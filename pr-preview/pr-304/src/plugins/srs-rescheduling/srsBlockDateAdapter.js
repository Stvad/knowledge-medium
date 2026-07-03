import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { aliasesProp, getBlockTypes } from "../../data/properties.js";
import { getOrCreateDailyNote, isValidDateAlias } from "../daily-notes/dailyNotes.js";
import { srsNextReviewDateProp } from "./schema.js";
import "../daily-notes/index.js";
//#region src/plugins/srs-rescheduling/srsBlockDateAdapter.ts
var decodeNextReviewDateId = (properties) => {
	const stored = properties[srsNextReviewDateProp.name];
	if (stored === void 0) return null;
	try {
		return srsNextReviewDateProp.codec.decode(stored) || null;
	} catch {
		return null;
	}
};
var decodeAliases = (properties) => {
	const stored = properties[aliasesProp.name];
	if (stored === void 0) return [];
	try {
		return aliasesProp.codec.decode(stored);
	} catch {
		return [];
	}
};
var dailyNoteIsoFromBlockId = async (block, dailyNoteId) => {
	const data = await block.repo.load(dailyNoteId);
	if (!data) return null;
	const aliasIso = decodeAliases(data.properties).find(isValidDateAlias);
	if (aliasIso) return aliasIso;
	const content = data.content.trim();
	return isValidDateAlias(content) ? content : null;
};
var srsBlockDateAdapter = {
	id: "srs-rescheduling.next-review-date",
	canHandle: (block) => {
		const data = block.peek();
		if (!data) return false;
		if (!getBlockTypes(data).includes("srs-sm2.5")) return false;
		return decodeNextReviewDateId(data.properties) !== null;
	},
	getCurrentIso: async (block) => {
		const data = block.peek() ?? await block.load();
		if (!data || !getBlockTypes(data).includes("srs-sm2.5")) return null;
		const dailyId = decodeNextReviewDateId(data.properties);
		if (!dailyId) return null;
		return dailyNoteIsoFromBlockId(block, dailyId);
	},
	setIso: async (block, iso) => {
		if (block.repo.isReadOnly) return false;
		const data = block.peek() ?? await block.load();
		if (!data || !getBlockTypes(data).includes("srs-sm2.5")) return false;
		const targetDaily = await getOrCreateDailyNote(block.repo, data.workspaceId, iso);
		let written = false;
		await block.repo.tx(async (tx) => {
			const row = await tx.get(block.id);
			if (!row || !getBlockTypes(row).includes("srs-sm2.5")) return;
			await tx.update(block.id, { properties: {
				...row.properties,
				[srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(targetDaily.id)
			} });
			written = true;
		}, {
			scope: ChangeScope.BlockDefault,
			description: "set srs next review date"
		});
		return written;
	}
};
//#endregion
export { srsBlockDateAdapter };

//# sourceMappingURL=srsBlockDateAdapter.js.map