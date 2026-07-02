import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { createdAtProp, editorFocusRequestProp, editorSelection, focusedBlockLocationProp, isCollapsedProp, isEditingProp, presetConfigProp, rendererNameProp, rendererProp, selectionStateProp, showPropertiesProp, sourceBlockIdProp, topLevelBlockIdProp, typesProp } from "../../data/properties.js";
import { propertyEditorOverridesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { TypesPropertyEditor } from "./TypesPropertyEditor.js";
//#region src/components/propertyEditors/typesPropertyUi.ts
var typesPropertyUi = definePropertyEditorOverride({
	name: typesProp.name,
	label: "Types",
	Editor: TypesPropertyEditor
});
var hiddenKernelPropertyUis = [
	createdAtProp,
	editorFocusRequestProp,
	editorSelection,
	focusedBlockLocationProp,
	isCollapsedProp,
	isEditingProp,
	presetConfigProp,
	rendererNameProp,
	rendererProp,
	selectionStateProp,
	showPropertiesProp,
	sourceBlockIdProp,
	topLevelBlockIdProp
].map((schema) => definePropertyEditorOverride({
	name: schema.name,
	hidden: true
}));
/** Per-name editor overrides only — type-keyed editor selection now
*  flows through `valuePresetsFacet`. See user-defined-properties §1-edit. */
var kernelPropertyUiExtension = systemToggle({
	id: "system:kernel-property-ui",
	name: "Property editors",
	description: "Editors for kernel property schemas (types, etc) and the hidden-property list for the property panel."
}).of([propertyEditorOverridesFacet.of(typesPropertyUi, { source: "kernel-ui" }), hiddenKernelPropertyUis.map((ui) => propertyEditorOverridesFacet.of(ui, { source: "kernel-ui" }))]);
var typesPropertyUiExtension = kernelPropertyUiExtension;
//#endregion
export { kernelPropertyUiExtension, typesPropertyUi, typesPropertyUiExtension };

//# sourceMappingURL=typesPropertyUi.js.map