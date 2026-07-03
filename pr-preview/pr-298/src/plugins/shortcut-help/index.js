import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appMountsFacet } from "../../extensions/core.js";
import { Keyboard } from "../../../node_modules/lucide-react/dist/esm/icons/keyboard.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { hasEditableTarget } from "../../shortcuts/utils.js";
import { shortcutHelpToggle } from "./toggleStore.js";
import { ShortcutHelpOverlay } from "./ShortcutHelpOverlay.js";
//#region src/plugins/shortcut-help/index.ts
var SHORTCUT_HELP_ACTION_ID = "shortcut_help";
var shortcutHelpMount = {
	id: "shortcut-help.overlay",
	component: ShortcutHelpOverlay
};
/** `?` opens the overlay. Both spellings are bound because tinykeys
*  modifier-matching is exact-set: `Shift+?` is what a US-style layout
*  produces (Shift+/ reports key '?'), while layouts with an unshifted
*  `?` deliver it bare.
*
*  The handler DECLINES (sync `false`) when the chord arrives from an
*  editable target. The coordinator's default typing filter alone does
*  not cover this: an active context's `eventFilter` (EDIT_MODE_CM opts
*  in every keydown inside `.cm-editor`) green-lights the WHOLE dispatch,
*  so without the decline, typing `?` in a note would open the overlay
*  and eat the character. Declining falls through to no candidate, the
*  event keeps its default, and the `?` is typed. From edit mode the
*  overlay is reached via the command palette. */
var shortcutHelpAction = {
	id: SHORTCUT_HELP_ACTION_ID,
	description: "Show keyboard shortcuts",
	context: ActionContextTypes.GLOBAL,
	icon: Keyboard,
	handler: (_deps, trigger) => {
		if (trigger instanceof KeyboardEvent && hasEditableTarget(trigger)) return false;
		shortcutHelpToggle.toggle();
	},
	defaultBinding: { keys: ["Shift+?", "?"] }
};
var shortcutHelpPlugin = systemToggle({
	id: "system:shortcut-help",
	name: "Shortcut help",
	description: "'?' overlay listing the currently-active keyboard shortcuts by context; press any chord while it's open to inspect what it would run."
}).of([appMountsFacet.of(shortcutHelpMount, { source: "shortcut-help" }), actionsFacet.of(shortcutHelpAction, { source: "shortcut-help" })]);
//#endregion
export { SHORTCUT_HELP_ACTION_ID, ShortcutHelpOverlay, shortcutHelpAction, shortcutHelpMount, shortcutHelpPlugin };

//# sourceMappingURL=index.js.map