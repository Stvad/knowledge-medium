import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { activePanelIdProp, aliasesProp, editorSelection, isEditingProp } from "../../data/properties.js";
import { getLayoutSessionBlock } from "../../data/stateBlocks.js";
import { addDaysIso, getOrCreateDailyNote, todayIso } from "./dailyNotes.js";
import { CalendarDays } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-days.js";
import { CalendarPlus } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-plus.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { parseAppHash } from "../../utils/routing.js";
import { getLayoutSessionId } from "../../utils/layoutSessionId.js";
import { navigate, navigateFromGlobalCommand, resolveGlobalCommandTarget } from "../../utils/navigation.js";
//#region src/plugins/daily-notes/actions.ts
var OPEN_TODAY_ACTION_ID = "open_today";
var APPEND_TODAY_DAILY_BLOCK_ACTION_ID = "append_today_daily_block";
var OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID = "open_previous_daily_note";
var OPEN_NEXT_DAILY_NOTE_ACTION_ID = "open_next_daily_note";
var ISO_ALIAS_RE = /^\d{4}-\d{2}-\d{2}$/;
var dailyNoteIsoFromBlock = (block) => {
	return (block.peekProperty(aliasesProp) ?? []).find((alias) => ISO_ALIAS_RE.test(alias)) ?? null;
};
var findContainingDailyNoteIso = async (repo, blockId, workspaceId) => {
	const data = await repo.load(blockId, { ancestors: true });
	if (!data || data.workspaceId !== workspaceId) return null;
	let block = repo.block(blockId);
	while (block) {
		const iso = dailyNoteIsoFromBlock(block);
		if (iso) return iso;
		block = block.parent;
	}
	return null;
};
/** The panel a navigator command targets, as a daily-note anchor: the workspace
*  that panel lives in, plus the visible block's daily-note ISO (or null if it
*  isn't a daily note). Goes through the same policy + destination resolution as
*  the navigation, so the workspace and validation match where prev/next will
*  create + open — even under a policy that retargets the workspace. Returns
*  null only when no panel is open. */
var resolveDailyNoteAnchor = async (repo, workspaceId) => {
	const target = await resolveGlobalCommandTarget(repo, workspaceId);
	if (!target) return null;
	return {
		workspaceId: target.workspaceId,
		iso: await findContainingDailyNoteIso(repo, target.blockId, target.workspaceId)
	};
};
/** Resolve just the ISO date of the currently-visible daily note — for the date
*  picker, which only needs the month/day to open on. */
var resolveCurrentDailyNoteIso = async (repo, workspaceId) => (await resolveDailyNoteAnchor(repo, workspaceId))?.iso ?? null;
var openDailyNoteByOffset = async (repo, offsetDays) => {
	const fallbackWorkspaceId = parseAppHash(window.location.hash).workspaceId ?? repo.activeWorkspaceId;
	if (!fallbackWorkspaceId) return;
	const anchor = await resolveDailyNoteAnchor(repo, fallbackWorkspaceId);
	const workspaceId = anchor?.workspaceId ?? fallbackWorkspaceId;
	navigateFromGlobalCommand(repo, {
		blockId: (await getOrCreateDailyNote(repo, workspaceId, addDaysIso(anchor?.iso ?? todayIso(), offsetDays))).id,
		workspaceId
	});
};
/** Append a fresh block to today's daily note and open it in a new
*  sidebar-stacked panel ready for editing. Shared between the
*  `append_today_daily_block` keyboard action and the
*  `consumeAppIntent` PWA-shortcut / share-target dispatcher in
*  the app-intents plugin — both want the exact same UX (drop the
*  user into a fresh, focused, editable block on today's note);
*  `content` lets the share-target seed the block with the shared
*  title/text/URL. Cursor lands at end-of-content so the user can
*  keep typing.
*
*  Returns the new block id on success, or `null` when nothing was
*  done (no active workspace, or read-only mode). The PWA-intent
*  dispatcher inspects the return value before stripping the URL
*  params — that way a shared payload that hits a read-only repo
*  isn't silently lost (the params survive so a reload, after the
*  user exits read-only mode, retries the dispatch). */
var appendTodayDailyBlockInStack = async (repo, layoutSessionBlock, options = {}) => {
	const workspaceId = repo.activeWorkspaceId;
	if (!workspaceId || repo.isReadOnly) return null;
	const content = options.content;
	const blockId = await repo.undoGroup(async (grouped) => {
		const note = await getOrCreateDailyNote(grouped, workspaceId, todayIso());
		return grouped.mutate.createChild({
			parentId: note.id,
			content,
			position: { kind: "last" }
		});
	});
	await layoutSessionBlock.load();
	const dest = await navigate(repo, {
		target: "sidebar-stack",
		blockId,
		workspaceId,
		sourcePanelId: layoutSessionBlock.peekProperty(activePanelIdProp),
		origin: "daily-note"
	});
	if (dest && dest.blockId === blockId) {
		const selection = {
			blockId,
			start: content ? content.length : 0
		};
		await repo.tx(async (tx) => {
			await tx.setProperty(dest.panelId, editorSelection, selection);
			await tx.setProperty(dest.panelId, isEditingProp, true);
		}, {
			scope: ChangeScope.UiState,
			description: "edit new daily block"
		});
	}
	return blockId;
};
var dailyNotesActions = ({ repo }) => [
	{
		id: OPEN_TODAY_ACTION_ID,
		description: "Open today's daily note",
		context: ActionContextTypes.GLOBAL,
		icon: CalendarDays,
		handler: async () => {
			const workspaceId = repo.activeWorkspaceId;
			if (!workspaceId) return;
			navigateFromGlobalCommand(repo, {
				blockId: (await getOrCreateDailyNote(repo, workspaceId, todayIso())).id,
				workspaceId
			});
		},
		defaultBinding: { keys: "Control+Shift+Backquote" }
	},
	{
		id: APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
		description: "New daily block",
		context: ActionContextTypes.GLOBAL,
		icon: CalendarPlus,
		handler: async ({ uiStateBlock }) => {
			await appendTodayDailyBlockInStack(repo, await getLayoutSessionBlock(uiStateBlock, getLayoutSessionId()));
		},
		defaultBinding: {
			keys: "Control+Shift+n",
			eventOptions: { preventDefault: true }
		}
	},
	{
		id: OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
		description: "Open previous daily note",
		context: ActionContextTypes.GLOBAL,
		handler: async () => {
			await openDailyNoteByOffset(repo, -1);
		},
		defaultBinding: { keys: "Control+Shift+BracketLeft" }
	},
	{
		id: OPEN_NEXT_DAILY_NOTE_ACTION_ID,
		description: "Open next daily note",
		context: ActionContextTypes.GLOBAL,
		handler: async () => {
			await openDailyNoteByOffset(repo, 1);
		},
		defaultBinding: { keys: "Control+Shift+BracketRight" }
	}
];
//#endregion
export { APPEND_TODAY_DAILY_BLOCK_ACTION_ID, OPEN_NEXT_DAILY_NOTE_ACTION_ID, OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID, OPEN_TODAY_ACTION_ID, appendTodayDailyBlockInStack, dailyNotesActions, resolveCurrentDailyNoteIso };

//# sourceMappingURL=actions.js.map