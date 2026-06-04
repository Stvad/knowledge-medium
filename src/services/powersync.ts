import {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  UpdateType,
  type CrudTransaction,
} from '@powersync/common'
import { supabase, hasSupabaseAuthConfig, readPersistedSession } from '@/services/supabase.js'
import { classifyUploadError } from '@/services/uploadErrorClassifier.js'
import { encryptUploadColumns, type GetCek, type SyncMode } from '@/sync/transform.js'

const powerSyncUrl = import.meta.env.VITE_POWERSYNC_URL?.trim()

const MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH = 10_000
const MAX_TRANSACTIONS_PER_UPLOAD_BATCH = 25
const MAX_BLOCKS_PER_SUPABASE_UPSERT = 500

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
    const mode = await getMode(workspaceId)
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

const blockPayloadFromPut = (entry: CrudEntry): BlockUploadPayload => ({
  ...(entry.opData ?? {}),
  id: entry.id,
})

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
        byId.set(entry.id, {
          ...existing,
          create: {...existing.create, ...patchData},
        })
        continue
      }

      byId.set(entry.id, {
        id: entry.id,
        order: existing?.order ?? order,
        create: existing?.create,
        createTxId: existing?.createTxId,
        patch: existing?.patch ? {...existing.patch, ...patchData} : patchData,
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

const chunked = <T,>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
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

  console.debug('[powersync] PATCH batch', patches.length)
  const payload = patches.map(patch => ({id: patch.id, ...patch.payload}))
  const {error} = await client.rpc('apply_block_patches', {patches: payload})

  if (error) {
    throw error
  }
}

const applyBlockDelete = async (id: string) => {
  const client = assertSupabase()

  console.debug('[powersync] DELETE', id)
  const {error} = await client
    .from('blocks')
    .delete()
    .eq('id', id)

  if (error) {
    throw error
  }
}

// Insert-or-skip on the id PK. Used for client-originated CREATEs so a
// deterministic-id collision with an existing server row preserves the
// server's state — user-prefs, user-page, and ui-state bootstrap on a fresh
// client all rely on this. Subsequent PATCH ops in the same batch still
// carry the user's intentional edits.
const applyBlockCreates = async (rows: readonly BlockUploadPayload[]) => {
  if (rows.length === 0) return
  const client = assertSupabase()

  for (const chunk of chunked(orderedBlockUpserts(rows), MAX_BLOCKS_PER_SUPABASE_UPSERT)) {
    console.debug('[powersync] CREATE batch', chunk.length)
    const {error} = await client
      .from('blocks')
      .upsert(chunk, {onConflict: 'id', ignoreDuplicates: true})

    if (error) {
      throw error
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

  // Preserve every entry in the rejected tx — a single CrudTransaction
  // can carry many CrudEntries (multi-row repo.tx). Inserting one
  // ps_crud_rejected row per entry keeps the audit shape symmetric with
  // ps_crud and lets a future UI count "N changes couldn't sync" directly.
  for (const entry of transaction.crud) {
    await database.execute(
      `INSERT INTO ps_crud_rejected
         (original_id, tx_id, data, error_code, error_message, rejected_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.clientId,
        transaction.transactionId ?? entry.transactionId ?? 0,
        JSON.stringify(crudEntryEnvelope(entry)),
        errorCode,
        errorMessage,
        rejectedAt,
      ],
    )
  }
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

/** Optimistic-batch / pessimistic-per-tx upload orchestrator.
 *
 *  Happy path: one compacted batch → one applyOperations call → complete
 *  the tail tx (which drains every preceding tx from ps_crud). Identical
 *  perf to the original handler.
 *
 *  On batch failure: classify the error. Transient (5xx / network /
 *  unknown) → re-throw so PowerSync retries the batch later. Permanent
 *  (FK violation, RLS denial, 4xx) → drop into per-tx fallback: apply
 *  each tx individually, completing on success, recording-then-completing
 *  on permanent failure, re-throwing on transient. This way one bad tx
 *  no longer jams the bucket — the rest of the queue drains and the
 *  bad one lands in ps_crud_rejected for inspection. */
const uploadTransactionsWithFallback = async (
  database: AbstractPowerSyncDatabase,
  transactions: readonly CrudTransaction[],
  deps: UploadDeps,
): Promise<void> => {
  const encryptOps = deps.encryptOps ?? (async ops => ops)
  const batchOps = await encryptOps(compactBlockCrudEntries(transactions.flatMap(t => t.crud)))

  try {
    await deps.applyOperations(database, batchOps)
    await transactions[transactions.length - 1]?.complete()
    return
  } catch (err) {
    if (classifyUploadError(err) === 'transient') {
      console.error('[powersync] upload failed (transient, will retry)', err)
      throw err
    }
    console.warn(
      `[powersync] batch upload rejected permanently — isolating ${transactions.length} tx(s)`,
      err,
    )
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
    } catch (err) {
      if (classifyUploadError(err) === 'transient') {
        console.error('[powersync] per-tx upload failed (transient, will retry)', err)
        throw err
      }
      console.warn(
        `[powersync] tx ${transaction.transactionId} rejected — quarantining`,
        err,
      )
      await deps.recordRejection(database, transaction, err)
      await transaction.complete()
    }
  }
}

const runUploadLoop = async (
  database: AbstractPowerSyncDatabase,
  deps: UploadDeps,
): Promise<void> => {
  while (true) {
    const transactions = await collectUploadBatch(database)
    if (transactions.length === 0) return
    await uploadTransactionsWithFallback(database, transactions, deps)
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
  return {
    fetchCredentials,
    uploadData: database => runUploadLoop(database, deps),
  }
}

export const __encryptUploadOpsForTest = encryptUploadOps
export const __compactBlockCrudEntriesForTest = compactBlockCrudEntries
export const __orderedBlockUpsertsForTest = orderedBlockUpserts
export const __uploadTransactionsWithFallbackForTest = uploadTransactionsWithFallback
export const __applyCompactedBlockOperationsForTest = applyCompactedBlockOperations
export const __applyBlockPatchesRpcForTest = applyBlockPatchesRpc
