import { getBlockTypes } from "../../data/properties.js";
import { srsArchivedProp } from "../srs-rescheduling/schema.js";
import "../srs-rescheduling/index.js";
//#region src/plugins/srs-review/archive.ts
/** Mark an SRS card archived. Archived cards drop out of the due-cards
*  query (`buildDueCardsQuery` excludes `archived: true`), so this is
*  how a card leaves review for good. No-op on non-SRS or read-only
*  blocks. Returns whether the write happened. */
var archiveSrsCard = async (block) => {
	if (block.repo.isReadOnly) return false;
	const data = block.peek() ?? await block.load();
	if (!data || !getBlockTypes(data).includes("srs-sm2.5")) return false;
	await block.set(srsArchivedProp, true);
	return true;
};
//#endregion
export { archiveSrsCard };

//# sourceMappingURL=archive.js.map