/**
 * Shared "is this id inside one of these root ids' subtrees?" walk, used by
 * two independent move-blocks call sites that both need to attribute an
 * arbitrary block id to a set of ROOT ids:
 *
 *  - `pasteAsMoveImpl` — is a paste destination inside (or one of) the
 *    blocks currently being cut? Falling through to a text paste there
 *    would duplicate the un-deleted originals, so it has to refuse instead.
 *  - `moveAction` — after a `PartialMoveError`, which of the ORIGINALLY
 *    requested ids (before `moveBlocksTo`'s internal descendant pruning)
 *    ended up covered by the roots that actually committed? Those need the
 *    same ui-state-selection bookkeeping a full success gets; the roots
 *    that didn't move (and their descendants) must stay selected.
 */
import type { Repo } from '@/data/repo.js'

/** Cache-only ancestor walk: is `candidateId` itself in `rootIds`, or a
 *  descendant of one of them? Loads the ancestor chain first (cheap if
 *  already cached) so `repo.cache` snapshots are populated to walk. Mirrors
 *  `isDescendantOf` in `@/utils/selection.ts` (not exported from there), a
 *  parent-chain walk with a `seen` guard against a corrupt cycle. */
export const isWithinSubtreeOfAny = async (
  repo: Repo,
  candidateId: string,
  rootIds: ReadonlySet<string>,
): Promise<boolean> => {
  if (rootIds.has(candidateId)) return true
  await repo.load(candidateId, { ancestors: true })

  const seen = new Set<string>([candidateId])
  let currentId = repo.block(candidateId).peek()?.parentId ?? null
  while (currentId) {
    if (seen.has(currentId)) return false // cycle guard
    if (rootIds.has(currentId)) return true
    seen.add(currentId)
    currentId = repo.cache.getSnapshot(currentId)?.parentId ?? null
  }
  return false
}
