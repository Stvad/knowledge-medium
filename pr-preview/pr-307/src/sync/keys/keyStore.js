import { IdbKeyedStore, idbKeyPrefix, idbRecordId } from "../../utils/idbKeyedStore.js";
//#region src/sync/keys/keyStore.ts
/**
* Per-device workspace-key (WK) store (design doc §5).
*
* On a device the WK lives as a NON-EXTRACTABLE `CryptoKey`, keyed by
* `(user_id, workspace_id)`. The production backing is IndexedDB:
* localStorage holds strings only and can store neither a `CryptoKey`
* nor raw key bytes safely, whereas IndexedDB structured-clones the
* non-extractable handle so JS can *use* it (encrypt/decrypt) but never
* read the bytes out. IndexedDB may be evicted under storage pressure —
* acceptable, because the model already requires the user to keep a
* backup of the WK (§5).
*
* The store is an interface so the coordinating layer (§8 flows, §9
* sync seam) depends on a capability, not on IndexedDB. Tests and the
* no-IndexedDB fallback use {@link InMemoryWorkspaceKeyStore}.
*
* NOTE on testing: a `CryptoKey` is structured-cloneable in browsers but
* NOT under Node's `structuredClone`, so the `CryptoKey`-storing path below
* can only be exercised in a real browser. Its keying logic is factored into
* the pure {@link keyStoreRecordId} (unit-tested), and the IndexedDB plumbing
* now lives in the shared {@link IdbKeyedStore} (Node-tested via fake-indexeddb).
* What remains browser-only is this store's wiring of that plumbing to a
* `CryptoKey` value — browser-validated via the §8 flows (unlock → reload →
* still unlocked).
*/
/** Normalize a raw stored value to a {@link WorkspaceKeyRecord}: a new-shape
*  record passes through; a LEGACY bare `CryptoKey` (pre-K_id) becomes
*  `{ wk, contentKeyHmac: null }`; `null`/`undefined` stays `null`. Exported for
*  direct unit testing — the IndexedDB read can't be exercised under Node. */
var normalizeKeyRecord = (stored) => {
	if (stored == null) return null;
	if (typeof stored === "object" && "wk" in stored) return stored;
	return {
		wk: stored,
		contentKeyHmac: null
	};
};
/** IndexedDB record-id prefix for all of a user's keys — the shared
*  collision-free `encodeURIComponent`-delimited prefix ({@link idbKeyPrefix}):
*  `enc("ab"):` is never a prefix of `enc("abc"):…`. */
var keyStoreUserPrefix = (userId) => idbKeyPrefix(userId);
/** Composite record id. Encoded so a delimiter inside an id can't make
*  two distinct (user, workspace) pairs collide ({@link idbRecordId}). */
var keyStoreRecordId = (userId, workspaceId) => idbRecordId(userId, workspaceId);
/** In-memory store. Used in tests and as the fallback when IndexedDB is
*  unavailable (the WK then lives only for the page's lifetime, which the
*  backup-required model tolerates). */
var InMemoryWorkspaceKeyStore = class {
	keys = /* @__PURE__ */ new Map();
	async get(userId, workspaceId) {
		return normalizeKeyRecord(this.keys.get(keyStoreRecordId(userId, workspaceId)));
	}
	async put(userId, workspaceId, record) {
		this.keys.set(keyStoreRecordId(userId, workspaceId), record);
	}
	async delete(userId, workspaceId) {
		this.keys.delete(keyStoreRecordId(userId, workspaceId));
	}
	async clearForUser(userId) {
		const prefix = keyStoreUserPrefix(userId);
		for (const key of [...this.keys.keys()]) if (key.startsWith(prefix)) this.keys.delete(key);
	}
};
var DB_NAME = "km-e2ee-keys";
var STORE_NAME = "workspace_keys";
/** IndexedDB-backed store. Stores a `CryptoKey`-bearing record, so the
*  round-trip can only run in a real browser (see the file header on testing);
*  the cached connection + commit-durable `tx` come from {@link IdbKeyedStore}. */
var IndexedDbWorkspaceKeyStore = class {
	idb = new IdbKeyedStore(DB_NAME, STORE_NAME);
	async get(userId, workspaceId) {
		return normalizeKeyRecord(await this.idb.tx("readonly", (store) => store.get(keyStoreRecordId(userId, workspaceId))));
	}
	async put(userId, workspaceId, record) {
		await this.idb.tx("readwrite", (store) => store.put(record, keyStoreRecordId(userId, workspaceId)));
	}
	async delete(userId, workspaceId) {
		await this.idb.tx("readwrite", (store) => store.delete(keyStoreRecordId(userId, workspaceId)));
	}
	async clearForUser(userId) {
		await this.idb.deleteByPrefix(keyStoreUserPrefix(userId));
	}
};
/** Pick the production store when IndexedDB exists, else the in-memory
*  fallback. */
var createWorkspaceKeyStore = () => {
	try {
		if (typeof indexedDB !== "undefined") return new IndexedDbWorkspaceKeyStore();
	} catch {}
	return new InMemoryWorkspaceKeyStore();
};
var sharedKeyStore = null;
var getWorkspaceKeyStore = () => sharedKeyStore ??= createWorkspaceKeyStore();
//#endregion
export { getWorkspaceKeyStore };

//# sourceMappingURL=keyStore.js.map