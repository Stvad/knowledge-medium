import type { PendingStatementParameter, RawTableType } from '@powersync/web'
import type { BlockData, BlockReference } from '@/data/api'

/** Storage shape — snake_case columns matching the Postgres schema and the
 *  local SQLite table. Domain shape (camelCase) lives on `BlockData` in
 *  `@/data/api`; `parseBlockRow` / `blockToRowParams` are the only places
 *  either shape leaks into the other. See data-layer-redesign §4.1.1. */
export interface BlockRow {
  id: string
  workspace_id: string
  parent_id: string | null
  // See BLOCK_LOCAL_COLUMNS below for both local-only columns.
  reference_target_id?: string | null
  is_field_form?: number | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  // See the `user_updated_at` entry in BLOCK_STORAGE_COLUMNS below.
  user_updated_at: number | null
  created_by: string
  updated_by: string
  // SQLite has no native boolean — stored as INTEGER 0/1 and the wa-sqlite
  // driver hands them back as JS numbers verbatim. Postgres column is
  // boolean; PowerSync hydrates the local row as 0/1.
  deleted: 0 | 1
}

type BlockColumnName = keyof BlockRow

type BlockStorageColumn = {
  readonly name: BlockColumnName
  readonly definition: string
}

/** Local SQLite column definitions. The PowerSync sync rule projects the
 *  same column names against Postgres (`scripts/gen-sync-config.ts` reads
 *  this array directly), so client and server stay structurally aligned —
 *  see feedback_powersync_sync_config_with_schema. */
export const BLOCK_STORAGE_COLUMNS = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'workspace_id', definition: 'workspace_id TEXT NOT NULL'},
  {name: 'parent_id', definition: 'parent_id TEXT'},
  {name: 'order_key', definition: 'order_key TEXT NOT NULL'},
  {name: 'content', definition: "content TEXT NOT NULL DEFAULT ''"},
  {name: 'properties_json', definition: "properties_json TEXT NOT NULL DEFAULT '{}'"},
  {name: 'references_json', definition: "references_json TEXT NOT NULL DEFAULT '[]'"},
  {name: 'created_at', definition: 'created_at INTEGER NOT NULL'},
  {name: 'updated_at', definition: 'updated_at INTEGER NOT NULL'},
  // Nullable (no NOT NULL): an old sync-rules window or pre-split row binds
  // NULL here rather than failing the raw-table put; `parseBlockRow` falls
  // back to `updated_at`. Mirrors the server column added in
  // 20260612000000_add_user_updated_at_monotonic_clamp.sql.
  {name: 'user_updated_at', definition: 'user_updated_at INTEGER'},
  {name: 'created_by', definition: 'created_by TEXT NOT NULL'},
  {name: 'updated_by', definition: 'updated_by TEXT NOT NULL'},
  {name: 'deleted', definition: 'deleted INTEGER NOT NULL DEFAULT 0'},
] as const satisfies readonly BlockStorageColumn[]

/** LOCAL-only columns on the live `blocks` table — never synced. Not part of
 *  `BLOCK_STORAGE_COLUMNS`, so they are excluded from everything that list
 *  derives: the PowerSync sync-rule projection (`scripts/gen-sync-config.ts`),
 *  the `blocks_synced` staging schema + raw-table put, the upload envelopes
 *  (`BLOCK_UPLOAD_COLUMNS` in clientSchema.ts), and the sync materializer's
 *  UPSERT (whose `ON CONFLICT DO UPDATE` therefore preserves them on
 *  arrival). Every device derives these columns independently from synced
 *  state. Existing installs get them via `ensureBlockLocalColumns` (the
 *  CREATE below only applies to fresh tables).
 *
 *  `reference_target_id` (properties-as-blocks migration, slice A): the
 *  resolved target when the row's whole content is exactly one reference
 *  span (`((id))` / `[[alias]]` / `[label](((uuid)))`, marked or not) — for
 *  property field rows this is the
 *  schema's fieldId. Kept local by owner decision (PR #288 §8/§11): a synced
 *  plaintext copy would leak reference-edge metadata that e2ee workspaces
 *  encrypt, and no server-side consumer exists.
 *
 *  `is_field_form` (§7 grammar box): 1 when the `::` field marker matched —
 *  pure syntax, stamped by the same derive pass regardless of whether the
 *  span resolves; NULL on every other row (never 0). */
