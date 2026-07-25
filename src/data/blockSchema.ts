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
  /** LOCAL-only derived column (properties-as-blocks migration, slice A):
   *  set when the row's whole content is exactly one reference token.
   *  Exists on `blocks` only — never on `blocks_synced`, never uploaded,
   *  never in a sync payload; every device derives it independently from
   *  content (see `BLOCK_LOCAL_COLUMNS`). Optional because rows read from
   *  `blocks_synced` (and pre-migration row_events snapshots) don't carry
   *  it; `parseBlockRow` normalizes absence to `null`. */
  reference_target_id?: string | null
  /** LOCAL-only derived bit (§7 grammar box): 1 when the row's whole trimmed
   *  content is the `::`-marked field form, NULL otherwise — ordinary rows
   *  are never stamped 0, so value-set predicates read
   *  `is_field_form IS NOT 1`, never `= 0`. Same local-column treatment as
   *  `reference_target_id`; `parseBlockRow` normalizes to boolean. */
  is_field_form?: number | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  // Nullable: old-client downloads / old sync-rules windows and pre-split
  // rows arrive without it; `parseBlockRow` falls back to `updated_at`.
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

/** Full `blocks`-table column list (includes local-only columns). Every
 *  current consumer reads the live `blocks` table; a `blocks_synced` read
 *  must NOT use this (staging carries storage columns only). */
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

/** Layout B staging table (design doc §9.2). PowerSync's blocks stream is
 *  retargeted to row_type `blocks_synced`, so EVERY downloaded row —
 *  plaintext or `enc:v1:` ciphertext — lands here first; a JS observer then
 *  materializes it into the app-visible plaintext `blocks` table. It mirrors
 *  the `blocks` column shape (same `BLOCK_STORAGE_COLUMNS`) so a server row
 *  hydrates without dropping fields, but carries NONE of the `blocks`
 *  triggers — it's a passive landing zone, never read by app queries. */
export const CREATE_BLOCKS_SYNCED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks_synced (
${formatSqlList(BLOCK_STORAGE_COLUMNS.map(column => column.definition), 6)}
  )
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

export const CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_active
  ON blocks (workspace_id)
  WHERE deleted = 0
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
  // Local-only column: absent on `blocks_synced` rows and pre-migration
  // row_events snapshots — normalize to null (optional-in, null-out).
  referenceTargetId: row.reference_target_id ?? null,
  // Local-only bit: 1 or NULL on disk (never 0) — normalize to boolean.
  isFieldForm: row.is_field_form === 1,
  orderKey: row.order_key,
  content: row.content,
  properties: safeJsonParse<Record<string, unknown>>(row.properties_json, {}),
  references: safeJsonParse<BlockReference[]>(row.references_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // Fallback absorbs old-rules downloads and pre-migration row_events
  // snapshots that carry no user_updated_at.
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
