import { Button } from "../../components/ui/button.js";
import { useRepo } from "../../context/repo.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { Pencil } from "../../../node_modules/lucide-react/dist/esm/icons/pencil.js";
import { RotateCcw } from "../../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js";
import { TriangleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/triangle-alert.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { keybindingOverridesFacet } from "../../shortcuts/keybindingOverrides.js";
import { normalizeChord } from "../../shortcuts/canonicalizeChord.js";
import { getActionsBeforeKeybindingOverrides, getEffectiveActions } from "../../shortcuts/effectiveActions.js";
import { contextConfigsByTypeFrom, runActionById } from "../../shortcuts/runAction.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Kbd } from "../../components/ui/kbd.js";
import { useEditModeYieldKeepalive } from "../../components/useEditModeYieldKeepalive.js";
import { formatChord } from "../keybindings-settings/keyCapture.js";
import { overrideEntryKey } from "../keybindings-settings/config.js";
import { openKeybindingsSettingsAction } from "../keybindings-settings/actions.js";
import { previewOverrideConflicts, readStoredOverrides, removeKeybindingOverride, setKeybindingOverride } from "../keybindings-settings/overrideStore.js";
import { actionSourcesFromRuntime, buildShortcutHelpModel, describeHandler } from "./model.js";
import { shortcutHelpToggle } from "./toggleStore.js";
import { useKeyInspector } from "./useKeyInspector.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/shortcut-help/ShortcutHelpOverlay.tsx
var PHASE_LABELS = {
	keyup: "on release",
	hold: "hold"
};
var NO_BINDINGS = [];
var NO_OVERRIDES = /* @__PURE__ */ new Set();
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
*  candidates for the same chord, with the handler's source on demand and
*  rebind / reset / unbind affordances that write the user's overrides. */
var MatchPanel = (t0) => {
	const $ = c(38);
	const { matches, capturing, partial, overriddenKeys, actions, onCancelCapture } = t0;
	let t1;
	if ($[0] !== actions || $[1] !== capturing || $[2] !== matches || $[3] !== onCancelCapture || $[4] !== overriddenKeys || $[5] !== partial) {
		const winner = matches.find(_temp2) ?? matches[0];
		const others = matches.filter((binding_0) => binding_0 !== winner);
		const handler = describeHandler(winner.action);
		const action = winner.action;
		const isCapturing = capturing?.actionId === action.id && capturing.context === action.context;
		const overridden = overriddenKeys.has(overrideEntryKey(action.context, action.id));
		let t2;
		if ($[7] !== action) {
			t2 = /* @__PURE__ */ jsx("span", {
				className: "text-sm font-medium",
				children: action.description
			});
			$[7] = action;
			$[8] = t2;
		} else t2 = $[8];
		let t3;
		if ($[9] !== action || $[10] !== actions || $[11] !== isCapturing || $[12] !== onCancelCapture || $[13] !== overridden || $[14] !== partial || $[15] !== winner) {
			t3 = isCapturing ? /* @__PURE__ */ jsxs("span", {
				className: "flex shrink-0 items-center gap-2 text-xs",
				children: [partial ? /* @__PURE__ */ jsxs(Kbd, { children: [formatChord(partial), "…"] }) : /* @__PURE__ */ jsx("span", {
					className: "text-muted-foreground",
					children: "Press a key…"
				}), /* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					onClick: onCancelCapture,
					children: "Cancel"
				})]
			}) : /* @__PURE__ */ jsxs("span", {
				className: "flex shrink-0 items-center gap-1",
				children: [
					/* @__PURE__ */ jsx(BindingChord, { binding: winner }),
					/* @__PURE__ */ jsx(Button, {
						type: "button",
						variant: "ghost",
						size: "icon",
						title: "Rebind",
						onClick: () => actions.onRebind(action.id, action.context, action.description),
						children: /* @__PURE__ */ jsx(Pencil, { className: "h-3.5 w-3.5" })
					}),
					overridden && /* @__PURE__ */ jsx(Button, {
						type: "button",
						variant: "ghost",
						size: "icon",
						title: "Reset to default",
						onClick: () => actions.onReset(action.id, action.context, action.description),
						children: /* @__PURE__ */ jsx(RotateCcw, { className: "h-3.5 w-3.5" })
					}),
					/* @__PURE__ */ jsx(Button, {
						type: "button",
						variant: "ghost",
						size: "icon",
						title: "Remove shortcut",
						onClick: () => actions.onUnbind(action.id, action.context, action.description),
						children: /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" })
					})
				]
			});
			$[9] = action;
			$[10] = actions;
			$[11] = isCapturing;
			$[12] = onCancelCapture;
			$[13] = overridden;
			$[14] = partial;
			$[15] = winner;
			$[16] = t3;
		} else t3 = $[16];
		let t4;
		if ($[17] !== t2 || $[18] !== t3) {
			t4 = /* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-2",
				children: [t2, t3]
			});
			$[17] = t2;
			$[18] = t3;
			$[19] = t4;
		} else t4 = $[19];
		let t5;
		if ($[20] !== action) {
			t5 = /* @__PURE__ */ jsx("code", { children: action.id });
			$[20] = action;
			$[21] = t5;
		} else t5 = $[21];
		let t6;
		if ($[22] !== winner) {
			t6 = winner.source && /* @__PURE__ */ jsxs(Fragment$1, { children: [
				" · ",
				"from ",
				/* @__PURE__ */ jsx("code", { children: winner.source })
			] });
			$[22] = winner;
			$[23] = t6;
		} else t6 = $[23];
		let t7;
		if ($[24] !== winner) {
			t7 = winner.shadowed && /* @__PURE__ */ jsxs(Fragment$1, { children: [" · ", "shadowed — would not fire right now"] });
			$[24] = winner;
			$[25] = t7;
		} else t7 = $[25];
		let t8;
		if ($[26] !== t5 || $[27] !== t6 || $[28] !== t7 || $[29] !== winner) {
			t8 = /* @__PURE__ */ jsxs("div", {
				className: "mt-1 text-xs text-muted-foreground",
				children: [
					winner.contextConfig.displayName,
					" · ",
					"action ",
					t5,
					t6,
					t7
				]
			});
			$[26] = t5;
			$[27] = t6;
			$[28] = t7;
			$[29] = winner;
			$[30] = t8;
		} else t8 = $[30];
		const t9 = handler.name ? ` — ${handler.name}()` : "";
		let t10;
		if ($[31] !== t9) {
			t10 = /* @__PURE__ */ jsxs("summary", {
				className: "cursor-pointer text-xs text-muted-foreground",
				children: ["Handler source", t9]
			});
			$[31] = t9;
			$[32] = t10;
		} else t10 = $[32];
		let t11;
		if ($[33] !== handler) {
			t11 = /* @__PURE__ */ jsx("pre", {
				className: "mt-1 max-h-48 max-w-full overflow-auto rounded bg-muted p-2 text-[11px] leading-snug",
				children: handler.source
			});
			$[33] = handler;
			$[34] = t11;
		} else t11 = $[34];
		let t12;
		if ($[35] !== t10 || $[36] !== t11) {
			t12 = /* @__PURE__ */ jsxs("details", {
				className: "mt-2",
				children: [t10, t11]
			});
			$[35] = t10;
			$[36] = t11;
			$[37] = t12;
		} else t12 = $[37];
		t1 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 rounded-md border bg-muted/40 p-3",
			children: [
				t4,
				t8,
				t12,
				others.length > 0 && /* @__PURE__ */ jsxs("div", {
					className: "mt-2 border-t pt-2 text-xs text-muted-foreground",
					children: [/* @__PURE__ */ jsx("div", {
						className: "mb-1",
						children: "Also bound to this chord:"
					}), others.map(_temp3)]
				})
			]
		});
		$[0] = actions;
		$[1] = capturing;
		$[2] = matches;
		$[3] = onCancelCapture;
		$[4] = overriddenKeys;
		$[5] = partial;
		$[6] = t1;
	} else t1 = $[6];
	return t1;
};
/** Names of the OTHER actions a proposed binding would also fire. */
var conflictPeers = (conflicts, self) => {
	const names = /* @__PURE__ */ new Set();
	for (const conflict of conflicts) for (const participant of conflict.actions) {
		if (participant.actionId === self.actionId && participant.context === self.context) continue;
		names.add(participant.description);
	}
	return [...names];
};
var NoticeBanner = (t0) => {
	const $ = c(41);
	const { notice, onReset, onOpenSettings, onDismiss } = t0;
	let t1;
	let t2;
	let t3;
	if ($[0] !== notice || $[1] !== onDismiss) {
		const peers = notice.kind === "bound" ? conflictPeers(notice.conflicts, notice) : [];
		t1 = "min-w-0 rounded-md border bg-muted/40 p-3 text-sm";
		let t4;
		if ($[5] !== notice.chord || $[6] !== notice.description || $[7] !== notice.kind) {
			t4 = notice.kind === "bound" && /* @__PURE__ */ jsxs("span", { children: [
				"Bound ",
				/* @__PURE__ */ jsx(Kbd, { children: formatChord(notice.chord) }),
				" to ",
				/* @__PURE__ */ jsx("span", {
					className: "font-medium",
					children: notice.description
				}),
				"."
			] });
			$[5] = notice.chord;
			$[6] = notice.description;
			$[7] = notice.kind;
			$[8] = t4;
		} else t4 = $[8];
		let t5;
		if ($[9] !== notice.description || $[10] !== notice.kind) {
			t5 = notice.kind === "reset" && /* @__PURE__ */ jsxs("span", { children: [
				"Restored the default shortcut for ",
				/* @__PURE__ */ jsx("span", {
					className: "font-medium",
					children: notice.description
				}),
				"."
			] });
			$[9] = notice.description;
			$[10] = notice.kind;
			$[11] = t5;
		} else t5 = $[11];
		let t6;
		if ($[12] !== notice.description || $[13] !== notice.kind) {
			t6 = notice.kind === "unbound" && /* @__PURE__ */ jsxs("span", { children: [
				"Removed the shortcut for ",
				/* @__PURE__ */ jsx("span", {
					className: "font-medium",
					children: notice.description
				}),
				"."
			] });
			$[12] = notice.description;
			$[13] = notice.kind;
			$[14] = t6;
		} else t6 = $[14];
		let t7;
		if ($[15] !== notice.description || $[16] !== notice.kind) {
			t7 = notice.kind === "error" && /* @__PURE__ */ jsxs("span", {
				className: "text-destructive",
				children: [
					"Couldn't update ",
					/* @__PURE__ */ jsx("span", {
						className: "font-medium",
						children: notice.description
					}),
					" — see the console."
				]
			});
			$[15] = notice.description;
			$[16] = notice.kind;
			$[17] = t7;
		} else t7 = $[17];
		let t8;
		if ($[18] !== t4 || $[19] !== t5 || $[20] !== t6 || $[21] !== t7) {
			t8 = /* @__PURE__ */ jsxs("div", {
				className: "min-w-0",
				children: [
					t4,
					t5,
					t6,
					t7
				]
			});
			$[18] = t4;
			$[19] = t5;
			$[20] = t6;
			$[21] = t7;
			$[22] = t8;
		} else t8 = $[22];
		let t9;
		if ($[23] === Symbol.for("react.memo_cache_sentinel")) {
			t9 = /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" });
			$[23] = t9;
		} else t9 = $[23];
		let t10;
		if ($[24] !== onDismiss) {
			t10 = /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				size: "icon",
				title: "Dismiss",
				onClick: onDismiss,
				children: t9
			});
			$[24] = onDismiss;
			$[25] = t10;
		} else t10 = $[25];
		if ($[26] !== t10 || $[27] !== t8) {
			t2 = /* @__PURE__ */ jsxs("div", {
				className: "flex items-start justify-between gap-2",
				children: [t8, t10]
			});
			$[26] = t10;
			$[27] = t8;
			$[28] = t2;
		} else t2 = $[28];
		t3 = peers.length > 0 && /* @__PURE__ */ jsxs("div", {
			className: "mt-2 flex items-start gap-1.5 text-xs text-amber-600",
			children: [/* @__PURE__ */ jsx(TriangleAlert, { className: "mt-0.5 h-3.5 w-3.5 shrink-0" }), /* @__PURE__ */ jsxs("span", { children: [
				"Also fires ",
				peers.join(", "),
				" — both handlers run on this chord."
			] })]
		});
		$[0] = notice;
		$[1] = onDismiss;
		$[2] = t1;
		$[3] = t2;
		$[4] = t3;
	} else {
		t1 = $[2];
		t2 = $[3];
		t3 = $[4];
	}
	let t4;
	if ($[29] !== notice.actionId || $[30] !== notice.context || $[31] !== notice.description || $[32] !== notice.kind || $[33] !== onOpenSettings || $[34] !== onReset) {
		t4 = notice.kind === "bound" && /* @__PURE__ */ jsxs("div", {
			className: "mt-2 flex items-center gap-3 text-xs",
			children: [/* @__PURE__ */ jsx("button", {
				type: "button",
				className: "underline hover:no-underline",
				onClick: () => onReset(notice.actionId, notice.context, notice.description),
				children: "Reset to default"
			}), /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "underline hover:no-underline",
				onClick: onOpenSettings,
				children: "Open keyboard settings"
			})]
		});
		$[29] = notice.actionId;
		$[30] = notice.context;
		$[31] = notice.description;
		$[32] = notice.kind;
		$[33] = onOpenSettings;
		$[34] = onReset;
		$[35] = t4;
	} else t4 = $[35];
	let t5;
	if ($[36] !== t1 || $[37] !== t2 || $[38] !== t3 || $[39] !== t4) {
		t5 = /* @__PURE__ */ jsxs("div", {
			className: t1,
			children: [
				t2,
				t3,
				t4
			]
		});
		$[36] = t1;
		$[37] = t2;
		$[38] = t3;
		$[39] = t4;
		$[40] = t5;
	} else t5 = $[40];
	return t5;
};
function ShortcutHelpOverlay() {
	const open = useSyncExternalStore(shortcutHelpToggle.subscribe, shortcutHelpToggle.isOpen, shortcutHelpToggle.isOpen);
	const runtime = useAppRuntime();
	const repo = useRepo();
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
	const overriddenKeys = useMemo(() => {
		if (!open) return NO_OVERRIDES;
		const set = /* @__PURE__ */ new Set();
		for (const override of runtime.read(keybindingOverridesFacet)) {
			if (override.source !== "user-prefs" || !override.context) continue;
			set.add(overrideEntryKey(override.context, override.actionId));
		}
		return set;
	}, [
		open,
		runtime,
		overridesGeneration
	]);
	const [capturing, setCapturing] = useState(null);
	const [notice, setNotice] = useState(null);
	const capturingRef = useRef(null);
	useLayoutEffect(() => {
		capturingRef.current = capturing;
	}, [capturing]);
	const [prevOpen, setPrevOpen] = useState(open);
	if (prevOpen !== open) {
		setPrevOpen(open);
		if (!open) {
			setCapturing(null);
			setNotice(null);
		}
	}
	const startRebind = useCallback((actionId, context, description) => {
		setNotice(null);
		setCapturing({
			actionId,
			context,
			description
		});
	}, []);
	const cancelRebind = useCallback(() => setCapturing(null), []);
	const commitRebind = useCallback((chord) => {
		const target = capturingRef.current;
		if (!target) return;
		setCapturing(null);
		const normalized = normalizeChord(chord);
		const entry = {
			actionId: target.actionId,
			context: target.context,
			binding: { keys: normalized }
		};
		(async () => {
			try {
				const stored = await readStoredOverrides(repo);
				const conflicts = previewOverrideConflicts(getActionsBeforeKeybindingOverrides(runtime), stored, entry);
				await setKeybindingOverride(repo, entry);
				setNotice({
					kind: "bound",
					actionId: target.actionId,
					context: target.context,
					description: target.description,
					chord: normalized,
					conflicts
				});
			} catch (error) {
				console.error("shortcut-help: failed to rebind", error);
				setNotice({
					kind: "error",
					description: target.description
				});
			}
		})();
	}, [repo, runtime]);
	const resetBinding = useCallback((actionId, context, description) => {
		(async () => {
			try {
				await removeKeybindingOverride(repo, actionId, context);
				setNotice({
					kind: "reset",
					description
				});
			} catch (error) {
				console.error("shortcut-help: failed to reset binding", error);
				setNotice({
					kind: "error",
					description
				});
			}
		})();
	}, [repo]);
	const unbindBinding = useCallback((actionId, context, description) => {
		(async () => {
			try {
				await setKeybindingOverride(repo, {
					actionId,
					context,
					binding: { unbound: true }
				});
				setNotice({
					kind: "unbound",
					description
				});
			} catch (error) {
				console.error("shortcut-help: failed to remove binding", error);
				setNotice({
					kind: "error",
					description
				});
			}
		})();
	}, [repo]);
	const overrideActions = useMemo(() => ({
		onRebind: startRebind,
		onReset: resetBinding,
		onUnbind: unbindBinding
	}), [
		startRebind,
		resetBinding,
		unbindBinding
	]);
	const openSettings = useCallback(() => {
		shortcutHelpToggle.close();
		runActionById(openKeybindingsSettingsAction.id, new CustomEvent("shortcut-help-settings"));
	}, []);
	const bindings = model?.bindings ?? NO_BINDINGS;
	const capture = useMemo(() => capturing ? {
		onChord: commitRebind,
		onCancel: cancelRebind
	} : null, [
		capturing,
		commitRebind,
		cancelRebind
	]);
	const { state, selectBinding } = useKeyInspector(open, bindings, shortcutHelpToggle.close, capture);
	const visibleGroups = useMemo(() => {
		if (!model) return [];
		if (!state.pendingMatches) return model.groups.filter((group) => group.bindings.length > 0);
		const pendingSet = new Set(state.pendingMatches);
		return model.groups.map((group) => ({
			...group,
			bindings: group.bindings.filter((b) => pendingSet.has(b))
		})).filter((group) => group.bindings.length > 0);
	}, [model, state.pendingMatches]);
	const status = capturing ? /* @__PURE__ */ jsxs("span", { children: [
		"Recording a shortcut for ",
		/* @__PURE__ */ jsx("span", {
			className: "font-medium",
			children: capturing.description
		}),
		" — press a combo, Esc to cancel"
	] }) : state.partial ? /* @__PURE__ */ jsxs("span", { children: [
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
				state.matches && /* @__PURE__ */ jsx(MatchPanel, {
					matches: state.matches,
					capturing,
					partial: state.partial,
					overriddenKeys,
					actions: overrideActions,
					onCancelCapture: cancelRebind
				}),
				notice && /* @__PURE__ */ jsx(NoticeBanner, {
					notice,
					onReset: resetBinding,
					onOpenSettings: openSettings,
					onDismiss: () => setNotice(null)
				}),
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