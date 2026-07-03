import { actionsFacet } from "../../extensions/core.js";
import { matchKeybindingPress, parseKeybinding } from "../../../node_modules/tinykeys/dist/tinykeys.js";
import { toChordArray } from "../../shortcuts/canonicalizeChord.js";
import { compareContexts, computeInstallableContexts } from "../../shortcuts/resolve.js";
import { actionRuntimeKey } from "../../shortcuts/effectiveActions.js";
//#region src/plugins/shortcut-help/model.ts
/**
* Pure model for the shortcut-help overlay (the Doom-style `?` popup).
*
* Two responsibilities, both DOM-free so they unit-test without a browser:
*
*  - `buildShortcutHelpModel` — flatten the effective action list into
*    per-active-context groups of keyboard bindings, ordered by the SAME
*    precedence core the dispatcher uses (`compareContexts`), with modal
*    shadowing marked via `computeInstallableContexts`. The overlay is a
*    truthful mirror of what a keypress would actually do, not a separate
*    hand-maintained cheat sheet.
*
*  - `matchPressedSequence` — sequence-aware lookup of a pressed-events
*    buffer against those bindings: exact completions plus the bindings the
*    buffer is a proper prefix of (the which-key narrowing for `g g`-style
*    sequence chords).
*
* Matching runs each binding through tinykeys' OWN `parseKeybinding` /
* `matchKeybindingPress` against the real KeyboardEvents — the same parser
* and matcher the coordinator's installed matchers use — so chord identity
* agrees with dispatch by construction (`event.code` fallback for
* `Backquote`-style bindings, `$mod` platform resolution, exact modifier
* sets). Canonical chord strings (`chordFromEvent`) are display-only.
*
* Deliberate approximations, documented rather than simulated: dispatch-time
* gates that need live deps (`canDispatch`, deps resolution, a handler's
* sync-`false` decline) and per-context `eventFilter`s are ignored — the
* popup answers "what is this chord bound to", not "would it no-op right
* now". The inspector also holds a sequence prefix indefinitely while the
* real dispatcher times sequences out after ~1s: the popup exists to let
* you READ the continuations, so it deliberately does not race you.
*/
var buildShortcutHelpModel = (actions, ctx, sourceByActionKey) => {
	const { active, contextConfigsByType } = ctx;
	const installable = computeInstallableContexts(active, contextConfigsByType);
	const shadower = Array.from(installable).map((type) => contextConfigsByType.get(type)).find((config) => config?.modal === true);
	const orderedTypes = Array.from(active.keys()).sort((a, b) => compareContexts(a, b, ctx));
	const groups = [];
	for (const type of orderedTypes) {
		const config = contextConfigsByType.get(type);
		if (!config || config.keyboardBindable === false) continue;
		const shadowed = !installable.has(type);
		const bindings = actions.filter((action) => action.context === type && action.defaultBinding).flatMap((action) => {
			const binding = action.defaultBinding;
			const phase = binding.phase ?? "keydown";
			const source = sourceByActionKey?.get(actionRuntimeKey(action));
			return toChordArray(binding.keys).flatMap((chord) => {
				const presses = parseKeybinding(chord);
				if (phase === "hold" && presses.length > 1) return [];
				return [{
					action,
					contextConfig: config,
					chord,
					presses,
					phase,
					...binding.phase === "hold" ? { holdMs: binding.holdMs } : {},
					shadowed,
					...source ? { source } : {}
				}];
			});
		});
		groups.push({
			config,
			shadowed,
			...shadowed && shadower ? { shadowedBy: shadower.displayName } : {},
			bindings
		});
	}
	return {
		groups,
		bindings: groups.flatMap((g) => g.bindings)
	};
};
/** `actionRuntimeKey` → contributing plugin id, from the raw `actionsFacet`
*  contributions. Effective actions are rewritten copies (transform +
*  override passes), so attribution matches on the context-qualified id,
*  not object identity. Known limits: last write wins if two plugins
*  contribute the same context:id, and a transform that REWRITES an
*  action's id/context loses attribution (no in-tree transform does). */
var actionSourcesFromRuntime = (runtime) => {
	const out = /* @__PURE__ */ new Map();
	for (const contribution of runtime.contributionsById(actionsFacet.id)) {
		if (!contribution.source) continue;
		out.set(actionRuntimeKey(contribution.value), contribution.source);
	}
	return out;
};
/**
* Look up a buffer of pressed KEY EVENTS against the model's bindings,
* sequence-aware. Events should be pre-processed with
* `withRecoveredLetterKey`, mirroring what the coordinator feeds its own
* matchers. Matching delegates to tinykeys' `matchKeybindingPress`, so a
* verdict here is the verdict the dispatcher's matcher would reach.
*/
var matchPressedSequence = (bindings, pressed) => {
	if (pressed.length === 0) return {
		exact: [],
		pending: []
	};
	const exact = [];
	const pending = [];
	for (const binding of bindings) {
		if (binding.presses.length < pressed.length) continue;
		if (!pressed.every((event, i) => matchKeybindingPress(event, binding.presses[i]))) continue;
		if (binding.presses.length === pressed.length) exact.push(binding);
		else pending.push(binding);
	}
	return {
		exact,
		pending
	};
};
/** Best-effort runtime description of the function a binding dispatches:
*  the effective handler's name (when it has a meaningful one) and its
*  source text. Readable in dev; reflects the minified bundle in prod —
*  still enough to recognise which code a chord lands in. */
var describeHandler = (action) => {
	const handler = action.handler;
	const name = handler.name && handler.name !== "handler" ? handler.name : void 0;
	return {
		...name ? { name } : {},
		source: handler.toString()
	};
};
//#endregion
export { actionSourcesFromRuntime, buildShortcutHelpModel, describeHandler, matchPressedSequence };

//# sourceMappingURL=model.js.map