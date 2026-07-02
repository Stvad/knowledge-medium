import v5 from "../../../node_modules/uuid/dist/v5.js";
import { dailyNoteBlockId } from "../daily-notes/dailyNotes.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
import "../daily-notes/index.js";
//#region src/plugins/roam-import/ids.ts
var ROAM_IMPORT_NS = "b8d6f1c2-7e9a-4f4d-a4f1-2c0a3a6e7f01";
var roamBlockId = (workspaceId, roamUid) => v5(`${workspaceId}:roam:${roamUid}`, ROAM_IMPORT_NS);
var resolveDailyPage = (workspaceId, page) => {
	const parsed = parseLiteralDailyPageTitle(page.title);
	if (parsed) return {
		iso: parsed.iso,
		blockId: dailyNoteBlockId(workspaceId, parsed.iso)
	};
	const isoFromUid = isoFromDateUid(page.uid);
	if (isoFromUid) return {
		iso: isoFromUid,
		blockId: dailyNoteBlockId(workspaceId, isoFromUid)
	};
	if (page[":log/id"] !== void 0) {
		const iso = isoFromLogId(page[":log/id"]);
		if (iso) return {
			iso,
			blockId: dailyNoteBlockId(workspaceId, iso)
		};
	}
	return null;
};
var isoFromDateUid = (uid) => {
	const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(uid);
	if (!match) return null;
	const [, mm, dd, yyyy] = match;
	return `${yyyy}-${mm}-${dd}`;
};
var isoFromLogId = (logId) => {
	if (!Number.isFinite(logId)) return null;
	const date = new Date(logId);
	if (Number.isNaN(date.getTime())) return null;
	const yyyy = date.getUTCFullYear();
	if (yyyy < 1e3 || yyyy > 9999) return null;
	return `${yyyy}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};
//#endregion
export { ROAM_IMPORT_NS, resolveDailyPage, roamBlockId };

//# sourceMappingURL=ids.js.map