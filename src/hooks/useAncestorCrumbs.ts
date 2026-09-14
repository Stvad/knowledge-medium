import { useMemo } from 'react'
import { useRepo } from '@/context/repo.js'
import { useHandles, useStableJson } from '@/hooks/block.js'
import { crumbsFromAncestors } from '@/utils/blockCrumbs.js'

const EMPTY_CRUMBS: ReadonlyMap<string, readonly string[]> = new Map()

/** Ancestor crumbs for a set of blocks, loaded AFTER the rows they
 *  annotate are already on screen.
 *
 *  The crumbs never sit in front of the results: the search renders, then
 *  the ancestor walks fill the reserved line in. A caller pairs this with
 *  `BlockCrumbs`, whose height is fixed whether or not the crumbs have
 *  arrived, so the fill-in cannot move the rows under the user's cursor.
 *
 *  That is a scheduling guarantee, not an isolation one: the walk shares
 *  one SQLite connection with search, so it does delay the next
 *  keystroke. Acceptable only while it stays a PK-bounded climb — what
 *  would move it is the walk ceasing to be index-backed, or chains far
 *  deeper than an outline's usual 5–15 levels.
 *
 *  One `core.ancestors` handle per id, so a result set that shifts every
 *  keystroke re-reads only the ids that entered it. Crumbs are live: a
 *  block reparented while the dialog is open re-crumbs. That the walk
 *  reports the parent it stopped at is what lets the caller pass ids
 *  alone — a search payload's `parentId` is not row-dep'd and can claim a
 *  parent for a block that has since moved to the workspace root, which
 *  would mark a genuine root as truncated.
 *
 *  Crumbs live in the handles, so an id that LEAVES the set for longer
 *  than the store's GC window loses them: type past a result and back to
 *  it slowly, and those rows re-crumb a load late.
 *
 *  A failed walk leaves that id absent from the map rather than throwing:
 *  breadcrumbs are decoration and must never take the search down with
 *  them. Crumb FORMATTING is deliberately not wrapped to match — a catch
 *  here would be one site of a rule with no owner. */
export const useAncestorCrumbs = (
  blockIds: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const repo = useRepo()
  // Crumbs are scoped to the active workspace: `crumbsFromAncestors`
  // refuses to render an ancestor from another one, and with no workspace
  // there is nothing to scope against, so we don't ask at all.
  const workspaceId = repo.activeWorkspaceId
  const ids = useStableJson(blockIds)

  const handles = useMemo(
    () => (workspaceId ? ids.map(id => repo.query.ancestors({id})) : []),
    [ids, repo, workspaceId],
  )
  const walks = useHandles(handles)

  return useMemo(() => {
    if (!workspaceId) return EMPTY_CRUMBS
    const out = new Map<string, readonly string[]>()
    ids.forEach((id, index) => {
      const walk = walks[index]
      if (!walk) return
      out.set(id, crumbsFromAncestors(walk.ancestors, {
        workspaceId,
        stoppedAtParentId: walk.stoppedAtParentId,
      }))
    })
    return out.size === 0 ? EMPTY_CRUMBS : out
  }, [ids, walks, workspaceId])
}
