/**
 * Shared "is this id inside one of these root ids' subtrees?" walk: after
 * a move, `moveAction` uses it to find every selected id the moved roots
 * carried along (the roots themselves and any descendant riding inside
 * them), so those leave the ui-state selection.
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
