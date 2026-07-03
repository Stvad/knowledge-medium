import { useHandle } from "../../hooks/block.js";
import { chipStateFor, chipTitle } from "./chipState.js";
import { useEffect, useState } from "react";
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
var ClaudeStatusChipRow = (t0) => {
	const $ = c(18);
	const { block, Inner } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp2 };
		$[0] = t1;
	} else t1 = $[0];
	const chip = useHandle(block, t1);
	if (!chip) {
		let t2;
		if ($[1] !== Inner || $[2] !== block) {
			t2 = /* @__PURE__ */ jsx(Inner, { block });
			$[1] = Inner;
			$[2] = block;
			$[3] = t2;
		} else t2 = $[3];
		return t2;
	}
	let t2;
	if ($[4] !== Inner || $[5] !== block) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: "min-w-0 flex-1",
			children: /* @__PURE__ */ jsx(Inner, { block })
		});
		$[4] = Inner;
		$[5] = block;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== chip) {
		t3 = chipTitle(chip);
		$[7] = chip;
		$[8] = t3;
	} else t3 = $[8];
	const t4 = chip.kind;
	let t5;
	if ($[9] !== chip) {
		t5 = chipBody(chip);
		$[9] = chip;
		$[10] = t5;
	} else t5 = $[10];
	let t6;
	if ($[11] !== chip.kind || $[12] !== t3 || $[13] !== t5) {
		t6 = /* @__PURE__ */ jsx("span", {
			title: t3,
			"data-claude-chip": t4,
			className: "mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground",
			children: t5
		});
		$[11] = chip.kind;
		$[12] = t3;
		$[13] = t5;
		$[14] = t6;
	} else t6 = $[14];
	let t7;
	if ($[15] !== t2 || $[16] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full items-start gap-1",
			children: [t2, t6]
		});
		$[15] = t2;
		$[16] = t6;
		$[17] = t7;
	} else t7 = $[17];
	return t7;
};
var decoratorCache = /* @__PURE__ */ new WeakMap();
var decorate = (inner) => {
	const existing = decoratorCache.get(inner);
	if (existing) return existing;
	const Decorated = (t0) => {
		const $ = c(2);
		const { block } = t0;
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(ClaudeStatusChipRow, {
				block,
				Inner: inner
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Decorated.displayName = "WithClaudeStatusChip";
	decoratorCache.set(inner, Decorated);
	return Decorated;
};
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