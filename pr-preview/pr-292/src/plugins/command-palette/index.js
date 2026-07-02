import { focusBlock } from "../../data/properties.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionContextsFacet, actionsFacet, appMountsFacet, headerItemsFacet } from "../../extensions/core.js";
import { Command } from "../../../node_modules/lucide-react/dist/esm/icons/command.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { quickActionItemsFacet } from "../swipe-quick-actions/actions.js";
import "../swipe-quick-actions/index.js";
import { commandPaletteToggle } from "./toggleStore.js";
import { CommandPaletteHeaderItem } from "./HeaderItem.js";
import { COMMAND_PALETTE_ACTION_ID, COMMAND_PALETTE_CONTEXT, COMMAND_PALETTE_FOR_BLOCK_ACTION_ID, commandPaletteActionContext } from "./context.js";
import { CommandPalette } from "./CommandPalette.js";
//#region src/plugins/command-palette/index.ts
var commandPaletteMount = {
	id: "command-palette.dialog",
	component: CommandPalette
};
var commandPaletteAction = {
	id: COMMAND_PALETTE_ACTION_ID,
	description: "Open command palette",
	context: ActionContextTypes.GLOBAL,
	icon: Command,
	handler: () => {
		commandPaletteToggle.toggle();
	},
	defaultBinding: { keys: "$mod+k" }
};
/** Quick-action variant that focuses the swiped block before opening the
*  palette. The palette renders against the live `useActiveContextsState`,
*  so making this block the focused-and-not-editing one ensures
*  NORMAL_MODE for it is active and the palette lists block-context
*  actions for it. `focusBlock` writes both `focusedBlockLocation` and
*  `isEditing=false` in one tx and returns the promise we await — if we
*  fired the toggle before that resolved, the palette would render
*  against the previously-focused block's NORMAL_MODE deps and any
*  command picked during that window would run on the wrong block. */
var commandPaletteForBlockAction = {
	id: COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
	description: "Open command palette",
	context: ActionContextTypes.NORMAL_MODE,
	icon: Command,
	handler: async ({ block, uiStateBlock, renderScopeId }) => {
		await focusBlock(uiStateBlock, block.id, { renderScopeId });
		commandPaletteToggle.toggle();
	}
};
var commandPaletteForBlockQuickAction = {
	actionId: COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
	label: "Commands"
};
var commandPaletteHeaderItem = {
	id: "command-palette.header",
	region: "start",
	component: CommandPaletteHeaderItem
};
var commandPalettePlugin = systemToggle({
	id: "system:command-palette",
	name: "Command palette",
	description: "Cmd+K palette listing every registered action. Kept enabled in safe mode as the recovery entry point.",
	essential: true
}).of([
	appMountsFacet.of(commandPaletteMount, { source: "command-palette" }),
	actionContextsFacet.of(commandPaletteActionContext, { source: "command-palette" }),
	actionsFacet.of(commandPaletteAction, { source: "command-palette" }),
	actionsFacet.of(commandPaletteForBlockAction, { source: "command-palette" }),
	quickActionItemsFacet.of(commandPaletteForBlockQuickAction, { source: "command-palette" }),
	headerItemsFacet.of(commandPaletteHeaderItem, {
		source: "command-palette",
		precedence: 20
	})
]);
//#endregion
export { COMMAND_PALETTE_ACTION_ID, COMMAND_PALETTE_CONTEXT, COMMAND_PALETTE_FOR_BLOCK_ACTION_ID, CommandPalette, CommandPaletteHeaderItem, commandPaletteAction, commandPaletteActionContext, commandPaletteForBlockAction, commandPaletteForBlockQuickAction, commandPaletteHeaderItem, commandPaletteMount, commandPalettePlugin };

//# sourceMappingURL=index.js.map