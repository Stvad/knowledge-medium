import { useUser } from "../../components/Login.js";
import { actionsFacet } from "../../extensions/core.js";
import { useRepo } from "../../context/repo.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { celebrationCycle, isBirthdayToday, isForced, isRecipient, msUntilNextLocalMidnight } from "./gate.js";
import { applyWolfTheme, syncWolfTheme } from "./wolfTheme.js";
import { BirthdayOverlay } from "./BirthdayOverlay.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/birthday/BirthdayCelebration.tsx
var OVERLAY_KEY = "birthday:overlay-shown";
/** Runtime-contribution bucket for the command-palette entry. Pushed only
*  while the celebration is live so "Theme: Wolf" appears in the palette
*  on the day (and nowhere else) — the way back if he switches away. */
var WOLF_ACTION_SOURCE = "birthday.wolf-theme-action";
var wolfThemeAction = {
	id: "birthday.apply-wolf-theme",
	description: "Theme: Wolf 🐺",
	context: ActionContextTypes.GLOBAL,
	handler: () => {
		applyWolfTheme();
	}
};
function readOverlayShown() {
	try {
		return window.localStorage?.getItem(OVERLAY_KEY) ?? null;
	} catch {
		return null;
	}
}
function markOverlayShown(cycle) {
	try {
		window.localStorage?.setItem(OVERLAY_KEY, cycle);
	} catch {}
}
function BirthdayCelebration() {
	const $ = c(7);
	const user = useUser();
	const repo = useRepo();
	const [showOverlay, setShowOverlay] = useState(false);
	let t0;
	let t1;
	if ($[0] !== repo || $[1] !== user.id) {
		t0 = () => {
			let cancelled = false;
			let timer;
			const run = async () => {
				const now = /* @__PURE__ */ new Date();
				const cycle = celebrationCycle(now);
				const isBirthday = isBirthdayToday(now) && await isRecipient(user.id);
				if (cancelled) return;
				syncWolfTheme(isBirthday, cycle);
				if (repo.facetRuntime) repo.setRuntimeContributions(actionsFacet, WOLF_ACTION_SOURCE, isBirthday ? [wolfThemeAction] : []);
				if (isBirthday && (isForced() || readOverlayShown() !== cycle)) {
					markOverlayShown(cycle);
					setShowOverlay(true);
				}
				timer = setTimeout(() => void run(), msUntilNextLocalMidnight(now) + 1e3);
			};
			run();
			return () => {
				cancelled = true;
				if (timer) clearTimeout(timer);
				if (repo.facetRuntime) repo.setRuntimeContributions(actionsFacet, WOLF_ACTION_SOURCE, []);
			};
		};
		t1 = [user.id, repo];
		$[0] = repo;
		$[1] = user.id;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	useEffect(t0, t1);
	if (!showOverlay) return null;
	const t2 = user.name ?? void 0;
	let t3;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = () => setShowOverlay(false);
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] !== t2) {
		t4 = /* @__PURE__ */ jsx(BirthdayOverlay, {
			name: t2,
			onClose: t3
		});
		$[5] = t2;
		$[6] = t4;
	} else t4 = $[6];
	return t4;
}
//#endregion
export { BirthdayCelebration };

//# sourceMappingURL=BirthdayCelebration.js.map