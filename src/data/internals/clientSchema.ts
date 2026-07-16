/** Client-side SQLite schema additions on top of the PowerSync-managed
 *  `blocks` table. None of these tables are synced — they're the local
 *  mechanism for tx context, per-row audit, per-tx audit, upload routing,
 *  and local side indexes. The client-only triggers live here too —
 *  server-side Postgres has no `powersync_crud` and no need for any of
 *  them. See data-layer-redesign §4.2 / §4.3 / §4.4 / §4.5 / §4.1.1.
 *
 *  Run from `repoProvider.ts` after PowerSync's own schema initialization:
 *
 *      for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
 *        await db.execute(stmt)
 *      }
 */

import {
  ALIAS_COLLISION_RAISE_PREFIX,
  PARENT_DELETED_RAISE_PREFIX,
  RAISE_FIELD_SEP_SQL,
} from './raiseProtocol'

// ============================================================================
// Tables
// ============================================================================

/** Single-row table. Triggers read it via
 *  `(SELECT … FROM tx_context WHERE id = 1)`. Why not a TEMP table:
 *  triggers in `main` schema cannot reference `temp.X` tables. The
 *  TxEngine sets all five fields at the start of `writeTransaction`
 *  and clears them (back to NULL) at the end.
 *
 *  `tx_seq` is the integer tx-grouping key the upload-routing triggers
 *  copy into `ps_crud.tx_id`. PowerSync's `getNextCrudTransaction()`
 *  groups CRUD entries by `ps_crud.tx_id`; without it, a multi-row
 *  `repo.tx` uploads as N separate server-side transactions. The text
 *  `tx_id` (above) is what `row_events` records — distinct because
 *  audit doesn't need integer grouping and the text form is friendlier
 *  for log inspection. */
export const CREATE_TX_CONTEXT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS tx_context (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    tx_id    TEXT,
    tx_seq   INTEGER,
    user_id  TEXT,
    scope    TEXT,
    source   TEXT,
    group_id TEXT
  )
`

/** Idempotent seed of the single row. Re-runs are no-ops. */
export const SEED_TX_CONTEXT_ROW_SQL = `
  INSERT OR IGNORE INTO tx_context (id) VALUES (1)
`

/** Per-row audit / change-history log. Trigger-written on every write to
 *  `blocks` — local (`repo.tx`) and sync-applied (observer materialize) alike
 *  — capturing the full before/after row state of each change. `tx_id` = NULL
 *  for sync-applied writes (see the COALESCE / CASE in the row_events triggers
 *  below); `source` distinguishes 'user' from 'sync'.
 *
 *  This is the substrate for local change history / time-travel, and the ONLY
 *  place an INCOMING sync change is durably recorded — `command_events` covers
 *  local `repo.tx` operations only (mutator-grain), never sync apply. Nothing
 *  reads `row_events` at runtime: the Layout B observer owns invalidation, so
 *  this is a write-only history log.
 *
 *  Intentionally unbounded — full history is kept and never auto-trimmed. Any
 *  retention policy is a future opt-in, never a silent drop (preserving user
 *  history is paramount). Client-only; never synced. */
export const CREATE_ROW_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS row_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id       TEXT,
    block_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    group_id    TEXT
  )
`

export const CREATE_ROW_EVENTS_TX_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_row_events_tx
  ON row_events (tx_id)
`

export const CREATE_ROW_EVENTS_BLOCK_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_row_events_block
  ON row_events (block_id, created_at DESC)
`

export const CREATE_ROW_EVENTS_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_row_events_created
  ON row_events (created_at DESC)
`

/** Per-tx metadata. One row per `repo.tx` invocation. Sync-applied writes
 *  don't go through `repo.tx` and therefore don't produce
 *  `command_events`. */
export const CREATE_COMMAND_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS command_events (
    tx_id         TEXT PRIMARY KEY,
    description   TEXT,
    scope         TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    workspace_id  TEXT,
    mutator_calls TEXT NOT NULL,
    source        TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )
`

export const CREATE_COMMAND_EVENTS_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_command_events_created
  ON command_events (created_at DESC)
`

export const CREATE_COMMAND_EVENTS_WORKSPACE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_command_events_workspace
  ON command_events (workspace_id, created_at DESC)
`

/** Trigger-maintained side index of `(workspace_id, alias) → block_id`,
 *  derived from the `alias` entry in each live block's `properties_json`.
 *
 *  The previous shape walked `json_each(properties_json, '$.alias')` per
 *  query, which scans the full workspace partition every time. With
 *  150-MB-class workspaces this is the dominant cost in alias-heavy
 *  paths (Roam import, parseReferences, autocomplete). The
 *  index gives O(log n) `(workspace_id, alias_lower?)` lookup at the
 *  cost of three triggers and one extra row per (block, alias) pair.
 *
 *  Local-only: the table is fully derivable from `blocks.properties_json`
 *  so it is not synced — PowerSync's CRUD-apply path writes through
 *  `BLOCKS_RAW_TABLE.put` (an `INSERT … ON CONFLICT DO UPDATE`) which
 *  fires our INSERT/UPDATE triggers, populating this table on incoming
 *  sync the same way local writes do.
 *
 *  Soft-delete: triggers keep block_aliases empty for blocks where
 *  `deleted = 1`. Hard-delete (the DELETE row_event trigger on blocks
 *  is reserved for future purges) also clears via the DELETE trigger
 *  here. Restoring a tombstone (`UPDATE deleted = 1 → 0`) re-fires the
 *  UPDATE trigger and re-populates from `properties_json`.
 *
 *  PRIMARY KEY (block_id, alias) makes the per-(block, alias) write
 *  idempotent under `INSERT OR IGNORE` (e.g. duplicate aliases on the
 *  same block, or backfill running over already-populated rows).
 *  `alias` is stored verbatim (case preserved); `alias_lower` is the
 *  pre-computed `LOWER(alias)` so case-insensitive autocomplete doesn't
 *  re-evaluate `LOWER()` per row.
 */
export const CREATE_BLOCK_ALIASES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS block_aliases (
    block_id     TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    alias_lower  TEXT NOT NULL,
    PRIMARY KEY (block_id, alias)
  )
`

/** Case-sensitive exact-match path: parseReferences `lookupAliasTarget`
 *  and `findBlockByAliasInWorkspace`. */
export const CREATE_BLOCK_ALIASES_WS_ALIAS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias
  ON block_aliases (workspace_id, alias)
`

/** Tiny key/value table for one-shot schema-bootstrapping markers
 *  (currently only the alias backfill). Local-only — the markers
 *  describe the state of a derived index on this device, not anything
 *  the server cares about.
 *
 *  Why a dedicated table instead of "is block_aliases empty?": a
 *  legitimately empty workspace, or a workspace whose user removed
 *  every alias, would otherwise re-trigger the full backfill scan on
 *  every launch — which is exactly what the LIMIT 1 short-circuit was
 *  meant to avoid. The marker captures "we ran the backfill once for
 *  this schema version" directly. */
export const CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS client_schema_state (
    key           TEXT PRIMARY KEY,
    completed_at  INTEGER NOT NULL
  )
`

/** Case-insensitive substring/prefix path for alias autocomplete. */
export const CREATE_BLOCK_ALIASES_WS_ALIAS_LOWER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias_lower
  ON block_aliases (workspace_id, alias_lower)
`

export const DROP_BLOCKS_WORKSPACE_TYPE_INDEX_SQL = `
  DROP INDEX IF EXISTS idx_blocks_workspace_type
`

/** Trigger-maintained membership index over `properties_json.$.types`.
 *  This replaces the old scalar `$.type` expression index: SQLite
 *  cannot expression-index array membership directly, so by-type
 *  queries join through this local side table. */
