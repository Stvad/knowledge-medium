import { clientLocalSettings } from "../utils/ClientLocalSettings.js";
//#region src/extensions/overridesCache.ts
/**
* First-paint cache for the runtime-toggle overrides map.
*
* `staticAppExtensions` resolves synchronously before PowerSync
* hydrates, so without a cache every system plugin's effect would
* start (and every mount would mount) only to be torn down ~one
* round-trip later when the synced Extensions block arrives. To
* avoid the flash, we mirror the synced overrides into a narrowly-
* scoped `ClientLocalSettings` entry per workspace, written from the
* extensions-settings meta-plugin's subscription effect, read by
* `AppRuntimeProvider` at boot.
*
* Schema is sparse: only entries that diverge from the handle's
* manifest default are recorded (matches `applyToggle` semantics).
* Absence means "use the manifest default" — so adding new plugins
* with `defaultEnabled: false` (opt-in / experimental) doesn't
* require migrating anyone's cached state.
*/
var CACHE_KEY_PREFIX = "extensions.overrides";
var cacheKey = (workspaceId) => `${CACHE_KEY_PREFIX}.${workspaceId}`;
var encodeOverrides = (overrides) => {
	const out = {};
	for (const [id, state] of overrides) out[id] = state;
	return out;
};
var decodeOverrides = (raw) => {
	const out = /* @__PURE__ */ new Map();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [id, state] of Object.entries(raw)) if (typeof state === "boolean") out.set(id, state);
	return out;
};
/** Read the cached overrides for a workspace. Returns an empty map
*  if nothing is cached or the stored value is malformed (which
*  matches "use manifest defaults"). */
var readOverridesCache = (workspaceId, storage = clientLocalSettings) => {
	return decodeOverrides(storage.get(cacheKey(workspaceId), null));
};
/** Write the overrides map for a workspace. Called from the
*  extensions-settings effect whenever the synced block changes. Writes
*  an empty object when the map has no entries (rather than removing
*  the key) so consumers can distinguish "hydrated, no overrides"
*  from "never hydrated, fall back to defaults" if they care. */
var writeOverridesCache = (workspaceId, overrides, storage = clientLocalSettings) => {
	storage.set(cacheKey(workspaceId), encodeOverrides(overrides));
};
//#endregion
export { decodeOverrides, encodeOverrides, readOverridesCache, writeOverridesCache };

//# sourceMappingURL=overridesCache.js.map