import { propertySchemasFacet, typesFacet } from "../../data/facets.js";
import { reviewDeckStartedProp, reviewDeckTagProp, reviewProgressProp, srsReviewDeckType, srsReviewProgressType } from "./schema.js";
//#region src/plugins/srs-review/dataExtension.ts
var srsReviewDataExtension = [
	propertySchemasFacet.of(reviewDeckTagProp, { source: "srs-review" }),
	propertySchemasFacet.of(reviewDeckStartedProp, { source: "srs-review" }),
	propertySchemasFacet.of(reviewProgressProp, { source: "srs-review" }),
	typesFacet.of(srsReviewDeckType, { source: "srs-review" }),
	typesFacet.of(srsReviewProgressType, { source: "srs-review" })
];
//#endregion
export { srsReviewDataExtension };

//# sourceMappingURL=dataExtension.js.map