export const CREATE_BLOCK_TYPES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS block_types (
    block_id     TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    type         TEXT NOT NULL,
    PRIMARY KEY (block_id, type)
  )
`

export const CREATE_BLOCK_TYPES_TYPE_WORKSPACE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_block_types_type_workspace
  ON block_types (type, workspace_id)
`

/** Stable integer rowids for `blocks_fts`.
 *
 *  FTS5 rows are keyed by integer `rowid`, but `blocks.id` is a string
 *  UUID. Deleting/updating by an UNINDEXED `block_id` column would scan
 *  the whole FTS table on every content edit, so this tiny local map
 *  gives each block a stable integer key that triggers can use for
 *  O(log n) lookup + rowid-targeted FTS maintenance.
 *
 *  Local-only and fully derivable. Soft-deletes keep the mapping so a
 *  later restore reuses the same FTS rowid; hard-deletes clear it. */
export const CREATE_BLOCKS_FTS_ROWIDS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks_fts_rowids (
    fts_rowid  INTEGER PRIMARY KEY,
    block_id   TEXT NOT NULL UNIQUE
  )
`

/** Trigger-maintained trigram FTS5 index over live `blocks.content`.
 *
 *  `trigram` preserves the old substring-search capability of
 *  `LIKE '%query%'` while moving the search onto an index. The
 *  workspace/block id columns are stored for filtering and joining but
 *  are not indexed as text terms. */
export const CREATE_BLOCKS_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content,
    workspace_id UNINDEXED,
    block_id UNINDEXED,
    tokenize = 'trigram case_sensitive 0'
  )
`

/** Quarantine for `ps_crud` rows whose upload the server refused with a
 *  permanent error (FK violation, RLS denial, insufficient privilege,
 *  4xx that can't recover on retry). The PowerSync upload handler moves
 *  rejected txs here so the queue can keep draining instead of blocking
 *  on a write that will never succeed; the row preserves enough context
 *  for a later UI surface ("N changes couldn't sync") and post-hoc
 *  inspection.
 *
 *  Local-only — the server has no view of what its own rejections
 *  looked like from the client side, and these rows reference the
 *  client's `ps_crud.id` which doesn't exist on the server anyway. */
export const CREATE_PS_CRUD_REJECTED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ps_crud_rejected (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id   INTEGER NOT NULL,
    tx_id         INTEGER NOT NULL,
    data          TEXT NOT NULL,
    error_code    TEXT,
    error_message TEXT,
    rejected_at   INTEGER NOT NULL
  )
`

export const CREATE_PS_CRUD_REJECTED_REJECTED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ps_crud_rejected_rejected_at
  ON ps_crud_rejected (rejected_at DESC)
`

export const CREATE_PS_CRUD_REJECTED_TX_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ps_crud_rejected_tx_id
  ON ps_crud_rejected (tx_id)
`

// ============================================================================
// blocks_synced change-capture queue (Layout B, design doc §9.2) — the
// observer's O(delta) detection signal, replacing an O(N) re-scan of the whole
// staging table on every startup/tick.
//
// PowerSync's sync-apply runs the raw-table put/delete statements
// (BLOCKS_SYNCED_RAW_TABLE) directly against `blocks_synced` as ordinary SQL,
// and those INSERT/DELETE statements fire the AFTER triggers below — the
// signal the observer drains to materialize each change into the live `blocks`
// table (the production sync-invalidation path).
//
// APPEND-ONLY LOG keyed by a monotonic `seq`, drained with a watermark
// pattern: the observer reads rows up to MAX(seq),
// processes them, then `DELETE … WHERE seq <= <that max>`. This is robust to
// the two things a coalescing id-keyed table is NOT:
//   - Drain race: a delivery that lands mid-drain gets a higher seq, so the
//     watermark delete can't remove its signal (an id-keyed REPLACE would have
//     overwritten the very row being processed and lost the newer change).
//   - Partial failure: if processing throws, the delete is never reached, so
//     the rows stay queued and retry on the next tick / next startup.
// Coalescing still happens, in JS at drain time (latest op per id wins), so a
// hot row is materialized once per batch, not once per delivery.
//
//   - INSERT trigger → 'upsert'. The raw put is `INSERT OR REPLACE`, and
//     PowerSync applies a *changed* synced row as this REPLACE (a DELETE then
//     an INSERT), never a bare UPDATE. Left alone, every changed block would
//     enqueue BOTH a 'delete' (the replace's implicit DELETE) and an 'upsert' —
//     two rows for one logical upsert, inflating the pending count ~2× and
//     wasting drain windows on no-op delete passes. So the INSERT trigger
//     COLLAPSES at enqueue: it drops a pending same-id 'delete' before appending
//     its 'upsert', netting a single 'upsert' per REPLACE. This is safe because
//     the REPLACE's delete-then-insert is one atomic statement and the drain
//     reads the queue only after the apply tx commits — it never sees a partial
//     (delete-without-insert) REPLACE. (No UPDATE trigger: PowerSync never
//     issues a bare UPDATE against the raw table.)
//   - DELETE trigger → 'delete'. A real stream-exit (membership revoke /
//     workspace delete) has no following INSERT, so its 'delete' survives the
//     collapse and supersedes an un-drained 'upsert'; it is captured DURABLY so
//     a removal that lands while the observer is down is still drained on next
//     startup.
//
// No source-gating: these are not upload triggers, so they fire on both sync
// and (the rare) local writes to the staging table. blocks_synced itself
// carries no upload routing, so this never enqueues a server write.
// ============================================================================

export const CREATE_BLOCKS_SYNCED_CHANGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks_synced_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id  TEXT NOT NULL,
    op  TEXT NOT NULL CHECK (op IN ('upsert', 'delete'))
  )
`

/** Indexes the enqueue-collapse lookup in `blocks_synced_changes_insert`
 *  (`DELETE … WHERE id = NEW.id AND op = 'delete'`). The table is otherwise
 *  keyed only by the autoincrement `seq`, so without this index that per-insert
 *  delete would SCAN the entire pending queue on every staging insert — even a
 *  brand-new id with no matching 'delete'. During a bulk sync/backfill the queue
 *  grows (within one PowerSync apply tx) far faster than the observer drains, so
 *  an unindexed scan turns the apply into O(n²) — the exact large-download case
 *  this queue exists to keep cheap (the ~310K-row backfill that motivated the
 *  collapse). With the index the lookup is an O(log n) seek, including the common
 *  no-match insert. The drain still reads/deletes by `seq` (PK), so this index
 *  only serves the collapse delete; its maintenance cost on queue insert + the
 *  drain's `DELETE … WHERE seq <= ?` is O(log n) per row. */
export const CREATE_BLOCKS_SYNCED_CHANGES_ID_OP_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_synced_changes_id_op
  ON blocks_synced_changes (id, op)
`

export const CREATE_BLOCKS_SYNCED_CHANGES_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_synced_changes_insert
  AFTER INSERT ON blocks_synced
  BEGIN
    DELETE FROM blocks_synced_changes WHERE id = NEW.id AND op = 'delete';
    INSERT INTO blocks_synced_changes (id, op) VALUES (NEW.id, 'upsert');
  END
`

export const CREATE_BLOCKS_SYNCED_CHANGES_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_synced_changes_delete
  AFTER DELETE ON blocks_synced
  BEGIN
    INSERT INTO blocks_synced_changes (id, op) VALUES (OLD.id, 'delete');
  END
