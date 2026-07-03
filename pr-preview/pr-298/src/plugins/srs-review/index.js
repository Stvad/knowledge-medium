import { getBlockTypes } from "../../data/properties.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionContextsFacet, actionsFacet, blockRenderersFacet } from "../../extensions/core.js";
import { dailyNotesDataExtension } from "../daily-notes/dataExtension.js";
import { referencesDataExtension } from "../references/dataExtension.js";
import "../srs-rescheduling/schema.js";
import { srsReschedulingDataExtension } from "../srs-rescheduling/dataExtension.js";
import { ArchiveX } from "../../../node_modules/lucide-react/dist/esm/icons/archive-x.js";
import { GraduationCap } from "../../../node_modules/lucide-react/dist/esm/icons/graduation-cap.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { navigateFromGlobalCommand } from "../../utils/navigation.js";
import { blockLayoutFacet } from "../../extensions/blockInteraction.js";
import "../daily-notes/index.js";
import { blockTaggingDataExtension } from "../block-tagging/dataExtension.js";
import "../srs-rescheduling/index.js";
import { SRS_REVIEW_DECK_TYPE, reviewDeckStartedProp, reviewDeckTagProp, srsReviewDeckType } from "./schema.js";
import { srsReviewDataExtension } from "./dataExtension.js";
import { buildDueCardsQuery, dueBoundary } from "./dueQuery.js";
import { archiveSrsCard } from "./archive.js";
import { srsReviewActionContext, srsReviewActions } from "./actions.js";
import { srsReviewCardLayoutContribution } from "./reviewCardLayout.js";
import { SrsReviewDeckRenderer } from "./ReviewDeckRenderer.js";
import { getOrCreateReviewDeck, reviewDeckBlockId } from "./deck.js";
//#region src/plugins/srs-review/index.ts
var OPEN_SRS_REVIEW_ACTION_ID = "open_srs_review";
var SRS_ARCHIVE_ACTION_ID = "srs.archive";
var openReviewAction = (repo) => ({
	id: OPEN_SRS_REVIEW_ACTION_ID,
	description: "Open SRS review",
	context: ActionContextTypes.GLOBAL,
	icon: GraduationCap,
	handler: async () => {
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId) return;
		navigateFromGlobalCommand(repo, {
			blockId: (await getOrCreateReviewDeck(repo, workspaceId)).id,
			workspaceId
		});
	},
	defaultBinding: { keys: "Control+Shift+r" }
});
var srsArchiveAction = {
	id: SRS_ARCHIVE_ACTION_ID,
	description: "SRS: Archive card",
	context: ActionContextTypes.NORMAL_MODE,
	icon: ArchiveX,
	isVisible: ({ block }) => {
		const data = block.peek();
		return !!data && getBlockTypes(data).includes("srs-sm2.5");
	},
	handler: async ({ block }) => {
		await archiveSrsCard(block);
	}
};
var srsReviewPlugin = ({ repo }) => systemToggle({
	id: "system:srs-review",
	name: "SRS review",
	description: "Deck-based review mode for spaced-repetition cards due today or earlier."
}).of([
	srsReschedulingDataExtension,
	dailyNotesDataExtension,
	referencesDataExtension,
	blockTaggingDataExtension,
	srsReviewDataExtension,
	blockRenderersFacet.of({
		id: "srsReviewDeck",
		renderer: SrsReviewDeckRenderer
	}, { source: "srs-review" }),
	blockLayoutFacet.of(srsReviewCardLayoutContribution, { source: "srs-review" }),
	actionsFacet.of(openReviewAction(repo), { source: "srs-review" }),
	actionsFacet.of(srsArchiveAction, { source: "srs-review" }),
	actionContextsFacet.of(srsReviewActionContext, { source: "srs-review" }),
	srsReviewActions.map((action) => actionsFacet.of(action, { source: "srs-review" }))
]);
//#endregion
export { OPEN_SRS_REVIEW_ACTION_ID, SRS_ARCHIVE_ACTION_ID, SRS_REVIEW_DECK_TYPE, buildDueCardsQuery, dueBoundary, getOrCreateReviewDeck, reviewDeckBlockId, reviewDeckStartedProp, reviewDeckTagProp, srsReviewDeckType, srsReviewPlugin };

//# sourceMappingURL=index.js.map