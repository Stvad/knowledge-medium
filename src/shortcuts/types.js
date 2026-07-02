//#region src/shortcuts/types.ts
var ActionContextTypes = {
	GLOBAL: "global",
	NORMAL_MODE: "normal-mode",
	EDIT_MODE_CM: "edit-mode-cm",
	PROPERTY_EDITING: "property-editing",
	MULTI_SELECT_MODE: "multi-select-mode",
	/**
	* Pointer-dispatched block gestures (shift-click selection, future
	* double-click-to-edit). Never auto-activated by a surface — it carries no
	* persistent state to install bindings against. Instead the block shell
	* dispatches a pointer event with the clicked block's deps SUPPLIED, and the
	* coordinator resolves candidates against those. The context exists only to
	* give those actions a home + a dependency validator.
	*/
	BLOCK_POINTER: "block-pointer"
};
//#endregion
export { ActionContextTypes };

//# sourceMappingURL=types.js.map