`

// ============================================================================
// row_events triggers (3) — the per-row audit / change-history log. Fire for
// BOTH local (`repo.tx`) and sync-applied (observer materialize) writes to
// `blocks`; the COALESCE-to-'sync' tag distinguishes them. Nothing reads
// row_events at runtime — the Layout B observer owns invalidation — so this is
// a write-only history substrate (local change-history / time-travel; the only
// durable record of incoming sync changes).
//
// Soft-delete semantics (§4.3): tx.delete sets deleted = 1 (UPDATE), so it
// fires the UPDATE trigger. The body inspects whether `deleted` transitioned
// from 0 to 1 and writes kind = 'soft-delete' instead of 'update'.
// ============================================================================

/** Serializes a blocks row (NEW or OLD) to the JSON snapshot stored in
 *  `row_events.{before,after}_json`. NEW / OLD references resolve at
 *  trigger time. */
const blockJsonObjectSql = (rowRef: 'NEW' | 'OLD') => `
      json_object(
        'id', ${rowRef}.id,
        'workspaceId', ${rowRef}.workspace_id,
        'parentId', ${rowRef}.parent_id,
        'referenceTargetId', ${rowRef}.reference_target_id,
        'orderKey', ${rowRef}.order_key,
        'content', ${rowRef}.content,
        'properties', json(${rowRef}.properties_json),
        'references', json(${rowRef}.references_json),
        'createdAt', ${rowRef}.created_at,
        'updatedAt', ${rowRef}.updated_at,
        'userUpdatedAt', coalesce(${rowRef}.user_updated_at, ${rowRef}.updated_at),
        'createdBy', ${rowRef}.created_by,
        'updatedBy', ${rowRef}.updated_by,
        'deleted', json(CASE WHEN ${rowRef}.deleted THEN 'true' ELSE 'false' END)
      )
`.trim()

/** Belt-and-suspenders source gate for tx_context projections: the column
 *  is the active local tx's value only when source IS NOT NULL. Sync-applied
 *  writes leave source = NULL (no `repo.tx` is open during the observer's
 *  materialize); without this guard a stale tx_id / group_id left in
 *  `tx_context` from the previous local tx would leak into the sync-applied
 *  row_events row. The TxEngine clears all fields at end-of-tx; the trigger
 *  logic is the load-bearing correctness check. One template for both
 *  columns so the gate can't silently diverge between them. */
const triggerCtxColumnSql = (column: 'tx_id' | 'group_id') => `
      CASE
        WHEN (SELECT source FROM tx_context WHERE id = 1) IS NULL
          THEN NULL
        ELSE (SELECT ${column} FROM tx_context WHERE id = 1)
      END
`.trim()

const triggerTxIdSql = triggerCtxColumnSql('tx_id')

const triggerSourceSql = `COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`

/** Undo-group token (issue #306) — same source-gated projection as tx_id. */
const triggerGroupIdSql = triggerCtxColumnSql('group_id')

export const CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_insert
  AFTER INSERT ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${triggerTxIdSql},
      NEW.id,
      'create',
      NULL,
      ${blockJsonObjectSql('NEW')},
      ${triggerSourceSql},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${triggerGroupIdSql}
    );
  END
`

export const CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_update
  AFTER UPDATE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${triggerTxIdSql},
      NEW.id,
      CASE
        WHEN OLD.deleted = 0 AND NEW.deleted = 1 THEN 'soft-delete'
        ELSE 'update'
      END,
      ${blockJsonObjectSql('OLD')},
      ${blockJsonObjectSql('NEW')},
      ${triggerSourceSql},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${triggerGroupIdSql}
    );
  END
`

/** DELETE row_event writer captures hard purges. Hard deletes do not sync —
 *  PowerSync sees the row vanish locally; soft-delete via the synced
 *  `deleted` column is what propagates "this row is gone" through sync. */
export const CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_delete
  AFTER DELETE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${triggerTxIdSql},
      OLD.id,
      'delete',
      ${blockJsonObjectSql('OLD')},
      NULL,
      ${triggerSourceSql},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${triggerGroupIdSql}
    );
  END
`

// ============================================================================
// Upload-routing triggers (2) — fire for any LOCAL repo.tx write
// (source IS NOT NULL). Sync-applied writes leave source = NULL and so
// are skipped — those rows are already on the server. Every other write
// (BlockDefault / UiState / UserPrefs / References) enqueues; the
// upload handler's per-tx fallback + rejection quarantine handles any
// server-side refusal.
//
// v1: NO upload-routing trigger for DELETE. Hard-delete (physical removal)
// is not a v1 operation and would require a separate purge-semantics
// decision (sync hard-deletes vs. local-only purge). Soft-deletes go
// through tx.delete → UPDATE deleted = 1 → fires the UPDATE upload trigger
// below, which forwards correctly. See §4.5.
//
// The upload SQL writes through PowerSync's standard powersync_crud queue:
//   ps_crud (tx_id INTEGER, data TEXT)
// where data is a JSON envelope { op, type, id, data }. PowerSync picks
// rows out of ps_crud and uploads them via the configured connector.
// ============================================================================

interface UploadColumnSpec {
  readonly name: string
  readonly jsonValue: (rowRef: string) => string
}

/** Column projection used by the upload-routing triggers. Anything
 *  that emits an upload envelope must source its data shape from this
 *  list. */
const BLOCK_UPLOAD_COLUMNS: readonly UploadColumnSpec[] = [
  {name: 'workspace_id', jsonValue: rowRef => `${rowRef}.workspace_id`},
  {name: 'parent_id', jsonValue: rowRef => `${rowRef}.parent_id`},
  {name: 'order_key', jsonValue: rowRef => `${rowRef}.order_key`},
  {name: 'content', jsonValue: rowRef => `${rowRef}.content`},
  {name: 'properties_json', jsonValue: rowRef => `${rowRef}.properties_json`},
  {name: 'references_json', jsonValue: rowRef => `${rowRef}.references_json`},
  {name: 'created_at', jsonValue: rowRef => `${rowRef}.created_at`},
  {name: 'updated_at', jsonValue: rowRef => `${rowRef}.updated_at`},
  {name: 'user_updated_at', jsonValue: rowRef => `${rowRef}.user_updated_at`},
  {name: 'created_by', jsonValue: rowRef => `${rowRef}.created_by`},
  {name: 'updated_by', jsonValue: rowRef => `${rowRef}.updated_by`},
  {
    name: 'deleted',
    jsonValue: rowRef => `json(CASE WHEN ${rowRef}.deleted THEN 'true' ELSE 'false' END)`,
  },
]

const blockUploadJsonSql = (rowRef: string) => `
      json_object(
${BLOCK_UPLOAD_COLUMNS.map(column => `        '${column.name}', ${column.jsonValue(rowRef)}`).join(',\n')}
      )
`.trim()

const blockUploadDiffPredicateSql = BLOCK_UPLOAD_COLUMNS
  .map(column => `OLD.${column.name} IS NOT NEW.${column.name}`)
  .join('\n    OR ')

// workspace_id is emitted UNCONDITIONALLY (not gated on OLD IS NOT NEW): the
// Phase D encrypt-on-upload hook needs it on EVERY PATCH to look up the
// workspace key and build the per-column AAD, but a content-only edit wouldn't
// otherwise change workspace_id and so would omit it. A self-write of the
// unchanged workspace_id is a harmless no-op server-side. The remaining columns
// stay change-gated to keep PATCHes column-narrow.
const blockUploadPatchJsonSql = () => `
      json_remove(
        json_set(
          '{}',
          '$.workspace_id', NEW.workspace_id,
${BLOCK_UPLOAD_COLUMNS.filter(column => column.name !== 'workspace_id').map(column =>
  `          CASE WHEN OLD.${column.name} IS NOT NEW.${column.name} THEN '$.${column.name}' ELSE '$.__noop' END, ${column.jsonValue('NEW')}`,
).join(',\n')}
        ),
        '$.__noop'
      )
`.trim()

// tx_id on ps_crud is what PowerSync's `getNextCrudTransaction()` groups
// by, so a multi-row repo.tx uploads as a single server-side transaction.
// Read it from `tx_context.tx_seq` (a non-null INTEGER set by the engine
// at tx start). Without this, every row in a multi-write tx ships as its
// own CrudTransaction and atomicity intent is lost on the server.
const triggerTxSeqSql = `(SELECT tx_seq FROM tx_context WHERE id = 1)`

