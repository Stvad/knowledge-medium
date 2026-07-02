import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { blockTypeDescriptionProp, blockTypeLabelProp, blockTypePropertiesProp } from "../../data/properties.js";
import { propertyEditorOverridesFacet, valuePresetsFacet } from "../../data/facets.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { useHandle } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { propertyShapeLabel } from "../propertyPanel/shapes.js";
import { PropertyShapeGlyph } from "../propertyPanel/shapeUi.js";
import { PropertyPicker } from "../propertyPanel/PropertyPicker.js";
import { DefaultBlockRenderer } from "./DefaultBlockRenderer.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/BlockTypeBlockRenderer.tsx
/** Renderer for `'block-type'` blocks (user-defined-types Phase 1).
*  Wraps the default block layout and replaces the content area with a
*  type editor — label input, description textarea, and a properties
*  list backed by the shared PropertyPicker (same autocomplete +
*  inline-create UX as the property panel's "+ Field" surface).
*  Parallel in shape to PropertySchemaBlockRenderer. */
var writeBlockTypeLabel = async (block, currentLabel, currentContent, next) => {
	if (next === currentLabel && next === currentContent) return;
	await block.repo.tx(async (tx) => {
		if (next !== currentLabel) await tx.setProperty(block.id, blockTypeLabelProp, next);
		if (next !== currentContent) await tx.update(block.id, { content: next });
	}, {
		scope: ChangeScope.BlockDefault,
		description: "edit block-type label"
	});
};
var BlockTypeContentRenderer = (t0) => {
	const $ = c(81);
	const { block } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp };
		$[0] = t1;
	} else t1 = $[0];
	const data = useHandle(block, t1);
	const readOnly = block.repo.isReadOnly;
	const runtime = useAppRuntime();
	const presets = runtime.read(valuePresetsFacet);
	const uis = runtime.read(propertyEditorOverridesFacet);
	const userSchemas = block.repo.userSchemas;
	let t2;
	bb0: {
		if (!data) {
			t2 = "";
			break bb0;
		}
		const raw = data.properties[blockTypeLabelProp.name];
		let t3;
		if ($[1] !== raw) {
			t3 = raw === void 0 ? blockTypeLabelProp.defaultValue : blockTypeLabelProp.codec.decode(raw);
			$[1] = raw;
			$[2] = t3;
		} else t3 = $[2];
		t2 = t3;
	}
	const label = t2;
	let t3;
	bb1: {
		if (!data) {
			t3 = "";
			break bb1;
		}
		const raw_0 = data.properties[blockTypeDescriptionProp.name];
		let t4;
		if ($[3] !== raw_0) {
			t4 = raw_0 === void 0 ? blockTypeDescriptionProp.defaultValue : blockTypeDescriptionProp.codec.decode(raw_0);
			$[3] = raw_0;
			$[4] = t4;
		} else t4 = $[4];
		t3 = t4;
	}
	const description = t3;
	let t4;
	bb2: {
		if (!data) {
			let t5;
			if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
				t5 = [];
				$[5] = t5;
			} else t5 = $[5];
			t4 = t5;
			break bb2;
		}
		const raw_1 = data.properties[blockTypePropertiesProp.name];
		let t5;
		if ($[6] !== raw_1) {
			t5 = raw_1 === void 0 ? blockTypePropertiesProp.defaultValue : blockTypePropertiesProp.codec.decode(raw_1);
			$[6] = raw_1;
			$[7] = t5;
		} else t5 = $[7];
		t4 = t5;
	}
	const propertyRefs = t4;
	let t5;
	if ($[8] !== propertyRefs || $[9] !== userSchemas) {
		let t6;
		if ($[11] !== userSchemas) {
			t6 = (refId) => ({
				refId,
				schema: userSchemas.getSchemaForBlockId(refId)
			});
			$[11] = userSchemas;
			$[12] = t6;
		} else t6 = $[12];
		t5 = propertyRefs.map(t6);
		$[8] = propertyRefs;
		$[9] = userSchemas;
		$[10] = t5;
	} else t5 = $[10];
	const resolvedEntries = t5;
	let t6;
	if ($[13] !== resolvedEntries) {
		t6 = resolvedEntries.flatMap(_temp2);
		$[13] = resolvedEntries;
		$[14] = t6;
	} else t6 = $[14];
	const excludedNames = t6;
	const [draftLabel, setDraftLabel] = useState(label);
	const [committedLabel, setCommittedLabel] = useState(label);
	if (label !== committedLabel) {
		setCommittedLabel(label);
		setDraftLabel(label);
	}
	const [draftDescription, setDraftDescription] = useState(description);
	const [committedDescription, setCommittedDescription] = useState(description);
	if (description !== committedDescription) {
		setCommittedDescription(description);
		setDraftDescription(description);
	}
	let t7;
	if ($[15] !== block || $[16] !== data?.content || $[17] !== label) {
		t7 = async (next) => {
			await writeBlockTypeLabel(block, label, data?.content ?? "", next);
		};
		$[15] = block;
		$[16] = data?.content;
		$[17] = label;
		$[18] = t7;
	} else t7 = $[18];
	data?.content;
	const writeLabel = t7;
	let t8;
	if ($[19] !== block || $[20] !== description) {
		t8 = async (next_0) => {
			if (next_0 === description) return;
			await block.set(blockTypeDescriptionProp, next_0);
		};
		$[19] = block;
		$[20] = description;
		$[21] = t8;
	} else t8 = $[21];
	const writeDescription = t8;
	let t9;
	if ($[22] !== block.id || $[23] !== block.repo) {
		t9 = async (next_1) => {
			await block.repo.tx(async (tx) => {
				await tx.setProperty(block.id, blockTypePropertiesProp, next_1);
			}, {
				scope: ChangeScope.BlockDefault,
				description: "edit block-type properties"
			});
		};
		$[22] = block.id;
		$[23] = block.repo;
		$[24] = t9;
	} else t9 = $[24];
	const writeRefs = t9;
	let t10;
	if ($[25] !== propertyRefs || $[26] !== userSchemas || $[27] !== writeRefs) {
		t10 = async (schema) => {
			const blockId = userSchemas.getSchemaBlockId(schema.name);
			if (!blockId) {
				console.warn(`[BlockTypeBlockRenderer] schema "${schema.name}" has no backing block; kernel/plugin schemas can't be lifted into a user-defined type yet.`);
				return;
			}
			if (propertyRefs.includes(blockId)) return;
			await writeRefs([...propertyRefs, blockId]);
		};
		$[25] = propertyRefs;
		$[26] = userSchemas;
		$[27] = writeRefs;
		$[28] = t10;
	} else t10 = $[28];
	const appendSchema = t10;
	let t11;
	if ($[29] !== appendSchema || $[30] !== block.repo.userSchemas) {
		t11 = async (args) => {
			if (args.adopted) {
				await appendSchema(args.adopted);
				return;
			}
			await appendSchema(await block.repo.userSchemas.addSchema({
				name: args.name,
				presetId: args.presetId
			}));
		};
		$[29] = appendSchema;
		$[30] = block.repo.userSchemas;
		$[31] = t11;
	} else t11 = $[31];
	const handlePick = t11;
	let t12;
	if ($[32] !== userSchemas) {
		t12 = async (args_0) => {
			const trimmed = args_0.name.trim();
			if (!trimmed) return;
			const existing = userSchemas.getSchemaForBlockId(userSchemas.getSchemaBlockId(trimmed) ?? "");
			if (existing) return existing;
			try {
				return await userSchemas.addSchema({
					name: trimmed,
					presetId: args_0.presetId
				});
			} catch (t13) {
				const err = t13;
				console.error(`[BlockTypeBlockRenderer] failed to register schema "${trimmed}":`, err);
				return;
			}
		};
		$[32] = userSchemas;
		$[33] = t12;
	} else t12 = $[33];
	const handleConfigureNewSchema = t12;
	let t13;
	if ($[34] !== propertyRefs || $[35] !== writeRefs) {
		t13 = async (refId_0) => {
			await writeRefs(propertyRefs.filter((r) => r !== refId_0));
		};
		$[34] = propertyRefs;
		$[35] = writeRefs;
		$[36] = t13;
	} else t13 = $[36];
	const removeRef = t13;
	const [confirmDelete, setConfirmDelete] = useState(false);
	let t14;
	if ($[37] !== block.id || $[38] !== block.repo.mutate) {
		t14 = async () => {
			await block.repo.mutate.delete({ id: block.id });
		};
		$[37] = block.id;
		$[38] = block.repo.mutate;
		$[39] = t14;
	} else t14 = $[39];
	const performDelete = t14;
	if (!data) return null;
	const t15 = "w-full space-y-2 py-1";
	let t16;
	if ($[40] === Symbol.for("react.memo_cache_sentinel")) {
		t16 = (e_0) => setDraftLabel(e_0.target.value);
		$[40] = t16;
	} else t16 = $[40];
	let t17;
	if ($[41] !== draftLabel || $[42] !== writeLabel) {
		t17 = () => {
			writeLabel(draftLabel.trim());
		};
		$[41] = draftLabel;
		$[42] = writeLabel;
		$[43] = t17;
	} else t17 = $[43];
	let t18;
	if ($[44] !== draftLabel || $[45] !== readOnly || $[46] !== t17) {
		t18 = /* @__PURE__ */ jsx("div", {
			className: "flex items-center gap-2",
			children: /* @__PURE__ */ jsx(Input, {
				value: draftLabel,
				placeholder: "type label",
				readOnly,
				onChange: t16,
				onBlur: t17,
				onKeyDown: _temp3,
				className: "h-8 max-w-md text-base font-semibold"
			})
		});
		$[44] = draftLabel;
		$[45] = readOnly;
		$[46] = t17;
		$[47] = t18;
	} else t18 = $[47];
	let t19;
	if ($[48] === Symbol.for("react.memo_cache_sentinel")) {
		t19 = /* @__PURE__ */ jsx("label", {
			className: "pt-1 text-xs font-semibold text-muted-foreground",
			children: "Description"
		});
		$[48] = t19;
	} else t19 = $[48];
	let t20;
	if ($[49] === Symbol.for("react.memo_cache_sentinel")) {
		t20 = (e_2) => setDraftDescription(e_2.target.value);
		$[49] = t20;
	} else t20 = $[49];
	let t21;
	if ($[50] !== draftDescription || $[51] !== writeDescription) {
		t21 = () => {
			writeDescription(draftDescription);
		};
		$[50] = draftDescription;
		$[51] = writeDescription;
		$[52] = t21;
	} else t21 = $[52];
	let t22;
	if ($[53] !== draftDescription || $[54] !== readOnly || $[55] !== t21) {
		t22 = /* @__PURE__ */ jsxs("div", {
			className: "grid grid-cols-[6rem,minmax(0,1fr)] items-start gap-3",
			children: [t19, /* @__PURE__ */ jsx("textarea", {
				value: draftDescription,
				placeholder: "What is this type for?",
				readOnly,
				onChange: t20,
				onBlur: t21,
				className: "min-h-[60px] w-full max-w-md rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
			})]
		});
		$[53] = draftDescription;
		$[54] = readOnly;
		$[55] = t21;
		$[56] = t22;
	} else t22 = $[56];
	const t23 = "grid grid-cols-[6rem,minmax(0,1fr)] items-start gap-3";
	let t24;
	if ($[57] === Symbol.for("react.memo_cache_sentinel")) {
		t24 = /* @__PURE__ */ jsx("label", {
			className: "pt-1 text-xs font-semibold text-muted-foreground",
			children: "Properties"
		});
		$[57] = t24;
	} else t24 = $[57];
	const t25 = "min-w-0 space-y-1";
	const t26 = resolvedEntries.map((entry) => /* @__PURE__ */ jsxs("div", {
		className: "flex items-center gap-2 rounded-md border border-input/60 bg-background px-2 py-1 text-sm",
		children: [entry.schema ? /* @__PURE__ */ jsxs(Fragment$1, { children: [
			/* @__PURE__ */ jsx(PropertyShapeGlyph, {
				shape: entry.schema.codec.type,
				Glyph: uis.get(entry.schema.name)?.Glyph ?? presets.get(entry.schema.codec.type)?.Glyph,
				className: "text-muted-foreground"
			}),
			/* @__PURE__ */ jsx("span", {
				className: "flex-1 truncate",
				children: entry.schema.name
			}),
			/* @__PURE__ */ jsx("span", {
				className: "text-xs text-muted-foreground",
				children: presets.get(entry.schema.codec.type)?.label ?? propertyShapeLabel(entry.schema.codec.type)
			})
		] }) : /* @__PURE__ */ jsxs("span", {
			className: "flex-1 truncate text-muted-foreground italic",
			children: [
				"unresolved ref (",
				entry.refId.slice(0, 8),
				"…)"
			]
		}), !readOnly && /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
			"aria-label": "Remove property",
			onClick: () => {
				removeRef(entry.refId);
			},
			children: /* @__PURE__ */ jsx(X, { className: "h-3.5 w-3.5" })
		})]
	}, entry.refId));
	let t27;
	if ($[58] !== block || $[59] !== excludedNames || $[60] !== handleConfigureNewSchema || $[61] !== handlePick || $[62] !== readOnly || $[63] !== userSchemas) {
		t27 = !readOnly && /* @__PURE__ */ jsx("div", {
			className: "flex items-center gap-2 pt-1",
			children: /* @__PURE__ */ jsx(PropertyPicker, {
				onAdd: handlePick,
				onConfigureNewSchema: handleConfigureNewSchema,
				excludedNames,
				block,
				filterSchema: (schema_0) => userSchemas.getSchemaBlockId(schema_0.name) !== void 0,
				placeholder: "Add property"
			})
		});
		$[58] = block;
		$[59] = excludedNames;
		$[60] = handleConfigureNewSchema;
		$[61] = handlePick;
		$[62] = readOnly;
		$[63] = userSchemas;
		$[64] = t27;
	} else t27 = $[64];
	let t28;
	if ($[65] !== t26 || $[66] !== t27) {
		t28 = /* @__PURE__ */ jsxs("div", {
			className: t25,
			children: [t26, t27]
		});
		$[65] = t26;
		$[66] = t27;
		$[67] = t28;
	} else t28 = $[67];
	let t29;
	if ($[68] !== t24 || $[69] !== t28) {
		t29 = /* @__PURE__ */ jsxs("div", {
			className: t23,
			children: [t24, t28]
		});
		$[68] = t24;
		$[69] = t28;
		$[70] = t29;
	} else t29 = $[70];
	let t30;
	if ($[71] !== confirmDelete || $[72] !== performDelete || $[73] !== readOnly || $[74] !== setConfirmDelete) {
		t30 = !readOnly && /* @__PURE__ */ jsxs("div", {
			className: "flex flex-wrap items-center gap-2",
			children: [/* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				size: "sm",
				className: "h-7 text-xs text-destructive hover:text-destructive",
				onClick: () => {
					if (confirmDelete) {
						performDelete();
						setConfirmDelete(false);
					} else setConfirmDelete(true);
				},
				children: confirmDelete ? "Really delete?" : "Delete type"
			}), confirmDelete && /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				size: "sm",
				className: "h-7 text-xs",
				onClick: () => setConfirmDelete(false),
				children: "Cancel"
			})]
		});
		$[71] = confirmDelete;
		$[72] = performDelete;
		$[73] = readOnly;
		$[74] = setConfirmDelete;
		$[75] = t30;
	} else t30 = $[75];
	let t31;
	if ($[76] !== t18 || $[77] !== t22 || $[78] !== t29 || $[79] !== t30) {
		t31 = /* @__PURE__ */ jsxs("div", {
			className: t15,
			children: [
				t18,
				t22,
				t29,
				t30
			]
		});
		$[76] = t18;
		$[77] = t22;
		$[78] = t29;
		$[79] = t30;
		$[80] = t31;
	} else t31 = $[80];
	return t31;
};
BlockTypeContentRenderer.displayName = "BlockTypeContentRenderer";
/** Outer wrapper: keeps the default block layout (children,
*  indentation, drag handle, focus chrome) and swaps in the
*  type-editing content renderer. */
var BlockTypeBlockRenderer = Object.assign((props) => /* @__PURE__ */ jsx(DefaultBlockRenderer, {
	...props,
	ContentRenderer: BlockTypeContentRenderer,
	EditContentRenderer: BlockTypeContentRenderer
}), {
	canRender: ({ block }) => {
		const data = block.peek();
		if (!data) return false;
		const types = data.properties.types;
		return Array.isArray(types) && types.includes("block-type");
	},
	priority: () => 100
});
BlockTypeBlockRenderer.displayName = "BlockTypeBlockRenderer";
function _temp(d) {
	return d ? {
		id: d.id,
		content: d.content,
		properties: d.properties
	} : void 0;
}
function _temp2(e) {
	return e.schema ? [e.schema.name] : [];
}
function _temp3(e_1) {
	if (e_1.key === "Enter") {
		e_1.preventDefault();
		e_1.target.blur();
	}
}
//#endregion
export { BlockTypeBlockRenderer, writeBlockTypeLabel };

//# sourceMappingURL=BlockTypeBlockRenderer.js.map