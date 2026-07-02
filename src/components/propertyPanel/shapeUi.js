import { cn } from "../../lib/utils.js";
import { Braces } from "../../../node_modules/lucide-react/dist/esm/icons/braces.js";
import { Calendar } from "../../../node_modules/lucide-react/dist/esm/icons/calendar.js";
import { Hash } from "../../../node_modules/lucide-react/dist/esm/icons/hash.js";
import { Link } from "../../../node_modules/lucide-react/dist/esm/icons/link.js";
import { List } from "../../../node_modules/lucide-react/dist/esm/icons/list.js";
import { SquareCheckBig } from "../../../node_modules/lucide-react/dist/esm/icons/square-check-big.js";
import { Type } from "../../../node_modules/lucide-react/dist/esm/icons/type.js";
import { propertyShapeLabel } from "./shapes.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/propertyPanel/shapeUi.tsx
var TYPE_GLYPHS = {
	number: Hash,
	boolean: SquareCheckBig,
	list: List,
	date: Calendar,
	object: Braces,
	string: Type,
	url: Link
};
/** Resolves the icon component for a property row, preset picker, or
*  field-config sheet. The `Glyph` prop wins (used for per-name
*  `PropertyEditorOverride.Glyph` overrides AND `ValuePreset.Glyph`
*  contributions threaded through `resolvePropertyDisplay`); falling
*  back to the codec-type-keyed kernel table for plugin types without
*  a registered glyph, and finally to the generic text icon. */
function PropertyShapeGlyph(t0) {
	const $ = c(10);
	const { shape, Glyph, className: t1 } = t0;
	const className = t1 === void 0 ? "" : t1;
	if (Glyph) {
		let t2;
		if ($[0] !== className) {
			t2 = cn("h-3.5 w-3.5", className);
			$[0] = className;
			$[1] = t2;
		} else t2 = $[1];
		let t3;
		if ($[2] !== Glyph || $[3] !== t2) {
			t3 = /* @__PURE__ */ jsx(Glyph, { className: t2 });
			$[2] = Glyph;
			$[3] = t2;
			$[4] = t3;
		} else t3 = $[4];
		return t3;
	}
	const Icon = TYPE_GLYPHS[shape] ?? Type;
	let t2;
	if ($[5] !== className) {
		t2 = cn("h-3.5 w-3.5", className);
		$[5] = className;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== Icon || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsx(Icon, {
			className: t2,
			strokeWidth: 1.8
		});
		$[7] = Icon;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	return t3;
}
function PropertyShapeButton(t0) {
	const $ = c(19);
	const { shape, Glyph, label, schemaUnknown, decodeFailed: t1, disabled: t2, onClick } = t0;
	const decodeFailed = t1 === void 0 ? false : t1;
	const disabled = t2 === void 0 ? false : t2;
	const tone = disabled ? "text-fuchsia-500/70 cursor-default" : decodeFailed ? "text-destructive hover:text-destructive hover:bg-muted" : schemaUnknown ? "text-muted-foreground hover:text-foreground hover:bg-muted" : "text-fuchsia-500 hover:text-fuchsia-600 hover:bg-muted";
	let t3;
	if ($[0] !== tone) {
		t3 = cn("flex h-7 w-5 items-center justify-center rounded-sm", tone, "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring");
		$[0] = tone;
		$[1] = t3;
	} else t3 = $[1];
	let t4;
	if ($[2] !== disabled || $[3] !== label || $[4] !== shape) {
		t4 = disabled ? `${label} — built-in ${propertyShapeLabel(shape)} field, no config` : `Configure ${label} (${propertyShapeLabel(shape)})`;
		$[2] = disabled;
		$[3] = label;
		$[4] = shape;
		$[5] = t4;
	} else t4 = $[5];
	const t5 = `Configure ${label}`;
	let t6;
	if ($[6] !== disabled || $[7] !== onClick) {
		t6 = (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (disabled) return;
			onClick();
		};
		$[6] = disabled;
		$[7] = onClick;
		$[8] = t6;
	} else t6 = $[8];
	let t7;
	if ($[9] !== Glyph || $[10] !== shape) {
		t7 = /* @__PURE__ */ jsx(PropertyShapeGlyph, {
			shape,
			Glyph
		});
		$[9] = Glyph;
		$[10] = shape;
		$[11] = t7;
	} else t7 = $[11];
	let t8;
	if ($[12] !== disabled || $[13] !== t3 || $[14] !== t4 || $[15] !== t5 || $[16] !== t6 || $[17] !== t7) {
		t8 = /* @__PURE__ */ jsx("button", {
			type: "button",
			disabled,
			className: t3,
			title: t4,
			"aria-label": t5,
			"data-property-config-button": "true",
			"data-property-row-control": "true",
			onClick: t6,
			children: t7
		});
		$[12] = disabled;
		$[13] = t3;
		$[14] = t4;
		$[15] = t5;
		$[16] = t6;
		$[17] = t7;
		$[18] = t8;
	} else t8 = $[18];
	return t8;
}
//#endregion
export { PropertyShapeButton, PropertyShapeGlyph };

//# sourceMappingURL=shapeUi.js.map