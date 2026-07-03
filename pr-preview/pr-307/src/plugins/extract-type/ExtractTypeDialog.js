import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { useRepo } from "../../context/repo.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { createTypeBlock } from "../../data/typeExtraction.js";
import { PropertyShapePicker, buildPropertyShapeChoices } from "./PropertyShapePicker.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/extract-type/ExtractTypeDialog.tsx
/** ExtractTypeDialog — Step 1 of the extract-type flow: pure type
*  assembly from a prototype.
*
*  The user picks which of the prototype's properties belong on the
*  new type and names it. No values, no match-value, no candidate
*  preview — those concerns live in the "find candidates for this
*  type" dialog, which is also a standalone command and is what
*  Step 2 of the extract flow delegates to.
*
*  On submit:
*   1. `createTypeBlock` materialises a fresh block-type block with
*      the caller's label + picked schema refList.
*   2. The dialog resolves with the new type id; the `extractType`
*      action then opens the find-type-instances dialog on it, so the
*      user lands directly in the candidate-finding flow with the new
*      type's properties pre-listed. */
function ExtractTypeDialog(t0) {
	const $ = c(37);
	const { prototypeBlockId, resolve, cancel } = t0;
	const repo = useRepo();
	const [prototype, setPrototype] = useState(null);
	const [typeName, setTypeName] = useState("");
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = [];
		$[0] = t1;
	} else t1 = $[0];
	const [choices, setChoices] = useState(t1);
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	let t2;
	let t3;
	if ($[1] !== prototypeBlockId || $[2] !== repo) {
		t2 = () => {
			let cancelled = false;
			(async () => {
				const data = await repo.load(prototypeBlockId);
				if (cancelled) return;
				if (!data) {
					setError(`Block ${prototypeBlockId} not found`);
					return;
				}
				setPrototype(data);
				setChoices(buildPropertyShapeChoices(repo, data));
			})();
			return () => {
				cancelled = true;
			};
		};
		t3 = [repo, prototypeBlockId];
		$[1] = prototypeBlockId;
		$[2] = repo;
		$[3] = t2;
		$[4] = t3;
	} else {
		t2 = $[3];
		t3 = $[4];
	}
	useEffect(t2, t3);
	let t4;
	if ($[5] !== choices) {
		t4 = choices.filter(_temp);
		$[5] = choices;
		$[6] = t4;
	} else t4 = $[6];
	const pickedChoices = t4;
	let t5;
	if ($[7] !== pickedChoices) {
		t5 = pickedChoices.filter(_temp2).map(_temp3);
		$[7] = pickedChoices;
		$[8] = t5;
	} else t5 = $[8];
	const pickedSchemaBlockIds = t5;
	const droppedFromTypeCount = pickedChoices.length - pickedSchemaBlockIds.length;
	let t6;
	if ($[9] !== busy || $[10] !== pickedSchemaBlockIds.length || $[11] !== typeName) {
		t6 = typeName.trim() !== "" && pickedSchemaBlockIds.length > 0 && !busy;
		$[9] = busy;
		$[10] = pickedSchemaBlockIds.length;
		$[11] = typeName;
		$[12] = t6;
	} else t6 = $[12];
	const canCreate = t6;
	let t7;
	if ($[13] !== pickedSchemaBlockIds || $[14] !== prototype || $[15] !== repo || $[16] !== resolve || $[17] !== typeName) {
		t7 = async () => {
			if (!prototype) return;
			setError(null);
			setBusy(true);
			try {
				resolve({ typeBlockId: await createTypeBlock(repo, {
					workspaceId: prototype.workspaceId,
					label: typeName.trim(),
					propertySchemaIds: pickedSchemaBlockIds
				}) });
			} catch (t8) {
				const err = t8;
				setError(err instanceof Error ? err.message : "Failed to create type");
				setBusy(false);
			}
		};
		$[13] = pickedSchemaBlockIds;
		$[14] = prototype;
		$[15] = repo;
		$[16] = resolve;
		$[17] = typeName;
		$[18] = t7;
	} else t7 = $[18];
	const handleCreate = t7;
	let t8;
	if ($[19] !== cancel) {
		t8 = (next) => {
			if (!next) cancel();
		};
		$[19] = cancel;
		$[20] = t8;
	} else t8 = $[20];
	let t9;
	if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = /* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: "Extract type from this block" }), /* @__PURE__ */ jsx(DialogDescription, { children: "Name the new type and pick which of this block’s properties belong on it. You’ll then be prompted to find blocks to retag as the new type." })] });
		$[21] = t9;
	} else t9 = $[21];
	let t10;
	if ($[22] !== busy || $[23] !== canCreate || $[24] !== cancel || $[25] !== choices || $[26] !== droppedFromTypeCount || $[27] !== error || $[28] !== handleCreate || $[29] !== prototype || $[30] !== typeName) {
		t10 = prototype && /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 space-y-4",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-2",
					children: [/* @__PURE__ */ jsx(Label, {
						htmlFor: "extract-type-name",
						children: "Type name"
					}), /* @__PURE__ */ jsx(Input, {
						id: "extract-type-name",
						autoFocus: true,
						placeholder: "Task",
						value: typeName,
						onChange: (e) => setTypeName(e.target.value),
						disabled: busy
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-2",
					children: [
						/* @__PURE__ */ jsx(Label, { children: "Properties" }),
						choices.length === 0 ? /* @__PURE__ */ jsx("p", {
							className: "text-sm text-muted-foreground",
							children: "This block has no extractable properties. Set some properties on it before extracting a type."
						}) : /* @__PURE__ */ jsx(PropertyShapePicker, {
							choices,
							onChange: setChoices,
							disabled: busy,
							idPrefix: "extract-pick",
							showNoSchemaNote: true,
							showMatchValue: false,
							showValuePreview: false
						}),
						droppedFromTypeCount > 0 && /* @__PURE__ */ jsxs("p", {
							className: "text-xs text-muted-foreground",
							children: [
								droppedFromTypeCount,
								" picked propert",
								droppedFromTypeCount === 1 ? "y has" : "ies have",
								" no user-defined schema and can’t be added to the new type definition."
							]
						})
					]
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
					onClick: handleCreate,
					disabled: !canCreate,
					children: busy ? "Creating…" : "Create type"
				})] })
			]
		});
		$[22] = busy;
		$[23] = canCreate;
		$[24] = cancel;
		$[25] = choices;
		$[26] = droppedFromTypeCount;
		$[27] = error;
		$[28] = handleCreate;
		$[29] = prototype;
		$[30] = typeName;
		$[31] = t10;
	} else t10 = $[31];
	let t11;
	if ($[32] !== t10) {
		t11 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-2xl",
			children: [t9, t10]
		});
		$[32] = t10;
		$[33] = t11;
	} else t11 = $[33];
	let t12;
	if ($[34] !== t11 || $[35] !== t8) {
		t12 = /* @__PURE__ */ jsx(Dialog, {
			open: true,
			onOpenChange: t8,
			children: t11
		});
		$[34] = t11;
		$[35] = t8;
		$[36] = t12;
	} else t12 = $[36];
	return t12;
}
function _temp3(c_1) {
	return c_1.schemaBlockId;
}
function _temp2(c_0) {
	return c_0.schemaBlockId !== void 0;
}
function _temp(c) {
	return c.picked;
}
//#endregion
export { ExtractTypeDialog };

//# sourceMappingURL=ExtractTypeDialog.js.map