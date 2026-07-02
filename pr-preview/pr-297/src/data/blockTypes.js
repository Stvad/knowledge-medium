import { defineBlockType } from "./api/blockType.js";
import "./api/index.js";
import { aliasesProp, blockTypeColorProp, blockTypeDescriptionProp, blockTypeHideTagProp, blockTypeLabelProp, blockTypePropertiesProp, extensionDescriptionProp, extensionNameProp, presetConfigProp, presetIdProp, propertyNameProp, userIdProp } from "./properties.js";
//#region src/data/blockTypes.ts
var EXTENSION_TYPE = "extension";
var PAGE_TYPE = "page";
var PANEL_TYPE = "panel";
var PANEL_STACK_TYPE = "panel-stack";
/** User-defined property schemas live as blocks of this type
*  (user-defined-properties §4). Kernel-owned; users don't create or
*  remove the type contribution itself. */
var PROPERTY_SCHEMA_TYPE = "property-schema";
/** Marker type for the singleton Properties page that hosts every
*  property-schema block in a workspace. */
var PROPERTIES_PAGE_TYPE = "panel:properties";
/** User-defined types live as blocks of this type
*  (user-defined-types Phase 1). Kernel-owned; users don't create or
*  remove the type contribution itself. */
var BLOCK_TYPE_TYPE = "block-type";
/** Marker type for the singleton Types page that hosts every
*  block-type block in a workspace. */
var TYPES_PAGE_TYPE = "panel:types";
/** Marker type for the singleton Recents page — a Tana-style view of
*  recently-edited blocks in the workspace. */
var RECENTS_PAGE_TYPE = "panel:recents";
/** Per-user "user page" type. Tagged alongside `PAGE_TYPE` (so the page
*  stays navigable) and carries the user's opaque id as a property,
*  letting `block_types`-indexed lookups enumerate users and attribution
*  surfaces resolve an id to its page/name. Kernel-owned. */
var USER_TYPE = "user";
var KERNEL_TYPE_CONTRIBUTIONS = [
	defineBlockType({
		id: EXTENSION_TYPE,
		label: "Extension",
		structural: true,
		properties: [extensionNameProp, extensionDescriptionProp]
	}),
	defineBlockType({
		id: PAGE_TYPE,
		label: "Page",
		structural: true,
		properties: [aliasesProp]
	}),
	defineBlockType({
		id: PANEL_TYPE,
		label: "Panel",
		structural: true
	}),
	defineBlockType({
		id: PANEL_STACK_TYPE,
		label: "Panel stack",
		structural: true
	}),
	defineBlockType({
		id: PROPERTY_SCHEMA_TYPE,
		label: "Property schema",
		structural: true,
		properties: [
			propertyNameProp,
			presetIdProp,
			presetConfigProp
		]
	}),
	defineBlockType({
		id: PROPERTIES_PAGE_TYPE,
		label: "Properties page",
		structural: true,
		properties: [aliasesProp]
	}),
	defineBlockType({
		id: BLOCK_TYPE_TYPE,
		label: "Type",
		structural: true,
		properties: [
			blockTypeLabelProp,
			blockTypeDescriptionProp,
			blockTypePropertiesProp,
			blockTypeHideTagProp,
			blockTypeColorProp
		]
	}),
	defineBlockType({
		id: TYPES_PAGE_TYPE,
		label: "Types page",
		structural: true,
		properties: [aliasesProp]
	}),
	defineBlockType({
		id: RECENTS_PAGE_TYPE,
		label: "Recents page",
		structural: true,
		properties: [aliasesProp]
	}),
	defineBlockType({
		id: USER_TYPE,
		label: "User",
		structural: true,
		properties: [aliasesProp, userIdProp]
	})
];
//#endregion
export { BLOCK_TYPE_TYPE, EXTENSION_TYPE, KERNEL_TYPE_CONTRIBUTIONS, PAGE_TYPE, PANEL_STACK_TYPE, PANEL_TYPE, PROPERTIES_PAGE_TYPE, PROPERTY_SCHEMA_TYPE, RECENTS_PAGE_TYPE, TYPES_PAGE_TYPE, USER_TYPE };

//# sourceMappingURL=blockTypes.js.map