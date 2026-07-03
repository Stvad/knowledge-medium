import { materializabilityToMode } from "../../sync/transform.js";
import { verifyContentHash } from "../../sync/crypto/contentHash.js";
import { decodeBytes } from "../../sync/byteTransform.js";
//#region src/plugins/attachments/uploadRecovery.ts
/**
* The §9 failed-upload recovery actor — the brain behind the user's "Retry" on a
* `failed` up-lane record (design §9/§17).
*
* PRINCIPLE (user): if we saved the file's bytes locally, it's on us to get them
* uploaded — a failed upload must not require a manual re-paste. The drain
* ({@link import('./uploadDrain.js').drainUploads}) bounds retries by attempt/age then
* quarantines to `failed`, which is inert: nothing re-drains it. This actor un-sticks
* such records WITHOUT re-entering the hot correction loop the `failed` state exists to
* stop.
*
* USER-TRIGGERED, NOT AN AUTOMATIC SWEEP. Recovery only ever touches the QUARANTINED set:
* a TRANSIENT failure (offline / 5xx / token) stays `pending` — the drain keeps it there and
* the reconnect/refocus sweep re-drives it automatically — and only crosses into `failed` if it
* keeps failing past the drain's ~7-day AGE backstop ({@link import('./uploadDrain.js')}
* `deferTransientOrFail`). So `failed` holds mostly the permanent-ish rejects (poisoned path,
* shape-rejected body, 413, not-a-writer) plus that rare aged-out transient, and for those the
* right — and codebase-consistent — UX is to SURFACE them (the §9 diagnostics warning) and let
* the user hit Retry, exactly as block-sync rejections surface via `ps_crud_rejected`. The user
* is the rate limiter, so there is no automatic re-drive bound: this pass runs when they ask, and
* the probe below makes even a "Retry all" safe against poisoned paths (a probe + hash-verify,
* never a blind re-PUT).
*
* WHY A PROBE PASS, NOT A BLIND RE-`pending`: a blind `failed → pending` would make the
* drain re-UPLOAD the full sealed bytes even when the content path is occupied/poisoned
* (`put` → 409 → verify → back to `failed`) — the exact wasted full PUT per Retry §9's probe
* exists to avoid. Instead we do ONE direct RLS GET of the content path
* ({@link BlobStore.probe}) — a 404 when the path is free (no body); the object's bytes when
* it's occupied (which we have to read anyway to hash-verify) — and branch (§9/§17):
*   - ABSENT (404, path free)     → `requeue` failed→pending; the existing drain uploads
*                                   the local bytes. The ONLY branch that costs a PUT,
*                                   and it reuses the already-bounded drain rather than a
*                                   second upload path.
*   - PRESENT + hash-VERIFIES     → another device already materialized our content →
*                                   `delete` the record; NO re-upload. (Drops the
*                                   durability floor to best-effort like any replicated
*                                   byte — the accepted §9 tradeoff.)
*   - PRESENT + hash-MISMATCHES /
*     undecodable                 → still poisoned (§17) → stay `failed`; never a PUT.
*   - transient GET (offline/5xx/
*     unknown), not-materializable
*     (locked/unpinned/signed-out),
*     or wrong active account      → DEFER (no state change); a later Retry re-probes.
*                                    No attempt burn, no PUT.
*
* WHY THE DOWN-LANE CAN'T DO THIS: the down-lane fetches bytes that are ABSENT locally;
* a `failed` record's bytes are PRESENT locally, so the down-lane never visits it. This
* re-attempt is the up-lane's own (design §9).
*
* PURE: like {@link import('./uploadReconcile.js').reconcileUploads} /
* {@link import('./uploadDrain.js').drainUploads}, this only reads the queue + probes /
* decodes REMOTE bytes and mutates the queue (`requeue` / `delete`). It NEVER touches the
* LOCAL byte store — a `failed` record's local bytes are the only copy + the self-heal
* source and stay put (the eviction-exemption invariant); only an explicit user discard
* releases them (content-refcount-gated, §8/§9/§16). It does NOT run the drain itself; the
* app wiring ({@link import('./assetUpload.js').runUploadRecovery}) drains the requeued
* records after this pass, inside one lane lock.
*/
var recoverOne = async (userId, rec, ctx) => {
	if (!ctx.isActiveUser()) return "deferred";
	const mode = materializabilityToMode(await ctx.getMaterializability(rec.workspaceId));
	if (mode === null) return "deferred";
	let stored;
	try {
		stored = await ctx.blobStore.probe(rec.workspaceId, rec.contentKey);
	} catch {
		return "deferred";
	}
	if (!ctx.isActiveUser()) return "deferred";
	if (stored === null) {
		await ctx.store.requeue(userId, rec.assetBlockId, rec.stagedAt);
		return "requeued";
	}
	let decoded;
	try {
		decoded = await decodeBytes(stored, mode, ctx.getCek, {
			contentHash: rec.contentHash,
			workspaceId: rec.workspaceId
		});
	} catch {
		return "poisoned";
	}
	if (await verifyContentHash(decoded, rec.contentHash)) {
		await ctx.store.delete(userId, rec.assetBlockId);
		return "cleared";
	}
	return "poisoned";
};
/** Probe + 3-way every `failed` record for `userId` (design §9/§17). Sequential — the
*  failed set is small and this runs on an explicit user Retry; the app wiring runs it
*  single-owner (lane lock) and drains the requeued records afterward. */
var recoverFailedUploads = async (userId, deps) => {
	const ctx = {
		store: deps.store,
		blobStore: deps.blobStore,
		getMaterializability: deps.getMaterializability,
		getCek: deps.getCek,
		isActiveUser: deps.isActiveUser ?? (() => true)
	};
	const failed = await deps.store.listByStatus(userId, "failed");
	const counts = {
		requeued: 0,
		cleared: 0,
		poisoned: 0,
		deferred: 0
	};
	for (const rec of failed) counts[await recoverOne(userId, rec, ctx)] += 1;
	return counts;
};
//#endregion
export { recoverFailedUploads };

//# sourceMappingURL=uploadRecovery.js.map