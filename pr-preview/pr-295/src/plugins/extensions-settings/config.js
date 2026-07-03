import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { CodecError } from "../../data/api/errors.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { decodeOverrides, encodeOverrides } from "../../extensions/overridesCache.js";
//#region src/plugins/extensions-settings/config.ts
/**
* Storage shape for the Extensions meta-plugin.
*
* One per-user prefs block (via `getPluginPrefsBlock`) holds the
* `overrides` map for every togglable in the runtime. The codec
* follows the standard "throw on shape mismatch" convention — the
* subscription effect catches the throw and falls back to the empty
* map, so a manual edit gone wrong doesn't take down extensions.
*/
var expectedShape = "object<string, boolean>";
var isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var decodeOverridesStrict = (json) => {
	if (json === null) return /* @__PURE__ */ new Map();
	if (!isPlainObject(json)) throw new CodecError(expectedShape, json);
	for (const value of Object.values(json)) if (typeof value !== "boolean") throw new CodecError(expectedShape, json);
	return decodeOverrides(json);
};
var overridesCodec = {
	type: "extensions:overrides",
	encode: encodeOverrides,
	decode: decodeOverridesStrict
};
/** The overrides map property on the Extensions block. */
var extensionsOverridesProp = defineProperty("extensions:overrides", {
	codec: overridesCodec,
	defaultValue: /* @__PURE__ */ new Map(),
	changeScope: ChangeScope.UserPrefs
});
/** Per-user prefs sub-block type for the Extensions meta-plugin.
*  Holds the central overrides map for every togglable. Lives under the
*  Preferences tree via `getPluginPrefsBlock`. */
var extensionsPrefsType = defineBlockType({
	id: "extensions-prefs",
	label: "Extensions",
	properties: [extensionsOverridesProp]
});
//#endregion
export { extensionsOverridesProp, extensionsPrefsType, overridesCodec };

//# sourceMappingURL=config.js.map