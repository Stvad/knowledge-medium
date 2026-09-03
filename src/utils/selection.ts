import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import {
  type FocusedBlockLocation,
  focusedBlockLocationProp,
  isEditingProp,
  isCollapsedProp,
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  selectionStateProp,
  uiStateRenderScopeId,
} from '@/data/properties'
import { ChangeScope } from '@/data/api'

/** True if `block` is collapsed *and* the caller cares. The scope root
 *  is treated as always-expanded ONLY when its surface force-opens it
 *  (`scopeRootForcesOpen`) — true for a focal panel/top-level root
 *  (rendered `open` regardless of its own collapse flag), false for a
 *  nested surface root (backlink/embed), which honours its collapse flag
 *  in both render and navigation. Reads the property synchronously from
 *  cache; assumes the row has been loaded. */
const isExpanded = (block: Block, scopeRootId: string, scopeRootForcesOpen: boolean): boolean => {
  if (block.id === scopeRootId && scopeRootForcesOpen) return true
  return !(block.peekProperty(isCollapsedProp) ?? false)
}

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
export const nextVisibleBlock = async (
  current: Block,
  scopeRootId: string,
  scopeRootForcesOpen = true,
): Promise<Block | null> => {
  const repo = current.repo
  await current.load()

  // Step into the first child if expanded.
  if (isExpanded(current, scopeRootId, scopeRootForcesOpen)) {
    const childIds = await current.childIds.load()
    if (childIds.length > 0) return repo.block(childIds[0])
  }

  // Climb ancestors looking for a next sibling. Stop at the scope root.
  let walker: Block = current
  while (walker.id !== scopeRootId) {
    const data = walker.peek()
    if (!data || data.parentId === null) return null
    const parentId = data.parentId
    const parent = repo.block(parentId)
    await parent.load()
    const siblingIds = await parent.childIds.load()
    const idx = siblingIds.indexOf(walker.id)
    if (idx !== -1 && idx + 1 < siblingIds.length) {
      return repo.block(siblingIds[idx + 1])
    }
    walker = parent
  }
  return null
}

/** Returns the previous visible block in document order under
 *  `scopeRootId`. Mirror of `nextVisibleBlock`: if `current` has a
 *  previous sibling, descend into that sibling's last visible
 *  descendant; otherwise return the parent. Stops at `scopeRootId`
 *  (returns null when `current` is the surface's scope root). */
export const previousVisibleBlock = async (
  current: Block,
  scopeRootId: string,
): Promise<Block | null> => {
  if (current.id === scopeRootId) return null
  const repo = current.repo
  await current.load()

  const data = current.peek()
  if (!data || data.parentId === null) return null
  const parentId = data.parentId

  const parent = repo.block(parentId)
  await parent.load()
  const siblingIds = await parent.childIds.load()
  const idx = siblingIds.indexOf(current.id)

  if (idx > 0) {
    // Descend into the previous sibling's last visible descendant.
    return getLastVisibleDescendant(repo.block(siblingIds[idx - 1]))
  }
  // No previous sibling — the parent is the previous visible block.
  // When current is a direct child of scopeRootId, parent === scopeRootId,
  // which is itself the first visible block in the surface.
  return parent
}

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
export const blockAfterSubtreeRemoval = async (
  current: Block,
  scopeRootId: string,
): Promise<Block | null> => {
  if (current.id === scopeRootId) return null
  const repo = current.repo
  await current.load()
  const data = current.peek()
  if (!data || data.parentId === null) return null

  const parent = repo.block(data.parentId)
  await parent.load()
  const siblingIds = await parent.childIds.load()
  const idx = siblingIds.indexOf(current.id)
  if (idx === -1) return parent

  if (idx + 1 < siblingIds.length) return repo.block(siblingIds[idx + 1])
  if (idx - 1 >= 0) return repo.block(siblingIds[idx - 1])
  return parent
}

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
export const getLastVisibleDescendant = async (
  block: Block,
  scopeRootId?: string,
  scopeRootForcesOpen = true,
): Promise<Block> => {
  const repo = block.repo
  await block.load()
  let current = block
  while (true) {
    const isScopeRoot = current.id === scopeRootId && scopeRootForcesOpen
    const collapsed = current.peekProperty(isCollapsedProp) ?? false
    if (collapsed && !isScopeRoot) return current
    const childIds = await current.childIds.load()
    if (childIds.length === 0) return current
    current = repo.block(childIds[childIds.length - 1])
    await current.load()
  }
}

