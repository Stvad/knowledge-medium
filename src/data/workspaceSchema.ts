import type { PendingStatementParameter, RawTableType } from '@powersync/web'
import type { Workspace, WorkspaceMembership, WorkspaceRole } from '@/types'

// These tables are sync-only from the client's perspective: rows arrive via
// PowerSync streams (powersync/sync-config.yaml) and outgoing changes go
// through Supabase RPCs (src/data/workspaces.ts). We therefore do NOT wire
// powersync_crud triggers for them in repoInstance.ts.

type ColumnDef = {
  readonly name: string
  readonly definition: string
}

const buildPutSql = (tableName: string, columns: readonly ColumnDef[]) => `
  INSERT OR REPLACE INTO ${tableName} (
${columns.map(c => `        ${c.name}`).join(',\n')}
      ) VALUES (${columns.map(() => '?').join(', ')})
`

const buildPutParams = (columns: readonly ColumnDef[]): PendingStatementParameter[] =>
  columns.map(c => (c.name === 'id' ? 'Id' : {Column: c.name}))

const buildCreateTableSql = (tableName: string, columns: readonly ColumnDef[]) => `
  CREATE TABLE IF NOT EXISTS ${tableName} (
${columns.map(c => `    ${c.definition}`).join(',\n')}
  )
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

const WORKSPACE_COLUMNS: readonly ColumnDef[] = [
  {name: 'id', definition: 'id TEXT PRIMARY KEY NOT NULL'},
  {name: 'name', definition: "name TEXT NOT NULL DEFAULT ''"},
  {name: 'owner_user_id', definition: 'owner_user_id TEXT NOT NULL'},
  {name: 'create_time', definition: 'create_time INTEGER NOT NULL'},
  {name: 'update_time', definition: 'update_time INTEGER NOT NULL'},
]

export const CREATE_WORKSPACES_TABLE_SQL = buildCreateTableSql('workspaces', WORKSPACE_COLUMNS)

export const WORKSPACES_RAW_TABLE = {
  put: {
    sql: buildPutSql('workspaces', WORKSPACE_COLUMNS),
    params: buildPutParams(WORKSPACE_COLUMNS),
  },
  delete: {
    sql: 'DELETE FROM workspaces WHERE id = ?',
    params: ['Id'],
  },
} satisfies RawTableType

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

const WORKSPACE_MEMBER_COLUMNS: readonly ColumnDef[] = [
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

export const WORKSPACE_MEMBERS_RAW_TABLE = {
  put: {
    sql: buildPutSql('workspace_members', WORKSPACE_MEMBER_COLUMNS),
    params: buildPutParams(WORKSPACE_MEMBER_COLUMNS),
  },
  delete: {
    sql: 'DELETE FROM workspace_members WHERE id = ?',
    params: ['Id'],
  },
} satisfies RawTableType

export const parseWorkspaceMemberRow = (row: WorkspaceMemberRow): WorkspaceMembership => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role as WorkspaceRole,
  createTime: row.create_time,
})