export const BLOCK_LOCAL_COLUMNS = [
  {name: 'reference_target_id', definition: 'reference_target_id TEXT'},
  {name: 'is_field_form', definition: 'is_field_form INTEGER'},
] as const satisfies readonly {readonly name: keyof BlockRow; readonly definition: string}[]

const BLOCK_COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(column => column.name)

/** Column list for reads/writes against the live `blocks` table (synced
 *  storage columns + local-only columns). `blocks_synced` reads must keep
 *  using the storage-only list. */
export const BLOCKS_TABLE_COLUMN_NAMES: readonly (keyof BlockRow)[] = [
  ...BLOCK_COLUMN_NAMES,
  ...BLOCK_LOCAL_COLUMNS.map(column => column.name),
]

const formatSqlList = (items: readonly string[], indentSize: number) => {
  const indent = ' '.repeat(indentSize)
  return items.map(item => `${indent}${item}`).join(',\n')
}

export const SELECT_BLOCK_COLUMNS_SQL = BLOCKS_TABLE_COLUMN_NAMES.join(',\n  ')

export const buildQualifiedBlockColumnsSql = (tableName: string) =>
  BLOCKS_TABLE_COLUMN_NAMES
    .map(columnName => `${tableName}.${columnName} AS ${columnName}`)
    .join(',\n  ')

export const CREATE_BLOCKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks (
${formatSqlList(
    [...BLOCK_STORAGE_COLUMNS, ...BLOCK_LOCAL_COLUMNS].map(column => column.definition),
    6,
  )}
  )
`

/** Idempotent boot migration: add the local-only columns to a pre-existing
 *  `blocks` table (`CREATE TABLE IF NOT EXISTS` never alters an existing
 *  table). `blocks_synced` deliberately stays storage-only — it mirrors the
 *  server row shape. Runs before the client-schema trigger recreation so
 *  trigger bodies referencing the column never bind a missing column. */
export const ensureBlockLocalColumns = async (db: {
  execute(sql: string, params?: unknown[]): Promise<unknown>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}): Promise<void> => {
  const columns = await db.getAll<{name: string}>(`PRAGMA table_info(blocks)`)
  if (columns.length === 0) return
  for (const column of BLOCK_LOCAL_COLUMNS) {
    if (!columns.some(existing => existing.name === column.name)) {
      await db.execute(`ALTER TABLE blocks ADD COLUMN ${column.definition}`)
    }
  }
}

/**
 * LOCAL-only staging column: has the drain decided that `blocks` correctly
 * reflects this delivery?
 *
 * The durable record of "this device downloaded a row it has not applied",
 * written by the materializer in the SAME transaction as the decision itself.
 * Every other way of answering that question is a poll of concurrently-moving
 * state from somewhere the decision is not made, and each one is its own
 * time-of-check window.
 *
 * Self-maintaining, which is why it is a column here rather than a side table:
 * PowerSync's put is an `INSERT OR REPLACE` over the STORAGE columns only, so
 * every delivery — first or re-delivery — resets this to its default and a
 * newer version is unapplied until the drain says otherwise; a staging delete
 * takes it with the row. No path can leave it stale.
 *
 * `blocks_synced` carries INSERT and DELETE triggers but no UPDATE trigger, so
 * clearing it enqueues nothing and cannot feed the drain its own tail.
 *
 * Appended after the storage columns, and by the upgrade migration too, so a
 * fresh table and an ALTERed one have the same layout.
 */
export const STAGING_LOCAL_COLUMNS = [
  {name: 'needs_apply', definition: 'needs_apply INTEGER NOT NULL DEFAULT 1'},
] as const satisfies readonly {name: string; definition: string}[]

/** Layout B staging table (design doc §9.2). PowerSync's blocks stream is
 *  retargeted to row_type `blocks_synced`, so EVERY downloaded row —
 *  plaintext or `enc:v1:` ciphertext — lands here first; a JS observer then
 *  materializes it into the app-visible plaintext `blocks` table. It mirrors
 *  the `blocks` column shape (same `BLOCK_STORAGE_COLUMNS`) so a server row
 *  hydrates without dropping fields, but carries NONE of the `blocks`
 *  triggers — it's a passive landing zone, never read by app queries. */
export const CREATE_BLOCKS_SYNCED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks_synced (
${formatSqlList([...BLOCK_STORAGE_COLUMNS, ...STAGING_LOCAL_COLUMNS].map(column => column.definition), 6)}
  )
`

