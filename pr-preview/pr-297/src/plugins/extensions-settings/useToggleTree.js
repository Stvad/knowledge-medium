import { useRepo } from "../../context/repo.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { dynamicExtensionsExtension } from "../../extensions/dynamicExtensions.js";
import { useOverrides } from "../../extensions/useOverrides.js";
import { discoverToggleTree } from "../../facets/discoverToggleTree.js";
import { staticAppExtensions } from "../../extensions/staticAppExtensions.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/extensions-settings/useToggleTree.ts
/**
* Walk the full extension tree (static + dynamic) into a
* `ToggleNode[]` for the settings UI.
*
* The hook owns the lifecycle:
*   - rebuilds the tree whenever the `generation` from `useOverrides`
*     bumps (i.e. `refreshAppRuntime` fired — likely the user just
*     toggled something or a new extension block landed)
*   - rebuilds on workspace switch
*   - awaits the dynamicExtensionsExtension function so user-extension
*     shell rows surface in the tree even when disabled (their
*     compile is skipped but the shell handle is still emitted)
*/
var treeViewKey = (workspaceId, safeMode) => `${workspaceId}:${safeMode ? "safe" : "normal"}`;
var lastResolvedTree = null;
var useToggleTree = () => {
	const $ = c(23);
	const repo = useRepo();
	const workspaceId = repo.activeWorkspaceId;
	const { overrides, generation } = useOverrides(workspaceId);
	const safeMode = useAppRuntime().context.safeMode === true;
	let t0;
	if ($[0] !== safeMode || $[1] !== workspaceId) {
		t0 = workspaceId ? treeViewKey(workspaceId, safeMode) : null;
		$[0] = safeMode;
		$[1] = workspaceId;
		$[2] = t0;
	} else t0 = $[2];
	const viewKey = t0;
	const lastTreeForView = lastResolvedTree?.key === viewKey ? lastResolvedTree.tree : void 0;
	let t1;
	if ($[3] !== viewKey) {
		t1 = () => viewKey !== null && lastResolvedTree?.key === viewKey ? lastResolvedTree : null;
		$[3] = viewKey;
		$[4] = t1;
	} else t1 = $[4];
	const [resolved, setResolved] = useState(t1);
	let t2;
	if ($[5] !== repo) {
		t2 = staticAppExtensions({ repo });
		$[5] = repo;
		$[6] = t2;
	} else t2 = $[6];
	const baseExtensions = t2;
	let t3;
	let t4;
	if ($[7] !== baseExtensions || $[8] !== generation || $[9] !== overrides || $[10] !== repo || $[11] !== safeMode || $[12] !== viewKey || $[13] !== workspaceId) {
		t3 = () => {
			if (!workspaceId || !viewKey) return;
			let cancelled = false;
			(async () => {
				const next = await discoverToggleTree([baseExtensions, dynamicExtensionsExtension({
					repo,
					workspaceId,
					safeMode,
					overrides
				})], {
					repo,
					workspaceId,
					safeMode: false,
					generation
				});
				if (!cancelled) {
					const nextResolved = {
						key: viewKey,
						tree: next
					};
					lastResolvedTree = nextResolved;
					setResolved(nextResolved);
				}
			})();
			return () => {
				cancelled = true;
			};
		};
		t4 = [
			baseExtensions,
			repo,
			workspaceId,
			overrides,
			generation,
			safeMode,
			viewKey
		];
		$[7] = baseExtensions;
		$[8] = generation;
		$[9] = overrides;
		$[10] = repo;
		$[11] = safeMode;
		$[12] = viewKey;
		$[13] = workspaceId;
		$[14] = t3;
		$[15] = t4;
	} else {
		t3 = $[14];
		t4 = $[15];
	}
	useEffect(t3, t4);
	const resolvedTreeForView = resolved?.key === viewKey ? resolved.tree : void 0;
	let t5;
	if ($[16] !== lastTreeForView || $[17] !== resolvedTreeForView) {
		t5 = resolvedTreeForView ?? lastTreeForView ?? [];
		$[16] = lastTreeForView;
		$[17] = resolvedTreeForView;
		$[18] = t5;
	} else t5 = $[18];
	const tree = t5;
	const loading = viewKey === null ? false : resolvedTreeForView === void 0 && lastTreeForView === void 0;
	const t6 = workspaceId ?? void 0;
	let t7;
	if ($[19] !== loading || $[20] !== t6 || $[21] !== tree) {
		t7 = {
			tree,
			loading,
			workspaceId: t6
		};
		$[19] = loading;
		$[20] = t6;
		$[21] = tree;
		$[22] = t7;
	} else t7 = $[22];
	return t7;
};
//#endregion
export { useToggleTree };

//# sourceMappingURL=useToggleTree.js.map