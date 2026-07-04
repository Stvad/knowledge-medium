import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
import { keyAtEnd } from "../data/orderKey.js";
import { workspaceLandingFacet } from "../extensions/core.js";
import { getLayoutSessionBlock, getUIStateBlock } from "../data/stateBlocks.js";
import { buildLayout, preserveHashQueryParams } from "../utils/routing.js";
import { getLayoutSessionId } from "../utils/layoutSessionId.js";
import { applyCurrentLayoutUrl, createPanelRowInTx } from "../utils/panelLayoutProjection.js";
import { resolveAppRuntimeSync } from "../facets/resolveAppRuntime.js";
import { readOverridesCache } from "../extensions/overridesCache.js";
import { rememberWorkspace } from "../utils/lastWorkspace.js";
import { staticAppExtensions } from "../extensions/staticAppExtensions.js";
//#region src/bootstrap/workspaceBootstrap.ts
var replaceHash = (hash) => {
	if (typeof window === "undefined") return;
	const nextHash = preserveHashQueryParams(hash, window.location.hash);
	if (window.location.hash === nextHash) return;
	window.history.replaceState(null, "", nextHash);
};
var landingRuntimeCache = /* @__PURE__ */ new Map();
var getLandingRuntime = (repo) => {
	const workspaceId = repo.activeWorkspaceId;
	const overrides = workspaceId ? readOverridesCache(workspaceId) : /* @__PURE__ */ new Map();
	const overridesFingerprint = JSON.stringify([...overrides.entries()].sort(([a], [b]) => a.localeCompare(b)));
	const cacheKey = `${repo.instanceId}:${workspaceId ?? ""}:${overridesFingerprint}`;
	const cached = landingRuntimeCache.get(cacheKey);
	if (cached) return cached;
	const runtime = resolveAppRuntimeSync(staticAppExtensions({ repo }), {
		overrides,
		context: {
			repo,
			workspaceId,
			safeMode: false
		}
	});
	landingRuntimeCache.set(cacheKey, runtime);
	return runtime;
};
var resolveLandingBlockId = async (repo, workspaceId, freshlyCreated) => {
	const resolvers = getLandingRuntime(repo).read(workspaceLandingFacet);
	for (let i = resolvers.length - 1; i >= 0; i -= 1) try {
		const id = await resolvers[i]({
			repo,
			workspaceId,
			freshlyCreated
		});
		if (id) return id;
	} catch (error) {
		console.error("[App] workspace landing resolver threw", error);
	}
	return null;
};
/**
* The bootstrap *write* phase (§6 gate already cleared by the caller). Performs
* the workspace-scoped writes — remember-as-default, one-shot backfills, the
* starter tutorial, the Properties/Types/Recents pages, the ui-state block — and
* applies the URL→layout projection (landing on a plugin-resolved block when the
* layout is empty). Returns the layout-session block the app renders.
*
* Testable without rendering: it takes a repo and plain args and returns a Block.
*/
var bootstrapWorkspace = async ({ repo, workspaceId, freshlyCreated, requestedHash, requestedWorkspaceId }) => {
	rememberWorkspace(workspaceId);
	repo.scheduleWorkspaceBackfills(workspaceId);
	repo.scheduleReconcileRescan(workspaceId);
	const resolveLayoutSession = async () => {
		const layoutSessionBlock = await getLayoutSessionBlock(await getUIStateBlock(repo, workspaceId, repo.user, {}), getLayoutSessionId());
		if ((await applyCurrentLayoutUrl({
			repo,
			workspaceId,
			layoutSessionBlock,
			hash: requestedWorkspaceId && requestedWorkspaceId !== workspaceId ? buildLayout(workspaceId) : requestedHash,
			replaceHash
		})).kind === "empty") {
			const landingId = await resolveLandingBlockId(repo, workspaceId, freshlyCreated);
			if (landingId) {
				replaceHash(buildLayout(workspaceId, [landingId]));
				await repo.tx(async (tx) => {
					if (!await tx.get(layoutSessionBlock.id)) throw new Error(`getInitialLayout: layout session block ${layoutSessionBlock.id} not found`);
					await createPanelRowInTx(repo, tx, {
						workspaceId,
						parentId: layoutSessionBlock.id,
						orderKey: keyAtEnd(null),
						blockId: landingId
					});
				}, {
					scope: ChangeScope.UiState,
					description: "bootstrap landing panel"
				});
			}
		}
		return layoutSessionBlock;
	};
	await repo.ensureSystemPages(workspaceId);
	return await resolveLayoutSession();
};
//#endregion
export { bootstrapWorkspace };

//# sourceMappingURL=workspaceBootstrap.js.map