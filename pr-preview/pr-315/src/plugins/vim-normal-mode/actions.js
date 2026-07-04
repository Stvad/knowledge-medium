import { outlineRenderScopeId } from "../../utils/renderScope.js";
import { focusBlock, isCollapsedProp, selectionStateProp } from "../../data/properties.js";
import { actionsFacet } from "../../extensions/core.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { getLastVisibleDescendant, nextVisibleBlock, previousVisibleBlock } from "../../utils/selection.js";
import { pasteFromClipboard } from "../../paste/operations.js";
import { structuralEditPolicyForBlock } from "../../data/structuralEditPolicy.js";
import { bindBlockActionContext, createSharedBlockActions, enterEditMode } from "../../shortcuts/blockActions.js";
//#region src/plugins/vim-normal-mode/actions.ts
var JUMP_BLOCK_COUNT = 8;
/** Walk up to `count` visible blocks in `direction`, stopping early at the
*  scope boundary. Returns the landing block, or null when the start block is
*  already at the boundary (no movement). Exported for direct testing — the
*  jump_many_{up,down} actions are thin focus wrappers around it. */
var jumpVisibleBlocks = async (startBlock, scopeRootId, count, direction, scopeRootForcesOpen = true) => {
	let current = startBlock;
	let last = startBlock;
	for (let i = 0; i < count; i++) {
		const next = direction === "up" ? await previousVisibleBlock(current, scopeRootId) : await nextVisibleBlock(current, scopeRootId, scopeRootForcesOpen);
		if (!next) break;
		current = next;
		last = next;
	}
	return last === startBlock ? null : last;
};
function getVimNormalModeActions({ repo }) {
	const { indentBlock, outdentBlock, moveBlockUp, moveBlockDown, deleteBlock, togglePropertiesDisplay, toggleBlockCollapse, extendSelectionUp, extendSelectionDown } = createSharedBlockActions({ repo });
	const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock);
	const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock);
	const deleteBlockAction = {
		...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock),
		defaultBinding: { keys: [
			"Delete",
			"Backspace",
			"d d"
		] }
	};
	const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay);
	const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse);
	const extendSelectionUpAction = {
		...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUp),
		defaultBinding: {
			...extendSelectionUp.defaultBinding,
			keys: ["Shift+ArrowUp", "Shift+k"]
		}
	};
	const extendSelectionDownAction = {
		...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDown),
		defaultBinding: {
			...extendSelectionDown.defaultBinding,
			keys: ["Shift+ArrowDown", "Shift+j"]
		}
	};
	const bindNormal = (action) => bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action);
	return [
		indentBlockAction,
		outdentBlockAction,
		bindNormal({
			id: "move_down",
			description: "Move to next block",
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block || !uiStateBlock || !scopeRootId) return;
				const next = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen);
				if (next) focusBlock(uiStateBlock, next.id, { renderScopeId: deps.renderScopeId });
			},
			defaultBinding: { keys: ["ArrowDown", "j"] }
		}),
		bindNormal({
			id: "move_up",
			description: "Move to previous block",
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block || !uiStateBlock || !scopeRootId) return;
				const prev = await previousVisibleBlock(block, scopeRootId);
				if (prev) focusBlock(uiStateBlock, prev.id, { renderScopeId: deps.renderScopeId });
			},
			defaultBinding: { keys: ["ArrowUp", "k"] }
		}),
		bindNormal({
			id: "enter_edit_mode",
			description: "Enter edit mode",
			handler: async (deps) => enterEditMode(deps.uiStateBlock),
			defaultBinding: { keys: "i" }
		}),
		bindNormal({
			id: "enter_edit_mode_at_end",
			description: "Enter edit mode at end",
			handler: async ({ block, uiStateBlock }) => {
				await block.load();
				enterEditMode(uiStateBlock, {
					blockId: block.id,
					start: block.peek()?.content.length
				});
			},
			defaultBinding: { keys: "a" }
		}),
		toggleBlockCollapseAction,
		togglePropertiesDisplayAction,
		deleteBlockAction,
		bindNormal({
			id: "create_block_below_and_edit",
			description: "Create block below (or as child) and enter edit mode",
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block || !uiStateBlock || !scopeRootId) return;
				const { createBelowPlacement } = await structuralEditPolicyForBlock(block, scopeRootId);
				const newId = createBelowPlacement === "child-first" ? await repo.mutate.createChild({
					parentId: block.id,
					position: { kind: "first" },
					revealParent: true
				}) : await repo.mutate.createSiblingBelow({ siblingId: block.id });
				if (newId) await focusBlock(uiStateBlock, newId, {
					edit: true,
					renderScopeId: deps.renderScopeId
				});
			},
			defaultBinding: { keys: "o" }
		}),
		bindNormal({
			id: "select_focused_block_and_start_selection",
			description: "Select focused block and start selection",
			handler: async (deps) => {
				const { block, uiStateBlock } = deps;
				if (!block || !uiStateBlock) return;
				await uiStateBlock.set(selectionStateProp, {
					selectedBlockIds: [block.id],
					anchorBlockId: block.id
				});
			},
			defaultBinding: { keys: ["Space", "v"] }
		}),
		extendSelectionUpAction,
		extendSelectionDownAction,
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp, { idPrefix: "normal" }),
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown, { idPrefix: "normal" }),
		bindNormal({
			id: "jump_to_first_visible_block",
			description: "Jump to first visible block",
			handler: async ({ uiStateBlock, scopeRootId, renderScopeId }) => {
				if (!scopeRootId) return;
				focusBlock(uiStateBlock, scopeRootId, { renderScopeId: renderScopeId ?? outlineRenderScopeId(scopeRootId) });
			},
			defaultBinding: { keys: "g g" }
		}),
		bindNormal({
			id: "jump_to_last_visible_block",
			description: "Jump to last visible block",
			handler: async ({ uiStateBlock, scopeRootId, renderScopeId, scopeRootForcesOpen }) => {
				if (!scopeRootId) return;
				const lastBlock = await getLastVisibleDescendant(repo.block(scopeRootId), scopeRootId, scopeRootForcesOpen);
				if (!lastBlock) return;
				focusBlock(uiStateBlock, lastBlock.id, { renderScopeId: renderScopeId ?? outlineRenderScopeId(scopeRootId) });
			},
			defaultBinding: { keys: "Shift+g" }
		}),
		bindNormal({
			id: "jump_many_down",
			description: "Jump down several blocks",
			handler: async ({ block, uiStateBlock, renderScopeId, scopeRootId, scopeRootForcesOpen }) => {
				if (!scopeRootId) return;
				const target = await jumpVisibleBlocks(block, scopeRootId, JUMP_BLOCK_COUNT, "down", scopeRootForcesOpen);
				if (target) focusBlock(uiStateBlock, target.id, { renderScopeId });
			},
			defaultBinding: { keys: "Control+d" }
		}),
		bindNormal({
			id: "jump_many_up",
			description: "Jump up several blocks",
			handler: async ({ block, uiStateBlock, renderScopeId, scopeRootId, scopeRootForcesOpen }) => {
				if (!scopeRootId) return;
				const target = await jumpVisibleBlocks(block, scopeRootId, JUMP_BLOCK_COUNT, "up", scopeRootForcesOpen);
				if (target) focusBlock(uiStateBlock, target.id, { renderScopeId });
			},
			defaultBinding: { keys: "Control+u" }
		}),
		bindNormal({
			id: "create_block_above_and_edit",
			description: "Create block above (or as child) and enter edit mode",
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block || !uiStateBlock) return;
				const { createAbovePlacement } = await structuralEditPolicyForBlock(block, scopeRootId);
				const newId = createAbovePlacement === "child-first" ? await repo.mutate.createChild({
					parentId: block.id,
					position: { kind: "first" },
					revealParent: true
				}) : await repo.mutate.createSiblingAbove({ siblingId: block.id });
				if (!newId) return;
				await focusBlock(uiStateBlock, newId, {
					edit: true,
					renderScopeId: deps.renderScopeId
				});
			},
			defaultBinding: { keys: "Shift+o" }
		}),
		bindNormal({
			id: "paste_after",
			description: "Paste from clipboard after current block",
			handler: async ({ block, uiStateBlock, renderScopeId, scopeRootId }) => {
				const pasted = await pasteFromClipboard(block, repo, {
					position: "after",
					scopeRootId
				});
				if (pasted[0]) focusBlock(uiStateBlock, pasted[0].id, { renderScopeId });
			},
			defaultBinding: { keys: "p" }
		}),
		bindNormal({
			id: "paste_before",
			description: "Paste from clipboard before current block",
			handler: async ({ block, uiStateBlock, renderScopeId, scopeRootId }) => {
				const pasted = await pasteFromClipboard(block, repo, {
					position: "before",
					scopeRootId
				});
				if (pasted[0]) focusBlock(uiStateBlock, pasted[0].id, { renderScopeId });
			},
			defaultBinding: { keys: "Shift+p" }
		}),
		bindNormal({
			id: "undo",
			description: "Undo",
			handler: async () => {
				await repo.undo();
			},
			defaultBinding: { keys: "u" }
		}),
		bindNormal({
			id: "redo",
			description: "Redo",
			handler: async () => {
				await repo.redo();
			},
			defaultBinding: { keys: "Control+r" }
		}),
		bindNormal({
			id: "collapse_into_parent",
			description: "Collapse current block into its parent and focus parent",
			handler: async ({ block, uiStateBlock, renderScopeId, scopeRootId }) => {
				if (!scopeRootId || block.id === scopeRootId) return;
				await repo.load(block.id, { ancestors: true });
				const parent = block.parent;
				if (!parent || parent.id === scopeRootId) return;
				await parent.set(isCollapsedProp, true);
				focusBlock(uiStateBlock, parent.id, { renderScopeId });
			},
			defaultBinding: { keys: "Shift+z" }
		})
	];
}
var vimNormalModeActionsExtension = ({ repo }) => getVimNormalModeActions({ repo }).map((action) => actionsFacet.of(action, { source: "vim-normal-mode" }));
//#endregion
export { getVimNormalModeActions, jumpVisibleBlocks, vimNormalModeActionsExtension };

//# sourceMappingURL=actions.js.map