/** Serves the "is this device's view of the workspace behind" read, which every
 *  one-way pass takes and re-takes inside its own write transaction.
 *
 *  PARTIAL, and that is the whole point: the healthy answer is that the
 *  workspace has no unapplied rows, so the index holds nothing for it and the
 *  read is a miss on an empty range rather than a scan of every downloaded row.
 *  It carries the same shape as the change queue — one entry per arrival, gone
 *  once the drain resolves it — so a bulk sync grows it and then drains it. */
export const CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_synced_needs_apply
  ON blocks_synced (workspace_id)
  WHERE needs_apply = 1
`

/** Sibling iteration index. Matches the server-side
 *  `idx_blocks_parent_order` in `supabase/migrations/<...>_initial_schema_v2.sql`.
 *  `(order_key, id)` tiebreak handles fractional-indexing-jittered key
 *  collisions for deterministic post-sync ordering. */
export const CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_parent_order
  ON blocks (parent_id, order_key, id)
  WHERE deleted = 0
`

/** The tombstone complement of `idx_blocks_parent_order`, which is partial to
 *  `deleted = 0` — so `tx.deletedChildrenOf` had no index to reach and planned
 *  as `SCAN blocks` plus a temp B-tree sort, once per revived property, inside
 *  the write transaction.
 *
 *  Cheap despite sitting on the hot table: a partial index over `deleted = 1`
 *  holds only tombstones, and a row enters or leaves it only when `deleted`
 *  flips — edits to live rows never touch it. */
export const CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_parent_deleted
  ON blocks (parent_id, order_key, id)
  WHERE deleted = 1
`

export const CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_active
  ON blocks (workspace_id)
  WHERE deleted = 0
`

/** Serves the properties-cell backfill's candidate scan (every
 *  property-carrying block of a workspace, in id order). `idx_blocks_workspace_
 *  active` cannot: it carries no `id`, so the cursor sorts into a temp B-tree
 *  once per batch. A query only gets this index by carrying the literal
 *  `properties_json <> '{}'` term — SQLite cannot prove `json_type(...) =
 *  'object' AND EXISTS(json_each(...))` implies non-empty. */
export const CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_nonempty_properties
  ON blocks (workspace_id, id)
  WHERE deleted = 0 AND properties_json <> '{}'
`

/** Partial index over the local derived column: field-row recognition and
 *  "rows referencing target X" scans (rename retitle, projection walks) hit
 *  `(workspace_id, reference_target_id, parent_id)`; the `IS NOT NULL`
 *  predicate keeps it tiny — only exact-reference rows have the column set. */
export const CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_reference_target_parent
  ON blocks (workspace_id, reference_target_id, parent_id)
  WHERE deleted = 0 AND reference_target_id IS NOT NULL
`

/** Partial index over the field-form bit (§9): "all field rows under X" /
 *  "all field rows in workspace W" scans hit
 *  `(workspace_id, parent_id, reference_target_id)` filtered to marked rows
 *  only — the `= 1` predicate keeps it as small as the set of field rows. */
export const CREATE_BLOCKS_FIELD_FORM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_field_form
  ON blocks (workspace_id, parent_id, reference_target_id)
  WHERE deleted = 0 AND is_field_form = 1
