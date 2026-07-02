import v5 from "../../node_modules/uuid/dist/v5.js";
import { supabase } from "../services/supabase.js";
import { parseWorkspaceMemberRow, parseWorkspaceRow } from "./workspaceSchema.js";
//#region src/data/workspaces.ts
var assertSupabase = () => {
	if (!supabase) throw new Error("Supabase is not configured; workspace RPCs require remote sync");
	return supabase;
};
var toNumber = (value) => typeof value === "number" ? value : Number(value);
var parseRpcWorkspace = (row) => ({
	id: row.id,
	name: row.name,
	ownerUserId: row.owner_user_id,
	createTime: toNumber(row.create_time),
	updateTime: toNumber(row.update_time),
	encryptionMode: row.encryption_mode,
	wkCanary: row.wk_canary
});
var parseRpcWorkspaceMember = (row) => ({
	id: row.id,
	workspaceId: row.workspace_id,
	userId: row.user_id,
	role: row.role,
	createTime: toNumber(row.create_time)
});
var parseRpcWorkspaceInvitation = (row) => ({
	id: row.id,
	workspaceId: row.workspace_id,
	workspaceName: row.workspace_name,
	email: row.email,
	role: row.role,
	invitedByUserId: row.invited_by_user_id,
	createTime: toNumber(row.create_time)
});
var parseRpcWorkspaceMemberWithEmail = (row) => ({
	id: row.id,
	workspaceId: row.workspace_id,
	userId: row.user_id,
	role: row.role,
	email: row.email,
	createTime: toNumber(row.create_time)
});
var canAccessRemoteWorkspace = async (workspaceId) => {
	const client = assertSupabase();
	try {
		const { data, error } = await client.from("workspaces").select("id").eq("id", workspaceId).maybeSingle();
		if (error) return {
			kind: "unknown",
			error
		};
		return data ? { kind: "allowed" } : { kind: "denied" };
	} catch (error) {
		return {
			kind: "unknown",
			error
		};
	}
};
var parseCreatedWorkspace = (payload) => ({
	workspace: parseRpcWorkspace(payload.workspace),
	member: parseRpcWorkspaceMember(payload.member)
});
var ensurePersonalWorkspace = async () => {
	const { data, error } = await assertSupabase().rpc("ensure_personal_workspace");
	if (error) throw error;
	if (!data) throw new Error("ensure_personal_workspace returned no payload");
	const payload = data;
	return {
		...parseCreatedWorkspace(payload),
		inserted: payload.inserted
	};
};
var createWorkspace = async (name, options = {}) => {
	const client = assertSupabase();
	const params = { p_name: name };
	if (options.encryptionMode) params.p_encryption_mode = options.encryptionMode;
	if (options.workspaceId) params.p_workspace_id = options.workspaceId;
	if (options.wkCanary) params.p_wk_canary = options.wkCanary;
	const { data, error } = await client.rpc("create_workspace", params);
	if (error) throw error;
	if (!data) throw new Error("create_workspace returned no payload");
	return parseCreatedWorkspace(data);
};
var deleteWorkspace = async (workspaceId) => {
	const { error } = await assertSupabase().rpc("delete_workspace", { p_workspace_id: workspaceId });
	if (error) throw error;
};
var renameWorkspace = async (workspaceId, name) => {
	const client = assertSupabase();
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Workspace name cannot be empty");
	const { error } = await client.from("workspaces").update({
		name: trimmed,
		update_time: Date.now()
	}).eq("id", workspaceId);
	if (error) throw error;
};
var updateWorkspaceMemberRole = async (workspaceId, userId, role) => {
	const { data, error } = await assertSupabase().rpc("update_workspace_member_role", {
		p_workspace_id: workspaceId,
		p_user_id: userId,
		p_role: role
	});
	if (error) throw error;
	if (!data) throw new Error("update_workspace_member_role returned no row");
	return parseRpcWorkspaceMember(data);
};
var removeWorkspaceMember = async (workspaceId, userId) => {
	const { error } = await assertSupabase().rpc("remove_workspace_member", {
		p_workspace_id: workspaceId,
		p_user_id: userId
	});
	if (error) throw error;
};
var inviteMemberByEmail = async (workspaceId, email, role) => {
	const { data, error } = await assertSupabase().rpc("invite_member_by_email", {
		p_workspace_id: workspaceId,
		p_email: email,
		p_role: role
	});
	if (error) throw error;
	if (!data) throw new Error("invite_member_by_email returned no row");
	return parseRpcWorkspaceInvitation(data);
};
var acceptInvitation = async (invitationId) => {
	const { data, error } = await assertSupabase().rpc("accept_invitation", { p_invitation_id: invitationId });
	if (error) throw error;
	if (!data) throw new Error("accept_invitation returned no row");
	return parseRpcWorkspaceMember(data);
};
var declineInvitation = async (invitationId) => {
	const { error } = await assertSupabase().rpc("decline_invitation", { p_invitation_id: invitationId });
	if (error) throw error;
};
var listMyPendingInvitations = async () => {
	const { data, error } = await assertSupabase().rpc("list_my_pending_invitations");
	if (error) throw error;
	return data.map(parseRpcWorkspaceInvitation);
};
var listWorkspaceMembersWithEmails = async (workspaceId) => {
	const { data, error } = await assertSupabase().rpc("list_workspace_members_with_emails", { p_workspace_id: workspaceId });
	if (error) throw error;
	return data.map(parseRpcWorkspaceMemberWithEmail);
};
var SELECT_LOCAL_WORKSPACES_SQL = `
  SELECT id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`;
