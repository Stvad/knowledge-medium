import { materializabilityToMode } from "../../sync/transform.js";
import { verifyContentHash } from "../../sync/crypto/contentHash.js";
import { BlobPutError } from "./blobStore.js";
import { decodeBytes, encodeBytes } from "../../sync/byteTransform.js";
//#region src/plugins/attachments/uploadDrain.ts
/**
* The up-lane drain (design §9/§11) — uploads `pending` byte records to Storage.
*
* For each pending record: read the PLAINTEXT bytes from the OPFS byte store,
* encode them AT DRAIN TIME (passthrough for plaintext, AES-GCM seal for e2ee —
* the key is only needed here, not at capture), and upload the result directly to
* `<ws>/<contentKey>` (§10.1, RLS-gated, first-write-wins). A confirmed upload
* DELETES the record; the bytes stay in OPFS as the local render replica.
*
* A 200 write clears the record. A 409 (the content-addressed path was already
* occupied) is NOT taken as success blind: Storage is untrusted + immutable, so the
* existing object may be a stale / buggy / POISONED body, not our content (§17).
* We fetch + decode + hash-verify it first — a match is a genuine cross-device
* dedup and clears the record; a mismatch leaves the record `failed` so the §9/§17
* opportunistic correction (writer-delete + re-upload) can act, rather than
* silently clearing the only entry that could ever fix the path.
*
* Failure handling (the §9/§17 bounded-correction rule):
*   - `defer` materializability (locked / unpinned / signed out) → leave `pending`,
*     no attempt burn; the next sweep retries once the workspace is materializable.
*   - PERMANENT BlobPutError (403/404/413, the advisory hint) → `failed` at once.
*   - TRANSIENT BlobPutError (offline / no-session / 401 / 5xx / network — EVERY
*     non-permanent upload error) → leave `pending`, NO attempt burn; it clears on
*     reconnect / token refresh / server recovery, so only the AGE backstop ever
*     quarantines it. (Crucial: the reconciler re-arms the drain on every
*     `online`/`visible` event, so a flaky-network paste must NOT exhaust the small
*     attempt budget in a few refocuses and land in `failed`, which nothing re-drains.)
*   - an ENCODE error or a local OPFS read THROW (a non-connectivity failure that a
*     refocus can't fix) → bump attempts and retry, bounded by attempt count AND age
*     so a persistent bug can't retry on every refocus forever.
*   - 409 + the existing object hash-MISMATCHES (poisoned path, §17) → `failed`;
*     a transient verify-GET failure → retry (the object exists, just unreadable now).
*   - local bytes missing (OPFS eviction before the upload drained) → `failed`:
*     unrecoverable from the queue; §9 recovery / a re-paste re-stages with bytes.
*
* SINGLE-OWNER: this is a background lane. The caller (Phase 5d) serializes it
* under a `navigator.locks` lock so two tabs never drain concurrently; the upload
* is idempotent (upsert:false, first-write-wins) so even a racing drain is safe.
*
* SCOPE — undo-before-upload: this drain does NOT check whether the asset block is
* still live before uploading. A paste-then-undo can leave a `pending` record
* whose block is soft-deleted; this drain uploads its bytes anyway. That is
* harmless and deliberate — objects are immutable, content-addressed, and
* reference-permanent (§16 GC reclaims an unreferenced object). Adding an inline
* block-presence check here would couple the lane to the DB and reintroduce a
* hydration race (absent-because-unsynced vs absent-because-undone). Orphan
* cleanup is the boot reconciler's (5d) + §16 GC's job, gated on the settled
* checkpoint — not this hot path. (Divergence from design.html's "drain
* block-exists-before-PUT" note; correctness-equivalent given immutable objects.)
*/
/** Default retry bounds. Generous enough to ride out a long offline stretch, but
*  finite so a non-enumerated permanent failure can't retry forever (§9/§17). */
var DEFAULT_MAX_ATTEMPTS = 8;
var DEFAULT_MAX_AGE_MS = 10080 * 60 * 1e3;
/** Bounded-retry decision for a non-permanent failure: bump the attempt unless a
*  bound (attempt count OR age) is reached, in which case quarantine. */
var retryOrFail = async (userId, rec, ctx) => {
	if (rec.attempts + 1 >= ctx.maxAttempts || ctx.now() - rec.stagedAt > ctx.maxAgeMs) {
		await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt);
		return "failed";
	}
	await ctx.store.recordAttempt(userId, rec.assetBlockId, rec.stagedAt);
	return "retried";
};
/** A CLEARLY-transient failure (offline, token absent, Storage 5xx — anything that
*  clears on reconnect / token refresh / server recovery): leave the record PENDING
*  WITHOUT burning the bounded attempt budget. The reconciler re-arms the drain on
*  every `online`/`visible` event, so a flaky-network paste retried a handful of
*  times would otherwise exhaust `maxAttempts` and quarantine a perfectly good upload
*  in seconds — `failed` is terminal (nothing re-drains it). Only the AGE backstop
*  applies here; past it, give up. */
var deferTransientOrFail = async (userId, rec, ctx) => {
	if (ctx.now() - rec.stagedAt > ctx.maxAgeMs) {
		await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt);
		return "failed";
	}
	return "deferred";
};
var drainOne = async (userId, rec, ctx) => {
	if (!ctx.isActiveUser()) return "deferred";
	const mode = materializabilityToMode(await ctx.getMaterializability(rec.workspaceId));
	if (mode === null) return "deferred";
	let plaintext;
	try {
		plaintext = await ctx.byteStore.get(userId, rec.workspaceId, rec.contentKey);
	} catch {
		return retryOrFail(userId, rec, ctx);
	}
	if (!plaintext) {
		await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt);
		return "failed";
	}
	try {
		const sealed = await encodeBytes(plaintext, mode, ctx.getCek, {
			contentHash: rec.contentHash,
			workspaceId: rec.workspaceId
		});
		if (await ctx.blobStore.put(rec.workspaceId, rec.contentKey, sealed) === "exists") return verifyExistingOrQuarantine(userId, rec, mode, ctx);
		await ctx.store.delete(userId, rec.assetBlockId);
		return "uploaded";
	} catch (err) {
		if (err instanceof BlobPutError) {
			if (err.permanent) {
				await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt);
				return "failed";
			}
			return deferTransientOrFail(userId, rec, ctx);
		}
		return retryOrFail(userId, rec, ctx);
	}
};
/** A 409 means the content-addressed path was already occupied — but Storage is
*  untrusted + immutable, so the existing object may be a stale / buggy / poisoned
*  body rather than our content (§17). Fetch + decode + hash-verify it:
*    - matches our hash → genuine cross-device dedup → delete the record (done).
*    - present but mismatches / can't decode → POISONED path → `failed`, so the
*      §9/§17 opportunistic correction (writer-delete + re-upload) can act. We must
*      NOT clear: that strands our good local bytes with no entry to fix the path.
*    - the verify-GET fails transiently → retry (the object exists, just unreadable
*      right now); never clear or quarantine on a transient read. */
var verifyExistingOrQuarantine = async (userId, rec, mode, ctx) => {
	let stored;
	try {
		stored = await ctx.blobStore.get(rec.workspaceId, rec.contentKey);
	} catch {
		return retryOrFail(userId, rec, ctx);
	}
	let decoded;
	try {
		decoded = await decodeBytes(stored, mode, ctx.getCek, {
			contentHash: rec.contentHash,
			workspaceId: rec.workspaceId
		});
	} catch {
		await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt);
		return "failed";
	}
	if (await verifyContentHash(decoded, rec.contentHash)) {
		await ctx.store.delete(userId, rec.assetBlockId);
		return "uploaded";
	}
	await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt);
	return "failed";
};
/** Drain every `pending` byte record for `userId`. Sequential — the queue is
*  small and this avoids hammering Storage; the caller runs it single-owner. */
var drainUploads = async (userId, deps) => {
	const ctx = {
		store: deps.store,
		byteStore: deps.byteStore,
		blobStore: deps.blobStore,
		getMaterializability: deps.getMaterializability,
		getCek: deps.getCek,
		isActiveUser: deps.isActiveUser ?? (() => true),
		now: deps.now ?? (() => Date.now()),
		maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		maxAgeMs: deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS
	};
	const pending = await deps.store.listByStatus(userId, "pending");
	const tally = {
		uploaded: 0,
		failed: 0,
		deferred: 0,
		retried: 0
	};
	for (const rec of pending) tally[await drainOne(userId, rec, ctx)] += 1;
	return tally;
};
//#endregion
export { drainUploads };

//# sourceMappingURL=uploadDrain.js.map