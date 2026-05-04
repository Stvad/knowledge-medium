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
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
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
  {name: 'created_by', definition: 'created_by TEXT NOT NULL'},
  {name: 'updated_by', definition: 'updated_by TEXT NOT NULL'},
  {name: 'deleted', definition: 'deleted INTEGER NOT NULL DEFAULT 0'},
] as const satisfies readonly BlockStorageColumn[]

const BLOCK_COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(column => column.name)

const BLOCK_SYNC_COLUMN_NAMES = BLOCK_COLUMN_NAMES.filter(
  (name): name is Exclude<BlockColumnName, 'id'> => name !== 'id',
)

const formatSqlList = (items: readonly string[], indentSize: number) => {
  const indent = ' '.repeat(indentSize)
  return items.map(item => `${indent}${item}`).join(',\n')
}

const formatSqlOrList = (items: readonly string[], indentSize: number) => {
  const indent = ' '.repeat(indentSize)
  return items.map((item, index) => `${indent}${index === 0 ? '' : 'OR '}${item}`).join('\n')
}

const BLOCK_SYNC_ASSIGNMENTS = BLOCK_SYNC_COLUMN_NAMES.map(columnName => `${columnName} = excluded.${columnName}`)

const BLOCK_SYNC_DIFF_PREDICATES = BLOCK_SYNC_COLUMN_NAMES.map(
  columnName => `blocks.${columnName} IS NOT excluded.${columnName}`,
)

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

export const CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_with_references
  ON blocks (workspace_id)
  WHERE deleted = 0 AND references_json != '[]'
`

/** Expression index over `(workspace_id, $.type)`. Local-only — there's no
 *  matching server-side index, this exists to make the
 *  `SELECT_BLOCKS_BY_TYPE_SQL` path cheap on imports with O(100k) blocks
 *  where the JSON-extract scan would otherwise be a full-table walk.
 *  `findExtensionBlocks` runs at every workspace bootstrap and re-runs on
 *  every workspace-scoped invalidation; without this it dominated cold
 *  load (single ~2.7s call per re-run on the 91k-block import DB). */
export const CREATE_BLOCKS_WORKSPACE_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_type
  ON blocks (workspace_id, json_extract(properties_json, '$.type'))
  WHERE deleted = 0
`

export const UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (
${formatSqlList(BLOCK_COLUMN_NAMES, 4)}
  ) VALUES (${BLOCK_COLUMN_NAMES.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET
${formatSqlList(BLOCK_SYNC_ASSIGNMENTS, 4)}
  WHERE
${formatSqlOrList(BLOCK_SYNC_DIFF_PREDICATES, 4)}
`

const powerSyncParamForColumn = (columnName: BlockColumnName): PendingStatementParameter =>
  columnName === 'id' ? 'Id' : {Column: columnName}

// PowerSync's CRUD-apply path runs this `put` for both inserts and updates of
// a synced row. INSERT OR REPLACE would fire SQLite's DELETE+INSERT trigger
// pair on an update, so the `row_events` audit trigger sees the change as
// kind='insert' with before_json=NULL — and `rowEventsTail` then treats a
// pure content/property edit as a child-membership change and clears the
// parent's child-loaded marker. ON CONFLICT(id) DO UPDATE preserves the
// UPDATE shape (OLD/NEW visible to triggers), keeping before_json populated
// so the membership-vs-content classification in `rowEventsTail` is correct.
// The WHERE guard keeps re-delivered identical sync rows from firing UPDATE
// triggers at all; `row_events` is an invalidation queue, not a durable copy
// of every sync operation PowerSync has replayed.
export const BLOCKS_RAW_TABLE = {
  put: {
    sql: `
      INSERT INTO blocks (
${formatSqlList(BLOCK_COLUMN_NAMES, 8)}
      ) VALUES (${BLOCK_COLUMN_NAMES.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET
${formatSqlList(BLOCK_SYNC_ASSIGNMENTS, 8)}
      WHERE
${formatSqlOrList(BLOCK_SYNC_DIFF_PREDICATES, 8)}
    `,
    params: BLOCK_COLUMN_NAMES.map(powerSyncParamForColumn),
  },
  delete: {
    sql: 'DELETE FROM blocks WHERE id = ?',
    params: ['Id'],
  },
} satisfies RawTableType

export const buildBlockCrudJsonSql = (rowRef: string) => `
  json_object(
${formatSqlList(BLOCK_SYNC_COLUMN_NAMES.map(columnName => `'${columnName}', ${rowRef}.${columnName}`), 4)}
  )
`

type BlockSnapshotJsonField = {
  readonly key: keyof BlockData
  readonly sqlExpression: (rowRef: string) => string
}

const BLOCK_SNAPSHOT_JSON_FIELDS = [
  {key: 'id', sqlExpression: rowRef => `${rowRef}.id`},
  {key: 'workspaceId', sqlExpression: rowRef => `${rowRef}.workspace_id`},
  {key: 'parentId', sqlExpression: rowRef => `${rowRef}.parent_id`},
  {key: 'orderKey', sqlExpression: rowRef => `${rowRef}.order_key`},
  {key: 'content', sqlExpression: rowRef => `${rowRef}.content`},
  {key: 'properties', sqlExpression: rowRef => `json(${rowRef}.properties_json)`},
  {key: 'references', sqlExpression: rowRef => `json(${rowRef}.references_json)`},
  {key: 'createdAt', sqlExpression: rowRef => `${rowRef}.created_at`},
  {key: 'updatedAt', sqlExpression: rowRef => `${rowRef}.updated_at`},
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
  orderKey: row.order_key,
  content: row.content,
  properties: safeJsonParse<Record<string, unknown>>(row.properties_json, {}),
  references: safeJsonParse<BlockReference[]>(row.references_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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
  createdBy: string,
  updatedBy: string,
  deleted: 0 | 1,
]

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
  blockData.createdBy,
  blockData.updatedBy,
  blockData.deleted ? 1 : 0,
]
