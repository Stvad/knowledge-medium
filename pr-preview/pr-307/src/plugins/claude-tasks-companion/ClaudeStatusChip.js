import { useHandle } from "../../hooks/block.js";
import { cachedContentDecorator } from "../../extensions/blockInteraction.js";
import { chipStateFor, chipTitle } from "./chipState.js";
import { clearAskedClaude, isAskedClaude, subscribeAskedClaude } from "./askedStore.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/claude-tasks-companion/ClaudeStatusChip.tsx
/** Claude task status chip — a small pill in the block's right gutter
*  driven purely by the `claude:*` properties the claude-tasks daemon
*  writes (running → replied ✓ / failed ⚠). The graph is the feedback
*  channel: props sync reactively to every device, so this needs no
*  daemon connection — it just makes the lifecycle visible.
*
*  Same gutter pattern as the inline backlink count badge: with no
*  chip, content renders untouched (no wrapper). */
/** Ticks once a second while mounted — only running chips mount it. */
var useElapsedLabel = (sinceMs) => {
	const $ = c(7);
	const [nowMs, setNowMs] = useState(_temp);
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = () => {
			const timer = setInterval(() => setNowMs(Date.now()), 1e3);
			return () => clearInterval(timer);
		};
		t1 = [];
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	useEffect(t0, t1);
	if (sinceMs === null) return null;
	let t2;
	if ($[2] !== nowMs || $[3] !== sinceMs) {
		t2 = Math.round((nowMs - sinceMs) / 1e3);
		$[2] = nowMs;
		$[3] = sinceMs;
		$[4] = t2;
	} else t2 = $[4];
	const seconds = Math.max(0, t2);
	if (seconds < 100) return `${seconds}s`;
	let t3;
	if ($[5] !== seconds) {
		t3 = Math.round(seconds / 60);
		$[5] = seconds;
		$[6] = t3;
	} else t3 = $[6];
	return `${t3}m`;
};
var RunningChip = (t0) => {
	const $ = c(3);
	const { chip } = t0;
	const elapsed = useElapsedLabel(chip.updatedAtMs);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx("span", {
			className: "animate-pulse text-amber-600",
			children: "●"
		});
		$[0] = t1;
	} else t1 = $[0];
	const t2 = elapsed ? ` · ${elapsed}` : "";
	let t3;
	if ($[1] !== t2) {
		t3 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t1, /* @__PURE__ */ jsxs("span", { children: ["Claude", t2] })] });
		$[1] = t2;
		$[2] = t3;
	} else t3 = $[2];
	return t3;
};
var chipBody = (chip) => {
	switch (chip.kind) {
		case "queued": return /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("span", {
			className: "text-muted-foreground",
			children: "●"
		}), /* @__PURE__ */ jsx("span", { children: "Claude…" })] });
		case "running": return /* @__PURE__ */ jsx(RunningChip, { chip });
		case "done": return /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("span", {
			className: "text-emerald-600",
			children: "✓"
		}), /* @__PURE__ */ jsx("span", { children: "Claude" })] });
		case "error": return /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("span", {
			className: "text-red-600",
			children: "⚠"
		}), /* @__PURE__ */ jsx("span", { children: "Claude" })] });
	}
};
/** Optimistic "queued" shown between the Ask Claude action and the
*  daemon's claim writing real props. */
var OPTIMISTIC_QUEUED = {
	kind: "queued",
	updatedAtMs: null,
	attempts: 1,
	errorMessage: ""
};
var ClaudeStatusChipRow = (t0) => {
	const $ = c(24);
	const { block, Inner } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp2 };
		$[0] = t1;
	} else t1 = $[0];
	const propsChip = useHandle(block, t1);
	let t2;
	if ($[1] !== block.id) {
		t2 = () => isAskedClaude(block.id);
		$[1] = block.id;
		$[2] = t2;
	} else t2 = $[2];
	const asked = useSyncExternalStore(subscribeAskedClaude, t2);
	let t3;
	let t4;
	if ($[3] !== block.id || $[4] !== propsChip) {
		t3 = () => {
			if (propsChip) clearAskedClaude(block.id);
		};
		t4 = [propsChip, block.id];
		$[3] = block.id;
		$[4] = propsChip;
		$[5] = t3;
		$[6] = t4;
	} else {
		t3 = $[5];
		t4 = $[6];
	}
	useEffect(t3, t4);
	const chip = propsChip ?? (asked ? OPTIMISTIC_QUEUED : null);
	if (!chip) {
		let t5;
		if ($[7] !== Inner || $[8] !== block) {
			t5 = /* @__PURE__ */ jsx(Inner, { block });
			$[7] = Inner;
			$[8] = block;
			$[9] = t5;
		} else t5 = $[9];
		return t5;
	}
	let t5;
	if ($[10] !== Inner || $[11] !== block) {
		t5 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0 flex-1",
			children: /* @__PURE__ */ jsx(Inner, { block })
		});
		$[10] = Inner;
		$[11] = block;
		$[12] = t5;
	} else t5 = $[12];
	let t6;
	if ($[13] !== chip) {
		t6 = chipTitle(chip);
		$[13] = chip;
		$[14] = t6;
	} else t6 = $[14];
	const t7 = chip.kind;
	let t8;
	if ($[15] !== chip) {
		t8 = chipBody(chip);
		$[15] = chip;
		$[16] = t8;
	} else t8 = $[16];
	let t9;
	if ($[17] !== chip.kind || $[18] !== t6 || $[19] !== t8) {
		t9 = /* @__PURE__ */ jsx("span", {
			title: t6,
			"data-claude-chip": t7,
			className: "mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground",
			children: t8
		});
		$[17] = chip.kind;
		$[18] = t6;
		$[19] = t8;
		$[20] = t9;
	} else t9 = $[20];
	let t10;
	if ($[21] !== t5 || $[22] !== t9) {
		t10 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full items-start gap-1",
			children: [t5, t9]
		});
		$[21] = t5;
		$[22] = t9;
		$[23] = t10;
	} else t10 = $[23];
	return t10;
};
var decorate = cachedContentDecorator(ClaudeStatusChipRow, "WithClaudeStatusChip");
/** Chips attach everywhere except nested surfaces (embeds, backlink
*  entries, breadcrumbs) — a status pill repeated through every embed
*  of a mention is noise; the canonical block carries it. */
var claudeStatusChipContribution = (ctx) => ctx.blockContext?.isNestedSurface ? null : decorate;
function _temp() {
	return Date.now();
}
function _temp2(doc) {
	return chipStateFor(doc?.properties);
}
//#endregion
export { claudeStatusChipContribution };

//# sourceMappingURL=ClaudeStatusChip.js.map