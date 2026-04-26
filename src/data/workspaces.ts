import { supabase } from '@/services/supabase'
import type {
  Workspace,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceRole,
} from '@/types'
import type { Repo } from '@/data/repo'
import {
  parseWorkspaceMemberRow,
  parseWorkspaceRow,
  type WorkspaceMemberRow,
  type WorkspaceRow,
} from '@/data/workspaceSchema'

const assertSupabase = () => {
  if (!supabase) {
    throw new Error('Supabase is not configured; workspace RPCs require remote sync')
  }
  return supabase
}

const toNumber = (value: number | string): number =>
  typeof value === 'number' ? value : Number(value)

// ---------------------------------------------------------------------------
// RPC payload parsing — Postgres returns numeric bigints as strings via PostgREST.
// ---------------------------------------------------------------------------

type RpcWorkspaceRow = {
  id: string
  name: string
  owner_user_id: string
  create_time: number | string
  update_time: number | string
}

const parseRpcWorkspace = (row: RpcWorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.owner_user_id,
  createTime: toNumber(row.create_time),
  updateTime: toNumber(row.update_time),
})

type RpcWorkspaceMemberRow = {
  id: string
  workspace_id: string
  user_id: string
  role: string
  create_time: number | string
}

const parseRpcWorkspaceMember = (row: RpcWorkspaceMemberRow): WorkspaceMembership => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role as WorkspaceRole,
  createTime: toNumber(row.create_time),
})

type RpcWorkspaceInvitationRow = {
  id: string
  workspace_id: string
  email: string
  role: string
  invited_by_user_id: string
  create_time: number | string
}

const parseRpcWorkspaceInvitation = (row: RpcWorkspaceInvitationRow): WorkspaceInvitation => ({
  id: row.id,
  workspaceId: row.workspace_id,
  email: row.email,
  role: row.role as Exclude<WorkspaceRole, 'owner'>,
  invitedByUserId: row.invited_by_user_id,
  createTime: toNumber(row.create_time),
})

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

export const ensurePersonalWorkspace = async (): Promise<Workspace> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('ensure_personal_workspace')
  if (error) throw error
  if (!data) throw new Error('ensure_personal_workspace returned no row')
  return parseRpcWorkspace(data as RpcWorkspaceRow)
}

export const createWorkspace = async (name: string): Promise<Workspace> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('create_workspace', {p_name: name})
  if (error) throw error
  if (!data) throw new Error('create_workspace returned no row')
  return parseRpcWorkspace(data as RpcWorkspaceRow)
}

export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  const client = assertSupabase()
  const {error} = await client.rpc('delete_workspace', {p_workspace_id: workspaceId})
  if (error) throw error
}

export const updateWorkspaceMemberRole = async (
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMembership> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('update_workspace_member_role', {
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_role: role,
  })
  if (error) throw error
  if (!data) throw new Error('update_workspace_member_role returned no row')
  return parseRpcWorkspaceMember(data as RpcWorkspaceMemberRow)
}

export const removeWorkspaceMember = async (
  workspaceId: string,
  userId: string,
): Promise<void> => {
  const client = assertSupabase()
  const {error} = await client.rpc('remove_workspace_member', {
    p_workspace_id: workspaceId,
    p_user_id: userId,
  })
  if (error) throw error
}

export const inviteMemberByEmail = async (
  workspaceId: string,
  email: string,
  role: Exclude<WorkspaceRole, 'owner'>,
): Promise<WorkspaceInvitation> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('invite_member_by_email', {
    p_workspace_id: workspaceId,
    p_email: email,
    p_role: role,
  })
  if (error) throw error
  if (!data) throw new Error('invite_member_by_email returned no row')
  return parseRpcWorkspaceInvitation(data as RpcWorkspaceInvitationRow)
}

export const acceptInvitation = async (invitationId: string): Promise<WorkspaceMembership> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('accept_invitation', {p_invitation_id: invitationId})
  if (error) throw error
  if (!data) throw new Error('accept_invitation returned no row')
  return parseRpcWorkspaceMember(data as RpcWorkspaceMemberRow)
}

