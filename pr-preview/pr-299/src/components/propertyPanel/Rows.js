import { Input } from "../ui/input.js";
import { useRepo } from "../../context/repo.js";
import { Settings2 } from "../../../node_modules/lucide-react/dist/esm/icons/settings-2.js";
import { buildAppHash } from "../../utils/routing.js";
import { useOpenBlock } from "../../utils/navigation.js";
import { METADATA_ROW_GRID_STYLE, PROPERTY_ROW_GRID_STYLE } from "./layout.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyPanel/Rows.tsx
function PropertySectionLabel(t0) {
	const $ = c(8);
	const { section } = t0;
	const label = section.id.startsWith("type:") ? `# ${section.label}` : section.label;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx("span", {});
		$[0] = t1;
	} else t1 = $[0];
	const t2 = section.description ?? section.label;
	let t3;
	if ($[1] !== label || $[2] !== t2) {
		t3 = /* @__PURE__ */ jsx("div", {
			className: "truncate",
			title: t2,
			children: label
		});
		$[1] = label;
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	let t4;
	let t5;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx("span", {});
		t5 = /* @__PURE__ */ jsx("span", {});
		$[4] = t4;
		$[5] = t5;
	} else {
		t4 = $[4];
		t5 = $[5];
	}
	let t6;
	if ($[6] !== t3) {
		t6 = /* @__PURE__ */ jsxs("div", {
			className: "grid items-center gap-2 pt-2 text-[11px] font-medium uppercase text-muted-foreground/60",
			style: PROPERTY_ROW_GRID_STYLE,
			children: [
				t1,
				t3,
				t4,
				t5
			]
		});
		$[6] = t3;
		$[7] = t6;
	} else t6 = $[7];
	return t6;
}
function MetadataRow(t0) {
	const $ = c(15);
	const { row } = t0;
	const workspaceId = useRepo().activeWorkspaceId ?? void 0;
	const t1 = row.linkToBlockId ?? "";
	let t2;
	if ($[0] !== t1 || $[1] !== workspaceId) {
		t2 = {
			blockId: t1,
			workspaceId
		};
		$[0] = t1;
		$[1] = workspaceId;
		$[2] = t2;
	} else t2 = $[2];
	const openBlock = useOpenBlock(t2);
	const showLink = Boolean(row.linkToBlockId) && Boolean(workspaceId);
	let t3;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(Settings2, { className: "h-3.5 w-3.5 text-muted-foreground" });
		$[3] = t3;
	} else t3 = $[3];
	let t4;
	if ($[4] !== row.label) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: "truncate text-muted-foreground",
			title: row.label,
			children: row.label
		});
		$[4] = row.label;
		$[5] = t4;
	} else t4 = $[5];
	let t5;
	if ($[6] !== openBlock || $[7] !== row.linkToBlockId || $[8] !== row.value || $[9] !== showLink || $[10] !== workspaceId) {
		t5 = showLink ? /* @__PURE__ */ jsx("a", {
			href: buildAppHash(workspaceId, row.linkToBlockId),
			onClick: openBlock,
			title: row.value,
			className: "inline-flex h-7 min-w-0 items-center rounded-sm px-2 text-sm text-foreground no-underline hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			children: /* @__PURE__ */ jsx("span", {
				className: "min-w-0 truncate",
				children: row.value
			})
		}) : /* @__PURE__ */ jsx(Input, {
			value: row.value,
			disabled: true,
			className: "h-7 min-w-0 bg-muted/30 text-sm"
		});
		$[6] = openBlock;
		$[7] = row.linkToBlockId;
		$[8] = row.value;
		$[9] = showLink;
		$[10] = workspaceId;
		$[11] = t5;
	} else t5 = $[11];
	let t6;
	if ($[12] !== t4 || $[13] !== t5) {
		t6 = /* @__PURE__ */ jsxs("div", {
			className: "grid items-center gap-2 py-0.5 text-sm",
			style: METADATA_ROW_GRID_STYLE,
			children: [
				t3,
				t4,
				t5
			]
		});
		$[12] = t4;
		$[13] = t5;
		$[14] = t6;
	} else t6 = $[14];
	return t6;
}
//#endregion
export { MetadataRow, PropertySectionLabel };

//# sourceMappingURL=Rows.js.map