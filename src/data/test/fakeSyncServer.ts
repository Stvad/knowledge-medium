/**
 * In-memory fake of the Supabase sync server, for two-device convergence
 * tests. Sits behind the REAL upload pipeline (`runUploadLoop` →
 * `compactBlockCrudEntries` → `applyCompactedBlockOperations`, via the
 * injectable `BlockUploadSink` seam) and delivers rows back into a
 * device's `blocks_synced` raw table exactly the way PowerSync does
 * (`BLOCKS_SYNCED_RAW_TABLE.put`, verbatim server row).
 *
 * Server-side write semantics modeled below, each at the site that
 * implements it: `apply_block_creates`'s insert-or-TOUCH, `apply_block_patches`'
 * closed column list, the `blocks_clamp_updated_at` drift/un-drift split,
 * `blocks_prevent_workspace_change`, and the hard-DELETE refusal.
 *
 * Delivery: a per-row monotonically increasing `version` (bumped on every
 * server-side write, including the create-conflict touch) plus a
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
 *  (20260612000000's `blocks_clamp_updated_at` lists the deliberate
 *  EXCLUSIONS; this is the complement). */
const CONTENT_COLUMNS = [
  'parent_id', 'order_key', 'content', 'properties_json', 'references_json', 'deleted',
] as const

const asBool = (v: unknown): boolean => v === true || v === 1 || v === 'true'

/** How far past server-now the drift bump trusts a client's proposed stamp
 *  (`max_trusted_skew_ms`, 20260803000000). Unbounded, a crafted or badly
 *  broken clock could pin a row's version at bigint max, after which every
 *  later `+ 1` raises 22003 and the row is permanently uneditable.
 *
 *  Exported so a boundary test can derive its input from this rather than
 *  restating the number: a test that hardcodes 3_600_000 stops sitting on the
 *  boundary the moment this value changes, and goes on passing while testing
 *  nothing. */
export const MAX_TRUSTED_SKEW_MS = 3_600_000

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

/** `apply_block_creates` (20260709000000) INSERTs every column
 *  explicitly, so an absent JSON key becomes an explicit SQL NULL. That
 *  23502-violates every one of these columns even though some declare a SQL
 *  DEFAULT (the `blocks` table's column defaults, e.g. `content ... DEFAULT
 *  '' NOT NULL`) — a DEFAULT only fires when the column is OMITTED from the
 *  INSERT's column list, not when NULL is explicitly supplied, and this RPC
 *  always supplies a value. Excluded on purpose: `parent_id` (nullable,
 *  no NOT NULL), `user_updated_at` (nullable — the clamp trigger backfills
 *  it from `updated_at` when NULL), and `deleted`
 *  (the RPC itself does `COALESCE((c->>'deleted')::boolean, false)` rather
 *  than relying on the column DEFAULT). */
