import { withMoveTransition } from "../../utils/viewTransition.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/breadcrumbs/usePromotableBreadcrumb.ts
/** Shared state for "promote-in-place" breadcrumbs: clicking an ancestor
*  unfurls it as the shown subtree root, with the same crossfade as panel
*  breadcrumb navigation. The shown id resets to `rootId` whenever it
*  changes, so a surface whose root swaps under it (e.g. the SRS card
*  advancing) snaps back to the new root; for a stable root (e.g. a
*  backlink entry) the reset never fires. */
function usePromotableBreadcrumb(rootId) {
	const $ = c(5);
	const [shownId, setShownId] = useState(rootId);
	const [prevRoot, setPrevRoot] = useState(rootId);
	if (prevRoot !== rootId) {
		setPrevRoot(rootId);
		setShownId(rootId);
	}
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = (blockId) => {
			withMoveTransition(async () => {
				setShownId(blockId);
			});
		};
		$[0] = t0;
	} else t0 = $[0];
	const showBlock = t0;
	let t1;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = (parent) => {
			showBlock(parent.id);
		};
		$[1] = t1;
	} else t1 = $[1];
	const promote = t1;
	const t2 = shownId === rootId;
	let t3;
	if ($[2] !== shownId || $[3] !== t2) {
		t3 = {
			shownId,
			isInitial: t2,
			promote,
			showBlock
		};
		$[2] = shownId;
		$[3] = t2;
		$[4] = t3;
	} else t3 = $[4];
	return t3;
}
//#endregion
export { usePromotableBreadcrumb };

//# sourceMappingURL=usePromotableBreadcrumb.js.map