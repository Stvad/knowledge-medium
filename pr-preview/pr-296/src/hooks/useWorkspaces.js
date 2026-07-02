import { useQuery } from "../../node_modules/@powersync/react/lib/hooks/watched/useQuery.js";
import "../../node_modules/@powersync/react/lib/index.js";
import { useHash } from "../../node_modules/react-use/esm/useHash.js";
import { useRepo } from "../context/repo.js";
import { parseAppHash } from "../utils/routing.js";
import { c } from "react/compiler-runtime";
//#region src/hooks/useWorkspaces.ts
/** The active workspace id, re-rendered reactively on a workspace switch.
*
*  Subscribes to the URL hash via `useHash` (a switch only assigns the hash —
*  no reload — and `repo.activeWorkspaceId` is an imperative pin that mutates
*  WITHOUT notifying React), so reading this re-renders subscribers when the
*  workspace changes.
*
*  The *value* prefers the pin: it's the workspace `App` actually resolved and
*  committed (always the accessible one). The hash is navigation intent that
*  can momentarily point at a workspace App fell back away from — a denied /
*  redirected deep link, whose URL App normalizes via `history.replaceState`
*  (which fires no `hashchange`, so a live `useHash` can lag). Following the
*  raw hash there would have the write-backed user-page hooks (`useUserBlock`)
*  touch a workspace the user can't access. On a switcher switch the pin is set
*  synchronously before the hash changes, so pin-first is identical there; the
*  hash is only the fallback before the pin is first set. */
var useActiveWorkspaceId = () => {
	const $ = c(3);
	const repo = useRepo();
	const [hash] = useHash();
	let t0;
	if ($[0] !== hash || $[1] !== repo.activeWorkspaceId) {
		t0 = repo.activeWorkspaceId ?? parseAppHash(hash).workspaceId ?? null;
		$[0] = hash;
		$[1] = repo.activeWorkspaceId;
		$[2] = t0;
	} else t0 = $[2];
	return t0;
};
var SELECT_WORKSPACES_SQL = `
  SELECT id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`;
var SELECT_WORKSPACE_MEMBERS_SQL = `
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`;
var parseWorkspace = (row) => ({
	id: row.id,
	name: row.name,
	ownerUserId: row.owner_user_id,
	createTime: row.create_time,
	updateTime: row.update_time,
	encryptionMode: row.encryption_mode,
	wkCanary: row.wk_canary
});
var parseMember = (row) => ({
	id: row.id,
	workspaceId: row.workspace_id,
	userId: row.user_id,
	role: row.role,
	createTime: row.create_time
});
/** Reactive list of all workspaces the current user belongs to. */
var useWorkspaces = () => {
	const $ = c(5);
	const { data, isLoading } = useQuery(SELECT_WORKSPACES_SQL);
	let t0;
	if ($[0] !== data) {
		t0 = data.map(parseWorkspace);
		$[0] = data;
		$[1] = t0;
	} else t0 = $[1];
	let t1;
	if ($[2] !== isLoading || $[3] !== t0) {
		t1 = {
			workspaces: t0,
			isLoading
		};
		$[2] = isLoading;
		$[3] = t0;
		$[4] = t1;
	} else t1 = $[4];
	return t1;
};
/** Reactive list of members for a specific workspace. */
var useWorkspaceMembers = (workspaceId) => {
	const $ = c(8);
	const t0 = workspaceId ?? "";
	let t1;
	if ($[0] !== t0) {
		t1 = [t0];
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	const { data, isLoading } = useQuery(SELECT_WORKSPACE_MEMBERS_SQL, t1);
	let t2;
	if ($[2] !== data || $[3] !== workspaceId) {
		t2 = workspaceId ? data.map(parseMember) : [];
		$[2] = data;
		$[3] = workspaceId;
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] !== isLoading || $[6] !== t2) {
		t3 = {
			members: t2,
			isLoading
		};
		$[5] = isLoading;
		$[6] = t2;
		$[7] = t3;
	} else t3 = $[7];
	return t3;
};
var SELECT_MY_ROLES_SQL = `
  SELECT workspace_id, role
  FROM workspace_members
  WHERE user_id = ?
`;
/** Reactive map of (workspaceId -> current user's role) for every workspace
*  the user belongs to. Backed by PowerSync's useQuery so role changes
*  pushed by the server flow through to subscribers without a reload. */
var useMyWorkspaceRoles = () => {
	const $ = c(7);
	const repo = useRepo();
	let t0;
	if ($[0] !== repo.user.id) {
		t0 = [repo.user.id];
		$[0] = repo.user.id;
		$[1] = t0;
	} else t0 = $[1];
	const { data, isLoading } = useQuery(SELECT_MY_ROLES_SQL, t0);
	let t1;
	if ($[2] !== data) {
		t1 = new Map(data.map(_temp));
		$[2] = data;
		$[3] = t1;
	} else t1 = $[3];
	const rolesByWorkspaceId = t1;
	let t2;
	if ($[4] !== isLoading || $[5] !== rolesByWorkspaceId) {
		t2 = {
			rolesByWorkspaceId,
			isLoading
		};
		$[4] = isLoading;
		$[5] = rolesByWorkspaceId;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
};
function _temp(row) {
	return [row.workspace_id, row.role];
}
//#endregion
export { useActiveWorkspaceId, useMyWorkspaceRoles, useWorkspaceMembers, useWorkspaces };

//# sourceMappingURL=useWorkspaces.js.map