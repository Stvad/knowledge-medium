import { propertySchemasFacet, typesFacet } from "../../data/facets.js";
import { srsArchivedProp, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp, srsSm25Type, srsSnapshotHistoryProp } from "./schema.js";
//#region src/plugins/srs-rescheduling/dataExtension.ts
var srsReschedulingDataExtension = [
	propertySchemasFacet.of(srsIntervalProp, { source: "srs-rescheduling" }),
	propertySchemasFacet.of(srsFactorProp, { source: "srs-rescheduling" }),
	propertySchemasFacet.of(srsNextReviewDateProp, { source: "srs-rescheduling" }),
	propertySchemasFacet.of(srsReviewCountProp, { source: "srs-rescheduling" }),
	propertySchemasFacet.of(srsGradeProp, { source: "srs-rescheduling" }),
	propertySchemasFacet.of(srsArchivedProp, { source: "srs-rescheduling" }),
	propertySchemasFacet.of(srsSnapshotHistoryProp, { source: "srs-rescheduling" }),
	typesFacet.of(srsSm25Type, { source: "srs-rescheduling" })
];
//#endregion
export { srsReschedulingDataExtension };

//# sourceMappingURL=dataExtension.js.map