export const CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_upload_insert
  AFTER INSERT ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${triggerTxSeqSql},
      json_object(
        'op', 'PUT',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${blockUploadJsonSql('NEW')}
      )
    );
  END
`

export const CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_upload_update
  AFTER UPDATE ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND (
    ${blockUploadDiffPredicateSql}
    )
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${triggerTxSeqSql},
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${blockUploadPatchJsonSql()}
      )
    );
  END
`

// ============================================================================
// Workspace-invariant triggers (2) — gate on `source IS NOT NULL`, so they
// fire ONLY for writes made through repo.tx. Sync-applied writes leave
// source = NULL and bypass these checks (the server FK + composite-FK shape
// already validated those). Raw out-of-band writes (forbidden by §4.2's
// discipline rule) also leave source = NULL and would bypass — that's why
// the rule is "no third write path"; this trigger is not a safety net for
// raw writes.
//
// The `NOT EXISTS` predicate catches two failure modes in one check: dangling
// parent (id pointing to nothing) and cross-workspace parent. Does NOT filter
// on `deleted = 0` — that rule has its own trigger
// (`blocks_parent_not_deleted_check_*`) below, with a structured RAISE the
// engine translates back to `ParentDeletedError`. Splitting the two keeps
// the error messages distinguishable and each predicate one PK lookup.
// ============================================================================

export const CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_parent_workspace_check_insert
  BEFORE INSERT ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'parent must exist and share workspace_id')
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND workspace_id = NEW.workspace_id
    );
  END
`

export const CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_parent_workspace_check_update
  BEFORE UPDATE OF parent_id, workspace_id ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'parent must exist and share workspace_id')
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND workspace_id = NEW.workspace_id
    );
  END
`

// ============================================================================
// parent-not-deleted triggers — refuse to land a live child under a
// tombstoned parent on any local write path. Mirrors the alias-uniqueness
// trigger's pattern: the invariant moves from app code (kernel mutator
// preflight) into the schema so every path — `tx.create`, `tx.move`,
// `tx.restore`, future plugins — gets the check by construction.
//
// Skipped when `tx_context.source IS NULL` so PowerSync sync-apply doesn't
// fail on the transient "child arrives before parent's tombstone" cross-
// client ordering. Spec §4.1.1: server FK accepts tombstoned parents;
// strict-local / permissive-sync is the documented asymmetry.
//
// The RAISE message is structured: `parent_deleted` followed by a
// US-separated (char(31)) parent id. The tx engine catches errors with
// this prefix and re-throws as `ParentDeletedError(parentId)` — keeping
// the existing typed error class for callers that already
// `instanceof`-check it.
//
// INSERT trigger gate: NEW.parent_id IS NOT NULL AND NEW.deleted = 0.
// `tx.create` always builds rows with `deleted = false`, so this skips
// the no-op case of a tombstone insert (sync apply, which also bypasses
// the source gate).
//
// UPDATE trigger fires on `parent_id` OR `deleted` change. The deleted
// gate matters for two cases: (a) `tx.restore` flips `deleted = 0` while
// `parent_id` stays pinned, (b) `applyRaw` (undo/redo) UPDATEs all
// columns including `deleted`. Both must respect the rule. Subtree-
// delete cascading is unaffected — `softDeleteSubtree` visits the parent
// first, so by the time a descendant is processed its parent is already
// tombstoned but the descendant's UPDATE has `NEW.deleted = 1`, which
// the WHEN clause excludes.
//
// Undo/redo replay does NOT rely on any mutator's first-touch snapshot
// order: `_replay` applies rows via `replayApplicationOrder`
// (txSnapshots.ts) — live targets parents-first, tombstones last — so
// a descendant's restore always sees a live parent regardless of how
// the original tx happened to touch rows (core.merge, for one, touches
// rehomed children before the from-block's tombstone).
// ============================================================================

export const CREATE_BLOCKS_PARENT_NOT_DELETED_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_parent_not_deleted_check_insert
  BEFORE INSERT ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND NEW.deleted = 0
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,
      '${PARENT_DELETED_RAISE_PREFIX}' || ${RAISE_FIELD_SEP_SQL} || NEW.parent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND deleted = 1
    );
  END
`

export const CREATE_BLOCKS_PARENT_NOT_DELETED_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_parent_not_deleted_check_update
  BEFORE UPDATE OF parent_id, deleted ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND NEW.deleted = 0
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,
      '${PARENT_DELETED_RAISE_PREFIX}' || ${RAISE_FIELD_SEP_SQL} || NEW.parent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND deleted = 1
    );
  END
`

// ============================================================================
// block_aliases triggers (3) — fire for both local AND sync writes; same
// shape as the row_events triggers. Together they hold the invariant:
//
//   block_aliases ⊇ { (id, workspace_id, alias, LOWER(alias))
//                     | blocks row deleted = 0
//                     ∧ alias ∈ properties_json $.alias }
//
// `INSERT OR IGNORE` covers re-entrant cases (duplicate alias values on
// the same block, backfill against already-populated rows). The
// `typeof(je.value) = 'text'` guard rejects malformed array elements
// (numbers, nulls, nested objects) defensively — the codec only writes
// strings, but stale data from earlier shapes shouldn't crash the
// trigger.
//
// `json_each(NEW.properties_json, '$.alias')` returns 0 rows when the
// `$.alias` path is missing — important because most blocks have no
// aliases, and this is the hot path on every UPDATE OF content (which
// fires the same trigger pattern via UPDATE OF properties_json … no
// it doesn't; UPDATE OF columns gates the trigger on those columns
// changing, so a content-only edit does NOT fire blocks_alias_update).
// ============================================================================

const aliasInsertSelectSql = (rowRef: 'NEW') => `
      INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
      SELECT ${rowRef}.id, ${rowRef}.workspace_id, je.value, LOWER(je.value)
      FROM json_each(${rowRef}.properties_json, '$.alias') AS je
      WHERE typeof(je.value) = 'text';
`.trim()

export const CREATE_BLOCKS_ALIAS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_alias_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${aliasInsertSelectSql('NEW')}
  END
`

/** Fires only when `properties_json`, `deleted`, or `workspace_id`
 *  changes — content edits, parent moves, and order_key changes don't
 *  touch the alias index. Always wipes the row's prior aliases first
 *  (cheap: PK lookup), then re-inserts unless the row is now soft-
 *  deleted. Restoring a tombstone re-populates via the same path. */
export const CREATE_BLOCKS_ALIAS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_alias_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
    SELECT NEW.id, NEW.workspace_id, je.value, LOWER(je.value)
    FROM json_each(NEW.properties_json, '$.alias') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`

/** Hard-delete cleanup. Soft-deletes go through the UPDATE trigger
 *  above (which sees `NEW.deleted = 1` and writes nothing back). */
export const CREATE_BLOCKS_ALIAS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_alias_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = OLD.id;
  END
