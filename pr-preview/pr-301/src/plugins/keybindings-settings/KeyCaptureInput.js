import { Button } from "../../components/ui/button.js";
import { Kbd } from "../../components/ui/kbd.js";
import { chordFromEvent, formatChord, isMacPlatform, isModifierOnly } from "./keyCapture.js";
import { useEffect, useRef } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/keybindings-settings/KeyCaptureInput.tsx
/**
* Single-chord capture input. Mounts as a small interactive surface
* that listens for keydown, builds a tinykeys chord string via
* `chordFromEvent`, and surfaces it back to the parent via
* `onCapture`. The user confirms with the next non-modifier keypress
* (chord commits immediately) and cancels with Escape.
*
* Stops propagation on every key event while focused so the captured
* chord doesn't accidentally fire the action it's about to be bound
* to.
*/
var KeyCaptureInput = (t0) => {
	const $ = c(20);
	const { pending, onCapture, onPartial, onCancel } = t0;
	const ref = useRef(null);
	let t1;
	let t2;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = () => {
			ref.current?.focus();
		};
		t2 = [];
		$[0] = t1;
		$[1] = t2;
	} else {
		t1 = $[0];
		t2 = $[1];
	}
	useEffect(t1, t2);
	let t3;
	if ($[2] !== onCancel || $[3] !== onCapture || $[4] !== onPartial) {
		t3 = (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				onCancel();
				return;
			}
			const native = event.nativeEvent;
			if (isModifierOnly(native)) {
				const onMac = isMacPlatform();
				const primary = onMac ? native.metaKey : native.ctrlKey;
				const secondary = onMac ? native.ctrlKey : native.metaKey;
				const previewParts = [];
				if (primary) previewParts.push("$mod");
				if (secondary) previewParts.push(onMac ? "Control" : "Meta");
				if (native.altKey) previewParts.push("Alt");
				if (native.shiftKey) previewParts.push("Shift");
				onPartial(previewParts.length ? previewParts.join("+") : null);
				return;
			}
			const chord = chordFromEvent({
				key: native.key,
				code: native.code,
				keyCode: native.keyCode,
				metaKey: native.metaKey,
				ctrlKey: native.ctrlKey,
				altKey: native.altKey,
				shiftKey: native.shiftKey
			});
			if (chord) onCapture(chord);
		};
		$[2] = onCancel;
		$[3] = onCapture;
		$[4] = onPartial;
		$[5] = t3;
	} else t3 = $[5];
	const handleKeyDown = t3;
	let t4;
	if ($[6] !== onPartial) {
		t4 = (event_0) => {
			if (isModifierOnly(event_0.nativeEvent)) onPartial(null);
		};
		$[6] = onPartial;
		$[7] = t4;
	} else t4 = $[7];
	const handleKeyUp = t4;
	let t5;
	if ($[8] !== pending) {
		t5 = pending ? /* @__PURE__ */ jsxs(Kbd, { children: [formatChord(pending), "…"] }) : /* @__PURE__ */ jsx("span", {
			className: "text-muted-foreground",
			children: "Press a key…"
		});
		$[8] = pending;
		$[9] = t5;
	} else t5 = $[9];
	let t6;
	if ($[10] !== handleKeyDown || $[11] !== handleKeyUp || $[12] !== onCancel || $[13] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			ref,
			tabIndex: 0,
			onKeyDown: handleKeyDown,
			onKeyUp: handleKeyUp,
			onBlur: onCancel,
			className: "inline-flex min-h-[28px] min-w-[120px] items-center justify-center rounded border border-dashed border-primary/60 bg-primary/5 px-2 py-1 text-xs outline-none focus:border-primary",
			"aria-label": "Press a key combination",
			children: t5
		});
		$[10] = handleKeyDown;
		$[11] = handleKeyUp;
		$[12] = onCancel;
		$[13] = t5;
		$[14] = t6;
	} else t6 = $[14];
	let t7;
	if ($[15] !== onCancel) {
		t7 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "ghost",
			size: "sm",
			onClick: onCancel,
			title: "Cancel",
			children: "Cancel"
		});
		$[15] = onCancel;
		$[16] = t7;
	} else t7 = $[16];
	let t8;
	if ($[17] !== t6 || $[18] !== t7) {
		t8 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-1",
			children: [t6, t7]
		});
		$[17] = t6;
		$[18] = t7;
		$[19] = t8;
	} else t8 = $[19];
	return t8;
};
//#endregion
export { KeyCaptureInput };

//# sourceMappingURL=KeyCaptureInput.js.map