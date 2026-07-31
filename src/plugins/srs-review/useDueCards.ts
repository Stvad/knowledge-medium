import { useEffect, useMemo, useState } from 'react'
import type { BlockData, TypedBlockQuery } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useBlockQuery, useHandle } from '@/hooks/block.js'
import {
  UNRESOLVED_TAG_ID,
  buildDueCardsQuery,
  buildTaggedCandidatesQuery,
  selectNewCards,
} from './dueQuery.ts'

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

/** The deck tag's page block id, or null for the untagged "all due" deck.
 *
 *  A non-empty `tagName` is resolved via `core.aliasLookup`; when the page
 *  doesn't exist the deck targets `UNRESOLVED_TAG_ID` so it reports zero
 *  rather than every due card. */
const useTagBlockId = (workspaceId: string, tagName: string): string | null => {
  const repo = useRepo()
  const alias = tagName.trim()
  const wantsTag = alias.length > 0

  // aliasLookup short-circuits to null on an empty alias, so the
  // all-due deck simply gets a null tag id.
  const resolvedId = useHandle(
    repo.query.aliasLookup({workspaceId, alias: wantsTag ? alias : ''}),
    {selector: data => (data ? data.id : null)},
  ) as string | null
  return wantsTag ? (resolvedId ?? UNRESOLVED_TAG_ID) : null
}

/** Shared query builder for the due-cards hooks, so `useDueCards` and
 *  `useDueCardsReady` observe the exact same typed-blocks handle. */
const useDueCardsQuery = (workspaceId: string, tagName: string): TypedBlockQuery => {
  const tagBlockId = useTagBlockId(workspaceId, tagName)

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

/** Whether a typed-blocks query has produced a result yet (vs. still
 *  loading). A loaded-but-empty query reports `true` here while
 *  `useBlockQuery` returns `[]`, letting callers tell "nothing matched"
 *  apart from "not loaded yet" — the handle's data is `undefined` until
 *  the first resolve, then an array (possibly empty). Takes the built
 *  query so it shares the caller's handle and adds no extra query. */
const useQueryReady = (query: TypedBlockQuery): boolean => {
  const repo = useRepo()
  return useHandle(repo.query.typedBlocks(query), {
    selector: data => data !== undefined,
  }) as boolean
}

/** Everything a review session collects for a deck, in the order it should
 *  be shown: the cards due today or earlier, then the blocks the user has
 *  tagged for review that aren't cards yet.
 *
 *  New cards go LAST so the day's scheduled work is never displaced by
 *  freshly-tagged material — and they need no bulk write to exist. Grading
 *  one runs the ordinary `rescheduleBlock` path, whose `basisFromBlock`
 *  already falls back to the SM-2.5 defaults for a block with no SRS
 *  properties and whose apply adds the type in the same tx. So a new card's
 *  scheduling metadata is written exactly once, by the user's own grade, one
 *  card at a time — nothing is written just by opening a deck.
 *
 *  The tagged-candidates query is deliberately session-only (the deck picker
 *  still counts due cards alone): it loads every block referencing the tag,
 *  which is fine once per opened deck but would be paid per-tag on every
 *  render of the picker. */
export interface ReviewDeckCards {
  cards: BlockData[]
  /** Ids within `cards` that aren't enrolled yet. Membership is live, so a
   *  block that loses its tag — or gains the SRS type elsewhere — leaves
   *  the set on its own. */
  newIds: ReadonlySet<string>
  /** False until BOTH queries have resolved. Reconciling a restored session
   *  against a half-loaded collection would drop its new cards. */
  ready: boolean
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

export const useReviewDeckCards = (
  workspaceId: string,
  tagName: string,
): ReviewDeckCards => {
  // Resolve the tag and today's cutoff ONCE and build both queries from them.
  // Going through `useDueCards` + a separate ready hook would re-run
  // `useDueCardsQuery` per call — three `aliasLookup` subscriptions and two
  // identical 60s midnight timers for one screen's worth of state.
  const tagBlockId = useTagBlockId(workspaceId, tagName)
  const startOfToday = useStartOfToday()

  const dueQuery = useMemo(
    () => buildDueCardsQuery({workspaceId, tagBlockId, now: new Date(startOfToday)}),
    [workspaceId, tagBlockId, startOfToday],
  )
  const candidatesQuery = useMemo(
    () => buildTaggedCandidatesQuery({workspaceId, tagBlockId}),
    [workspaceId, tagBlockId],
  )

  const dueCards = useBlockQuery(dueQuery)
  const dueReady = useQueryReady(dueQuery)
  const candidates = useBlockQuery(candidatesQuery)
  const candidatesReady = useQueryReady(candidatesQuery)

  return useMemo(() => {
    // The two sets are disjoint by their predicates (carries the SRS type
    // vs. doesn't), but they are SEPARATE handles that resolve
    // independently — between resolves one can still hold a pre-grade row
    // for a block the other already sees post-grade. Subtracting the due
    // ids keeps that window from queueing the same block twice.
    const dueIds = new Set(dueCards.map(c => c.id))
    const newCards = selectNewCards(candidates).filter(c => !dueIds.has(c.id))
    return {
      cards: [...dueCards, ...newCards],
      newIds: newCards.length === 0 ? EMPTY_IDS : new Set(newCards.map(c => c.id)),
      ready: dueReady && candidatesReady,
    }
  }, [dueCards, candidates, dueReady, candidatesReady])
}
