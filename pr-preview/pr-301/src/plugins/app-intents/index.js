import { systemToggle } from "../../facets/togglable.js";
import { appEffectsFacet } from "../../extensions/core.js";
import { getLayoutSessionBlock, getUIStateBlock } from "../../data/stateBlocks.js";
import { getLayoutSessionId } from "../../utils/layoutSessionId.js";
import { __resetAppIntentForTesting, consumeAppIntent, formatSharedContent } from "./appIntents.js";
//#region src/plugins/app-intents/index.ts
/**
* App-intents plugin — handles PWA-shortcut, Web Share Target, and
* `note_taking.new_note_url` boot-time dispatch.
*
* Public surface:
*   - `consumeAppIntent(repo, layoutSessionBlock)` — pure-function
*     entry point (used by `appIntentsBootstrapEffect` and tests).
*   - `formatSharedContent` — exported for tests and any future
*     plugin that wants to format Web Share API payloads the same
*     way.
*
* `appIntentsPlugin` (AppExtension) contributes one `AppEffect`:
*   - `appIntentsBootstrapEffect` — runs once per workspace mount.
*     It resolves the layout-session block from the repo's
*     UI-state, then hands off to `consumeAppIntent`. Effect-scoped
*     errors are caught by `AppRuntimeProvider`'s effect loop and
*     logged.
*/
var appIntentsBootstrapEffect = {
	id: "app-intents.bootstrap",
	start: async ({ repo, workspaceId }) => {
		await consumeAppIntent(repo, await getLayoutSessionBlock(await getUIStateBlock(repo, workspaceId, repo.user, {}), getLayoutSessionId()));
	}
};
var appIntentsPlugin = systemToggle({
	id: "system:app-intents",
	name: "App intents",
	description: "Bootstrap that dispatches PWA-shortcut / share-target / note-taker URL intents on app open.",
	essential: true
}).of([appEffectsFacet.of(appIntentsBootstrapEffect, { source: "app-intents" })]);
//#endregion
export { __resetAppIntentForTesting, appIntentsBootstrapEffect, appIntentsPlugin, consumeAppIntent, formatSharedContent };

//# sourceMappingURL=index.js.map