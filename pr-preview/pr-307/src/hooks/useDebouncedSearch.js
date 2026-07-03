import { useDebouncedValue } from "./useDebouncedValue.js";
import { useCallback, useEffect, useRef, useState } from "react";
//#region src/hooks/useDebouncedSearch.ts
/** Debounced, self-cancelling async search feeding an autocomplete list.
*
*  Pairs with `useAutocompleteListbox` (which owns the active-index/keyboard
*  interaction) — this hook owns only the query→results half: trim, debounce,
*  fire once the debounce settles, and drop any in-flight request the moment
*  the input changes OR `reset()` is called. That cancellation is what keeps a
*  late result for the previous (or cleared) text from repopulating `results`
*  and letting a commit add a stale entry; centralizing it here — `reset()`
*  included — means each consumer can't re-break that race independently. */
function useDebouncedSearch({ query, delayMs, enabled = true, search, onResults, revalidateOn = [] }) {
	const [results, setResults] = useState([]);
	const [resultsQuery, setResultsQuery] = useState("");
	const trimmed = query.trim();
	const debounced = useDebouncedValue(trimmed, delayMs);
	const searchRef = useRef(search);
	const onResultsRef = useRef(onResults);
	useEffect(() => {
		searchRef.current = search;
		onResultsRef.current = onResults;
	});
	const resetTokenRef = useRef(0);
	useEffect(() => {
		if (!enabled || !debounced || trimmed !== debounced) return;
		let cancelled = false;
		const resetToken = resetTokenRef.current;
		searchRef.current(debounced).then((next) => {
			if (cancelled || resetToken !== resetTokenRef.current) return;
			setResults(next);
			setResultsQuery(debounced);
			onResultsRef.current?.(next);
		});
		return () => {
			cancelled = true;
		};
	}, [
		enabled,
		debounced,
		trimmed,
		...revalidateOn
	]);
	return {
		results,
		resultsQuery,
		reset: useCallback(() => {
			resetTokenRef.current++;
			setResults([]);
			setResultsQuery("");
		}, [])
	};
}
//#endregion
export { useDebouncedSearch };

//# sourceMappingURL=useDebouncedSearch.js.map