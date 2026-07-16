/**
 * In-memory fake of the Supabase sync server, for two-device convergence
 * tests (issue #372 Batch 3). Sits behind the REAL upload pipeline
 * (`runUploadLoop` → `compactBlockCrudEntries` →
 * `applyCompactedBlockOperations`, via the injectable `BlockUploadSink`
 * seam) and delivers rows back into a device's `blocks_synced` raw table
 * exactly the way PowerSync does (`BLOCKS_SYNCED_RAW_TABLE.put`, verbatim
 * server row — `powersync/sync-config.yaml` selects all 13
 * `BLOCK_STORAGE_COLUMNS` with no transformation).
 *
 * Server-side write semantics faithfully modeled (each cites the
 * migration it mirrors):
 *
 *  - `apply_block_creates` insert-or-TOUCH
 *    (supabase/migrations/20260709000000, ~L82-130): a create for an
 *    existing id preserves the server row untouched — the ON-CONFLICT
 *    branch is a no-op self-assignment whose only effect is a WAL write,
 *    i.e. the authoritative row gets re-delivered (here: a version bump so
 *    the next `deliverTo` re-sends it). A fresh insert future-clamps its
 *    stamps but gets no floor/bump (the clamp trigger's INSERT path).
 *
 *  - `apply_block_patches` (20260612000000, ~L83-130): closed column list;
 *    absent keys keep the server value (`COALESCE(patch->>'col', col)` —
 *    which also means an explicit JSON null keeps the old value for every
 *    column EXCEPT `parent_id`, which uses `CASE WHEN patch ? 'parent_id'`
 *    so explicit null re-roots). A patch for a missing id raises (P0002,
 *    rolls back the whole RPC) — unreachable in the convergence universe
 *    (creates always precede patches, cross-device ids arrive via
 *    delivery), so this fake throws and the fuzzer treats it as a bug.
 *
 *  - `blocks_clamp_updated_at` (20260612000000, L27-77 — the NET current
 *    behavior): on INSERT and UPDATE, future-clamp `updated_at` and
 *    `created_at` to server-now and set
 *    `user_updated_at := least(coalesce(user_updated_at, updated_at), now)`;
 *    on UPDATE only, floor `updated_at := greatest(new, old)` then bump
 *    `updated_at := greatest(new, old + 1)` iff a CONTENT column changed —
 *    content columns are exactly {parent_id, order_key, content,
 *    properties_json, references_json, deleted} (metadata columns
 *    deliberately never bump).
 *
 *  - `blocks_prevent_workspace_change` (consolidated initial, ~L187-200):
 *    an UPDATE changing `workspace_id` raises. The upload PATCH emits
 *    `workspace_id` unconditionally (clientSchema.ts
 *    `blockUploadPatchJsonSql` — the Phase-D AAD hook needs it), so the
 *    fake accepts an *equal* workspace_id and throws on a real change.
 *
 *  - hard DELETE (`sink.deleteRow`): unreachable on the v1 path (soft
 *    delete is a PATCH `deleted=1`; there is no DELETE upload trigger —
 *    clientSchema.ts:498-502). The fake throws so an unexpected hard
 *    delete surfaces as a bug instead of silently vanishing a row.
 *
 * Delivery: a per-row monotonically increasing `version` (bumped on every
 * server-side write INCLUDING the create-conflict touch) plus a
 * per-device cursor — `deliverTo(db, cursor)` writes every row with
 * `version > cursor` into that device's `blocks_synced` (INSERT OR
 * REPLACE, firing the real change-capture queue triggers) and returns the
 * new cursor. Tombstones (deleted=1) deliver as upserts — the sync rule
 * has no deleted filter; rows only ever LEAVE the synced set via
 * workspace/membership lifecycle, which this fake doesn't model.
 *
 * The server clock is injected (`now`) and must be monotonic —
 * `created_at`/`user_updated_at` have no restoring floor (only the
 * future-clamp), so a backwards clock would shave them in ways the
 * product accepts but a convergence oracle shouldn't have to reason
 * about.
 */
