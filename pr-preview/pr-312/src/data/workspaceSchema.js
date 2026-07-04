//#region src/data/workspaceSchema.ts
var buildPutSql = (tableName, columns) => `
  INSERT OR REPLACE INTO ${tableName} (
${columns.map((c) => `        ${c.name}`).join(",\n")}
      ) VALUES (${columns.map(() => "?").join(", ")})
`;
var buildPutParams = (columns) => columns.map((c) => c.name === "id" ? "Id" : { Column: c.name });
var buildCreateTableSql = (tableName, columns) => `
  CREATE TABLE IF NOT EXISTS ${tableName} (
${columns.map((c) => `    ${c.definition}`).join(",\n")}
  )
`;
var WORKSPACE_COLUMNS = [
	{
		name: "id",
		definition: "id TEXT PRIMARY KEY NOT NULL"
	},
	{
		name: "name",
		definition: "name TEXT NOT NULL DEFAULT ''"
	},
	{
		name: "owner_user_id",
		definition: "owner_user_id TEXT NOT NULL"
	},
	{
		name: "create_time",
		definition: "create_time INTEGER NOT NULL"
	},
	{
		name: "update_time",
		definition: "update_time INTEGER NOT NULL"
	},
	{
		name: "encryption_mode",
		definition: "encryption_mode TEXT NOT NULL DEFAULT 'none'"
	},
	{
		name: "wk_canary",
		definition: "wk_canary TEXT"
	}
];
var CREATE_WORKSPACES_TABLE_SQL = buildCreateTableSql("workspaces", WORKSPACE_COLUMNS);
/**
* Idempotent local-schema migration for the E2EE workspace columns (§7).
* CREATE TABLE IF NOT EXISTS is a no-op on a device whose `workspaces`
* table predates these columns, so add them explicitly. Guarded on column
* existence so a fresh install — which already has them from
* CREATE_WORKSPACES_TABLE_SQL — doesn't throw "duplicate column name".
* The NOT NULL DEFAULT 'none' backfills existing rows to plaintext until
* PowerSync replays each row's real value.
*/
var ensureWorkspaceE2eeColumns = async (db) => {
	const columns = await db.getAll("PRAGMA table_info(workspaces)");
	const present = new Set(columns.map((c) => c.name));
	if (!present.has("encryption_mode")) await db.execute("ALTER TABLE workspaces ADD COLUMN encryption_mode TEXT NOT NULL DEFAULT 'none'");
	if (!present.has("wk_canary")) await db.execute("ALTER TABLE workspaces ADD COLUMN wk_canary TEXT");
};
var WORKSPACES_RAW_TABLE = {
	put: {
		sql: buildPutSql("workspaces", WORKSPACE_COLUMNS),
		params: buildPutParams(WORKSPACE_COLUMNS)
	},
	delete: {
		sql: "DELETE FROM workspaces WHERE id = ?",
		params: ["Id"]
	}
};
var parseWorkspaceRow = (row) => ({
	id: row.id,
	name: row.name,
	ownerUserId: row.owner_user_id,
	createTime: row.create_time,
	updateTime: row.update_time,
	encryptionMode: row.encryption_mode,
	wkCanary: row.wk_canary
});
var WORKSPACE_MEMBER_COLUMNS = [
	{
		name: "id",
		definition: "id TEXT PRIMARY KEY NOT NULL"
	},
	{
		name: "workspace_id",
		definition: "workspace_id TEXT NOT NULL"
	},
	{
		name: "user_id",
		definition: "user_id TEXT NOT NULL"
	},
	{
		name: "role",
		definition: "role TEXT NOT NULL"
	},
	{
		name: "create_time",
		definition: "create_time INTEGER NOT NULL"
	}
];
var CREATE_WORKSPACE_MEMBERS_TABLE_SQL = buildCreateTableSql("workspace_members", WORKSPACE_MEMBER_COLUMNS);
var CREATE_WORKSPACE_MEMBERS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON workspace_members (user_id)
`;
var WORKSPACE_MEMBERS_RAW_TABLE = {
	put: {
		sql: buildPutSql("workspace_members", WORKSPACE_MEMBER_COLUMNS),
		params: buildPutParams(WORKSPACE_MEMBER_COLUMNS)
	},
	delete: {
		sql: "DELETE FROM workspace_members WHERE id = ?",
		params: ["Id"]
	}
};
var parseWorkspaceMemberRow = (row) => ({
	id: row.id,
	workspaceId: row.workspace_id,
	userId: row.user_id,
	role: row.role,
	createTime: row.create_time
});
//#endregion
export { CREATE_WORKSPACES_TABLE_SQL, CREATE_WORKSPACE_MEMBERS_INDEX_SQL, CREATE_WORKSPACE_MEMBERS_TABLE_SQL, WORKSPACES_RAW_TABLE, WORKSPACE_COLUMNS, WORKSPACE_MEMBERS_RAW_TABLE, WORKSPACE_MEMBER_COLUMNS, ensureWorkspaceE2eeColumns, parseWorkspaceMemberRow, parseWorkspaceRow };

//# sourceMappingURL=workspaceSchema.js.map