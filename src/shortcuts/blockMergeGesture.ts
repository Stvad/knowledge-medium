import { ChangeScope, type Tx } from '@/data/api'
import type { Block } from '@/data/block'
import { holdsSource } from '@/data/blockTypes'
import { captureOccurrenceEdge, deleteBlock, liveChildAt, merge } from '@/data/mutators'
import { focusBlock } from '@/data/properties'
import { flushPendingEditorContent } from '@/data/pendingEditorContent'
import type { ListingSurface } from '@/data/childrenView'
import { refusesMerge, type DrawnMergeAnchor } from '@/data/structuralEditPolicy'
import { drawnChildrenOf } from '@/data/visibleChildren'
import { nestedWriteLocation } from '@/utils/drawnWalk'
import { ensureDeletableThroughUi } from '@/utils/deleteBlockThroughUi'

/** The Roam rule both merge gestures refuse on: `into` and `from` each show
 *  children of their own on the surface, so folding one into the other would
 *  reconcile two child lists the user did not ask to combine. When `from` is
 *  `into`'s only child there is no independent list: `from`'s children take
 *  its slot. Counted on the drawn lists — a property row the surface shows is
 *  a child the user sees move. */
export const bothShowIndependentChildren = async (
  {into, from}: {into: Block; from: Block},
  surface: ListingSurface,
): Promise<boolean> => {
  const fromChildren = await drawnChildrenOf(from, surface)
  if (fromChildren.length === 0) return false
  const intoChildren = await drawnChildrenOf(into, surface)
  return intoChildren.some(child => child !== from.id)
}

export interface MergeUpGesture {
  /** The block Backspace consumes. */
  from: Block
  /** The block drawn before it, which takes its text. */
  into: Block
  /** The editor's live text of `from`: the stored content may lag its debounce. */
  liveContent: string
  /** Where both are drawn; its render scope is where `into` takes focus. */
  surface: ListingSurface
  uiStateBlock: Block
  /** For a member, its preceding sibling and their common data parent. */
  anchor?: DrawnMergeAnchor
  /** Runs once the merge is not refused, before it writes (the key's preventDefault). */
  onTaken?: () => void
  isCurrent?: () => boolean
}

/** Both endpoints must still occupy the captured parent edges when the editor's write commits. */
export async function mergeCheck(from: Block, into: Block, surface: ListingSurface, anchor?: MergeUpGesture['anchor']) {
  const [source, destination] = await Promise.all([from.load(), into.load()])
  const drawn = await nestedWriteLocation(from, surface.renderScopeId)
  if (!source || !destination || drawn === null || await refusesMerge(from, surface, drawn)) return null
  const roots = {boundaryId: anchor?.parentId ?? drawn?.boundaryId, foreignRootId: drawn?.foreignRootId}
  const fromEdge = captureOccurrenceEdge(from.id, anchor?.parentId ?? source.parentId, roots)
  const intoEdge = captureOccurrenceEdge(into.id, destination.parentId, roots)
  return async (tx: Tx) => {
    if (!await fromEdge.currentRow(tx)) return false
    if (!await intoEdge.currentRow(tx)) return false
    if (!anchor) return source.parentId === null || tx.isDescendantOf(into.id, source.parentId)
    return !!await liveChildAt(tx, anchor.siblingId, anchor.parentId) && await tx.isDescendantOf(into.id, anchor.siblingId)
  }
}

/** Backspace at the start of `from`: its text joins `into`'s, its children
 *  follow, and `into` is edited at the join. Refused where either block holds
 *  source (the text would join code), where both show children of their own,
 *  and where deleting `from` would be (a merge destroys it). Returns whether
 *  it merged. */
export const mergeUp = async (
  {from, into, liveContent, surface, uiStateBlock, onTaken, anchor, isCurrent}: MergeUpGesture,
): Promise<boolean> => {
  const current = await mergeCheck(from, into, surface, anchor)
  if (!current) return false
  const deleteLeaf = anchor && liveContent === '' &&
    (await from.repo.query.childIds({id: from.id, propertyChildren: 'all'}).load()).length === 0
  if (!deleteLeaf && (anchor?.deleteOnly || holdsSource(from) || holdsSource(into) || await bothShowIndependentChildren({into, from}, surface))) return false
  onTaken?.()
  const joinOffset = into.peek()?.content.length ?? 0
  if (!await ensureDeletableThroughUi([from])) return false
  // The editor's pending text is saved as its own undo step first, so undoing
  // the merge restores `from` with what was typed.
  flushPendingEditorContent()
  // One transaction: the live text first, so the merge concatenates it.
  const merged = await from.repo.tx(async tx => {
    if (!await current(tx)) return false
    if (deleteLeaf && await tx.hasChildren(from.id)) return false
    if (isCurrent?.() === false) return false
    if (deleteLeaf) {
      await tx.run(deleteBlock, {id: from.id})
      return true
    }
    await tx.update(from.id, {content: liveContent})
    await tx.run(merge, {intoId: into.id, fromId: from.id})
    return true
  }, {scope: ChangeScope.BlockDefault, description: 'merge into previous block'})
  if (!merged) return false
  await focusBlock(uiStateBlock, into.id, {
    edit: true,
    renderScopeId: surface.renderScopeId,
    selection: {start: joinOffset},
  })
  return true
}
