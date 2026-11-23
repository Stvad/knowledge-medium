import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { holdsSource } from '@/data/blockTypes'
import { merge } from '@/data/mutators'
import { editorSelection, focusBlock } from '@/data/properties'
import { flushPendingEditorContent } from '@/data/pendingEditorContent'
import type { ListingSurface } from '@/data/childrenView'
import { visibleChildIds } from '@/data/visibleChildren'
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
  const fromChildIds = await visibleChildIds(from, surface)
  if (fromChildIds.length === 0) return false
  const intoChildIds = await visibleChildIds(into, surface)
  return intoChildIds.some(childId => childId !== from.id)
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
  /** Runs once the merge is not refused, before it writes (the key's preventDefault). */
  onTaken?: () => void
}

/** Backspace at the start of `from`: its text joins `into`'s, its children
 *  follow, and `into` is edited at the join. Refused where either block holds
 *  source (the text would join code), where both show children of their own,
 *  and where deleting `from` would be (a merge destroys it). Returns whether
 *  it merged. */
export const mergeUp = async (
  {from, into, liveContent, surface, uiStateBlock, onTaken}: MergeUpGesture,
): Promise<boolean> => {
  await Promise.all([from.load(), into.load()])
  if (holdsSource(from) || holdsSource(into)) return false
  if (await bothShowIndependentChildren({into, from}, surface)) return false
  onTaken?.()
  const joinOffset = into.peek()?.content.length ?? 0
  if (!await ensureDeletableThroughUi([from])) return false
  // The editor's pending text is saved as its own undo step first, so undoing
  // the merge restores `from` with what was typed.
  flushPendingEditorContent()
  // One transaction: the live text first, so the merge concatenates it.
  await from.repo.tx(async tx => {
    await tx.update(from.id, {content: liveContent})
    await tx.run(merge, {intoId: into.id, fromId: from.id})
  }, {scope: ChangeScope.BlockDefault, description: 'merge into previous block'})
  await uiStateBlock.set(editorSelection, {blockId: into.id, start: joinOffset})
  await focusBlock(uiStateBlock, into.id, {edit: true, renderScopeId: surface.renderScopeId})
  return true
}