`

/** Sibling of the index above WITHOUT the `deleted` predicate, for the one
 *  question that must include tombstones: "does this workspace hold any field
 *  row at all?".
 *
 *  Recognition never filters `deleted` — descent is a structural fact about
 *  `parent_id`, and sync-apply permits a live child under a tombstoned parent
 *  (see `kernelQueries.ts`), so a value row under a tombstoned field row is
 *  still machinery. A fast-path probe that asks the live index instead answers
 *  "no machinery here" for a workspace whose only field row is tombstoned, and
 *  the filter it guards is then skipped over rows it should have caught.
 *
 *  Still as small as the set of field rows; only the live-row predicate is
 *  dropped, not the `= 1`.
 *
 *  `parent_id` is the second column for the other tombstone-inclusive question:
 *  "which fieldIds does THIS block have a tombstoned field row for?", which the
 *  cell backfill asks per owner inside its writing transaction. Without it that
 *  lookup scans every field row in the workspace, once per owner — quadratic on
 *  the graphs the pass exists for. `workspace_id` alone stays a usable prefix,
 *  so the existence probe above is unaffected.
 *
 *  DROPped first because `CREATE INDEX IF NOT EXISTS` will not RESHAPE an index
 *  that already exists: every client that ran an earlier build has the
 *  single-column version, and would silently keep it. */
export const CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_any_field_form
  ON blocks (workspace_id, parent_id)
  WHERE is_field_form = 1
`

/** Paired with the statement above — see its DROP note.
 *
 *  Guarded by {@link dropStaleAnyFieldFormIndex} rather than run unconditionally:
 *  schema init runs on every app open, so a bare DROP + CREATE rebuilds the
 *  index every launch, and on the workspaces this migration targets that is a
 *  full index build in the startup path forever, to fix a shape once. */
const DROP_STALE_ANY_FIELD_FORM_INDEX_SQL = `
  DROP INDEX IF EXISTS idx_blocks_any_field_form
`

/** Reshape `idx_blocks_any_field_form` only when it is actually the old
 *  single-column form. `CREATE INDEX IF NOT EXISTS` will not reshape an index
 *  that already exists, so the DROP is required on upgrading devices — and only
 *  on those. Reads the stored DDL rather than `PRAGMA index_info`, which is a
 *  plain SELECT through any db handle. */
export const dropStaleAnyFieldFormIndex = async (db: {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}): Promise<void> => {
  const existing = await db.getOptional<{sql: string | null}>(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_blocks_any_field_form'`,
  )
  if (existing === null) return
  if (existing.sql?.includes('parent_id') === true) return
  await db.execute(DROP_STALE_ANY_FIELD_FORM_INDEX_SQL)
}

const powerSyncParamForColumn = (columnName: BlockColumnName): PendingStatementParameter =>
  columnName === 'id' ? 'Id' : {Column: columnName}

// Layout B staging raw table (design doc §9.2). PowerSync's sync-apply runs
// this plain `INSERT OR REPLACE` / `DELETE` directly against `blocks_synced`,
// which carries no triggers of its own beyond the change-capture queue. It
// overwrites the staged row (plaintext or `enc:v1:` ciphertext) on every
// re-delivery; the observer is what dedups no-ops, in JS, on its way into the
// live `blocks` table.
export const BLOCKS_SYNCED_RAW_TABLE = {
  put: {
    sql: `
      INSERT OR REPLACE INTO blocks_synced (
${formatSqlList(BLOCK_COLUMN_NAMES, 8)}
      ) VALUES (${BLOCK_COLUMN_NAMES.map(() => '?').join(', ')})
    `,
    params: BLOCK_COLUMN_NAMES.map(powerSyncParamForColumn),
  },
  delete: {
    sql: 'DELETE FROM blocks_synced WHERE id = ?',
    params: ['Id'],
  },
} satisfies RawTableType

type BlockSnapshotJsonField = {
  readonly key: keyof BlockData
  readonly sqlExpression: (rowRef: string) => string
}

