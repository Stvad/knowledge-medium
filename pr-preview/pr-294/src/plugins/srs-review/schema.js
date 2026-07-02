import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
//#region src/plugins/srs-review/schema.ts
var SRS_REVIEW_DECK_TYPE = "srs-review-deck";
/** The tag a deck reviews, stored as the bare page name (matching
*  `blockTagsConfigProp`). Resolved to a block id at query time via
*  `core.aliasLookup`. Empty string is the "all due" deck — every SRS
*  card due today or earlier, regardless of tag. */
var reviewDeckTagProp = defineProperty("srs-review:deck-tag", {
	codec: codecs.string,
	defaultValue: "",
	changeScope: ChangeScope.BlockDefault
});
/** False until the user picks a deck in the in-place picker; flips the
*  deck renderer from the picker to the review session. A persisted
*  flag (rather than React state) so reopening the deck block resumes
*  the chosen deck instead of dropping back to the picker. The session
*  writes it back to false via its "Change deck" affordance. */
var reviewDeckStartedProp = defineProperty("srs-review:deck-started", {
	codec: codecs.boolean,
	defaultValue: false,
	changeScope: ChangeScope.BlockDefault
});
var srsReviewDeckType = defineBlockType({
	id: SRS_REVIEW_DECK_TYPE,
	label: "SRS review deck",
	properties: [reviewDeckTagProp, reviewDeckStartedProp]
});
var SRS_REVIEW_PROGRESS_TYPE = "srs-review-progress";
/** Single object property (one write per state change) rather than five
*  scalar props. `ChangeScope.UiState` routes it into the ui-state
*  subtree, undo-segregated from document edits — it's session/UI state,
*  not document content. */
var reviewProgressProp = defineProperty("srs-review:progress", {
	codec: codecs.unsafeIdentity(),
	defaultValue: null,
	changeScope: ChangeScope.UiState
});
var srsReviewProgressType = defineBlockType({
	id: SRS_REVIEW_PROGRESS_TYPE,
	label: "SRS review progress",
	properties: [reviewProgressProp]
});
//#endregion
export { SRS_REVIEW_DECK_TYPE, SRS_REVIEW_PROGRESS_TYPE, reviewDeckStartedProp, reviewDeckTagProp, reviewProgressProp, srsReviewDeckType, srsReviewProgressType };

//# sourceMappingURL=schema.js.map