`

/** Workspace-scoped alias uniqueness — enforced at the storage layer
 *  so the invariant holds regardless of which write path arrives at
 *  the table (local `tx.create` + `setProperty`, `tx.restore`,
 *  applyRaw from undo, future mutators). Fires BEFORE every INSERT
 *  into `block_aliases`; if any other live block already claims the
 *  same `(workspace_id, alias)`, RAISE(ABORT) rolls back the entire
 *  user tx atomically.
 *
 *  Blank aliases (`NEW.alias = ''`) are skipped to match the
 *  `tx.aliasLookup` semantics: lookup returns null for `''` because
 *  blanks aren't meaningful claims. Without the skip, two blocks
 *  each carrying an empty entry in their alias array (e.g. notes
 *  the user cleared) would spuriously collide on the second write.
 *
 *  The RAISE message is structured: `alias_collision` followed by
 *  US-separated (char(31)) HEX-encoded workspace_id, alias, and
 *  attempting block_id. Hex encoding guarantees the delimiter never
 *  appears inside a field, even if the alias text itself contains
 *  control chars — earlier comments asserted the codec rejected
 *  control chars, but `codecs.string` only checks typeof, so the
 *  encoding has to defend itself rather than relying on data-shape
 *  invariants. The tx engine hex-decodes each field and looks up
 *  the existing claimant to construct
 *  `ProcessorRejection('alias.collision', meta)`.
 *
 *  Skipped when `tx_context.source IS NULL` so PowerSync sync-apply
 *  doesn't fail on dupes propagating from other clients (mirrors the
 *  workspace-invariant trigger's policy). V1 leaves cross-client
 *  alias merges as latent; the user-facing merge flow is V2.
 *  Backfill (`BACKFILL_BLOCK_ALIASES_SQL`) also runs outside a
 *  `tx_context.source` setting, so the one-time index re-population
 *  on schema upgrade is tolerant of any latent dupes that predate
 *  this trigger.
 *
 *  Self-reclaim is handled naturally: `blocks_alias_update` DELETEs
 *  the row's prior aliases before re-inserting, so a row rewriting
 *  its own alias sees no other claimant at INSERT time. */
export const CREATE_BLOCK_ALIASES_WORKSPACE_UNIQUE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS block_aliases_workspace_alias_unique
  BEFORE INSERT ON block_aliases
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND NEW.alias != ''
  BEGIN
    SELECT RAISE(ABORT,
      '${ALIAS_COLLISION_RAISE_PREFIX}' || ${RAISE_FIELD_SEP_SQL} ||
      hex(NEW.workspace_id) || ${RAISE_FIELD_SEP_SQL} ||
      hex(NEW.alias) || ${RAISE_FIELD_SEP_SQL} ||
      hex(NEW.block_id)
    )
    WHERE EXISTS (
      SELECT 1 FROM block_aliases
      WHERE workspace_id = NEW.workspace_id
        AND alias = NEW.alias
        AND block_id != NEW.block_id
    );
  END
`

// ============================================================================
// block_types triggers (3) — same maintenance shape as block_aliases, but
// indexing every string in properties_json $.types.
// ============================================================================

const typeInsertSelectSql = (rowRef: 'NEW') => `
      INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
      SELECT ${rowRef}.id, ${rowRef}.workspace_id, je.value
      FROM json_each(${rowRef}.properties_json, '$.types') AS je
      WHERE typeof(je.value) = 'text';
`.trim()

export const CREATE_BLOCKS_TYPE_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_type_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${typeInsertSelectSql('NEW')}
  END
`

export const CREATE_BLOCKS_TYPE_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_type_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
    SELECT NEW.id, NEW.workspace_id, je.value
    FROM json_each(NEW.properties_json, '$.types') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`

export const CREATE_BLOCKS_TYPE_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_type_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = OLD.id;
  END
`

// ============================================================================
// blocks_fts triggers (3) — same derived-index maintenance shape as
// block_aliases/block_types, keyed through blocks_fts_rowids so updates
// can delete by FTS rowid instead of scanning an UNINDEXED UUID column.
// ============================================================================

const blocksFtsInsertSql = (rowRef: 'NEW') => `
      INSERT INTO blocks_fts_rowids (block_id)
      SELECT ${rowRef}.id
      WHERE NOT EXISTS (
        SELECT 1 FROM blocks_fts_rowids WHERE block_id = ${rowRef}.id
      );
      INSERT INTO blocks_fts (rowid, content, workspace_id, block_id)
      SELECT fts_rowid, ${rowRef}.content, ${rowRef}.workspace_id, ${rowRef}.id
      FROM blocks_fts_rowids
      WHERE block_id = ${rowRef}.id
        AND ${rowRef}.deleted = 0
        AND ${rowRef}.content != '';
`.trim()

export const CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_fts_insert
  AFTER INSERT ON blocks
  BEGIN
    ${blocksFtsInsertSql('NEW')}
  END
`

export const CREATE_BLOCKS_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_fts_update
  AFTER UPDATE OF content, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    ${blocksFtsInsertSql('NEW')}
  END
`

export const CREATE_BLOCKS_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_fts_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    DELETE FROM blocks_fts_rowids WHERE block_id = OLD.id;
  END
`

/** One-shot backfill from `blocks.properties_json`. Called after the
 *  CLIENT_SCHEMA_STATEMENTS run, gated on a `client_schema_state` row
 *  so existing installations populate the index once on the first
 *  startup with this schema, and steady-state startups are a single
 *  cheap PK lookup. New installations also no-op (no blocks ⇒
 *  nothing to backfill, marker still recorded so subsequent starts
 *  short-circuit).
 *
 *  Marker key vs derived state: an earlier shape probed `block_aliases`
 *  for any row, treating non-empty as proof the backfill ran. That
 *  conflated "backfill complete" with "this workspace has any aliases
 *  at all", so a workspace with zero alias-bearing blocks (or one that
 *  later had every alias removed) re-ran the full table scan on every
 *  launch. The dedicated marker captures the intent directly.
 *
 *  Why not part of CLIENT_SCHEMA_STATEMENTS: the SELECT scans the
 *  blocks table, which is multi-million rows on big workspaces.
 *  Running unconditionally on every app start would defeat the index
 *  the user just paid for. */
export const ALIAS_BACKFILL_MARKER_KEY = 'block_aliases_backfill_v1'

export const SELECT_BLOCK_ALIASES_BACKFILL_DONE_SQL = `
  SELECT 1 FROM client_schema_state WHERE key = '${ALIAS_BACKFILL_MARKER_KEY}'
`

export const RECORD_BLOCK_ALIASES_BACKFILL_DONE_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${ALIAS_BACKFILL_MARKER_KEY}', strftime('%s', 'now') * 1000)
`

export const BACKFILL_BLOCK_ALIASES_SQL = `
  INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
  SELECT b.id, b.workspace_id, je.value, LOWER(je.value)
  FROM blocks b, json_each(b.properties_json, '$.alias') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`

export const BLOCK_TYPES_BACKFILL_MARKER_KEY = 'block_types_backfill_v1'

export const SELECT_BLOCK_TYPES_BACKFILL_DONE_SQL = `
  SELECT 1 FROM client_schema_state WHERE key = '${BLOCK_TYPES_BACKFILL_MARKER_KEY}'
`

export const RECORD_BLOCK_TYPES_BACKFILL_DONE_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${BLOCK_TYPES_BACKFILL_MARKER_KEY}', strftime('%s', 'now') * 1000)
`

export const BACKFILL_BLOCK_TYPES_SQL = `
  INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
  SELECT b.id, b.workspace_id, je.value
  FROM blocks b, json_each(b.properties_json, '$.types') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`

export const BLOCKS_FTS_BACKFILL_MARKER_KEY = 'blocks_fts_backfill_v1'

export const SELECT_BLOCKS_FTS_BACKFILL_DONE_SQL = `
  SELECT 1 FROM client_schema_state WHERE key = '${BLOCKS_FTS_BACKFILL_MARKER_KEY}'
`

export const RECORD_BLOCKS_FTS_BACKFILL_DONE_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${BLOCKS_FTS_BACKFILL_MARKER_KEY}', strftime('%s', 'now') * 1000)
`

export const BACKFILL_BLOCKS_FTS_ROWIDS_SQL = `
  INSERT OR IGNORE INTO blocks_fts_rowids (block_id)
  SELECT id
  FROM blocks
  WHERE deleted = 0 AND content != ''
