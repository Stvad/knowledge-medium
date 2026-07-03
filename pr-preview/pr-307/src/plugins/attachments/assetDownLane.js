import { getActiveUserId, isRemoteSyncActive } from "../../data/repoProvider.js";
import { getByteStore } from "./byteStore.js";
import { getAssetResolver } from "./assetResolver.js";
import { MEDIA_TYPE, mediaHashProp } from "./mediaBlock.js";
import { reconcileDownLane } from "./downLane.js";
import { runSingleOwner } from "./laneLock.js";
//#region src/plugins/attachments/assetDownLane.ts
/**
* The app-wired down-lane (design §8/§9) — assembles the pure {@link reconcileDownLane}
* with the real app deps and runs it single-owner per (user, workspace) across tabs (so
* two tabs on different workspaces replicate concurrently, not serialized).
*
* One pass walks the ACTIVE workspace's `media` blocks (the §8 "scoped to active /
* opened workspaces" rule — never cold workspaces, the sync-flood lesson) and hands
* the absent ones to the resolver's backlog lane. The resolver is the active user's
* singleton, so materializability / keys / the byte-store scope all resolve against
* whoever is signed in — the down-lane only READS + caches locally, so unlike the
* up-lane it needs no per-user session binding (a mid-switch pass just fails closed
* for the wrong user and the re-arm picks up the new workspace).
*
* Durable storage (§8 "so the byte store isn't best-effort evicted") is NOT requested
* here: `navigator.storage.persist()` is origin-wide and already requested once at boot
* via {@link import('@/requestPersistentStorage.js')} (which carries the don't-nag
* cooldown + permission-denied guards), so the OPFS byte store is already covered.
*/
/** Slow periodic re-walk (§9): catches a block whose origin uploaded its bytes LATE
*  (the "synced block can outlive its bytes" backstop self-heals on the next pass) and
*  chews through the budget tail. Slow — a steady-state pass is all cheap has() probes,
*  but there's no point hammering it. */
var DOWN_LANE_SWEEP_INTERVAL_MS = 600 * 1e3;
/** The down-lane lock is scoped per (user, WORKSPACE), not per user: a pass replicates
*  ONE workspace's bytes, so two tabs on DIFFERENT workspaces do disjoint work and must
*  run concurrently — a per-user lock would skip whichever tab lost the race, starving
*  its workspace until the next sweep/reconnect. Same (user, workspace) in two tabs IS
*  duplicate work and still dedups (one owner; the other skips). */
var downLaneLockName = (userId, workspaceId) => `km-asset-down-lane:${userId}:${workspaceId}`;
/** The active workspace's media blocks → distinct replication requests. Skips a block
*  with no hash yet (the empty `media:hash` default — capture hasn't populated it, or a
*  malformed row) and DEDUPS by content hash: a block copy / import can carry the same
*  hash on several blocks, and replicating that one object once suffices (the down-lane
*  is sequential, so a duplicate would only cost a redundant has() probe anyway). */
var collectReplicationRequests = async (repo, workspaceId) => {
	const rows = await repo.queryBlocks({
		workspaceId,
		types: [MEDIA_TYPE]
	});
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const row of rows) {
		const encoded = row.properties[mediaHashProp.name];
		if (encoded === void 0) continue;
		let contentHash;
		try {
			contentHash = mediaHashProp.codec.decode(encoded);
		} catch {
			continue;
		}
		if (!contentHash || seen.has(contentHash)) continue;
		seen.add(contentHash);
		out.push({
			workspaceId,
			contentHash
		});
	}
	return out;
};
/** Run ONE down-lane pass for `workspaceId`, single-owner per (user, workspace) across
*  tabs. A no-op when: remote sync is off (local-only — nothing to fetch from), signed
*  out, or another tab already owns THIS workspace's lane this tick (`runSingleOwner`
*  skips rather than queues; a tab on a DIFFERENT workspace runs concurrently). The DB
*  walk runs INSIDE the lock, so a non-owner tab does zero work. */
var runDownLaneReconcile = async (repo, workspaceId) => {
	if (!isRemoteSyncActive()) return;
	const userId = getActiveUserId();
	if (!userId) return;
	await runSingleOwner(downLaneLockName(userId, workspaceId), async () => {
		const requests = await collectReplicationRequests(repo, workspaceId);
		if (requests.length === 0) return;
		let present;
		try {
			present = await getByteStore().listWorkspaceKeys(userId, workspaceId);
		} catch (err) {
			console.warn(`[media] down-lane presence scan failed for ${workspaceId}; probing per-block`, err);
		}
		await reconcileDownLane(requests, {
			resolver: getAssetResolver(),
			present
		});
	});
};
//#endregion
export { DOWN_LANE_SWEEP_INTERVAL_MS, collectReplicationRequests, runDownLaneReconcile };

//# sourceMappingURL=assetDownLane.js.map