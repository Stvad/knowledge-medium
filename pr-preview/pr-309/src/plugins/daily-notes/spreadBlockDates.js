import { addDaysIso, todayIso } from "./dailyNotes.js";
import { pickBlockDateAdapter } from "./blockDateAdapter.js";
//#region src/plugins/daily-notes/spreadBlockDates.ts
var normalizeDays = (days) => {
	const wholeDays = Math.floor(days);
	if (!Number.isFinite(wholeDays) || wholeDays < 1) throw new Error("Choose at least 1 day");
	return wholeDays;
};
/** Maps a `[0,1)` random value to an integer day offset in
*  `[1, days]`. Exported so per-block randomness stays reproducible
*  in tests. */
var randomUpcomingDateOffset = (days, random = Math.random) => {
	const dayCount = normalizeDays(days);
	const value = Math.max(0, Math.min(random(), .999999999999));
	return 1 + Math.floor(value * dayCount);
};
var spreadBlockDates = async (runtime, blocks, options) => {
	const dayCount = normalizeDays(options.days);
	const random = options.random ?? Math.random;
	const baseIso = todayIso(options.now ?? /* @__PURE__ */ new Date());
	let eligible = 0;
	let updated = 0;
	for (const block of blocks) {
		if (!block.peek()) await block.load();
		const adapter = pickBlockDateAdapter(runtime, block);
		if (!adapter) continue;
		eligible += 1;
		const targetIso = addDaysIso(baseIso, randomUpcomingDateOffset(dayCount, random));
		if (await adapter.setIso(block, targetIso)) updated += 1;
	}
	return {
		eligible,
		updated,
		skipped: blocks.length - eligible
	};
};
//#endregion
export { randomUpcomingDateOffset, spreadBlockDates };

//# sourceMappingURL=spreadBlockDates.js.map