//#region src/plugins/attachments/byteStore.ts
/**
* The local DECRYPTED byte store (design §8) — the single on-disk replica + the
* render source for asset bytes.
*
* One store holding PLAINTEXT bytes (raw for a plaintext workspace, decrypted
* with the WK for E2EE), keyed by the content-addressed path
* `assets/<user_id>/<workspace_id>/<content-key>` (§7.3/§8):
*   - `<user_id>` is the account-isolation boundary (§7) — the store is shared
*     across the profile's accounts, so every op is user-scoped.
*   - `<workspace_id>` makes leave/revoke purge only the affected bytes
*     (`purgeWorkspace`, the §8 one-shot claw-back primitive).
*   - `<content-key>` is the §10 object path segment the resolver derives.
*
* Bytes are written ONCE, already verified (the resolver hash-checks before
* `put`, §5.1/§7.3), so the store is a dumb content-addressed blob cache — it
* holds no keys and makes no trust decisions. The backing store is OPFS
* (`OpfsByteStore`); `InMemoryByteStore` is the test double + no-OPFS fallback.
*
* Destruction is the coarse platform clear (§7.2) — this store has no per-store
* wipe role; `purgeWorkspace` is an AUTHORIZATION claw-back (revoke/leave), not
* a destruction hook.
*/
/** Root directory name under the OPFS root for all asset bytes. */
var ASSETS_ROOT = "assets";
var encodeComponent = encodeURIComponent;
var encodeSegment = (s) => {
	const e = encodeComponent(s);
	if (e === "") return "%2Eempty";
	if (e === ".") return "%2Edot";
	if (e === "..") return "%2Edotdot";
	return e;
};
/** Inverse of {@link encodeSegment}: reverse the three sentinels, else
*  `decodeURIComponent`. Maps an OPFS filename back to the content-key it encodes,
*  for enumerating a workspace's stored objects ({@link ByteStore.listWorkspaceKeys}). */
var decodeSegment = (s) => {
	if (s === "%2Eempty") return "";
	if (s === "%2Edot") return ".";
	if (s === "%2Edotdot") return "..";
	return decodeURIComponent(s);
};
/** Path segments under the OPFS root for one object. Each is {@link encodeSegment}-
*  escaped so a `/` (or other reserved char) in an id becomes one inert directory
*  name — it can't introduce extra tree levels or alias two distinct ids — and so a
*  `.`/`..`/empty id (reachable: a local account id is the typed username) is remapped
*  to a collision-free sentinel the File System API accepts, rather than throwing. */
var assetPathSegments = (userId, workspaceId, contentKey) => [
	ASSETS_ROOT,
	encodeSegment(userId),
	encodeSegment(workspaceId),
	encodeSegment(contentKey)
];
var isNotFound = (err) => err instanceof DOMException && err.name === "NotFoundError";
/**
* In-memory store: the test double and the fallback when OPFS is unavailable
* (the bytes then live only for the page's lifetime, which the re-fetchable
* replica model tolerates — §8). Copies on `put`/`get` so a caller mutating its
* buffer can't corrupt the cache, matching OPFS's read-a-fresh-File semantics.
*/
var InMemoryByteStore = class {
	blobs = /* @__PURE__ */ new Map();
	key(userId, workspaceId, contentKey) {
		return assetPathSegments(userId, workspaceId, contentKey).join("/");
	}
	/** The `assets/<user>/<ws>/` key prefix shared by the workspace-wide scans
	*  (`listWorkspaceKeys` enumerate, `purgeWorkspace` reap) — one source of truth so
	*  the two can't drift. The remainder after it is the {@link encodeSegment}-escaped
	*  content-key. */
	wsPrefix(userId, workspaceId) {
		return `${ASSETS_ROOT}/${encodeSegment(userId)}/${encodeSegment(workspaceId)}/`;
	}
	async get(userId, workspaceId, contentKey) {
		const hit = this.blobs.get(this.key(userId, workspaceId, contentKey));
		return hit ? new Uint8Array(hit) : null;
	}
	async put(userId, workspaceId, contentKey, bytes) {
		this.blobs.set(this.key(userId, workspaceId, contentKey), new Uint8Array(bytes));
	}
	async has(userId, workspaceId, contentKey) {
		return this.blobs.has(this.key(userId, workspaceId, contentKey));
	}
	async listWorkspaceKeys(userId, workspaceId) {
		const prefix = this.wsPrefix(userId, workspaceId);
		const out = /* @__PURE__ */ new Set();
		for (const k of this.blobs.keys()) if (k.startsWith(prefix)) out.add(decodeSegment(k.slice(prefix.length)));
		return out;
	}
	async delete(userId, workspaceId, contentKey) {
		this.blobs.delete(this.key(userId, workspaceId, contentKey));
	}
	async purgeWorkspace(userId, workspaceId) {
		const prefix = this.wsPrefix(userId, workspaceId);
		for (const k of [...this.blobs.keys()]) if (k.startsWith(prefix)) this.blobs.delete(k);
	}
};
/**
* OPFS-backed store (the production §8 store). Each `(user, workspace, key)`
* walks `assets/<user>/<ws>/<key>` as a directory tree, creating dirs on `put`
* and treating a `NotFoundError` as a miss on read.
*/
var OpfsByteStore = class {
	getRoot;
	/** Cached OPFS root + per-(user,ws) dir handles, so repeated ops (the down-lane's
	*  probes, capture/demand reads+writes) skip re-walking the 3-level chain from the
	*  root each call. Only SUCCESSFUL resolutions are cached. Invalidated on
	*  `purgeWorkspace`; a handle left stale by external eviction is handled per-op
	*  (reads → NotFound miss; `put` invalidates + retries). */
	rootCache;
	wsDirCache = /* @__PURE__ */ new Map();
	constructor(deps = {}) {
		this.getRoot = deps.getRoot ?? (() => navigator.storage.getDirectory());
	}
	root() {
		return this.rootCache ??= this.getRoot();
	}
	/** Walk a chain of (already-encoded) directory names from the cached OPFS root.
	*  `create: false` throws `NotFoundError` at the first missing dir (a read
	*  miss); `create: true` makes them (a write). */
	async walk(names, create) {
		let dir = await this.root();
		for (const name of names) dir = await dir.getDirectoryHandle(name, { create });
		return dir;
	}
	wsCacheKey(userId, workspaceId) {
		return `${encodeSegment(userId)}/${encodeSegment(workspaceId)}`;
	}
	/** The `assets/<user>/<ws>` directory holding one workspace's object files, memoized
	*  (see {@link wsDirCache}). When cached the `create` flag is moot — the dir exists. */
	workspaceDir(userId, workspaceId, create) {
		const cacheKey = this.wsCacheKey(userId, workspaceId);
		const cached = this.wsDirCache.get(cacheKey);
		if (cached) return cached;
		const pending = this.walk([
			ASSETS_ROOT,
			encodeSegment(userId),
			encodeSegment(workspaceId)
		], create).catch((err) => {
			this.wsDirCache.delete(cacheKey);
			throw err;
		});
		this.wsDirCache.set(cacheKey, pending);
		return pending;
	}
	async get(userId, workspaceId, contentKey) {
		try {
			const file = await (await (await this.workspaceDir(userId, workspaceId, false)).getFileHandle(encodeSegment(contentKey))).getFile();
			return new Uint8Array(await file.arrayBuffer());
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}
	async put(userId, workspaceId, contentKey, bytes) {
		try {
			await this.writeFile(userId, workspaceId, contentKey, bytes);
		} catch {
			this.wsDirCache.delete(this.wsCacheKey(userId, workspaceId));
			await this.writeFile(userId, workspaceId, contentKey, bytes);
		}
	}
	async writeFile(userId, workspaceId, contentKey, bytes) {
		const writable = await (await (await this.workspaceDir(userId, workspaceId, true)).getFileHandle(encodeSegment(contentKey), { create: true })).createWritable();
		try {
			await writable.write(bytes);
		} finally {
			await writable.close();
		}
	}
	async has(userId, workspaceId, contentKey) {
		try {
			await (await this.workspaceDir(userId, workspaceId, false)).getFileHandle(encodeSegment(contentKey));
			return true;
		} catch (err) {
			if (isNotFound(err)) return false;
			throw err;
		}
	}
	async listWorkspaceKeys(userId, workspaceId) {
		try {
			const dir = await this.workspaceDir(userId, workspaceId, false);
			const keys = /* @__PURE__ */ new Set();
			for await (const name of dir.keys()) keys.add(decodeSegment(name));
			return keys;
		} catch (err) {
			if (isNotFound(err)) return /* @__PURE__ */ new Set();
			throw err;
		}
	}
	async delete(userId, workspaceId, contentKey) {
		try {
			await (await this.workspaceDir(userId, workspaceId, false)).removeEntry(encodeSegment(contentKey));
		} catch (err) {
			if (isNotFound(err)) return;
			throw err;
		}
	}
	async purgeWorkspace(userId, workspaceId) {
		this.wsDirCache.delete(this.wsCacheKey(userId, workspaceId));
		try {
			await (await this.walk([ASSETS_ROOT, encodeSegment(userId)], false)).removeEntry(encodeSegment(workspaceId), { recursive: true });
		} catch (err) {
			if (isNotFound(err)) return;
			throw err;
		}
	}
};
/** Pick the OPFS store when available, else the in-memory fallback. */
var createByteStore = () => {
	try {
		if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") return new OpfsByteStore();
	} catch {}
	return new InMemoryByteStore();
};
var sharedByteStore = null;
var getByteStore = () => sharedByteStore ??= createByteStore();
//#endregion
export { ASSETS_ROOT, InMemoryByteStore, OpfsByteStore, assetPathSegments, createByteStore, getByteStore };

//# sourceMappingURL=byteStore.js.map