import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from "../../utils/scheduleIdle.js";
import { getActiveUserId } from "../../data/repoProvider.js";
import { useRepo } from "../../context/repo.js";
import { useActiveWorkspaceId } from "../../hooks/useWorkspaces.js";
import { DOWN_LANE_SWEEP_INTERVAL_MS, runDownLaneReconcile } from "./assetDownLane.js";
import { armSharedLaneTriggers } from "./laneArming.js";
import { useEffect } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/attachments/MediaDownLaneReplicator.tsx
/**
* App-root mount that drives the down-lane (design §8/§9) — background replication of
* the active workspace's media bytes to the local OPFS store, so its images are
* available offline. Mounted via `appMountsFacet`. Renders nothing.
*
* It:
*   - runs a down-lane pass for the ACTIVE workspace, re-arming when the user SWITCHES
*     workspaces (the effect's `workspaceId` dep) so only opened workspaces replicate
*     (the §8 scope rule);
*   - schedules EVERY pass off the cold-start / navigation hot path (deep idle) and
*     coalesces overlapping triggers: the initial catch-up, the once-initial-sync-SETTLES
*     re-run (so blocks that just arrived get walked), the reconnect retry (`online`), and
*     a slow periodic sweep for the §9 backstop self-heal + the budget tail. Routing the
*     settle re-run through idle is load-bearing: `onFirstSync` fires its callback
*     SYNCHRONOUSLY when the db has already synced (e.g. a workspace switch after initial
*     sync), so a direct pass would scan + fetch during navigation.
*
* The pass itself is single-owner per (user, workspace) across tabs + a no-op in
* local-only / signed-out (see {@link runDownLaneReconcile}); this component is just the
* per-tab arming.
* (Durable origin storage for the byte store, §8, is requested once at boot — origin-
* wide — by `@/requestPersistentStorage.js`, so it isn't this component's concern.)
*/
var MediaDownLaneReplicator = () => {
	const $ = c(4);
	const repo = useRepo();
	const workspaceId = useActiveWorkspaceId();
	let t0;
	let t1;
	if ($[0] !== repo || $[1] !== workspaceId) {
		t0 = () => {
			if (!workspaceId) return;
			let cancelled = false;
			const pass = () => {
				if (cancelled) return;
				runDownLaneReconcile(repo, workspaceId).catch(_temp);
			};
			let scheduled = false;
			const schedulePass = () => {
				if (scheduled) return;
				scheduled = true;
				scheduleDeepIdle(() => {
					scheduled = false;
					pass();
				}, CATCHUP_DEEP_IDLE);
			};
			schedulePass();
			const disposeShared = armSharedLaneTriggers(getActiveUserId(), schedulePass, schedulePass);
			const sweep = setInterval(schedulePass, DOWN_LANE_SWEEP_INTERVAL_MS);
			return () => {
				cancelled = true;
				disposeShared();
				clearInterval(sweep);
			};
		};
		t1 = [repo, workspaceId];
		$[0] = repo;
		$[1] = workspaceId;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	useEffect(t0, t1);
	return null;
};
function _temp(err) {
	return console.warn("[media] down-lane reconcile failed", err);
}
//#endregion
export { MediaDownLaneReplicator };

//# sourceMappingURL=MediaDownLaneReplicator.js.map