import "../../data/blockTypes.js";
import { useRepo } from "../../context/repo.js";
import { useHandle } from "../../hooks/block.js";
import { MarkdownContentRenderer } from "../../components/renderer/MarkdownContentRenderer.js";
import { DefaultBlockRenderer } from "../../components/renderer/DefaultBlockRenderer.js";
import { BlockLoadingPlaceholder } from "../../components/BlockLoadingPlaceholder.js";
import { LazyViewportMount } from "../../components/util/LazyViewportMount.js";
import { BlockEmbed } from "../../components/references/BlockEmbed.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/recents/RecentsPageBlockRenderer.tsx
/** Renderer for the Recents page. Wraps the default page layout and
*  swaps the content area for a Tana-style list of recently-edited
*  blocks, backed by the kernel `recentBlocks` query. Each row uses
*  `BlockEmbed` so the block goes through the regular renderer chain
*  (markdown, wikilinks, click semantics) instead of a custom
*  string-truncating row. */
var RECENTS_LIMIT = 50;
var CLOCK_TICK_MS = 6e4;
var ROW_ESTIMATED_HEIGHT_PX = 64;
var ROW_OVERSCAN_PX = 600;
var subscribeClock = (listener) => {
	const id = window.setInterval(listener, CLOCK_TICK_MS);
	return () => window.clearInterval(id);
};
var getClockSnapshot = () => Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
var getServerClockSnapshot = () => 0;
var useMinuteClock = () => {
	return useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot);
};
var formatRelative = (ts, now) => {
	if (now === 0) return "";
	const diffMs = now - ts;
	if (diffMs < 0) return "just now";
	const sec = Math.floor(diffMs / 1e3);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d ago`;
	return new Date(ts).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric"
	});
};
var RecentRowPlaceholder = (t0) => {
	const $ = c(5);
	const { reservedHeight } = t0;
	let t1;
	if ($[0] !== reservedHeight) {
		t1 = { minHeight: reservedHeight };
		$[0] = reservedHeight;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(BlockLoadingPlaceholder, { reservedHeight: 32 });
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] !== t1) {
		t3 = /* @__PURE__ */ jsx("div", {
			className: "py-2",
			style: t1,
			"aria-hidden": true,
			children: t2
		});
		$[3] = t1;
		$[4] = t3;
	} else t3 = $[4];
	return t3;
};
function RecentRow(t0) {
	const $ = c(14);
	const { data, now } = t0;
	const t1 = `recents:${data.id}`;
	const t2 = `row:${data.id}`;
	let t3;
	if ($[0] !== data.id || $[1] !== t2) {
		t3 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0 flex-1",
			children: /* @__PURE__ */ jsx(BlockEmbed, {
				blockId: data.id,
				sourceBlockId: "recents",
				occurrenceId: t2
			})
		});
		$[0] = data.id;
		$[1] = t2;
		$[2] = t3;
	} else t3 = $[2];
	let t4;
	if ($[3] !== data.userUpdatedAt || $[4] !== now) {
		t4 = formatRelative(data.userUpdatedAt, now);
		$[3] = data.userUpdatedAt;
		$[4] = now;
		$[5] = t4;
	} else t4 = $[5];
	let t5;
	if ($[6] !== t4) {
		t5 = /* @__PURE__ */ jsx("span", {
			className: "shrink-0 pt-1 text-xs text-muted-foreground tabular-nums",
			children: t4
		});
		$[6] = t4;
		$[7] = t5;
	} else t5 = $[7];
	let t6;
	if ($[8] !== t3 || $[9] !== t5) {
		t6 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-start justify-between gap-3 py-1",
			children: [t3, t5]
		});
		$[8] = t3;
		$[9] = t5;
		$[10] = t6;
	} else t6 = $[10];
	let t7;
	if ($[11] !== t1 || $[12] !== t6) {
		t7 = /* @__PURE__ */ jsx(LazyViewportMount, {
			cacheKey: t1,
			estimatedHeightPx: ROW_ESTIMATED_HEIGHT_PX,
			overscanPx: ROW_OVERSCAN_PX,
			renderPlaceholder: _temp,
			children: t6
		});
		$[11] = t1;
		$[12] = t6;
		$[13] = t7;
	} else t7 = $[13];
	return t7;
}
function _temp(props) {
	return /* @__PURE__ */ jsx(RecentRowPlaceholder, { ...props });
}
function RecentsList(t0) {
	const $ = c(12);
	const { workspaceId } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== repo.query || $[1] !== workspaceId) {
		t1 = repo.query.recentBlocks({
			workspaceId,
			limit: RECENTS_LIMIT
		});
		$[0] = repo.query;
		$[1] = workspaceId;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: _temp2 };
		$[3] = t2;
	} else t2 = $[3];
	const recents = useHandle(t1, t2);
	const now = useMinuteClock();
	if (recents.length === 0) {
		let t3;
		if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
			t3 = /* @__PURE__ */ jsx("div", {
				className: "py-6 text-sm text-muted-foreground",
				children: "No recent edits yet — edit a block and it will show up here."
			});
			$[4] = t3;
		} else t3 = $[4];
		return t3;
	}
	let t3;
	if ($[5] !== now || $[6] !== recents) {
		let t4;
		if ($[8] !== now) {
			t4 = (data_0) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(RecentRow, {
				data: data_0,
				now
			}) }, data_0.id);
			$[8] = now;
			$[9] = t4;
		} else t4 = $[9];
		t3 = recents.map(t4);
		$[5] = now;
		$[6] = recents;
		$[7] = t3;
	} else t3 = $[7];
	let t4;
	if ($[10] !== t3) {
		t4 = /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col divide-y divide-border/40 border-t border-border/40",
			children: t3
		});
		$[10] = t3;
		$[11] = t4;
	} else t4 = $[11];
	return t4;
}
function _temp2(data) {
	return data ?? [];
}
var RecentsPageContentRenderer = (props) => {
	const $ = c(7);
	const { block } = props;
	const workspaceId = block.peek()?.workspaceId;
	let t0;
	if ($[0] !== props) {
		t0 = /* @__PURE__ */ jsx(MarkdownContentRenderer, { ...props });
		$[0] = props;
		$[1] = t0;
	} else t0 = $[1];
	let t1;
	if ($[2] !== workspaceId) {
		t1 = workspaceId && /* @__PURE__ */ jsx(RecentsList, { workspaceId });
		$[2] = workspaceId;
		$[3] = t1;
	} else t1 = $[3];
	let t2;
	if ($[4] !== t0 || $[5] !== t1) {
		t2 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full flex-col gap-3",
			children: [t0, t1]
		});
		$[4] = t0;
		$[5] = t1;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
};
RecentsPageContentRenderer.displayName = "RecentsPageContentRenderer";
var RecentsPageBlockRenderer = Object.assign((props) => /* @__PURE__ */ jsx(DefaultBlockRenderer, {
	...props,
	ContentRenderer: RecentsPageContentRenderer
}), {
	canRender: ({ block }) => {
		const data = block.peek();
		if (!data) return false;
		const types = data.properties.types;
		return Array.isArray(types) && types.includes("panel:recents");
	},
	priority: () => 100
});
RecentsPageBlockRenderer.displayName = "RecentsPageBlockRenderer";
//#endregion
export { RecentsPageBlockRenderer };

//# sourceMappingURL=RecentsPageBlockRenderer.js.map