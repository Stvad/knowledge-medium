import { useMemo } from 'react'
import type { BlockData } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useHandles } from '@/hooks/block.js'
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
 *  That is a scheduling guarantee, not an isolation one. This repo's
 *  PowerSync setup runs `OPFSCoopSyncVFS` — ONE connection behind a
 *  single-slot mutex, no read/read concurrency — so an ancestor read in
 *  flight when the next keystroke's search dispatches does delay it. What
 *  makes that a non-issue is the size of the read: the walk joins on
 *  `blocks.id` (the primary key), so it costs PK lookups bounded by chain
 *  DEPTH and dodges the automatic-index planner trap `SUBTREE_SQL` needs
 *  an `INDEXED BY` hint for. It therefore does NOT grow with the
 *  workspace the way content search does (an unindexed LIKE scan,
 *  "O(total content bytes)" in `linkTargetAutocomplete`'s own words) — so
 *  the margin holds as data grows. What would move it: the walk ceasing
 *  to be index-backed, or chains far deeper than an outline's usual 5–15
 *  levels.
 *
 *  One `core.ancestors` handle per id, which is the per-id cache: a
 *  result set that shifts every keystroke re-reads only the ids that
 *  entered it, and those reads coalesce into one statement. Crumbs are
 *  live, so a block reparented while the dialog is open re-crumbs.
 *
 *  Crumbs live in the handles, so an id that LEAVES the set for longer
 *  than the store's GC window loses them: type past a result and back to
 *  it slowly, and those rows re-crumb a load late.
 *
 *  A failed walk leaves that id absent from the map rather than throwing:
 *  breadcrumbs are decoration and must never take the search down with
 *  them. Crumb FORMATTING is deliberately not wrapped to match: a
 *  malformed chain would throw during render exactly as it would for
 *  every other consumer that projects a query result, and a catch here
 *  would be one site of a rule with no owner. */
export const useAncestorCrumbs = (
  blocks: readonly AncestorCrumbTarget[],
): ReadonlyMap<string, readonly string[]> => {
  const repo = useRepo()
  // Crumbs are scoped to the active workspace: `crumbsFromAncestors`
  // refuses to render an ancestor from another one, and with no workspace
  // there is nothing to scope against, so we don't ask at all.
  const workspaceId = repo.activeWorkspaceId
  // Keyed on the targets' CONTENT, not the array's identity, so a caller
  // can build it inline — and serialized as JSON rather than joined on a
  // delimiter. `blockId.ts` enforces canonical uuids only on the tx INSERT
  // path and deliberately exempts sync-applied and `applyRaw` rows, so an
  // id containing the delimiter is not impossible; encoding it away costs
  // nothing and removes the assumption.
  const targetsKey = JSON.stringify(blocks.map(block => [block.id, block.parentId]))
  const targets = useMemo(
    () => JSON.parse(targetsKey) as [string, string | null][],
    [targetsKey],
  )

  const chainHandles = useMemo(
    () => (workspaceId ? targets.map(([id]) => repo.query.ancestors({id})) : []),
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
    () => (workspaceId ? targets.map(([id]) => repo.block(id)) : []),
    [targets, repo, workspaceId],
  )

  const chains = useHandles(chainHandles)
  // Observed, not fetched. A seed row the caller's search already
  // hydrated is free to read, and one it did not is exactly the case the
  // payload's `parentId` fallback exists for — loading it would be a row
  // read per result, serialized behind the ancestor walk, to improve on
  // an answer we already have.
  const seeds = useHandles(seedHandles, {fetchMissing: false})

  return useMemo(() => {
    if (!workspaceId) return EMPTY_CRUMBS
    const out = new Map<string, readonly string[]>()
    targets.forEach(([id, payloadParentId], index) => {
      const ancestors = chains[index] as BlockData[] | undefined
      if (!ancestors) return
      const seed = seeds[index]
      out.set(id, crumbsFromAncestors(ancestors, {
        workspaceId,
        parentId: seed ? seed.parentId : payloadParentId,
      }))
    })
    return out.size === 0 ? EMPTY_CRUMBS : out
  }, [targets, chains, seeds, workspaceId])
}