const BLOCK_SNAPSHOT_JSON_FIELDS = [
  {key: 'id', sqlExpression: rowRef => `${rowRef}.id`},
  {key: 'workspaceId', sqlExpression: rowRef => `${rowRef}.workspace_id`},
  {key: 'parentId', sqlExpression: rowRef => `${rowRef}.parent_id`},
  {key: 'referenceTargetId', sqlExpression: rowRef => `${rowRef}.reference_target_id`},
  // Same undo/history treatment as `referenceTargetId`: the bit rides row
  // snapshots so replay restores it (same-tx processors are skipped on undo).
  {key: 'isFieldForm', sqlExpression: rowRef => `json(CASE WHEN ${rowRef}.is_field_form = 1 THEN 'true' ELSE 'false' END)`},
  {key: 'orderKey', sqlExpression: rowRef => `${rowRef}.order_key`},
  {key: 'content', sqlExpression: rowRef => `${rowRef}.content`},
  {key: 'properties', sqlExpression: rowRef => `json(${rowRef}.properties_json)`},
  {key: 'references', sqlExpression: rowRef => `json(${rowRef}.references_json)`},
  {key: 'createdAt', sqlExpression: rowRef => `${rowRef}.created_at`},
  {key: 'updatedAt', sqlExpression: rowRef => `${rowRef}.updated_at`},
  {key: 'userUpdatedAt', sqlExpression: rowRef => `coalesce(${rowRef}.user_updated_at, ${rowRef}.updated_at)`},
  {key: 'createdBy', sqlExpression: rowRef => `${rowRef}.created_by`},
  {key: 'updatedBy', sqlExpression: rowRef => `${rowRef}.updated_by`},
  {key: 'deleted', sqlExpression: rowRef => `json(CASE WHEN ${rowRef}.deleted THEN 'true' ELSE 'false' END)`},
] as const satisfies readonly BlockSnapshotJsonField[]

export const buildBlockSnapshotJsonSql = (rowRef: string) => `
  json_object(
${formatSqlList(BLOCK_SNAPSHOT_JSON_FIELDS.map(field => `'${field.key}', ${field.sqlExpression(rowRef)}`), 4)}
  )
`

const safeJsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn('Failed to parse stored block JSON', error)
    return fallback
  }
}

export const parseBlockSnapshotJson = (value: string | null | undefined) =>
  value ? safeJsonParse<BlockData | null>(value, null) ?? undefined : undefined

export const parseBlockRow = (row: BlockRow): BlockData => ({
  id: row.id,
  workspaceId: row.workspace_id,
  parentId: row.parent_id,
  referenceTargetId: row.reference_target_id ?? null,
  isFieldForm: row.is_field_form === 1,
  orderKey: row.order_key,
  content: row.content,
  properties: safeJsonParse<Record<string, unknown>>(row.properties_json, {}),
  references: safeJsonParse<BlockReference[]>(row.references_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  userUpdatedAt: row.user_updated_at ?? row.updated_at,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  deleted: Boolean(row.deleted),
})

type BlockRowParams = [
  id: string,
  workspaceId: string,
  parentId: string | null,
  orderKey: string,
  content: string,
  propertiesJson: string,
  referencesJson: string,
  createdAt: number,
  updatedAt: number,
  userUpdatedAt: number,
  createdBy: string,
  updatedBy: string,
  deleted: 0 | 1,
  referenceTargetId: string | null,
  isFieldForm: 1 | null,
]

/** Positional params for an INSERT into the live `blocks` table — ordered
 *  storage columns first, then local columns (matching
 *  `BLOCKS_TABLE_COLUMN_NAMES` / txEngine's `INSERT_SQL`). NOT for
 *  `blocks_synced` (staging binds storage columns only). */
export const blockToRowParams = (blockData: BlockData): BlockRowParams => [
  blockData.id,
  blockData.workspaceId,
  blockData.parentId,
  blockData.orderKey,
  blockData.content,
  JSON.stringify(blockData.properties ?? {}),
  JSON.stringify(blockData.references ?? []),
  blockData.createdAt,
  blockData.updatedAt,
  blockData.userUpdatedAt,
  blockData.createdBy,
  blockData.updatedBy,
  blockData.deleted ? 1 : 0,
  blockData.referenceTargetId ?? null,
  // 1-or-NULL storage convention: unmarked rows carry NULL, never 0, so SQL
  // value-set predicates (`is_field_form IS NOT 1`) match underived rows too.
  blockData.isFieldForm ? 1 : null,
]

/** Positional params for the `blocks_synced` staging put (and any other
 *  storage-columns-only bind): `blockToRowParams` minus the trailing
 *  local-only columns — staging mirrors the server row shape and never
 *  carries them. */
export const blockToSyncedRowParams = (blockData: BlockData): unknown[] =>
  blockToRowParams(blockData).slice(0, BLOCK_STORAGE_COLUMNS.length)
