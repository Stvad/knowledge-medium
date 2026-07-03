import { Block } from "../data/block.js";
import { EditorView } from "../../node_modules/@codemirror/view/dist/index.js";
import { ActionContextTypes } from "./types.js";
import { isInteractiveContentEvent } from "../extensions/blockInteraction.js";
//#region src/shortcuts/defaultContexts.ts
var isBaseShortcutDependencies = (deps) => typeof deps === "object" && deps !== null && "uiStateBlock" in deps && deps.uiStateBlock instanceof Block;
var isBlockShortcutDependencies = (deps) => isBaseShortcutDependencies(deps) && typeof deps === "object" && deps !== null && "block" in deps && deps.block instanceof Block;
var isCodeMirrorEditModeDependencies = (deps) => isBaseShortcutDependencies(deps) && typeof deps === "object" && deps !== null && "block" in deps && deps.block instanceof Block && "editorView" in deps && deps.editorView instanceof EditorView;
var isPropertyEditingDependencies = (deps) => isBlockShortcutDependencies(deps) && typeof deps === "object" && deps !== null && "input" in deps && deps.input instanceof HTMLInputElement;
var isMultiSelectModeDependencies = (deps) => isBaseShortcutDependencies(deps) && typeof deps === "object" && deps !== null && "selectedBlocks" in deps && Array.isArray(deps.selectedBlocks) && deps.selectedBlocks.every((b) => b instanceof Block) && "anchorBlock" in deps && (deps.anchorBlock === null || deps.anchorBlock instanceof Block);
var isBlockPointerDependencies = (deps) => isBlockShortcutDependencies(deps) && typeof deps === "object" && deps !== null && "targetElement" in deps && deps.targetElement instanceof HTMLElement;
var defaultActionContextConfigs = [
	{
		type: ActionContextTypes.GLOBAL,
		displayName: "Global",
		validateDependencies: isBaseShortcutDependencies
	},
	{
		type: ActionContextTypes.NORMAL_MODE,
		displayName: "Normal Mode",
		validateDependencies: isBlockShortcutDependencies
	},
	{
		type: ActionContextTypes.EDIT_MODE_CM,
		displayName: "Edit Mode (CodeMirror)",
		defaultEventOptions: { preventDefault: false },
		eventFilter: (event) => {
			return event.target?.closest(".cm-editor") !== null;
		},
		validateDependencies: isCodeMirrorEditModeDependencies
	},
	{
		type: ActionContextTypes.PROPERTY_EDITING,
		displayName: "Property Editing",
		modal: true,
		validateDependencies: isPropertyEditingDependencies
	},
	{
		type: ActionContextTypes.MULTI_SELECT_MODE,
		displayName: "Multi-Select Mode",
		modal: true,
		validateDependencies: isMultiSelectModeDependencies
	},
	{
		type: ActionContextTypes.BLOCK_POINTER,
		displayName: "Block Pointer Gesture",
		keyboardBindable: false,
		priority: "high",
		pointerTargetFilter: (event) => !isInteractiveContentEvent(event),
		validateDependencies: isBlockPointerDependencies
	}
];
//#endregion
export { defaultActionContextConfigs };

//# sourceMappingURL=defaultContexts.js.map