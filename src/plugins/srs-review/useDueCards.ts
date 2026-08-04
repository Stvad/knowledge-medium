import { useMemo } from 'react'
import type { BlockData, TypedBlockQuery } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useBlockQuery, useHandle } from '@/hooks/block.js'
import { useStartOfToday } from '@/plugins/daily-notes/today.js'
import {
  UNRESOLVED_TAG_ID,
  buildDueCardsQuery,
  buildTaggedCandidatesQuery,
  selectNewCards,
} from './dueQuery.ts'

/** The deck tag's page block id, or null for the untagged "all due" deck.
 *
 *  A non-empty `tagName` is resolved via `core.aliasLookup`; when the page
 *  doesn't exist the deck targets `UNRESOLVED_TAG_ID` so it reports zero
 *  rather than every due card. */
interface ResolvedTag {
  tagBlockId: string | null
  /** False while `aliasLookup` is still loading. Load and "no such page" both
   *  produce a null id, and the difference matters: an unresolved tag falls
   *  back to `UNRESOLVED_TAG_ID`, whose queries match NOTHING and settle
   *  immediately. Without this flag the deck reports ready with an empty new
   *  set before the real tag has even been looked up — and a restored session
   *  graded in that window drops a valid new card. */
  resolved: boolean
}

const useTagBlockId = (workspaceId: string, tagName: string): ResolvedTag => {
  const repo = useRepo()
  const alias = tagName.trim()
  const wantsTag = alias.length > 0

  // `undefined` is preserved as "still loading" — the selector must NOT
  // collapse it to null, which is also what a genuinely missing page returns.
  const resolvedId = useHandle(
    repo.query.aliasLookup({workspaceId, alias: wantsTag ? alias : ''}),
    {selector: data => (data === undefined ? undefined : (data ? data.id : null))},
  ) as string | null | undefined

  // The all-due deck asks no question, so there is nothing to wait for.
  if (!wantsTag) return {tagBlockId: null, resolved: true}
  return {tagBlockId: resolvedId ?? UNRESOLVED_TAG_ID, resolved: resolvedId !== undefined}
}

/** Shared query builder for the due-cards hooks, so `useDueCards` and
 *  `useDueCardsReady` observe the exact same typed-blocks handle. */
const useDueCardsQuery = (workspaceId: string, tagName: string): TypedBlockQuery => {
  const {tagBlockId} = useTagBlockId(workspaceId, tagName)

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

/** Just the cardinality, aggregated in SQLite rather than by materialising
 *  rows. The deck picker renders one number per deck and held every due card
 *  to do it; `core.typedBlockCount` is the same question with a different
 *  projection, sharing the list query's membership semantics, candidate set and
 *  invalidation, so the two cannot disagree. `undefined` until the first
 *  resolve.
 *
 *  Counts DUE cards only, not the tagged-but-unenrolled ones a session also
 *  collects — "N due" stays literally true, and counting new cards would mean
 *  materialising every block that references the tag (see
 *  `buildTaggedCandidatesQuery`), which is exactly the per-tag-per-render cost
 *  this hook exists to avoid. */
export const useDueCardCount = (workspaceId: string, tagName: string): number | undefined => {
  const repo = useRepo()
  const query = useDueCardsQuery(workspaceId, tagName)
  // Identity selector: the handle's whole value IS the number, so there is
  // nothing narrower to project. Spelled out because the lint rule that asks
  // for one is guarding against subscribing to a whole row for one field.
  return useHandle(repo.query.typedBlockCount(query), {selector: data => data}) as number | undefined
}

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
  /** False until the tag lookup AND both queries have resolved. Reconciling a
   *  restored session against a half-loaded collection would drop its new
   *  cards — and the tag lookup counts, because an unresolved tag makes both
   *  queries settle instantly against a sentinel that matches nothing. */
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
  const {tagBlockId, resolved: tagResolved} = useTagBlockId(workspaceId, tagName)
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
      ready: tagResolved && dueReady && candidatesReady,
    }
  }, [dueCards, candidates, tagResolved, dueReady, candidatesReady])
}
