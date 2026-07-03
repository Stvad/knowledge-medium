import { getOrCreateDailyNote, todayIso } from "../daily-notes/dailyNotes.js";
import { seedTutorial } from "./seed.js";
//#region src/plugins/onboarding/landing.ts
var onboardingLanding = async ({ repo, workspaceId, freshlyCreated }) => {
	if (!freshlyCreated) return null;
	await seedTutorial(repo, workspaceId);
	const dailyNote = await getOrCreateDailyNote(repo, workspaceId, todayIso());
	await repo.mutate.createChild({
		parentId: dailyNote.id,
		content: "[[Tutorial]]",
		position: { kind: "first" }
	});
	return null;
};
//#endregion
export { onboardingLanding };

//# sourceMappingURL=landing.js.map