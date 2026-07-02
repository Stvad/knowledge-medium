import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/hooks/useDebouncedValue.ts
/** Returns `value` delayed by `delayMs`, collapsing rapid changes into a
*  single trailing update — for debouncing a search query before firing
*  the request. The first value is returned immediately; subsequent
*  changes wait out `delayMs` of quiet. */
function useDebouncedValue(value, delayMs) {
	const $ = c(4);
	const [debounced, setDebounced] = useState(value);
	let t0;
	let t1;
	if ($[0] !== delayMs || $[1] !== value) {
		t0 = () => {
			const timer = setTimeout(() => setDebounced(value), delayMs);
			return () => clearTimeout(timer);
		};
		t1 = [value, delayMs];
		$[0] = delayMs;
		$[1] = value;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	useEffect(t0, t1);
	return debounced;
}
//#endregion
export { useDebouncedValue };

//# sourceMappingURL=useDebouncedValue.js.map