import { isEnabled } from "../../facets/togglable.js";
import { Button } from "../../components/ui/button.js";
import { buildAppHash } from "../../utils/routing.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Label } from "../../components/ui/label.js";
import { useExtensionApprovalStatus } from "../../extensions/extensionApprovalStatus.js";
import { Fragment } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/extensions-settings/ExtensionsSettings.tsx
/**
* Presentational tree of toggle rows for the Extensions settings
* surface.
*
* Pure: takes a discovered `ToggleNode[]` + the current `Overrides`
* map + an `onToggle(handle, next)` callback, and renders nested
* checkboxes. The caller threads `onToggle` into a write to the
* Extensions block (see `setOverride`, slice 9c).
*
* Conventions:
*
*   - Each row is a checkbox + label + (optional) description.
*   - Essentials render as `checked` and `disabled` — they cannot be
*     flipped through the UI (the `isEnabled` filter forces them on
*     anyway, so a flippable checkbox would only confuse).
*   - Children indent one level via padding; ARIA `treeitem` /
*     `aria-level` carries the nesting for assistive tech and tests.
*/
/** Stable-sort the tree so essentials surface first within each level,
*  then alphabetical (case-insensitive, locale-aware) within each
*  (essential / non-essential) group. Static catalog order remains the
*  runtime order; the settings UI reorders purely for discoverability. */
var nameComparator = new Intl.Collator(void 0, { sensitivity: "base" });
var compareNodes = (a, b) => {
	const aEss = a.handle.essential === true ? 0 : 1;
	const bEss = b.handle.essential === true ? 0 : 1;
	if (aEss !== bEss) return aEss - bEss;
	return nameComparator.compare(a.handle.name, b.handle.name);
};
var groupEssentialsFirst = (nodes) => {
	return nodes.toSorted(compareNodes).map((node) => ({
		handle: node.handle,
		children: groupEssentialsFirst(node.children)
	}));
};
var ExtensionsSettings = (t0) => {
	const $ = c(22);
	const { tree, overrides, onToggle, onApprove, workspaceId } = t0;
	let t1;
	let t2;
	if ($[0] !== tree) {
		const system = [];
		const user = [];
		for (const root of tree) if (root.handle.kind === "user") user.push(root);
		else system.push(root);
		t1 = groupEssentialsFirst(system);
		t2 = groupEssentialsFirst(user);
		$[0] = tree;
		$[1] = t1;
		$[2] = t2;
	} else {
		t1 = $[1];
		t2 = $[2];
	}
	let t3;
	if ($[3] !== t1 || $[4] !== t2) {
		t3 = {
			system: t1,
			user: t2
		};
		$[3] = t1;
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	const sections = t3;
	if (sections.system.length === 0 && sections.user.length === 0) {
		let t4;
		if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
			t4 = /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: "No extensions to display."
			});
			$[6] = t4;
		} else t4 = $[6];
		return t4;
	}
	let t4;
	if ($[7] !== onApprove || $[8] !== onToggle || $[9] !== overrides || $[10] !== sections.system || $[11] !== workspaceId) {
		t4 = sections.system.length > 0 && /* @__PURE__ */ jsx(Section, {
			title: "Built-in extensions",
			nodes: sections.system,
			overrides,
			onToggle,
			onApprove,
			workspaceId
		});
		$[7] = onApprove;
		$[8] = onToggle;
		$[9] = overrides;
		$[10] = sections.system;
		$[11] = workspaceId;
		$[12] = t4;
	} else t4 = $[12];
	let t5;
	if ($[13] !== onApprove || $[14] !== onToggle || $[15] !== overrides || $[16] !== sections.user || $[17] !== workspaceId) {
		t5 = sections.user.length > 0 && /* @__PURE__ */ jsx(Section, {
			title: "User extensions",
			nodes: sections.user,
			overrides,
			onToggle,
			onApprove,
			workspaceId
		});
		$[13] = onApprove;
		$[14] = onToggle;
		$[15] = overrides;
		$[16] = sections.user;
		$[17] = workspaceId;
		$[18] = t5;
	} else t5 = $[18];
	let t6;
	if ($[19] !== t4 || $[20] !== t5) {
		t6 = /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col gap-4",
			children: [t4, t5]
		});
		$[19] = t4;
		$[20] = t5;
		$[21] = t6;
	} else t6 = $[21];
	return t6;
};
var Section = (t0) => {
	const $ = c(18);
	const { title, nodes, overrides, onToggle, onApprove, workspaceId } = t0;
	let t1;
	if ($[0] !== title) {
		t1 = /* @__PURE__ */ jsx("h3", {
			className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
			children: title
		});
		$[0] = title;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== nodes || $[3] !== onApprove || $[4] !== onToggle || $[5] !== overrides || $[6] !== workspaceId) {
		let t3;
		if ($[8] !== onApprove || $[9] !== onToggle || $[10] !== overrides || $[11] !== workspaceId) {
			t3 = (node) => /* @__PURE__ */ jsx(ToggleRow, {
				node,
				overrides,
				onToggle,
				onApprove,
				workspaceId,
				level: 1
			}, node.handle.id);
			$[8] = onApprove;
			$[9] = onToggle;
			$[10] = overrides;
			$[11] = workspaceId;
			$[12] = t3;
		} else t3 = $[12];
		t2 = nodes.map(t3);
		$[2] = nodes;
		$[3] = onApprove;
		$[4] = onToggle;
		$[5] = overrides;
		$[6] = workspaceId;
		$[7] = t2;
	} else t2 = $[7];
	let t3;
	if ($[13] !== t2) {
		t3 = /* @__PURE__ */ jsx("ul", {
			role: "tree",
			className: "flex flex-col gap-1",
			children: t2
		});
		$[13] = t2;
		$[14] = t3;
	} else t3 = $[14];
	let t4;
	if ($[15] !== t1 || $[16] !== t3) {
		t4 = /* @__PURE__ */ jsxs("section", {
			className: "flex flex-col gap-1",
			children: [t1, t3]
		});
		$[15] = t1;
		$[16] = t3;
		$[17] = t4;
	} else t4 = $[17];
	return t4;
};
var ToggleRow = (t0) => {
	const $ = c(53);
	const { node, overrides, onToggle, onApprove, workspaceId, level } = t0;
	const { handle, children } = node;
	let t1;
	if ($[0] !== handle || $[1] !== overrides) {
		t1 = isEnabled(handle, overrides);
		$[0] = handle;
		$[1] = overrides;
		$[2] = t1;
	} else t1 = $[2];
	const checked = t1;
	const essential = handle.essential === true;
	const approvalStatus = useExtensionApprovalStatus(handle.id);
	const checkboxId = `system-plugin-toggle-${handle.id}`;
	const labelId = `${checkboxId}-label`;
	let t2;
	if ($[3] !== handle.id || $[4] !== handle.kind || $[5] !== workspaceId) {
		t2 = handle.kind === "user" && workspaceId ? buildAppHash(workspaceId, handle.id) : void 0;
		$[3] = handle.id;
		$[4] = handle.kind;
		$[5] = workspaceId;
		$[6] = t2;
	} else t2 = $[6];
	const definitionHref = t2;
	const indent = (level - 1) * 16;
	let t3;
	if ($[7] !== indent) {
		t3 = { paddingInlineStart: indent };
		$[7] = indent;
		$[8] = t3;
	} else t3 = $[8];
	let t4;
	if ($[9] !== essential || $[10] !== handle || $[11] !== onToggle) {
		t4 = (next) => {
			if (essential) return;
			onToggle(handle, next === true);
		};
		$[9] = essential;
		$[10] = handle;
		$[11] = onToggle;
		$[12] = t4;
	} else t4 = $[12];
	let t5;
	if ($[13] !== checkboxId || $[14] !== checked || $[15] !== essential || $[16] !== labelId || $[17] !== t4) {
		t5 = /* @__PURE__ */ jsx(Checkbox, {
			id: checkboxId,
			"aria-labelledby": labelId,
			checked,
			disabled: essential,
			onCheckedChange: t4
		});
		$[13] = checkboxId;
		$[14] = checked;
		$[15] = essential;
		$[16] = labelId;
		$[17] = t4;
		$[18] = t5;
	} else t5 = $[18];
	let t6;
	if ($[19] !== checkboxId || $[20] !== definitionHref || $[21] !== essential || $[22] !== handle.id || $[23] !== handle.name || $[24] !== labelId) {
		t6 = definitionHref ? /* @__PURE__ */ jsx("a", {
			id: labelId,
			href: definitionHref,
			"data-block-id": handle.id,
			className: "rounded-sm text-sm font-medium leading-none text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			title: "Open extension definition",
			children: handle.name
		}) : /* @__PURE__ */ jsxs(Label, {
			id: labelId,
			htmlFor: checkboxId,
			className: essential ? "text-muted-foreground" : void 0,
			children: [handle.name, essential && /* @__PURE__ */ jsx("span", {
				className: "ml-2 text-xs text-muted-foreground",
				children: "(essential)"
			})]
		});
		$[19] = checkboxId;
		$[20] = definitionHref;
		$[21] = essential;
		$[22] = handle.id;
		$[23] = handle.name;
		$[24] = labelId;
		$[25] = t6;
	} else t6 = $[25];
	let t7;
	if ($[26] !== handle.description) {
		t7 = handle.description && /* @__PURE__ */ jsx("span", {
			className: "text-xs text-muted-foreground",
			children: handle.description
		});
		$[26] = handle.description;
		$[27] = t7;
	} else t7 = $[27];
	let t8;
	if ($[28] !== approvalStatus || $[29] !== handle || $[30] !== onApprove) {
		t8 = handle.kind === "user" && approvalStatus && onApprove && /* @__PURE__ */ jsxs("div", {
			className: "mt-1 flex items-center gap-2",
			children: [/* @__PURE__ */ jsx("span", {
				className: "text-xs text-amber-600 dark:text-amber-500",
				children: approvalStatus.kind === "needs-approval" ? "Not approved on this device" : "Running an older approved version — Update to adopt the latest source"
			}), /* @__PURE__ */ jsx(Button, {
				type: "button",
				size: "sm",
				variant: "outline",
				onClick: () => onApprove(handle),
				children: approvalStatus.kind === "needs-approval" ? "Enable here" : "Update"
			})]
		});
		$[28] = approvalStatus;
		$[29] = handle;
		$[30] = onApprove;
		$[31] = t8;
	} else t8 = $[31];
	let t9;
	if ($[32] !== t6 || $[33] !== t7 || $[34] !== t8) {
		t9 = /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col",
			children: [
				t6,
				t7,
				t8
			]
		});
		$[32] = t6;
		$[33] = t7;
		$[34] = t8;
		$[35] = t9;
	} else t9 = $[35];
	let t10;
	if ($[36] !== checked || $[37] !== handle.name || $[38] !== level || $[39] !== t3 || $[40] !== t5 || $[41] !== t9) {
		t10 = /* @__PURE__ */ jsxs("li", {
			role: "treeitem",
			"aria-level": level,
			"aria-checked": checked,
			"aria-label": handle.name,
			className: "flex items-start gap-2",
			style: t3,
			children: [t5, t9]
		});
		$[36] = checked;
		$[37] = handle.name;
		$[38] = level;
		$[39] = t3;
		$[40] = t5;
		$[41] = t9;
		$[42] = t10;
	} else t10 = $[42];
	let t11;
	if ($[43] !== children || $[44] !== level || $[45] !== onApprove || $[46] !== onToggle || $[47] !== overrides || $[48] !== workspaceId) {
		t11 = children.length > 0 && children.map((child) => /* @__PURE__ */ jsx(ToggleRow, {
			node: child,
			overrides,
			onToggle,
			onApprove,
			workspaceId,
			level: level + 1
		}, child.handle.id));
		$[43] = children;
		$[44] = level;
		$[45] = onApprove;
		$[46] = onToggle;
		$[47] = overrides;
		$[48] = workspaceId;
		$[49] = t11;
	} else t11 = $[49];
	let t12;
	if ($[50] !== t10 || $[51] !== t11) {
		t12 = /* @__PURE__ */ jsxs(Fragment, { children: [t10, t11] });
		$[50] = t10;
		$[51] = t11;
		$[52] = t12;
	} else t12 = $[52];
	return t12;
};
//#endregion
export { ExtensionsSettings };

//# sourceMappingURL=ExtensionsSettings.js.map