import { BLOCKS_SYNCED_RAW_TABLE, BLOCK_STORAGE_COLUMNS } from '@/data/blockSchema'
import type { PowerSyncDatabase } from '@powersync/node'

/** The 13 server-side `blocks` columns, JS-typed. `deleted` normalized to
 *  boolean inside the server (uploads carry a JSON boolean; delivery
 *  converts to the 0/1 SQLite shape). */
export interface ServerBlockRow {
  id: string
  workspace_id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  user_updated_at: number | null
  created_by: string | null
  updated_by: string | null
  deleted: boolean
}

/** The 6 columns whose change triggers the +1 version bump
 *  (20260612000000 L64-65 lists the deliberate EXCLUSIONS; this is the
 *  complement). */
const CONTENT_COLUMNS = [
  'parent_id', 'order_key', 'content', 'properties_json', 'references_json', 'deleted',
] as const

const asBool = (v: unknown): boolean => v === true || v === 1 || v === 'true'

export interface FakeSyncServer {
  /** `BlockUploadSink.createRows` — apply_block_creates semantics. */
  createRows(rows: readonly Record<string, unknown>[]): Promise<void>
  /** `BlockUploadSink.applyPatches` — apply_block_patches semantics. */
  applyPatches(patches: ReadonlyArray<{ id: string; payload: Record<string, unknown> }>): Promise<void>
  /** `BlockUploadSink.deleteRow` — unreachable on the v1 path; throws. */
  deleteRow(id: string): Promise<void>
  /** Write every row changed since `cursor` into `db`'s `blocks_synced`
   *  (verbatim, INSERT OR REPLACE — fires the real queue triggers) and
   *  return the new cursor. */
  deliverTo(db: PowerSyncDatabase, cursor: number): Promise<number>
  /** Current global version — a device whose cursor equals this has seen
   *  every server write. */
  version(): number
  /** Server rows in the 0/1-`deleted` SQL value shape, ordered by id —
   *  the convergence oracle's ground truth. */
  rows(): Array<Record<string, unknown>>
}

const COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(c => c.name)

/** Server row → the positional param list `BLOCKS_SYNCED_RAW_TABLE.put`
 *  expects (BLOCK_STORAGE_COLUMNS order, `deleted` as 0/1). */
const rowParams = (row: ServerBlockRow): unknown[] =>
  COLUMN_NAMES.map(name =>
    name === 'deleted' ? (row.deleted ? 1 : 0) : row[name as keyof ServerBlockRow])