`

export const BACKFILL_BLOCKS_FTS_SQL = `
  INSERT INTO blocks_fts (rowid, content, workspace_id, block_id)
  SELECT r.fts_rowid, b.content, b.workspace_id, b.id
  FROM blocks b
  JOIN blocks_fts_rowids r ON r.block_id = b.id
  WHERE b.deleted = 0
    AND b.content != ''
    AND NOT EXISTS (
      SELECT 1 FROM blocks_fts WHERE rowid = r.fts_rowid
    )
`

/** Planner-stats freshness, decided by *drift* rather than a clock.
 *  wa-sqlite ships without an automatic `sqlite_stat1`, so the planner
 *  falls back to row-count heuristics that consistently mis-rank join
 *  orders on `blocks` once the workspace is large — a 4-id `json_each`
 *  lookup with `(workspace_id, deleted)` filtering scans the workspace
 *  partial index (300k+ rows) instead of driving from the small set into
 *  the PK. Running `ANALYZE` populates `sqlite_stat1` and flips that
 *  decision.
 *
 *  WHEN to re-run is the subtle part: `sqlite_stat1` already records the
 *  row count seen at the last ANALYZE, so we re-run whenever the live
 *  `blocks` count has diverged from that baseline by more than
 *  {@link ANALYZE_GROWTH_FACTOR}×. That one rule covers every case a timer
 *  can't: the empty-table-at-init race (no baseline → ANALYZE once data
 *  lands, never over the empty table), a large initial sync, a bulk
 *  import, and the legacy "0 0" stats bug (baseline ~0 over a huge table →
 *  force re-ANALYZE). A stable workspace stays within the factor and is
 *  left alone, so the multi-second scan doesn't repeat every boot. No
 *  marker row is needed — `sqlite_stat1` itself is the source of truth. */

/** Below this many `blocks` rows the planner's join-order choices don't
 *  cause the multi-second freezes (scanning a sub-thousand-row table is
 *  cheap either way), so ANALYZE buys nothing — and recording a tiny
 *  row-estimate mid-sync could itself mislead the planner into scanning a
 *  table that's actually still filling. Gates whether ANALYZE runs at
 *  all. */
export const ANALYZE_MIN_BLOCKS = 1000

/** Re-ANALYZE once the live `blocks` count diverges from the count baked
 *  into `sqlite_stat1` by this factor in either direction. 4× keeps the
 *  estimate within the same order of magnitude the planner cares about
 *  (join order turns on order-of-magnitude differences, not 4×), so a
 *  gradually-growing workspace re-analyzes rarely while an import or
 *  initial sync that multiplies the table triggers it promptly. */
export const ANALYZE_GROWTH_FACTOR = 4

/** Estimated `blocks` row count recorded at the last ANALYZE. `stat` is a
 *  space-separated string ("<rows> <avg-rows-per-key>…"); `CAST(... AS
 *  INTEGER)` parses its leading integer. MAX across the per-index rows is
 *  the table estimate (the partial workspace index reports live rows, the
 *  PK reports all rows; MAX takes the table total to match COUNT(*)).
 *  NULL when ANALYZE has never populated stats for `blocks`. */
export const SELECT_BLOCKS_STAT_ESTIMATE_SQL = `
  SELECT MAX(CAST(stat AS INTEGER)) AS rows FROM sqlite_stat1 WHERE tbl = 'blocks'
`

/** `sqlite_stat1` only exists once ANALYZE has run at least once; querying
 *  it before then throws "no such table". Probe `sqlite_master` first. */
export const SELECT_SQLITE_STAT1_EXISTS_SQL = `
  SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1' LIMIT 1
`

export const SELECT_BLOCKS_COUNT_SQL = `SELECT COUNT(*) AS count FROM blocks`

/** Per-name reprojection markers. Once `reprojectRefTypedProperties`
 *  has done a catch-up pass for property name `X`, a row keyed
 *  `reproject_ref:<X>` lands in `client_schema_state`. Subsequent
 *  cold-starts (kernel→merged delta, plugins→user-data delta) skip
 *  scanning blocks for `X` because the references processor has been
 *  maintaining `references_json` incrementally on every write since.
 *
 *  Marker is cleared (DELETE) when reprojection runs for a name whose
 *  current schema is no longer ref-typed (cleanup case): a future
 *  re-add-as-ref needs the catch-up scan again because writes during
 *  the non-ref window left properties_json values without
 *  references_json entries. */
export const REPROJECT_REF_MARKER_PREFIX = 'reproject_ref:'

export const SELECT_REPROJECT_REF_MARKERS_SQL = `
  SELECT key FROM client_schema_state WHERE key LIKE '${REPROJECT_REF_MARKER_PREFIX}%'
`

export const RECORD_REPROJECT_REF_MARKER_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`

export const CLEAR_REPROJECT_REF_MARKER_SQL = `
  DELETE FROM client_schema_state WHERE key = ?
`

/** Completion markers for workspace-scoped repo.tx data backfills
 *  (`workspaceBackfillsFacet`). Keyed `workspace_backfill:<workspaceId>:<id>`;
 *  a row lands once a backfill has run for a workspace, so subsequent opens
 *  skip it. Local (never synced) — like the reproject markers, each device
 *  records its own completion. */
export const WORKSPACE_BACKFILL_MARKER_PREFIX = 'workspace_backfill:'

export const SELECT_WORKSPACE_BACKFILL_MARKERS_SQL = `
  SELECT key FROM client_schema_state WHERE key LIKE '${WORKSPACE_BACKFILL_MARKER_PREFIX}%'
`

export const RECORD_WORKSPACE_BACKFILL_MARKER_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`

/** One-time post-upgrade marker: this client has re-scanned a workspace's
 *  staged `blocks_synced` rows under the relaxed reconcile gate, to heal
 *  deterministic-id shadows the old gate skip-staled (and whose change-queue
 *  entry it then consumed, so a normal queue-driven drain never re-evaluates
 *  them). Keyed `reconcile_rescan_v1:<workspaceId>` — once per workspace per
 *  client. */
export const RECONCILE_RESCAN_MARKER_PREFIX = 'reconcile_rescan_v1:'

export const SELECT_RECONCILE_RESCAN_MARKER_SQL = `
  SELECT key FROM client_schema_state WHERE key = ?
`

export const RECORD_RECONCILE_RESCAN_MARKER_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`

// ============================================================================
// Bulk-apply ordered list. Run after `blocks` exists (PowerSync's schema
// initialization creates it). Idempotent (`IF NOT EXISTS`).
// ============================================================================

// A trigger created with `CREATE TRIGGER IF NOT EXISTS` is FROZEN on upgrade:
// once a trigger of that name exists, SQLite keeps the old body and silently
// ignores the new definition. So a client whose local DB was bootstrapped
// before a trigger's body changed keeps running the stale one forever — which
// is exactly how the pre-D-3.1 `blocks_upload_update` kept stripping
// workspace_id from content-only PATCHes and stranding e2ee uploads behind the
// server's ciphertext CHECK (SQLSTATE 23514).
//
// Force every CREATE TRIGGER to re-apply from current source by prepending a
// `DROP TRIGGER IF EXISTS <name>` before it. This is self-maintaining: any
// future trigger body change auto-installs on next startup, with no per-change
// migration to remember. Only triggers are force-recreated — tables and indexes
// keep `IF NOT EXISTS` (dropping a table would destroy data). A dropped trigger
// is free to rebuild, and the bootstrap runs before the repo serves any write,
// so there is no window where a write misses its trigger.
const CREATE_TRIGGER_NAME_RE = /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i

const withTriggerRecreate = (statements: readonly string[]): string[] =>
  statements.flatMap(stmt => {
    const name = stmt.match(CREATE_TRIGGER_NAME_RE)?.[1]
    return name ? [`DROP TRIGGER IF EXISTS ${name}`, stmt] : [stmt]
  })

