import { useHandle, usePropertyValue } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { backlinksViewFacet } from "./facet.js";
import { backlinksViewProp, defaultBacklinksViewIdForBlock } from "./prop.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/backlinks-view/BacklinksViewSection.tsx
/**
* Footer section that drives the variant pick:
* - reads registered variants from `backlinksViewFacet`
* - reads the current block's optional saved choice from `backlinksViewProp`
* - otherwise derives the default view from the block (daily notes use grouped)
* - mounts only the selected variant — unselected variants never run
*   their queries, since their hooks live inside their components and
*   only mount when rendered
*
* The "are there any backlinks?" gate lives inside the selected variant,
* which receives `controls` and decides whether to render them. That lets
* grouped backlinks gate from its grouped snapshot instead of forcing this
* coordinator to run an unconditional flat backlinks query first.
*/
function BacklinksViewSection(t0) {
	const $ = c(17);
	const { block, resolveContext } = t0;
	const runtime = useAppRuntime();
	let t1;
	if ($[0] !== resolveContext || $[1] !== runtime) {
		t1 = runtime.read(backlinksViewFacet)(resolveContext);
		$[0] = resolveContext;
		$[1] = runtime;
		$[2] = t1;
	} else t1 = $[2];
	const variants = t1.all;
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: defaultBacklinksViewIdForBlock };
		$[3] = t2;
	} else t2 = $[3];
	const defaultId = useHandle(block, t2);
	const [overrideId, setOverrideId] = usePropertyValue(block, backlinksViewProp);
	const selectedId = overrideId ?? defaultId;
	let t3;
	if ($[4] !== defaultId || $[5] !== selectedId || $[6] !== variants) {
		t3 = variants.find((v_0) => v_0.id === selectedId) ?? variants.find((v) => v.id === defaultId) ?? variants[0];
		$[4] = defaultId;
		$[5] = selectedId;
		$[6] = variants;
		$[7] = t3;
	} else t3 = $[7];
	const selected = t3;
	if (!selected) return null;
	const Selected = selected.render;
	let t4;
	if ($[8] !== defaultId || $[9] !== selected.id || $[10] !== setOverrideId || $[11] !== variants) {
		t4 = variants.length > 1 && /* @__PURE__ */ jsx("div", {
			className: "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
			role: "group",
			"aria-label": "Backlinks view",
			children: variants.map((variant) => {
				const active = variant.id === selected.id;
				return /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => setOverrideId(variant.id === defaultId ? void 0 : variant.id),
					className: `leading-4 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${active ? "font-medium text-foreground" : "hover:text-foreground"}`,
					"aria-pressed": active,
					children: variant.label
				}, variant.id);
			})
		});
		$[8] = defaultId;
		$[9] = selected.id;
		$[10] = setOverrideId;
		$[11] = variants;
		$[12] = t4;
	} else t4 = $[12];
	const t5 = t4 || void 0;
	let t6;
	if ($[13] !== Selected || $[14] !== block || $[15] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			onClick: _temp,
			children: /* @__PURE__ */ jsx(Selected, {
				block,
				controls: t5
			})
		});
		$[13] = Selected;
		$[14] = block;
		$[15] = t5;
		$[16] = t6;
	} else t6 = $[16];
	return t6;
}
/** Coordinator footer contribution. Captures the resolve context so
*  the section component can read `backlinksViewFacet` (whose
*  resolver takes `BlockResolveContext`) without rebuilding it inside
*  the React tree. The captured ctx is stable per (block, panel, ...)
*  thanks to `DefaultBlockRenderer`'s resolve-context memo, so the
*  wrapper component identity is stable per block. */
function _temp(event) {
	return event.stopPropagation();
}
var backlinksViewFooterContribution = (ctx) => {
	if (!ctx.isTopLevel) return null;
	const Section = (props) => {
		const $ = c(2);
		let t0;
		if ($[0] !== props) {
			t0 = /* @__PURE__ */ jsx(BacklinksViewSection, {
				...props,
				resolveContext: ctx
			});
			$[0] = props;
			$[1] = t0;
		} else t0 = $[1];
		return t0;
	};
	Section.displayName = "BacklinksViewSection";
	return Section;
};
//#endregion
export { BacklinksViewSection, backlinksViewFooterContribution };

//# sourceMappingURL=BacklinksViewSection.js.map