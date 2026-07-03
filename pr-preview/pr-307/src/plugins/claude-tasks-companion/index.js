import { systemToggle } from "../../facets/togglable.js";
import { blockContentDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { claudeStatusChipContribution } from "./ClaudeStatusChip.js";
/** UI companion for the claude-tasks daemon (packages/claude-tasks):
*  surfaces the `claude:*` task lifecycle the daemon writes into the
*  graph. Pure reader — works on every device, daemon or not. */
var claudeTasksCompanionPlugin = systemToggle({
	id: "system:claude-tasks-companion",
	name: "Claude tasks companion",
	description: "Status chips for Claude task blocks: shows working/replied/failed on blocks the claude-tasks daemon processes."
}).of([blockContentDecoratorsFacet.of(claudeStatusChipContribution, { source: "claude-tasks-companion" })]);
//#endregion
export { claudeTasksCompanionPlugin };

//# sourceMappingURL=index.js.map