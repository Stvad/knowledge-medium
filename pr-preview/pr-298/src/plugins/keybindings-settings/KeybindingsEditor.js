import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { actionContextsFacet } from "../../extensions/core.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { Pencil } from "../../../node_modules/lucide-react/dist/esm/icons/pencil.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { RotateCcw } from "../../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js";
import { TriangleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/triangle-alert.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { normalizeChord } from "../../shortcuts/canonicalizeChord.js";
import { applyKeybindingOverrides } from "../../shortcuts/applyKeybindingOverrides.js";
import { getActionsBeforeKeybindingOverrides } from "../../shortcuts/effectiveActions.js";
import { Kbd } from "../../components/ui/kbd.js";
import { formatChord } from "./keyCapture.js";
import { overrideEntryKey } from "./config.js";
import { findKeybindingConflicts } from "../../shortcuts/keybindingConflicts.js";
import { toFacetOverrides, withRemovedOverride, withReplacedOverride } from "./overrideStore.js";
import { KeyCaptureInput } from "./KeyCaptureInput.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/keybindings-settings/KeybindingsEditor.tsx
/**
* Property editor for `keybindings:overrides`.
*
* Lists every action the runtime knows about, grouped by context.
* Each row shows the action's current effective binding (taking the
* unsaved `value` into account, not just the runtime-committed state)
* with edit / reset / disable affordances. A separate section at the
* bottom collects actions whose effective binding is undefined — the
* user can assign a chord there to give the action a shortcut.
*
* The editor is purely a view over `value` + the action registry: every
* mutation calls `onChange(nextValue)` which writes the prefs block.
* The subscription effect then mirrors the new value into the cache
* and dispatches `refreshAppRuntime`, after which `HotkeyReconciler`
* picks up the new bindings via the next `getEffectiveActions` pass.
*/
var chordOf = (action) => {
	const binding = action.defaultBinding;
	if (!binding) return null;
	return Array.isArray(binding.keys) ? binding.keys[0] ?? null : binding.keys;
};
var isOverridden = (stored, actionId, context) => {
	const key = overrideEntryKey(context, actionId);
	return stored.some((e) => overrideEntryKey(e.context, e.actionId) === key);
};
var KeybindingsEditor = (t0) => {
	const $ = c(70);
	const { value, onChange } = t0;
	const runtime = useAppRuntime();
	let t1;
	if ($[0] !== runtime) {
		t1 = runtime.read(actionContextsFacet);
		$[0] = runtime;
		$[1] = t1;
	} else t1 = $[1];
	const contextConfigs = t1;
	let set;
	if ($[2] !== contextConfigs) {
		set = /* @__PURE__ */ new Set();
		for (const c of contextConfigs) if (c.keyboardBindable === false) set.add(c.type);
		$[2] = contextConfigs;
		$[3] = set;
	} else set = $[3];
	const nonBindableContexts = set;
	let t2;
	if ($[4] !== nonBindableContexts || $[5] !== runtime) {
		let t3;
		if ($[7] !== nonBindableContexts) {
			t3 = (a) => !nonBindableContexts.has(a.context);
			$[7] = nonBindableContexts;
			$[8] = t3;
		} else t3 = $[8];
		t2 = getActionsBeforeKeybindingOverrides(runtime).filter(t3);
		$[4] = nonBindableContexts;
		$[5] = runtime;
		$[6] = t2;
	} else t2 = $[6];
	const baseActions = t2;
	let map;
	if ($[9] !== contextConfigs) {
		map = /* @__PURE__ */ new Map();
		for (const c_0 of contextConfigs) map.set(c_0.type, c_0.displayName);
		$[9] = contextConfigs;
		$[10] = map;
	} else map = $[10];
	const contextDisplay = map;
	let t3;
	if ($[11] !== value) {
		t3 = toFacetOverrides(value);
		$[11] = value;
		$[12] = t3;
	} else t3 = $[12];
	const facetEntries = t3;
	let t4;
	if ($[13] !== baseActions || $[14] !== facetEntries) {
		t4 = applyKeybindingOverrides(baseActions, facetEntries);
		$[13] = baseActions;
		$[14] = facetEntries;
		$[15] = t4;
	} else t4 = $[15];
	const previewActions = t4;
	let t5;
	if ($[16] !== previewActions) {
		t5 = findKeybindingConflicts(previewActions);
		$[16] = previewActions;
		$[17] = t5;
	} else t5 = $[17];
	const conflicts = t5;
	let map_0;
	if ($[18] !== conflicts) {
		map_0 = /* @__PURE__ */ new Map();
		for (const conflict of conflicts) for (const p of conflict.actions) {
			const key = overrideEntryKey(p.context, p.actionId);
			const set_0 = map_0.get(key) ?? /* @__PURE__ */ new Set();
			set_0.add(conflict.chord);
			map_0.set(key, set_0);
		}
		$[18] = conflicts;
		$[19] = map_0;
	} else map_0 = $[19];
	const conflictChordsByAction = map_0;
	const [search, setSearch] = useState("");
	const [capturing, setCapturing] = useState(null);
	let t6;
	if ($[20] !== search) {
		t6 = (action) => {
			const q = search.trim().toLowerCase();
			if (!q) return true;
			return action.id.toLowerCase().includes(q) || action.description.toLowerCase().includes(q);
		};
		$[20] = search;
		$[21] = t6;
	} else t6 = $[21];
	const matchesSearch = t6;
	let t7;
	if ($[22] !== matchesSearch || $[23] !== previewActions) {
		const withBinding = [];
		const withoutBinding = [];
		for (const action_0 of previewActions) {
			if (!matchesSearch(action_0)) continue;
			if (action_0.defaultBinding) withBinding.push(action_0);
			else withoutBinding.push(action_0);
		}
		const groups = /* @__PURE__ */ new Map();
		for (const action_1 of withBinding) {
			const bucket = groups.get(action_1.context) ?? [];
			bucket.push(action_1);
			groups.set(action_1.context, bucket);
		}
		for (const bucket_0 of groups.values()) bucket_0.sort(_temp);
		withoutBinding.sort(_temp2);
		t7 = {
			groups,
			withoutBinding
		};
		$[22] = matchesSearch;
		$[23] = previewActions;
		$[24] = t7;
	} else t7 = $[24];
	const sections = t7;
	let t8;
	if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = (action_2) => {
			setCapturing({
				actionId: action_2.id,
				context: action_2.context,
				pending: null
			});
		};
		$[25] = t8;
	} else t8 = $[25];
	const handleStartCapture = t8;
	let t9;
	if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = () => setCapturing(null);
		$[26] = t9;
	} else t9 = $[26];
	const handleCancelCapture = t9;
	let t10;
	if ($[27] !== capturing || $[28] !== onChange || $[29] !== value) {
		t10 = (chord) => {
			if (!capturing) return;
			const normalized = normalizeChord(chord);
			onChange(withReplacedOverride(value, {
				actionId: capturing.actionId,
				context: capturing.context,
				binding: { keys: normalized }
			}));
			setCapturing(null);
		};
		$[27] = capturing;
		$[28] = onChange;
		$[29] = value;
		$[30] = t10;
	} else t10 = $[30];
	const handleCaptureChord = t10;
	let t11;
	if ($[31] === Symbol.for("react.memo_cache_sentinel")) {
		t11 = (chord_0) => {
			setCapturing((prev) => prev ? {
				...prev,
				pending: chord_0
			} : prev);
		};
		$[31] = t11;
	} else t11 = $[31];
	const handlePartialChord = t11;
	let t12;
	if ($[32] !== onChange || $[33] !== value) {
		t12 = (actionId, context) => {
			onChange(withRemovedOverride(value, actionId, context));
		};
		$[32] = onChange;
		$[33] = value;
		$[34] = t12;
	} else t12 = $[34];
	const handleReset = t12;
	let t13;
	if ($[35] !== onChange || $[36] !== value) {
		t13 = (actionId_0, context_0) => {
			onChange(withReplacedOverride(value, {
				actionId: actionId_0,
				context: context_0,
				binding: { unbound: true }
			}));
		};
		$[35] = onChange;
		$[36] = value;
		$[37] = t13;
	} else t13 = $[37];
	const handleDisable = t13;
	let t14;
	if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
		t14 = (event) => setSearch(event.target.value);
		$[38] = t14;
	} else t14 = $[38];
	let t15;
	if ($[39] !== search) {
		t15 = /* @__PURE__ */ jsx(Input, {
			value: search,
			onChange: t14,
			placeholder: "Filter actions…"
		});
		$[39] = search;
		$[40] = t15;
	} else t15 = $[40];
	let t16;
	if ($[41] !== capturing || $[42] !== conflictChordsByAction || $[43] !== contextDisplay || $[44] !== handleCaptureChord || $[45] !== handleDisable || $[46] !== handleReset || $[47] !== sections.groups || $[48] !== value) {
		let t17;
		if ($[50] !== capturing || $[51] !== conflictChordsByAction || $[52] !== contextDisplay || $[53] !== handleCaptureChord || $[54] !== handleDisable || $[55] !== handleReset || $[56] !== value) {
			t17 = (t18) => {
				const [context_1, actions] = t18;
				return /* @__PURE__ */ jsx(Section, {
					title: contextDisplay.get(context_1) ?? context_1,
					children: actions.map((action_3) => /* @__PURE__ */ jsx(ActionRow, {
						action: action_3,
						chord: chordOf(action_3),
						overridden: isOverridden(value, action_3.id, action_3.context),
						conflictChords: conflictChordsByAction.get(overrideEntryKey(action_3.context, action_3.id)),
						capturing: capturing?.actionId === action_3.id && capturing.context === action_3.context ? capturing : null,
						onStartCapture: () => handleStartCapture(action_3),
						onCaptureChord: handleCaptureChord,
						onPartial: handlePartialChord,
						onCancelCapture: handleCancelCapture,
						onReset: () => handleReset(action_3.id, action_3.context),
						onDisable: () => handleDisable(action_3.id, action_3.context)
					}, overrideEntryKey(action_3.context, action_3.id)))
				}, context_1);
			};
			$[50] = capturing;
			$[51] = conflictChordsByAction;
			$[52] = contextDisplay;
			$[53] = handleCaptureChord;
			$[54] = handleDisable;
			$[55] = handleReset;
			$[56] = value;
			$[57] = t17;
		} else t17 = $[57];
		t16 = [...sections.groups.entries()].sort(_temp3).map(t17);
		$[41] = capturing;
		$[42] = conflictChordsByAction;
		$[43] = contextDisplay;
		$[44] = handleCaptureChord;
		$[45] = handleDisable;
		$[46] = handleReset;
		$[47] = sections.groups;
		$[48] = value;
		$[49] = t16;
	} else t16 = $[49];
	let t17;
	if ($[58] !== capturing || $[59] !== contextDisplay || $[60] !== handleCaptureChord || $[61] !== handleDisable || $[62] !== handleReset || $[63] !== sections.withoutBinding || $[64] !== value) {
		t17 = sections.withoutBinding.length > 0 && /* @__PURE__ */ jsx(Section, {
			title: "Without shortcut",
			children: sections.withoutBinding.map((action_4) => /* @__PURE__ */ jsx(ActionRow, {
				action: action_4,
				chord: null,
				overridden: isOverridden(value, action_4.id, action_4.context),
				conflictChords: void 0,
				capturing: capturing?.actionId === action_4.id && capturing.context === action_4.context ? capturing : null,
				onStartCapture: () => handleStartCapture(action_4),
				onCaptureChord: handleCaptureChord,
				onPartial: handlePartialChord,
				onCancelCapture: handleCancelCapture,
				onReset: () => handleReset(action_4.id, action_4.context),
				onDisable: () => handleDisable(action_4.id, action_4.context),
				variant: "empty",
				contextLabel: contextDisplay.get(action_4.context) ?? action_4.context
			}, overrideEntryKey(action_4.context, action_4.id)))
		});
		$[58] = capturing;
		$[59] = contextDisplay;
		$[60] = handleCaptureChord;
		$[61] = handleDisable;
		$[62] = handleReset;
		$[63] = sections.withoutBinding;
		$[64] = value;
		$[65] = t17;
	} else t17 = $[65];
	let t18;
	if ($[66] !== t15 || $[67] !== t16 || $[68] !== t17) {
		t18 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-4",
			children: [
				t15,
				t16,
				t17
			]
		});
		$[66] = t15;
		$[67] = t16;
		$[68] = t17;
		$[69] = t18;
	} else t18 = $[69];
	return t18;
};
var Section = (t0) => {
	const $ = c(7);
	const { title, children } = t0;
	let t1;
	if ($[0] !== title) {
		t1 = /* @__PURE__ */ jsx("h3", {
			className: "text-xs font-semibold uppercase text-muted-foreground",
			children: title
		});
		$[0] = title;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== children) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: "divide-y divide-border/40 rounded border border-border/40",
			children
		});
		$[2] = children;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== t1 || $[5] !== t2) {
		t3 = /* @__PURE__ */ jsxs("section", {
			className: "space-y-1",
			children: [t1, t2]
		});
		$[4] = t1;
		$[5] = t2;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
var ActionRow = (t0) => {
	const $ = c(28);
	const { action, chord, overridden, conflictChords, capturing, variant, contextLabel, onStartCapture, onCaptureChord, onPartial, onCancelCapture, onReset, onDisable } = t0;
	let t1;
	if ($[0] !== action.description) {
		t1 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: action.description
		});
		$[0] = action.description;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== contextLabel || $[3] !== variant) {
		t2 = variant === "empty" && contextLabel && /* @__PURE__ */ jsxs("span", {
			className: "text-xs text-muted-foreground",
			children: ["· ", contextLabel]
		});
		$[2] = contextLabel;
		$[3] = variant;
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] !== t1 || $[6] !== t2) {
		t3 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-1 truncate text-sm",
			children: [t1, t2]
		});
		$[5] = t1;
		$[6] = t2;
		$[7] = t3;
	} else t3 = $[7];
	let t4;
	if ($[8] !== action.id) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: "truncate text-xs text-muted-foreground",
			children: action.id
		});
		$[8] = action.id;
		$[9] = t4;
	} else t4 = $[9];
	let t5;
	if ($[10] !== t3 || $[11] !== t4) {
		t5 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 flex-1",
			children: [t3, t4]
		});
		$[10] = t3;
		$[11] = t4;
		$[12] = t5;
	} else t5 = $[12];
	let t6;
	if ($[13] !== capturing || $[14] !== chord || $[15] !== conflictChords || $[16] !== onCancelCapture || $[17] !== onCaptureChord || $[18] !== onDisable || $[19] !== onPartial || $[20] !== onReset || $[21] !== onStartCapture || $[22] !== overridden || $[23] !== variant) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "flex shrink-0 items-center gap-1",
			children: capturing ? /* @__PURE__ */ jsx(KeyCaptureInput, {
				pending: capturing.pending,
				onCapture: onCaptureChord,
				onPartial,
				onCancel: onCancelCapture
			}) : /* @__PURE__ */ jsxs(Fragment$1, { children: [
				chord ? /* @__PURE__ */ jsx(Kbd, { children: formatChord(chord) }) : /* @__PURE__ */ jsx("span", {
					className: "text-xs text-muted-foreground",
					children: "—"
				}),
				conflictChords && conflictChords.size > 0 && /* @__PURE__ */ jsx("span", {
					className: "inline-flex items-center text-amber-600",
					title: `Shadows in ${[...conflictChords].map(formatChord).join(", ")} — both will run`,
					children: /* @__PURE__ */ jsx(TriangleAlert, { className: "h-3.5 w-3.5" })
				}),
				/* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "icon",
					onClick: onStartCapture,
					title: variant === "empty" ? "Add binding" : "Change binding",
					children: variant === "empty" ? /* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ jsx(Pencil, { className: "h-3.5 w-3.5" })
				}),
				overridden && /* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "icon",
					onClick: onReset,
					title: "Reset to default",
					children: /* @__PURE__ */ jsx(RotateCcw, { className: "h-3.5 w-3.5" })
				}),
				chord && /* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "icon",
					onClick: onDisable,
					title: "Disable shortcut",
					children: /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" })
				})
			] })
		});
		$[13] = capturing;
		$[14] = chord;
		$[15] = conflictChords;
		$[16] = onCancelCapture;
		$[17] = onCaptureChord;
		$[18] = onDisable;
		$[19] = onPartial;
		$[20] = onReset;
		$[21] = onStartCapture;
		$[22] = overridden;
		$[23] = variant;
		$[24] = t6;
	} else t6 = $[24];
	let t7;
	if ($[25] !== t5 || $[26] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-2 px-2 py-1.5",
			children: [t5, t6]
		});
		$[25] = t5;
		$[26] = t6;
		$[27] = t7;
	} else t7 = $[27];
	return t7;
};
function _temp(a_0, b) {
	return a_0.description.localeCompare(b.description);
}
function _temp2(a_1, b_0) {
	return a_1.description.localeCompare(b_0.description);
}
function _temp3(t0, t1) {
	const [a_2] = t0;
	const [b_1] = t1;
	return a_2 < b_1 ? -1 : a_2 > b_1 ? 1 : 0;
}
//#endregion
export { KeybindingsEditor };

//# sourceMappingURL=KeybindingsEditor.js.map