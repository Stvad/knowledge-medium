import { recentsPageBlockId } from "../../data/recentsPage.js";
import { useRepo } from "../../context/repo.js";
import { Clock } from "../../../node_modules/lucide-react/dist/esm/icons/clock.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/recents/HeaderItem.tsx
function RecentsHeaderItem() {
	const $ = c(7);
	const repo = useRepo();
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { plainClick: "navigator" };
		$[0] = t0;
	} else t0 = $[0];
	const openBlock = useBlockOpener(t0);
	let t1;
	if ($[1] !== openBlock || $[2] !== repo.activeWorkspaceId) {
		t1 = (event) => {
			const workspaceId = repo.activeWorkspaceId;
			if (!workspaceId) return;
			openBlock(event, { blockId: recentsPageBlockId(workspaceId) });
		};
		$[1] = openBlock;
		$[2] = repo.activeWorkspaceId;
		$[3] = t1;
	} else t1 = $[3];
	let t2;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(Clock, { className: "h-4 w-4" });
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] !== t1) {
		t3 = /* @__PURE__ */ jsx("button", {
			className: "inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-8",
			onClick: t1,
			title: "Recently edited blocks",
			"aria-label": "Open recents",
			children: t2
		});
		$[5] = t1;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
}
//#endregion
export { RecentsHeaderItem };

//# sourceMappingURL=HeaderItem.js.map