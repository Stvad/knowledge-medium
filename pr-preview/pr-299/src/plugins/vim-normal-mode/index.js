import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { shortcutSurfaceActivationsFacet } from "../../extensions/blockInteraction.js";
import { actionDispatchWrap } from "../../shortcuts/actionDispatch.js";
import { colemakKeybindingsPlugin } from "../colemak-keybindings/index.js";
import { vimNormalModeActionsExtension } from "./actions.js";
import { enterBlockEditModeOnGestureAction, vimClickToFocusDecorator, vimNormalModeActivation } from "./interactions.js";
//#region src/plugins/vim-normal-mode/index.ts
var vimNormalModeInteractionExtension = [
	actionDispatchWrap(vimClickToFocusDecorator, { source: "vim-normal-mode" }),
	actionsFacet.of(enterBlockEditModeOnGestureAction, { source: "vim-normal-mode" }),
	shortcutSurfaceActivationsFacet.of(vimNormalModeActivation, {
		precedence: 100,
		source: "vim-normal-mode"
	})
];
var vimNormalModePlugin = ({ repo }) => systemToggle({
	id: "system:vim-normal-mode",
	name: "Vim normal mode",
	description: "Vim-style normal-mode keybindings inside the editor.",
	defaultEnabled: false
}).of([
	vimNormalModeInteractionExtension,
	vimNormalModeActionsExtension({ repo }),
	colemakKeybindingsPlugin
]);
//#endregion
export { vimNormalModeInteractionExtension, vimNormalModePlugin };

//# sourceMappingURL=index.js.map