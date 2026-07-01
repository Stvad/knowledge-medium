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
  reference_target_id: string | null
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
  {name: 'reference_target_id', definition: 'reference_target_id TEXT'},
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

const BLOCK_COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(column => column.name)

const formatSqlList = (items: readonly string[], indentSize: number) => {
  const indent = ' '.repeat(indentSize)
  return items.map(item => `${indent}${item}`).join(',\n')
}

export const SELECT_BLOCK_COLUMNS_SQL = BLOCK_COLUMN_NAMES.join(',\n  ')

export const buildQualifiedBlockColumnsSql = (tableName: string) =>
  BLOCK_COLUMN_NAMES
    .map(columnName => `${tableName}.${columnName} AS ${columnName}`)
    .join(',\n  ')

export const CREATE_BLOCKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks (
${formatSqlList(BLOCK_STORAGE_COLUMNS.map(column => column.definition), 6)}
  )
`

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

export const CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_reference_target_parent
  ON blocks (workspace_id, reference_target_id, parent_id)
  WHERE deleted = 0 AND reference_target_id IS NOT NULL
`

export const CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_active
  ON blocks (workspace_id)
  WHERE deleted = 0
`

export const CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_nonempty_properties
  ON blocks (workspace_id, id)
  WHERE deleted = 0 AND properties_json <> '{}'
`

export const CREATE_BLOCKS_WORKSPACE_RECENT_CONTENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_recent_content
  ON blocks (workspace_id, updated_at DESC, id ASC)
  WHERE deleted = 0 AND content != ''
`

export interface BlockSchemaDb {
  execute(sql: string): Promise<unknown>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
}

export const ensureBlockStorageColumns = async (db: BlockSchemaDb): Promise<void> => {
  // Add `reference_target_id` to pre-existing tables on upgrading devices:
  // `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so it never
  // adds the column. BOTH `blocks` and the Layout-B staging `blocks_synced`
  // need it — the raw-table `INSERT OR REPLACE INTO blocks_synced (…)` and sync
  // materialization both bind/select `reference_target_id`, so an un-migrated
  // `blocks_synced` throws `no such column` the moment sync stages a row.
  // Guarded on table existence so this is safe regardless of call order vs the
  // `CREATE TABLE` statements (a not-yet-created table is created WITH the
  // column from `BLOCK_STORAGE_COLUMNS`).
  for (const table of ['blocks', 'blocks_synced'] as const) {
    const tableExists = await db.getOptional<{name: string}>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
    )
    if (!tableExists) continue
    const column = await db.getOptional<{name: string}>(
      `SELECT name FROM pragma_table_info('${table}') WHERE name = 'reference_target_id'`,
    )
    if (!column) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN reference_target_id TEXT`)
    }
  }
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
  referenceTargetId: string | null,
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
]

export const blockToRowParams = (blockData: BlockData): BlockRowParams => [
  blockData.id,
  blockData.workspaceId,
  blockData.parentId,
  blockData.referenceTargetId ?? null,
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
]
