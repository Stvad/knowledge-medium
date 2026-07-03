import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { notifyBlockEditSettled } from "../../editor/editSettleSignal.js";
import { CLAUDE_PROPS } from "./chipState.js";
import { markAskedClaude } from "./askedStore.js";
//#region src/plugins/claude-tasks-companion/askClaude.ts
var ASK_CLAUDE_ACTION_ID = "claude-tasks.ask";
var EDIT_MODE_ASK_CLAUDE_ACTION_ID = "edit.cm.claude-tasks.ask";
/** The daemon's default backlink-watcher target. The mention is plain
*  content — the reference projection turns it into the backlink the
*  watcher sees. */
var CLAUDE_MENTION = "[[claude]]";
/** Re-queueing clears the terminal lifecycle props but KEEPS
*  claude:session — the retry resumes the thread — and claude:reply
*  markers on children are untouched. */
var REQUEUE_CLEARED_PROPS = [
	CLAUDE_PROPS.status,
	CLAUDE_PROPS.updatedAt,
	CLAUDE_PROPS.attempts,
	CLAUDE_PROPS.error,
	"claude:watcher"
];
var contentWithClaudeMention = (content) => {
	if (content.toLowerCase().includes(CLAUDE_MENTION)) return content;
	const trimmed = content.trimEnd();
	return trimmed ? `${trimmed} ${CLAUDE_MENTION}` : CLAUDE_MENTION;
};
var askClaude = async (block) => {
	if (block.repo.isReadOnly) return;
	if (!(block.peek() ?? await block.load())) return;
	await block.repo.tx(async (tx) => {
		const fresh = await tx.get(block.id);
		if (!fresh) return;
		const properties = {
			...fresh.properties,
			[CLAUDE_PROPS.askedAt]: Date.now()
		};
		const status = fresh.properties[CLAUDE_PROPS.status];
		if (status !== "queued" && status !== "running") for (const key of REQUEUE_CLEARED_PROPS) delete properties[key];
		await tx.update(block.id, {
			content: contentWithClaudeMention(fresh.content ?? ""),
			properties
		});
	}, {
		scope: ChangeScope.BlockDefault,
		description: "ask claude"
	});
	markAskedClaude(block.id);
	notifyBlockEditSettled(block.id);
};
var createAskClaudeAction = (context, id, description) => ({
	id,
	description,
	context,
	handler: (async ({ block }) => {
		await askClaude(block);
	})
});
var askClaudeActions = [createAskClaudeAction(ActionContextTypes.NORMAL_MODE, ASK_CLAUDE_ACTION_ID, "Ask Claude about this block"), createAskClaudeAction(ActionContextTypes.EDIT_MODE_CM, EDIT_MODE_ASK_CLAUDE_ACTION_ID, "Ask Claude about this block (Edit Mode)")];
//#endregion
export { ASK_CLAUDE_ACTION_ID, EDIT_MODE_ASK_CLAUDE_ACTION_ID, askClaude, askClaudeActions, contentWithClaudeMention };

//# sourceMappingURL=askClaude.js.map