import { installDateScrubAuxListeners } from "./dateScrubGesture.js";
import { useEffect } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/daily-notes/DateKeyboardScrubController.tsx
var DateKeyboardScrubController = () => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = [];
		$[0] = t0;
	} else t0 = $[0];
	useEffect(_temp, t0);
	return null;
};
function _temp() {
	return installDateScrubAuxListeners();
}
//#endregion
export { DateKeyboardScrubController };

//# sourceMappingURL=DateKeyboardScrubController.js.map