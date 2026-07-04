import { isRefCodec, isRefListCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
import { blockTypeLabelProp, getBlockTypes } from "../../data/properties.js";
import { Button } from "../../components/ui/button.js";
import { labelForBlockData } from "../../utils/linkTargetAutocomplete.js";
import { useRepo } from "../../context/repo.js";
import { useHandle } from "../../hooks/block.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { resolvePropertyDisplay } from "../../components/propertyEditors/defaults.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { ReferenceSearch } from "../../components/propertyEditors/RefPropertyEditor.js";
import { Label } from "../../components/ui/label.js";
import { findCandidatesByPropertyShape, retagBlocks } from "../../data/typeExtraction.js";
import { buildTypeShapeChoices } from "./PropertyShapePicker.js";
import { useEffect, useMemo, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/extract-type/FindTypeInstancesDialog.tsx
/** FindTypeInstancesDialog — "Find blocks to retag as this type."
*
*  Step 1 of the extract-type flow delegates here after creating the
*  type, and the dialog is also usable standalone on any existing
*  block-type block.
*
*  Step 1 (configure): list the type's declared properties. For each
*  picked property the user can optionally enter a value via the
*  property's normal property-panel editor (Date picker, ref
*  autocomplete, etc.). Picked properties without a value match on
*  presence only ("the property is set, any value"); picked
*  properties with a value require exact match.
*
*  Step 2 (confirm): candidate list with checkboxes — blocks whose
*  property bag covers the picked subset AND aren't already tagged
*  with this type. */
var formatCandidateLabel = (data) => {
	const content = data.content?.trim() ?? "";
	if (content.length > 0) return content;
	return `(empty block ${data.id.slice(0, 8)})`;
};
var typeLabelOf = (typeBlock) => {
	const raw = typeBlock.properties[blockTypeLabelProp.name];
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	return typeBlock.content?.trim() || `(unlabeled ${typeBlock.id.slice(0, 8)})`;
};
var isMeaningfulValue = (value) => {
	if (value === void 0 || value === null) return false;
	if (typeof value === "string") return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return true;
};
/** Normalize the user-entered editor value for a ref / refList
*  property into the array of target ids `PropertyShapeFilter.targetIds`
*  expects. Drops empties and de-dupes. */
var collectTargetIds = (value) => {
	const ids = [];
	if (typeof value === "string" && value.trim() !== "") ids.push(value.trim());
	else if (Array.isArray(value)) {
		for (const item of value) if (typeof item === "string" && item.trim() !== "") ids.push(item.trim());
	}
	return Array.from(new Set(ids));
};
/** Hard cap on candidates surfaced to the user at once. Above this
*  the picker becomes unwieldy (every row is a checkbox + live block
*  label) and we'd rather make the user narrow their filter. The cap
*  is local to this dialog — `findCandidatesByPropertyShape`'s own
*  default (1000) was too low for the retag flow and produced
*  suspicious round counts. When the result length equals the cap we
*  show an inline truncation hint. */
var CANDIDATE_DISPLAY_LIMIT = 5e3;
function FindTypeInstancesDialog({ typeBlockId, resolve, cancel }) {
	const repo = useRepo();
	const [typeBlock, setTypeBlock] = useState(null);
	const [step, setStep] = useState("configure");
	const [choices, setChoices] = useState([]);
	const [candidates, setCandidates] = useState([]);
	const [truncated, setTruncated] = useState(false);
	const [confirmed, setConfirmed] = useState(/* @__PURE__ */ new Set());
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const data = await repo.load(typeBlockId);
			if (cancelled) return;
			if (!data) {
				setError(`Type block ${typeBlockId} not found`);
				return;
			}
			setTypeBlock(data);
			setChoices(buildTypeShapeChoices(repo, data));
		})();
		return () => {
			cancelled = true;
		};
	}, [repo, typeBlockId]);
	const pickedChoices = useMemo(() => choices.filter((c) => c.picked), [choices]);
	const canSearch = pickedChoices.length > 0 && !busy;
	const canRetag = candidates.length > 0 && confirmed.size > 0 && !busy;
	const handleSearch = async () => {
		if (!typeBlock) return;
		setError(null);
		setBusy(true);
		try {
			const shape = pickedChoices.map((c_0) => {
				const schema = repo.propertySchemas.get(c_0.name);
				if (schema && (isRefCodec(schema.codec) || isRefListCodec(schema.codec))) {
					const targetIds = collectTargetIds(c_0.value);
					return targetIds.length > 0 ? {
						name: c_0.name,
						targetIds
					} : { name: c_0.name };
				}
				return isMeaningfulValue(c_0.value) ? {
					name: c_0.name,
					value: c_0.value
				} : { name: c_0.name };
			});
			const ids = await findCandidatesByPropertyShape(repo, {
				workspaceId: typeBlock.workspaceId,
				shape,
				exclude: [typeBlock.id],
				limit: CANDIDATE_DISPLAY_LIMIT
			});
			setTruncated(ids.length >= CANDIDATE_DISPLAY_LIMIT);
			const live = (await Promise.all(ids.map((id) => repo.load(id)))).filter((r) => r !== null && !getBlockTypes(r).includes(typeBlock.id));
			setCandidates(live);
			setConfirmed(new Set(live.map((r_0) => r_0.id)));
			setStep("confirm");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to find candidates");
		} finally {
			setBusy(false);
		}
	};
	const handleSubmit = async () => {
		if (!typeBlock) return;
		setError(null);
		setBusy(true);
		try {
			const instanceIds = candidates.map((c_1) => c_1.id).filter((id_0) => confirmed.has(id_0));
			if (instanceIds.length > 0) await retagBlocks(repo, {
				typeId: typeBlock.id,
				instanceIds
			});
			resolve();
		} catch (err_0) {
			setError(err_0 instanceof Error ? err_0.message : "Failed to retag");
			setBusy(false);
		}
	};
	const typeLabel = typeBlock ? typeLabelOf(typeBlock) : "";
	return /* @__PURE__ */ jsx(Dialog, {
		open: true,
		onOpenChange: (next) => {
			if (!next) cancel();
		},
		children: /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-2xl",
			children: [
				/* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: typeBlock ? `Find blocks to retag as “${typeLabel}”` : "Find blocks to retag" }), /* @__PURE__ */ jsx(DialogDescription, { children: step === "configure" ? "Pick which of this type’s properties to match on. Optionally enter a value to require exact match instead of just presence." : `Review the candidates and confirm which should be retagged as ${typeLabel}.` })] }),
				step === "configure" && typeBlock && /* @__PURE__ */ jsxs("div", {
					className: "min-w-0 space-y-4",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "space-y-2",
							children: [/* @__PURE__ */ jsx(Label, { children: "Type properties" }), choices.length === 0 ? /* @__PURE__ */ jsx("p", {
								className: "text-sm text-muted-foreground",
								children: "This type declares no user-defined properties — there’s nothing to match candidates against. Add property-schema refs to the type’s block-type:properties first."
							}) : /* @__PURE__ */ jsx(TypeInstanceRows, {
								choices,
								onChange: setChoices,
								typeBlockId: typeBlock.id,
								disabled: busy
							})]
						}),
						error && /* @__PURE__ */ jsx("p", {
							className: "text-sm text-destructive",
							children: error
						}),
						/* @__PURE__ */ jsxs(DialogFooter, { children: [/* @__PURE__ */ jsx(Button, {
							variant: "ghost",
							onClick: cancel,
							disabled: busy,
							children: "Cancel"
						}), /* @__PURE__ */ jsx(Button, {
							onClick: handleSearch,
							disabled: !canSearch,
							children: busy ? "Searching…" : "Find candidates"
						})] })
					]
				}),
				step === "confirm" && typeBlock && /* @__PURE__ */ jsxs("div", {
					className: "min-w-0 space-y-4",
					children: [
						/* @__PURE__ */ jsx("p", {
							className: "text-sm",
							children: candidates.length === 0 ? `No untagged blocks match this shape.` : `${candidates.length.toLocaleString()} block${candidates.length === 1 ? "" : "s"} match this shape and aren’t yet tagged as ${typeLabel}.`
						}),
						truncated && /* @__PURE__ */ jsxs("p", {
							className: "text-sm text-amber-600 dark:text-amber-500",
							children: [
								"More candidates exist — results were capped at ",
								CANDIDATE_DISPLAY_LIMIT.toLocaleString(),
								". Narrow the filter to see the rest."
							]
						}),
						candidates.length > 0 && /* @__PURE__ */ jsx("ul", {
							className: "max-h-72 space-y-1 overflow-auto rounded-md border p-2",
							children: candidates.map((candidate) => /* @__PURE__ */ jsxs("li", {
								className: "flex items-center gap-3 rounded px-2 py-1 hover:bg-muted/60",
								children: [/* @__PURE__ */ jsx(Checkbox, {
									id: `find-type-instances-confirm-${candidate.id}`,
									checked: confirmed.has(candidate.id),
									onCheckedChange: (next_0) => {
										setConfirmed((prev) => {
											const out = new Set(prev);
											if (next_0 === true) out.add(candidate.id);
											else out.delete(candidate.id);
											return out;
										});
									},
									disabled: busy
								}), /* @__PURE__ */ jsx(Label, {
									htmlFor: `find-type-instances-confirm-${candidate.id}`,
									className: "min-w-0 flex-1 cursor-pointer truncate text-sm",
									children: formatCandidateLabel(candidate)
								})]
							}, candidate.id))
						}),
						error && /* @__PURE__ */ jsx("p", {
							className: "text-sm text-destructive",
							children: error
						}),
						/* @__PURE__ */ jsxs(DialogFooter, { children: [/* @__PURE__ */ jsx(Button, {
							variant: "ghost",
							onClick: () => setStep("configure"),
							disabled: busy,
							children: "Back"
						}), /* @__PURE__ */ jsx(Button, {
							onClick: handleSubmit,
							disabled: busy || candidates.length > 0 && !canRetag,
							children: busy ? "Retagging…" : candidates.length === 0 ? "Done" : `Retag ${confirmed.size} block${confirmed.size === 1 ? "" : "s"}`
						})] })
					]
				})
			]
		})
	});
}
/** Row list for the find-type-instances picker. Each row is the
*  property's checkbox + name on the left, and the property-panel
*  Editor (resolved via the normal codec → preset chain) on the right
*  for capturing an optional value filter.
*
*  The Editor's `block` slot is filled with the type-block facade so
*  ref/refList editors (which need repo + workspace context) work
*  unmodified. The type block is never written to by these editors —
*  they only call our local `onChange`. */
function TypeInstanceRows(t0) {
	const $ = c(13);
	const { choices, onChange, typeBlockId, disabled } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== repo || $[1] !== typeBlockId) {
		t1 = repo.block(typeBlockId);
		$[0] = repo;
		$[1] = typeBlockId;
		$[2] = t1;
	} else t1 = $[2];
	const ownerBlock = t1;
	let t2;
	if ($[3] !== choices || $[4] !== disabled || $[5] !== onChange || $[6] !== ownerBlock || $[7] !== repo.propertyEditorOverrides || $[8] !== repo.propertySchemas || $[9] !== repo.valuePresets) {
		t2 = choices.map((choice, idx) => {
			const display = resolvePropertyDisplay({
				name: choice.name,
				encodedValue: void 0,
				schemas: repo.propertySchemas,
				uis: repo.propertyEditorOverrides,
				presets: repo.valuePresets
			});
			const Editor = display.Editor;
			const setChoice = (next) => {
				onChange(choices.map((c, i) => i === idx ? {
					...c,
					...next
				} : c));
			};
			const isRef = isRefCodec(display.schema.codec);
			const isRefList = isRefListCodec(display.schema.codec);
			return /* @__PURE__ */ jsxs("li", {
				className: "flex min-w-0 items-start gap-3 rounded px-2 py-1.5 hover:bg-muted/60",
				children: [/* @__PURE__ */ jsx(Checkbox, {
					id: `find-type-instances-pick-${idx}`,
					checked: choice.picked,
					onCheckedChange: (next_0) => setChoice({ picked: next_0 === true }),
					disabled,
					className: "mt-1.5"
				}), /* @__PURE__ */ jsxs("div", {
					className: "min-w-0 flex-1 space-y-1",
					children: [/* @__PURE__ */ jsx(Label, {
						htmlFor: `find-type-instances-pick-${idx}`,
						className: "cursor-pointer truncate font-mono text-sm",
						children: choice.name
					}), /* @__PURE__ */ jsx("div", {
						className: choice.picked ? "" : "opacity-50 pointer-events-none",
						children: isRef || isRefList ? /* @__PURE__ */ jsx(RefFilterEditor, {
							schema: display.schema,
							owner: ownerBlock,
							isList: isRefList,
							value: choice.value,
							onChange: (next_1) => setChoice({ value: next_1 })
						}) : Editor !== void 0 ? /* @__PURE__ */ jsx(Editor, {
							value: choice.value,
							onChange: (next_2) => setChoice({ value: next_2 }),
							block: ownerBlock,
							schema: display.schema
						}) : /* @__PURE__ */ jsxs("div", {
							className: "text-xs text-muted-foreground/70",
							children: [
								"No editor registered for ",
								display.shape,
								"."
							]
						})
					})]
				})]
			}, choice.name);
		});
		$[3] = choices;
		$[4] = disabled;
		$[5] = onChange;
		$[6] = ownerBlock;
		$[7] = repo.propertyEditorOverrides;
		$[8] = repo.propertySchemas;
		$[9] = repo.valuePresets;
		$[10] = t2;
	} else t2 = $[10];
	let t3;
	if ($[11] !== t2) {
		t3 = /* @__PURE__ */ jsx("ul", {
			className: "max-h-96 min-w-0 space-y-1 overflow-auto rounded-md border p-2",
			children: t2
		});
		$[11] = t2;
		$[12] = t3;
	} else t3 = $[12];
	return t3;
}
var EMPTY_IDS = Object.freeze([]);
/** Compact ref / refList editor for the filter context.
*
*  Reuses the autocomplete (`ReferenceSearch`) from the standard
*  RefPropertyEditor so users see the same blocks they'd see in any
*  other ref picker. Replaces the full `BlockEmbed` display with a
*  one-line chip per picked block — `BlockEmbed` is meant for "show me
*  this block in context" and renders an entire BlockComponent, which
*  is overkill (and visually broken) for a filter input.
*
*  `isList === false` collapses the editor to a single picked value
*  (`ref` codec); `true` accumulates a list (`refList`). The shape is
*  `string | undefined` and `readonly string[]` respectively, matching
*  what the schema codecs decode to. */
function RefFilterEditor(t0) {
	const $ = c(25);
	const { schema, owner, isList, value, onChange } = t0;
	let t1;
	bb0: {
		if (isRefCodec(schema.codec) || isRefListCodec(schema.codec)) {
			t1 = schema.codec.targetTypes;
			break bb0;
		}
		t1 = EMPTY_IDS;
	}
	const targetTypes = t1;
	let t2;
	bb1: {
		if (isList) {
			let t3;
			if ($[0] !== value) {
				t3 = Array.isArray(value) ? value.filter(_temp) : EMPTY_IDS;
				$[0] = value;
				$[1] = t3;
			} else t3 = $[1];
			t2 = t3;
			break bb1;
		}
		let t3;
		if ($[2] !== value) {
			t3 = typeof value === "string" && value.length > 0 ? [value] : EMPTY_IDS;
			$[2] = value;
			$[3] = t3;
		} else t3 = $[3];
		t2 = t3;
	}
	const pickedIds = t2;
	let t3;
	if ($[4] !== isList || $[5] !== onChange || $[6] !== pickedIds) {
		t3 = (id) => {
			if (isList) onChange(pickedIds.filter((x) => x !== id));
			else onChange("");
		};
		$[4] = isList;
		$[5] = onChange;
		$[6] = pickedIds;
		$[7] = t3;
	} else t3 = $[7];
	const removeId = t3;
	let t4;
	if ($[8] !== isList || $[9] !== onChange || $[10] !== pickedIds) {
		t4 = (id_0) => {
			if (isList) {
				if (pickedIds.includes(id_0)) return;
				onChange([...pickedIds, id_0]);
			} else onChange(id_0);
		};
		$[8] = isList;
		$[9] = onChange;
		$[10] = pickedIds;
		$[11] = t4;
	} else t4 = $[11];
	const addId = t4;
	const showPicker = isList || pickedIds.length === 0;
	let t5;
	if ($[12] !== pickedIds || $[13] !== removeId) {
		t5 = pickedIds.length > 0 && /* @__PURE__ */ jsx("div", {
			className: "flex flex-wrap gap-1.5",
			children: pickedIds.map((id_1) => /* @__PURE__ */ jsx(RefChip, {
				blockId: id_1,
				onRemove: () => removeId(id_1)
			}, id_1))
		});
		$[12] = pickedIds;
		$[13] = removeId;
		$[14] = t5;
	} else t5 = $[14];
	let t6;
	if ($[15] !== addId || $[16] !== isList || $[17] !== owner || $[18] !== pickedIds || $[19] !== showPicker || $[20] !== targetTypes) {
		t6 = showPicker && /* @__PURE__ */ jsx(ReferenceSearch, {
			owner,
			excludeIds: pickedIds,
			targetTypes,
			placeholder: "Search blocks",
			selectionMode: isList ? "multiple" : "single",
			onPick: addId
		});
		$[15] = addId;
		$[16] = isList;
		$[17] = owner;
		$[18] = pickedIds;
		$[19] = showPicker;
		$[20] = targetTypes;
		$[21] = t6;
	} else t6 = $[21];
	let t7;
	if ($[22] !== t5 || $[23] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 space-y-1.5",
			children: [t5, t6]
		});
		$[22] = t5;
		$[23] = t6;
		$[24] = t7;
	} else t7 = $[24];
	return t7;
}
/** One-line chip showing the picked block's label + remove button.
*  Reactive: re-renders if the referenced block's content/aliases
*  change while the dialog is open. */
function _temp(v) {
	return typeof v === "string";
}
function RefChip(t0) {
	const $ = c(16);
	const { blockId, onRemove } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== blockId || $[1] !== repo) {
		t1 = repo.block(blockId);
		$[0] = blockId;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const handle = t1;
	let t2;
	if ($[3] !== blockId) {
		t2 = { selector: (data) => labelForBlockData(data, `(${blockId.slice(0, 8)})`) };
		$[3] = blockId;
		$[4] = t2;
	} else t2 = $[4];
	const label = useHandle(handle, t2);
	let t3;
	if ($[5] !== label) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: "min-w-0 truncate",
			title: label,
			children: label
		});
		$[5] = label;
		$[6] = t3;
	} else t3 = $[6];
	const t4 = `Remove ${label}`;
	let t5;
	if ($[7] !== onRemove) {
		t5 = (event) => {
			event.preventDefault();
			event.stopPropagation();
			onRemove();
		};
		$[7] = onRemove;
		$[8] = t5;
	} else t5 = $[8];
	let t6;
	if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx(X, { className: "h-3 w-3" });
		$[9] = t6;
	} else t6 = $[9];
	let t7;
	if ($[10] !== t4 || $[11] !== t5) {
		t7 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "shrink-0 rounded-sm text-muted-foreground hover:text-destructive",
			"aria-label": t4,
			onClick: t5,
			children: t6
		});
		$[10] = t4;
		$[11] = t5;
		$[12] = t7;
	} else t7 = $[12];
	let t8;
	if ($[13] !== t3 || $[14] !== t7) {
		t8 = /* @__PURE__ */ jsxs("span", {
			className: "inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-sm",
			children: [t3, t7]
		});
		$[13] = t3;
		$[14] = t7;
		$[15] = t8;
	} else t8 = $[15];
	return t8;
}
//#endregion
export { FindTypeInstancesDialog };

//# sourceMappingURL=FindTypeInstancesDialog.js.map