/** Walks ancestors via cache snapshots and returns the topmost block
 *  reachable. Used by some shortcut handlers that need to jump to
 *  the workspace root. Cache-only; the caller is expected to have
 *  hydrated the chain via `repo.load(id, {ancestors: true})` first. */
export const getRootBlock = (block: Block): Block => {
  const repo = block.repo
  let current: Block = block
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current.id)) return current
    seen.add(current.id)
    const data = current.peek()
    if (!data?.parentId) return current
    const parentSnap = repo.cache.getSnapshot(data.parentId)
    if (!parentSnap) return current
    current = repo.block(data.parentId)
  }
}

interface AncestorChain {
  /** Ancestor ids, closest first. */
  ids: string[]
  /** False when the walk ran out of CACHED rows before reaching a root —
   *  i.e. `ids` is a prefix of the real chain and the caller must hydrate
   *  before trusting it. True when the walk ended for a reason hydrating
   *  can't change: a parentless root, a confirmed-missing/tombstoned row,
   *  or a cycle. */
  complete: boolean
}

/** Cache-only ancestor chain of `id`, closest first.
 *
 *  The walk is deliberately identical to the one the hierarchy rules need:
 *  the first hop reads `Block.peek()` (so a tombstone or confirmed-missing
 *  row yields an empty chain) and the rest read `repo.cache.getSnapshot`
 *  directly, with the same cycle guard — that guard is defence against
 *  corrupted data, not something well-formed input can hit. An id is
 *  recorded BEFORE its own snapshot is looked up, so a parent whose row
 *  isn't cached still counts as an ancestor. */
const ancestorChainFromCache = (repo: Repo, id: string): AncestorChain => {
  const ids: string[] = []
  const self = repo.block(id).peek()
  // undefined = row not loaded, so any chain we compute here is a guess.
  // null = the cache knows the row is missing or tombstoned; hydrating
  // can't produce a chain either (`repo.load` filters deleted rows), so
  // the empty chain is the final answer.
  if (self === undefined) return {ids, complete: false}

  const seen = new Set<string>([id])
  let currentId: string | null | undefined = self?.parentId
  while (currentId) {
    if (seen.has(currentId)) return {ids, complete: true}  // cycle guard
    seen.add(currentId)
    ids.push(currentId)
    const snapshot = repo.cache.getSnapshot(currentId)
    if (snapshot === undefined) return {ids, complete: false}
    currentId = snapshot.parentId
  }
  return {ids, complete: true}
}

/** Validates a set of block ids against hierarchical selection
 *  rules:
 *   - When a block is selected, none of its descendants may be selected
 *   - When a block is selected, none of its ancestors may be selected
 *  Processes ids in input order; the first id wins ties.
 *
 *  Hot path: `extendSelection` runs this over the WHOLE accumulated range
 *  on every Shift+Arrow — twice, since `getBlocksInRange` validates its
 *  result and `commitSelectionRange` validates what it's handed. Both the
 *  hydration and the comparison below are therefore written to cost
 *  nothing when the selection is already on screen:
 *
 *   - hydration is skipped for ids whose ancestor chain is already cached.
 *     Loading unconditionally cost 2 SQL round-trips per selected block per
 *     keystroke (~400 for a 100-block selection) and was the entire
 *     measured SQL cost of extending a selection. Trusting the cache here
 *     is not a new assumption — the rules themselves are decided purely
 *     from cache snapshots, and `Block.load()` short-circuits the same way
 *     for the same reason.
 *   - the ancestor rule is checked against a set of kept ids rather than by
 *     re-testing every kept id pairwise, turning O(selection²) chain walks
 *     into O(selection × depth). */
