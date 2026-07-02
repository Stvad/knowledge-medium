import { useQuery } from "../node_modules/@powersync/react/lib/hooks/watched/useQuery.js";
import "../node_modules/@powersync/react/lib/index.js";
import useSearchParam_default from "../node_modules/react-use/esm/useSearchParam.js";
import { hasRemoteSyncConfig } from "./services/powersync.js";
import { useIsLocalOnly } from "./components/Login.js";
import { markStartup } from "./utils/startupTimeline.js";
import { useRepo } from "./context/repo.js";
import { BlockContextProvider } from "./context/block.js";
import { layoutWorkspaceChanged, parseLayout } from "./utils/routing.js";
import { useMyWorkspaceRoles } from "./hooks/useWorkspaces.js";
import { PanelLayoutProjection } from "./utils/panelLayoutProjection.js";
import { BlockComponent } from "./components/BlockComponent.js";
import { hasSafeModeSearchParam } from "./utils/safeMode.js";
import { getLocalMemberRole, getLocalWorkspace } from "./data/workspaces.js";
import { AppRuntimeProvider } from "./extensions/AppRuntimeProvider.js";
import { resolveWorkspaceEntry } from "./sync/keys/resolveWorkspaceEntry.js";
import { WorkspaceKeyGate } from "./components/workspace/WorkspaceKeyGate.js";
import { resolveWorkspace } from "./bootstrap/resolveWorkspace.js";
import { bootstrapWorkspace } from "./bootstrap/workspaceBootstrap.js";
import { use, useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/App.tsx
var INITIAL_LAYOUT_CACHE_LIMIT = 64;
var initialLayoutCache = /* @__PURE__ */ new Map();
var getCurrentHash = () => typeof window === "undefined" ? "" : window.location.hash;
var resolveInitialLayout = async (repo, requestedHash, useRemoteSync) => {
	const route = parseLayout(requestedHash);
	const { id: workspaceId, freshlyCreated } = await resolveWorkspace(repo, route.workspaceId, useRemoteSync);
	repo.setActiveWorkspaceId(workspaceId);
	const role = await getLocalMemberRole(repo, workspaceId, repo.user.id);
	repo.setReadOnly(role === "viewer");
	const entry = await resolveWorkspaceEntry(repo.user.id, workspaceId, (id) => getLocalWorkspace(repo, id));
	markStartup("workspaceResolved");
	if (entry.kind === "waiting") {
		repo.setReadOnly(true);
		return {
			kind: "waiting",
			workspaceId
		};
	}
	if (entry.kind === "locked") {
		repo.setReadOnly(true);
		return {
			kind: "locked",
			workspaceId,
			workspaceName: entry.workspaceName,
			reason: entry.reason,
			canary: entry.canary
		};
	}
	const layoutSessionBlock = await bootstrapWorkspace({
		repo,
		workspaceId,
		freshlyCreated,
		requestedHash,
		requestedWorkspaceId: route.workspaceId
	});
	markStartup("bootstrapDone");
	return {
		kind: "ready",
		workspaceId,
		layoutSessionBlock
	};
};
var initialLayoutCacheKey = (repo, requestedHash, useRemoteSync, navigationVersion) => [
	repo.instanceId,
	requestedHash || "__empty_hash__",
	useRemoteSync ? "remote" : "local",
	navigationVersion
].join(":");
var getInitialLayout = (repo, requestedHash, useRemoteSync, navigationVersion) => {
	const key = initialLayoutCacheKey(repo, requestedHash, useRemoteSync, navigationVersion);
	const cached = initialLayoutCache.get(key);
	if (cached) {
		initialLayoutCache.delete(key);
		initialLayoutCache.set(key, cached);
		return cached;
	}
	const promise = resolveInitialLayout(repo, requestedHash, useRemoteSync);
	initialLayoutCache.set(key, promise);
	if (initialLayoutCache.size > INITIAL_LAYOUT_CACHE_LIMIT) {
		const oldest = initialLayoutCache.keys().next().value;
		if (oldest) initialLayoutCache.delete(oldest);
	}
	promise.catch(() => {
		if (initialLayoutCache.get(key) === promise) initialLayoutCache.delete(key);
	});
	return promise;
};
var App = () => {
	const $ = c(48);
	const repo = useRepo();
	const [hashSnapshot, setHashSnapshot] = useState(_temp);
	const t0 = useSearchParam_default("safeMode");
	let t1;
	if ($[0] !== t0) {
		t1 = hasSafeModeSearchParam(t0);
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	const safeMode = t1;
	const localOnly = useIsLocalOnly();
	const useRemoteSync = hasRemoteSyncConfig && !localOnly;
	let t2;
	if ($[2] !== hashSnapshot.hash || $[3] !== hashSnapshot.version || $[4] !== repo || $[5] !== useRemoteSync) {
		t2 = getInitialLayout(repo, hashSnapshot.hash, useRemoteSync, hashSnapshot.version);
		$[2] = hashSnapshot.hash;
		$[3] = hashSnapshot.version;
		$[4] = repo;
		$[5] = useRemoteSync;
		$[6] = t2;
	} else t2 = $[6];
	const initial = use(t2);
	const activeWorkspaceId = initial.workspaceId;
	const layoutSessionBlock = initial.kind === "ready" ? initial.layoutSessionBlock : null;
	let t3;
	let t4;
	if ($[7] !== activeWorkspaceId || $[8] !== layoutSessionBlock || $[9] !== repo) {
		t3 = () => {
			if (!layoutSessionBlock) return;
			const projection = new PanelLayoutProjection({
				repo,
				workspaceId: activeWorkspaceId,
				layoutSessionBlock
			});
			const syncHash = () => {
				const nextHash = getCurrentHash();
				setHashSnapshot((current) => {
					if (!layoutWorkspaceChanged(current.hash, nextHash)) return current;
					return {
						hash: nextHash,
						version: current.version + 1
					};
				});
			};
			const unsubscribe = projection.subscribe(syncHash);
			let disposed = false;
			projection.start().then(() => {
				if (disposed) {
					projection.dispose();
					return;
				}
				syncHash();
			}).catch(_temp2);
			return () => {
				disposed = true;
				unsubscribe();
				projection.dispose();
			};
		};
		t4 = [
			repo,
			activeWorkspaceId,
			layoutSessionBlock
		];
		$[7] = activeWorkspaceId;
		$[8] = layoutSessionBlock;
		$[9] = repo;
		$[10] = t3;
		$[11] = t4;
	} else {
		t3 = $[10];
		t4 = $[11];
	}
	useEffect(t3, t4);
	const { rolesByWorkspaceId } = useMyWorkspaceRoles();
	let t5;
	if ($[12] !== activeWorkspaceId || $[13] !== rolesByWorkspaceId) {
		t5 = rolesByWorkspaceId.get(activeWorkspaceId);
		$[12] = activeWorkspaceId;
		$[13] = rolesByWorkspaceId;
		$[14] = t5;
	} else t5 = $[14];
	const activeRole = t5;
	let t6;
	let t7;
	if ($[15] !== activeRole || $[16] !== initial.kind || $[17] !== repo) {
		t6 = () => {
			if (initial.kind !== "ready" || !activeRole) return;
			repo.setReadOnly(activeRole === "viewer");
		};
		t7 = [
			initial.kind,
			activeRole,
			repo
		];
		$[15] = activeRole;
		$[16] = initial.kind;
		$[17] = repo;
		$[18] = t6;
		$[19] = t7;
	} else {
		t6 = $[18];
		t7 = $[19];
	}
	useEffect(t6, t7);
	let t8;
	let t9;
	if ($[20] !== initial.kind) {
		t8 = () => {
			if (initial.kind !== "ready") return;
			let inner = 0;
			const outer = requestAnimationFrame(() => {
				inner = requestAnimationFrame(_temp3);
			});
			return () => {
				cancelAnimationFrame(outer);
				cancelAnimationFrame(inner);
			};
		};
		t9 = [initial.kind];
		$[20] = initial.kind;
		$[21] = t8;
		$[22] = t9;
	} else {
		t8 = $[21];
		t9 = $[22];
	}
	useEffect(t8, t9);
	let t10;
	let t11;
	if ($[23] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = () => {
			const onHashChange = () => {
				const nextHash_0 = getCurrentHash();
				setHashSnapshot((current_0) => layoutWorkspaceChanged(current_0.hash, nextHash_0) ? {
					hash: nextHash_0,
					version: current_0.version + 1
				} : current_0);
			};
			window.addEventListener("hashchange", onHashChange);
			window.addEventListener("popstate", onHashChange);
			return () => {
				window.removeEventListener("hashchange", onHashChange);
				window.removeEventListener("popstate", onHashChange);
			};
		};
		t11 = [];
		$[23] = t10;
		$[24] = t11;
	} else {
		t10 = $[23];
		t11 = $[24];
	}
	useEffect(t10, t11);
	let t12;
	if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
		t12 = () => {
			setHashSnapshot(_temp4);
		};
		$[25] = t12;
	} else t12 = $[25];
	const reResolve = t12;
	if (initial.kind === "waiting") {
		let t13;
		if ($[26] !== initial.workspaceId) {
			t13 = /* @__PURE__ */ jsx(WorkspaceSyncWaiting, {
				workspaceId: initial.workspaceId,
				onReady: reResolve
			});
			$[26] = initial.workspaceId;
			$[27] = t13;
		} else t13 = $[27];
		return t13;
	}
	if (initial.kind === "locked") {
		const t13 = initial.workspaceName ?? void 0;
		let t14;
		if ($[28] !== initial.workspaceId || $[29] !== repo) {
			t14 = async () => {
				await repo.drainSyncWorkspace(initial.workspaceId);
				reResolve();
			};
			$[28] = initial.workspaceId;
			$[29] = repo;
			$[30] = t14;
		} else t14 = $[30];
		let t15;
		if ($[31] !== initial.canary || $[32] !== initial.reason || $[33] !== initial.workspaceId || $[34] !== repo.user.id || $[35] !== t13 || $[36] !== t14) {
			t15 = /* @__PURE__ */ jsx(WorkspaceKeyGate, {
				userId: repo.user.id,
				workspaceId: initial.workspaceId,
				workspaceName: t13,
				reason: initial.reason,
				canary: initial.canary,
				onResolved: t14
			});
			$[31] = initial.canary;
			$[32] = initial.reason;
			$[33] = initial.workspaceId;
			$[34] = repo.user.id;
			$[35] = t13;
			$[36] = t14;
			$[37] = t15;
		} else t15 = $[37];
		return t15;
	}
	let t13;
	if ($[38] !== safeMode) {
		t13 = {
			layoutBoundary: true,
			safeMode
		};
		$[38] = safeMode;
		$[39] = t13;
	} else t13 = $[39];
	let t14;
	if ($[40] !== initial.layoutSessionBlock.id) {
		t14 = /* @__PURE__ */ jsx(BlockComponent, { blockId: initial.layoutSessionBlock.id });
		$[40] = initial.layoutSessionBlock.id;
		$[41] = t14;
	} else t14 = $[41];
	let t15;
	if ($[42] !== safeMode || $[43] !== t14) {
		t15 = /* @__PURE__ */ jsx(AppRuntimeProvider, {
			safeMode,
			children: t14
		});
		$[42] = safeMode;
		$[43] = t14;
		$[44] = t15;
	} else t15 = $[44];
	let t16;
	if ($[45] !== t13 || $[46] !== t15) {
		t16 = /* @__PURE__ */ jsx(BlockContextProvider, {
			initialValue: t13,
			children: t15
		});
		$[45] = t13;
		$[46] = t15;
		$[47] = t16;
	} else t16 = $[47];
	return t16;
};
function WorkspaceSyncWaiting(t0) {
	const $ = c(7);
	const { workspaceId, onReady } = t0;
	let t1;
	if ($[0] !== workspaceId) {
		t1 = [workspaceId];
		$[0] = workspaceId;
		$[1] = t1;
	} else t1 = $[1];
	const { data } = useQuery("SELECT id FROM workspaces WHERE id = ? LIMIT 1", t1);
	const present = data.length > 0;
	let t2;
	let t3;
	if ($[2] !== onReady || $[3] !== present) {
		t2 = () => {
			if (present) onReady();
		};
		t3 = [present, onReady];
		$[2] = onReady;
		$[3] = present;
		$[4] = t2;
		$[5] = t3;
	} else {
		t2 = $[4];
		t3 = $[5];
	}
	useEffect(t2, t3);
	let t4;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: "flex min-h-svh items-center justify-center p-6",
			children: /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: "Loading workspace…"
			})
		});
		$[6] = t4;
	} else t4 = $[6];
	return t4;
}
function _temp() {
	return {
		hash: getCurrentHash(),
		version: 0
	};
}
function _temp2(error) {
	console.error("[App] Failed to start panel layout projection", error);
}
function _temp3() {
	return markStartup("firstContentPaint");
}
function _temp4(current_1) {
	return {
		hash: current_1.hash,
		version: current_1.version + 1
	};
}
//#endregion
export { App as default };

//# sourceMappingURL=App.js.map