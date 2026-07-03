import { useRepo } from "../../../context/repo.js";
import { useWorkspaceId } from "../../../hooks/block.js";
import { cachedContentDecorator } from "../../../extensions/blockInteraction.js";
import { BacklinksViewSection } from "../../backlinks-view/BacklinksViewSection.js";
import { inlineBacklinksApplies } from "./applies.js";
import { useBacklinkCount } from "./useBacklinkCount.js";
import { toggleBacklinkExpansion, useBacklinkExpansion } from "./expansionStore.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/backlinks/inline-counts/InlineBacklinkCount.tsx
var InlineBacklinkCountBadge = (t0) => {
	const $ = c(10);
	const { block, Inner } = t0;
	const count = useBacklinkCount(block, useWorkspaceId(block, useRepo().activeWorkspaceId ?? ""));
	const expanded = useBacklinkExpansion(block.id);
	let t1;
	if ($[0] !== Inner || $[1] !== block) {
		t1 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0 flex-1",
			children: /* @__PURE__ */ jsx(Inner, { block })
		});
		$[0] = Inner;
		$[1] = block;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== block.id || $[4] !== count || $[5] !== expanded) {
		t2 = count > 0 && /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: () => toggleBacklinkExpansion(block.id),
			"aria-expanded": expanded,
			"aria-label": `${count} linked reference${count === 1 ? "" : "s"}`,
			title: `${count} linked reference${count === 1 ? "" : "s"}`,
			className: `mt-0.5 inline-flex h-4 min-w-4 shrink-0 select-none items-center justify-center rounded-full px-1 text-xs leading-none tabular-nums transition-colors ${expanded ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`,
			children: count
		});
		$[3] = block.id;
		$[4] = count;
		$[5] = expanded;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== t1 || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full items-start gap-1",
			children: [t1, t2]
		});
		$[7] = t1;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	return t3;
};
var decorate = cachedContentDecorator(InlineBacklinkCountBadge, "WithInlineBacklinkCount");
var inlineBacklinkCountDecoratorContribution = (ctx) => inlineBacklinksApplies(ctx) ? decorate : null;
var ExpandedBacklinks = (t0) => {
	const $ = c(3);
	const { block, resolveContext } = t0;
	if (useBacklinkCount(block, useWorkspaceId(block, useRepo().activeWorkspaceId ?? "")) === 0) return null;
	let t1;
	if ($[0] !== block || $[1] !== resolveContext) {
		t1 = /* @__PURE__ */ jsx(BacklinksViewSection, {
			block,
			resolveContext
		});
		$[0] = block;
		$[1] = resolveContext;
		$[2] = t1;
	} else t1 = $[2];
	return t1;
};
ExpandedBacklinks.displayName = "ExpandedBacklinks";
var inlineBacklinkExpansionFooterContribution = (ctx) => {
	if (!inlineBacklinksApplies(ctx)) return null;
	const Section = (t0) => {
		const $ = c(2);
		const { block } = t0;
		if (!useBacklinkExpansion(block.id)) return null;
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(ExpandedBacklinks, {
				block,
				resolveContext: ctx
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Section.displayName = "InlineBacklinkExpansion";
	return Section;
};
//#endregion
export { inlineBacklinkCountDecoratorContribution, inlineBacklinkExpansionFooterContribution };

//# sourceMappingURL=InlineBacklinkCount.js.map