export const createFakeSyncServer = (opts: { now: () => number }): FakeSyncServer => {
  const rows = new Map<string, ServerBlockRow>()
  const versions = new Map<string, number>()
  let version = 0
  const touch = (id: string): void => { versions.set(id, ++version) }

  /** The clamp trigger's BOTH-paths section (20260612000000 L38-46):
   *  future-clamp both stamps, then populate/clamp user_updated_at from
   *  the ALREADY-CLAMPED updated_at. */
  const clampCommon = (row: ServerBlockRow): void => {
    const serverNow = opts.now()
    if (row.updated_at > serverNow) row.updated_at = serverNow
    if (row.created_at > serverNow) row.created_at = serverNow
    row.user_updated_at = Math.min(row.user_updated_at ?? row.updated_at, serverNow)
  }

  return {
    async createRows(payloads) {
      for (const payload of payloads) {
        const id = payload.id as string
        if (rows.has(id)) {
          // Insert-or-TOUCH: preserve the server row; the no-op
          // self-assignment's WAL write re-delivers the authoritative row
          // (20260709000000 — replaced the client-side self-heal outbox).
          // The clamp sees no content change, so updated_at is unchanged.
          touch(id)
          continue
        }
        const row: ServerBlockRow = {
          id,
          workspace_id: payload.workspace_id as string,
          parent_id: (payload.parent_id ?? null) as string | null,
          order_key: payload.order_key as string,
          content: (payload.content ?? '') as string,
          properties_json: (payload.properties_json ?? '{}') as string,
          references_json: (payload.references_json ?? '[]') as string,
          created_at: payload.created_at as number,
          updated_at: payload.updated_at as number,
          user_updated_at: (payload.user_updated_at ?? null) as number | null,
          created_by: (payload.created_by ?? null) as string | null,
          updated_by: (payload.updated_by ?? null) as string | null,
          deleted: asBool(payload.deleted ?? false),
        }
        clampCommon(row) // INSERT path: future-clamp only — no floor, no bump.
        rows.set(id, row)
        touch(id)
      }
    },

    async applyPatches(patches) {
      // Mirror the RPC's whole-call atomicity: scan for missing ids FIRST
      // (the real loop collects them and raises P0002, rolling back the
      // whole RPC tx) so a bad patch can't half-apply the batch.
      const missing = patches.filter(p => !rows.has(p.id)).map(p => p.id)
      if (missing.length > 0) {
        throw new Error(`fakeSyncServer: apply_block_patches P0002 — missing ids ${JSON.stringify(missing)}`)
      }
      for (const { id, payload } of patches) {
        const old = rows.get(id)!
        const next: ServerBlockRow = { ...old }

        // Closed column list with COALESCE(patch->>'col', col): absent OR
        // JSON-null keeps the server value — except parent_id, which is
        // key-presence-gated so explicit null re-roots (20260612000000 ~L96).
        if ('parent_id' in payload) next.parent_id = (payload.parent_id ?? null) as string | null
        const coalesce = <K extends keyof ServerBlockRow>(key: K, v: unknown): void => {
          if (v !== undefined && v !== null) next[key] = v as ServerBlockRow[K]
        }
        if (payload.workspace_id != null && payload.workspace_id !== old.workspace_id) {
          // blocks_prevent_workspace_change — workspace_id is immutable.
          throw new Error(`fakeSyncServer: workspace_id change rejected for ${id}`)
        }
        coalesce('order_key', payload.order_key)
        coalesce('content', payload.content)
        coalesce('properties_json', payload.properties_json)
        coalesce('references_json', payload.references_json)
        coalesce('created_at', payload.created_at)
        coalesce('updated_at', payload.updated_at)
        coalesce('user_updated_at', payload.user_updated_at)
        coalesce('created_by', payload.created_by)
        coalesce('updated_by', payload.updated_by)
        if (payload.deleted !== undefined && payload.deleted !== null) {
          next.deleted = asBool(payload.deleted)
        }

        // UPDATE-path clamp: common future-clamps, then the monotonic
        // floor, then the +1 content bump (20260612000000 L48-63).
        clampCommon(next)
        next.updated_at = Math.max(next.updated_at, old.updated_at)
        const contentChanged = CONTENT_COLUMNS.some(col => next[col] !== old[col])
        if (contentChanged) {
          next.updated_at = Math.max(next.updated_at, old.updated_at + 1)
        }

        rows.set(id, next)
        touch(id)
      }
    },

    async deleteRow(id) {
      throw new Error(
        `fakeSyncServer: unexpected hard DELETE for ${id} — the v1 upload path has no DELETE op (soft delete is a PATCH); a hard delete reaching the sink is a bug`,
      )
    },

    async deliverTo(db, cursor) {
      // Deterministic order: by (version) — the change stream is ordered.
      const pending = [...versions.entries()]
        .filter(([, v]) => v > cursor)
        .sort((a, b) => a[1] - b[1])
      for (const [id] of pending) {
        await db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, rowParams(rows.get(id)!))
      }
      return version
    },

    version: () => version,

    rows: () =>
      [...rows.values()]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(row => Object.fromEntries(COLUMN_NAMES.map(name =>
          [name, name === 'deleted' ? (row.deleted ? 1 : 0) : row[name as keyof ServerBlockRow]]))),
  }
}
