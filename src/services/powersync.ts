import {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  UpdateType,
  type CrudTransaction,
} from '@powersync/common'
import { chunk } from 'lodash-es'
import { supabase, hasSupabaseAuthConfig, readPersistedSession } from '@/services/supabase.js'
import { classifyUploadError } from '@/services/uploadErrorClassifier.js'
import { encryptUploadColumns, type GetCek, type SyncMode } from '@/sync/transform.js'

const powerSyncUrl = import.meta.env.VITE_POWERSYNC_URL?.trim()

const MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH = 10_000
const MAX_TRANSACTIONS_PER_UPLOAD_BATCH = 25

/** Upper bound on CREATEs shipped in a single `apply_block_creates` RPC — same
 *  reasoning as {@link MAX_PATCHES_PER_SUPABASE_RPC}: that RPC runs one
 *  INSERT-or-touch per row inside one statement, so an uncapped batch (a bulk
 *  import lands as one big repo.tx and `collectUploadBatch` takes the first tx
 *  whole) would trip Postgres `statement_timeout`, which classifies transient and
 *  retries the oversized batch forever. */
export const MAX_CREATES_PER_SUPABASE_RPC = 500

/** Upper bound on patches shipped in a single `apply_block_patches` RPC.
 *  That RPC runs one UPDATE per patch (each firing the per-write server
 *  triggers) inside one statement, so an uncapped batch — a schema-swap
 *  reprojection or a bulk import lands as one big repo.tx, and
 *  `collectUploadBatch` always takes the first tx whole — runs tens of
 *  thousands of UPDATEs in one statement and trips Postgres
 *  `statement_timeout` (SQLSTATE 57014). A timeout classifies transient,
 *  so PowerSync retries the same oversized batch forever and the queue
 *  stops draining. Chunking keeps each RPC well under the timeout; the
 *  patches are column-narrow and idempotent, so splitting them across
 *  separate RPC transactions is safe. Mirrors `MAX_CREATES_PER_SUPABASE_RPC`. */
export const MAX_PATCHES_PER_SUPABASE_RPC = 500

/** Client-side abort budget for every Supabase upload request in this file —
 *  `apply_block_patches`, `apply_block_creates`, and the block DELETE. Without
 *  this, a fetch that never settles (plausible around an iOS background/
 *  foreground transition) leaves the connector's `uploadData` promise
 *  permanently pending — PowerSync's upload loop awaits it, so uploads stop
 *  silently and permanently for the life of the process: no console error, no
 *  `ps_crud_rejected` row, no retry (the 2026-08-13 iPad incident: 22 blocks
 *  stuck in `ps_crud` for 16.3 hours, one session alive 15.8h of that and never
 *  uploading once). `withUploadTimeout` below races every request against this
 *  budget so the call always settles one way or the other.
 *
 *  Value is chosen ABOVE the server's `statement_timeout` for these RPCs, not
 *  below it — aborting the client fetch does NOT roll back the server
 *  transaction, so a client timeout shorter than the server's would abandon
 *  work that then lands anyway and gets retried (see `withUploadTimeout`'s doc
 *  comment for why that retry is itself safe). Neither `apply_block_patches`
 *  nor `apply_block_creates` sets its own `statement_timeout` — the only
 *  per-function override anywhere in the migrations is `delete_workspace`'s
 *  5min (20260513205724_extend_delete_workspace_timeout.sql) — so both RPCs
 *  run under the `authenticated` role's Supabase-platform default of 8s
 *  (https://supabase.com/docs/guides/database/postgres/timeouts; confirmed via
 *  the platform docs, not present in this repo's migrations). 60s leaves
 *  ~7.5x headroom over that 8s ceiling: for a full 500-row batch
 *  (MAX_CREATES_PER_SUPABASE_RPC / MAX_PATCHES_PER_SUPABASE_RPC), most of the
 *  budget is there to cover request/response transfer time on a slow mobile
 *  link, not server execution — the 500-row cap itself exists specifically to
 *  keep server execution well under the 8s statement_timeout (see that
 *  constant's comment above). If the live project's configured default is
 *  ever raised above 8s, this still holds: 60s only needs to exceed whatever
 *  ceiling is actually in effect, and a stale assumption here fails safe
 *  (worst case, an occasional legitimate-but-slow request gets retried). */
export const UPLOAD_RPC_TIMEOUT_MS = 60_000

export const hasPowerSyncServiceConfig = Boolean(powerSyncUrl)
export const hasRemoteSyncConfig = hasSupabaseAuthConfig && hasPowerSyncServiceConfig

type BlockUploadPayload = Record<string, unknown> & {id: string}

export type CompactedBlockOperation =
  | {
      kind: 'create'
      id: string
      payload: BlockUploadPayload
      order: number
    }
  | {
      kind: 'patch'
      id: string
      payload: Record<string, unknown>
      order: number
    }
  | {
      kind: 'delete'
      id: string
      order: number
    }