const REQUIRED_CREATE_FIELDS = [
  'workspace_id', 'order_key', 'content', 'properties_json', 'references_json',
  'created_at', 'updated_at', 'created_by', 'updated_by',
] as const

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

  /** The clamp trigger's BOTH-paths section (20260803000000, the section
   *  20260612000000 originally introduced): future-clamp both stamps, then
   *  populate/clamp user_updated_at from the ALREADY-CLAMPED updated_at.
   *
   *  `serverNow` is passed in rather than read here because the trigger
   *  computes `server_now_ms` ONCE per invocation and the drift branch below
   *  needs the same value — and because `opts.now` is a counter in the fuzz
   *  harness, so a second call would silently advance the server clock. */
  const clampCommon = (row: ServerBlockRow, serverNow: number): void => {
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
        // Real Postgres raises 23502 (NOT NULL violation) here instead of
        // silently defaulting — see REQUIRED_CREATE_FIELDS above for why an
        // absent key isn't the same as an omitted column server-side. A
        // regression that drops a column from the upload payload (e.g. an
        // upload-trigger change) must fail loud here instead of quarantining
        // silently in prod.
        const missing = REQUIRED_CREATE_FIELDS.filter(
          key => payload[key] === undefined || payload[key] === null,
        )
        if (missing.length > 0) {
          throw new Error(
            `fakeSyncServer: apply_block_creates 23502 — missing required field(s) ${JSON.stringify(missing)} for ${id}`,
          )
        }
        const row: ServerBlockRow = {
          id,
          workspace_id: payload.workspace_id as string,
          parent_id: (payload.parent_id ?? null) as string | null,
          order_key: payload.order_key as string,
          content: payload.content as string,
          properties_json: payload.properties_json as string,
          references_json: payload.references_json as string,
          created_at: payload.created_at as number,
          updated_at: payload.updated_at as number,
          user_updated_at: (payload.user_updated_at ?? null) as number | null,
          created_by: payload.created_by as string,
          updated_by: payload.updated_by as string,
          deleted: asBool(payload.deleted ?? false),
        }
        clampCommon(row, opts.now()) // INSERT path: future-clamp only — no floor, no bump.
        rows.set(id, row)
        touch(id)
      }
    },

    async applyPatches(patches) {
      // Both rejection checks run before ANY mutation — the real RPC rolls
      // the whole call back (missing id raises P0002, a workspace_id change
      // trips `blocks_prevent_workspace_change`), so a per-patch check would
      // leave the fake non-atomic where Postgres is not.
      // Unreachable in this fuzz universe (creates precede patches; ids
      // arrive via delivery) — a real hit here is a bug to surface, not a
      // case to handle gracefully.
      const missing = patches.filter(p => !rows.has(p.id)).map(p => p.id)
      if (missing.length > 0) {
        throw new Error(`fakeSyncServer: apply_block_patches P0002 — missing ids ${JSON.stringify(missing)}`)
      }
      // The upload PATCH always includes workspace_id (clientSchema.ts's
      // `blockUploadPatchJsonSql`, for the Phase-D AAD hook), so presence
      // alone isn't a signal — only a value change is rejected.
      const workspaceChange = patches.find(({ id, payload }) => {
        const old = rows.get(id)!
        return payload.workspace_id != null && payload.workspace_id !== old.workspace_id
      })
      if (workspaceChange) {
        // blocks_prevent_workspace_change — workspace_id is immutable.
        throw new Error(`fakeSyncServer: workspace_id change rejected for ${workspaceChange.id}`)
      }
      for (const { id, payload } of patches) {
        const old = rows.get(id)!
        const next: ServerBlockRow = { ...old }

        // Closed column list with COALESCE(patch->>'col', col): absent OR
        // JSON-null keeps the server value — except parent_id, which is
        // key-presence-gated so explicit null re-roots (20260612000000's
        // `apply_block_patches`).
        if ('parent_id' in payload) next.parent_id = (payload.parent_id ?? null) as string | null
        const coalesce = <K extends keyof ServerBlockRow>(key: K, v: unknown): void => {
          if (v !== undefined && v !== null) next[key] = v as ServerBlockRow[K]
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

        // UPDATE-path clamp (20260803000000's `blocks_clamp_updated_at`,
        // replacing the pre-drift version in 20260612000000).
        const serverNow = opts.now()
        // The proposed stamp BEFORE the future-clamp — the drift bump must
        // clear the AUTHOR'S local stamp, which is this raw value.
        const rawProposed = next.updated_at
        clampCommon(next, serverNow)

        // Drift = "the server row moved under this edit". `base_updated_at` is
        // the version the client edited against; absent (old client) or the
        // 0 pristine sentinel carry no information, so both read as drifted.
        // Deliberately NOT content-gated — see the migration header for why
        // comparing the merged row to OLD answers the wrong question. One
        // consequence: two devices writing the same value can merge to a
        // row identical to OLD while the author still lacks whatever else
        // the other device changed.
        // `apply_block_patches` reads the base with `patch->>'base_updated_at'`,
        // which yields the same TEXT for a JSON number and a JSON string of
        // digits — so the real server compares both, and both are then filtered
        // by `^[0-9]{1,18}$` (anything else, including an explicit JSON null and
        // an absent key, becomes the '0' sentinel). Modelling only the number
        // form would make this oracle bump where production does not, which is
        // the direction that HIDES a convergence bug rather than inventing one.
        const base = payload.base_updated_at
        const baseVersion = typeof base === 'number' ? base
          : typeof base === 'string' && /^[0-9]{1,18}$/.test(base) ? Number(base)
            : null
        const drifted = baseVersion === null || baseVersion === 0
          || baseVersion !== old.updated_at

        if (drifted) {
          next.updated_at = Math.max(
            serverNow,
            old.updated_at,
            Math.min(rawProposed, serverNow + MAX_TRUSTED_SKEW_MS),
          ) + 1
          // A proposal exactly one past the cap makes the min() return the cap,
          // so `+ 1` hands back that same proposal — the author's own stamp,
          // which is the equal stamp the echo skip keys on.
          if (next.updated_at === rawProposed) next.updated_at += 1
        } else {
          next.updated_at = Math.max(next.updated_at, old.updated_at)
          const contentChanged = CONTENT_COLUMNS.some(col => next[col] !== old[col])
          if (contentChanged) {
            next.updated_at = Math.max(next.updated_at, old.updated_at + 1)
          }
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
        // JS `<`/`>` compares UTF-16 code units; SQLite's default BINARY
        // collation (what `ORDER BY id` on the real device DBs uses)
        // compares UTF-8 bytes — the two orders diverge only for non-ASCII
        // ids, which this fuzz universe never mints ('root', `a-gen-*`,
        // `b-gen-*`).
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(row => Object.fromEntries(COLUMN_NAMES.map(name =>
          [name, name === 'deleted' ? (row.deleted ? 1 : 0) : row[name as keyof ServerBlockRow]]))),
  }
}
