//#region src/data/blockSchema.ts
/** Local SQLite column definitions. The PowerSync sync rule projects the
*  same column names against Postgres (`scripts/gen-sync-config.ts` reads
*  this array directly), so client and server stay structurally aligned —
*  see feedback_powersync_sync_config_with_schema. */
var BLOCK_STORAGE_COLUMNS = [
	{
		name: "id",
		definition: "id TEXT PRIMARY KEY NOT NULL"
	},
	{
		name: "workspace_id",
		definition: "workspace_id TEXT NOT NULL"
	},
	{
		name: "parent_id",
		definition: "parent_id TEXT"
	},
	{
		name: "order_key",
		definition: "order_key TEXT NOT NULL"
	},
	{
		name: "content",
		definition: "content TEXT NOT NULL DEFAULT ''"
	},
	{
		name: "properties_json",
		definition: "properties_json TEXT NOT NULL DEFAULT '{}'"
	},
	{
		name: "references_json",
		definition: "references_json TEXT NOT NULL DEFAULT '[]'"
	},
	{
		name: "created_at",
		definition: "created_at INTEGER NOT NULL"
	},
	{
		name: "updated_at",
		definition: "updated_at INTEGER NOT NULL"
	},
	{
		name: "user_updated_at",
		definition: "user_updated_at INTEGER"
	},
	{
		name: "created_by",
		definition: "created_by TEXT NOT NULL"
	},
	{
		name: "updated_by",
		definition: "updated_by TEXT NOT NULL"
	},
	{
		name: "deleted",
		definition: "deleted INTEGER NOT NULL DEFAULT 0"
	}
];
var BLOCK_COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map((column) => column.name);
var formatSqlList = (items, indentSize) => {
	const indent = " ".repeat(indentSize);
	return items.map((item) => `${indent}${item}`).join(",\n");
};
var SELECT_BLOCK_COLUMNS_SQL = BLOCK_COLUMN_NAMES.join(",\n  ");
var buildQualifiedBlockColumnsSql = (tableName) => BLOCK_COLUMN_NAMES.map((columnName) => `${tableName}.${columnName} AS ${columnName}`).join(",\n  ");
var CREATE_BLOCKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks (
${formatSqlList(BLOCK_STORAGE_COLUMNS.map((column) => column.definition), 6)}
  )
`;
/** Layout B staging table (design doc §9.2). PowerSync's blocks stream is
*  retargeted to row_type `blocks_synced`, so EVERY downloaded row —
*  plaintext or `enc:v1:` ciphertext — lands here first; a JS observer then
*  materializes it into the app-visible plaintext `blocks` table. It mirrors
*  the `blocks` column shape (same `BLOCK_STORAGE_COLUMNS`) so a server row
*  hydrates without dropping fields, but carries NONE of the `blocks`
*  triggers — it's a passive landing zone, never read by app queries. */
var CREATE_BLOCKS_SYNCED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blocks_synced (
${formatSqlList(BLOCK_STORAGE_COLUMNS.map((column) => column.definition), 6)}
  )
`;
/** Sibling iteration index. Matches the server-side
*  `idx_blocks_parent_order` in `supabase/migrations/<...>_initial_schema_v2.sql`.
*  `(order_key, id)` tiebreak handles fractional-indexing-jittered key
*  collisions for deterministic post-sync ordering. */
var CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_parent_order
  ON blocks (parent_id, order_key, id)
  WHERE deleted = 0
`;
var CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_active
  ON blocks (workspace_id)
  WHERE deleted = 0
`;
var powerSyncParamForColumn = (columnName) => columnName === "id" ? "Id" : { Column: columnName };
var BLOCKS_SYNCED_RAW_TABLE = {
	put: {
		sql: `
      INSERT OR REPLACE INTO blocks_synced (
${formatSqlList(BLOCK_COLUMN_NAMES, 8)}
      ) VALUES (${BLOCK_COLUMN_NAMES.map(() => "?").join(", ")})
    `,
		params: BLOCK_COLUMN_NAMES.map(powerSyncParamForColumn)
	},
	delete: {
		sql: "DELETE FROM blocks_synced WHERE id = ?",
		params: ["Id"]
	}
};
var BLOCK_SNAPSHOT_JSON_FIELDS = [
	{
		key: "id",
		sqlExpression: (rowRef) => `${rowRef}.id`
	},
	{
		key: "workspaceId",
		sqlExpression: (rowRef) => `${rowRef}.workspace_id`
	},
	{
		key: "parentId",
		sqlExpression: (rowRef) => `${rowRef}.parent_id`
	},
	{
		key: "orderKey",
		sqlExpression: (rowRef) => `${rowRef}.order_key`
	},
	{
		key: "content",
		sqlExpression: (rowRef) => `${rowRef}.content`
	},
	{
		key: "properties",
		sqlExpression: (rowRef) => `json(${rowRef}.properties_json)`
	},
	{
		key: "references",
		sqlExpression: (rowRef) => `json(${rowRef}.references_json)`
	},
	{
		key: "createdAt",
		sqlExpression: (rowRef) => `${rowRef}.created_at`
	},
	{
		key: "updatedAt",
		sqlExpression: (rowRef) => `${rowRef}.updated_at`
	},
	{
		key: "userUpdatedAt",
		sqlExpression: (rowRef) => `coalesce(${rowRef}.user_updated_at, ${rowRef}.updated_at)`
	},
	{
		key: "createdBy",
		sqlExpression: (rowRef) => `${rowRef}.created_by`
	},
	{
		key: "updatedBy",
		sqlExpression: (rowRef) => `${rowRef}.updated_by`
	},
	{
		key: "deleted",
		sqlExpression: (rowRef) => `json(CASE WHEN ${rowRef}.deleted THEN 'true' ELSE 'false' END)`
	}
];
var buildBlockSnapshotJsonSql = (rowRef) => `
  json_object(
${formatSqlList(BLOCK_SNAPSHOT_JSON_FIELDS.map((field) => `'${field.key}', ${field.sqlExpression(rowRef)}`), 4)}
  )
`;
var safeJsonParse = (value, fallback) => {
	if (!value) return fallback;
	try {
		return JSON.parse(value);
	} catch (error) {
		console.warn("Failed to parse stored block JSON", error);
		return fallback;
	}
};
var parseBlockSnapshotJson = (value) => value ? safeJsonParse(value, null) ?? void 0 : void 0;
var parseBlockRow = (row) => ({
	id: row.id,
	workspaceId: row.workspace_id,
	parentId: row.parent_id,
	orderKey: row.order_key,
	content: row.content,
	properties: safeJsonParse(row.properties_json, {}),
	references: safeJsonParse(row.references_json, []),
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	userUpdatedAt: row.user_updated_at ?? row.updated_at,
	createdBy: row.created_by,
	updatedBy: row.updated_by,
	deleted: Boolean(row.deleted)
});
var blockToRowParams = (blockData) => [
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
	blockData.deleted ? 1 : 0
];
//#endregion
export { BLOCKS_SYNCED_RAW_TABLE, BLOCK_STORAGE_COLUMNS, CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL, CREATE_BLOCKS_SYNCED_TABLE_SQL, CREATE_BLOCKS_TABLE_SQL, CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL, SELECT_BLOCK_COLUMNS_SQL, blockToRowParams, buildBlockSnapshotJsonSql, buildQualifiedBlockColumnsSql, parseBlockRow, parseBlockSnapshotJson };

//# sourceMappingURL=blockSchema.js.map