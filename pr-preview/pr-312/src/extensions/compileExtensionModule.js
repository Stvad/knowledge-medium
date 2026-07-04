const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["node_modules/@babel/standalone/babel.js","_virtual/_rolldown/runtime.js"])))=>i.map(i=>d[i]);
import { __toESM } from "../../_virtual/_rolldown/runtime.js";
import { hex } from "../../node_modules/@scure/base/index.js";
import { __vitePreload } from "../../_virtual/_vite/preload-helper.js";
import { getCompiledModuleCache } from "./compiledModuleCache.js";
//#region src/extensions/compileExtensionModule.ts
var COMPILER_VERSION = "2";
var createCompileCache = () => ({
	byHash: /* @__PURE__ */ new Map(),
	byBlock: /* @__PURE__ */ new Map()
});
var defaultCache = createCompileCache();
var compileImplOverride = null;
var transpileImpl = defaultTranspileViaBabel;
var instantiateImpl = defaultInstantiateViaBlob;
function __setCompileImplForTest(impl) {
	const previous = compileImplOverride;
	compileImplOverride = impl;
	return () => {
		compileImplOverride = previous;
	};
}
function __setTranspileImplForTest(impl) {
	const previous = transpileImpl;
	transpileImpl = impl;
	return () => {
		transpileImpl = previous;
	};
}
function __setInstantiateImplForTest(impl) {
	const previous = instantiateImpl;
	instantiateImpl = impl;
	return () => {
		instantiateImpl = previous;
	};
}
function __resetCompileCacheForTest() {
	defaultCache.byHash.clear();
	defaultCache.byBlock.clear();
}
/** Pure SHA-256 of the source. The compiler version is intentionally NOT
*  mixed in here — see {@link COMPILER_VERSION}. This is the hash the
*  device-local approval pins, and what the loader compares against
*  `hashExtensionSource(live block.content)` to detect source drift. */
async function hashExtensionSource(content) {
	const data = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return hex.encode(new Uint8Array(digest));
}
/** Transpile TS/JSX source to JS. Babel is loaded with a dynamic
*  `import()` so `@babel/standalone` (~0.85 MB gz) leaves the eager
*  startup preload set (#167) — it's fetched/evaluated only here, on a
*  genuine compile-cache miss.
*
*  Two debuggability additions (COMPILER_VERSION 2):
*   - `sourceMaps: 'inline'` + `sourceFileName` embeds a base64 source map
*     (with the original TSX in `sourcesContent`) so DevTools maps stack
*     frames / breakpoints back to the author's source, not the transpiled
*     JS.
*   - a trailing `//# sourceURL` names the in-memory script. The blob URL is
*     revoked the instant the import resolves, so without this a throw shows
*     `blob:<uuid>` with no name; the sourceURL survives revocation and, when
*     `blockId` is known, identifies *which* extension a frame came from.
*  Note: the L1 cache is keyed by content hash, so two blocks with identical
*  source share one compiled string — the sourceURL then carries whichever
*  block compiled first. Cosmetic only (identical-source extensions are rare;
*  they already share one module instance). */
async function defaultTranspileViaBabel(content, blockId) {
	const Babel = await __vitePreload(() => import("../../node_modules/@babel/standalone/babel.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1)), __vite__mapDeps([0,1]));
	const sourceName = `${(blockId ?? "extension-block").replace(/[^A-Za-z0-9._-]/g, "_")}.tsx`;
	const transpiled = Babel.transform(content, {
		filename: sourceName,
		sourceFileName: sourceName,
		sourceMaps: "inline",
		presets: ["react", "typescript"]
	}).code;
	if (!transpiled) throw new Error("Transpiled extension code is empty");
	return `${transpiled}\n//# sourceURL=km-extension://${sourceName}`;
}
/** Build an ESM module from already-transpiled JS via a blob URL. This
*  is the only step that touches the network/loader, and the only step
*  that runs on a persistent-cache hit (no Babel). */
async function defaultInstantiateViaBlob(compiled) {
	const blob = new Blob([compiled], { type: "text/javascript" });
	const blobUrl = URL.createObjectURL(blob);
	try {
		return await __vitePreload(() => import(
			/* @vite-ignore */
			blobUrl
), []);
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}
/**
* Resolve a module through the in-memory L1 (content-hash) / L2 (blockId)
* cache, building it via `factory` only on a miss. `hashKey` is the
* content hash that keys L1 — for an approved load it's the APPROVED
* source hash (the pin), so two blocks sharing the same approved source
* share one module instance, and a re-resolve of an unchanged pin returns
* the same reference (React doesn't remount).
*
* A rejected build is dropped from BOTH layers so the next call retries
* rather than caching the failure forever.
*/
function resolveCachedModule(cache, hashKey, blockId, factory) {
	const cachedForBlock = cache.byBlock.get(blockId);
	if (cachedForBlock?.contentHash === hashKey) return cachedForBlock.modulePromise;
	let modulePromise = cache.byHash.get(hashKey);
	if (!modulePromise) {
		modulePromise = factory();
		cache.byHash.set(hashKey, modulePromise);
		modulePromise.catch(() => {
			if (cache.byHash.get(hashKey) === modulePromise) cache.byHash.delete(hashKey);
			if (cache.byBlock.get(blockId)?.modulePromise === modulePromise) cache.byBlock.delete(blockId);
		});
	}
	cache.byBlock.set(blockId, {
		contentHash: hashKey,
		modulePromise
	});
	return modulePromise;
}
/**
* Runtime shape-guard that tells a real Phase-2 approval record apart from
* a leftover Phase-1 (#167) compile-cache row.
*
* THIS IS A SECURITY CHECK (#67), not a defensive nicety. Phase 1 shipped
* the SAME `km-extension-compiled` store and auto-wrote a row
* `{sourceHash, compiled, compilerVersion}` on EVERY compile (implicit
* auto-approve), with no `approvedSource`/`approvedAt`. On every upgraded
* profile that store is already full of such rows. If row-presence alone
* counted as trust, every already-compiled extension would skip
* `needs-approval` and execute its cached JS with no explicit approval —
* defeating the gate for the entire existing fleet. A row is an approval
* ONLY if it carries the Phase-2 fields; legacy rows read as "no approval"
* and are overwritten by the next real `approveExtension`.
*/
var isApprovalRecord = (row) => {
	if (!row || typeof row !== "object") return false;
	const r = row;
	return typeof r.approvedSource === "string" && typeof r.approvedAt === "number" && typeof r.sourceHash === "string" && typeof r.compiled === "string" && typeof r.compilerVersion === "string";
};
/** Distinguish "no approval" from "couldn't read the approval store". Use
*  this (not {@link readApproval}) anywhere the no-approval fallback is to
*  pin live source. */
async function lookupApproval(blockId, persistent = getCompiledModuleCache()) {
	let row;
	try {
		row = await persistent.read(blockId);
	} catch (error) {
		console.warn(`Extension approval read failed for ${blockId}`, error);
		return { status: "unreadable" };
	}
	return isApprovalRecord(row) ? {
		status: "approved",
		record: row
	} : { status: "unapproved" };
}
/** Best-effort read of a block's device-local approval record. A flaky
*  read (or absence, or a legacy non-approval row) is reported as "no
*  approval", which surfaces as the cross-device "enable here?" prompt
*  rather than silently running anything — correct for the LOADER, which
*  simply declines to run on `undefined`. Callers whose no-approval
*  fallback is to pin live source must use {@link lookupApproval} so they
*  can fail closed on a transient read error. See {@link isApprovalRecord}
*  for why legacy rows are rejected. */
async function readApproval(blockId, persistent = getCompiledModuleCache()) {
	const lookup = await lookupApproval(blockId, persistent);
	return lookup.status === "approved" ? lookup.record : void 0;
}
/** Best-effort write — a flaky persist must never reject the operation
*  that triggered it (the in-memory module is still returned/usable this
*  session; the next boot just re-prompts for approval). */
async function persistApproval(persistent, blockId, record) {
	try {
		await persistent.write(blockId, record);
	} catch (error) {
		console.warn(`Extension approval write failed for ${blockId}`, error);
	}
}
/**
* Grant (or refresh) the device-local approval for a block: transpile the
* source and DURABLY persist the approval row. This is the ONLY path that
* loads Babel and writes an approval row — the only place trust is
* established (#67). Callers are the settings "enable/update" control and
* the agent `enable-extension` command; both pass the CURRENT live
* `block.content` as the approved source.
*
* Deliberately DECOUPLED from running the module (#67 review):
*   - It does NOT instantiate. Approving a block vouches the SOURCE, not its
*     runtime behaviour — a module that transpiles but throws at import/eval
*     must NOT abort the approve/enable action. That runtime error surfaces
*     through the loader's `errorReporter` after intent is applied, where it
*     belongs (and where the row still shows in settings for recovery).
*   - The persist is NOT best-effort. If the trust row can't be written
*     (quota / private-mode / aborted tx) the approve has FAILED and throws,
*     so callers don't set "enabled" intent against a non-existent approval
*     (which would silently loop on needs-approval). Contrast the load
*     path's compiler-bump rewrite, which stays best-effort.
*
* Idempotent for unchanged, already-approved source (no Babel, no write).
* Throws if the source can't be transpiled (syntax error — nothing to pin)
* or the approval can't be persisted. Returns the approved source hash.
*/
async function approveExtension(blockId, source, persistent = getCompiledModuleCache()) {
	const sourceHash = await hashExtensionSource(source);
	const existing = await readApproval(blockId, persistent);
	if (existing?.sourceHash === sourceHash && existing.compilerVersion === COMPILER_VERSION) return { contentHash: sourceHash };
	const compiled = compileImplOverride ? source : await transpileImpl(source, blockId);
	await persistent.write(blockId, {
		sourceHash,
		approvedSource: source,
		compiled,
		compilerVersion: COMPILER_VERSION,
		approvedAt: Date.now()
	});
	return { contentHash: sourceHash };
}
/**
* Instantiate a block from its APPROVED record (the pin) — never from live
* content. This is the load path the runtime uses for an
* already-approved, enabled block: no Babel on the warm path.
*
*   - compiler matches → instantiate the pinned `compiled` string.
*   - compiler bumped → recompile from `approvedSource` (loads Babel) and
*     re-pin the fresh output. We recompile the APPROVED source, not the
*     live content, so a compiler bump can never become a backdoor for
*     drifted (un-approved) code.
*
* `contentHash` in the result is the approved hash (so callers can compare
* it against the live content hash to know whether an update is pending).
*/
async function loadApprovedExtension(blockId, approval, cache = defaultCache, persistent = getCompiledModuleCache()) {
	return {
		module: await resolveCachedModule(cache, approval.sourceHash, blockId, async () => {
			if (compileImplOverride) return compileImplOverride(approval.approvedSource);
			if (approval.compilerVersion !== COMPILER_VERSION) {
				const compiled = await transpileImpl(approval.approvedSource, blockId);
				await persistApproval(persistent, blockId, {
					...approval,
					compiled,
					compilerVersion: COMPILER_VERSION
				});
				return instantiateImpl(compiled);
			}
			return instantiateImpl(approval.compiled);
		}),
		contentHash: approval.sourceHash
	};
}
/**
* Compile LIVE source into a module WITHOUT persisting or requiring an
* approval. Used only by the agent install `--verify` path, which resolves
* a brand-new block's source in an isolated runtime to inspect its
* contributions before any approval exists. Never used on the user-facing
* load path — that one runs only approved, pinned output.
*/
async function compileForVerification(content, blockId, cache = defaultCache) {
	const contentHash = await hashExtensionSource(content);
	return {
		module: await resolveCachedModule(cache, contentHash, blockId, () => compileImplOverride ? compileImplOverride(content) : transpileImpl(content, blockId).then(instantiateImpl)),
		contentHash
	};
}
/**
* Revoke a block's device-local approval: delete the persisted row and
* drop the in-memory L2 entry, so the block stops running on the next
* resolve. Best-effort (a failed delete must not break disable/uninstall);
* the worst case is an orphaned row that a later re-approval overwrites (or
* that a full "clear site data" wipe drops).
*/
async function revokeExtensionApproval(blockId, persistent = getCompiledModuleCache(), cache = defaultCache) {
	evictBlockFromCache(blockId, cache);
	try {
		await persistent.delete(blockId);
	} catch (error) {
		console.warn(`Extension approval delete failed for ${blockId}`, error);
	}
}
/**
* Drop a block's entry from the in-memory L2 cache. Use when a block is
* deleted/revoked so its modulePromise is eligible for GC. (The L1 entry
* under the old hash may survive — acceptable since other blocks could
* share it.) Does not touch the persisted approval; use
* {@link revokeExtensionApproval} for that.
*/
function evictBlockFromCache(blockId, cache = defaultCache) {
	cache.byBlock.delete(blockId);
}
//#endregion
export { __resetCompileCacheForTest, __setCompileImplForTest, __setInstantiateImplForTest, __setTranspileImplForTest, approveExtension, compileForVerification, createCompileCache, evictBlockFromCache, hashExtensionSource, loadApprovedExtension, lookupApproval, readApproval, revokeExtensionApproval };

//# sourceMappingURL=compileExtensionModule.js.map