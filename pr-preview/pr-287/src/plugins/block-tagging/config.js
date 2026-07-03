import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { uniqueStrings } from "../../utils/array.js";
//#region src/plugins/block-tagging/config.ts
/** Tag names are interpolated into a wikilink (`[[name]]`). The
*  reference parser balances `[[ … ]]` pairs, so a name containing
*  either delimiter would parse into a different alias than what the
*  user typed. `renderWikilink` already munges `]]` (with a lossy
*  space-split), but it does not touch `[[` — `"foo[[bar"` renders
*  as `"[[foo[[bar]]"` and parses back as alias `"bar"`. Rather than
*  silently corrupting input, reject names containing either
*  delimiter at the entry points (dialog, config editor, append
*  helpers). */
var isValidTagName = (name) => {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed.includes("[[")) return false;
	if (trimmed.includes("]]")) return false;
	return true;
};
var normalizeBlockTagsConfig = (value) => uniqueStrings(value);
/** Per-workspace list of tag names available to the "add tag" group
*  action. Each entry is a bare page name — the action appends
*  ` [[name]]` to each selected block's content if not already
*  present (no `#` prefix, matching how the user writes tags
*  inline). */
var blockTagsConfigProp = defineProperty("blockTagging:tagsConfig", {
	codec: {
		type: "blockTagging:tagsConfig",
		encode: normalizeBlockTagsConfig,
		decode: normalizeBlockTagsConfig
	},
	defaultValue: [],
	changeScope: ChangeScope.UserPrefs
});
/** Per-plugin prefs sub-block for the block-tagging plugin. Holds
*  `blockTagsConfigProp` (the user's curated tag list). */
var blockTaggingPrefsType = defineBlockType({
	id: "block-tagging-prefs",
	label: "Tags",
	properties: [blockTagsConfigProp]
});
//#endregion
export { blockTaggingPrefsType, blockTagsConfigProp, isValidTagName, normalizeBlockTagsConfig };

//# sourceMappingURL=config.js.map