/** Seams the rejection-tolerant upload orchestrator pokes through so tests
 *  can mock the two side-effects (Supabase write + rejection-table write)
 *  without spinning up a real DB or HTTP client. The default wiring lives
 *  in `defaultUploadDeps` below. */
export interface UploadDeps {
  applyOperations: (
    database: AbstractPowerSyncDatabase,
    operations: readonly CompactedBlockOperation[],
  ) => Promise<void>
  recordRejection: (
    database: AbstractPowerSyncDatabase,
    transaction: CrudTransaction,
    error: unknown,
  ) => Promise<void>
  /** Encrypt-on-upload transform (§9.2), applied to the compacted ops before
   *  they hit the wire. Optional so test deps can omit it; absent ⇒ identity. */
  encryptOps?: (
    operations: readonly CompactedBlockOperation[],
  ) => Promise<readonly CompactedBlockOperation[]>
}

/** Resolve a workspace's sync mode for the encrypt-on-upload decision. The
 *  policy (mode pin, §6) is injected; today's default is uniformly 'none'
 *  (no e2ee workspace exists pre-rollout), so encryption is a no-op until the
 *  §8 flows wire a real resolver + key store. */
export type GetWorkspaceMode = (workspaceId: string) => SyncMode | Promise<SyncMode>

/** Seal the content columns of each create/patch op whose workspace is e2ee,
 *  before they reach the wire (§9.2). Deletes and plaintext workspaces pass
 *  through untouched. `workspace_id` is read off the payload (always present
 *  per the upload trigger, D-3.1); an op missing it can't be e2ee-routed and
 *  passes through — a genuine e2ee plaintext write would be rejected by the
 *  server-side ciphertext trigger rather than silently stored. */
const encryptUploadOps = async (
  ops: readonly CompactedBlockOperation[],
  getMode: GetWorkspaceMode,
  getCek: GetCek,
): Promise<CompactedBlockOperation[]> => {
  // The mode is constant per workspace, but a bulk upload (import,
  // reprojection, long-offline drain) carries up to ~10k ops — each
  // `getMode` is a synchronous localStorage read, so resolving it per op
  // means thousands of main-thread reads + awaits for one value per
  // workspace. Memoize per workspaceId (mirrors `materializabilityByWs` in
  // syncObserver/materialize.ts).
  const modeByWs = new Map<string, SyncMode>()
  const resolveMode = async (workspaceId: string): Promise<SyncMode> => {
    const cached = modeByWs.get(workspaceId)
    if (cached !== undefined) return cached
    const resolved = await getMode(workspaceId)
    modeByWs.set(workspaceId, resolved)
    return resolved
  }

  const out: CompactedBlockOperation[] = []
  for (const op of ops) {
    if (op.kind === 'delete') {
      out.push(op)
      continue
    }
    const workspaceId = op.payload.workspace_id
    if (typeof workspaceId !== 'string') {
      out.push(op)
      continue
    }
    const mode = await resolveMode(workspaceId)
    if (mode === 'none') {
      out.push(op)
      continue
    }
    const payload = await encryptUploadColumns(op.id, workspaceId, op.payload, mode, getCek)
    out.push(
      op.kind === 'create'
        ? { ...op, payload: payload as BlockUploadPayload }
        : { ...op, payload },
    )
  }
  return out
}

// Pre-rollout defaults: every workspace is plaintext and no keys exist, so the
// default encryptOps is identity. The §8 flows replace these with a mode-pin
// resolver + IndexedDB key-store lookup when e2ee ships.
const defaultGetWorkspaceMode: GetWorkspaceMode = () => 'none'
const defaultUploadGetCek: GetCek = async () => null

/** Per-row apply primitives that `applyCompactedBlockOperations` dispatches
 *  to. Factored out so tests can substitute a controllable sink and assert
 *  which path each operation took. The default sink wires to Supabase. */
export interface BlockUploadSink {
  createRows: (rows: readonly BlockUploadPayload[]) => Promise<void>
  applyPatches: (
    patches: ReadonlyArray<{id: string; payload: Record<string, unknown>}>,
  ) => Promise<void>
  deleteRow: (id: string) => Promise<void>
}

// Per-id accumulator used by `compactBlockCrudEntries`.
//
// PATCHes that share a transaction with the create are folded into the
// create's payload (`createTxId` tracks which tx the create came from), so
// the bootstrap pattern `tx.create({props: {}}) → addTypeInTx (PATCH)`
// emits a single insert-or-skip CREATE rather than CREATE+PATCH — without
// fusion the PATCH overwrites the server's `properties_json` and wipes
// preferences when a deterministic-id row already exists server-side.
//
// PATCHes from a DIFFERENT tx than the create stay in the separate `patch`
// slot so they still emit as their own wire op: the CREATE may be a no-op
// insert-or-skip (server already has the row), but the cross-tx PATCH is a
// user-intentional edit that must land regardless.
type PerBlockState = {
  id: string
  order: number
  create?: BlockUploadPayload
  createTxId?: number
  patch?: Record<string, unknown>
  deleted?: true
}

