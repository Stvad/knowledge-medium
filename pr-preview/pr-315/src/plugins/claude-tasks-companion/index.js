import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { blockContentDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { claudeStatusChipContribution } from "./ClaudeStatusChip.js";
import { askClaudeActions } from "./askClaude.js";
//#region src/plugins/claude-tasks-companion/index.ts
var SOURCE = "claude-tasks-companion";
/** UI companion for the claude-tasks daemon (packages/claude-tasks):
*  surfaces the `claude:*` task lifecycle the daemon writes into the
*  graph (status chips) and offers the explicit Ask Claude trigger.
*  The chips are pure readers — they work on every device, daemon or
*  not; the action degrades to a plain [[claude]] mention when no
*  daemon is listening. */
var claudeTasksCompanionPlugin = systemToggle({
	id: "system:claude-tasks-companion",
	name: "Claude tasks companion",
	description: "Status chips + Ask Claude action for blocks the claude-tasks daemon processes."
}).of([blockContentDecoratorsFacet.of(claudeStatusChipContribution, { source: SOURCE }), ...askClaudeActions.map((action) => actionsFacet.of(action, { source: SOURCE }))]);
//#endregion
export { claudeTasksCompanionPlugin };

//# sourceMappingURL=index.js.map