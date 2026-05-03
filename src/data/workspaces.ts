import { v5 as uuidv5 } from 'uuid'
import { supabase } from '@/services/supabase'
import type {
  Workspace,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceMemberWithEmail,
  WorkspaceRole,
} from '@/types'
import type { Repo } from './repo'
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
  workspace_name?: string
  email: string
  role: string
  invited_by_user_id: string
  create_time: number | string
}

const parseRpcWorkspaceInvitation = (row: RpcWorkspaceInvitationRow): WorkspaceInvitation => ({
  id: row.id,
  workspaceId: row.workspace_id,
  workspaceName: row.workspace_name,
  email: row.email,
  role: row.role as Exclude<WorkspaceRole, 'owner'>,
  invitedByUserId: row.invited_by_user_id,
  createTime: toNumber(row.create_time),
})

type RpcWorkspaceMemberWithEmailRow = {
  id: string
  workspace_id: string
  user_id: string
  role: string
  email: string
  create_time: number | string
}

const parseRpcWorkspaceMemberWithEmail = (
  row: RpcWorkspaceMemberWithEmailRow,
): WorkspaceMemberWithEmail => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role as WorkspaceRole,
  email: row.email,
  createTime: toNumber(row.create_time),
})

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

// Server-side, RLS-gated access check. We use this at bootstrap to decide
// whether to trust a URL hash workspace id BEFORE relying on PowerSync's
// local replication — `waitForFirstSync` returns instantly on subsequent
// visits (first sync already done, persistent IndexedDB), so polling for
// the local row to "appear" is unreliable as an access check.
//
// Tri-state result so the caller can distinguish offline / transient
// failure from a real "no access":
//
//   - 'allowed' — RLS lets us read the row; trust the URL.
//   - 'denied'  — request succeeded with no row. RLS denial OR a
//                 deleted/non-existent workspace; both mean "fall through
//                 to the default workspace" since the user provably can't
//                 see it.
//   - 'unknown' — transport failure (offline, 5xx, JWT refresh in flight,
//                 structured PostgREST error). We can't tell allowed
//                 from denied, so the caller MUST NOT silently bump the
//                 user to a different workspace — that misroutes anyone
//                 offline with a previously-cached workspace they
//                 legitimately have access to.
export type WorkspaceAccessResult =
  | {kind: 'allowed'}
  | {kind: 'denied'}
  | {kind: 'unknown', error: unknown}

export const canAccessRemoteWorkspace = async (
  workspaceId: string,
): Promise<WorkspaceAccessResult> => {
  const client = assertSupabase()
  try {
    const {data, error} = await client
      .from('workspaces')
      .select('id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (error) {
      // Structured PostgREST/auth error (JWT expired, 5xx, schema cache
      // miss, etc.). Treat as unknown rather than denied so we don't
      // misroute on a transient failure.
      return {kind: 'unknown', error}
    }
    return data ? {kind: 'allowed'} : {kind: 'denied'}
  } catch (error) {
    // Network failure thrown by fetch (TypeError: Failed to fetch,
    // AbortError, DNS, etc.) — the user is offline or the server is
    // unreachable.
    return {kind: 'unknown', error}
  }
}

// Both create_workspace and ensure_personal_workspace return a jsonb
// envelope { workspace, member [, inserted] } so the client gets the
// canonical member row in the same round-trip as the workspace. Priming
// local state with the canonical member id avoids the duplicate rows
// that used to come from a synthetic-id local prime + canonical row
// arriving via sync (the raw workspace_members table has no UNIQUE
// constraint on (workspace_id, user_id) to dedupe them).
//
// The RPCs no longer seed a workspace root block. Bootstrap creates
// today's daily note client-side via getOrCreateDailyNote, which is
// idempotent under deterministic UUIDs — no soft-lock if the client
// crashes between RPC and seed write because there's no separate seed
// step to crash between.
type WorkspaceCreationPayload = {
  workspace: RpcWorkspaceRow
  member: RpcWorkspaceMemberRow
}

type EnsurePersonalWorkspacePayload = WorkspaceCreationPayload & {
  inserted: boolean
}

export interface CreatedWorkspace {
  workspace: Workspace
  member: WorkspaceMembership
}

export interface EnsuredPersonalWorkspace {
  workspace: Workspace
  member: WorkspaceMembership
  inserted: boolean
}

const parseCreatedWorkspace = (payload: WorkspaceCreationPayload): CreatedWorkspace => ({
  workspace: parseRpcWorkspace(payload.workspace),
  member: parseRpcWorkspaceMember(payload.member),
})

export const ensurePersonalWorkspace = async (): Promise<EnsuredPersonalWorkspace> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('ensure_personal_workspace')
  if (error) throw error
  if (!data) throw new Error('ensure_personal_workspace returned no payload')
  const payload = data as EnsurePersonalWorkspacePayload
  return {
    ...parseCreatedWorkspace(payload),
    inserted: payload.inserted,
  }
}

export const createWorkspace = async (name: string): Promise<CreatedWorkspace> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('create_workspace', {p_name: name})
  if (error) throw error
  if (!data) throw new Error('create_workspace returned no payload')
  return parseCreatedWorkspace(data as WorkspaceCreationPayload)
}

export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  const client = assertSupabase()
  const {error} = await client.rpc('delete_workspace', {p_workspace_id: workspaceId})
  if (error) throw error
}

