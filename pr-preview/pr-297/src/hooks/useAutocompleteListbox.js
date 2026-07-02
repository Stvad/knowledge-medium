import { useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/hooks/useAutocompleteListbox.ts
/** The shared interaction core of the autocomplete dropdowns (ref/tag/
*  type/property pickers): the active-option index, arrow-key navigation,
*  Enter/Tab commit, and the option mouse + a11y wiring. It is
*  search-agnostic — the caller fetches its own options (debounced or not)
*  and feeds the current list's length in via `itemCount`. */
function useAutocompleteListbox(t0) {
	const $ = c(18);
	const { itemCount, onCommit, setOpen, wrap: t1, commitOnTab: t2, listboxId } = t0;
	const wrap = t1 === void 0 ? false : t1;
	const commitOnTab = t2 === void 0 ? false : t2;
	const [activeIndex, setActiveIndex] = useState(0);
	let t3;
	if ($[0] !== itemCount || $[1] !== wrap) {
		t3 = (delta) => {
			setActiveIndex((index) => {
				if (itemCount <= 0) return index;
				if (wrap) return (index + delta + itemCount) % itemCount;
				return Math.min(Math.max(index + delta, 0), itemCount - 1);
			});
		};
		$[0] = itemCount;
		$[1] = wrap;
		$[2] = t3;
	} else t3 = $[2];
	const move = t3;
	let t4;
	if ($[3] !== activeIndex || $[4] !== commitOnTab || $[5] !== move || $[6] !== onCommit || $[7] !== setOpen) {
		t4 = (event) => {
			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					setOpen(true);
					move(1);
					return;
				case "ArrowUp":
					event.preventDefault();
					setOpen(true);
					move(-1);
					return;
				case "Enter":
					if (onCommit(activeIndex)) event.preventDefault();
					return;
				case "Tab":
					if (commitOnTab && onCommit(activeIndex)) event.preventDefault();
					return;
			}
		};
		$[3] = activeIndex;
		$[4] = commitOnTab;
		$[5] = move;
		$[6] = onCommit;
		$[7] = setOpen;
		$[8] = t4;
	} else t4 = $[8];
	const onKeyDown = t4;
	let t5;
	if ($[9] !== activeIndex || $[10] !== listboxId || $[11] !== onCommit) {
		t5 = (index_0) => ({
			role: "option",
			id: listboxId ? `${listboxId}-option-${index_0}` : void 0,
			"aria-selected": index_0 === activeIndex,
			onMouseEnter: () => setActiveIndex(index_0),
			onMouseDown: _temp,
			onClick: () => {
				onCommit(index_0);
			}
		});
		$[9] = activeIndex;
		$[10] = listboxId;
		$[11] = onCommit;
		$[12] = t5;
	} else t5 = $[12];
	const getOptionProps = t5;
	const t6 = listboxId ? `${listboxId}-option-${activeIndex}` : void 0;
	let t7;
	if ($[13] !== activeIndex || $[14] !== getOptionProps || $[15] !== onKeyDown || $[16] !== t6) {
		t7 = {
			activeIndex,
			setActiveIndex,
			activeDescendantId: t6,
			onKeyDown,
			getOptionProps
		};
		$[13] = activeIndex;
		$[14] = getOptionProps;
		$[15] = onKeyDown;
		$[16] = t6;
		$[17] = t7;
	} else t7 = $[17];
	return t7;
}
function _temp(event_0) {
	return event_0.preventDefault();
}
//#endregion
export { useAutocompleteListbox };

//# sourceMappingURL=useAutocompleteListbox.js.map