import type { PendingStatementParameter, RawTableType } from '@powersync/web'
import type { BlockData, BlockProperties, BlockReference } from '@/types'

export interface BlockRow {
  id: string
  workspace_id: string
  content: string
  properties_json: string
  child_ids_json: string
  parent_id: string | null
  create_time: number
  update_time: number
  created_by_user_id: string
  updated_by_user_id: string
  references_json: string
  // SQLite has no native boolean — booleans are stored as INTEGER 0/1 and the
  // wa-sqlite driver hands them back as JS numbers verbatim. Narrow to 0 | 1
  // so consumers know they're working with the raw integer encoding.
  deleted: 0 | 1
}

type BlockColumnName = keyof BlockRow

type BlockStorageColumn = {
  readonly name: BlockColumnName
  readonly definition: string
}

export const BLOCK_STORAGE_COLUMNS = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'workspace_id', definition: 'workspace_id TEXT NOT NULL'},
  {name: 'content', definition: "content TEXT NOT NULL DEFAULT ''"},
  {name: 'properties_json', definition: "properties_json TEXT NOT NULL DEFAULT '{}'"},
  {name: 'child_ids_json', definition: "child_ids_json TEXT NOT NULL DEFAULT '[]'"},
  {name: 'parent_id', definition: 'parent_id TEXT'},
  {name: 'create_time', definition: 'create_time INTEGER NOT NULL'},
  {name: 'update_time', definition: 'update_time INTEGER NOT NULL'},
  {name: 'created_by_user_id', definition: 'created_by_user_id TEXT NOT NULL'},
  {name: 'updated_by_user_id', definition: 'updated_by_user_id TEXT NOT NULL'},
  {name: 'references_json', definition: "references_json TEXT NOT NULL DEFAULT '[]'"},
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

export const CREATE_BLOCKS_PARENT_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_parent_id
  ON blocks (parent_id)
`

export const UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (
${formatSqlList(BLOCK_COLUMN_NAMES, 4)}
  ) VALUES (${BLOCK_COLUMN_NAMES.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET
${formatSqlList(BLOCK_SYNC_COLUMN_NAMES.map(columnName => `${columnName} = excluded.${columnName}`), 4)}
`

const powerSyncParamForColumn = (columnName: BlockColumnName): PendingStatementParameter =>
  columnName === 'id' ? 'Id' : {Column: columnName}

export const BLOCKS_RAW_TABLE = {
  put: {
    sql: `
      INSERT OR REPLACE INTO blocks (
${formatSqlList(BLOCK_COLUMN_NAMES, 8)}
      ) VALUES (${BLOCK_COLUMN_NAMES.map(() => '?').join(', ')})
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
  {key: 'content', sqlExpression: rowRef => `${rowRef}.content`},
  {key: 'properties', sqlExpression: rowRef => `json(${rowRef}.properties_json)`},
  {key: 'childIds', sqlExpression: rowRef => `json(${rowRef}.child_ids_json)`},
  {key: 'parentId', sqlExpression: rowRef => `${rowRef}.parent_id`},
  {key: 'createTime', sqlExpression: rowRef => `${rowRef}.create_time`},
  {key: 'updateTime', sqlExpression: rowRef => `${rowRef}.update_time`},
  {key: 'createdByUserId', sqlExpression: rowRef => `${rowRef}.created_by_user_id`},
  {key: 'updatedByUserId', sqlExpression: rowRef => `${rowRef}.updated_by_user_id`},
  {key: 'references', sqlExpression: rowRef => `json(${rowRef}.references_json)`},
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
  content: row.content,
  properties: safeJsonParse<BlockProperties>(row.properties_json, {}),
  childIds: safeJsonParse<string[]>(row.child_ids_json, []),
  parentId: row.parent_id ?? undefined,
  createTime: row.create_time,
  updateTime: row.update_time,
  createdByUserId: row.created_by_user_id,
  updatedByUserId: row.updated_by_user_id,
  references: safeJsonParse<BlockReference[]>(row.references_json, []),
  deleted: Boolean(row.deleted),
})

type BlockRowParams = [
  id: string,
  workspaceId: string,
  content: string,
  propertiesJson: string,
  childIdsJson: string,
  parentId: string | null,
  createTime: number,
  updateTime: number,
  createdByUserId: string,
  updatedByUserId: string,
  referencesJson: string,
  deleted: 0 | 1,
]

export const blockToRowParams = (blockData: BlockData): BlockRowParams => [
  blockData.id,
  blockData.workspaceId,
  blockData.content,
  JSON.stringify(blockData.properties ?? {}),
  JSON.stringify(blockData.childIds ?? []),
  blockData.parentId ?? null,
  blockData.createTime,
  blockData.updateTime,
  blockData.createdByUserId,
  blockData.updatedByUserId,
  JSON.stringify(blockData.references ?? []),
  blockData.deleted ? 1 : 0,
]
