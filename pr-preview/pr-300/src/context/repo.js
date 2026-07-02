import memoize from "../../node_modules/lodash-es/memoize.js";
import { PowerSyncContext } from "../../node_modules/@powersync/react/lib/hooks/PowerSyncContext.js";
import "../../node_modules/@powersync/react/lib/index.js";
import { resolveFacetRuntimeSync } from "../facets/facet.js";
import { Repo } from "../data/repo.js";
import { BlockCache } from "../data/blockCache.js";
import { useIsLocalOnly, useUser } from "../components/Login.js";
import { staticDataExtensions } from "../extensions/staticDataExtensions.js";
import { ensurePowerSyncReady, getPowerSyncDb, syncObserverDepsFor } from "../data/repoProvider.js";
import { surfaceProcessorRejection } from "../extensions/processorRejectionToast.js";
import { markStartup } from "../utils/startupTimeline.js";
import { createContext, use, useContext } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/context/repo.tsx
var initRepo = memoize(async (user, useRemoteSync) => {
	await ensurePowerSyncReady(user.id, useRemoteSync);
	const repo = new Repo({
		db: getPowerSyncDb(user.id),
		cache: new BlockCache(),
		user: {
			id: user.id,
			name: user.name
		},
		syncObserverDeps: syncObserverDepsFor(user.id)
	});
	repo.setFacetRuntime(resolveFacetRuntimeSync(staticDataExtensions, {
		repo,
		workspaceId: null,
		safeMode: false,
		generation: "repo-bootstrap"
	}));
	repo.onUserError((error) => surfaceProcessorRejection(error, repo));
	markStartup("repoReady");
	return repo;
}, (user, useRemoteSync) => `${user.id}:${useRemoteSync ? "remote" : "local"}`);
var RepoContext = createContext(void 0);
function RepoProvider(t0) {
	const $ = c(9);
	const { children } = t0;
	const user = useUser();
	const localOnly = useIsLocalOnly();
	if (!user) throw new Error("User must be set before creating Repo");
	const t1 = !localOnly;
	let t2;
	if ($[0] !== t1 || $[1] !== user) {
		t2 = initRepo(user, t1);
		$[0] = t1;
		$[1] = user;
		$[2] = t2;
	} else t2 = $[2];
	const repoInstance = use(t2);
	const t3 = repoInstance.db;
	let t4;
	if ($[3] !== children || $[4] !== t3) {
		t4 = /* @__PURE__ */ jsx(PowerSyncContext, {
			value: t3,
			children
		});
		$[3] = children;
		$[4] = t3;
		$[5] = t4;
	} else t4 = $[5];
	let t5;
	if ($[6] !== repoInstance || $[7] !== t4) {
		t5 = /* @__PURE__ */ jsx(RepoContext, {
			value: repoInstance,
			children: t4
		});
		$[6] = repoInstance;
		$[7] = t4;
		$[8] = t5;
	} else t5 = $[8];
	return t5;
}
function useRepo() {
	const context = useContext(RepoContext);
	if (context === void 0) throw new Error("useRepo must be used within a RepoContext");
	return context;
}
//#endregion
export { RepoProvider, useRepo };

//# sourceMappingURL=repo.js.map