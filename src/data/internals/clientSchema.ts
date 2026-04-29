/** Client-side SQLite schema additions on top of the PowerSync-managed
 *  `blocks` table. None of these tables are synced — they're the local
 *  mechanism for tx context, per-row audit, per-tx audit, and upload
 *  routing. The seven triggers (5 audit/upload + 2 workspace-invariant)
 *  live here too — server-side Postgres has no `powersync_crud` and no
 *  need for any of them. See data-layer-redesign §4.2 / §4.3 / §4.4 / §4.5
 *  / §4.1.1.
 *
 *  Run from `repoInstance.ts` after PowerSync's own schema initialization:
 *
 *      for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
 *        await db.execute(stmt)
 *      }
 */

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
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    tx_id   TEXT,
    tx_seq  INTEGER,
    user_id TEXT,
    scope   TEXT,
    source  TEXT
  )
`

/** Idempotent seed of the single row. Re-runs are no-ops. */
export const SEED_TX_CONTEXT_ROW_SQL = `
  INSERT OR IGNORE INTO tx_context (id) VALUES (1)
`

/** Per-row audit + invalidation log. Trigger-written. tx_id = NULL for
 *  sync-applied writes (see the COALESCE / CASE in the row_events
 *  triggers below). */
export const CREATE_ROW_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS row_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id       TEXT,
    block_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
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

// ============================================================================
// Helpers used inside trigger bodies. Centralised so the SQL fragments
// match in every trigger.
// ============================================================================

/** Snapshot a `blocks` row as JSON in domain shape (camelCase) for
 *  `row_events.{before,after}_json`. NEW / OLD references resolve at
 *  trigger time. */
const blockJsonObjectSql = (rowRef: 'NEW' | 'OLD') => `
      json_object(
        'id', ${rowRef}.id,
        'workspaceId', ${rowRef}.workspace_id,
        'parentId', ${rowRef}.parent_id,
        'orderKey', ${rowRef}.order_key,
        'content', ${rowRef}.content,
        'properties', json(${rowRef}.properties_json),
        'references', json(${rowRef}.references_json),
        'createdAt', ${rowRef}.created_at,
        'updatedAt', ${rowRef}.updated_at,
        'createdBy', ${rowRef}.created_by,
        'updatedBy', ${rowRef}.updated_by,
        'deleted', json(CASE WHEN ${rowRef}.deleted THEN 'true' ELSE 'false' END)
      )
`.trim()

/** Belt-and-suspenders: tx_id is the active local tx_id only when source
 *  IS NOT NULL. Sync-applied writes leave source = NULL (no `repo.tx` is
 *  open during PowerSync's CRUD apply); without this guard a stale tx_id
 *  left in `tx_context` from the previous local tx would leak into the
 *  sync-applied row_events row. The TxEngine clears all four fields at
 *  end-of-tx; the trigger logic is the load-bearing correctness check. */
const triggerTxIdSql = `
      CASE
        WHEN (SELECT source FROM tx_context WHERE id = 1) IS NULL
          THEN NULL
        ELSE (SELECT tx_id FROM tx_context WHERE id = 1)
      END
`.trim()

const triggerSourceSql = `COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`

// ============================================================================
// row_events triggers (3) — fire for both local AND sync writes; the
// COALESCE-to-'sync' tag distinguishes them.
//
// Soft-delete semantics (§4.3): tx.delete sets deleted = 1 (UPDATE), so it
// fires the UPDATE trigger. The body inspects whether `deleted` transitioned
// from 0 to 1 and writes kind = 'soft-delete' instead of 'update'.
// ============================================================================

export const CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_insert
  AFTER INSERT ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at
    ) VALUES (
      ${triggerTxIdSql},
      NEW.id,
      'create',
      NULL,
      ${blockJsonObjectSql('NEW')},
      ${triggerSourceSql},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    );
  END
`

export const CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_update
  AFTER UPDATE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at
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
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    );
  END
`

/** DELETE row_event writer is reserved for hard purges. v1 ships no purge
 *  mechanism; the trigger exists for future use (e.g. a job that purges
 *  soft-deleted rows older than N days). Hard deletes do not sync —
 *  PowerSync sees the row vanish locally; soft-delete via the synced
 *  `deleted` column is what propagates "this row is gone" through sync. */
export const CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_delete
  AFTER DELETE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at
    ) VALUES (
      ${triggerTxIdSql},
      OLD.id,
      'delete',
      ${blockJsonObjectSql('OLD')},
      NULL,
      ${triggerSourceSql},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    );
  END
`

// ============================================================================
// Upload-routing triggers (2) — fire only for LOCAL USER writes
// (source = 'user'). Sync-applied writes (source = NULL → 'sync') and
// UI-state writes (source = 'local-ephemeral') do NOT upload.
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

const blockUploadJsonSql = (rowRef: 'NEW' | 'OLD') => `
      json_object(
        'workspace_id', ${rowRef}.workspace_id,
        'parent_id', ${rowRef}.parent_id,
        'order_key', ${rowRef}.order_key,
        'content', ${rowRef}.content,
        'properties_json', ${rowRef}.properties_json,
        'references_json', ${rowRef}.references_json,
        'created_at', ${rowRef}.created_at,
        'updated_at', ${rowRef}.updated_at,
        'created_by', ${rowRef}.created_by,
        'updated_by', ${rowRef}.updated_by,
        'deleted', json(CASE WHEN ${rowRef}.deleted THEN 'true' ELSE 'false' END)
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
  WHEN (SELECT source FROM tx_context WHERE id = 1) = 'user'
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
  WHEN (SELECT source FROM tx_context WHERE id = 1) = 'user'
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${triggerTxSeqSql},
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${blockUploadJsonSql('NEW')}
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
// on `deleted = 0` — accepting soft-deleted parents matches the server FK and
// the v4.24 alignment (§4.1.1). The "don't create new children under a
// soft-deleted parent" rule lives at the kernel mutator layer.
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
// Bulk-apply ordered list. Run after `blocks` exists (PowerSync's schema
// initialization creates it). Idempotent (`IF NOT EXISTS`).
// ============================================================================

export const CLIENT_SCHEMA_STATEMENTS: readonly string[] = [
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
  // 5 audit/upload triggers
  CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL,
  // 2 workspace-invariant triggers
  CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL,
] as const

export const CLIENT_SCHEMA_TRIGGER_NAMES = [
  'blocks_row_event_insert',
  'blocks_row_event_update',
  'blocks_row_event_delete',
  'blocks_upload_insert',
  'blocks_upload_update',
  'blocks_parent_workspace_check_insert',
  'blocks_parent_workspace_check_update',
] as const