const assertSupabase = () => {
  if (!supabase) {
    throw new Error('Supabase is not configured')
  }

  return supabase
}

/** Re-throw a Supabase/PostgREST error with the HTTP `status` attached.
 *
 *  PostgREST returns the HTTP status as a SIBLING of `{error}` in the
 *  response tuple — it is never a field on the `PostgrestError` object
 *  (which carries only `{message, details, hint, code}`). The upload-error
 *  classifier keys its 4xx handling off `err.status`, so unless the status is
 *  threaded onto the thrown error that handling is dead: a codeless 4xx (a
 *  generic 400, a 413, or any non-JSON body postgrest-js surfaces as
 *  `{message: body}` with no `code`) would fall through to `transient` and
 *  PowerSync would retry the same batch forever — the original queue jam. With
 *  the status attached, the classifier routes a non-retryable 4xx to
 *  `ambiguous` (bounded retry, then quarantine) and keeps the retryable subset
 *  (401/403/408/429) transient. See `uploadErrorClassifier.ts` and issue #190. */
const throwWithHttpStatus = (error: object, status: number): never => {
  throw Object.assign(error, {status})
}

/** Runs one Supabase request with a hard client-side abort at
 *  {@link UPLOAD_RPC_TIMEOUT_MS}. `run` receives the `AbortSignal` to chain
 *  onto the request via postgrest-js's `.abortSignal(...)` — present on this
 *  pinned `@supabase/postgrest-js` version (see
 *  `PostgrestTransformBuilder.abortSignal` in node_modules; confirmed, not
 *  assumed). The abort is RACED against the request rather than trusted
 *  alone: if some layer of the stack doesn't fully honor the signal — the
 *  exact failure mode this change targets, a fetch that never settles — the
 *  race still forces the call to settle once the timer fires.
 *
 *  Retrying after this timeout is safe:
 *   - Creates go through `apply_block_creates`, which is "Insert-or-TOUCH:
 *     preserve the server row, but emit a WAL change so the racing client
 *     gets an echo" (see that RPC's migration header) — never a destructive
 *     overwrite, so a re-sent create either really inserts or safely re-touches.
 *   - Patches are "column-narrow and idempotent, so splitting them across
 *     separate RPC transactions is safe" (see `MAX_PATCHES_PER_SUPABASE_RPC`
 *     above) — replaying the same patch payload writes the same columns again.
 *   - A DELETE retried after its row was already removed server-side is a
 *     normal SQL no-op (0 rows affected, not an error).
 *
 *  The synthesized timeout error is a plain `Error` (`name: 'TimeoutError'`,
 *  no `code`/`status` fields) — `classifyUploadError` already routes that
 *  shape to `transient` via its "no code we recognise and no 4xx" fallthrough,
 *  so no classifier change is needed. Pinned by a dedicated test in
 *  powersync.test.ts rather than a classifier-side rule, since the fallthrough
 *  already covers it (see that test for the reasoning). */
