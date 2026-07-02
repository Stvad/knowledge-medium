import { materializabilityToMode } from "../../sync/transform.js";
import { verifyContentHash } from "../../sync/crypto/contentHash.js";
import { deriveContentKey } from "../../sync/crypto/contentKey.js";
import { decodeBytes } from "../../sync/byteTransform.js";
//#region src/plugins/attachments/resolver.ts
/**
* The in-thread asset resolver (design §7.3) — the single place that turns a
* media block's `(workspaceId, contentHash)` into displayable plaintext bytes,
* or a fail-closed verdict.
*
* Flow on a local miss (§7.3 / §8 / §10):
*   materializability → derive content-key → fetch ciphertext → decode
*   (decrypt with the WK / passthrough plaintext) → HASH-VERIFY → store → bytes
*
* THE HASH VERIFY IS THE LOAD-BEARING CONTROL. After the §10.1 reversal (no
* server-side write guard), this read-side check against the block's synced
* `hash` is the SOLE byte-confidentiality / integrity gate: the untrusted server
* (e2ee §2) may return arbitrary or stale bytes for a content path, and the AAD
* tag alone can't catch a poisoner who knows the content hash and seals junk
* under the right AAD. So anything that isn't the genuine plaintext — a fetch
* failure, an AEAD-open failure, OR a hash mismatch — is discarded, NEVER stored
* and NEVER served; the caller renders the broken-asset placeholder. This is the
* hard Phase-3 acceptance gate (§17), not an optimization.
*
* Three-valued, never two-valued (§5.1 / §7.3 / e2ee §6 rule 2): the decode
* decision is driven by `getMaterializability` — decrypt (e2ee + WK) / copy
* (plaintext-pinned) / defer (e2ee without WK, unpinned, or signed out). `defer`
* fails CLOSED (no fetch, no passthrough) — never `getMode`'s two-valued
* downgrade, which would serve attacker plaintext for an evicted-pin workspace.
*
* Returns verified BYTES, not an object URL: the renderer (Phase 4) wraps them
* as `Blob([bytes], { type: mime })` → `createObjectURL` (mime is block
* metadata) and owns the revoke-on-unmount lifecycle. Keeping the resolver at
* bytes makes the security-critical core fully unit-testable without the DOM.
*/
/** The fail-closed reasons that arise BEFORE any network fetch (the `prepare` stage:
*  signed-out, locked, missing K_id, malformed hash) — as opposed to the fetch-stage
*  reasons (`fetch-failed` / `decode-failed` / `hash-mismatch`, and `error`) that can
*  only arise after hitting the network. The down-lane uses this split purely for its
*  summary tally: pre-fetch failures are reported `unavailable` (no point retrying
*  without a key / unlock), fetch-stage ones `failed` (transient, retried next pass).
*  Neither consumes the down-lane budget — only a successful download does (see
*  downLane.ts), so a stable-ordered failing prefix never starves the healthy tail. */
var PRE_FETCH_FAIL_REASONS = new Set([
	"deferred",
	"no-content-key",
	"invalid-hash"
]);
/** The shared fail-closed verdict. Typed as just the failure shape (not the whole
*  `AssetResolveResult` union) so it's assignable to every result type that carries it
*  — `AssetResolveResult`, the internal `ResolveOutcome`, and `AssetReplicateResult`. */
var fail = (reason) => ({
	ok: false,
	reason
});
var createAssetResolver = (deps) => {
	const { getUserId, byteStore, blobStore, getMaterializability, getCek, getContentKeyHmac } = deps;
	const inFlight = /* @__PURE__ */ new Map();
	/** Steps (1)+(2): signed-in check, three-valued decode decision (§7.3), and the
	*  §10 content-key. Any rejection bubbles to the caller's outer safety net (→
	*  `error`). Shared by both lanes so the backlog `has()` probe and the demand fetch
	*  address the byte store with the same key. */
	const prepare = async ({ workspaceId, contentHash }) => {
		const userId = getUserId();
		if (!userId) return {
			ok: false,
			reason: "deferred"
		};
		const materializability = await getMaterializability(workspaceId);
		const mode = materializabilityToMode(materializability);
		if (mode === null) {
			if (materializability === "defer") return {
				ok: false,
				reason: "deferred"
			};
			console.warn(`[assetResolver] unexpected materializability "${materializability}" for ${workspaceId}; failing closed`);
			return {
				ok: false,
				reason: "error"
			};
		}
		const contentKeyHmac = mode === "e2ee" ? await getContentKeyHmac(workspaceId) : null;
		if (mode === "e2ee" && !contentKeyHmac) return {
			ok: false,
			reason: "no-content-key"
		};
		try {
			return {
				ok: true,
				userId,
				mode,
				contentKey: await deriveContentKey({
					contentHash,
					mode,
					contentKeyHmac
				})
			};
		} catch {
			return {
				ok: false,
				reason: "invalid-hash"
			};
		}
	};
	const resolveImpl = async ({ workspaceId, contentHash }) => {
		try {
			const prep = await prepare({
				workspaceId,
				contentHash
			});
			if (!prep.ok) return fail(prep.reason);
			const { userId, mode, contentKey } = prep;
			let local = null;
			try {
				local = await byteStore.get(userId, workspaceId, contentKey);
			} catch (err) {
				console.warn(`[assetResolver] local byte-store read failed for ${workspaceId}; re-fetching`, err);
			}
			if (local) return {
				ok: true,
				bytes: local,
				source: "local"
			};
			let blob;
			try {
				blob = await blobStore.get(workspaceId, contentKey);
			} catch {
				return fail("fetch-failed");
			}
			let plaintext;
			try {
				plaintext = await decodeBytes(blob, mode, getCek, {
					contentHash,
					workspaceId
				});
			} catch {
				return fail("decode-failed");
			}
			if (!await verifyContentHash(plaintext, contentHash)) return fail("hash-mismatch");
			let stored = false;
			try {
				await byteStore.put(userId, workspaceId, contentKey, plaintext);
				stored = true;
			} catch (err) {
				console.warn(`[assetResolver] byte-store write failed for ${workspaceId}; serving uncached`, err);
			}
			return {
				ok: true,
				bytes: plaintext,
				source: stored ? "downloaded" : "unstored"
			};
		} catch (err) {
			console.warn(`[assetResolver] unexpected error resolving ${workspaceId}; failing closed`, err);
			return fail("error");
		}
	};
	const coalescedResolve = (request) => {
		const key = `${getUserId() ?? ""}\n${request.workspaceId}\n${request.contentHash}`;
		const existing = inFlight.get(key);
		if (existing) return existing;
		const pending = resolveImpl(request).finally(() => inFlight.delete(key));
		inFlight.set(key, pending);
		return pending;
	};
	const resolve = async (request) => {
		const r = await coalescedResolve(request);
		return r.ok ? {
			ok: true,
			bytes: r.bytes
		} : r;
	};
	const replicate = async (request, present) => {
		try {
			const prep = await prepare(request);
			if (!prep.ok) return {
				ok: false,
				reason: prep.reason
			};
			let isPresent = false;
			if (present) isPresent = present.has(prep.contentKey);
			else try {
				isPresent = await byteStore.has(prep.userId, request.workspaceId, prep.contentKey);
			} catch (err) {
				console.warn(`[assetResolver] has() probe failed for ${request.workspaceId}; fetching`, err);
			}
			if (isPresent) return {
				ok: true,
				status: "present"
			};
			const r = await coalescedResolve(request);
			if (!r.ok) return {
				ok: false,
				reason: r.reason
			};
			if (r.source === "unstored") return {
				ok: false,
				reason: "store-failed"
			};
			return {
				ok: true,
				status: r.source === "local" ? "present" : "replicated"
			};
		} catch (err) {
			console.warn(`[assetResolver] unexpected error replicating ${request.workspaceId}; failing closed`, err);
			return {
				ok: false,
				reason: "error"
			};
		}
	};
	return {
		resolve,
		replicate
	};
};
//#endregion
export { PRE_FETCH_FAIL_REASONS, createAssetResolver };

//# sourceMappingURL=resolver.js.map