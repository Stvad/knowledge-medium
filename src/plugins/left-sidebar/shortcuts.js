import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import memoize from "../../../node_modules/lodash-es/memoize.js";
import v5 from "../../../node_modules/uuid/dist/v5.js";
import { keyAtEnd } from "../../data/orderKey.js";
import { createOrRestoreTargetBlock } from "../../data/targets.js";
import { getOrCreateJournalBlock } from "../daily-notes/dailyNotes.js";
import "../daily-notes/index.js";
//#region src/plugins/left-sidebar/shortcuts.ts
var SHORTCUTS_BLOCK_CONTENT = "Shortcuts";
var JOURNAL_SHORTCUT_CONTENT = "[[Journal]]";
var JOURNAL_SHORTCUT_ALIAS = "Journal";
var SHORTCUTS_NS = "c1d7a2e3-4b6f-4a8e-9c5d-2f3b6e8a1c47";
var JOURNAL_SHORTCUT_NS = "b2a4f7c9-3d5e-4f1b-8a2c-9e7b6d4f3a51";
var shortcutsBlockId = (userBlockId) => v5(userBlockId, SHORTCUTS_NS);
var journalShortcutBlockId = (shortcutsId) => v5(shortcutsId, JOURNAL_SHORTCUT_NS);
var getOrCreateShortcutsBlock = memoize(async (userBlock) => {
	const repo = userBlock.repo;
	const userData = userBlock.peek() ?? await userBlock.load();
	if (!userData) throw new Error(`Shortcuts parent ${userBlock.id} is missing`);
	const shortcutsId = shortcutsBlockId(userBlock.id);
	if (await repo.load(shortcutsId)) return repo.block(shortcutsId);
	const journal = await getOrCreateJournalBlock(repo, userData.workspaceId);
	await repo.tx(async (tx) => {
		const parent = await tx.get(userBlock.id);
		if (!parent || parent.deleted) throw new Error(`Shortcuts parent ${userBlock.id} is missing`);
		const siblings = await tx.childrenOf(userBlock.id, parent.workspaceId);
		if (!(await createOrRestoreTargetBlock(tx, {
			id: shortcutsId,
			workspaceId: parent.workspaceId,
			parentId: userBlock.id,
			orderKey: keyAtEnd(siblings.at(-1)?.orderKey ?? null),
			freshContent: SHORTCUTS_BLOCK_CONTENT,
			systemMint: true
		})).inserted) return;
		await createOrRestoreTargetBlock(tx, {
			id: journalShortcutBlockId(shortcutsId),
			workspaceId: parent.workspaceId,
			parentId: shortcutsId,
			orderKey: keyAtEnd(),
			freshContent: JOURNAL_SHORTCUT_CONTENT,
			systemMint: true,
			onInsertedOrRestored: async (tx, id) => {
				await tx.update(id, { references: [{
					id: journal.id,
					alias: JOURNAL_SHORTCUT_ALIAS
				}] });
			}
		});
	}, {
		scope: ChangeScope.UserPrefs,
		description: "ensure shortcuts block"
	});
	return repo.block(shortcutsId);
}, (userBlock) => `${userBlock.repo.instanceId}:${userBlock.id}`);
//#endregion
export { getOrCreateShortcutsBlock, journalShortcutBlockId, shortcutsBlockId };

//# sourceMappingURL=shortcuts.js.map