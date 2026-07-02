import { useEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/util/LazyViewportMount.tsx
/** Session-scoped cache of measured lazy-rendered heights, keyed by the
*  caller's stable cache key. It lets remounted placeholders reserve the
*  last known size for the same item, reducing layout shuffle. */
var measuredHeights = /* @__PURE__ */ new Map();
var mountedCacheKeys = /* @__PURE__ */ new Set();
/**
* Defers mounting expensive content until its placeholder approaches the
* viewport. Once mounted, content stays mounted; teardown churn is more
* expensive than keeping a few idle subscriptions alive.
*
* Test/SSR fallback: if IntersectionObserver is unavailable, mounts
* immediately so callers behave like their non-lazy equivalents.
*/
function LazyViewportMount(t0) {
	const $ = c(22);
	const { cacheKey, estimatedHeightPx, overscanPx, children, renderPlaceholder } = t0;
	let t1;
	if ($[0] !== cacheKey) {
		t1 = () => typeof IntersectionObserver === "undefined" || mountedCacheKeys.has(cacheKey);
		$[0] = cacheKey;
		$[1] = t1;
	} else t1 = $[1];
	const [mounted, setMounted] = useState(t1);
	const containerRef = useRef(null);
	let t2;
	let t3;
	if ($[2] !== cacheKey || $[3] !== mounted) {
		t2 = () => {
			if (mounted) mountedCacheKeys.add(cacheKey);
		};
		t3 = [mounted, cacheKey];
		$[2] = cacheKey;
		$[3] = mounted;
		$[4] = t2;
		$[5] = t3;
	} else {
		t2 = $[4];
		t3 = $[5];
	}
	useEffect(t2, t3);
	let t4;
	let t5;
	if ($[6] !== mounted || $[7] !== overscanPx) {
		t4 = () => {
			if (mounted) return;
			const el = containerRef.current;
			if (!el) return;
			const observer = new IntersectionObserver((entries) => {
				if (entries[0]?.isIntersecting) setMounted(true);
			}, { rootMargin: `${overscanPx}px 0px` });
			observer.observe(el);
			return () => observer.disconnect();
		};
		t5 = [mounted, overscanPx];
		$[6] = mounted;
		$[7] = overscanPx;
		$[8] = t4;
		$[9] = t5;
	} else {
		t4 = $[8];
		t5 = $[9];
	}
	useEffect(t4, t5);
	let t6;
	let t7;
	if ($[10] !== cacheKey || $[11] !== mounted) {
		t6 = () => {
			if (!mounted) return;
			const el_0 = containerRef.current;
			if (!el_0) return;
			if (typeof ResizeObserver === "undefined") return;
			const observer_0 = new ResizeObserver(() => {
				const h = el_0.offsetHeight;
				if (h > 0) measuredHeights.set(cacheKey, h);
			});
			observer_0.observe(el_0);
			return () => observer_0.disconnect();
		};
		t7 = [mounted, cacheKey];
		$[10] = cacheKey;
		$[11] = mounted;
		$[12] = t6;
		$[13] = t7;
	} else {
		t6 = $[12];
		t7 = $[13];
	}
	useEffect(t6, t7);
	if (mounted) {
		let t8;
		if ($[14] !== children) {
			t8 = /* @__PURE__ */ jsx("div", {
				ref: containerRef,
				children
			});
			$[14] = children;
			$[15] = t8;
		} else t8 = $[15];
		return t8;
	}
	let t8;
	if ($[16] !== cacheKey || $[17] !== estimatedHeightPx || $[18] !== renderPlaceholder) {
		t8 = renderPlaceholder({ reservedHeight: measuredHeights.get(cacheKey) ?? estimatedHeightPx });
		$[16] = cacheKey;
		$[17] = estimatedHeightPx;
		$[18] = renderPlaceholder;
		$[19] = t8;
	} else t8 = $[19];
	let t9;
	if ($[20] !== t8) {
		t9 = /* @__PURE__ */ jsx("div", {
			ref: containerRef,
			children: t8
		});
		$[20] = t8;
		$[21] = t9;
	} else t9 = $[21];
	return t9;
}
//#endregion
export { LazyViewportMount };

//# sourceMappingURL=LazyViewportMount.js.map