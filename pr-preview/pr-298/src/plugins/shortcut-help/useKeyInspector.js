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
var useKeyInspector = (open, bindings, onClose, capture) => {
	const $ = c(18);
	const [state, setState] = useState(EMPTY);
	const captureRef = useRef(capture ?? null);
	let t0;
	let t1;
	if ($[0] !== capture) {
		t0 = () => {
			captureRef.current = capture ?? null;
		};
		t1 = [capture];
		$[0] = capture;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	useLayoutEffect(t0, t1);
	const stateRef = useRef(state);
	let t2;
	let t3;
	if ($[3] !== state) {
		t2 = () => {
			stateRef.current = state;
		};
		t3 = [state];
		$[3] = state;
		$[4] = t2;
		$[5] = t3;
	} else {
		t2 = $[4];
		t3 = $[5];
	}
	useLayoutEffect(t2, t3);
	let t4;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ new Set();
		$[6] = t4;
	} else t4 = $[6];
	const downWhileOpenRef = useRef(t4);
	const [prevOpen, setPrevOpen] = useState(open);
	const [prevBindings, setPrevBindings] = useState(bindings);
	if (prevOpen !== open || prevBindings !== bindings) {
		setPrevOpen(open);
		setPrevBindings(bindings);
		setState(EMPTY);
	}
	let t5;
	let t6;
	if ($[7] !== open) {
		t5 = () => {
			if (!open) return;
			downWhileOpenRef.current = /* @__PURE__ */ new Set();
			cancelArmedHolds();
		};
		t6 = [open];
		$[7] = open;
		$[8] = t5;
		$[9] = t6;
	} else {
		t5 = $[8];
		t6 = $[9];
	}
	useEffect(t5, t6);
	let t7;
	let t8;
	if ($[10] !== bindings || $[11] !== onClose || $[12] !== open) {
		t7 = () => {
			if (!open) return;
			const clearPartial = () => {
				setState(_temp);
			};
			const onKeydown = (rawEvent) => {
				rawEvent.stopPropagation();
				if (!rawEvent.repeat) downWhileOpenRef.current.add(physicalKeyId(rawEvent));
				const capturing = captureRef.current;
				if (capturing) {
					rawEvent.preventDefault();
					if (rawEvent.repeat) return;
					if (rawEvent.key === "Escape") {
						capturing.onCancel();
						return;
					}
					if (isModifierOnly(rawEvent)) {
						const partial = modifierPreview(rawEvent);
						setState((s_0) => ({
							...s_0,
							partial
						}));
						return;
					}
					const chord = chordFromEvent(rawEvent);
					if (chord) capturing.onChord(chord);
					return;
				}
				if (isCopyChord(rawEvent) && hasTextSelection()) return;
				rawEvent.preventDefault();
				if (rawEvent.repeat) return;
				const event = withRecoveredLetterKey(rawEvent);
				if (isModifierOnly(event)) {
					const partial_0 = modifierPreview(event);
					setState((s_1) => ({
						...s_1,
						partial: partial_0
					}));
					return;
				}
				if (event.key === "Escape") {
					const s_2 = stateRef.current;
					if (s_2.pressed.length > 0 || s_2.matches || s_2.pendingMatches || s_2.unmatched || s_2.partial) setState(EMPTY);
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
		t8 = [
			open,
			bindings,
			onClose
		];
		$[10] = bindings;
		$[11] = onClose;
		$[12] = open;
		$[13] = t7;
		$[14] = t8;
	} else {
		t7 = $[13];
		t8 = $[14];
	}
	useEffect(t7, t8);
	let t9;
	if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = (binding) => {
			setState({
				...EMPTY,
				matches: [binding]
			});
		};
		$[15] = t9;
	} else t9 = $[15];
	const selectBinding = t9;
	let t10;
	if ($[16] !== state) {
		t10 = {
			state,
			selectBinding
		};
		$[16] = state;
		$[17] = t10;
	} else t10 = $[17];
	return t10;
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