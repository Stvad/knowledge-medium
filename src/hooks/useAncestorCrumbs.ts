import { useMemo } from 'react'
import { useRepo } from '@/context/repo.js'
import { useHandles, useStableJson } from '@/hooks/block.js'
import { crumbsFromAncestors } from '@/utils/blockCrumbs.js'

const EMPTY_CRUMBS: ReadonlyMap<string, readonly string[]> = new Map()

export interface AncestorCrumbTarget {
  id: string
  /** The block's own parent edge, as the caller's payload has it — the
   *  FALLBACK for the live row below, not the source of truth. See
   *  `crumbsFromAncestors`, which needs the edge to tell a root from an
   *  orphan when the ancestor walk comes back empty. */
  parentId: string | null
}

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
 *  block reparented while the dialog is open re-crumbs.
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
  blocks: readonly AncestorCrumbTarget[],
): ReadonlyMap<string, readonly string[]> => {
  const repo = useRepo()
  // Crumbs are scoped to the active workspace: `crumbsFromAncestors`
  // refuses to render an ancestor from another one, and with no workspace
  // there is nothing to scope against, so we don't ask at all.
  const workspaceId = repo.activeWorkspaceId
  const targets = useStableJson(
    blocks.map(block => ({id: block.id, parentId: block.parentId})),
  )

  const chainHandles = useMemo(
    () => (workspaceId ? targets.map(target => repo.query.ancestors({id: target.id})) : []),
    [targets, repo, workspaceId],
  )
  // The seed row, SUBSCRIBED rather than peeked. `core.searchByContent`
  // deliberately declares no row deps, so a parent move on a result row
  // does not invalidate it (`kernelQueries.test.ts`, "parent move on a
  // result row does NOT invalidate") — a block moved to the workspace
  // root while the dialog is open would keep a stale non-null parent in
  // the caller's payload, and the freshly emptied ancestor walk would
  // then read as a cut chain, marking a genuine root as truncated.
  const seedHandles = useMemo(
    () => (workspaceId ? targets.map(target => repo.block(target.id)) : []),
    [targets, repo, workspaceId],
  )

  const chains = useHandles(chainHandles)
  // Observed, not fetched: a seed nothing hydrated is exactly the case
  // the payload's `parentId` fallback exists for, so a row read per
  // result would be spent improving on an answer we already have.
  const seeds = useHandles(seedHandles, {fetchMissing: false})

  return useMemo(() => {
    if (!workspaceId) return EMPTY_CRUMBS
    const out = new Map<string, readonly string[]>()
    targets.forEach((target, index) => {
      const ancestors = chains[index]
      if (!ancestors) return
      const seed = seeds[index]
      out.set(target.id, crumbsFromAncestors(ancestors, {
        workspaceId,
        parentId: seed ? seed.parentId : target.parentId,
      }))
    })
    return out.size === 0 ? EMPTY_CRUMBS : out
  }, [targets, chains, seeds, workspaceId])
}
