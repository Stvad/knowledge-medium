import { showProgress } from "../../utils/toast.js";
import { GraduationCap } from "../../../node_modules/lucide-react/dist/esm/icons/graduation-cap.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { parseAppHash } from "../../utils/routing.js";
import { navigateFromGlobalCommand } from "../../utils/navigation.js";
import { TUTORIAL_DEFAULT_TITLE } from "./outline.js";
import { seedTutorial } from "./seed.js";
//#region src/plugins/onboarding/action.ts
var INSERT_TUTORIAL_ACTION_ID = "onboarding.insert_tutorial";
/**
* Seed the Tutorial subtree into `workspaceId`, unless it already carries
* a `Tutorial` page — re-seeding would mint a second page with the same
* alias and leave `[[Tutorial]]` lookups ambiguous. The `block_aliases`
* index is trigger-maintained (synchronous), so the guard sees a prior
* seed immediately. Returns the default Tutorial page id (the existing
* one when present) plus whether it was already there, so the caller can
* route to it either way.
*/
var insertTutorialIntoWorkspace = async (repo, workspaceId) => {
	const existing = await repo.query.aliasLookup({
		workspaceId,
		alias: TUTORIAL_DEFAULT_TITLE
	}).load();
	if (existing) return {
		tutorialId: existing.id,
		alreadyExisted: true
	};
	return {
		tutorialId: await seedTutorial(repo, workspaceId),
		alreadyExisted: false
	};
};
var insertTutorialAction = ({ repo }) => ({
	id: INSERT_TUTORIAL_ACTION_ID,
	description: "Insert tutorial",
	context: ActionContextTypes.GLOBAL,
	icon: GraduationCap,
	handler: async () => {
		const workspaceId = parseAppHash(window.location.hash).workspaceId ?? repo.activeWorkspaceId;
		if (!workspaceId) {
			showProgress("Insert tutorial").fail("Insert tutorial failed: no active workspace");
			return;
		}
		const banner = showProgress("Inserting tutorial…");
		try {
			const { tutorialId, alreadyExisted } = await insertTutorialIntoWorkspace(repo, workspaceId);
			banner.done(alreadyExisted ? "Tutorial already present — opening it" : "Tutorial inserted");
			await navigateFromGlobalCommand(repo, {
				blockId: tutorialId,
				workspaceId
			});
		} catch (err) {
			console.error("[onboarding] insert tutorial failed:", err);
			banner.fail(`Insert tutorial failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
});
//#endregion
export { INSERT_TUTORIAL_ACTION_ID, insertTutorialAction, insertTutorialIntoWorkspace };

//# sourceMappingURL=action.js.map