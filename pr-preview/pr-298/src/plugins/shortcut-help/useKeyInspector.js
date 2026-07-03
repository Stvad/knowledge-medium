import { withRecoveredLetterKey } from "../../shortcuts/utils.js";
import { cancelArmedHolds } from "../../shortcuts/holdRegistry.js";
import { chordFromEvent, isMacPlatform, isModifierOnly, modifierPreview } from "../keybindings-settings/keyCapture.js";
import { matchPressedSequence } from "./model.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/shortcut-help/useKeyInspector.ts
/**
* Key interception for the shortcut-help overlay.
*
* While the overlay is open a capture-phase window listener swallows every
* keydown (`stopPropagation` before the coordinator's bubble-phase
* listeners, `preventDefault` against native fallbacks), so pressing a
* chord INSPECTS it instead of running it — including chords the modal
* shadowing would otherwise let through (global Cmd+K etc.). This is the
* same "raw window listener for a keyboard-capture surface" pattern the
* reconciler's hold-binding observer uses; it is not a new UI event bus.
*
* Keyups are swallowed ONLY for keys pressed while the overlay was open.
* A release of a key held from BEFORE opening propagates on purpose: it
* terminates a gesture already in flight — a `phase: 'keyup'` commit (date
* scrub) or a hold observer's cancel-on-release — which would otherwise
* wedge. Armed-but-unfired hold timers can't be cancelled by a keyup we
* never see, so opening also cancels them explicitly via the reconciler's
* hold registry.
*
* Pressed events accumulate into a sequence buffer matched via
* `matchPressedSequence` (tinykeys' own matcher, for dispatch parity):
* exact completions surface as `matches`, live prefixes narrow the overlay
* to `pendingMatches` (which-key), and a chord bound to nothing flashes as
* `unmatched`. Escape clears any of that first, then closes. The buffer is
* held indefinitely (no 1s dispatch-style timeout) — the popup exists to
* let you read the continuations.
*
* One escape hatch from the swallow: the platform copy chord with a live
* text selection keeps its native default, so the handler-source panel is
* copyable.
*/
var EMPTY = {
	pressed: [],
	matches: null,
	pendingMatches: null,
	unmatched: null,
	partial: null
};
/** The platform copy chord (⌘C / Ctrl+C), with no other modifiers. */
var isCopyChord = (event) => event.key.toLowerCase() === "c" && !event.shiftKey && !event.altKey && (isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
var hasTextSelection = () => {
	const selection = window.getSelection();
	return Boolean(selection && !selection.isCollapsed);
};
/** Stable physical id for pairing a keyup with its keydown. `code` is
*  layout- and modifier-independent; `key` is the fallback where `code`
*  is unavailable (some test environments). */
var physicalKeyId = (event) => event.code || event.key;
var useKeyInspector = (open, bindings, onClose) => {
	const $ = c(15);
	const [state, setState] = useState(EMPTY);
	const stateRef = useRef(state);
	let t0;
	let t1;
	if ($[0] !== state) {
		t0 = () => {
			stateRef.current = state;
		};
		t1 = [state];
		$[0] = state;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	useLayoutEffect(t0, t1);
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ new Set();
		$[3] = t2;
	} else t2 = $[3];
	const downWhileOpenRef = useRef(t2);
	const [prevOpen, setPrevOpen] = useState(open);
	const [prevBindings, setPrevBindings] = useState(bindings);
	if (prevOpen !== open || prevBindings !== bindings) {
		setPrevOpen(open);
		setPrevBindings(bindings);
		setState(EMPTY);
	}
	let t3;
	let t4;
	if ($[4] !== open) {
		t3 = () => {
			if (!open) return;
			downWhileOpenRef.current = /* @__PURE__ */ new Set();
			cancelArmedHolds();
		};
		t4 = [open];
		$[4] = open;
		$[5] = t3;
		$[6] = t4;
	} else {
		t3 = $[5];
		t4 = $[6];
	}
	useEffect(t3, t4);
	let t5;
	let t6;
	if ($[7] !== bindings || $[8] !== onClose || $[9] !== open) {
		t5 = () => {
			if (!open) return;
			const clearPartial = () => {
				setState(_temp);
			};
			const onKeydown = (rawEvent) => {
				rawEvent.stopPropagation();
				if (!rawEvent.repeat) downWhileOpenRef.current.add(physicalKeyId(rawEvent));
				if (isCopyChord(rawEvent) && hasTextSelection()) return;
				rawEvent.preventDefault();
				if (rawEvent.repeat) return;
				const event = withRecoveredLetterKey(rawEvent);
				if (isModifierOnly(event)) {
					const partial = modifierPreview(event);
					setState((s_0) => ({
						...s_0,
						partial
					}));
					return;
				}
				if (event.key === "Escape") {
					const s_1 = stateRef.current;
					if (s_1.pressed.length > 0 || s_1.matches || s_1.pendingMatches || s_1.unmatched || s_1.partial) setState(EMPTY);
					else onClose();
					return;
				}
				const display = chordFromEvent(event);
				if (!display) return;
				const nextPressed = [...stateRef.current.pressed, {
					event,
					display
				}];
				let attempt = nextPressed;
				let lookup = matchPressedSequence(bindings, attempt.map(_temp2));
				while (lookup.exact.length === 0 && lookup.pending.length === 0 && attempt.length > 1) {
					attempt = attempt.slice(1);
					lookup = matchPressedSequence(bindings, attempt.map(_temp3));
				}
				const { exact, pending } = lookup;
				if (exact.length === 0 && pending.length === 0) {
					setState({
						...EMPTY,
						unmatched: nextPressed.map(_temp4)
					});
					return;
				}
				setState({
					pressed: pending.length > 0 ? attempt : [],
					matches: exact.length > 0 ? exact : null,
					pendingMatches: pending.length > 0 ? pending : null,
					unmatched: null,
					partial: null
				});
			};
			const onKeyup = (event_0) => {
				if (downWhileOpenRef.current.delete(physicalKeyId(event_0))) event_0.stopPropagation();
				if (isModifierOnly(event_0)) clearPartial();
			};
			const onBlur = () => clearPartial();
			window.addEventListener("keydown", onKeydown, { capture: true });
			window.addEventListener("keyup", onKeyup, { capture: true });
			window.addEventListener("blur", onBlur);
			return () => {
				window.removeEventListener("keydown", onKeydown, { capture: true });
				window.removeEventListener("keyup", onKeyup, { capture: true });
				window.removeEventListener("blur", onBlur);
			};
		};
		t6 = [
			open,
			bindings,
			onClose
		];
		$[7] = bindings;
		$[8] = onClose;
		$[9] = open;
		$[10] = t5;
		$[11] = t6;
	} else {
		t5 = $[10];
		t6 = $[11];
	}
	useEffect(t5, t6);
	let t7;
	if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = (binding) => {
			setState({
				...EMPTY,
				matches: [binding]
			});
		};
		$[12] = t7;
	} else t7 = $[12];
	const selectBinding = t7;
	let t8;
	if ($[13] !== state) {
		t8 = {
			state,
			selectBinding
		};
		$[13] = state;
		$[14] = t8;
	} else t8 = $[14];
	return t8;
};
function _temp(s) {
	return s.partial ? {
		...s,
		partial: null
	} : s;
}
function _temp2(p) {
	return p.event;
}
function _temp3(p_0) {
	return p_0.event;
}
function _temp4(p_1) {
	return p_1.display;
}
//#endregion
export { useKeyInspector };

//# sourceMappingURL=useKeyInspector.js.map