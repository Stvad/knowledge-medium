import type { Workspace, WorkspaceMembership, WorkspaceRole } from '@/types'

// These tables are sync-only from the client's perspective: rows arrive via
// Electric shapes and outgoing changes go through Supabase RPCs
// (src/data/workspaces.ts). We therefore do NOT wire outbox triggers for them.

type ColumnDef = {
  readonly name: string
  readonly definition: string
}

const buildInsertSql = (tableName: string, columns: readonly ColumnDef[]) => `
  INSERT INTO ${tableName} (
${columns.map(c => `        ${c.name}`).join(',\n')}
      ) VALUES (${columns.map(() => '?').join(', ')})
`

const buildCreateTableSql = (tableName: string, columns: readonly ColumnDef[]) => `
  CREATE TABLE IF NOT EXISTS ${tableName} (
${columns.map(c => `    ${c.definition}`).join(',\n')}
  )
`

const buildUpdateAssignments = (columns: readonly ColumnDef[]) =>
  columns
    .filter(column => column.name !== 'id')
    .map(column => `${column.name} = excluded.${column.name}`)
    .join(',\n    ')

const buildUpsertSql = (tableName: string, columns: readonly ColumnDef[]) => `
  ${buildInsertSql(tableName, columns).trim()}
  ON CONFLICT(id) DO UPDATE SET
    ${buildUpdateAssignments(columns)}
`

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string
  name: string
  owner_user_id: string
  create_time: number
  update_time: number
}

export const WORKSPACE_COLUMNS: readonly ColumnDef[] = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'name', definition: "name TEXT NOT NULL DEFAULT ''"},
  {name: 'owner_user_id', definition: 'owner_user_id TEXT NOT NULL'},
  {name: 'create_time', definition: 'create_time INTEGER NOT NULL'},
  {name: 'update_time', definition: 'update_time INTEGER NOT NULL'},
]

export const CREATE_WORKSPACES_TABLE_SQL = buildCreateTableSql('workspaces', WORKSPACE_COLUMNS)

export const UPSERT_WORKSPACE_SQL = buildUpsertSql('workspaces', WORKSPACE_COLUMNS)
export const DELETE_WORKSPACE_SQL = 'DELETE FROM workspaces WHERE id = ?'

export const parseWorkspaceRow = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.owner_user_id,
  createTime: row.create_time,
  updateTime: row.update_time,
})

// ---------------------------------------------------------------------------
// workspace_members
// ---------------------------------------------------------------------------

export interface WorkspaceMemberRow {
  id: string
  workspace_id: string
  user_id: string
  role: string
  create_time: number
}

export const WORKSPACE_MEMBER_COLUMNS: readonly ColumnDef[] = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'workspace_id', definition: 'workspace_id TEXT NOT NULL'},
  {name: 'user_id', definition: 'user_id TEXT NOT NULL'},
  {name: 'role', definition: 'role TEXT NOT NULL'},
  {name: 'create_time', definition: 'create_time INTEGER NOT NULL'},
]

export const CREATE_WORKSPACE_MEMBERS_TABLE_SQL = buildCreateTableSql(
  'workspace_members',
  WORKSPACE_MEMBER_COLUMNS,
)

export const CREATE_WORKSPACE_MEMBERS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON workspace_members (user_id)
`

export const UPSERT_WORKSPACE_MEMBER_SQL = buildUpsertSql('workspace_members', WORKSPACE_MEMBER_COLUMNS)
export const DELETE_WORKSPACE_MEMBER_SQL = 'DELETE FROM workspace_members WHERE id = ?'

export const parseWorkspaceMemberRow = (row: WorkspaceMemberRow): WorkspaceMembership => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role as WorkspaceRole,
  createTime: row.create_time,
})
