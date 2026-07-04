import { isRefCodec, isRefListCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
import { aliasesProp, blockTypePropertiesProp, rendererNameProp, rendererProp, typesProp } from "../../data/properties.js";
import { labelForBlockData } from "../../utils/linkTargetAutocomplete.js";
import { useRepo } from "../../context/repo.js";
import { useHandle } from "../../hooks/block.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Label } from "../../components/ui/label.js";
import { c } from "react/compiler-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/extract-type/PropertyShapePicker.tsx
var refKindFor = (repo, name) => {
	const schema = repo.propertySchemas.get(name);
	if (!schema) return void 0;
	if (isRefListCodec(schema.codec)) return "refList";
	if (isRefCodec(schema.codec)) return "ref";
};
/** Properties that never make sense to extract from a prototype.
*  System bookkeeping, the types list itself, aliases (page identity),
*  and renderer overrides (UI state). Same exclusion list as
*  `roam-import/typeCandidates.ts` uses for the same reason. */
var isExcludedFromExtract = (name) => name.startsWith("system:") || name === typesProp.name || name === aliasesProp.name || name === rendererProp.name || name === rendererNameProp.name;
var buildPropertyShapeChoices = (repo, prototype) => {
	return Object.entries(prototype.properties).filter(([name, value]) => !isExcludedFromExtract(name) && value !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({
		name,
		picked: true,
		matchValue: false,
		value,
		schemaBlockId: repo.userSchemas.getSchemaBlockId(name),
		refKind: refKindFor(repo, name)
	}));
};
/** Build picker choices from an existing block-type block's properties
*  refList. Unlike `buildPropertyShapeChoices` which reads a prototype's
*  properties_json (instance values), this reads the TYPE definition
*  — each entry corresponds to a property-schema block the type's
*  refList points at. No per-property `value` field (the type itself
*  carries no instance values), so callers should pass
*  `showMatchValue=false` to the picker. */
var buildTypeShapeChoices = (repo, typeBlock) => {
	const raw = typeBlock.properties[blockTypePropertiesProp.name];
	const schemaIds = raw === void 0 ? blockTypePropertiesProp.defaultValue : blockTypePropertiesProp.codec.decode(raw);
	const out = [];
	for (const schemaId of schemaIds) {
		const schema = repo.userSchemas.getSchemaForBlockId(schemaId);
		if (!schema) continue;
		out.push({
			name: schema.name,
			picked: true,
			matchValue: false,
			value: void 0,
			schemaBlockId: schemaId,
			refKind: refKindFor(repo, schema.name)
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
};
var formatPropertyValue = (value) => {
	if (value === void 0) return "";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};
/** Reactive label for a single block id. Subscribes to the block via
*  repo.block + useHandle so the preview updates if the referenced
*  block's content/aliases change while the dialog is open. Falls back
*  to a shortened id for blocks that fail to load. */
var RefLabel = (t0) => {
	const $ = c(9);
	const { id } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== id || $[1] !== repo) {
		t1 = repo.block(id);
		$[0] = id;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const handle = t1;
	let t2;
	if ($[3] !== id) {
		t2 = id.slice(0, 8);
		$[3] = id;
		$[4] = t2;
	} else t2 = $[4];
	const fallback = `(${t2})`;
	let t3;
	if ($[5] !== fallback) {
		t3 = { selector: (data) => labelForBlockData(data, fallback) };
		$[5] = fallback;
		$[6] = t3;
	} else t3 = $[6];
	const label = useHandle(handle, t3);
	let t4;
	if ($[7] !== label) {
		t4 = /* @__PURE__ */ jsx(Fragment, { children: label });
		$[7] = label;
		$[8] = t4;
	} else t4 = $[8];
	return t4;
};
var ValuePreview = (t0) => {
	const $ = c(16);
	const { choice, emptyValuePlaceholder } = t0;
	if (choice.value === void 0) {
		let t1;
		if ($[0] !== emptyValuePlaceholder) {
			t1 = /* @__PURE__ */ jsx(Fragment, { children: emptyValuePlaceholder });
			$[0] = emptyValuePlaceholder;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	}
	if (choice.refKind === "refList" && Array.isArray(choice.value)) {
		const t1 = choice.value;
		let t2;
		let t3;
		if ($[2] !== choice.value || $[3] !== emptyValuePlaceholder) {
			t3 = Symbol.for("react.early_return_sentinel");
			bb0: {
				const ids = t1.filter(_temp);
				if (ids.length === 0) {
					let t4;
					if ($[6] !== emptyValuePlaceholder) {
						t4 = /* @__PURE__ */ jsx(Fragment, { children: emptyValuePlaceholder });
						$[6] = emptyValuePlaceholder;
						$[7] = t4;
					} else t4 = $[7];
					t3 = t4;
					break bb0;
				}
				t2 = ids.map(_temp2);
			}
			$[2] = choice.value;
			$[3] = emptyValuePlaceholder;
			$[4] = t2;
			$[5] = t3;
		} else {
			t2 = $[4];
			t3 = $[5];
		}
		if (t3 !== Symbol.for("react.early_return_sentinel")) return t3;
		let t4;
		if ($[8] !== t2) {
			t4 = /* @__PURE__ */ jsx(Fragment, { children: t2 });
			$[8] = t2;
			$[9] = t4;
		} else t4 = $[9];
		return t4;
	}
	if (choice.refKind === "ref" && typeof choice.value === "string") {
		let t1;
		if ($[10] !== choice.value) {
			t1 = /* @__PURE__ */ jsx(RefLabel, { id: choice.value });
			$[10] = choice.value;
			$[11] = t1;
		} else t1 = $[11];
		return t1;
	}
	let t1;
	if ($[12] !== choice.value) {
		t1 = formatPropertyValue(choice.value);
		$[12] = choice.value;
		$[13] = t1;
	} else t1 = $[13];
	let t2;
	if ($[14] !== t1) {
		t2 = /* @__PURE__ */ jsx(Fragment, { children: t1 });
		$[14] = t1;
		$[15] = t2;
	} else t2 = $[15];
	return t2;
};
function PropertyShapePicker(t0) {
	const $ = c(11);
	const { choices, onChange, disabled: t1, idPrefix: t2, showNoSchemaNote: t3, showMatchValue: t4, showValuePreview: t5, emptyValuePlaceholder: t6 } = t0;
	const disabled = t1 === void 0 ? false : t1;
	const idPrefix = t2 === void 0 ? "shape-pick" : t2;
	const showNoSchemaNote = t3 === void 0 ? false : t3;
	const showMatchValue = t4 === void 0 ? true : t4;
	const showValuePreview = t5 === void 0 ? true : t5;
	const emptyValuePlaceholder = t6 === void 0 ? "" : t6;
	if (choices.length === 0) return null;
	let t7;
	if ($[0] !== choices || $[1] !== disabled || $[2] !== emptyValuePlaceholder || $[3] !== idPrefix || $[4] !== onChange || $[5] !== showMatchValue || $[6] !== showNoSchemaNote || $[7] !== showValuePreview) {
		t7 = choices.map((choice, idx) => {
			const hasNoSchema = choice.schemaBlockId === void 0;
			return /* @__PURE__ */ jsxs("li", {
				className: "flex min-w-0 items-center gap-3 rounded px-2 py-1 hover:bg-muted/60",
				children: [
					/* @__PURE__ */ jsx(Checkbox, {
						id: `${idPrefix}-${idx}`,
						checked: choice.picked,
						onCheckedChange: (next) => {
							onChange(choices.map((c, i) => i === idx ? {
								...c,
								picked: next === true
							} : c));
						},
						disabled
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "min-w-0 flex-1",
						children: [/* @__PURE__ */ jsxs("div", {
							className: "flex items-center gap-2",
							children: [/* @__PURE__ */ jsx(Label, {
								htmlFor: `${idPrefix}-${idx}`,
								className: "cursor-pointer truncate font-mono text-sm",
								children: choice.name
							}), showNoSchemaNote && hasNoSchema && /* @__PURE__ */ jsx("span", {
								className: "text-xs text-muted-foreground",
								title: "No user-defined property-schema for this name. Kernel and plugin properties can't be added to a user type yet.",
								children: "(no user schema)"
							})]
						}), showValuePreview && /* @__PURE__ */ jsx("div", {
							className: "truncate text-xs text-muted-foreground",
							children: /* @__PURE__ */ jsx(ValuePreview, {
								choice,
								emptyValuePlaceholder
							})
						})]
					}),
					showMatchValue && /* @__PURE__ */ jsxs("label", {
						className: "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
						children: [/* @__PURE__ */ jsx(Checkbox, {
							checked: choice.matchValue,
							onCheckedChange: (next_0) => {
								onChange(choices.map((c_0, i_0) => i_0 === idx ? {
									...c_0,
									matchValue: next_0 === true
								} : c_0));
							},
							disabled: disabled || !choice.picked
						}), "match value"]
					})
				]
			}, choice.name);
		});
		$[0] = choices;
		$[1] = disabled;
		$[2] = emptyValuePlaceholder;
		$[3] = idPrefix;
		$[4] = onChange;
		$[5] = showMatchValue;
		$[6] = showNoSchemaNote;
		$[7] = showValuePreview;
		$[8] = t7;
	} else t7 = $[8];
	let t8;
	if ($[9] !== t7) {
		t8 = /* @__PURE__ */ jsx("ul", {
			className: "max-h-72 min-w-0 space-y-1 overflow-auto rounded-md border p-2",
			children: t7
		});
		$[9] = t7;
		$[10] = t8;
	} else t8 = $[10];
	return t8;
}
/** Convert a choice list into the `shape` arg accepted by
*  `findCandidatesByPropertyShape`. */
var choicesToShape = (choices) => choices.filter((c) => c.picked).map((c) => ({
	name: c.name,
	...c.matchValue ? { value: c.value } : {}
}));
function _temp(v) {
	return typeof v === "string";
}
function _temp2(id, i) {
	return /* @__PURE__ */ jsxs("span", { children: [i > 0 && ", ", /* @__PURE__ */ jsx(RefLabel, { id })] }, id);
}
//#endregion
export { PropertyShapePicker, buildPropertyShapeChoices, buildTypeShapeChoices, choicesToShape, formatPropertyValue };

//# sourceMappingURL=PropertyShapePicker.js.map