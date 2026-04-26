import { useQuery } from '@powersync/react'
import type { Workspace, WorkspaceMembership, WorkspaceRole } from '@/types'

interface WorkspaceRowResult {
  id: string
  name: string
  owner_user_id: string
  create_time: number
  update_time: number
}

interface WorkspaceMemberRowResult {
  id: string
  workspace_id: string
  user_id: string
  role: string
  create_time: number
}

const SELECT_WORKSPACES_SQL = `
  SELECT id, name, owner_user_id, create_time, update_time
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`

const SELECT_WORKSPACE_MEMBERS_SQL = `
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`

const parseWorkspace = (row: WorkspaceRowResult): Workspace => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.owner_user_id,
  createTime: row.create_time,
  updateTime: row.update_time,
})

const parseMember = (row: WorkspaceMemberRowResult): WorkspaceMembership => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role as WorkspaceRole,
  createTime: row.create_time,
})

/** Reactive list of all workspaces the current user belongs to. */
export const useWorkspaces = (): {workspaces: Workspace[], isLoading: boolean} => {
  const {data, isLoading} = useQuery<WorkspaceRowResult>(SELECT_WORKSPACES_SQL)
  return {
    workspaces: data.map(parseWorkspace),
    isLoading,
  }
}

/** Reactive list of members for a specific workspace. */
export const useWorkspaceMembers = (
  workspaceId: string | null | undefined,
): {members: WorkspaceMembership[], isLoading: boolean} => {
  const {data, isLoading} = useQuery<WorkspaceMemberRowResult>(
    SELECT_WORKSPACE_MEMBERS_SQL,
    [workspaceId ?? ''],
  )
  return {
    members: workspaceId ? data.map(parseMember) : [],
    isLoading,
  }
}
