import { useEffect, useRef, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import { collapseCrumbs, crumbsFromAncestors } from '@/utils/blockCrumbs.js'

/** How many ids go into one `core.manyAncestors` statement. One SQL bind
 *  per id, so this bounds the parameter count for a caller that hands us
 *  more ids than any search surface does today (every one of them caps at
 *  25, i.e. a single chunk). */
const ANCESTOR_BATCH_SIZE = 50

/** Separator for the effect's id key. `\u001f` (unit separator) can't
 *  appear in a block id, so a join is unambiguous — and keying the effect
 *  on the CONTENT of the id list rather than the array's identity keeps a
 *  caller free to build it inline (the same reason `BlockSearchPicker`
 *  joins its exclusion set). */
const ID_KEY_SEPARATOR = '\u001f'

const EMPTY_CRUMBS: ReadonlyMap<string, readonly string[]> = new Map()

/** Ancestor crumbs for a set of blocks, loaded AFTER the rows they
 *  annotate are already on screen.
 *
 *  The point is that search stays exactly as fast as it was. The crumbs
 *  never sit in front of the results: the search renders, then one
 *  batched `core.manyAncestors` fills the reserved line in. A caller
 *  pairs this with `BlockCrumbs`, whose height is fixed whether or not
 *  the crumbs have arrived, so the fill-in cannot move the rows under the
 *  user's cursor.
 *
 *  Ids are requested ONCE per hook instance (typically one dialog
 *  session). Typing a character re-runs the search and usually returns
 *  overlapping ids; only the genuinely new ones cost a query, and the
 *  rows that survived keep their crumbs rather than blanking and
 *  re-filling.
 *
 *  Snapshot semantics, not live: crumbs are read once and not resubscribed
 *  to. A search dropdown is open for seconds and a re-parent mid-typing
 *  would only shuffle a decoration — not worth N row subscriptions per
 *  keystroke. Consumers that need live ancestors want `useParents` /
 *  `useManyParents`.
 *
 *  A failed load is logged and dropped: breadcrumbs are decoration and
 *  must never take the search down with them. Those ids stay eligible, so
 *  the next query that includes them retries. */
export const useAncestorCrumbs = (
  blockIds: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const repo = useRepo()
  const [crumbs, setCrumbs] = useState(EMPTY_CRUMBS)
  // Ids already fetched or in flight. A ref, not state: it gates whether
  // the effect issues a query and must never itself trigger a render.
  const requestedRef = useRef<Set<string>>(new Set())
  const idsKey = blockIds.join(ID_KEY_SEPARATOR)

  useEffect(() => {
    // Captured once rather than read through the ref in the cleanup: the
    // Set is created with the ref and never reassigned, so this is the
    // same object either way — and it's what the exhaustive-deps rule
    // wants to see for a ref touched during teardown.
    const requested = requestedRef.current
    const ids = idsKey ? idsKey.split(ID_KEY_SEPARATOR) : []
    const missing = ids.filter(id => !requested.has(id))
    if (missing.length === 0) return

    for (const id of missing) requested.add(id)
    // Ids this run claimed but hasn't delivered yet. On teardown they go
    // back into the pool: otherwise a superseded run (the query changed
    // while its chunks were in flight) would leave them marked requested
    // forever and those rows could never get a crumb line.
    const undelivered = new Set(missing)
    let cancelled = false

    void (async () => {
      for (let start = 0; start < missing.length; start += ANCESTOR_BATCH_SIZE) {
        const chunk = missing.slice(start, start + ANCESTOR_BATCH_SIZE)
        try {
          const entries = await repo.query.manyAncestors({ids: chunk}).load()
          if (cancelled) return
          for (const id of chunk) undelivered.delete(id)
          setCrumbs(previous => {
            const next = new Map(previous)
            for (const entry of entries) {
              next.set(entry.startId, collapseCrumbs(crumbsFromAncestors(entry.ancestors)))
            }
            return next
          })
        } catch (error) {
          console.error('[ancestor-crumbs] failed to load ancestors', error)
          for (const id of chunk) {
            undelivered.delete(id)
            requested.delete(id)
          }
          if (cancelled) return
        }
      }
    })()

    return () => {
      cancelled = true
      for (const id of undelivered) requested.delete(id)
    }
  }, [idsKey, repo])

  return crumbs
}
