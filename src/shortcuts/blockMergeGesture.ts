import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { holdsSource } from '@/data/blockTypes'
import { merge } from '@/data/mutators'
import { focusBlock } from '@/data/properties'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
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
  propertyDisplay: PropertyDisplayScopeLevels,
): Promise<boolean> => {
  const fromChildIds = await visibleChildIds(from, propertyDisplay)
  if (fromChildIds.length === 0) return false
  const intoChildIds = await visibleChildIds(into, propertyDisplay)
  return intoChildIds.some(childId => childId !== from.id)
}

export interface MergeUpGesture {
  /** The block Backspace consumes. */
  from: Block
  /** The block drawn before it, which takes its text. */
  into: Block
  /** The editor's live text of `from`: the stored content may lag its debounce. */
  liveContent: string
  propertyDisplay: PropertyDisplayScopeLevels
  uiStateBlock: Block
  renderScopeId: string | undefined
  /** Runs once the merge is not refused, before it writes (the key's preventDefault). */
  onTaken?: () => void
}

/** Backspace at the start of `from`: its text joins `into`'s, its children
 *  follow, and `into` is edited at the join. Refused where either block holds
 *  source (the text would join code), where both show children of their own,
 *  and where deleting `from` would be (a merge destroys it). Returns whether
 *  it merged. */
export const mergeUp = async (
  {from, into, liveContent, propertyDisplay, uiStateBlock, renderScopeId, onTaken}: MergeUpGesture,
): Promise<boolean> => {
  await Promise.all([from.load(), into.load()])
  if (holdsSource(from) || holdsSource(into)) return false
  if (await bothShowIndependentChildren({into, from}, propertyDisplay)) return false
  onTaken?.()
  const joinOffset = into.peek()?.content.length ?? 0
  if (!await ensureDeletableThroughUi([from])) return false
  // One transaction: the live text first, so the merge concatenates it.
  await from.repo.tx(async tx => {
    await tx.update(from.id, {content: liveContent})
    await tx.run(merge, {intoId: into.id, fromId: from.id})
  }, {scope: ChangeScope.BlockDefault, description: 'merge into previous block'})
  await focusBlock(uiStateBlock, into.id, {edit: true, renderScopeId, selection: {start: joinOffset}})
  return true
}
