import { cn } from "../../lib/utils.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { chipStyle } from "./chipStyle.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/typeChip/TypeChip.tsx
/** The one visual for a type tag chip — the supertags block chip row
*  and the property panel's selected-types chips render this same
*  component, so colors, truncation, and the remove affordance can't
*  drift apart. POLICY stays with the caller: which chips get a
*  remove ✕ (the block row withholds it from plumbing types), which
*  labels link to a definition block, and whether the label carries
*  the `#` sigil. */
/** Unknown id (type not registered — other device's type not yet
*  synced, plugin disabled, or a deleted definition block): show a
*  shortened id, never a full uuid. */
var displayLabel = (type, typeId) => type?.label ?? (typeId.length > 8 ? `${typeId.slice(0, 8)}…` : typeId);
var TypeChip = (t0) => {
	const $ = c(20);
	const { typeId, type, link, onRemove, withHash } = t0;
	let t1;
	if ($[0] !== type || $[1] !== typeId) {
		t1 = displayLabel(type, typeId);
		$[0] = type;
		$[1] = typeId;
		$[2] = t1;
	} else t1 = $[2];
	const label = t1;
	let t2;
	if ($[3] !== type) {
		t2 = chipStyle(type);
		$[3] = type;
		$[4] = t2;
	} else t2 = $[4];
	const style = t2;
	const labelText = withHash ? `#${label}` : label;
	const t3 = style ? "" : "bg-muted text-muted-foreground";
	let t4;
	if ($[5] !== t3) {
		t4 = cn("inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs", t3);
		$[5] = t3;
		$[6] = t4;
	} else t4 = $[6];
	const t5 = type ? type.description ?? typeId : `Unknown type ${typeId} (not registered)`;
	let t6;
	if ($[7] !== labelText || $[8] !== link) {
		t6 = link ? /* @__PURE__ */ jsx("a", {
			href: link.href,
			className: "truncate text-inherit no-underline hover:underline",
			draggable: false,
			onClick: link.onClick,
			children: labelText
		}) : /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: labelText
		});
		$[7] = labelText;
		$[8] = link;
		$[9] = t6;
	} else t6 = $[9];
	let t7;
	if ($[10] !== label || $[11] !== onRemove || $[12] !== style) {
		t7 = onRemove && /* @__PURE__ */ jsx("button", {
			type: "button",
			className: cn("rounded-sm p-1 -m-1 hover:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", style ? "text-inherit opacity-70 hover:opacity-100" : "text-muted-foreground hover:text-foreground"),
			"aria-label": `Remove ${label} type`,
			onMouseDown: _temp,
			onClick: (event_0) => {
				event_0.stopPropagation();
				onRemove();
			},
			children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3" })
		});
		$[10] = label;
		$[11] = onRemove;
		$[12] = style;
		$[13] = t7;
	} else t7 = $[13];
	let t8;
	if ($[14] !== style || $[15] !== t4 || $[16] !== t5 || $[17] !== t6 || $[18] !== t7) {
		t8 = /* @__PURE__ */ jsxs("span", {
			className: t4,
			style,
			title: t5,
			children: [t6, t7]
		});
		$[14] = style;
		$[15] = t4;
		$[16] = t5;
		$[17] = t6;
		$[18] = t7;
		$[19] = t8;
	} else t8 = $[19];
	return t8;
};
function _temp(event) {
	return event.preventDefault();
}
//#endregion
export { TypeChip };

//# sourceMappingURL=TypeChip.js.map