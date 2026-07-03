import { propertyEditorOverridesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { dialogAppMountExtension } from "../../extensions/dialogAppMount.js";
import { groupedBacklinksGroupHeaderActionsFacet } from "../grouped-backlinks/facet.js";
import { blockTagsConfigProp } from "./config.js";
import { blockTaggingDataExtension } from "./dataExtension.js";
import { blockTagsConfigUi } from "./propertyEditorOverride.js";
import { appendTagToBlocks, appendTagToContent } from "./appendTag.js";
import { ADD_TAG_ACTION_ID, ADD_TAG_BLOCKS_ACTION_ID, addTagAction, addTagBlockAction, addTagGroupHeaderEntry } from "./addTagAction.js";
//#region src/plugins/block-tagging/index.ts
var blockTaggingPlugin = systemToggle({
	id: "system:block-tagging",
	name: "Block tagging",
	description: "Add-tag action and the per-workspace tag-list preference."
}).of([
	blockTaggingDataExtension,
	dialogAppMountExtension,
	propertyEditorOverridesFacet.of(blockTagsConfigUi, { source: "block-tagging" }),
	actionsFacet.of(addTagBlockAction, { source: "block-tagging" }),
	actionsFacet.of(addTagAction, { source: "block-tagging" }),
	groupedBacklinksGroupHeaderActionsFacet.of(addTagGroupHeaderEntry, { source: "block-tagging" })
]);
//#endregion
export { ADD_TAG_ACTION_ID, ADD_TAG_BLOCKS_ACTION_ID, appendTagToBlocks, appendTagToContent, blockTaggingPlugin, blockTagsConfigProp };

//# sourceMappingURL=index.js.map