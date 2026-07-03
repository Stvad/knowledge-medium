import { Button } from "../ui/button.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { PropertyPicker } from "./PropertyPicker.js";
import { consumePendingPropertyCreateRequest, focusPropertyRowByNameWhenReady, subscribePropertyCreateRequests } from "../../utils/propertyNavigation.js";
import { PROPERTY_ROW_GRID_STYLE } from "./layout.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/propertyPanel/AddPropertyForm.tsx
/** AddPropertyForm — the panel's "add a field" entry point. Wraps the
*  shared PropertyPicker with the panel's row layout (3-column grid),
*  the +Field toggle button, and the focus-after-add bridge. The form
*  either adopts an existing schema or asks UserSchemasService.addSchema
*  to create a new one (default preset: 'ref') before the caller shows
*  an unset row for the property. */
function AddPropertyForm(t0) {
	const $ = c(23);
	const { block, onAdd, onConfigureNewSchema } = t0;
	const blockId = block.id;
	let t1;
	if ($[0] !== blockId) {
		t1 = () => consumePendingPropertyCreateRequest(blockId);
		$[0] = blockId;
		$[1] = t1;
	} else t1 = $[1];
	const [initialRequest] = useState(t1);
	let t2;
	if ($[2] !== initialRequest) {
		t2 = initialRequest ? {
			key: 0,
			initialName: initialRequest.initialName ?? ""
		} : null;
		$[2] = initialRequest;
		$[3] = t2;
	} else t2 = $[3];
	const [openState, setOpenState] = useState(t2);
	let t3;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = (t4) => {
			const initialName = t4 === void 0 ? "" : t4;
			setOpenState((prev) => ({
				key: (prev?.key ?? 0) + 1,
				initialName
			}));
		};
		$[4] = t3;
	} else t3 = $[4];
	const openForm = t3;
	let t4;
	let t5;
	if ($[5] !== blockId) {
		t4 = () => subscribePropertyCreateRequests(blockId, (detail) => openForm(detail.initialName));
		t5 = [blockId, openForm];
		$[5] = blockId;
		$[6] = t4;
		$[7] = t5;
	} else {
		t4 = $[6];
		t5 = $[7];
	}
	useEffect(t4, t5);
	let t6;
	if ($[8] !== blockId || $[9] !== onAdd) {
		t6 = async (args) => {
			await onAdd(args);
			setOpenState(null);
			focusPropertyRowByNameWhenReady(blockId, args.name);
		};
		$[8] = blockId;
		$[9] = onAdd;
		$[10] = t6;
	} else t6 = $[10];
	const handleAdd = t6;
	if (!openState) {
		let t7;
		if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
			t7 = /* @__PURE__ */ jsxs(Button, {
				variant: "ghost",
				size: "sm",
				className: "h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground",
				title: "Add field",
				onClick: () => openForm(),
				children: [/* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5" }), "Field"]
			});
			$[11] = t7;
		} else t7 = $[11];
		return t7;
	}
	let t7;
	if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = () => setOpenState(null);
		$[12] = t7;
	} else t7 = $[12];
	let t8;
	if ($[13] !== block || $[14] !== handleAdd || $[15] !== onConfigureNewSchema || $[16] !== openState.initialName || $[17] !== openState.key) {
		t8 = /* @__PURE__ */ jsx(PropertyPicker, {
			initialName: openState.initialName,
			onAdd: handleAdd,
			onConfigureNewSchema,
			autoFocus: true,
			onEscape: t7,
			block
		}, openState.key);
		$[13] = block;
		$[14] = handleAdd;
		$[15] = onConfigureNewSchema;
		$[16] = openState.initialName;
		$[17] = openState.key;
		$[18] = t8;
	} else t8 = $[18];
	let t10;
	let t9;
	if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = /* @__PURE__ */ jsx(PropertyEmptyValue, {});
		t10 = /* @__PURE__ */ jsx("div", {});
		$[19] = t10;
		$[20] = t9;
	} else {
		t10 = $[19];
		t9 = $[20];
	}
	let t11;
	if ($[21] !== t8) {
		t11 = /* @__PURE__ */ jsxs("div", {
			className: "grid items-center gap-2 border-b border-border/40 py-0.5 text-sm",
			style: PROPERTY_ROW_GRID_STYLE,
			children: [
				t8,
				t9,
				t10
			]
		});
		$[21] = t8;
		$[22] = t11;
	} else t11 = $[22];
	return t11;
}
function PropertyEmptyValue() {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0",
			children: /* @__PURE__ */ jsx("div", {
				className: "h-7 truncate py-1 text-sm text-muted-foreground/55",
				children: "Empty"
			})
		});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
}
//#endregion
export { AddPropertyForm };

//# sourceMappingURL=AddPropertyForm.js.map