export async function validateSelectionHierarchy(
  selectedIds: string[],
  repo: Repo,
): Promise<string[]> {
  const uncached = uniqueBlockIds(selectedIds)
    .filter(id => !ancestorChainFromCache(repo, id).complete)
  if (uncached.length > 0) {
    await Promise.all(uncached.map(id => repo.load(id, {ancestors: true})))
  }

  const validated = new Set<string>()
  /** ancestor id → the kept ids sitting under it. The reverse rule ("drop
   *  kept blocks that are descendants of the incoming one") reads this
   *  instead of re-walking every kept id's chain. Entries are not pruned
   *  when an id is dropped: a stale entry only ever produces a no-op
   *  `validated.delete`. */
  const keptUnder = new Map<string, Set<string>>()

  for (const id of selectedIds) {
    if (validated.has(id)) continue  // duplicate id — re-adding is a no-op
    const {ids: ancestors} = ancestorChainFromCache(repo, id)

    // An ancestor is already selected — this block is covered by it.
    // (At most one kept ancestor can exist, and it excludes any kept
    // descendant, since the kept set never holds an ancestor/descendant
    // pair itself. So the two rules below are never both live for one id.)
    if (ancestors.some(ancestorId => validated.has(ancestorId))) continue

    for (const descendantId of keptUnder.get(id) ?? []) validated.delete(descendantId)
    validated.add(id)
    for (const ancestorId of ancestors) {
      const bucket = keptUnder.get(ancestorId)
      if (bucket) bucket.add(id)
      else keptUnder.set(ancestorId, new Set([id]))
    }
  }

  return Array.from(validated)
}

const uniqueBlockIds = (ids: readonly string[]): string[] =>
  Array.from(new Set(ids))

export const blockIdsInOrderedSelectionRange = (
  orderedLocations: readonly FocusedBlockLocation[],
  anchorIndex: number,
  targetIndex: number,
): string[] => {
  if (
    anchorIndex < 0 ||
    targetIndex < 0 ||
    anchorIndex >= orderedLocations.length ||
    targetIndex >= orderedLocations.length
  ) return []

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return uniqueBlockIds(
    orderedLocations.slice(start, end + 1).map(location => location.blockId),
  )
}

export const findBestSelectionAnchorIndex = (
  orderedLocations: readonly FocusedBlockLocation[],
  options: {
    anchorBlockId: string
    targetIndex: number
    selectedBlockIds?: readonly string[]
    currentLocation?: FocusedBlockLocation
  },
): number => {
  const {
    anchorBlockId,
    targetIndex,
    selectedBlockIds = [],
    currentLocation,
  } = options
  if (targetIndex < 0 || targetIndex >= orderedLocations.length) return -1

  const candidates = orderedLocations
    .map((location, index) => ({location, index}))
    .filter(({location}) => location.blockId === anchorBlockId)
  if (candidates.length === 0) return -1
  if (candidates.length === 1) return candidates[0].index

  const focusedCandidate = candidates.find(({location}) =>
    sameFocusedBlockLocation(location, currentLocation),
  )
  if (focusedCandidate) return focusedCandidate.index

  const selected = new Set(selectedBlockIds)
  const ranked = candidates
    .map(({index}) => {
      const ids = blockIdsInOrderedSelectionRange(orderedLocations, index, targetIndex)
      const overlap = ids.filter(id => selected.has(id)).length
      const extra = ids.length - overlap
      const missing = selectedBlockIds.filter(id => !ids.includes(id)).length
      return {
        index,
        score: overlap * 4 - extra - missing,
      }
    })
    .sort((a, b) => b.score - a.score)

  return ranked[0]?.index ?? candidates[0].index
}

export async function commitSelectionRange(
  options: {
    uiStateBlock: Block
    anchorBlockId: string
    targetLocation: FocusedBlockLocation
    selectedBlockIds: readonly string[]
    clearEditing?: boolean
    description?: string
  },
): Promise<boolean> {
  const {
    uiStateBlock,
    anchorBlockId,
    targetLocation,
    selectedBlockIds,
    clearEditing = false,
    description = 'extend selection',
  } = options
  if (selectedBlockIds.length === 0) return false

  const validatedIds = await validateSelectionHierarchy([...selectedBlockIds], uiStateBlock.repo)
  await uiStateBlock.repo.tx(async tx => {
    await tx.setProperty(uiStateBlock.id, selectionStateProp, {
      selectedBlockIds: validatedIds,
      anchorBlockId,
    })
    await tx.setProperty(uiStateBlock.id, focusedBlockLocationProp, targetLocation)
    if (clearEditing) {
      await tx.setProperty(uiStateBlock.id, isEditingProp, false)
    }
  }, {scope: ChangeScope.UiState, description})
  return true
}

