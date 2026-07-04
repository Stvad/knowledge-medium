import { ChangeScope } from "./api/changeScope.js";
import { codecs } from "./api/codecs.js";
import { defineProperty } from "./api/propertySchema.js";
import "./api/index.js";
import { outlineRenderScopeId } from "../utils/renderScope.js";
//#region src/data/properties.ts
var showPropertiesProp = defineProperty("system:showProperties", {
	codec: codecs.boolean,
	defaultValue: false,
	changeScope: ChangeScope.UiState
});
var isEditingProp = defineProperty("isEditing", {
	codec: codecs.boolean,
	defaultValue: false,
	changeScope: ChangeScope.UiState
});
var topLevelBlockIdProp = defineProperty("topLevelBlockId", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.UiState
});
var focusedBlockLocationProp = defineProperty("focusedBlockLocation", {
	codec: codecs.optionalIdentity(),
	defaultValue: void 0,
	changeScope: ChangeScope.UiState
});
var activePanelIdProp = defineProperty("activePanelId", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.UiState
});
var scrollTopProp = defineProperty("scrollTop", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.UiState
});
var editorSelection = defineProperty("editorSelection", {
	codec: codecs.optionalIdentity(),
	defaultValue: void 0,
	changeScope: ChangeScope.UiState
});
var editorFocusRequestProp = defineProperty("editorFocusRequest", {
	codec: codecs.number,
	defaultValue: 0,
	changeScope: ChangeScope.UiState
});
var selectionStateProp = defineProperty("blockSelectionState", {
	codec: codecs.unsafeIdentity(),
	defaultValue: {
		selectedBlockIds: [],
		anchorBlockId: null
	},
	changeScope: ChangeScope.UiState
});
var isCollapsedProp = defineProperty("system:collapsed", {
	codec: codecs.boolean,
	defaultValue: false,
	changeScope: ChangeScope.BlockDefault
});
var typesProp = defineProperty("types", {
	codec: codecs.list(codecs.string),
	defaultValue: [],
	changeScope: ChangeScope.BlockDefault
});
var rendererProp = defineProperty("renderer", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var rendererNameProp = defineProperty("rendererName", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var createdAtProp = defineProperty("createdAt", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var sourceBlockIdProp = defineProperty("sourceBlockId", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
/** Human-readable extension name. Kept on the block instead of inside
*  executable extension code so disabled extensions can still be
*  described in settings without compiling them. */
var extensionNameProp = defineProperty("extension:name", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** Optional extension description displayed in the settings surface. */
var extensionDescriptionProp = defineProperty("extension:description", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** User-supplied property name on a `'property-schema'` block. */
var propertyNameProp = defineProperty("property-schema:name", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** Preset id on a `'property-schema'` block — matches a registered
*  `ValuePreset.id` (and the codec's `type` for codecs built by that
*  preset). */
var presetIdProp = defineProperty("property-schema:preset", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** Preset-specific config JSON. Stored as opaque JSON via the
*  `unsafeIdentity` codec; validation happens in the preset's
*  `configCodec.decode` at registration time. */
var presetConfigProp = defineProperty("property-schema:config", {
	codec: codecs.unsafeIdentity("object"),
	defaultValue: {},
	changeScope: ChangeScope.BlockDefault
});
/** Human-readable label on a `'block-type'` block. Shown in the type
*  picker and as the section header in the property panel. */
var blockTypeLabelProp = defineProperty("block-type:label", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** Optional free-form description on a `'block-type'` block. */
var blockTypeDescriptionProp = defineProperty("block-type:description", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** RefList over `'property-schema'` blocks. UserTypesService resolves
*  each ref to the merged property-schema map (via
*  `UserSchemasService.getSchemaForBlockId`) to build the lifted
*  property list on the resulting TypeContribution. */
var blockTypePropertiesProp = defineProperty("block-type:properties", {
	codec: codecs.refList({ targetTypes: ["property-schema"] }),
	defaultValue: [],
	changeScope: ChangeScope.BlockDefault
});
/** Don't render this type's chip on blocks (the supertags `#type`
*  row). Display-only — the type stays taggable and visible in
*  pickers/panel. Lifted onto `TypeContribution.hideFromBlockDisplay`. */
var blockTypeHideFromBlockDisplayProp = defineProperty("block-type:hide-from-block-display", {
	codec: codecs.boolean,
	defaultValue: false,
	changeScope: ChangeScope.BlockDefault
});
/** CSS color for this type's tag chip (any `color`-property value:
*  `#e11d48`, `tomato`, `hsl(…)`, …). Empty = default chip styling.
*  Lifted onto `TypeContribution.color`. */
var blockTypeColorProp = defineProperty("block-type:color", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** Opaque user id (the value stored in `created_by` / `updated_by`) on a
*  `'user'` user-page block. Gives the page a structured, queryable link
*  between the id and the display name (the block's content) alongside
*  the human-friendly alias — so attribution surfaces can resolve either
*  direction without parsing aliases. */
var userIdProp = defineProperty("user:id", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** Alias list stored on alias-target / daily-note blocks (§7). The
*  encoded shape in `properties_json` is `string[]`; the codec is the
*  list-of-strings combinator.
*
*  This is the schema `parseReferences` writes when a tx inserts a
*  target block (e.g. `[[Inbox]]` produces a target with
*  `aliases: ['Inbox']`), and the same schema alias-lookup queries
*  consult to resolve `[[alias]]` to a target id. */
var aliasesProp = defineProperty("alias", {
	codec: codecs.list(codecs.string),
	defaultValue: [],
	changeScope: ChangeScope.BlockDefault
});
var getBlockTypes = (data) => {
	const raw = data.properties[typesProp.name];
	return raw === void 0 ? typesProp.defaultValue : typesProp.codec.decode(raw);
};
var hasBlockType = (data, typeId) => getBlockTypes(data).includes(typeId);
/** Type-membership delta helpers for same-tx processors that watch the
*  `properties` field. `row.before` is null on insert; `row.after` is
*  null on hard-delete — both are null-safe here, returning the
*  appropriate one-sided diff. Order in the returned array matches
*  `typesProp.codec.decode` order on whichever side is non-null. */
var addedTypes = (row) => {
	const before = row.before ? new Set(getBlockTypes(row.before)) : /* @__PURE__ */ new Set();
	return (row.after ? getBlockTypes(row.after) : []).filter((t) => !before.has(t));
};
var removedTypes = (row) => {
	const before = row.before ? getBlockTypes(row.before) : [];
	const after = row.after ? new Set(getBlockTypes(row.after)) : /* @__PURE__ */ new Set();
	return before.filter((t) => !after.has(t));
};
/** Raw membership writer for BlockData construction paths that do not
*  have a Repo/Tx available. Does not run setup or materialise
*  addType initial values. */
var addBlockTypeToProperties = (properties, typeId) => {
	const current = getBlockTypes({ properties });
	if (current.includes(typeId)) return properties;
	return {
		...properties,
		[typesProp.name]: typesProp.codec.encode([...current, typeId])
	};
};
/** Set the editing flag on the UI-state block. Refuses to enter edit
*  mode in a read-only repo (workspace viewer) — the wrappers also
*  short-circuit, but this gate keeps any new caller honest. */
var setIsEditing = (uiStateBlock, editing) => {
	if (editing && uiStateBlock.repo.isReadOnly) return;
	uiStateBlock.set(isEditingProp, editing);
};
var decodeFocusedBlockLocation = (raw) => {
	if (typeof raw !== "object" || raw === null) return void 0;
	const maybe = raw;
	return typeof maybe.blockId === "string" && typeof maybe.renderScopeId === "string" ? {
		blockId: maybe.blockId,
		renderScopeId: maybe.renderScopeId
	} : void 0;
};
var focusedBlockLocationFromProperties = (properties) => {
	if (!properties) return void 0;
	return decodeFocusedBlockLocation(properties[focusedBlockLocationProp.name]);
};
var peekFocusedBlockLocation = (uiStateBlock) => focusedBlockLocationFromProperties(uiStateBlock.peek()?.properties);
var isFocusedBlock = (uiStateBlock, blockId, renderScopeId) => {
	const location = peekFocusedBlockLocation(uiStateBlock);
	if (!location || location.blockId !== blockId) return false;
	return renderScopeId ? location.renderScopeId === renderScopeId : true;
};
var sameFocusedBlockLocation = (a, b) => Boolean(a && b && a.blockId === b.blockId && a.renderScopeId === b.renderScopeId);
var isEditingFromProperties = (properties) => {
	const encoded = properties?.[isEditingProp.name];
	return encoded === void 0 ? isEditingProp.defaultValue : isEditingProp.codec.decode(encoded);
};
/** Atomically move focus to `blockId` and set the edit flag in one tx.
*
*  Focus is a rendered location, not just a logical block id: the
*  same block can appear in the outline, backlinks, and any number of
*  embeds at once. The render scope disambiguates those copies while
*  keeping selection state separately keyed by block id.
*
*  Returns the tx-commit promise so callers that need to observe
*  focus-derived state next can `await` instead of racing propagation. */
var focusBlock = async (uiStateBlock, blockId, options = {}) => {
	const { edit = false, renderScopeId } = options;
	const targetEdit = edit && !uiStateBlock.repo.isReadOnly ? true : false;
	const currentLocation = peekFocusedBlockLocation(uiStateBlock);
	const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp);
	const fallbackRenderScopeId = currentLocation?.blockId === blockId ? currentLocation.renderScopeId : outlineRenderScopeId(topLevelBlockId ?? blockId);
	const location = {
		blockId,
		renderScopeId: renderScopeId ?? fallbackRenderScopeId
	};
	await uiStateBlock.repo.tx(async (tx) => {
		const current = targetEdit ? null : await tx.get(uiStateBlock.id);
		const preserveCurrentEditMode = !targetEdit && sameFocusedBlockLocation(focusedBlockLocationFromProperties(current?.properties), location) && isEditingFromProperties(current?.properties);
		await tx.setProperty(uiStateBlock.id, focusedBlockLocationProp, location);
		await tx.setProperty(uiStateBlock.id, isEditingProp, preserveCurrentEditMode || targetEdit);
	}, {
		scope: ChangeScope.UiState,
		description: "focus block"
	});
};
/** Exit edit mode on behalf of `blockId` — but only if that block still
*  owns edit mode when the tx commits.
*
*  `isEditing` is a single flag shared across the UI-state surface, so an
*  unconditional clear is identity-less: it can't tell *whose* edit mode it
*  ends. During a block→block tap the tapped block's `focusBlock(edit:true)`
*  and the outgoing editor's blur-driven exit race. An anonymous clear that
*  commits *after* the handoff clobbers the flag the new block just set,
*  dropping edit mode entirely (on a soft keyboard it hides, needing a
*  second tap) — and it only misfires under that timing, which is why it
*  doesn't repro on fast/native paths.
*
*  Reading the focused location INSIDE the tx (commit-consistent — the same
*  `tx.get` pattern `focusBlock` uses to preserve edit mode) makes this a
*  compare-and-swap: whichever of the two txs commits second sees the
*  other's effect, so both interleavings settle on the tapped block editing.
*  Unlike a DOM-focus heuristic it's oblivious to *where* focus physically
*  sits (the iOS soft-keyboard proxy input, the incoming block's shell, …). */
var exitEditModeForBlock = async (uiStateBlock, blockId, renderScopeId) => {
	await uiStateBlock.repo.tx(async (tx) => {
		const location = focusedBlockLocationFromProperties((await tx.get(uiStateBlock.id))?.properties);
		if (location && location.blockId !== blockId) return;
		if (location && renderScopeId !== void 0 && location.renderScopeId !== renderScopeId) return;
		await tx.setProperty(uiStateBlock.id, isEditingProp, false);
	}, {
		scope: ChangeScope.UiState,
		description: "exit edit mode"
	});
};
var requestEditorFocus = (uiStateBlock) => {
	const current = uiStateBlock.peekProperty(editorFocusRequestProp) ?? 0;
	uiStateBlock.set(editorFocusRequestProp, current + 1);
};
/** Every kernel-owned `PropertySchema` in one array. Consumed by
*  `kernelDataExtension` to register them with `propertySchemasFacet`
*  so non-React surfaces (the property panel's schema lookup, future
*  CLI / server-side audit, plugin authors inspecting the registry)
*  see the kernel descriptors uniformly.
*
*  Heterogeneous `PropertySchema<T>` shapes flatten through
*  `PropertySchema<unknown>` for storage in the array — the precise
*  per-schema types stay at the export sites and reach typed callers
*  via the schema reference (`block.set(typesProp, ...)` etc.). */
var KERNEL_PROPERTY_SCHEMAS = [
	showPropertiesProp,
	isEditingProp,
	topLevelBlockIdProp,
	focusedBlockLocationProp,
	activePanelIdProp,
	scrollTopProp,
	editorSelection,
	editorFocusRequestProp,
	selectionStateProp,
	isCollapsedProp,
	typesProp,
	rendererProp,
	rendererNameProp,
	createdAtProp,
	sourceBlockIdProp,
	aliasesProp,
	extensionNameProp,
	extensionDescriptionProp,
	propertyNameProp,
	presetIdProp,
	presetConfigProp,
	blockTypeLabelProp,
	blockTypeDescriptionProp,
	blockTypePropertiesProp,
	blockTypeHideFromBlockDisplayProp,
	blockTypeColorProp,
	userIdProp
];
//#endregion
export { KERNEL_PROPERTY_SCHEMAS, activePanelIdProp, addBlockTypeToProperties, addedTypes, aliasesProp, blockTypeColorProp, blockTypeDescriptionProp, blockTypeHideFromBlockDisplayProp, blockTypeLabelProp, blockTypePropertiesProp, createdAtProp, editorFocusRequestProp, editorSelection, exitEditModeForBlock, extensionDescriptionProp, extensionNameProp, focusBlock, focusedBlockLocationFromProperties, focusedBlockLocationProp, getBlockTypes, hasBlockType, isCollapsedProp, isEditingProp, isFocusedBlock, peekFocusedBlockLocation, presetConfigProp, presetIdProp, propertyNameProp, removedTypes, rendererNameProp, rendererProp, requestEditorFocus, sameFocusedBlockLocation, scrollTopProp, selectionStateProp, setIsEditing, showPropertiesProp, sourceBlockIdProp, topLevelBlockIdProp, typesProp, userIdProp };

//# sourceMappingURL=properties.js.map