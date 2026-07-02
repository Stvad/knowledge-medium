import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { DAILY_NOTE_TYPE } from "../daily-notes/schema.js";
//#region src/plugins/srs-rescheduling/schema.ts
var SRS_SM25_TYPE = "srs-sm2.5";
var srsIntervalProp = defineProperty("interval", {
	codec: codecs.number,
	defaultValue: 2,
	changeScope: ChangeScope.BlockDefault
});
var srsFactorProp = defineProperty("factor", {
	codec: codecs.number,
	defaultValue: 2.5,
	changeScope: ChangeScope.BlockDefault
});
var srsNextReviewDateProp = defineProperty("next-review-date", {
	codec: codecs.ref({ targetTypes: [DAILY_NOTE_TYPE] }),
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
var srsReviewCountProp = defineProperty("review-count", {
	codec: codecs.number,
	defaultValue: 0,
	changeScope: ChangeScope.BlockDefault
});
var srsGradeProp = defineProperty("grade", {
	codec: codecs.number,
	defaultValue: 0,
	changeScope: ChangeScope.BlockDefault
});
var srsArchivedProp = defineProperty("archived", {
	codec: codecs.boolean,
	defaultValue: false,
	changeScope: ChangeScope.BlockDefault
});
var srsSnapshotHistoryProp = defineProperty("snapshot-history", {
	codec: codecs.list(codecs.unsafeIdentity()),
	defaultValue: [],
	changeScope: ChangeScope.BlockDefault
});
var srsSm25Type = defineBlockType({
	id: SRS_SM25_TYPE,
	label: "SRS SM-2.5",
	structural: true,
	properties: [
		srsIntervalProp,
		srsFactorProp,
		srsNextReviewDateProp,
		srsReviewCountProp,
		srsGradeProp,
		srsArchivedProp,
		srsSnapshotHistoryProp
	]
});
//#endregion
export { SRS_SM25_TYPE, srsArchivedProp, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp, srsSm25Type, srsSnapshotHistoryProp };

//# sourceMappingURL=schema.js.map