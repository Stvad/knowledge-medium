import { isReadOnlyBlock } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { normalizeBacklinksFilter } from "./query.js";
import { useRepo } from "../../context/repo.js";
import { BacklinkFilters } from "./BacklinkFilters.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/backlinks/BacklinksFilterPropertyEditor.tsx
var workspaceIdFromBlock = (block) => {
	if (!block || typeof block !== "object") return void 0;
	const peek = block.peek;
	if (typeof peek !== "function") return void 0;
	const data = peek();
	return typeof data?.workspaceId === "string" ? data.workspaceId : void 0;
};
var BacklinksFilterPropertyEditor = (t0) => {
	const $ = c(15);
	const { value, onChange, block } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== block) {
		t1 = isReadOnlyBlock(block);
		$[0] = block;
		$[1] = t1;
	} else t1 = $[1];
	const readOnly = t1;
	let t2;
	if ($[2] !== value) {
		t2 = normalizeBacklinksFilter(value);
		$[2] = value;
		$[3] = t2;
	} else t2 = $[3];
	const filter = t2;
	let t3;
	if ($[4] !== block || $[5] !== repo.activeWorkspaceId) {
		t3 = repo.activeWorkspaceId ?? workspaceIdFromBlock(block) ?? "";
		$[4] = block;
		$[5] = repo.activeWorkspaceId;
		$[6] = t3;
	} else t3 = $[6];
	const workspaceId = t3;
	let t4;
	if ($[7] !== onChange) {
		t4 = (next) => onChange(normalizeBacklinksFilter(next));
		$[7] = onChange;
		$[8] = t4;
	} else t4 = $[8];
	const handleChange = t4;
	if (!workspaceId) {
		let t5;
		if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
			t5 = /* @__PURE__ */ jsx("div", {
				className: "text-xs text-muted-foreground",
				children: "No workspace selected."
			});
			$[9] = t5;
		} else t5 = $[9];
		return t5;
	}
	let t5;
	if ($[10] !== filter || $[11] !== handleChange || $[12] !== readOnly || $[13] !== workspaceId) {
		t5 = /* @__PURE__ */ jsx(BacklinkFilters, {
			workspaceId,
			filter,
			onChange: handleChange,
			readOnly
		});
		$[10] = filter;
		$[11] = handleChange;
		$[12] = readOnly;
		$[13] = workspaceId;
		$[14] = t5;
	} else t5 = $[14];
	return t5;
};
//#endregion
export { BacklinksFilterPropertyEditor };

//# sourceMappingURL=BacklinksFilterPropertyEditor.js.map