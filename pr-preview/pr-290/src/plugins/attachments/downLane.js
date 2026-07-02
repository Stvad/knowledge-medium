import { PRE_FETCH_FAIL_REASONS } from "./resolver.js";
//#region src/plugins/attachments/downLane.ts
/**
* The down-lane reconciler (design §8/§9) — the background half of the byte-
* replication subsystem. Where the up-lane drains local bytes the server lacks,
* the down-lane reconciles the mirror: for each `media` block in an active
* workspace whose bytes are ABSENT locally, fetch → decrypt → hash-verify → store,
* so the workspace's images are available offline (§8 "every asset on disk").
*
* This is the PURE core (mirrors {@link drainUploads}). The caller (assetDownLane)
* walks the local DB to produce the work-list and runs this single-owner under a
* Web Lock; here we just iterate, leaning on the resolver's `replicate` for the
* actual per-asset work + the shared coalescing fetch primitive (§8).
*
* THREE politeness controls, all here:
*   - SEQUENTIAL — the "drip". One asset at a time, deliberately slow enough never
*     to saturate the link or starve a demand fetch (the user-is-looking-at-it lane,
*     which is `resolve`, not throttled and coalesces with us). The lowest possible
*     concurrency; matches the up-lane drain.
*   - A SUCCESS BUDGET — at most `budget` successful DOWNLOADS per pass, beyond which
*     the long tail stays lazy (re-fetched on demand or the next pass) rather than
*     blowing the origin quota / egress in one sweep (§8 "budget-capped"). Only a
*     successful download consumes it: an already-present block is FREE (a cheap has()
*     probe, no egress) AND a FAILURE is free and never halts the walk. Charging
*     failures would let a stable-ordered failing PREFIX (offline / never-uploaded /
*     poisoned OLDER blocks) shadow every healthier asset behind it on every sweep, so
*     they'd never background-replicate. Re-attempting absent blocks each pass is the
*     §9 backstop self-heal — sequential + idle, bounded by the absent count, costing
*     a cheap GET (request overhead) not byte egress.
*   - FORWARD PROGRESS — because only successful downloads consume the budget and a
*     replicated block is present (free) on the next pass, successive passes chew
*     through the absent tail `budget` at a time, walking PAST any failing head rather
*     than re-spending the budget on it.
*
* SCOPE is the caller's job: it walks ONLY active/opened workspaces (the "don't
* touch unopened workspaces" sync-flood lesson — §8). ASSET-SPECIFIC failures don't
* halt the walk: one poisoned / offline block doesn't stop the rest from replicating.
* The one exception is a STORAGE-WIDE write failure (`store-failed` — quota / OPFS):
* since every later put would fail too, it stops the pass rather than re-fetch the tail
* for bytes that can't land. The down-lane keeps NO persisted state — a miss simply
* reappears on the next pass (the §9 "synced block can outlive its bytes" backstop
* self-heals when the origin uploads, or when storage frees).
*/
/** Default per-pass budget of successful DOWNLOADS — bounds eager replication egress
*  while staying large enough that a modest workspace fully replicates in a pass or
*  two. The tail beyond it is lazy-re-fetchable, never lost. */
var DEFAULT_DOWN_LANE_BUDGET = 32;
/** Replicate the absent bytes for `requests` (one active workspace's media blocks),
*  sequential and success-budget-bounded. See the module header for the politeness
*  model — crucially, failures are FREE and never halt the walk. */
var reconcileDownLane = async (requests, deps) => {
	const budget = deps.budget ?? 32;
	let present = 0;
	let replicated = 0;
	let failed = 0;
	let unavailable = 0;
	for (let i = 0; i < requests.length; i++) {
		if (replicated >= budget) return {
			present,
			replicated,
			failed,
			unavailable,
			skipped: requests.length - i
		};
		const r = await deps.resolver.replicate(requests[i], deps.present);
		if (r.ok) {
			if (r.status === "present") {
				present += 1;
				continue;
			}
			replicated += 1;
			continue;
		}
		if (r.reason === "store-failed") return {
			present,
			replicated,
			failed: failed + 1,
			unavailable,
			skipped: requests.length - 1 - i
		};
		if (PRE_FETCH_FAIL_REASONS.has(r.reason)) unavailable += 1;
		else failed += 1;
	}
	return {
		present,
		replicated,
		failed,
		unavailable,
		skipped: 0
	};
};
//#endregion
export { DEFAULT_DOWN_LANE_BUDGET, reconcileDownLane };

//# sourceMappingURL=downLane.js.map