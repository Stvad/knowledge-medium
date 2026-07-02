import { setModePin } from "../sync/keys/modePin.js";
import { canAccessRemoteWorkspace, ensureLocalPersonalWorkspace, ensurePersonalWorkspace, getLocalWorkspace, listLocalWorkspaces, primeLocalWorkspaceAndMember } from "../data/workspaces.js";
import { recallRememberedWorkspace } from "../utils/lastWorkspace.js";
//#region src/bootstrap/resolveWorkspace.ts
var pinPlaintextBestEffort = (userId, workspaceId) => {
	try {
		setModePin(userId, workspaceId, "plaintext");
	} catch (err) {
		console.warn(`[App] plaintext pin failed for ${workspaceId} (will quarantine on next load)`, err);
	}
};
var resolveWorkspace = async (repo, requestedWorkspaceId, useRemoteSync) => {
	if (requestedWorkspaceId) {
		const localWs = await getLocalWorkspace(repo, requestedWorkspaceId);
		if (localWs) return {
			id: localWs.id,
			freshlyCreated: false
		};
		if (useRemoteSync) {
			const access = await canAccessRemoteWorkspace(requestedWorkspaceId);
			if (access.kind === "allowed") return {
				id: requestedWorkspaceId,
				freshlyCreated: false
			};
			if (access.kind === "unknown") {
				console.warn(`canAccessRemoteWorkspace failed for ${requestedWorkspaceId}; trusting URL workspace and proceeding`, access.error);
				return {
					id: requestedWorkspaceId,
					freshlyCreated: false
				};
			}
			console.warn(`Workspace ${requestedWorkspaceId} from URL is not accessible; falling back to default workspace.`);
		}
	}
	const remembered = recallRememberedWorkspace();
	if (remembered) {
		const ws = await getLocalWorkspace(repo, remembered);
		if (ws) return {
			id: ws.id,
			freshlyCreated: false
		};
	}
	if (useRemoteSync) {
		const result = await ensurePersonalWorkspace();
		await primeLocalWorkspaceAndMember(repo, result.workspace, result.member);
		if (result.inserted) pinPlaintextBestEffort(repo.user.id, result.workspace.id);
		return {
			id: result.workspace.id,
			freshlyCreated: result.inserted
		};
	}
	const locals = await listLocalWorkspaces(repo);
	if (locals.length > 0) return {
		id: locals[0].id,
		freshlyCreated: false
	};
	const local = await ensureLocalPersonalWorkspace(repo);
	if (local.inserted) pinPlaintextBestEffort(repo.user.id, local.workspace.id);
	return {
		id: local.workspace.id,
		freshlyCreated: local.inserted
	};
};
//#endregion
export { resolveWorkspace };

//# sourceMappingURL=resolveWorkspace.js.map