/** Run `fn` with `triggerName` temporarily dropped, then recreate it from
 *  `createSql` (its canonical definition) — even if `fn` throws. For a bulk
 *  maintenance write that must NOT fan out through an unconditional per-row
 *  side-effect trigger (e.g. a column backfill that would otherwise write one
 *  `row_events` row per block — hundreds of thousands of them). SQLite has no
 *  `DISABLE TRIGGER`, so drop+recreate is the equivalent; pass the same
 *  `CREATE` constant the bootstrap installs so the recreated trigger can't
 *  drift. This is the client analog of the server backfill's `DISABLE TRIGGER`
 *  bracketing, and the same drop-then-recreate move {@link withTriggerRecreate}
 *  already does to every trigger on boot. Bootstrap-only: there is no
 *  write-serving window in which the trigger is absent. */
const withTriggerSuspended = async (
  db: {execute: (sql: string) => Promise<unknown>},
  triggerName: string,
  createSql: string,
  fn: () => Promise<void>,
): Promise<void> => {
  await db.execute(`DROP TRIGGER IF EXISTS ${triggerName}`)
  try {
    await fn()
  } finally {
    await db.execute(createSql)
  }
}

export const CLIENT_SCHEMA_STATEMENTS: readonly string[] = withTriggerRecreate([
  // Tables
  CREATE_TX_CONTEXT_TABLE_SQL,
  SEED_TX_CONTEXT_ROW_SQL,
  CREATE_ROW_EVENTS_TABLE_SQL,
  CREATE_ROW_EVENTS_TX_INDEX_SQL,
  CREATE_ROW_EVENTS_BLOCK_INDEX_SQL,
  CREATE_ROW_EVENTS_CREATED_INDEX_SQL,
  CREATE_COMMAND_EVENTS_TABLE_SQL,
  CREATE_COMMAND_EVENTS_CREATED_INDEX_SQL,
  CREATE_COMMAND_EVENTS_WORKSPACE_INDEX_SQL,
  CREATE_BLOCK_ALIASES_TABLE_SQL,
  CREATE_BLOCK_ALIASES_WS_ALIAS_INDEX_SQL,
  CREATE_BLOCK_ALIASES_WS_ALIAS_LOWER_INDEX_SQL,
  CREATE_BLOCK_TYPES_TABLE_SQL,
  CREATE_BLOCK_TYPES_TYPE_WORKSPACE_INDEX_SQL,
  CREATE_BLOCKS_FTS_ROWIDS_TABLE_SQL,
  CREATE_BLOCKS_FTS_TABLE_SQL,
  CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL,
  CREATE_PS_CRUD_REJECTED_TABLE_SQL,
  CREATE_PS_CRUD_REJECTED_REJECTED_AT_INDEX_SQL,
  CREATE_PS_CRUD_REJECTED_TX_ID_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_CHANGES_TABLE_SQL,
  CREATE_BLOCKS_SYNCED_CHANGES_ID_OP_INDEX_SQL,
  DROP_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,
  // 3 row_events audit/history triggers
  CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,
  // 2 upload-routing triggers
  CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL,
  // 2 workspace-invariant triggers
  CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL,
  // 2 parent-not-deleted triggers
  CREATE_BLOCKS_PARENT_NOT_DELETED_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_PARENT_NOT_DELETED_UPDATE_TRIGGER_SQL,
  // 3 block_aliases-maintenance triggers + 1 uniqueness-enforcement trigger
  CREATE_BLOCKS_ALIAS_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_ALIAS_UPDATE_TRIGGER_SQL,
  CREATE_BLOCKS_ALIAS_DELETE_TRIGGER_SQL,
  CREATE_BLOCK_ALIASES_WORKSPACE_UNIQUE_TRIGGER_SQL,
  // 3 block_types-maintenance triggers
  CREATE_BLOCKS_TYPE_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_TYPE_UPDATE_TRIGGER_SQL,
  CREATE_BLOCKS_TYPE_DELETE_TRIGGER_SQL,
  // 3 blocks_fts-maintenance triggers
  CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_FTS_UPDATE_TRIGGER_SQL,
  CREATE_BLOCKS_FTS_DELETE_TRIGGER_SQL,
  // 2 blocks_synced change-capture triggers (Layout B observer detection)
  CREATE_BLOCKS_SYNCED_CHANGES_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_SYNCED_CHANGES_DELETE_TRIGGER_SQL,
])

export const CLIENT_SCHEMA_TRIGGER_NAMES = [
  'blocks_row_event_insert',
  'blocks_row_event_update',
  'blocks_row_event_delete',
  'blocks_upload_insert',
  'blocks_upload_update',
  'blocks_parent_workspace_check_insert',
  'blocks_parent_workspace_check_update',
  'blocks_parent_not_deleted_check_insert',
  'blocks_parent_not_deleted_check_update',
  'blocks_alias_insert',
  'blocks_alias_update',
  'blocks_alias_delete',
  'block_aliases_workspace_alias_unique',
  'blocks_type_insert',
  'blocks_type_update',
  'blocks_type_delete',
  'blocks_fts_insert',
  'blocks_fts_update',
  'blocks_fts_delete',
  'blocks_synced_changes_insert',
  'blocks_synced_changes_delete',
] as const

interface ClientSchemaBootstrapDb {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
  getOptional: <T>(sql: string) => Promise<T | null>
}

/** Run after CLIENT_SCHEMA_STATEMENTS to populate block_aliases from
 *  pre-existing blocks rows on the first app start that includes the
 *  alias-index schema. Subsequent starts are a single cheap LIMIT 1
 *  read because triggers maintain the table from then on.
 *
 *  Tests open a fresh database with no blocks → noop. Production
 *  picks up the existing PowerSync-synced blocks → one large INSERT
 *  on the first start, then noop on every start after. */
export const backfillBlockAliasesIfEmpty = async (
  db: ClientSchemaBootstrapDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BLOCK_ALIASES_BACKFILL_DONE_SQL)
  if (done !== null) return
  await db.execute(BACKFILL_BLOCK_ALIASES_SQL)
  // Record completion regardless of whether any rows were inserted —
  // an empty workspace is fully backfilled too, and we don't want to
  // re-scan blocks on every start in that case.
  await db.execute(RECORD_BLOCK_ALIASES_BACKFILL_DONE_SQL)
}

export const backfillBlockTypesIfEmpty = async (
  db: ClientSchemaBootstrapDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BLOCK_TYPES_BACKFILL_DONE_SQL)
  if (done !== null) return
  await db.execute(BACKFILL_BLOCK_TYPES_SQL)
  await db.execute(RECORD_BLOCK_TYPES_BACKFILL_DONE_SQL)
}

export const backfillBlocksFtsIfEmpty = async (
  db: ClientSchemaBootstrapDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BLOCKS_FTS_BACKFILL_DONE_SQL)
  if (done !== null) return
  await db.execute(BACKFILL_BLOCKS_FTS_ROWIDS_SQL)
  await db.execute(BACKFILL_BLOCKS_FTS_SQL)
  await db.execute(RECORD_BLOCKS_FTS_BACKFILL_DONE_SQL)
}

