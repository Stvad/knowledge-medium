//#region src/utils/dailyPage.ts
var ordinalSuffix = (day) => {
	if (day >= 11 && day <= 13) return "th";
	switch (day % 10) {
		case 1: return "st";
		case 2: return "nd";
		case 3: return "rd";
		default: return "th";
	}
};
/** "April 26th, 2026" — Roam-style long form, en-US, used as a page alias. */
var formatRoamDate = (date) => {
	const month = date.toLocaleString("en-US", { month: "long" });
	const day = date.getDate();
	return `${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()}`;
};
/** "2026-04-26" — ISO local-date form, used as a secondary page alias. */
var formatIsoDate = (date) => {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
/** Both daily-page aliases for the given date, long form first. */
var dailyPageAliases = (date) => [formatRoamDate(date), formatIsoDate(date)];
//#endregion
export { dailyPageAliases, formatIsoDate, formatRoamDate };

//# sourceMappingURL=dailyPage.js.map