// Rename uses a direct UPDATE — workspaces_update RLS allows writers
// (owner + editor) to modify the row. No RPC needed.
export const renameWorkspace = async (workspaceId: string, name: string): Promise<void> => {
  const client = assertSupabase()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Workspace name cannot be empty')
  const {error} = await client
    .from('workspaces')
    .update({name: trimmed, update_time: Date.now()})
    .eq('id', workspaceId)
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
// Pending-invitation + member-with-email reads (server-joined, server-filtered).
// ---------------------------------------------------------------------------

export const listMyPendingInvitations = async (): Promise<WorkspaceInvitation[]> => {
  const client = assertSupabase()
  // The RPC filters server-side by auth.email() AND joins workspace.name, so
  // (a) inviters don't see their outgoing invites in their personal inbox
  // (the RLS owner-read policy would otherwise leak them), and (b) the
  // notification UI can render a friendly workspace name.
  const {data, error} = await client.rpc('list_my_pending_invitations')
  if (error) throw error
  return (data as RpcWorkspaceInvitationRow[]).map(parseRpcWorkspaceInvitation)
}

export const listWorkspaceMembersWithEmails = async (
  workspaceId: string,
): Promise<WorkspaceMemberWithEmail[]> => {
  const client = assertSupabase()
  const {data, error} = await client.rpc('list_workspace_members_with_emails', {
    p_workspace_id: workspaceId,
  })
  if (error) throw error
  return (data as RpcWorkspaceMemberWithEmailRow[]).map(parseRpcWorkspaceMemberWithEmail)
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

// Returns null when the membership hasn't synced locally yet (rare — happens
// only when the workspace itself just became accessible via URL hop and
// PowerSync hasn't replicated the membership row yet). Caller decides the
// default behavior in that case.
export const getLocalMemberRole = async (
  repo: Repo,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> => {
  const row = await repo.db.getOptional<{role: string}>(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1`,
    [workspaceId, userId],
  )
  return row ? (row.role as WorkspaceRole) : null
}

// ---------------------------------------------------------------------------
// Optimistic local seeding (after RPC returns, before sync replicates).
//
// The workspaces / workspace_members raw tables have no powersync_crud trigger,
// so direct INSERT OR REPLACE is local-only. PowerSync will overwrite with
// the canonical row when sync replicates.
// ---------------------------------------------------------------------------

// Module-private — call sites should use primeLocalWorkspaceAndMember so
// we always prime both rows together (and don't accidentally drift back
// toward inlined two-step primes with synthesized member ids).
const primeLocalWorkspace = async (repo: Repo, workspace: Workspace): Promise<void> => {
  await repo.db.execute(
    `INSERT OR REPLACE INTO workspaces (id, name, owner_user_id, create_time, update_time)
     VALUES (?, ?, ?, ?, ?)`,
    [workspace.id, workspace.name, workspace.ownerUserId, workspace.createTime, workspace.updateTime],
  )
}

const primeLocalMembership = async (
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

// Optimistic-prime convenience for "I just got a workspace + canonical
// member back from create_workspace / ensure_personal_workspace": writes
// both rows to local SQLite so the switcher renders immediately, before
// PowerSync replicates them.
//
// Both call sites (App.tsx ensure-personal-workspace bootstrap and
// CreateWorkspaceDialog create flow) used to inline this two-step prime
// independently. Keeping it in one helper means future tweaks (e.g.
// wrapping in a transaction, adding logging, retry logic) only land once.
//
// The member must be the canonical row returned by the RPC (with the
// server-generated id), NOT a synthesized one — local raw `workspace_members`
// has no (workspace_id, user_id) UNIQUE constraint, so a fake id would
// coexist with the canonical row once sync delivers it.
export const primeLocalWorkspaceAndMember = async (
  repo: Repo,
  workspace: Workspace,
  member: WorkspaceMembership,
): Promise<void> => {
  await primeLocalWorkspace(repo, workspace)
  await primeLocalMembership(repo, member)
}

// ---------------------------------------------------------------------------
// Local-only personal workspace bootstrap (used when remote sync is
// disabled — `.env.local` without VITE_SUPABASE_*). Mirrors
// `ensurePersonalWorkspace` but without an RPC: we synthesize a
// workspace + owner membership directly into local SQLite. IDs are
// derived from the user id with uuidv5 so reloads (or repeat boots in
// the same browser profile) converge on the same workspace.
// ---------------------------------------------------------------------------

const LOCAL_PERSONAL_WORKSPACE_NS = 'b13a1f4e-8a9d-4d8e-9e3a-7c2c4f5a1c80'

export const ensureLocalPersonalWorkspace = async (
  repo: Repo,
): Promise<EnsuredPersonalWorkspace> => {
  const userId = repo.user.id
  const workspaceId = uuidv5(`local-personal:${userId}`, LOCAL_PERSONAL_WORKSPACE_NS)
  const memberId = uuidv5(`local-member:${userId}`, LOCAL_PERSONAL_WORKSPACE_NS)

  const existing = await getLocalWorkspace(repo, workspaceId)
  if (existing) {
    const memberships = await listLocalWorkspaceMembers(repo, workspaceId)
    const ownerMember = memberships.find((m) => m.userId === userId)
    if (!ownerMember) {
      throw new Error(
        `Local personal workspace ${workspaceId} is missing a membership for user ${userId}`,
      )
    }
    return {workspace: existing, member: ownerMember, inserted: false}
  }

  const now = Date.now()
  const workspace: Workspace = {
    id: workspaceId,
    name: `${repo.user.name}'s Workspace`,
    ownerUserId: userId,
    createTime: now,
    updateTime: now,
  }
  const member: WorkspaceMembership = {
    id: memberId,
    workspaceId,
    userId,
    role: 'owner',
    createTime: now,
  }
  await primeLocalWorkspaceAndMember(repo, workspace, member)
  return {workspace, member, inserted: true}
}