const withUploadTimeout = async <T>(
  run: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const error = new Error(
      `Supabase upload request aborted: exceeded the ${UPLOAD_RPC_TIMEOUT_MS}ms ` +
      'client-side timeout (UPLOAD_RPC_TIMEOUT_MS)',
    )
    error.name = 'TimeoutError'
    controller.abort(error)
  }, UPLOAD_RPC_TIMEOUT_MS)

  // Reject on the signal itself (not just on our own timer firing) so the
  // race settles even if `abort()` were ever triggered from elsewhere with a
  // different reason — the reason threads through to the classifier.
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(controller.signal.reason as Error),
      {once: true},
    )
  })

  try {
    return await Promise.race([Promise.resolve(run(controller.signal)), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

const blockPayloadFromPut = (entry: CrudEntry): BlockUploadPayload => ({
  ...(entry.opData ?? {}),
  id: entry.id,
})

/** Wire-only PATCH key (issue #381): the row-version the edit was made
 *  against, stamped by the upload trigger from `OLD.updated_at`. Not a
 *  `blocks` column — see `blockUploadPatchJsonSql` in clientSchema.ts. */
const BASE_VERSION_KEY = 'base_updated_at'

/** Merge a later PATCH's columns over an earlier one, keeping the EARLIER
 *  base version — including when the earlier one HAS no base.
 *
 *  Every other column is last-write-wins — the newest value is the one to
 *  ship. The base is the exact opposite: it is a claim about the server
 *  state the burst STARTED from, and only the first patch in the burst
 *  knows that. Each subsequent local edit's trigger captured the previous
 *  LOCAL stamp as its base (the row is already dirty), which the server has
 *  never seen. Taking the last one would make an un-drifted burst look
 *  drifted (harmless — one extra echo) and, worse, could make a genuinely
 *  drifted burst look clean when the last local stamp happens to equal the
 *  server's current version, silently reintroducing #381.
 *
 *  An ABSENT base on the earlier patch is not "no opinion", it is the
 *  strongest opinion the protocol has: unknown base ⇒ assume drift. That
 *  happens for real during a version upgrade — `ps_crud` is persistent, so a
 *  PATCH queued offline by the previous bundle carries no base while a PATCH
 *  queued after the reload does. Letting the spread inherit the later base
 *  there would assert a starting point this burst never had, which is exactly
 *  the "looks clean but isn't" case above. So absence wins too, and the merged
 *  patch reaches the server with no base at all — which it reads as drifted. */
const mergePatchPayloads = (
  earlier: Record<string, unknown>,
  later: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = {...earlier, ...later}
  if (BASE_VERSION_KEY in earlier) {
    merged[BASE_VERSION_KEY] = earlier[BASE_VERSION_KEY]
  } else {
    delete merged[BASE_VERSION_KEY]
  }
  return merged
}

const compactBlockCrudEntries = (entries: readonly CrudEntry[]): CompactedBlockOperation[] => {
  const byId = new Map<string, PerBlockState>()

  for (const [order, entry] of entries.entries()) {
    if (entry.table !== 'blocks') {
      throw new Error(`Unsupported table in upload queue: ${entry.table}`)
    }

    const existing = byId.get(entry.id)

    if (entry.op === UpdateType.PUT) {
      // A fresh PUT supersedes any prior state for this id in the batch —
      // it's a full row snapshot at INSERT time. Subsequent PATCHes in
      // this batch will fuse into the create or accumulate separately
      // depending on whether they share the PUT's tx (see PATCH branch).
      byId.set(entry.id, {
        id: entry.id,
        order,
        create: blockPayloadFromPut(entry),
        createTxId: entry.transactionId,
      })
      continue
    }

    if (entry.op === UpdateType.PATCH) {
      const patchData = entry.opData ?? {}
      // A PATCH that follows a DELETE in the same batch is a no-op (we
      // already decided the row is gone). This is defensive — repo.tx
      // shouldn't produce that sequence.
      if (existing?.deleted) continue

      // Same-tx fusion: when the PATCH shares the create's tx, merge its
      // columns into the create payload. The PATCH carries the final
      // post-update value for each column it touches, so `{...create,
      // ...patch}` is the right merge direction.
      if (
        existing?.create
        && existing.createTxId !== undefined
        && existing.createTxId === entry.transactionId
      ) {
        // Drop the wire-only base on the way into a CREATE payload: creates go
        // to `apply_block_creates`, which has no drift concept (an INSERT has
        // no prior version, and the ON CONFLICT branch is a no-op TOUCH that
        // must NOT advance the stamp — see #244). Its closed column list would
        // ignore the key anyway; stripping keeps the create payload to real
        // columns so a future strict-payload check can't trip on it.
        const createColumns = {...patchData}
        delete createColumns[BASE_VERSION_KEY]
        byId.set(entry.id, {
          ...existing,
          create: {...existing.create, ...createColumns},
        })
        continue
      }

      byId.set(entry.id, {
        id: entry.id,
        order: existing?.order ?? order,
        create: existing?.create,
        createTxId: existing?.createTxId,
        patch: existing?.patch ? mergePatchPayloads(existing.patch, patchData) : patchData,
      })
      continue
    }

    if (entry.op === UpdateType.DELETE) {
      // DELETE clears prior create/patch in the batch — they cancel out.
      // Soft-delete UPDATEs come through as PATCH ops (deleted=1), not
      // DELETE, so this only fires for hard deletes (not v1).
      byId.set(entry.id, {
        id: entry.id,
        order,
        deleted: true,
      })
      continue
    }

    throw new Error(`Unsupported CRUD operation: ${entry.op}`)
  }

  const operations: CompactedBlockOperation[] = []
  for (const state of byId.values()) {
    if (state.deleted) {
      operations.push({kind: 'delete', id: state.id, order: state.order})
      continue
    }
    if (state.create) {
      operations.push({kind: 'create', id: state.id, payload: state.create, order: state.order})
    }
    if (state.patch) {
      operations.push({kind: 'patch', id: state.id, payload: state.patch, order: state.order})
    }
  }

  return operations.sort((left, right) => left.order - right.order)
}

const orderedBlockUpserts = (rows: readonly BlockUploadPayload[]): BlockUploadPayload[] => {
  const byId = new Map(rows.map(row => [row.id, row]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const ordered: BlockUploadPayload[] = []

  const visit = (row: BlockUploadPayload) => {
    const current = state.get(row.id)
    if (current === 'visited') return
    if (current === 'visiting') return

    state.set(row.id, 'visiting')
    const parentId = typeof row.parent_id === 'string' ? row.parent_id : null
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent) visit(parent)
    state.set(row.id, 'visited')
    ordered.push(row)
  }

  for (const row of rows) visit(row)
  return ordered
}

/** Ships every PATCH in the compacted batch as a single
 *  `apply_block_patches` RPC call. The server-side function loops the
 *  patches array and runs one column-narrow UPDATE per element, with the
 *  same semantics PostgREST `.update()` gave us before — just packed into
 *  one HTTP round trip instead of N. Per-key `properties_json` merge is
 *  out of scope here (see #51); each patch in the array writes its
 *  specified columns to its specified row id.
 *
 *  Server-missing rows raise SQLSTATE `P0002` inside the RPC, which
 *  rolls back the function's transaction so partial sibling UPDATEs do
 *  not commit. PostgREST surfaces the SQLSTATE on the error's `code`
 *  field; `uploadErrorClassifier` classifies it as permanent and the
 *  orchestrator's per-tx fallback (`uploadTransactionsWithFallback`)
 *  quarantines that single tx. */
const applyBlockPatchesRpc = async (
  patches: ReadonlyArray<{id: string; payload: Record<string, unknown>}>,
) => {
  if (patches.length === 0) return
  const client = assertSupabase()

  // Chunk so one RPC never runs more than MAX_PATCHES_PER_SUPABASE_RPC
  // server-side UPDATEs in a single statement (see the constant for why).
  for (const batch of chunk(patches, MAX_PATCHES_PER_SUPABASE_RPC)) {
    console.debug('[powersync] PATCH batch', batch.length)
    const payload = batch.map(patch => ({id: patch.id, ...patch.payload}))
    const {error, status} = await withUploadTimeout(signal =>
      client.rpc('apply_block_patches', {patches: payload}).abortSignal(signal),
    )

    if (error) {
      throwWithHttpStatus(error, status)
    }
  }
}

const applyBlockDelete = async (id: string) => {
  const client = assertSupabase()

  console.debug('[powersync] DELETE', id)
  const {error, status} = await withUploadTimeout(signal =>
    // eslint-disable-next-line no-restricted-syntax -- programmatic delete: Supabase query builder, not a Block
    client
      .from('blocks')
      .delete()
      .eq('id', id)
      .abortSignal(signal),
  )

  if (error) {
    throwWithHttpStatus(error, status)
  }
}

// Insert-or-TOUCH on the id PK, via the `apply_block_creates` RPC. Used for
// client-originated CREATEs so a deterministic-id collision with an existing
// server row PRESERVES the server's state — user-prefs, user-page, and ui-state
// bootstrap on a fresh client all rely on this. Subsequent PATCH ops in the same
// batch still carry the user's intentional edits.
//
// Why an RPC and not `.upsert(..., {ignoreDuplicates:true})`: `DO NOTHING`
// preserves the server row but writes no heap tuple, so a client that raced the
// create against sync gets NO echo and strands an insert-or-skip phantom
// (issue #336 / #244). The RPC does `ON CONFLICT DO UPDATE SET updated_at =
// blocks.updated_at` — a no-op touch that changes no data but emits a WAL change,
// so PowerSync re-sends the authoritative row down and the observer reconciles
// the phantom via the normal sync path. This replaces the whole client-side
// self-heal outbox. See the migration for the full rationale + trigger analysis.
const applyBlockCreates = async (rows: readonly BlockUploadPayload[]) => {
  if (rows.length === 0) return
  const client = assertSupabase()

  // Chunk for the same reason apply_block_patches does (see
  // MAX_CREATES_PER_SUPABASE_RPC): keep each RPC's per-row INSERT count under the
  // statement timeout. orderedBlockUpserts keeps a child out of an earlier chunk
  // (separate RPC = separate tx) than its parent — the parent self-FK is
  // DEFERRABLE within a tx but not across them.
  for (const batch of chunk(orderedBlockUpserts(rows), MAX_CREATES_PER_SUPABASE_RPC)) {
    console.debug('[powersync] CREATE batch', batch.length)
    const {error, status} = await withUploadTimeout(signal =>
      client.rpc('apply_block_creates', {creates: batch}).abortSignal(signal),
    )

    if (error) {
      throwWithHttpStatus(error, status)
    }
  }
}

const applyCompactedBlockOperations = async (
  _database: AbstractPowerSyncDatabase,
  operations: readonly CompactedBlockOperation[],
  sink: BlockUploadSink = defaultBlockUploadSink,
) => {
  const creates: BlockUploadPayload[] = []
  const patches: Array<{id: string; payload: Record<string, unknown>}> = []
  const deletes: string[] = []

  for (const operation of operations) {
    if (operation.kind === 'create') {
      creates.push(operation.payload)
    } else if (operation.kind === 'patch') {
      patches.push({id: operation.id, payload: operation.payload})
    } else {
      deletes.push(operation.id)
    }
  }

  // Order matters: creates first so subsequent patches/deletes find their
  // rows (when the row is genuinely new). Insert-or-skip semantics make
  // this safe when the row already exists.
  await sink.createRows(creates)

  if (patches.length > 0) {
    await sink.applyPatches(patches)
  }

  for (const id of deletes) {
    await sink.deleteRow(id)
  }
}

/** Production sink — Supabase under the hood. Tests pass a mock sink to
 *  `applyCompactedBlockOperations` so they can assert which path each
 *  operation took. */
const defaultBlockUploadSink: BlockUploadSink = {
  createRows: applyBlockCreates,
  applyPatches: applyBlockPatchesRpc,
  deleteRow: applyBlockDelete,
}


const collectUploadBatch = async (
  database: AbstractPowerSyncDatabase,
): Promise<CrudTransaction[]> => {
  const transactions: CrudTransaction[] = []
  const iterator = database.getCrudTransactions()[Symbol.asyncIterator]()
  let entryCount = 0

  while (
    transactions.length < MAX_TRANSACTIONS_PER_UPLOAD_BATCH &&
    (transactions.length === 0 || entryCount < MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH)
  ) {
    const next = await iterator.next()
    if (next.done || !next.value) break
    transactions.push(next.value)
    entryCount += next.value.crud.length
  }

  return transactions
}

/** Records a permanently-rejected upload to the `ps_crud_rejected`
 *  quarantine table so the bucket can keep draining. The row preserves
 *  enough context (original ps_crud id, tx id, full envelope, error
 *  code + message, wall-clock time) for a later UI surface or for
 *  manual inspection via `kmagent sql`. */
const recordRejectionToTable = async (
  database: AbstractPowerSyncDatabase,
  transaction: CrudTransaction,
  error: unknown,
): Promise<void> => {
  const errorCode = errorCodeOf(error)
  const errorMessage = errorMessageOf(error)
  const rejectedAt = Date.now()
  const txId = transaction.transactionId ?? transaction.crud[0]?.transactionId ?? 0

  // Preserve every entry in the rejected tx — a single CrudTransaction can
  // carry many CrudEntries (multi-row repo.tx). We write one ps_crud_rejected
  // row per entry so a future UI can count "N changes couldn't sync" directly.
  //
  // Atomic + idempotent: the whole set runs in one writeTransaction, so a
  // mid-loop INSERT failure rolls back cleanly (never a partial record), and
  // the leading DELETE-by-tx_id makes a re-run a no-op replace. Without that,
  // a failure between recording and the caller's complete() — which is a
  // separate step — would re-insert duplicate rows for this tx on the next
  // upload pass (the tx isn't drained, so it's quarantined again).
  await database.writeTransaction(async tx => {
    await tx.execute(`DELETE FROM ps_crud_rejected WHERE tx_id = ?`, [txId])
    for (const entry of transaction.crud) {
      await tx.execute(
        `INSERT INTO ps_crud_rejected
           (original_id, tx_id, data, error_code, error_message, rejected_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          entry.clientId,
          txId,
          JSON.stringify(crudEntryEnvelope(entry)),
          errorCode,
          errorMessage,
          rejectedAt,
        ],
      )
    }
  })
}

const errorCodeOf = (error: unknown): string | null => {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as {code?: unknown; status?: unknown}).code
      ?? (error as {status?: unknown}).status
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return String(candidate)
    }
  }
  return null
}

const errorMessageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Reconstruct the JSON envelope that the upload-routing triggers wrote
 *  into `ps_crud.data` (see clientSchema.ts). Keeping the same shape
 *  here means a rejected row carries the exact wire payload, so the
 *  rejection log reads symmetrically with the original queue. */
const crudEntryEnvelope = (entry: CrudEntry): Record<string, unknown> => {
  const opName =
    entry.op === UpdateType.PUT ? 'PUT'
    : entry.op === UpdateType.PATCH ? 'PATCH'
    : 'DELETE'
  const data = entry.opData ?? {}
  return entry.op === UpdateType.DELETE
    ? {op: opName, type: entry.table, id: entry.id}
    : {op: opName, type: entry.table, id: entry.id, data}
}

const makeUploadDeps = (
  getWorkspaceMode: GetWorkspaceMode,
  getCek: GetCek,
): UploadDeps => ({
  applyOperations: applyCompactedBlockOperations,
  recordRejection: recordRejectionToTable,
  encryptOps: ops => encryptUploadOps(ops, getWorkspaceMode, getCek),
})

/** How many upload passes an `ambiguous` tx (a suspected-permanent 4xx with no
 *  confirming code) is retried before it's quarantined. The first
 *  `AMBIGUOUS_RETRY_BUDGET - 1` passes re-throw (so PowerSync retries and a
 *  transient blip can clear); the last records the rejection and completes,
 *  draining the tx so the queue doesn't jam forever on a real permanent error.
 *  Counts are kept per `transactionId` for the lifetime of the connector (in
 *  memory — a restart resets the budget, which is itself a fresh "try again"). */
export const AMBIGUOUS_RETRY_BUDGET = 5

/** Records one more failed pass for an `ambiguous` tx and reports whether its
 *  retry budget is now spent. A tx with no stable `transactionId` can't be
 *  tracked across passes, so it's treated as already-exhausted (quarantine now)
 *  rather than retried unbounded. */
const ambiguousBudgetExhausted = (
  attempts: Map<number, number>,
  transaction: CrudTransaction,
): boolean => {
  const id = transaction.transactionId
  if (id === undefined) return true
  const next = (attempts.get(id) ?? 0) + 1
  attempts.set(id, next)
  return next >= AMBIGUOUS_RETRY_BUDGET
}

/** Clears a tx's ambiguous retry counter once it has drained (succeeded or been
 *  quarantined), so the map stays bounded by the count of currently-stuck txs. */
const forgetAmbiguousAttempts = (
  attempts: Map<number, number>,
  transaction: CrudTransaction,
): void => {
  if (transaction.transactionId !== undefined) attempts.delete(transaction.transactionId)
}

/** Optimistic-batch / pessimistic-per-tx upload orchestrator.
 *
 *  Happy path: one compacted batch → one applyOperations call → complete
 *  the tail tx (which drains every preceding tx from ps_crud). Identical
 *  perf to the original handler.
 *
 *  On ANY batch failure: drop into the per-tx fallback. We do NOT fast-path a
 *  transient error back into a whole-batch retry — applyOperations runs creates
 *  before patches, so a transient failure on a later op can leave the earlier
 *  creates already landed server-side, and re-throwing the whole batch would
 *  replay them every retry. Because the create path is now insert-or-TOUCH (ON
 *  CONFLICT DO UPDATE, not DO NOTHING), each replay is a real WAL write + a
 *  fleet-wide echo — unbounded amplification for the life of the transient.
 *  Per-tx draining bounds it to the succeeded PREFIX: every tx before the first
 *  failing one drains (one extra per-tx pass — complete() is a prefix
 *  checkpoint) so those creates stop re-touching. The failing tx and the suffix
 *  after it still retry — and their creates still re-touch — each pass until the
 *  transient clears; the win is the prefix, which for the common ordering (a
 *  create backlog queued ahead of a later edit) is all of it.
 *  The per-tx fallback applies each tx individually and classifies its error
 *  (see uploadErrorClassifier): complete() on success; re-throw (retry) on a
 *  transient error; record to ps_crud_rejected + complete() (quarantine) on a
 *  permanent error; and on an ambiguous error retry it across
 *  AMBIGUOUS_RETRY_BUDGET upload passes, then quarantine. This way one bad tx no
 *  longer jams the bucket — the rest of the queue drains and the bad one lands
 *  in ps_crud_rejected for inspection.
 *
 *  Encrypt-on-upload (§9.2) is part of that isolation: a tx for an e2ee
 *  workspace whose key is momentarily missing/unreadable makes `encryptOps`
 *  throw. The BATCH encryption is guarded so that failure DOESN'T abort the
 *  whole preflight — it falls through to the per-tx loop, which drains every
 *  earlier (encryptable) tx and then stops at the un-encryptable one (its
 *  per-tx `encryptOps` throws out of the loop). `complete()` is a checkpoint
 *  that drains all PRECEDING txs, so we can't skip the bad tx and complete a
 *  later one — instead PowerSync retries from it once the key is back. A
 *  missing key is treated as transient (retry), never a rejection (which would
 *  discard the edit). */
const uploadTransactionsWithFallback = async (
  database: AbstractPowerSyncDatabase,
  transactions: readonly CrudTransaction[],
  deps: UploadDeps,
  ambiguousAttempts: Map<number, number> = new Map(),
): Promise<void> => {
  const encryptOps = deps.encryptOps ?? (async ops => ops)

  // Guard the batch encryption: if a tx in the batch can't be encrypted (e2ee
  // key unavailable), fall through to the per-tx fallback rather than aborting
  // the whole batch before any of it can drain.
  let batchOps: readonly CompactedBlockOperation[] | null = null
  try {
    batchOps = await encryptOps(compactBlockCrudEntries(transactions.flatMap(t => t.crud)))
  } catch (err) {
    console.warn('[powersync] batch encryption failed — isolating per tx', err)
  }

  if (batchOps) {
    try {
      await deps.applyOperations(database, batchOps)
      await transactions[transactions.length - 1]?.complete()
      // The whole batch drained — clear any ambiguous retry counters it carried
      // (an earlier pass's transient blip cleared and the batch went through).
      for (const transaction of transactions) {
        forgetAmbiguousAttempts(ambiguousAttempts, transaction)
      }
      return
    } catch (err) {
      // ANY batch error (transient included) drops into the per-tx loop — see
      // the function doc above for why we don't fast-path a transient back into
      // a whole-batch retry (it would re-touch every already-landed create each
      // pass, now that the create path is insert-or-TOUCH). The loop drains the
      // succeeded prefix and re-throws the still-failing tx, classifying each
      // (transient → re-throw, ambiguous → retry-budget, permanent → quarantine).
      console.warn(
        `[powersync] batch upload failed — isolating ${transactions.length} tx(s)`,
        err,
      )
    }
  }

  // Per-tx fallback. Within-tx compaction still runs so the bootstrap
  // PUT+PATCH fusion (clientSchema.ts upload triggers + addTypeInTx) is
  // preserved — losing it would clobber properties_json on a server row
  // the deterministic-id bootstrap already created.
  for (const transaction of transactions) {
    const txOps = await encryptOps(compactBlockCrudEntries(transaction.crud))
    try {
      await deps.applyOperations(database, txOps)
      await transaction.complete()
      forgetAmbiguousAttempts(ambiguousAttempts, transaction)
    } catch (err) {
      const classification = classifyUploadError(err)
      if (classification === 'transient') {
        console.error('[powersync] per-tx upload failed (transient, will retry)', err)
        throw err
      }
      // An ambiguous error (a suspected-permanent 4xx with no confirming code)
      // is retried across a few upload passes before we give up: re-throw until
      // the budget is spent, then fall through to quarantine. A genuinely
      // transient blip clears within the budget; a real permanent error
      // quarantines instead of jamming the queue forever.
      if (classification === 'ambiguous' && !ambiguousBudgetExhausted(ambiguousAttempts, transaction)) {
        console.warn(
          `[powersync] tx ${transaction.transactionId} ambiguous upload error — retrying`,
          err,
        )
        throw err
      }
      console.warn(
        `[powersync] tx ${transaction.transactionId} rejected — quarantining`,
        err,
      )
      await deps.recordRejection(database, transaction, err)
      await transaction.complete()
      forgetAmbiguousAttempts(ambiguousAttempts, transaction)
    }
  }
}

const runUploadLoop = async (
  database: AbstractPowerSyncDatabase,
  deps: UploadDeps,
  ambiguousAttempts: Map<number, number>,
): Promise<void> => {
  while (true) {
    const transactions = await collectUploadBatch(database)
    if (transactions.length === 0) break
    await uploadTransactionsWithFallback(database, transactions, deps, ambiguousAttempts)
  }
}

const fetchCredentials = async () => {
  const client = assertSupabase()

  // getSession() refreshes an expired token before resolving; offline
  // that fails (and can hang on retries). Fall back to the last
  // persisted session so we still hand PowerSync a token to retry the
  // connection with once the network returns — and return null instead
  // of throwing when there's truly nothing, so an offline boot doesn't
  // spam the console with refresh failures.
  let session = readPersistedSession()
  try {
    const {data, error} = await client.auth.getSession()
    if (error) throw error
    if (data.session) session = data.session
  } catch (error) {
    if (!session) {
      console.debug('[powersync] fetchCredentials: no session available (offline?)', error)
      return null
    }
  }

  if (!session?.access_token || !powerSyncUrl) {
    return null
  }

  return {
    endpoint: powerSyncUrl,
    token: session.access_token,
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000)
      : undefined,
  }
}

/** §9.2 encrypt-on-upload wiring. The mode/key resolvers are injected so the
 *  app binds them to the signed-in user's mode pins + workspace-key store;
 *  omitted (e.g. in tests, or before e2ee is wired) they default to plaintext
 *  pass-through. */
export interface PowerSyncConnectorOptions {
  readonly getWorkspaceMode?: GetWorkspaceMode
  readonly getCek?: GetCek
}

export const createPowerSyncConnector = (
  options: PowerSyncConnectorOptions = {},
): PowerSyncBackendConnector => {
  const deps = makeUploadDeps(
    options.getWorkspaceMode ?? defaultGetWorkspaceMode,
    options.getCek ?? defaultUploadGetCek,
  )
  // Per-connector so `ambiguous` retry counts persist across the repeated
  // `uploadData` invocations PowerSync makes while a tx stays queued.
  const ambiguousAttempts = new Map<number, number>()
  return {
    fetchCredentials,
    uploadData: database => runUploadLoop(database, deps, ambiguousAttempts),
  }
}

export const __encryptUploadOpsForTest = encryptUploadOps
export const __compactBlockCrudEntriesForTest = compactBlockCrudEntries
export const __orderedBlockUpsertsForTest = orderedBlockUpserts
export const __uploadTransactionsWithFallbackForTest = uploadTransactionsWithFallback
export const __runUploadLoopForTest = runUploadLoop
export const __applyCompactedBlockOperationsForTest = applyCompactedBlockOperations
export const __applyBlockPatchesRpcForTest = applyBlockPatchesRpc
export const __applyBlockCreatesForTest = applyBlockCreates
export const __recordRejectionToTableForTest = recordRejectionToTable
