import { defineFacet } from "../facets/facet.js";
//#region src/shortcuts/keybindingOverrides.ts
/**
* Keybinding overrides — first-class extension point for rebinding
* actions without forking their definitions.
*
* Sources contribute `KeybindingOverride` entries via
* `keybindingOverridesFacet`. The keybindings-settings plugin
* contributes one entry per user-remapped action at high precedence;
* other plugins (or static config) can contribute entries at default
* precedence to ship opinionated rebinds. A dedicated cross-action pass
* (`applyKeybindingOverrides`, run by `getEffectiveActions` after the
* per-action transform pipeline) consumes the facet and rewrites each
* action's `defaultBinding` accordingly.
*
* Collision rule (matches "user override wins, default loses"):
*
*   • If a user-source override sets action B's chord to ⌘K, and
*     action A's *default* binding is ⌘K, A's chord is stripped in
*     contexts that overlap with B's. A still exists; it just no
*     longer claims that chord.
*   • Two user-source overrides on the same chord both keep it.
*     That's the "shadow + warn" case the settings UI surfaces;
*     hotkeys-js will dispatch both handlers.
*/
var KEYBINDING_OVERRIDE_USER_SOURCE = "user-prefs";
var isKeyOverrideUnbound = (binding) => "unbound" in binding && binding.unbound === true;
var isStringOrStringArray = (value) => typeof value === "string" || Array.isArray(value) && value.every((item) => typeof item === "string");
var isKeyOverrideBinding = (value) => {
	if (typeof value !== "object" || value === null) return false;
	if ("unbound" in value) return value.unbound === true;
	if ("keys" in value) return isStringOrStringArray(value.keys);
	return false;
};
var isKeybindingOverride = (value) => {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	return typeof v.actionId === "string" && v.actionId.length > 0 && (v.context === void 0 || typeof v.context === "string" && v.context.length > 0) && typeof v.source === "string" && v.source.length > 0 && v.binding !== void 0 && isKeyOverrideBinding(v.binding);
};
var keybindingOverridesFacet = defineFacet({
	id: "core.keybinding-overrides",
	validate: isKeybindingOverride
});
//#endregion
export { KEYBINDING_OVERRIDE_USER_SOURCE, isKeyOverrideUnbound, isKeybindingOverride, keybindingOverridesFacet };

//# sourceMappingURL=keybindingOverrides.js.map