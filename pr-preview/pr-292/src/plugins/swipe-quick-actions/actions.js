import { defineFacet } from "../../facets/facet.js";
//#region src/plugins/swipe-quick-actions/actions.ts
/** Semantic action invoked by a right-swipe on a block content surface.
*  The gesture plugin owns the trigger; another plugin owns the baseline
*  handler and other plugins can decorate it through `actionTransformsFacet`. */
var SWIPE_RIGHT_BLOCK_ACTION_ID = "block.swipe-right";
var isRecord = (value) => typeof value === "object" && value !== null;
var isQuickActionItem = (value) => isRecord(value) && typeof value.actionId === "string" && (value.label === void 0 || typeof value.label === "string") && (value.destructive === void 0 || typeof value.destructive === "boolean") && (value.overflow === void 0 || typeof value.overflow === "boolean") && (value.row === void 0 || typeof value.row === "number" && Number.isInteger(value.row) && value.row >= 1);
var quickActionItemsFacet = defineFacet({
	id: "swipe-quick-actions.items",
	validate: isQuickActionItem
});
/** Default visible items. Order: most-used to least-used, with
*  destructive last so it's farthest from the swipe origin.
*  `copy_block` here is the existing shared action that serializes the
*  block + its subtree as indented markdown (the same handler the vim
*  cmd+c binding uses) — not just the top-level content string. */
var DEFAULT_QUICK_ACTION_ITEMS = [
	{
		actionId: "copy_block",
		label: "Copy"
	},
	{
		actionId: "copy_block_ref",
		label: "Copy Ref"
	},
	{
		actionId: "open_focused_in_panel",
		label: "Open"
	},
	{
		actionId: "toggle_properties",
		label: "Properties"
	},
	{
		actionId: "delete_block",
		label: "Delete",
		destructive: true
	},
	{
		actionId: "zoom_in",
		label: "Zoom In",
		overflow: true
	},
	{
		actionId: "toggle_collapse",
		label: "Collapse",
		overflow: true
	},
	{
		actionId: "copy_block_embed",
		label: "Copy Embed",
		overflow: true
	}
];
//#endregion
export { DEFAULT_QUICK_ACTION_ITEMS, SWIPE_RIGHT_BLOCK_ACTION_ID, isQuickActionItem, quickActionItemsFacet };

//# sourceMappingURL=actions.js.map