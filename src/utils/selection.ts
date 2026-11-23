import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import {
  type FocusedBlockLocation,
  focusedBlockLocationProp,
  isEditingProp,
  sameFocusedBlockLocation,
  peekFocusedBlockLocation,
  selectionStateProp,
  uiStateRenderScopeId,
} from '@/data/properties'
import { ChangeScope, type BlockData } from '@/data/api'
import { flushPendingEditorContent } from '@/data/pendingEditorContent'
import { siblingPrecedes } from '@/data/orderKey'
import type { OutlineSurface } from '@/data/outlineSurface'

export * from './drawnWalk'
import { nextDrawnStep, previousDrawnStep, selectionBoundaryOf } from './drawnWalk'

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

/** Cache-only ancestor membership check. Walks parent chain via
 *  cache snapshots; returns true iff `descendant` is reached from
 *  `ancestor` going down (or, equivalently, if `ancestor` is in
 *  `descendant`'s parent chain). */
const isDescendantOf = (descendant: Block, ancestor: Block): boolean => {
  const repo = descendant.repo
  let currentId: string | null | undefined = descendant.peek()?.parentId
  const seen = new Set<string>([descendant.id])
  while (currentId) {
    if (seen.has(currentId)) return false  // cycle guard
    seen.add(currentId)
    if (currentId === ancestor.id) return true
    currentId = repo.cache.getSnapshot(currentId)?.parentId
  }
  return false
}

/** `id`'s chain from its root down to itself, read from the cache (load its
 *  ancestors first), or null when part of it isn't loaded or it cycles. */
const pathFromRoot = (repo: Repo, id: string): BlockData[] | null => {
  const path: BlockData[] = []
  const seen = new Set<string>()
  let current = repo.cache.getSnapshot(id)
  while (current) {
    // Defence in depth: a parent cycle (corrupt rows) would loop forever.
    if (seen.has(current.id)) return null
    seen.add(current.id)
    path.unshift(current)
    if (!current.parentId) return path
    current = repo.cache.getSnapshot(current.parentId)
  }
  return null
}

/** Whether `a` renders before `b` in their tree: an ancestor before its
 *  descendants, siblings as every children query sorts them (order key,
 *  then id). Blocks in different trees have no order. */
const precedesInTree = (a: readonly BlockData[], b: readonly BlockData[]): boolean => {
  if (a[0].id !== b[0].id) return false
  for (let depth = 1; depth < Math.min(a.length, b.length); depth++) {
    const [x, y] = [a[depth], b[depth]]
    if (x.id === y.id) continue
    return siblingPrecedes(x, y)
  }
  return a.length < b.length
}

/** `ids` with `id` inserted before the first of them it renders before,
 *  else appended — so a selection kept in document order stays in it. The
 *  multi-select actions apply in selection order and rely on that. Loads
 *  the ancestors the comparison reads. */
export async function insertInDocumentOrder(
  ids: readonly string[],
  id: string,
  repo: Repo,
): Promise<string[]> {
  await Promise.all([id, ...ids].map(each => repo.load(each, {ancestors: true})))
  const path = pathFromRoot(repo, id)
  const index = path
    ? ids.findIndex(other => {
      const otherPath = pathFromRoot(repo, other)
      return otherPath !== null && precedesInTree(path, otherPath)
    })
    : -1
  return index === -1 ? [...ids, id] : [...ids.slice(0, index), id, ...ids.slice(index)]
}

/** Validates a set of block ids against hierarchical selection
 *  rules:
 *   - When a block is selected, none of its descendants may be selected
 *   - When a block is selected, none of its ancestors may be selected
 *  Processes ids in input order; the first id wins ties. */
export async function validateSelectionHierarchy(
  selectedIds: string[],
  repo: Repo,
): Promise<string[]> {
  // Hydrate ancestor chains for all selected ids — cheap if cached.
  await Promise.all(selectedIds.map(id => repo.load(id, {ancestors: true})))

  const validatedIds = new Set<string>()
  for (const id of selectedIds) {
    const block = repo.block(id)
    let isValid = true

    for (const validId of validatedIds) {
      const validBlock = repo.block(validId)
      if (isDescendantOf(block, validBlock)) {
        isValid = false
        break
      }
      if (isDescendantOf(validBlock, block)) {
        validatedIds.delete(validId)
      }
    }

    if (isValid) validatedIds.add(id)
  }

  return Array.from(validatedIds)
}

