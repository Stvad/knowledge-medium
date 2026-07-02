import { recentsPageBlockId } from "../../data/recentsPage.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, blockRenderersFacet, headerItemsFacet } from "../../extensions/core.js";
import { Clock } from "../../../node_modules/lucide-react/dist/esm/icons/clock.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { navigateFromGlobalCommand } from "../../utils/navigation.js";
import { RecentsHeaderItem } from "./HeaderItem.js";
import { RecentsPageBlockRenderer } from "./RecentsPageBlockRenderer.js";
//#region src/plugins/recents/index.ts
var OPEN_RECENTS_ACTION_ID = "open_recents";
var openRecents = (repo) => {
	const workspaceId = repo.activeWorkspaceId;
	if (!workspaceId) return;
	navigateFromGlobalCommand(repo, { blockId: recentsPageBlockId(workspaceId) });
};
var openRecentsAction = (repo) => ({
	id: OPEN_RECENTS_ACTION_ID,
	description: "Open Recents — recently edited blocks",
	context: ActionContextTypes.GLOBAL,
	icon: Clock,
	handler: () => openRecents(repo)
});
var recentsHeaderItem = {
	id: "recents.header",
	region: "start",
	component: RecentsHeaderItem
};
var recentsPlugin = ({ repo }) => systemToggle({
	id: "system:recents",
	name: "Recents",
	description: "Tana-style view of recently-edited blocks in the workspace."
}).of([
	blockRenderersFacet.of({
		id: "recentsPage",
		renderer: RecentsPageBlockRenderer
	}, { source: "recents" }),
	headerItemsFacet.of(recentsHeaderItem, {
		source: "recents",
		precedence: 35
	}),
	actionsFacet.of(openRecentsAction(repo), { source: "recents" })
]);
//#endregion
export { OPEN_RECENTS_ACTION_ID, openRecentsAction, recentsHeaderItem, recentsPlugin };

//# sourceMappingURL=index.js.map