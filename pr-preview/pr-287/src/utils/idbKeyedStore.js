//#region src/utils/idbKeyedStore.ts
/**
* Shared scaffolding for the app's keyed, single-object-store IndexedDB stores.
*
* Several stores follow the same shape: one named DB holding one object store,
* values addressed by a string key, with a cached connection and commit-durable
* writes. Each used to hand-roll the same glue — `promisifyRequest`, a cached
* `openDb` that clears its handle on a rejected open, and a `tx` that resolves
* on the transaction's `oncomplete` (durability) rather than the request's
* `onsuccess`. Every IndexedDB-durability fix then had to be applied in each
* copy or they silently diverged. This module is the single copy. Consumers:
*   - `src/extensions/compiledModuleCache.ts` (approved/compiled extensions)
*   - `src/sync/keys/keyStore.ts` (per-device workspace keys — browser-only path)
*   - `src/plugins/attachments/uploadStore.ts` (the byte-upload staging queue)
*
* Records are stored under an opaque string key; {@link idbRecordId} builds a
* collision-free `(owner, id)` composite for the stores that namespace records
* per account, and {@link IdbKeyedStore.scanByPrefix}/{@link IdbKeyedStore.deleteByPrefix}
* walk one such namespace.
*
* TRANSACTION ACTIVENESS (load-bearing): an IndexedDB transaction is only
* "active" within the task that created it and its request callbacks — it
* auto-commits once control returns to the event loop with no outstanding
* request. The public ops ({@link IdbKeyedStore.tx}, {@link IdbKeyedStore.runTransaction},
* {@link IdbKeyedStore.scanByPrefix}) all invoke their request-issuing callback
* synchronously in the same task that created the transaction: every `await`
* between creating the tx and issuing its first request resolves via a microtask
* within that same task (the awaited promises are either already-settled or settle
* on the IDB open event), so the tx is still active. The callback a caller passes
* MUST likewise issue its first request synchronously, before any `await` that
* yields to a later task.
*/
/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
var promisifyRequest = (request) => new Promise((resolve, reject) => {
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});
/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
*  A readwrite write is only durable once the tx commits — `onsuccess` fires
*  earlier, while the tx is still open — so a caller that navigates/reloads
*  right after a write can have an un-committed tx rolled back. Handlers are
*  registered synchronously by the caller (before any await) so an `oncomplete`
*  that fires before we start awaiting can't be missed. */
var txCommitted = (transaction) => new Promise((resolve, reject) => {
	transaction.oncomplete = () => resolve();
	transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
	transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
});
/** Record-id prefix for all of an owner's records. The trailing `:` plus
*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
/** Composite record id. Each segment is encoded so a delimiter inside an id
*  can't make two distinct `(owner, id)` pairs collide. */
var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
/**
* A cached connection to one named DB + one object store, with commit-durable
* transactions. Each instance owns its own connection handle, so constructing a
* fresh instance against the same DB models a page reload (a new tab/handle
* reopening persisted data) — which is exactly how the consumers' tests verify
* durability.
*/
var IdbKeyedStore = class {
	dbPromise = null;
	constructor(dbName, storeName, version = 1) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
	}
	openDb() {
		if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.version);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}).catch((err) => {
			this.dbPromise = null;
			throw err;
		});
		return this.dbPromise;
	}
	/**
	* Open a transaction and return its object store plus a commit fence. PRIVATE
	* and footgun-laden by design — the caller must issue its first request
	* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
	* on an error path) or a tx abort surfaces as an unhandled rejection. The public
	* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
	* that contract so callers never have to.
	*/
	async openTransaction(mode) {
		const transaction = (await this.openDb()).transaction(this.storeName, mode);
		const committed = txCommitted(transaction);
		return {
			store: transaction.objectStore(this.storeName),
			committed
		};
	}
	/**
	* Run `body` against the store within one transaction and resolve on the
	* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
	* issue its first request synchronously — it is invoked in the same task that
	* created the tx (see the file header on activeness). If `body` rejects (or the
	* commit fence does), the fence's rejection is observed here so it can't surface
	* as an unhandled rejection, and the original error propagates. Use for cursor
	* scans / read-modify-write; single-request ops use {@link tx}.
	*/
	async runTransaction(mode, body) {
		const { store, committed } = await this.openTransaction(mode);
		try {
			const result = await body(store);
			await committed;
			return result;
		} catch (err) {
			committed.catch(() => {});
			throw err;
		}
	}
	/**
	* Run a single request against the store, resolving on the transaction COMMIT
	* (durability). The common case; multi-request / cursor work uses
	* {@link runTransaction}.
	*/
	async tx(mode, run) {
		return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
	}
	/**
	* Walk every record whose key starts with `prefix` (the per-owner namespace
	* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
	* commit-durable transaction. A plain `startsWith` over the (small) store avoids
	* IDBKeyRange string-bound subtleties; the `:`-delimited prefix is collision-free
	* across owners, so a scan never reaches a sibling owner. `visit` is synchronous
	* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
	* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
	* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
	* readwrite scan's partial writes) and rejects with that error.
	*/
	async scanByPrefix(mode, prefix, visit) {
		await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
			const request = store.openCursor();
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) {
					resolve();
					return;
				}
				try {
					if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
					cursor.continue();
				} catch (err) {
					try {
						store.transaction.abort();
					} catch {}
					reject(err);
				}
			};
			request.onerror = () => reject(request.error);
		}));
	}
	/**
	* Delete every record whose key starts with `prefix`, in one commit-durable
	* readwrite transaction. Sugar over {@link scanByPrefix}.
	*/
	async deleteByPrefix(prefix) {
		await this.scanByPrefix("readwrite", prefix, (cursor) => cursor.delete());
	}
};
//#endregion
export { IdbKeyedStore, idbKeyPrefix, idbRecordId, promisifyRequest };

//# sourceMappingURL=idbKeyedStore.js.map