const uniqueBlockIds = (ids: readonly string[]): string[] =>
  Array.from(new Set(ids))

/** One row of a range, in document order. A range is a set of blocks, so a row
 *  whose scope isn't known (a deferred row whose surface doesn't name it) still
 *  belongs; only the anchor search reads the scope, to tell copies of one
 *  block apart. */
export interface SelectionRangeRow {
  blockId: string
  renderScopeId?: string
}

export const blockIdsInOrderedSelectionRange = (
  orderedLocations: readonly SelectionRangeRow[],
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
  orderedLocations: readonly SelectionRangeRow[],
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

  const focusedCandidate = currentLocation?.blockId === anchorBlockId
    ? candidates.find(({location}) => location.renderScopeId === currentLocation.renderScopeId)
    : undefined
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
  flushPendingEditorContent()
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

/** Inclusive drawn range in document order. An unreachable anchor or a
 *  foreign-result boundary leaves the current selection alone. */
export async function getBlocksInRange(
  startBlockId: string,
  endBlockId: string,
  surface: OutlineSurface,
  repo: Repo,
  endScopeId?: string,
): Promise<string[]> {
  const start = repo.block(startBlockId)
  const boundary = await selectionBoundaryOf(start, surface.renderScopeId)
  const collect = async (step: typeof previousDrawnStep): Promise<string[] | null> => {
    const ids: string[] = []
    let cursor = {block: start, surface}
    for (;;) {
      ids.push(cursor.block.id)
      if (cursor.block.id === endBlockId && (endScopeId === undefined || cursor.surface.renderScopeId === endScopeId)) return ids
      const next = await step(cursor.block, cursor.surface)
      if (!next.block) return null
      const there = await selectionBoundaryOf(next.block, next.surface.renderScopeId)
      if (boundary !== there && !sameFocusedBlockLocation(boundary ?? undefined, there ?? undefined)) return null
      cursor = {block: next.block, surface: next.surface}
    }
  }
  const forward = await collect(nextDrawnStep)
  const range = forward ?? (await collect(previousDrawnStep))?.reverse() ?? []
  return validateSelectionHierarchy(range, repo)
}

/** Extends selection to include blocks in range between current
 *  anchor and target block. Reads selection state + focus from the
 *  UI-state block (sync), computes the range against the visible
 *  document order on `surface` (none: nothing to extend over), then writes
 *  the new selection state. With no active selection the range starts at
 *  `originBlockId` when given, else at the focused block. */
export async function extendSelection(
  targetBlockId: string,
  uiStateBlock: Block,
  repo: Repo,
  surface: OutlineSurface | null,
  {
    clearEditing = false,
    originBlockId, originRenderScopeId,
  }: {
    clearEditing?: boolean
    originBlockId?: string
    originRenderScopeId?: string
  } = {},
): Promise<boolean> {
  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId

  if (!surface) return false

  const currentAnchor = currentState?.anchorBlockId || originBlockId || focusedId
  if (!currentAnchor) return false

  const currentLocation = peekFocusedBlockLocation(uiStateBlock)
  const anchorScope = currentAnchor === originBlockId ? originRenderScopeId
    : currentAnchor === currentLocation?.blockId ? currentLocation.renderScopeId : undefined
  const targetScope = surface.renderScopeId ?? currentLocation?.renderScopeId ?? uiStateRenderScopeId(uiStateBlock, surface.scopeRootId)
  const rangeIds = await getBlocksInRange(targetBlockId, currentAnchor, {...surface, renderScopeId: targetScope}, repo, anchorScope)
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
      renderScopeId: targetScope,
    },
    selectedBlockIds: rangeIds,
    clearEditing,
  })
}
