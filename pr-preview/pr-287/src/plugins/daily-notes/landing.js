import { getOrCreateDailyNote, todayIso } from "./dailyNotes.js";
//#region src/plugins/daily-notes/landing.ts
var todayDailyNoteLanding = async ({ repo, workspaceId }) => {
	return (await getOrCreateDailyNote(repo, workspaceId, todayIso())).id;
};
//#endregion
export { todayDailyNoteLanding };

//# sourceMappingURL=landing.js.map