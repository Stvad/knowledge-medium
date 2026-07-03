import { editorSelection, focusBlock, isCollapsedProp, isEditingProp, peekFocusedBlockLocation, requestEditorFocus, selectionStateProp, setIsEditing, showPropertiesProp } from "../data/properties.js";
import { resetBlockSelection } from "../data/stateBlocks.js";
import { ArrowDown } from "../../node_modules/lucide-react/dist/esm/icons/arrow-down.js";
import { ArrowUp } from "../../node_modules/lucide-react/dist/esm/icons/arrow-up.js";
import { ChevronsDownUp } from "../../node_modules/lucide-react/dist/esm/icons/chevrons-down-up.js";
import { ClipboardCopy } from "../../node_modules/lucide-react/dist/esm/icons/clipboard-copy.js";
import { Copy } from "../../node_modules/lucide-react/dist/esm/icons/copy.js";
import { Link2 } from "../../node_modules/lucide-react/dist/esm/icons/link-2.js";
import { Link } from "../../node_modules/lucide-react/dist/esm/icons/link.js";
import { ListIndentDecrease } from "../../node_modules/lucide-react/dist/esm/icons/list-indent-decrease.js";
import { ListIndentIncrease } from "../../node_modules/lucide-react/dist/esm/icons/list-indent-increase.js";
import { SlidersHorizontal } from "../../node_modules/lucide-react/dist/esm/icons/sliders-horizontal.js";
import { TextAlignStart } from "../../node_modules/lucide-react/dist/esm/icons/text-align-start.js";
import { Trash2 } from "../../node_modules/lucide-react/dist/esm/icons/trash-2.js";
import { absoluteAppUrl, buildAppHash } from "../utils/routing.js";
import { blockAfterSubtreeRemoval, extendSelection, nextVisibleBlock, previousVisibleBlock } from "../utils/selection.js";
import { withMoveTransition } from "../utils/viewTransition.js";
import { structuralEditPolicyForBlock } from "../data/structuralEditPolicy.js";
import { copyBlockToClipboard } from "../utils/copy.js";
//#region src/shortcuts/blockActions.ts
var bindBlockActionContext = (context, action, { idPrefix } = {}) => ({
	...action,
	id: idPrefix ? `${idPrefix}.${action.id}` : action.id,
	context,
	handler: action.handler
});
/** Write to the system clipboard if the platform exposes the async API.
*  Used by the block-level "copy *" actions; safe to call in non-browser
*  contexts (jsdom, Node) — the no-clipboard branch silently no-ops so
*  unit tests can invoke handlers without setting up a clipboard mock. */
var writeToClipboard = (text) => {
	if (typeof navigator === "undefined" || !navigator.clipboard) return;
	navigator.clipboard.writeText(text);
};
/** Move `block` one step up (-1) or down (+1) in the visible outline,
*  crossing parent boundaries Roam/org-style and bounded by the
*  surface's scope root. Delegates the tree logic to the
*  `core.moveVertical` mutator (one transaction, undoable as a unit). */
var reorderBlock = async (repo, block, direction, scopeRootId) => {
	await repo.mutate.moveVertical({
		id: block.id,
		direction,
		scopeRootId
	});
};
var requestEditorFocusIfEditing = (uiStateBlock) => {
	if (uiStateBlock.peekProperty(isEditingProp)) requestEditorFocus(uiStateBlock);
};
var enterEditMode = (uiStateBlock, selection) => {
	if (uiStateBlock.repo.isReadOnly) return;
	resetBlockSelection(uiStateBlock);
	setIsEditing(uiStateBlock, true);
	if (selection) uiStateBlock.set(editorSelection, selection);
	requestEditorFocus(uiStateBlock);
};
/** Extend the block selection to the next visible block. Returns whether a
*  selection was actually extended — false at the last visible block in the
*  surface (no next block) or if the range resolved empty. Edit-mode callers
*  use this to avoid leaving edit mode for nothing, and pass `clearEditing` so
*  the exit folds into the selection's transaction (see extendSelectionDownEdit). */
/** True when a block selection is already active. The Roam-style first
*  Shift+Direction selects just the focused block; only once something is
*  selected do further presses extend to neighbours. */
var hasActiveSelection = (uiStateBlock) => (uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds.length ?? 0) > 0;
var extendSelectionDown = async (uiStateBlock, repo, scopeRootId, scopeRootForcesOpen = true, clearEditing = false) => {
	if (!scopeRootId) return false;
	const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId;
	if (!focusedId) return false;
	if (!hasActiveSelection(uiStateBlock)) {
		if (focusedId === scopeRootId) return false;
		return extendSelection(focusedId, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing);
	}
	const nextBlock = await nextVisibleBlock(repo.block(focusedId), scopeRootId, scopeRootForcesOpen);
	if (!nextBlock) return false;
	return extendSelection(nextBlock.id, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing);
};
/** Mirror of {@link extendSelectionDown} for the previous visible block.
*  Returns false at the first visible block in the surface (the focused block
*  is the scope root) or if the range resolved empty. */
var extendSelectionUp = async (uiStateBlock, repo, scopeRootId, scopeRootForcesOpen = true, clearEditing = false) => {
	if (!scopeRootId) return false;
	const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId;
	if (!focusedId) return false;
	if (!hasActiveSelection(uiStateBlock)) {
		if (focusedId === scopeRootId) return false;
		return extendSelection(focusedId, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing);
	}
	const prevBlock = await previousVisibleBlock(repo.block(focusedId), scopeRootId);
	if (!prevBlock) return false;
	return extendSelection(prevBlock.id, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing);
};
var createSharedBlockActions = ({ repo }) => {
	return {
		indentBlock: {
			id: "indent_block",
			description: "Indent block",
			icon: ListIndentIncrease,
			handler: async (deps) => {
				const { canIndent } = await structuralEditPolicyForBlock(deps.block, deps.scopeRootId);
				if (!canIndent) return;
				await repo.mutate.indent({ id: deps.block.id });
				requestEditorFocusIfEditing(deps.uiStateBlock);
			},
			defaultBinding: {
				keys: "Tab",
				eventOptions: { preventDefault: true }
			}
		},
		outdentBlock: {
			id: "outdent_block",
			description: "Outdent block",
			icon: ListIndentDecrease,
			handler: async ({ block, uiStateBlock, scopeRootId }) => {
				if (!scopeRootId) return;
				const { canOutdent } = await structuralEditPolicyForBlock(block, scopeRootId);
				if (!canOutdent) return;
				await repo.mutate.outdent({
					id: block.id,
					scopeRootId
				});
				requestEditorFocusIfEditing(uiStateBlock);
			},
			defaultBinding: {
				keys: "Shift+Tab",
				eventOptions: { preventDefault: true }
			}
		},
		moveBlockUp: {
			id: "move_block_up",
			description: "Move block up",
			icon: ArrowUp,
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block) return;
				await reorderBlock(repo, block, -1, scopeRootId);
				requestEditorFocusIfEditing(uiStateBlock);
			},
			defaultBinding: {
				keys: ["$mod+Shift+ArrowUp", "$mod+Shift+k"],
				eventOptions: { preventDefault: true }
			}
		},
		moveBlockDown: {
			id: "move_block_down",
			description: "Move block down",
			icon: ArrowDown,
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block) return;
				await reorderBlock(repo, block, 1, scopeRootId);
				requestEditorFocusIfEditing(uiStateBlock);
			},
			defaultBinding: {
				keys: ["$mod+Shift+ArrowDown", "$mod+Shift+j"],
				eventOptions: { preventDefault: true }
			}
		},
		deleteBlock: {
			id: "delete_block",
			description: "Delete block",
			icon: Trash2,
			handler: async (deps) => {
				const { block, uiStateBlock, scopeRootId } = deps;
				if (!block || !uiStateBlock) return;
				const next = scopeRootId ? await blockAfterSubtreeRemoval(block, scopeRootId) : null;
				await withMoveTransition(async () => {
					await block.delete();
				});
				if (next) focusBlock(uiStateBlock, next.id, { renderScopeId: deps.renderScopeId });
			},
			defaultBinding: { keys: "Delete" }
		},
		togglePropertiesDisplay: {
			id: "toggle_properties",
			description: "Toggle block properties",
			icon: SlidersHorizontal,
			handler: async (deps) => {
				const { block } = deps;
				if (!block) return;
				const showProperties = block.peekProperty(showPropertiesProp) ?? false;
				await block.set(showPropertiesProp, !showProperties);
			},
			defaultBinding: { keys: "t" }
		},
		toggleBlockCollapse: {
			id: "toggle_collapse",
			description: "Toggle block collapse",
			icon: ChevronsDownUp,
			handler: async (deps) => {
				const { block } = deps;
				if (!block) return;
				const isCollapsed = block.peekProperty(isCollapsedProp) ?? false;
				await withMoveTransition(async () => {
					await block.set(isCollapsedProp, !isCollapsed);
				});
			},
			defaultBinding: { keys: "z" }
		},
		extendSelectionUp: {
			id: "extend_selection_up",
			description: "Extend selection up",
			handler: async (deps) => {
				await extendSelectionUp(deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen);
			},
			defaultBinding: {
				keys: "Shift+ArrowUp",
				eventOptions: { preventDefault: true }
			}
		},
		extendSelectionDown: {
			id: "extend_selection_down",
			description: "Extend selection down",
			handler: async (deps) => {
				await extendSelectionDown(deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen);
			},
			defaultBinding: {
				keys: "Shift+ArrowDown",
				eventOptions: { preventDefault: true }
			}
		},
		copyBlock: {
			id: "copy_block",
			description: "Copy block to clipboard",
			icon: Copy,
			handler: ({ block }) => copyBlockToClipboard(block),
			defaultBinding: {
				keys: ["$mod+c", "y y"],
				eventOptions: { preventDefault: true }
			}
		},
		copyBlockRef: {
			id: "copy_block_ref",
			description: "Copy block reference",
			icon: Link2,
			handler: ({ block }) => {
				writeToClipboard(`((${block.id}))`);
			},
			defaultBinding: { keys: ["y r", "Alt+y"] }
		},
		copyBlockEmbed: {
			id: "copy_block_embed",
			description: "Copy block embed",
			icon: ClipboardCopy,
			handler: ({ block }) => {
				writeToClipboard(`!((${block.id}))`);
			},
			defaultBinding: { keys: ["y e", "Shift+y"] }
		},
		copyBlockContent: {
			id: "copy_block_content",
			description: "Copy block text only",
			icon: TextAlignStart,
			handler: async ({ block }) => {
				writeToClipboard((block.peek() ?? await block.load())?.content ?? "");
			},
			defaultBinding: { keys: "y c" }
		},
		copyBlockLink: {
			id: "copy_block_link",
			description: "Copy link to block",
			icon: Link,
			handler: ({ block }) => {
				const workspaceId = repo.activeWorkspaceId;
				if (!workspaceId) return;
				writeToClipboard(absoluteAppUrl(buildAppHash(workspaceId, block.id)));
			},
			defaultBinding: { keys: "y l" }
		}
	};
};
//#endregion
export { bindBlockActionContext, createSharedBlockActions, enterEditMode, extendSelectionDown, extendSelectionUp, requestEditorFocusIfEditing };

//# sourceMappingURL=blockActions.js.map