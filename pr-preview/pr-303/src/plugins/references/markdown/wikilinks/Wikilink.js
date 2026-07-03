import { useAppRuntime } from "../../../../extensions/runtimeContext.js";
import { buildAppHash } from "../../../../utils/routing.js";
import { useOpenBlock } from "../../../../utils/navigation.js";
import { isWikilinkDisplayParts, resolveWikilinkDisplay } from "./wikilinkDecorator.js";
import { c } from "react/compiler-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/references/markdown/wikilinks/Wikilink.tsx
function Wikilink(t0) {
	const $ = c(27);
	const { alias, blockId, sourceBlock, workspaceId, hasCustomDisplay: t1, children } = t0;
	const hasCustomDisplay = t1 === void 0 ? false : t1;
	let t2;
	if ($[0] !== blockId || $[1] !== workspaceId) {
		t2 = {
			blockId,
			workspaceId
		};
		$[0] = blockId;
		$[1] = workspaceId;
		$[2] = t2;
	} else t2 = $[2];
	const onClick = useOpenBlock(t2);
	const runtime = useAppRuntime();
	let decorated;
	let t3;
	if ($[3] !== alias || $[4] !== blockId || $[5] !== hasCustomDisplay || $[6] !== runtime || $[7] !== sourceBlock || $[8] !== workspaceId) {
		decorated = hasCustomDisplay ? null : resolveWikilinkDisplay(runtime, {
			alias,
			blockId,
			sourceBlock,
			workspaceId,
			runtime
		});
		t3 = isWikilinkDisplayParts(decorated) ? decorated : null;
		$[3] = alias;
		$[4] = blockId;
		$[5] = hasCustomDisplay;
		$[6] = runtime;
		$[7] = sourceBlock;
		$[8] = workspaceId;
		$[9] = decorated;
		$[10] = t3;
	} else {
		decorated = $[9];
		t3 = $[10];
	}
	const decoratedParts = t3;
	const display = decoratedParts ? decoratedParts.content : decorated ?? children;
	const before = decoratedParts?.before;
	const after = decoratedParts?.after;
	if (!blockId) {
		let t4;
		if ($[11] !== after || $[12] !== before || $[13] !== display) {
			t4 = /* @__PURE__ */ jsxs("span", { children: [
				before,
				display,
				after
			] });
			$[11] = after;
			$[12] = before;
			$[13] = display;
			$[14] = t4;
		} else t4 = $[14];
		return t4;
	}
	let t4;
	if ($[15] !== blockId || $[16] !== workspaceId) {
		t4 = buildAppHash(workspaceId, blockId);
		$[15] = blockId;
		$[16] = workspaceId;
		$[17] = t4;
	} else t4 = $[17];
	let t5;
	if ($[18] !== alias || $[19] !== display || $[20] !== onClick || $[21] !== t4) {
		t5 = /* @__PURE__ */ jsx("a", {
			href: t4,
			className: "wikilink",
			"data-alias": alias,
			onClick,
			children: display
		});
		$[18] = alias;
		$[19] = display;
		$[20] = onClick;
		$[21] = t4;
		$[22] = t5;
	} else t5 = $[22];
	let t6;
	if ($[23] !== after || $[24] !== before || $[25] !== t5) {
		t6 = /* @__PURE__ */ jsxs(Fragment, { children: [
			before,
			t5,
			after
		] });
		$[23] = after;
		$[24] = before;
		$[25] = t5;
		$[26] = t6;
	} else t6 = $[26];
	return t6;
}
//#endregion
export { Wikilink };

//# sourceMappingURL=Wikilink.js.map