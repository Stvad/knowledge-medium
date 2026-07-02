import { getOrCreateKernelPage, kernelPageBlockId } from "../../data/kernelPage.js";
import { SRS_REVIEW_DECK_TYPE } from "./schema.js";
//#region src/plugins/srs-review/deck.ts
var REVIEW_DECK_NS = "c3f1a9d4-2b8e-4f57-bc6a-1e9d8a4f2c70";
var REVIEW_DECK_ALIAS = "SRS Review";
var reviewDeckBlockId = (workspaceId) => kernelPageBlockId(workspaceId, REVIEW_DECK_NS);
/** Get-or-create the workspace's singleton review-deck page. Shares the
*  kernel-page bootstrap (deterministic id, PAGE_TYPE + marker type,
*  restore-on-reach) with Recents / Properties / Types. The
*  `srs-review-deck` marker is what `SrsReviewDeckRenderer.canRender`
*  keys on. */
var getOrCreateReviewDeck = (repo, workspaceId) => getOrCreateKernelPage(repo, workspaceId, {
	namespace: REVIEW_DECK_NS,
	alias: REVIEW_DECK_ALIAS,
	markerType: SRS_REVIEW_DECK_TYPE
});
//#endregion
export { getOrCreateReviewDeck, reviewDeckBlockId };

//# sourceMappingURL=deck.js.map