var SELECT_LOCAL_WORKSPACE_BY_ID_SQL = `
  SELECT id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary
  FROM workspaces
  WHERE id = ?
  LIMIT 1
`;
var SELECT_LOCAL_WORKSPACE_MEMBERS_SQL = `
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`;
var SELECT_LOCAL_MEMBERSHIPS_FOR_USER_SQL = `
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE user_id = ?
`;
var listLocalWorkspaces = async (repo) => {
	return (await repo.db.getAll(SELECT_LOCAL_WORKSPACES_SQL)).map(parseWorkspaceRow);
};
var getLocalWorkspace = async (repo, id) => {
	const row = await repo.db.getOptional(SELECT_LOCAL_WORKSPACE_BY_ID_SQL, [id]);
	return row ? parseWorkspaceRow(row) : null;
};
var listLocalWorkspaceMembers = async (repo, workspaceId) => {
	return (await repo.db.getAll(SELECT_LOCAL_WORKSPACE_MEMBERS_SQL, [workspaceId])).map(parseWorkspaceMemberRow);
};
var listLocalMembershipsForUser = async (repo, userId) => {
	return (await repo.db.getAll(SELECT_LOCAL_MEMBERSHIPS_FOR_USER_SQL, [userId])).map(parseWorkspaceMemberRow);
};
var getLocalMemberRole = async (repo, workspaceId, userId) => {
	const row = await repo.db.getOptional(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1`, [workspaceId, userId]);
	return row ? row.role : null;
};
var primeLocalWorkspace = async (repo, workspace) => {
	await repo.db.execute(`INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [
		workspace.id,
		workspace.name,
		workspace.ownerUserId,
		workspace.createTime,
		workspace.updateTime,
		workspace.encryptionMode,
		workspace.wkCanary
	]);
};
var primeLocalMembership = async (repo, membership) => {
	await repo.db.execute(`INSERT OR REPLACE INTO workspace_members (id, workspace_id, user_id, role, create_time)
     VALUES (?, ?, ?, ?, ?)`, [
		membership.id,
		membership.workspaceId,
		membership.userId,
		membership.role,
		membership.createTime
	]);
};
var primeLocalWorkspaceAndMember = async (repo, workspace, member) => {
	await primeLocalWorkspace(repo, workspace);
	await primeLocalMembership(repo, member);
};
var LOCAL_PERSONAL_WORKSPACE_NS = "b13a1f4e-8a9d-4d8e-9e3a-7c2c4f5a1c80";
var ensureLocalPersonalWorkspace = async (repo) => {
	const userId = repo.user.id;
	const workspaceId = v5(`local-personal:${userId}`, LOCAL_PERSONAL_WORKSPACE_NS);
	const memberId = v5(`local-member:${userId}`, LOCAL_PERSONAL_WORKSPACE_NS);
	const existing = await getLocalWorkspace(repo, workspaceId);
	if (existing) {
		const ownerMember = (await listLocalWorkspaceMembers(repo, workspaceId)).find((m) => m.userId === userId);
		if (!ownerMember) throw new Error(`Local personal workspace ${workspaceId} is missing a membership for user ${userId}`);
		return {
			workspace: existing,
			member: ownerMember,
			inserted: false
		};
	}
	const now = Date.now();
	const workspace = {
		id: workspaceId,
		name: `${repo.user.name}'s Workspace`,
		ownerUserId: userId,
		createTime: now,
		updateTime: now,
		encryptionMode: "none",
		wkCanary: null
	};
	const member = {
		id: memberId,
		workspaceId,
		userId,
		role: "owner",
		createTime: now
	};
	await primeLocalWorkspaceAndMember(repo, workspace, member);
	return {
		workspace,
		member,
		inserted: true
	};
};
//#endregion
export { acceptInvitation, canAccessRemoteWorkspace, createWorkspace, declineInvitation, deleteWorkspace, ensureLocalPersonalWorkspace, ensurePersonalWorkspace, getLocalMemberRole, getLocalWorkspace, inviteMemberByEmail, listLocalMembershipsForUser, listLocalWorkspaceMembers, listLocalWorkspaces, listMyPendingInvitations, listWorkspaceMembersWithEmails, primeLocalWorkspaceAndMember, removeWorkspaceMember, renameWorkspace, updateWorkspaceMemberRole };

//# sourceMappingURL=workspaces.js.map