import { useRepo } from "../../context/repo.js";
import { useWorkspaceId } from "../../hooks/block.js";
import { buildAppHash } from "../../utils/routing.js";
import { useOpenBlock } from "../../utils/navigation.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/references/ReferenceLink.tsx
var RICH_CONTENT_SELECTOR = "img, video, audio, iframe, canvas, button, [role=\"button\"], [data-block-interaction=\"ignore\"]";
/**
* Classify a click inside the reference link. Walk from the click target up to —
* but NOT including — the reference link itself (`currentTarget`). Excluding
* `currentTarget` is essential: the reference's OWN `<a href>` is an ancestor of
* every click, so counting it would mishandle plain text.
*
*  - `'anchor'`: an enclosing nested `<a href>` (a markdown link, a nested
*    reference). A link is explicitly meant to be followed, so it wins over a
*    rich descendant it wraps (a LINKED image `[![](img)](url)` follows the link,
*    not the lightbox). It navigates via its NATIVE default action / own handler,
*    so the reference must do nothing and must NOT `preventDefault`, or the inner
*    link's navigation dies with it.
*  - `'rich'`: non-anchor interactive/media content NOT wrapped in a link. It
*    handled its own click (lightbox / play / button), so the reference suppresses
*    its OWN navigation (`preventDefault`) but doesn't open the target.
*  - `null`: plain content — the reference navigates to its target.
*/
var classifyReferenceClick = (event) => {
	const { target, currentTarget } = event;
	if (!(target instanceof Element)) return null;
	let rich = false;
	for (let el = target; el && el !== currentTarget; el = el.parentElement) {
		if (el.matches("a[href]")) return "anchor";
		if (!rich && el.matches(RICH_CONTENT_SELECTOR)) rich = true;
	}
	return rich ? "rich" : null;
};
/**
* A click that concludes a TEXT SELECTION anchored inside the reference (a
* drag-select, a double-click-to-select) shouldn't navigate and throw the
* selection away. A plain click collapses any prior selection on `mousedown`, so
* a non-collapsed selection at click time was produced by this very gesture; we
* only treat it as ours when its anchor (where the selection started) is inside
* the reference, so a stray selection elsewhere on the page doesn't block nav.
*/
var concludesTextSelection = (currentTarget) => {
	if (typeof window === "undefined") return false;
	const selection = window.getSelection();
	return !!selection && !selection.isCollapsed && currentTarget.contains(selection.anchorNode);
};
/**
* The navigating anchor a block reference wraps its content in: a
* workspace-scoped link that opens the target block on click. Shared by the
* reference layout (wrapping the target's raw content) and `BlockRef`'s alias
* short-circuit (wrapping the alias text, without mounting the target), so the
* href / open-block behaviour lives in one place.
*/
function ReferenceLink(t0) {
	const $ = c(13);
	const { block, children } = t0;
	const workspaceId = useWorkspaceId(block, useRepo().activeWorkspaceId ?? "");
	let t1;
	if ($[0] !== block.id || $[1] !== workspaceId) {
		t1 = {
			blockId: block.id,
			workspaceId
		};
		$[0] = block.id;
		$[1] = workspaceId;
		$[2] = t1;
	} else t1 = $[2];
	const openBlock = useOpenBlock(t1);
	let t2;
	if ($[3] !== block.id || $[4] !== workspaceId) {
		t2 = buildAppHash(workspaceId, block.id);
		$[3] = block.id;
		$[4] = workspaceId;
		$[5] = t2;
	} else t2 = $[5];
	const href = t2;
	let t3;
	if ($[6] !== openBlock) {
		t3 = (event) => {
			const owner = classifyReferenceClick(event);
			if (owner === "anchor") return;
			if (owner === "rich") {
				event.preventDefault();
				return;
			}
			if (concludesTextSelection(event.currentTarget)) return;
			openBlock(event);
		};
		$[6] = openBlock;
		$[7] = t3;
	} else t3 = $[7];
	let t4;
	if ($[8] !== block.id || $[9] !== children || $[10] !== href || $[11] !== t3) {
		t4 = /* @__PURE__ */ jsx("a", {
			href,
			className: "blockref text-inherit no-underline cursor-pointer rounded-sm px-0.5 hover:bg-muted/60",
			"data-block-id": block.id,
			draggable: false,
			onClick: t3,
			children
		});
		$[8] = block.id;
		$[9] = children;
		$[10] = href;
		$[11] = t3;
		$[12] = t4;
	} else t4 = $[12];
	return t4;
}
//#endregion
export { ReferenceLink, classifyReferenceClick };

//# sourceMappingURL=ReferenceLink.js.map