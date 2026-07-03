import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { keybindingOverridesFacet } from "../../shortcuts/keybindingOverrides.js";
import { getEffectiveActions } from "../../shortcuts/effectiveActions.js";
import { contextConfigsByTypeFrom } from "../../shortcuts/runAction.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Kbd } from "../../components/ui/kbd.js";
import { useEditModeYieldKeepalive } from "../../components/useEditModeYieldKeepalive.js";
import { formatChord } from "../keybindings-settings/keyCapture.js";
import { actionSourcesFromRuntime, buildShortcutHelpModel, describeHandler } from "./model.js";
import { shortcutHelpToggle } from "./toggleStore.js";
import { useKeyInspector } from "./useKeyInspector.js";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/shortcut-help/ShortcutHelpOverlay.tsx
var PHASE_LABELS = {
	keyup: "on release",
	hold: "hold"
};
var NO_BINDINGS = [];
var PhaseBadge = (t0) => {
	const $ = c(2);
	const { binding } = t0;
	if (binding.phase === "keydown") return null;
	const label = binding.phase === "hold" && binding.holdMs !== void 0 ? `${PHASE_LABELS.hold} ${binding.holdMs}ms` : PHASE_LABELS[binding.phase];
	let t1;
	if ($[0] !== label) {
		t1 = /* @__PURE__ */ jsx("span", {
			className: "rounded border px-1 py-0.5 text-[10px] text-muted-foreground",
			children: label
		});
		$[0] = label;
		$[1] = t1;
	} else t1 = $[1];
	return t1;
};
var BindingChord = (t0) => {
	const $ = c(9);
	const { binding } = t0;
	let t1;
	if ($[0] !== binding) {
		t1 = /* @__PURE__ */ jsx(PhaseBadge, { binding });
		$[0] = binding;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== binding.chord) {
		t2 = formatChord(binding.chord);
		$[2] = binding.chord;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== t2) {
		t3 = /* @__PURE__ */ jsx(Kbd, { children: t2 });
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== t1 || $[7] !== t3) {
		t4 = /* @__PURE__ */ jsxs("span", {
			className: "flex shrink-0 items-center gap-1",
			children: [t1, t3]
		});
		$[6] = t1;
		$[7] = t3;
		$[8] = t4;
	} else t4 = $[8];
	return t4;
};
/** One row per ACTION: all of its chords rendered together (matching the
*  command palette's presentation), clicking inspects the first one. */
var ActionRow = (t0) => {
	const $ = c(13);
	const { bindings, onSelect } = t0;
	let t1;
	if ($[0] !== bindings[0] || $[1] !== onSelect) {
		t1 = () => onSelect(bindings[0]);
		$[0] = bindings[0];
		$[1] = onSelect;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== bindings[0].action.description) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: bindings[0].action.description
		});
		$[3] = bindings[0].action.description;
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] !== bindings) {
		t3 = bindings.map(_temp);
		$[5] = bindings;
		$[6] = t3;
	} else t3 = $[6];
	let t4;
	if ($[7] !== t3) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "flex shrink-0 items-center gap-1",
			children: t3
		});
		$[7] = t3;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[9] !== t1 || $[10] !== t2 || $[11] !== t4) {
		t5 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: t1,
			className: "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground",
			children: [t2, t4]
		});
		$[9] = t1;
		$[10] = t2;
		$[11] = t4;
		$[12] = t5;
	} else t5 = $[12];
	return t5;
};
/** Bucket a group's per-chord bindings back into per-action rows, keeping
*  the group's order. */
var rowsOf = (group) => {
	const rows = /* @__PURE__ */ new Map();
	for (const binding of group.bindings) {
		const row = rows.get(binding.action) ?? [];
		row.push(binding);
		rows.set(binding.action, row);
	}
	return Array.from(rows.values());
};
var ContextGroupSection = (t0) => {
	const $ = c(17);
	const { group, onSelect } = t0;
	let t1;
	if ($[0] !== group.shadowed || $[1] !== group.shadowedBy) {
		t1 = group.shadowed && /* @__PURE__ */ jsxs("span", {
			className: "rounded border px-1 py-0.5 text-[10px] font-normal normal-case",
			title: "A modal context holds the keyboard: these chords won't fire until it closes.",
			children: ["shadowed", group.shadowedBy ? ` by ${group.shadowedBy}` : ""]
		});
		$[0] = group.shadowed;
		$[1] = group.shadowedBy;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== group.config.displayName || $[4] !== t1) {
		t2 = /* @__PURE__ */ jsxs("h3", {
			className: "mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
			children: [group.config.displayName, t1]
		});
		$[3] = group.config.displayName;
		$[4] = t1;
		$[5] = t2;
	} else t2 = $[5];
	const t3 = group.shadowed ? "opacity-60" : void 0;
	let t4;
	if ($[6] !== group || $[7] !== onSelect) {
		let t5;
		if ($[9] !== onSelect) {
			t5 = (bindings) => /* @__PURE__ */ jsx(ActionRow, {
				bindings,
				onSelect
			}, bindings[0].action.id);
			$[9] = onSelect;
			$[10] = t5;
		} else t5 = $[10];
		t4 = rowsOf(group).map(t5);
		$[6] = group;
		$[7] = onSelect;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[11] !== t3 || $[12] !== t4) {
		t5 = /* @__PURE__ */ jsx("div", {
			className: t3,
			children: t4
		});
		$[11] = t3;
		$[12] = t4;
		$[13] = t5;
	} else t5 = $[13];
	let t6;
	if ($[14] !== t2 || $[15] !== t5) {
		t6 = /* @__PURE__ */ jsxs("section", {
			className: "mb-3 break-inside-avoid",
			children: [t2, t5]
		});
		$[14] = t2;
		$[15] = t5;
		$[16] = t6;
	} else t6 = $[16];
	return t6;
};
/** Detail card for the chord the user just pressed (or the row they
*  clicked): the winning action plus any lower-precedence/shadowed
*  candidates for the same chord, with the handler's source on demand. */
var MatchPanel = (t0) => {
	const $ = c(34);
	const { matches } = t0;
	let t1;
	if ($[0] !== matches) {
		t1 = matches.find(_temp2) ?? matches[0];
		$[0] = matches;
		$[1] = t1;
	} else t1 = $[1];
	const winner = t1;
	let t2;
	if ($[2] !== matches || $[3] !== winner) {
		let t3;
		if ($[5] !== winner) {
			t3 = (binding_0) => binding_0 !== winner;
			$[5] = winner;
			$[6] = t3;
		} else t3 = $[6];
		const others = matches.filter(t3);
		let t4;
		if ($[7] !== winner.action) {
			t4 = describeHandler(winner.action);
			$[7] = winner.action;
			$[8] = t4;
		} else t4 = $[8];
		const handler = t4;
		let t5;
		if ($[9] !== winner.action.description) {
			t5 = /* @__PURE__ */ jsx("span", {
				className: "text-sm font-medium",
				children: winner.action.description
			});
			$[9] = winner.action.description;
			$[10] = t5;
		} else t5 = $[10];
		let t6;
		if ($[11] !== winner) {
			t6 = /* @__PURE__ */ jsx(BindingChord, { binding: winner });
			$[11] = winner;
			$[12] = t6;
		} else t6 = $[12];
		let t7;
		if ($[13] !== t5 || $[14] !== t6) {
			t7 = /* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-2",
				children: [t5, t6]
			});
			$[13] = t5;
			$[14] = t6;
			$[15] = t7;
		} else t7 = $[15];
		let t8;
		if ($[16] !== winner.action.id) {
			t8 = /* @__PURE__ */ jsx("code", { children: winner.action.id });
			$[16] = winner.action.id;
			$[17] = t8;
		} else t8 = $[17];
		let t9;
		if ($[18] !== winner.source) {
			t9 = winner.source && /* @__PURE__ */ jsxs(Fragment$1, { children: [
				" · ",
				"from ",
				/* @__PURE__ */ jsx("code", { children: winner.source })
			] });
			$[18] = winner.source;
			$[19] = t9;
		} else t9 = $[19];
		let t10;
		if ($[20] !== winner.shadowed) {
			t10 = winner.shadowed && /* @__PURE__ */ jsxs(Fragment$1, { children: [" · ", "shadowed — would not fire right now"] });
			$[20] = winner.shadowed;
			$[21] = t10;
		} else t10 = $[21];
		let t11;
		if ($[22] !== t10 || $[23] !== t8 || $[24] !== t9 || $[25] !== winner.contextConfig.displayName) {
			t11 = /* @__PURE__ */ jsxs("div", {
				className: "mt-1 text-xs text-muted-foreground",
				children: [
					winner.contextConfig.displayName,
					" · ",
					"action ",
					t8,
					t9,
					t10
				]
			});
			$[22] = t10;
			$[23] = t8;
			$[24] = t9;
			$[25] = winner.contextConfig.displayName;
			$[26] = t11;
		} else t11 = $[26];
		const t12 = handler.name ? ` — ${handler.name}()` : "";
		let t13;
		if ($[27] !== t12) {
			t13 = /* @__PURE__ */ jsxs("summary", {
				className: "cursor-pointer text-xs text-muted-foreground",
				children: ["Handler source", t12]
			});
			$[27] = t12;
			$[28] = t13;
		} else t13 = $[28];
		let t14;
		if ($[29] !== handler.source) {
			t14 = /* @__PURE__ */ jsx("pre", {
				className: "mt-1 max-h-48 max-w-full overflow-auto rounded bg-muted p-2 text-[11px] leading-snug",
				children: handler.source
			});
			$[29] = handler.source;
			$[30] = t14;
		} else t14 = $[30];
		let t15;
		if ($[31] !== t13 || $[32] !== t14) {
			t15 = /* @__PURE__ */ jsxs("details", {
				className: "mt-2",
				children: [t13, t14]
			});
			$[31] = t13;
			$[32] = t14;
			$[33] = t15;
		} else t15 = $[33];
		t2 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 rounded-md border bg-muted/40 p-3",
			children: [
				t7,
				t11,
				t15,
				others.length > 0 && /* @__PURE__ */ jsxs("div", {
					className: "mt-2 border-t pt-2 text-xs text-muted-foreground",
					children: [/* @__PURE__ */ jsx("div", {
						className: "mb-1",
						children: "Also bound to this chord:"
					}), others.map(_temp3)]
				})
			]
		});
		$[2] = matches;
		$[3] = winner;
		$[4] = t2;
	} else t2 = $[4];
	return t2;
};
function ShortcutHelpOverlay() {
	const open = useSyncExternalStore(shortcutHelpToggle.subscribe, shortcutHelpToggle.isOpen, shortcutHelpToggle.isOpen);
	const runtime = useAppRuntime();
	const active = useActiveContextsState();
	useEditModeYieldKeepalive(open);
	const [overridesGeneration, setOverridesGeneration] = useState(0);
	useEffect(() => {
		return runtime.onFacetChange(keybindingOverridesFacet.id, () => {
			setOverridesGeneration((g) => g + 1);
		});
	}, [runtime]);
	const model = useMemo(() => {
		if (!open) return null;
		return buildShortcutHelpModel(getEffectiveActions(runtime), {
			active,
			contextConfigsByType: contextConfigsByTypeFrom(runtime)
		}, actionSourcesFromRuntime(runtime));
	}, [
		open,
		runtime,
		active,
		overridesGeneration
	]);
	const { state, selectBinding } = useKeyInspector(open, model?.bindings ?? NO_BINDINGS, shortcutHelpToggle.close);
	const visibleGroups = useMemo(() => {
		if (!model) return [];
		if (!state.pendingMatches) return model.groups.filter((group) => group.bindings.length > 0);
		const pendingSet = new Set(state.pendingMatches);
		return model.groups.map((group) => ({
			...group,
			bindings: group.bindings.filter((b) => pendingSet.has(b))
		})).filter((group) => group.bindings.length > 0);
	}, [model, state.pendingMatches]);
	const status = state.partial ? /* @__PURE__ */ jsxs("span", { children: [
		"Holding ",
		/* @__PURE__ */ jsx(Kbd, { children: formatChord(state.partial) }),
		"…"
	] }) : state.pressed.length > 0 ? /* @__PURE__ */ jsxs("span", { children: [
		"Pending sequence ",
		/* @__PURE__ */ jsx(Kbd, { children: state.pressed.map((p) => formatChord(p.display)).join(" ") }),
		" — showing continuations"
	] }) : state.unmatched ? /* @__PURE__ */ jsxs("span", { children: ["Nothing bound to ", /* @__PURE__ */ jsx(Kbd, { children: state.unmatched.map(formatChord).join(" ") })] }) : /* @__PURE__ */ jsx("span", { children: "Press any key combo to inspect it. Esc clears, then closes." });
	return /* @__PURE__ */ jsx(Dialog, {
		open,
		onOpenChange: shortcutHelpToggle.set,
		children: /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-2xl",
			children: [
				/* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: "Keyboard shortcuts" }), /* @__PURE__ */ jsx(DialogDescription, { children: status })] }),
				state.matches && /* @__PURE__ */ jsx(MatchPanel, { matches: state.matches }),
				/* @__PURE__ */ jsx("div", {
					className: "min-w-0 max-h-[60vh] overflow-y-auto sm:columns-2 sm:gap-6",
					children: visibleGroups.map((group) => /* @__PURE__ */ jsx(ContextGroupSection, {
						group,
						onSelect: selectBinding
					}, group.config.type))
				})
			]
		})
	});
}
function _temp(binding, index) {
	return /* @__PURE__ */ jsx(BindingChord, { binding }, index);
}
function _temp2(binding) {
	return !binding.shadowed;
}
function _temp3(binding_1, index) {
	return /* @__PURE__ */ jsxs("div", {
		className: "flex items-center justify-between gap-2 py-0.5",
		children: [/* @__PURE__ */ jsxs("span", {
			className: "truncate",
			children: [
				binding_1.action.description,
				" · ",
				binding_1.contextConfig.displayName,
				binding_1.shadowed ? " (shadowed)" : ""
			]
		}), /* @__PURE__ */ jsx(BindingChord, { binding: binding_1 })]
	}, `${binding_1.action.id}:${index}`);
}
//#endregion
export { ShortcutHelpOverlay };

//# sourceMappingURL=ShortcutHelpOverlay.js.map