/**
 * Idempotent local-schema migration for the `user_updated_at` split.
 * `blocks` / `blocks_synced` are created with CREATE TABLE IF NOT EXISTS, so
 * adding the column to `BLOCK_STORAGE_COLUMNS` does NOT add it to an existing
 * device's tables — yet it immediately appears in every generated statement
 * (INSERT_SQL, the observer's upsert, the raw-table put), so an un-migrated
 * device would fail "no such column" on the first write/sync. PRAGMA
 * table_info + ALTER TABLE ADD COLUMN on BOTH tables, guarded so a fresh
 * install (column already present from CREATE) doesn't throw "duplicate column
 * name".
 *
 * When the column is newly added, backfill `blocks` once so the stored value
 * is fully populated (no lingering NULLs — `parseBlockRow` falls back to
 * `updated_at` on read, but we keep the column honest). The backfill is
 * bracketed by `withTriggerSuspended`: the only trigger that fires on a
 * `user_updated_at`-only UPDATE is `blocks_row_event_update` (AFTER UPDATE ON
 * blocks, no column scope), and a full-table backfill through it would write
 * one `row_events` row per block. The FTS/alias/type triggers are column-scoped
 * (content/properties_json/deleted/workspace_id) and the upload trigger is
 * source-gated, so neither fires here. `blocks_synced` gets the column (the
 * raw-table put binds it) but no backfill — it's a passive sync landing zone
 * overwritten by deliveries.
 */
export const ensureBlockUserUpdatedAtColumn = async (db: {
  execute: (sql: string) => Promise<unknown>
  getAll: <T>(sql: string) => Promise<T[]>
}): Promise<void> => {
  let backfillBlocks = false
  for (const table of ['blocks', 'blocks_synced'] as const) {
    const columns = await db.getAll<{name: string}>(`PRAGMA table_info(${table})`)
    if (!columns.some(c => c.name === 'user_updated_at')) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN user_updated_at INTEGER`)
      if (table === 'blocks') backfillBlocks = true
    }
  }
  // Backfill only right after the ALTER — every existing `blocks` row is NULL
  // then. On later boots the column already exists, so we skip the backfill
  // (and its full-table scan) entirely.
  if (backfillBlocks) {
    await withTriggerSuspended(
      db,
      'blocks_row_event_update',
      CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,
      async () => {
        await db.execute('UPDATE blocks SET user_updated_at = updated_at')
      },
    )
  }
}

/**
 * Idempotent local-schema migration for undo grouping (issue #306): add
 * `group_id` to `tx_context` and `row_events` on upgrading devices.
 * Both tables are created with CREATE TABLE IF NOT EXISTS, so adding the
 * column to the CREATE statements does NOT add it to an existing device's
 * tables — yet the commit pipeline's tx_context UPDATE and the recreated
 * row_events triggers reference it unconditionally, so an un-migrated
 * device would fail "no such column" on the first `repo.tx`.
 *
 * MUST run before ANY re-creation of the row_events trigger bodies from
 * the current constants — that is the `CLIENT_SCHEMA_STATEMENTS` loop AND
 * `withTriggerSuspended` inside {@link ensureBlockUserUpdatedAtColumn}
 * (its backfill bracket re-installs `blocks_row_event_update` from the
 * NEW body, which inserts into `row_events.group_id`). SQLite accepts a
 * CREATE TRIGGER referencing a missing column and fails only at fire
 * time, so a wrong ordering isn't caught at bootstrap — it surfaces as
 * "no such column: group_id" on a concurrent old-tab write.
 * A table that does not exist yet is skipped — the CREATE that follows
 * carries the column (and appends it LAST, so fresh and ALTER-upgraded
 * layouts match). No backfill: NULL group_id simply means "ungrouped",
 * which is the correct reading for all pre-existing history. No trigger
 * suspension: ALTER TABLE fires no row triggers.
 */
export const ensureUndoGroupIdColumns = async (db: {
  execute: (sql: string) => Promise<unknown>
  getAll: <T>(sql: string) => Promise<T[]>
}): Promise<void> => {
  for (const table of ['tx_context', 'row_events'] as const) {
    const columns = await db.getAll<{name: string}>(`PRAGMA table_info(${table})`)
    if (columns.length === 0) continue
    if (!columns.some(c => c.name === 'group_id')) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN group_id TEXT`)
    }
  }
}

/** Row count `sqlite_stat1` recorded for `blocks` at the last ANALYZE, or
 *  `null` if ANALYZE has never run for it. See {@link SELECT_BLOCKS_STAT_ESTIMATE_SQL}. */
export const getBlocksStatEstimate = async (
  db: ClientSchemaBootstrapDb,
): Promise<number | null> => {
  // sqlite_stat1 doesn't exist until the first ANALYZE — probe to avoid a
  // "no such table" throw on a fresh device.
  const hasStatTable = await db.getOptional<{present: number}>(SELECT_SQLITE_STAT1_EXISTS_SQL)
  if (hasStatTable === null) return null
  const row = await db.getOptional<{rows: number | null}>(SELECT_BLOCKS_STAT_ESTIMATE_SQL)
  return row?.rows ?? null
}

/** Live `blocks` row count — a covering index scan: cheap relative to
 *  ANALYZE, but not free on a large table, so callers run it at idle. */
export const getBlocksCount = async (
  db: ClientSchemaBootstrapDb,
): Promise<number> => {
  const row = await db.getOptional<{count: number}>(SELECT_BLOCKS_COUNT_SQL)
  return row?.count ?? 0
}

/** Pure drift predicate (no I/O) so the thresholds stay unit-testable
 *  without a database. Given the count baked into `sqlite_stat1`
 *  (`estimate`, `null` = never analyzed) and the live `count`, decide
 *  whether ANALYZE is worth running. See {@link ANALYZE_MIN_BLOCKS} /
 *  {@link ANALYZE_GROWTH_FACTOR} for the rationale behind each branch. */
export const analyzeIsWarranted = (
  estimate: number | null,
  count: number,
  minBlocks: number = ANALYZE_MIN_BLOCKS,
  growthFactor: number = ANALYZE_GROWTH_FACTOR,
): boolean => {
  // Too small for join order to matter — and a tiny recorded estimate
  // could mislead the planner mid-sync. Leave the table's stats alone.
  if (count < minBlocks) return false
  // Real data but no baseline yet (fresh sync / first import).
  if (estimate === null) return true
  // Grew far past the baseline (import / initial sync / the "0 0" bug,
  // where estimate≈0 makes any real count exceed estimate*factor).
  if (count >= estimate * growthFactor) return true
  // Shrank far below it (e.g. a large prune) — re-tighten the estimate.
  if (estimate >= count * growthFactor) return true
  return false
}

export interface AnalyzeResult {
  /** Whether `ANALYZE` was run this call. */
  analyzed: boolean
  /** Live `blocks` count observed (drives the decision + any toast). */
  count: number
  /** Recorded estimate before this call (`null` = never analyzed). */
  previousEstimate: number | null
}

/** Run `ANALYZE` only if the live `blocks` count has drifted from the
 *  `sqlite_stat1` baseline (see {@link analyzeIsWarranted}). Callers MUST
 *  schedule this off the first-paint critical path (idle / post-sync):
 *  the count is a full index scan and ANALYZE itself is a multi-second
 *  pass on a large DB, both on the single SQLite worker. */
export const runAnalyzeIfStale = async (
  db: ClientSchemaBootstrapDb,
  opts: {minBlocks?: number; growthFactor?: number} = {},
): Promise<AnalyzeResult> => {
  const minBlocks = opts.minBlocks ?? ANALYZE_MIN_BLOCKS
  const growthFactor = opts.growthFactor ?? ANALYZE_GROWTH_FACTOR
  const previousEstimate = await getBlocksStatEstimate(db)
  const count = await getBlocksCount(db)
  if (!analyzeIsWarranted(previousEstimate, count, minBlocks, growthFactor)) {
    return {analyzed: false, count, previousEstimate}
  }
  await db.execute('ANALYZE')
  return {analyzed: true, count, previousEstimate}
}

/** Unconditional `ANALYZE` for the manual command-palette command — runs
 *  regardless of drift (the user explicitly asked) and reports the table
 *  size so the caller can surface it. Still belongs off the render
 *  path. */
export const runAnalyzeNow = async (
  db: ClientSchemaBootstrapDb,
): Promise<{count: number}> => {
  const count = await getBlocksCount(db)
  await db.execute('ANALYZE')
  return {count}
}