/** Walk visible blocks from `startBlockId` toward `endBlockId` using
 *  the relative-navigation primitives. Direction is auto-detected by
 *  walking both ways in lockstep — endpoints are interchangeable
 *  per the original `getBlocksInRange` contract. Returns the inclusive
 *  range of ids in document order, validated for hierarchy rules.
 *
 *  Interleaved rather than forward-walk-first: a forward probe that runs to
 *  completion before trying backward costs O(document) whenever the target
 *  is ABOVE the start — which is every upward Shift+Arrow, on every
 *  keystroke, re-walking the entire page below the anchor to find a block
 *  one row above it. Interleaving bounds the walk at 2× the real distance.
 *  Document order is total, so `endBlockId` is reachable from `startBlockId`
 *  on exactly one side and interleaving can't make the answer ambiguous.
 *
 *  Falls back to whichever endpoint is reachable when the other one
 *  isn't visible from the start (matches the legacy behavior of
 *  `getBlocksInRange` when one endpoint was missing from the visible
 *  list). */
export async function getBlocksInRange(
  startBlockId: string,
  endBlockId: string,
  scopeRootId: string,
  repo: Repo,
  scopeRootForcesOpen = true,
): Promise<string[]> {
  if (startBlockId === endBlockId) {
    return validateSelectionHierarchy([startBlockId], repo)
  }

  const start = repo.block(startBlockId)
  const end = repo.block(endBlockId)

  // Forward ids in document order; backward ids in reverse document order
  // (reversed on the way out) — appending to both beats unshifting into one.
  const forwardIds: string[] = []
  const backwardIds: string[] = []
  let forwardWalker: Block | null = start
  let backwardWalker: Block | null = start

  while (forwardWalker || backwardWalker) {
    if (forwardWalker) {
      forwardWalker = await nextVisibleBlock(forwardWalker, scopeRootId, scopeRootForcesOpen)
      if (forwardWalker) {
        forwardIds.push(forwardWalker.id)
        if (forwardWalker.id === endBlockId) {
          return validateSelectionHierarchy([startBlockId, ...forwardIds], repo)
        }
      }
    }
    if (backwardWalker) {
      backwardWalker = await previousVisibleBlock(backwardWalker, scopeRootId)
      if (backwardWalker) {
        backwardIds.push(backwardWalker.id)
        if (backwardWalker.id === endBlockId) {
          return validateSelectionHierarchy([...backwardIds.reverse(), startBlockId], repo)
        }
      }
    }
  }

  // Either endpoint isn't reachable from the other within the current
  // scope; preserve the legacy fallback of returning whichever
  // endpoints we know exist.
  console.warn(
    '[getBlocksInRange] endpoints not connected via visible navigation.',
    {startBlockId, endBlockId, scopeRootId},
  )
  const fallback: string[] = []
  if (start.peek()) fallback.push(startBlockId)
  if (end.peek() && startBlockId !== endBlockId) fallback.push(endBlockId)
  return validateSelectionHierarchy(Array.from(new Set(fallback)), repo)
}

/** Extends selection to include blocks in range between current
 *  anchor and target block. Reads selection state + focus from the
 *  UI-state block (sync), computes the range against the visible
 *  document order within the surface's scope root, then writes the
 *  new selection state. */
export async function extendSelection(
  targetBlockId: string,
  uiStateBlock: Block,
  repo: Repo,
  scopeRootId: string | undefined,
  scopeRootForcesOpen = true,
  clearEditing = false,
): Promise<boolean> {
  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId

  if (!scopeRootId) return false

  const currentAnchor = currentState?.anchorBlockId || focusedId
  if (!currentAnchor) return false

  const rangeIds = await getBlocksInRange(currentAnchor, targetBlockId, scopeRootId, repo, scopeRootForcesOpen)

  const currentLocation = peekFocusedBlockLocation(uiStateBlock)
  // Returns false when the range resolved empty (commitSelectionRange writes
  // nothing). `clearEditing` folds the isEditing→false write into the same
  // transaction as the selection, so a caller leaving edit mode for block
  // selection never produces a render where the block is both editing and
  // selected.
  return commitSelectionRange({
    uiStateBlock,
    anchorBlockId: currentAnchor,
    targetLocation: {
      blockId: targetBlockId,
      renderScopeId: currentLocation?.renderScopeId ?? uiStateRenderScopeId(uiStateBlock, scopeRootId),
    },
    selectedBlockIds: rangeIds,
    clearEditing,
  })
}
