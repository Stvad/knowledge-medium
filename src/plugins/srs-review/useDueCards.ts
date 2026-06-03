import { useEffect, useMemo, useState } from 'react'
import type { BlockData, TypedBlockQuery } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useBlockQuery, useHandle } from '@/hooks/block.js'
import { UNRESOLVED_TAG_ID, buildDueCardsQuery } from './dueQuery.ts'

const startOfLocalDay = (now: Date = new Date()): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

/** Local-midnight timestamp for today, advanced when the date rolls
 *  over. Polls once a minute (cheap, and only re-renders on the minute
 *  the day actually changes) so a deck left open overnight refreshes its
 *  due cutoff instead of staying pinned to yesterday. */
const useStartOfToday = (): number => {
  const [ts, setTs] = useState(startOfLocalDay)
  useEffect(() => {
    const id = setInterval(() => {
      const next = startOfLocalDay()
      setTs(prev => (prev === next ? prev : next))
    }, 60_000)
    return () => clearInterval(id)
  }, [])
  return ts
}

/** Shared query builder for the due-cards hooks, so `useDueCards` and
 *  `useDueCardsReady` observe the exact same typed-blocks handle.
 *
 *  A non-empty `tagName` is resolved to its page block id via
 *  `core.aliasLookup`; when the page doesn't exist the deck targets
 *  `UNRESOLVED_TAG_ID` so it reports zero rather than every due card.
 *  An empty `tagName` is the "all due" deck (no tag filter). */
const useDueCardsQuery = (workspaceId: string, tagName: string): TypedBlockQuery => {
  const repo = useRepo()
  const alias = tagName.trim()
  const wantsTag = alias.length > 0

  // aliasLookup short-circuits to null on an empty alias, so the
  // all-due deck simply gets a null tag id.
  const resolvedId = useHandle(
    repo.query.aliasLookup({workspaceId, alias: wantsTag ? alias : ''}),
    {selector: data => (data ? data.id : null)},
  ) as string | null
  const tagBlockId = wantsTag ? (resolvedId ?? UNRESOLVED_TAG_ID) : null

  // Drives the due cutoff off today's local midnight, which advances
  // overnight — so a deck left open past midnight starts surfacing the
  // newly-due cards instead of staying pinned to yesterday's boundary.
  const startOfToday = useStartOfToday()
  return useMemo(
    () => buildDueCardsQuery({workspaceId, tagBlockId, now: new Date(startOfToday)}),
    [workspaceId, tagBlockId, startOfToday],
  )
}

/** Reactive list of SRS cards due today or earlier for a deck. */
export const useDueCards = (workspaceId: string, tagName: string): BlockData[] =>
  useBlockQuery(useDueCardsQuery(workspaceId, tagName))

/** Whether the due-cards query has produced a result yet (vs. still
 *  loading). A loaded-but-empty deck reports `true` here while
 *  `useDueCards` returns `[]`, letting callers tell "nothing due" apart
 *  from "not loaded yet" — the query handle's data is `undefined` until
 *  the first resolve, then an array (possibly empty). Shares the handle
 *  with `useDueCards`, so it adds no extra query. */
export const useDueCardsReady = (workspaceId: string, tagName: string): boolean => {
  const repo = useRepo()
  const query = useDueCardsQuery(workspaceId, tagName)
  return useHandle(repo.query.typedBlocks(query), {
    selector: data => data !== undefined,
  }) as boolean
}
