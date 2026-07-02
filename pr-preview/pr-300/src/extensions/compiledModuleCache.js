import { IdbKeyedStore } from "../utils/idbKeyedStore.js";
//#region src/extensions/compiledModuleCache.ts
/**
* Device-local approval store for extension modules (issue #67), which
* doubles as the persistent compile cache (issue #167).
*
* Each row is a *trust grant*: its presence means "on THIS device, the
* user has reviewed this block's source (hash `sourceHash`) and approved
* it to run." A user-extension block executes only if such a row exists,
* and it runs the row's PINNED `compiled` output — never the live
* `block.content` — so a source change synced from elsewhere can't
* silently execute new code (#67). The same pinned output is what lets a
* warm boot rebuild the module without loading Babel (#167): the trust
* record and the compile cache are one and the same row.
*
* Write discipline: rows are written ONLY by an explicit approval
* (`approveExtension` in `compileExtensionModule.ts`), never as a
* side-effect of loading/compiling. That is the line between Phase 1's
* implicit auto-approve (every compile wrote a row) and Phase 2's
* device-local trust gate.
*
* Keyed by `blockId` (globally-unique), so each block occupies exactly
* one row, overwritten on re-approval (an explicit update). `delete`
* revokes a single approval (disable / uninstall / remote-disable);
* `clear` empties the whole store (currently exercised only by tests).
*
* The IndexedDB glue (cached connection, commit-durable `tx`) lives in the
* shared {@link IdbKeyedStore}. Unlike `sync/keys/keyStore.ts` — which holds a
* non-cloneable `CryptoKey` and therefore can't run under Node's
* `structuredClone` — our records are plain JSON, so the IndexedDB path
* is exercised directly in tests via `fake-indexeddb`.
*/
/** In-memory store. Used in tests and as the fallback when IndexedDB is
*  unavailable (private-mode, SSR, etc.) — persistence then degrades to
*  "per page lifetime", which just means the next cold start recompiles
*  via Babel, exactly the pre-#167 behavior. */
var InMemoryCompiledModuleCache = class {
	rows = /* @__PURE__ */ new Map();
	async read(blockId) {
		return this.rows.get(blockId);
	}
	async write(blockId, record) {
		this.rows.set(blockId, record);
	}
	async delete(blockId) {
		this.rows.delete(blockId);
	}
	async clear() {
		this.rows.clear();
	}
};
var DB_NAME = "km-extension-compiled";
var STORE_NAME = "compiled_modules";
/** IndexedDB-backed store. The values are plain JSON, so unlike
*  `keyStore.ts` this path runs fine under `fake-indexeddb` in tests. The
*  cached connection + commit-durable `tx` come from {@link IdbKeyedStore}. */
var IndexedDbCompiledModuleCache = class {
	idb = new IdbKeyedStore(DB_NAME, STORE_NAME);
	async read(blockId) {
		return await this.idb.tx("readonly", (store) => store.get(blockId)) ?? void 0;
	}
	async write(blockId, record) {
		await this.idb.tx("readwrite", (store) => store.put(record, blockId));
	}
	async delete(blockId) {
		await this.idb.tx("readwrite", (store) => store.delete(blockId));
	}
	async clear() {
		await this.idb.tx("readwrite", (store) => store.clear());
	}
};
/** Pick the IndexedDB store when available, else the in-memory fallback. */
var createCompiledModuleCache = () => {
	try {
		if (typeof indexedDB !== "undefined") return new IndexedDbCompiledModuleCache();
	} catch {}
	return new InMemoryCompiledModuleCache();
};
var sharedCache = null;
var getCompiledModuleCache = () => sharedCache ??= createCompiledModuleCache();
//#endregion
export { DB_NAME, InMemoryCompiledModuleCache, IndexedDbCompiledModuleCache, STORE_NAME, createCompiledModuleCache, getCompiledModuleCache };

//# sourceMappingURL=compiledModuleCache.js.map