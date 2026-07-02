import { CodecError } from "../../data/api/errors.js";
import { codecs } from "../../data/api/codecs.js";
import { definePreset } from "../../data/api/valuePresets.js";
import "../../data/api/index.js";
import { valuePresetsFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { AtSign } from "../../../node_modules/lucide-react/dist/esm/icons/at-sign.js";
import { Calendar } from "../../../node_modules/lucide-react/dist/esm/icons/calendar.js";
import { Hash } from "../../../node_modules/lucide-react/dist/esm/icons/hash.js";
import { Link } from "../../../node_modules/lucide-react/dist/esm/icons/link.js";
import { List } from "../../../node_modules/lucide-react/dist/esm/icons/list.js";
import { SquareCheckBig } from "../../../node_modules/lucide-react/dist/esm/icons/square-check-big.js";
import { SquareChevronDown } from "../../../node_modules/lucide-react/dist/esm/icons/square-chevron-down.js";
import { Type } from "../../../node_modules/lucide-react/dist/esm/icons/type.js";
import { BooleanPropertyEditor, DatePropertyEditor, ListPropertyEditor, NumberPropertyEditor, StringPropertyEditor, UrlPropertyEditor } from "./defaults.js";
import { RefListPropertyEditor, RefPropertyEditor } from "./RefPropertyEditor.js";
import { RefTargetTypePicker } from "./RefTargetTypePicker.js";
import { SelectPropertyEditor } from "./SelectPropertyEditor.js";
//#region src/components/propertyEditors/kernelValuePresets.ts
/** Kernel ValuePreset set + the contributions extension that registers
*  them via `valuePresetsFacet`. See user-defined-properties.md §1. */
/** Validates ref / refList preset config. `targetTypes`, when present,
*  must be a string[]; anything else is rejected at the parse boundary
*  so `build` always sees well-typed config. */
var refConfigCodec = {
	type: "ref-config",
	encode: (cfg) => {
		if (cfg.targetTypes === void 0 || cfg.targetTypes.length === 0) return {};
		return { targetTypes: [...cfg.targetTypes] };
	},
	decode: (json) => {
		if (json === null || typeof json !== "object" || Array.isArray(json)) throw new CodecError("ref config object", json);
		const obj = json;
		if (obj.targetTypes !== void 0) {
			if (!Array.isArray(obj.targetTypes) || !obj.targetTypes.every((t) => typeof t === "string")) throw new CodecError("ref config targetTypes (string[])", obj.targetTypes);
		}
		return { targetTypes: obj.targetTypes };
	}
};
/** Existing kernel editors are typed `PropertyEditor<unknown>`, which
*  is invariant against the per-preset `PropertyEditor<TValue>`
*  (PropertyEditor's T appears in both `value: T` and
*  `onChange: (next: T) => void`). The cast at the preset boundary
*  mirrors `AnyPropertySchema`'s `any`-escape pattern — runtime safety
*  comes from the codec encoding/decoding T-typed values, not from
*  static narrowing through the editor signature. */
var asEditor = (editor) => editor;
var kernelValuePresets = [
	definePreset({
		id: "string",
		label: "Plain text",
		Glyph: Type,
		build: () => codecs.string,
		defaultValue: "",
		Editor: asEditor(StringPropertyEditor)
	}),
	definePreset({
		id: "number",
		label: "Number",
		Glyph: Hash,
		build: () => codecs.number,
		defaultValue: 0,
		Editor: asEditor(NumberPropertyEditor)
	}),
	definePreset({
		id: "boolean",
		label: "Checkbox",
		Glyph: SquareCheckBig,
		build: () => codecs.boolean,
		defaultValue: false,
		Editor: asEditor(BooleanPropertyEditor)
	}),
	definePreset({
		id: "list",
		label: "Options",
		Glyph: List,
		build: () => codecs.list(codecs.unsafeIdentity()),
		defaultValue: [],
		Editor: asEditor(ListPropertyEditor)
	}),
	definePreset({
		id: "date",
		label: "Date",
		Glyph: Calendar,
		build: () => codecs.date,
		defaultValue: void 0,
		Editor: asEditor(DatePropertyEditor)
	}),
	definePreset({
		id: "url",
		label: "URL",
		Glyph: Link,
		build: () => codecs.url,
		defaultValue: "",
		Editor: asEditor(UrlPropertyEditor)
	}),
	definePreset({
		id: "enum",
		label: "Choice",
		Glyph: SquareChevronDown,
		build: () => codecs.enum([]),
		defaultValue: "",
		Editor: asEditor(SelectPropertyEditor),
		hideFromPicker: true
	}),
	definePreset({
		id: "ref",
		label: "Reference",
		Glyph: AtSign,
		build: (cfg) => codecs.ref(cfg),
		defaultValue: "",
		defaultConfig: {},
		configCodec: refConfigCodec,
		Editor: asEditor(RefPropertyEditor),
		ConfigEditor: RefTargetTypePicker
	}),
	definePreset({
		id: "refList",
		label: "References",
		Glyph: AtSign,
		build: (cfg) => codecs.refList(cfg),
		defaultValue: [],
		defaultConfig: {},
		configCodec: refConfigCodec,
		Editor: asEditor(RefListPropertyEditor),
		ConfigEditor: RefTargetTypePicker
	})
];
var kernelValuePresetsExtension = systemToggle({
	id: "system:kernel-value-presets",
	name: "Property value presets",
	description: "Default editor + glyph for each codec type, used by any property that doesn't ship a per-name override.",
	essential: true
}).of(kernelValuePresets.map((preset) => valuePresetsFacet.of(preset, { source: "kernel-ui" })));
//#endregion
export { kernelValuePresets, kernelValuePresetsExtension };

//# sourceMappingURL=kernelValuePresets.js.map