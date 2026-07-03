import { supabase } from "../../services/supabase.js";
import { getActiveSyncResolver, getActiveUserId, isRemoteSyncActive } from "../../data/repoProvider.js";
import { BlobPutError, createSupabaseBlobStore } from "./blobStore.js";
import { getByteStore } from "./byteStore.js";
import { createAssetResolver } from "./resolver.js";
//#region src/plugins/attachments/assetResolver.ts
/**
* The app-wired in-thread asset resolver singleton (design §7.3).
*
* Wires the pure {@link createAssetResolver} to the real app deps:
*   - byteStore  — the OPFS byte store (§8), one per origin.
*   - blobStore  — Supabase Storage, authed by the app's own session.
*   - sync deps  — the ACTIVE user's §6 resolver (materializability / WK / K_id),
*                  re-read per call so an account switch is reflected without
*                  rebuilding the singleton.
*   - getUserId  — the active account, the byte store's isolation scope (§7).
*
* Built once, lazily. When Supabase isn't configured (a local-only / unauthed
* build) there's no REMOTE object store — but a locally-captured paste still wrote
* its plaintext to the OPFS byte store, so we still build the NORMAL resolver, just
* with a blob store whose remote `get` always misses ({@link NO_REMOTE_BLOB_STORE}).
* The resolver checks the local byte store first (§7.3), so a local-only paste
* renders from disk; only a genuine remote miss fails closed (placeholder).
*/
var singleton = null;
/** A blob store for a build with no remote object store (local-only / unauthed):
*  `get` always misses, so the resolver serves LOCAL byte-store hits and fails
*  closed (`fetch-failed`) only on a true miss. `put`/`delete` are never reached
*  via the resolver (the up-lane has its own blob store) but are total for safety. */
var NO_REMOTE_BLOB_STORE = {
	put: async () => {
		throw new BlobPutError("no remote object store configured", false, void 0, "no_remote");
	},
	get: async () => {
		throw new Error("no remote object store configured");
	},
	probe: async () => {
		throw new Error("no remote object store configured");
	},
	delete: async () => {}
};
/** Wrap the remote blob store so it's consulted ONLY while the active session has
*  remote sync on; in local-only mode it behaves as {@link NO_REMOTE_BLOB_STORE} (a
*  remote miss), so the resolver still serves local OPFS hits but never makes a
*  Supabase request — the read-side half of the "no remote requests in local-only"
*  contract (Codex P1). Checked PER CALL, so a re-login mode switch is respected
*  without rebuilding the singleton. Shared with the up-lane (assetUpload's
*  getBlobStore) so the WRITE side gets the same per-call gate: an arm-time-only
*  check can go stale if remote sync is toggled off while a drain lock is held. */
var remoteSyncGated = (remote) => ({
	put: (ws, key, bytes) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).put(ws, key, bytes),
	get: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).get(ws, key),
	probe: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).probe(ws, key),
	delete: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).delete(ws, key)
});
var getAssetResolver = () => {
	if (singleton) return singleton;
	let blobStore;
	if (supabase) {
		const client = supabase;
		blobStore = remoteSyncGated(createSupabaseBlobStore({
			client,
			getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null
		}));
	} else blobStore = NO_REMOTE_BLOB_STORE;
	singleton = createAssetResolver({
		getUserId: getActiveUserId,
		byteStore: getByteStore(),
		blobStore,
		getMaterializability: (ws) => getActiveSyncResolver()?.getMaterializability(ws) ?? "defer",
		getCek: (ws) => getActiveSyncResolver()?.getCek(ws) ?? Promise.resolve(null),
		getContentKeyHmac: (ws) => getActiveSyncResolver()?.getContentKeyHmac(ws) ?? Promise.resolve(null)
	});
	return singleton;
};
//#endregion
export { NO_REMOTE_BLOB_STORE, getAssetResolver, remoteSyncGated };

//# sourceMappingURL=assetResolver.js.map