import { IdbKeyedStore, idbKeyPrefix, idbRecordId, promisifyRequest } from "../../utils/idbKeyedStore.js";
//#region src/plugins/attachments/uploadStore.ts
/**
* Durable byte-upload staging store (design §9/§11 — the up-lane's queue).
*
* Bytes ride a parallel lane to Supabase Storage (NOT PowerSync), so they need
* their OWN durable queue — `ps_crud` carries block metadata only. This store is
* that queue: one record per un-uploaded asset, surviving reload, that the
* up-lane drains.
*
* Lifecycle (one persisted `status` field):
*   staged  — written BEFORE the block tx, NOT drainable. Closes the orphan-upload
*             window: if the tx never commits (crash), the boot reconciler reaps a
*             `staged` record whose block is absent past the settled checkpoint, so
*             we never upload bytes for a block that doesn't exist.
*   pending — flipped from `staged` AFTER the tx commits (`promote`). Drainable.
*   failed  — a permanent upload rejection, or retries exhausted (§9 recovery can
*             requeue it). A confirmed upload DELETES the record (no terminal
*             "cleared" value is retained).
*
* Keyed by `(user_id, asset_block_id)` — `user_id` is load-bearing: the OPFS byte
* store and this queue are shared across the browser profile's accounts but drain
* per-user under the active session, so every op is namespaced by the user.
*
* The production backing is IndexedDB (commit-durable — the cached connection +
* commit fence come from the shared {@link IdbKeyedStore}); tests and the
* no-IndexedDB fallback use {@link InMemoryByteUploadStore}. Records are plain
* JSON, so unlike the keyStore the IndexedDB implementation IS exercisable under
* Node (fake-indexeddb).
*/
/** Record-id prefix for all of a user's records — the shared collision-free
*  `encodeURIComponent`-delimited prefix ({@link idbKeyPrefix}). */
var uploadUserPrefix = (userId) => idbKeyPrefix(userId);
/** Composite record id; encoded so a delimiter inside an id can't make two
*  distinct (user, asset) pairs collide ({@link idbRecordId}). */
var uploadRecordId = (userId, assetBlockId) => idbRecordId(userId, assetBlockId);
var stagedRecord = (input, stagedAt) => ({
	...input,
	status: "staged",
	attempts: 0,
	stagedAt
});
/** Optimistic-concurrency guard for the drain's terminal/attempt writes. The drain
*  reads a `pending` snapshot, then does a SLOW upload before deciding to fail/retry
*  it — but capture is lock-free, so a re-paste of the same content can re-arm that
*  record (`stage` bumps `stagedAt`) during the upload. A re-arm supersedes the
*  drain's stale decision; `markFailed`/`recordAttempt` pass the snapshot's
*  `stagedAt` and skip the write when the live stamp has moved. */
var supersededByReArm = (r, expectedStagedAt) => expectedStagedAt !== void 0 && r.stagedAt !== expectedStagedAt;
/** Wrap a wall clock so successive reads STRICTLY increase, even within one
*  millisecond. The `stagedAt` CAS ({@link supersededByReArm}) keys on stamp
*  inequality, so two re-arms of the same record that land in the same `Date.now()`
*  ms must still get distinct stamps — otherwise a stale drain's `markFailed` would
*  match (`expectedStagedAt === r.stagedAt`) the live re-paste and bury it in
*  `failed`, which nothing re-drains. Each store instance owns one counter (one per
*  page in production), so same-page re-arms are collision-free by construction, not
*  by clock luck. `stagedAt` stays a usable epoch ms (the age-based retry bound): it
*  drifts above wall-clock by at most the same-ms collision count, i.e. negligibly. */
var monotonicClock = (now) => {
	let last = 0;
	return () => {
		last = Math.max(now(), last + 1);
		return last;
	};
};
/** In-memory store. Tests + the fallback when IndexedDB is unavailable (the queue
*  then lives only for the page's lifetime — a reload loses un-uploaded intents,
*  the same failure class IndexedDB eviction already allows, recovered by re-paste). */
var InMemoryByteUploadStore = class {
	records = /* @__PURE__ */ new Map();
	clock;
	constructor(now = () => Date.now()) {
		this.clock = monotonicClock(now);
	}
	async stage(input) {
		this.records.set(uploadRecordId(input.userId, input.assetBlockId), stagedRecord(input, this.clock()));
	}
	async get(userId, assetBlockId) {
		return this.records.get(uploadRecordId(userId, assetBlockId)) ?? null;
	}
	async listByStatus(userId, status) {
		const prefix = uploadUserPrefix(userId);
		return [...this.records.entries()].filter(([id, r]) => id.startsWith(prefix) && r.status === status).map(([, r]) => r);
	}
	async countByStatus(userId, status) {
		const prefix = uploadUserPrefix(userId);
		let count = 0;
		for (const [id, r] of this.records) if (id.startsWith(prefix) && r.status === status) count += 1;
		return count;
	}
	mutate(userId, assetBlockId, fn) {
		const id = uploadRecordId(userId, assetBlockId);
		const existing = this.records.get(id);
		if (existing) this.records.set(id, fn(existing));
	}
	async promote(userId, assetBlockId) {
		this.mutate(userId, assetBlockId, (r) => ({
			...r,
			status: "pending"
		}));
	}
	async recordAttempt(userId, assetBlockId, expectedStagedAt) {
		this.mutate(userId, assetBlockId, (r) => supersededByReArm(r, expectedStagedAt) ? r : {
			...r,
			attempts: r.attempts + 1
		});
	}
	async markFailed(userId, assetBlockId, expectedStagedAt) {
		this.mutate(userId, assetBlockId, (r) => supersededByReArm(r, expectedStagedAt) ? r : {
			...r,
			status: "failed"
		});
	}
	async delete(userId, assetBlockId) {
		this.records.delete(uploadRecordId(userId, assetBlockId));
	}
	async clearForUser(userId) {
		const prefix = uploadUserPrefix(userId);
		for (const id of [...this.records.keys()]) if (id.startsWith(prefix)) this.records.delete(id);
	}
};
var UPLOAD_STORE_DB_NAME = "km-byte-uploads";
var STORE_NAME = "uploads";
/** IndexedDB-backed store. Writes resolve on the TRANSACTION commit (`oncomplete`),
*  not the request's `onsuccess`, so a capture's `stage` is genuinely durable
*  before we proceed to the block tx (the whole point of staging-before-commit) —
*  the cached connection + commit fence come from the shared {@link IdbKeyedStore}. */
var IndexedDbByteUploadStore = class {
	idb = new IdbKeyedStore(UPLOAD_STORE_DB_NAME, STORE_NAME);
	clock;
	constructor(now = () => Date.now()) {
		this.clock = monotonicClock(now);
	}
	async stage(input) {
		const record = stagedRecord(input, this.clock());
		await this.idb.tx("readwrite", (store) => store.put(record, uploadRecordId(input.userId, input.assetBlockId)));
	}
	async get(userId, assetBlockId) {
		return await this.idb.tx("readonly", (store) => store.get(uploadRecordId(userId, assetBlockId))) ?? null;
	}
	async listByStatus(userId, status) {
		const out = [];
		await this.idb.scanByPrefix("readonly", uploadUserPrefix(userId), (cursor) => {
			const record = cursor.value;
			if (record.status === status) out.push(record);
		});
		return out;
	}
	async countByStatus(userId, status) {
		let n = 0;
		await this.idb.scanByPrefix("readonly", uploadUserPrefix(userId), (cursor) => {
			if (cursor.value.status === status) n += 1;
		});
		return n;
	}
	/** Read-modify-write a single record inside one readwrite tx. A missing record
	*  is a no-op (a reaped/never-staged id mustn't crash the post-commit flip). */
	async mutate(userId, assetBlockId, fn) {
		const id = uploadRecordId(userId, assetBlockId);
		await this.idb.runTransaction("readwrite", async (store) => {
			const existing = await promisifyRequest(store.get(id));
			if (existing) await promisifyRequest(store.put(fn(existing), id));
		});
	}
	async promote(userId, assetBlockId) {
		await this.mutate(userId, assetBlockId, (r) => ({
			...r,
			status: "pending"
		}));
	}
	async recordAttempt(userId, assetBlockId, expectedStagedAt) {
		await this.mutate(userId, assetBlockId, (r) => supersededByReArm(r, expectedStagedAt) ? r : {
			...r,
			attempts: r.attempts + 1
		});
	}
	async markFailed(userId, assetBlockId, expectedStagedAt) {
		await this.mutate(userId, assetBlockId, (r) => supersededByReArm(r, expectedStagedAt) ? r : {
			...r,
			status: "failed"
		});
	}
	async delete(userId, assetBlockId) {
		await this.idb.tx("readwrite", (store) => store.delete(uploadRecordId(userId, assetBlockId)));
	}
	async clearForUser(userId) {
		await this.idb.deleteByPrefix(uploadUserPrefix(userId));
	}
};
/** Pick the production store when IndexedDB exists, else the in-memory fallback. */
var createByteUploadStore = () => {
	try {
		if (typeof indexedDB !== "undefined") return new IndexedDbByteUploadStore();
	} catch {}
	return new InMemoryByteUploadStore();
};
var sharedStore = null;
var getByteUploadStore = () => sharedStore ??= createByteUploadStore();
//#endregion
export { InMemoryByteUploadStore, IndexedDbByteUploadStore, UPLOAD_STORE_DB_NAME, createByteUploadStore, getByteUploadStore, uploadRecordId, uploadUserPrefix };

//# sourceMappingURL=uploadStore.js.map