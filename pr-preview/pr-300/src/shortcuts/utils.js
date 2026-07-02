import { ActionContextTypes } from "./types.js";
import { withMoveTransition } from "../utils/viewTransition.js";
import { invokeAction } from "./actionDispatch.js";
//#region src/shortcuts/utils.ts
var hasEditableTarget = (event) => {
	const target = event.target;
	if (!target) return false;
	return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
};
/**
* True for keyboard events shaped like "the user is typing into an editable
* field" — no chord-modifiers (Ctrl/Alt/Meta). Shift is permitted because
* it's part of producing capital letters and shifted symbols.
*
* Used by the default hotkeys-js event filter ([HotkeyReconciler.tsx]) to
* suppress shortcut handlers for bare `p`, `P` (= shift+p), `!` (= shift+1),
* Enter, Tab, etc. when focus is in an input. Modifier-bearing chords like
* `cmd+p` are NOT typing and stay unblocked — the user pressed those to
* address the app, not the input.
*/
var isTypingKeyEvent = (event) => !event.ctrlKey && !event.altKey && !event.metaKey;
/**
* Recover the logical letter of a keyboard event when an Alt or Meta
* modifier has corrupted `event.key`.
*
* `event.key` is unreliable for letter-keys under Alt/Meta:
*   - macOS option-transforms (Alt+y → '¥', Alt+z → 'Ω', …) on every layout.
*   - Linux xkb compose / dead-key setups that emit composing chars
*     when Alt is held.
*
* `event.code` is layout-INdependent — it reports the QWERTY-position
* id ('KeyY') even when the user is on Colemak/Dvorak. So matching on
* `event.code === 'KeyY'` works on Mac QWERTY but not on Mac Colemak,
* where the user's logical 'y' sits at the physical KeyO position.
*
* `event.keyCode` is what hotkeys-js used to get right. Modern browsers
* populate it for printable letters with the *logical* letter's char
* code — i.e. the letter the layout produces, derived before any
* modifier-induced transformation. So a Mac Colemak user pressing
* Alt+y gives `event.keyCode = 89` ('Y') regardless of `event.key`
* being a transformed glyph and `event.code` reporting KeyO.
*
* This helper returns the event unchanged when no recovery is needed,
* or a Proxy that overrides `event.key` with the recovered lowercase
* letter. Proxy (not spread/clone) so `getModifierState` and other
* prototype methods stay callable for tinykeys' matcher.
*
* Scope: letters only (`keyCode` in [65,90]) and only when Alt or
* Meta is held. Digit/punctuation keyCodes are layout-dependent in a
* way keyCode can't recover; those bindings use Digit{N} / code-form
* chord strings.
*/
var ASCII_A = 65;
var ASCII_Z = 90;
var withRecoveredLetterKey = (event) => {
	if (!event.altKey && !event.metaKey) return event;
	const keyCode = event.keyCode;
	if (keyCode < ASCII_A || keyCode > ASCII_Z) return event;
	const recovered = String.fromCharCode(keyCode).toLowerCase();
	if (event.key.toLowerCase() === recovered) return event;
	return new Proxy(event, { get(target, prop) {
		if (prop === "key") return recovered;
		const value = Reflect.get(target, prop);
		return typeof value === "function" ? value.bind(target) : value;
	} });
};
/**
* Creates a multi-select version of an action that applies the original action to each selected block.
* Uses makeModeAction under the hood with a specialized handler override.
*/
var applyToAllBlocksInSelection = (actionConfig, { applyInReverseOrder } = { applyInReverseOrder: false }) => {
	const multiSelectHandler = async (multiSelectDeps, trigger) => {
		const { selectedBlocks, uiStateBlock, scopeRootId } = multiSelectDeps;
		const blocks = applyInReverseOrder ? selectedBlocks.toReversed() : selectedBlocks;
		console.log(`[makeMultiSelect] Running action for ${blocks.length} blocks`);
		const runtime = uiStateBlock.repo.facetRuntime;
		await withMoveTransition(async () => {
			for (const block of blocks) {
				const originalDeps = {
					block,
					uiStateBlock,
					scopeRootId
				};
				await (runtime ? invokeAction(runtime, {
					action: actionConfig,
					deps: originalDeps,
					trigger
				}) : actionConfig.handler(originalDeps, trigger));
			}
		});
	};
	return makeMultiSelect({
		...actionConfig,
		description: `${actionConfig.description} (Multiple Blocks)`,
		handler: multiSelectHandler
	});
};
/**
* Creates a higher-order function that transforms an action config for a specific mode.
* This allows creating mode-specific action transformers like makeNormalMode, makeVisualMode, etc.
*
* @param mode The mode context type to transform the action into
* @param idPrefix The prefix to add to the action ID (e.g. 'normal', 'visual', etc)
* @returns A function that transforms an action config for the specified mode
*/
var makeModeAction = (mode, idPrefix) => {
	return (actionConfig) => ({
		...actionConfig,
		id: `${idPrefix}.${actionConfig.id}`,
		context: mode
	});
};
var makeNormalMode = makeModeAction(ActionContextTypes.NORMAL_MODE, "normal");
var makeCMMode = makeModeAction(ActionContextTypes.EDIT_MODE_CM, "edit.cm");
var makeMultiSelect = makeModeAction(ActionContextTypes.MULTI_SELECT_MODE, "multi_select");
/** Prefix used for the MULTI_SELECT_MODE variant's id. Mirrors the
*  prefix emitted by `makeMultiSelect`, so an existing multi-select
*  surface wired up via either path keeps the same id shape. */
var MULTI_SELECT_ID_PREFIX = "multi_select";
var multiSelectActionId = (baseId) => `${MULTI_SELECT_ID_PREFIX}.${baseId}`;
/** Pair an "operation over a set of blocks" with the two natural
*  action contexts: NORMAL_MODE (focused block as a one-element set)
*  and MULTI_SELECT_MODE (the current selection).
*
*  Reach for this when the operation collects shared user input
*  ONCE (a dialog asking for parameters, a confirm step, …) and
*  then applies the result to every block in the set.
*
*  Why not `applyToAllBlocksInSelection`: that wrapper invokes the
*  per-block handler N times for an N-block selection, which would
*  prompt the user N times for any operation that opens a dialog
*  in its handler. This helper passes the whole set into a single
*  `flow` call instead.
*
*  The two variants get distinct ids (NORMAL: `id`, MULTI_SELECT:
*  `multi_select.<id>`) because the command palette dispatches by
*  id alone — `getActiveActionById` picks the most-recently-active
*  matching context — so a shared id can route a click on the
*  "block" row to the multi-select handler when both contexts are
*  active. Distinct ids keep each row's behaviour grounded in the
*  context it advertises. */
var defineBlocksAction = ({ id, icon, blockDescription, blocksDescription, appliesTo, flow }) => ({
	block: {
		id,
		description: blockDescription,
		context: ActionContextTypes.NORMAL_MODE,
		...icon ? { icon } : {},
		...appliesTo ? { isVisible: ({ block }) => appliesTo(block) } : {},
		handler: ({ block }) => flow([block])
	},
	blocks: {
		id: multiSelectActionId(id),
		description: blocksDescription,
		context: ActionContextTypes.MULTI_SELECT_MODE,
		...icon ? { icon } : {},
		isVisible: ({ selectedBlocks }) => {
			if (selectedBlocks.length === 0) return false;
			if (!appliesTo) return true;
			return selectedBlocks.some((block) => appliesTo(block));
		},
		handler: ({ selectedBlocks }) => flow(selectedBlocks)
	}
});
//#endregion
export { applyToAllBlocksInSelection, defineBlocksAction, hasEditableTarget, isTypingKeyEvent, makeCMMode, makeModeAction, makeMultiSelect, makeNormalMode, multiSelectActionId, withRecoveredLetterKey };

//# sourceMappingURL=utils.js.map