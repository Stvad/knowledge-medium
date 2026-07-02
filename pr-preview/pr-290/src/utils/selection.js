import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
import { outlineRenderScopeId } from "./renderScope.js";
import { focusedBlockLocationProp, isCollapsedProp, isEditingProp, peekFocusedBlockLocation, sameFocusedBlockLocation, selectionStateProp } from "../data/properties.js";
//#region src/utils/selection.ts
/** True if `block` is collapsed *and* the caller cares. The scope root
*  is treated as always-expanded ONLY when its surface force-opens it
*  (`scopeRootForcesOpen`) — true for a focal panel/top-level root
*  (rendered `open` regardless of its own collapse flag), false for a
*  nested surface root (backlink/embed), which honours its collapse flag
*  in both render and navigation. Reads the property synchronously from
*  cache; assumes the row has been loaded. */
var isExpanded = (block, scopeRootId, scopeRootForcesOpen) => {
	if (block.id === scopeRootId && scopeRootForcesOpen) return true;
	return !(block.peekProperty(isCollapsedProp) ?? false);
};
/** Returns the next visible block in document order under
*  `scopeRootId` (the surface's visible-subtree root — the panel's zoom
*  root on the main outline, the shown block in a backlink entry, …),
*  walking *relatively* — descend into the first child if `current` is
*  expanded and has children, otherwise climb ancestors looking for a
*  next sibling. Stops at the scope boundary (`scopeRootId`); returns
*  null when `current` is the last visible block.
*
*  Touches O(depth) blocks (one SQL per parent's child list, all small
*  + handle-cached) instead of materializing the surface's full
*  visible-id list. Works correctly inside any surface with an arbitrary
*  scope root because no global "active panel" state is consulted. */
var nextVisibleBlock = async (current, scopeRootId, scopeRootForcesOpen = true) => {
	const repo = current.repo;
	await current.load();
	if (isExpanded(current, scopeRootId, scopeRootForcesOpen)) {
		const childIds = await current.childIds.load();
		if (childIds.length > 0) return repo.block(childIds[0]);
	}
	let walker = current;
	while (walker.id !== scopeRootId) {
		const data = walker.peek();
		if (!data || data.parentId === null) return null;
		const parentId = data.parentId;
		const parent = repo.block(parentId);
		await parent.load();
		const siblingIds = await parent.childIds.load();
		const idx = siblingIds.indexOf(walker.id);
		if (idx !== -1 && idx + 1 < siblingIds.length) return repo.block(siblingIds[idx + 1]);
		walker = parent;
	}
	return null;
};
/** Returns the previous visible block in document order under
*  `scopeRootId`. Mirror of `nextVisibleBlock`: if `current` has a
*  previous sibling, descend into that sibling's last visible
*  descendant; otherwise return the parent. Stops at `scopeRootId`
*  (returns null when `current` is the surface's scope root). */
var previousVisibleBlock = async (current, scopeRootId) => {
	if (current.id === scopeRootId) return null;
	const repo = current.repo;
	await current.load();
	const data = current.peek();
	if (!data || data.parentId === null) return null;
	const parentId = data.parentId;
	const parent = repo.block(parentId);
	await parent.load();
	const siblingIds = await parent.childIds.load();
	const idx = siblingIds.indexOf(current.id);
	if (idx > 0) return getLastVisibleDescendant(repo.block(siblingIds[idx - 1]));
	return parent;
};
/** Picks the block that should hold focus after `current` and its
*  entire subtree are removed. Uses the data tree (not the DOM):
*
*    1. Next data-sibling — the natural "shift-up" target. When a row
*       is removed from a list, the row that visually replaces its
*       position is the next sibling at the same depth.
*    2. Previous data-sibling — engaged when `current` was the last
*       sibling at its level.
*    3. Parent — engaged when `current` is the sole child. After
*       removal the parent is now empty, and it's the natural place
*       to land.
*
*  Returns null when `current` is the surface's `scopeRootId` (no
*  meaningful target, the surface is about to be empty), or when the
*  block is detached from the tree.
*
*  Mirrors `walker.findRecoveryAnchor`'s sibling-then-ancestor order
*  on the data side so the post-delete jump matches the proactive
*  recovery's choice for the disappear-from-DOM case. */
var blockAfterSubtreeRemoval = async (current, scopeRootId) => {
	if (current.id === scopeRootId) return null;
	const repo = current.repo;
	await current.load();
	const data = current.peek();
	if (!data || data.parentId === null) return null;
	const parent = repo.block(data.parentId);
	await parent.load();
	const siblingIds = await parent.childIds.load();
	const idx = siblingIds.indexOf(current.id);
	if (idx === -1) return parent;
	if (idx + 1 < siblingIds.length) return repo.block(siblingIds[idx + 1]);
	if (idx - 1 >= 0) return repo.block(siblingIds[idx - 1]);
	return parent;
};
/** Last visible descendant of `block` (deepest, last child of last
*  child, etc.). Used by keyboard navigation that needs to land on
*  the bottom of an expanded subtree. Returns the input block if it
*  is collapsed or has no children.
*
*  When `scopeRootId` is supplied, equals the block's id, AND the
*  surface force-opens it (`scopeRootForcesOpen`), its own
*  `isCollapsedProp` is ignored — matches `isExpanded`'s rule. Necessary
*  so vim `Shift+G` (jump to last visible block) still descends from a
*  focal panel root whose own flag carries a stale collapsed flag from
*  when it was viewed as a child. A nested scope root that honours its
*  collapse flag (`scopeRootForcesOpen === false`) terminates the
*  descent instead. Mid-walk collapsed blocks still terminate the
*  descent so `previousVisibleBlock`'s contract (don't dive into a
*  collapsed sibling) is preserved. */
var getLastVisibleDescendant = async (block, scopeRootId, scopeRootForcesOpen = true) => {
	const repo = block.repo;
	await block.load();
	let current = block;
	while (true) {
		const isScopeRoot = current.id === scopeRootId && scopeRootForcesOpen;
		if ((current.peekProperty(isCollapsedProp) ?? false) && !isScopeRoot) return current;
		const childIds = await current.childIds.load();
		if (childIds.length === 0) return current;
		current = repo.block(childIds[childIds.length - 1]);
		await current.load();
	}
};
/** Walks ancestors via cache snapshots and returns the topmost block
*  reachable. Used by some shortcut handlers that need to jump to
*  the workspace root. Cache-only; the caller is expected to have
*  hydrated the chain via `repo.load(id, {ancestors: true})` first. */
var getRootBlock = (block) => {
	const repo = block.repo;
	let current = block;
	const seen = /* @__PURE__ */ new Set();
	while (true) {
		if (seen.has(current.id)) return current;
		seen.add(current.id);
		const data = current.peek();
		if (!data?.parentId) return current;
		if (!repo.cache.getSnapshot(data.parentId)) return current;
		current = repo.block(data.parentId);
	}
};
/** Cache-only ancestor membership check. Walks parent chain via
*  cache snapshots; returns true iff `descendant` is reached from
*  `ancestor` going down (or, equivalently, if `ancestor` is in
*  `descendant`'s parent chain). */
var isDescendantOf = (descendant, ancestor) => {
	const repo = descendant.repo;
	let currentId = descendant.peek()?.parentId;
	const seen = new Set([descendant.id]);
	while (currentId) {
		if (seen.has(currentId)) return false;
		seen.add(currentId);
		if (currentId === ancestor.id) return true;
		currentId = repo.cache.getSnapshot(currentId)?.parentId;
	}
	return false;
};
/** Validates a set of block ids against hierarchical selection
*  rules:
*   - When a block is selected, none of its descendants may be selected
*   - When a block is selected, none of its ancestors may be selected
*  Processes ids in input order; the first id wins ties. */
async function validateSelectionHierarchy(selectedIds, repo) {
	await Promise.all(selectedIds.map((id) => repo.load(id, { ancestors: true })));
	const validatedIds = /* @__PURE__ */ new Set();
	for (const id of selectedIds) {
		const block = repo.block(id);
		let isValid = true;
		for (const validId of validatedIds) {
			const validBlock = repo.block(validId);
			if (isDescendantOf(block, validBlock)) {
				isValid = false;
				break;
			}
			if (isDescendantOf(validBlock, block)) validatedIds.delete(validId);
		}
		if (isValid) validatedIds.add(id);
	}
	return Array.from(validatedIds);
}
var uniqueBlockIds = (ids) => Array.from(new Set(ids));
var blockIdsInOrderedSelectionRange = (orderedLocations, anchorIndex, targetIndex) => {
	if (anchorIndex < 0 || targetIndex < 0 || anchorIndex >= orderedLocations.length || targetIndex >= orderedLocations.length) return [];
	const start = Math.min(anchorIndex, targetIndex);
	const end = Math.max(anchorIndex, targetIndex);
	return uniqueBlockIds(orderedLocations.slice(start, end + 1).map((location) => location.blockId));
};
var findBestSelectionAnchorIndex = (orderedLocations, options) => {
	const { anchorBlockId, targetIndex, selectedBlockIds = [], currentLocation } = options;
	if (targetIndex < 0 || targetIndex >= orderedLocations.length) return -1;
	const candidates = orderedLocations.map((location, index) => ({
		location,
		index
	})).filter(({ location }) => location.blockId === anchorBlockId);
	if (candidates.length === 0) return -1;
	if (candidates.length === 1) return candidates[0].index;
	const focusedCandidate = candidates.find(({ location }) => sameFocusedBlockLocation(location, currentLocation));
	if (focusedCandidate) return focusedCandidate.index;
	const selected = new Set(selectedBlockIds);
	return candidates.map(({ index }) => {
		const ids = blockIdsInOrderedSelectionRange(orderedLocations, index, targetIndex);
		const overlap = ids.filter((id) => selected.has(id)).length;
		const extra = ids.length - overlap;
		const missing = selectedBlockIds.filter((id) => !ids.includes(id)).length;
		return {
			index,
			score: overlap * 4 - extra - missing
		};
	}).sort((a, b) => b.score - a.score)[0]?.index ?? candidates[0].index;
};
async function commitSelectionRange(options) {
	const { uiStateBlock, anchorBlockId, targetLocation, selectedBlockIds, clearEditing = false, description = "extend selection" } = options;
	if (selectedBlockIds.length === 0) return false;
	const validatedIds = await validateSelectionHierarchy([...selectedBlockIds], uiStateBlock.repo);
	await uiStateBlock.repo.tx(async (tx) => {
		await tx.setProperty(uiStateBlock.id, selectionStateProp, {
			selectedBlockIds: validatedIds,
			anchorBlockId
		});
		await tx.setProperty(uiStateBlock.id, focusedBlockLocationProp, targetLocation);
		if (clearEditing) await tx.setProperty(uiStateBlock.id, isEditingProp, false);
	}, {
		scope: ChangeScope.UiState,
		description
	});
	return true;
}
/** Walk visible blocks from `startBlockId` toward `endBlockId` using
*  the relative-navigation primitives. Direction is auto-detected by
*  trying forward first, then backward — endpoints are interchangeable
*  per the original `getBlocksInRange` contract. Returns the inclusive
*  range of ids in document order, validated for hierarchy rules.
*
*  Falls back to whichever endpoint is reachable when the other one
*  isn't visible from the start (matches the legacy behavior of
*  `getBlocksInRange` when one endpoint was missing from the visible
*  list). */
async function getBlocksInRange(startBlockId, endBlockId, scopeRootId, repo, scopeRootForcesOpen = true) {
	if (startBlockId === endBlockId) return validateSelectionHierarchy([startBlockId], repo);
	const start = repo.block(startBlockId);
	const end = repo.block(endBlockId);
	const collectForward = async () => {
		const ids = [startBlockId];
		let walker = start;
		while (walker) {
			walker = await nextVisibleBlock(walker, scopeRootId, scopeRootForcesOpen);
			if (!walker) return null;
			ids.push(walker.id);
			if (walker.id === endBlockId) return ids;
		}
		return null;
	};
	const collectBackward = async () => {
		const ids = [startBlockId];
		let walker = start;
		while (walker) {
			walker = await previousVisibleBlock(walker, scopeRootId);
			if (!walker) return null;
			ids.unshift(walker.id);
			if (walker.id === endBlockId) return ids;
		}
		return null;
	};
	const range = await collectForward() ?? await collectBackward();
	if (range) return validateSelectionHierarchy(range, repo);
	console.warn("[getBlocksInRange] endpoints not connected via visible navigation.", {
		startBlockId,
		endBlockId,
		scopeRootId
	});
	const fallback = [];
	if (start.peek()) fallback.push(startBlockId);
	if (end.peek() && startBlockId !== endBlockId) fallback.push(endBlockId);
	return validateSelectionHierarchy(Array.from(new Set(fallback)), repo);
}
/** Extends selection to include blocks in range between current
*  anchor and target block. Reads selection state + focus from the
*  UI-state block (sync), computes the range against the visible
*  document order within the surface's scope root, then writes the
*  new selection state. */
async function extendSelection(targetBlockId, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen = true, clearEditing = false) {
	const currentState = uiStateBlock.peekProperty(selectionStateProp);
	const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId;
	if (!scopeRootId) return false;
	const currentAnchor = currentState?.anchorBlockId || focusedId;
	if (!currentAnchor) return false;
	const rangeIds = await getBlocksInRange(currentAnchor, targetBlockId, scopeRootId, repo, scopeRootForcesOpen);
	return commitSelectionRange({
		uiStateBlock,
		anchorBlockId: currentAnchor,
		targetLocation: {
			blockId: targetBlockId,
			renderScopeId: peekFocusedBlockLocation(uiStateBlock)?.renderScopeId ?? outlineRenderScopeId(scopeRootId)
		},
		selectedBlockIds: rangeIds,
		clearEditing
	});
}
//#endregion
export { blockAfterSubtreeRemoval, blockIdsInOrderedSelectionRange, commitSelectionRange, extendSelection, findBestSelectionAnchorIndex, getBlocksInRange, getLastVisibleDescendant, getRootBlock, nextVisibleBlock, previousVisibleBlock, validateSelectionHierarchy };

//# sourceMappingURL=selection.js.map