import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, workspaceLandingFacet } from "../../extensions/core.js";
import { EXTENSIONS_PAGE_TITLE, TUTORIAL_DEFAULT_TITLE, TUTORIAL_VIM_TITLE } from "./outline.js";
import { seedTutorial } from "./seed.js";
import { onboardingLanding } from "./landing.js";
import { insertTutorialAction } from "./action.js";
//#region src/plugins/onboarding/index.ts
/**
* Onboarding plugin — seeds the starter Tutorial into a brand-new
* workspace. Formerly kernel code (`src/initData.ts` + `src/tutorial/`)
* called directly from `workspaceBootstrap`; now a normal, toggleable
* plugin that contributes a `workspaceLandingFacet` resolver (see
* `landing.ts`). Being a plugin lets it depend on other plugins
* (daily-notes) and keeps first-run content out of the kernel.
*/
var onboardingPlugin = ({ repo }) => systemToggle({
	id: "system:onboarding",
	name: "Onboarding",
	description: "Seeds the starter Tutorial pages and a [[Tutorial]] bullet into a brand-new workspace, and adds an \"Insert tutorial\" command for any workspace."
}).of([workspaceLandingFacet.of(onboardingLanding, {
	source: "onboarding",
	precedence: 10
}), actionsFacet.of(insertTutorialAction({ repo }), { source: "onboarding" })]);
//#endregion
export { EXTENSIONS_PAGE_TITLE, TUTORIAL_DEFAULT_TITLE, TUTORIAL_VIM_TITLE, onboardingPlugin, seedTutorial };

//# sourceMappingURL=index.js.map