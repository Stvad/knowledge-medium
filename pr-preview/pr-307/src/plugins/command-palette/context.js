import { Block } from "../../data/block.js";
//#region src/plugins/command-palette/context.ts
var COMMAND_PALETTE_CONTEXT = "command-palette";
var COMMAND_PALETTE_ACTION_ID = "command_palette";
var COMMAND_PALETTE_FOR_BLOCK_ACTION_ID = "command_palette_for_block";
var isCommandPaletteDependencies = (deps) => typeof deps === "object" && deps !== null && "uiStateBlock" in deps && deps.uiStateBlock instanceof Block;
var commandPaletteActionContext = {
	type: COMMAND_PALETTE_CONTEXT,
	displayName: "Command Palette",
	modal: true,
	validateDependencies: isCommandPaletteDependencies
};
//#endregion
export { COMMAND_PALETTE_ACTION_ID, COMMAND_PALETTE_CONTEXT, COMMAND_PALETTE_FOR_BLOCK_ACTION_ID, commandPaletteActionContext };

//# sourceMappingURL=context.js.map