export const declineInvitation = async (invitationId: string): Promise<void> => {
  const client = assertSupabase()
  const {error} = await client.rpc('decline_invitation', {p_invitation_id: invitationId})
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Server-side workspace listings (RLS-filtered to the current user's set).
// ---------------------------------------------------------------------------

export const listMyWorkspaceIdsViaRest = async (): Promise<Set<string>> => {
  const client = assertSupabase()
  const {data, error} = await client
    .from('workspaces')
    .select('id')
  if (error) throw error
  return new Set((data ?? []).map((row: {id: string}) => row.id))
}

// ---------------------------------------------------------------------------
// Pending-invitation reads (RLS keys these on auth.email()).
// ---------------------------------------------------------------------------

export const listMyPendingInvitations = async (): Promise<WorkspaceInvitation[]> => {
  const client = assertSupabase()
  const {data, error} = await client
    .from('workspace_invitations')
    .select('*')
  if (error) throw error
  return (data as RpcWorkspaceInvitationRow[]).map(parseRpcWorkspaceInvitation)
}

// ---------------------------------------------------------------------------
// Local PowerSync SQLite reads
// ---------------------------------------------------------------------------

const SELECT_LOCAL_WORKSPACES_SQL = `
  SELECT id, name, owner_user_id, create_time, update_time
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`

const SELECT_LOCAL_WORKSPACE_BY_ID_SQL = `
  SELECT id, name, owner_user_id, create_time, update_time
  FROM workspaces
  WHERE id = ?
  LIMIT 1
`

const SELECT_LOCAL_WORKSPACE_MEMBERS_SQL = `
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`

const SELECT_LOCAL_MEMBERSHIPS_FOR_USER_SQL = `
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE user_id = ?
`

export const listLocalWorkspaces = async (repo: Repo): Promise<Workspace[]> => {
  const rows = await repo.db.getAll<WorkspaceRow>(SELECT_LOCAL_WORKSPACES_SQL)
  return rows.map(parseWorkspaceRow)
}

export const getLocalWorkspace = async (repo: Repo, id: string): Promise<Workspace | null> => {
  const row = await repo.db.getOptional<WorkspaceRow>(SELECT_LOCAL_WORKSPACE_BY_ID_SQL, [id])
  return row ? parseWorkspaceRow(row) : null
}

export const listLocalWorkspaceMembers = async (
  repo: Repo,
  workspaceId: string,
): Promise<WorkspaceMembership[]> => {
  const rows = await repo.db.getAll<WorkspaceMemberRow>(
    SELECT_LOCAL_WORKSPACE_MEMBERS_SQL,
    [workspaceId],
  )
  return rows.map(parseWorkspaceMemberRow)
}

export const listLocalMembershipsForUser = async (
  repo: Repo,
  userId: string,
): Promise<WorkspaceMembership[]> => {
  const rows = await repo.db.getAll<WorkspaceMemberRow>(
    SELECT_LOCAL_MEMBERSHIPS_FOR_USER_SQL,
    [userId],
  )
  return rows.map(parseWorkspaceMemberRow)
}

// ---------------------------------------------------------------------------
// Optimistic local seeding (after RPC returns, before sync replicates).
//
// The workspaces / workspace_members raw tables have no powersync_crud trigger,
// so direct INSERT OR REPLACE is local-only. PowerSync will overwrite with
// the canonical row when sync replicates.
// ---------------------------------------------------------------------------

export const primeLocalWorkspace = async (repo: Repo, workspace: Workspace): Promise<void> => {
  await repo.db.execute(
    `INSERT OR REPLACE INTO workspaces (id, name, owner_user_id, create_time, update_time)
     VALUES (?, ?, ?, ?, ?)`,
    [workspace.id, workspace.name, workspace.ownerUserId, workspace.createTime, workspace.updateTime],
  )
}

export const primeLocalMembership = async (
  repo: Repo,
  membership: WorkspaceMembership,
): Promise<void> => {
  await repo.db.execute(
    `INSERT OR REPLACE INTO workspace_members (id, workspace_id, user_id, role, create_time)
     VALUES (?, ?, ?, ?, ?)`,
    [
      membership.id,
      membership.workspaceId,
      membership.userId,
      membership.role,
      membership.createTime,
    ],
  )
}
