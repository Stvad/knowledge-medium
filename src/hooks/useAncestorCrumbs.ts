import { useEffect, useRef, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import { crumbsFromAncestors } from '@/utils/blockCrumbs.js'

/** How many ids go into one `core.manyAncestors` statement. One SQL bind
 *  per id, so this bounds the parameter count for a caller that hands us
 *  more ids than any search surface does today (every one of them caps at
 *  25, i.e. a single chunk). */
const ANCESTOR_BATCH_SIZE = 50

const EMPTY_CRUMBS: ReadonlyMap<string, readonly string[]> = new Map()

export interface AncestorCrumbTarget {
  id: string
  /** The block's own parent edge — see `crumbsFromAncestors`, which needs
   *  it to tell a root from an orphan when the ancestor walk comes back
   *  empty. */
  parentId: string | null
}

/** Ancestor crumbs for a set of blocks, loaded AFTER the rows they
 *  annotate are already on screen.
 *
 *  The crumbs never sit in front of the results: the search renders, then
 *  a batched `core.manyAncestors` fills the reserved line in. A caller
 *  pairs this with `BlockCrumbs`, whose height is fixed whether or not
 *  the crumbs have arrived, so the fill-in cannot move the rows under the
 *  user's cursor.
 *
 *  That is a scheduling guarantee, not an isolation one. This repo's
 *  PowerSync setup runs `OPFSCoopSyncVFS` — ONE connection behind a
 *  single-slot mutex, no read/read concurrency — so an ancestor read in
 *  flight when the next keystroke's search dispatches does delay it. What
 *  makes that a non-issue is the size of the read: `manyAncestors` joins
 *  on `blocks.id` (the primary key), so it costs PK lookups bounded by
 *  chain DEPTH and dodges the automatic-index planner trap `SUBTREE_SQL`
 *  needs an `INDEXED BY` hint for. It therefore does NOT grow with the
 *  workspace the way content search does (an unindexed LIKE scan,
 *  "O(total content bytes)" in `linkTargetAutocomplete`'s own words) — so
 *  the margin holds as data grows. What would move it: a caller batching
 *  hundreds of ids, the walk ceasing to be index-backed, or chains far
 *  deeper than an outline's usual 5–15 levels.
 *
 *  Each distinct missing-id set is its own handle (`HandleStore` keys on
 *  the args), so a typing burst leaves a few short-lived handles to GC
 *  rather than reusing one.
 *
 *  Snapshot semantics, not live: crumbs are read once and not resubscribed
 *  to. A search dropdown is open for seconds and a re-parent mid-typing
 *  would only shuffle a decoration — not worth N row subscriptions per
 *  keystroke. That covers the narrower `load()`-vs-`loadFresh()` case as
 *  well: `load` can resolve a snapshot invalidated while its loader ran,
 *  and since these ids stay claimed nothing re-asks — but a reparent one
 *  millisecond LATER produces the same stale crumb by design, so the
 *  window is not a distinct defect, and `loadFresh` is not on the public
 *  `Handle` contract (only `LoaderHandle`) to reach for anyway.
 *
 *  Deliberately NOT built on `useManyParents`, which wraps the same query
 *  in a live `useHandle`: its handle is keyed by the whole id list, and
 *  the resolver has no per-id sub-cache, so a search whose result set
 *  shifts every keystroke would re-run the full batched SQL for every
 *  visible row each time — the exact cost this hook's accumulate-only-
 *  what's-missing cache exists to avoid. Consumers that want live
 *  ancestors for a STABLE id set still want `useParents` /
 *  `useManyParents`.
 *
 *  A failed load is logged and dropped: breadcrumbs are decoration and
 *  must never take the search down with them. Those ids stay eligible, so
 *  the next query that includes them retries. */
export const useAncestorCrumbs = (
  blocks: readonly AncestorCrumbTarget[],
): ReadonlyMap<string, readonly string[]> => {
  const repo = useRepo()
  const [crumbs, setCrumbs] = useState(EMPTY_CRUMBS)
  // Ids already loaded or in flight. A ref, not state: it gates whether
  // the effect issues a query and must never itself trigger a render.
  const requestedRef = useRef<Set<string>>(new Set())
  // Crumbs are scoped to the active workspace: `crumbsFromAncestors`
  // refuses to render an ancestor from another one, and with no workspace
  // there is nothing to scope against, so we don't ask at all.
  const workspaceId = repo.activeWorkspaceId
  // Keyed on the targets' CONTENT, not the array's identity, so a caller
  // can build it inline — and serialized as JSON rather than joined on a
  // delimiter. `blockId.ts` enforces canonical uuids only on the tx INSERT
  // path and deliberately exempts sync-applied and `applyRaw` rows, so an
  // id containing the delimiter is not impossible; encoding it away costs
  // nothing and removes the assumption. Carrying the parent edge in the
  // key (rather than a ref) keeps the effect from reading state written
  // during render, which the React Compiler may treat as a Rules-of-React
  // violation.
  const targetsKey = JSON.stringify(blocks.map(block => [block.id, block.parentId]))

  // No cancellation, and no cleanup — deliberately, because a superseded
  // run's result is not stale data, it is data. `manyAncestors(ids)`
  // answers "the ancestors of these blocks", a question the search query
  // that prompted it does not participate in, so the answer stays correct
  // however the query has moved on and merging it is monotone. An earlier
  // draft cancelled superseded runs and handed their undelivered ids back
  // to the pool, which cost more than it bought:
  //
  //   - the caller's id list transiently EMPTIES on every keystroke (the
  //     rows are gated on the search result matching the live query),
  //     so each keypress tore down work that was about to land and the
  //     refill re-fetched it from scratch;
  //   - a superseded run that then FAILED handed back ids the newer run
  //     had already re-claimed, un-claiming a fetch in flight;
  //   - StrictMode's mount→cleanup→mount released and re-fetched
  //     everything, doubling query volume on every dialog open in dev.
  //
  // Keeping the claim for the lifetime of the request makes all three
  // disappear: an id in flight is simply never asked for twice. The only
  // path that un-claims is a genuine failure, which is exactly when a
  // retry is wanted.
  useEffect(() => {
    if (!workspaceId) return
    const requested = requestedRef.current
    const targets = JSON.parse(targetsKey) as [string, string | null][]
    const searchParentIds = new Map(targets)
    const ids = targets.map(([id]) => id)
    const missing = ids.filter(id => !requested.has(id))
    if (missing.length === 0) return

    for (const id of missing) requested.add(id)

    // The search row's own `parentId` is the fallback, not the source of
    // truth: `core.searchByContent` deliberately declares no row deps, so a
    // parent move on a result row does NOT invalidate it
    // (`kernelQueries.test.ts`, "parent move on a result row does NOT
    // invalidate"). A block moved to the workspace root while the dialog is
    // open would keep a stale non-null parent there, and the freshly
    // invalidated ancestor walk would return `[]` — reading as an orphan
    // and marking a genuine root as truncated. The BlockCache row is
    // updated by the move itself, so prefer it whenever it's loaded.
    const seedParentId = (id: string): string | null => {
      const cached = repo.block(id).peek()
      return cached ? cached.parentId : searchParentIds.get(id) ?? null
    }

    void (async () => {
      for (let start = 0; start < missing.length; start += ANCESTOR_BATCH_SIZE) {
        const chunk = missing.slice(start, start + ANCESTOR_BATCH_SIZE)
        try {
          const entries = await repo.query.manyAncestors({ids: chunk}).load()
          // Formatted HERE, not inside the updater below. A function-form
          // `setCrumbs` updater does not run in this stack frame — React
          // calls it during a later render — so anything that throws
          // inside it escapes this try entirely: the catch never runs, the
          // ids stay claimed with no retry, and the throw lands on the
          // app-root ErrorBoundary, taking the whole app down. Which is
          // the precise opposite of what this file promises about
          // breadcrumbs being decoration. The updater is left holding only
          // Map insertion of already-computed values, which cannot throw,
          // while still merging onto the LATEST state so concurrent chunks
          // don't clobber each other.
          const formatted = entries.map(entry => [
            entry.startId,
            crumbsFromAncestors(entry.ancestors, {
              workspaceId,
              parentId: seedParentId(entry.startId),
            }),
          ] as const)
          setCrumbs(previous => {
            const next = new Map(previous)
            for (const [blockId, crumbsForBlock] of formatted) next.set(blockId, crumbsForBlock)
            return next
          })
        } catch (error) {
          console.error('[ancestor-crumbs] failed to load ancestors', error)
          for (const id of chunk) requested.delete(id)
        }
      }
    })()
  }, [targetsKey, repo, workspaceId])

  return crumbs
}
