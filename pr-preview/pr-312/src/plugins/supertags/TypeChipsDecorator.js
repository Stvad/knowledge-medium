import { typesProp } from "../../data/properties.js";
import { useProperty, useWorkspaceId } from "../../hooks/block.js";
import { buildAppHash } from "../../utils/routing.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { useTypes } from "../../hooks/typeRegistry.js";
import { TypeChip } from "../../components/typeChip/TypeChip.js";
import { visibleTagTypeIds } from "./typeAutocomplete.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/supertags/TypeChipsDecorator.tsx
var TypeChips = (t0) => {
	const $ = c(17);
	const { block, typeIds, registry } = t0;
	const repo = block.repo;
	const readOnly = repo.isReadOnly;
	const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? "");
	const openBlock = useBlockOpener();
	let t1;
	if ($[0] !== block || $[1] !== openBlock || $[2] !== readOnly || $[3] !== registry || $[4] !== repo.userTypes || $[5] !== typeIds || $[6] !== workspaceId) {
		let t2;
		if ($[8] !== block || $[9] !== openBlock || $[10] !== readOnly || $[11] !== registry || $[12] !== repo.userTypes || $[13] !== workspaceId) {
			t2 = (typeId) => {
				const type = registry.get(typeId);
				const removable = !readOnly && type?.hideFromCompletion !== true;
				const definitionId = repo.userTypes.getTypeBlockId(typeId);
				return /* @__PURE__ */ jsx(TypeChip, {
					typeId,
					type,
					withHash: true,
					link: definitionId ? {
						href: buildAppHash(workspaceId, definitionId),
						onClick: (event) => openBlock(event, {
							blockId: definitionId,
							workspaceId
						})
					} : void 0,
					onRemove: removable ? () => {
						block.removeType(typeId);
					} : void 0
				}, typeId);
			};
			$[8] = block;
			$[9] = openBlock;
			$[10] = readOnly;
			$[11] = registry;
			$[12] = repo.userTypes;
			$[13] = workspaceId;
			$[14] = t2;
		} else t2 = $[14];
		t1 = typeIds.map(t2);
		$[0] = block;
		$[1] = openBlock;
		$[2] = readOnly;
		$[3] = registry;
		$[4] = repo.userTypes;
		$[5] = typeIds;
		$[6] = workspaceId;
		$[7] = t1;
	} else t1 = $[7];
	let t2;
	if ($[15] !== t1) {
		t2 = /* @__PURE__ */ jsx("span", {
			role: "group",
			className: "flex min-w-0 flex-wrap items-center gap-1",
			"aria-label": "Block types",
			children: t1
		});
		$[15] = t1;
		$[16] = t2;
	} else t2 = $[16];
	return t2;
};
/** Layout: chips hug the end of the content instead of claiming a
*  column. In a flex-WRAP container, line-breaking is decided on the
*  items' base sizes before any shrinking, so the chip row can never
*  squeeze the content narrower: short single-line content gets the
*  chips right after the text (Tana-ish); content long enough to wrap
*  puts them on their own row below. True Tana inline-in-the-last-line
*  isn't reachable while the content is a block-level editor — it
*  would need a CodeMirror end-of-doc widget. */
var TypeChipsDecorator = (t0) => {
	const $ = c(16);
	const { block, Inner } = t0;
	const [types] = useProperty(block, typesProp);
	const registry = useTypes();
	let t1;
	if ($[0] !== registry || $[1] !== types) {
		t1 = visibleTagTypeIds(types, registry);
		$[0] = registry;
		$[1] = types;
		$[2] = t1;
	} else t1 = $[2];
	const visible = t1;
	const t2 = visible.length > 0 ? "min-w-8 max-w-full has-[iframe]:w-full has-[video]:w-full has-[audio]:w-full" : "w-full";
	let t3;
	if ($[3] !== Inner || $[4] !== block) {
		t3 = /* @__PURE__ */ jsx(Inner, { block });
		$[3] = Inner;
		$[4] = block;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== t2 || $[7] !== t3) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: t2,
			children: t3
		});
		$[6] = t2;
		$[7] = t3;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[9] !== block || $[10] !== registry || $[11] !== visible) {
		t5 = visible.length > 0 && /* @__PURE__ */ jsx(TypeChips, {
			block,
			typeIds: visible,
			registry
		});
		$[9] = block;
		$[10] = registry;
		$[11] = visible;
		$[12] = t5;
	} else t5 = $[12];
	let t6;
	if ($[13] !== t4 || $[14] !== t5) {
		t6 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5",
			children: [t4, t5]
		});
		$[13] = t4;
		$[14] = t5;
		$[15] = t6;
	} else t6 = $[15];
	return t6;
};
var cache = /* @__PURE__ */ new WeakMap();
var decorate = (inner) => {
	const existing = cache.get(inner);
	if (existing) return existing;
	const Decorated = (t0) => {
		const $ = c(2);
		const { block } = t0;
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(TypeChipsDecorator, {
				block,
				Inner: inner
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Decorated.displayName = "WithTypeChips";
	cache.set(inner, Decorated);
	return Decorated;
};
var typeChipsDecoratorContribution = () => decorate;
//#endregion
export { typeChipsDecoratorContribution };

//# sourceMappingURL=TypeChipsDecorator.js.map