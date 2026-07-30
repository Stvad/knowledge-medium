import type { BlockData, TypedBlockQuery } from '@/data/api'
import { getBlockTypes } from '@/data/properties.js'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsNextReviewDateProp,
} from '@/plugins/srs-rescheduling'

/** A tag id can never legitimately be this string, so a `referencedBy`
 *  filter against it matches nothing. Used when a deck names a tag
 *  whose page doesn't exist yet — the deck should show zero due cards,
 *  not (as an unfiltered query would) every due card in the workspace. */
export const UNRESOLVED_TAG_ID = 'srs-review:unresolved-tag'

/** UTC midnight of the day after today's *local* calendar date. A card
 *  counts as due when its next-review daily note's date is strictly
 *  before this — i.e. today or any earlier day.
 *
 *  Daily notes store `daily-note:date` at UTC midnight of their calendar
 *  day (`Date.parse(`${iso}T00:00:00Z`)`), so the cutoff has to be UTC
 *  midnight too. A local-midnight cutoff would, west of UTC, encode to
 *  later than tomorrow's UTC-midnight daily note and pull tomorrow's
 *  cards into the deck a day early. */
export const dueBoundary = (now: Date = new Date()): Date => {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  tomorrow.setDate(tomorrow.getDate() + 1)
  return new Date(Date.UTC(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()))
}

export interface DueCardsQueryInput {
  workspaceId: string
  /** Tag's block id, or null/undefined for the "all due" deck. Pass
   *  `UNRESOLVED_TAG_ID` for a named-but-missing tag. */
  tagBlockId?: string | null
  /** Tag on the card itself (`self`) vs the card or any ancestor
   *  (`ancestor`, the page-as-tag default). */
  scope?: 'self' | 'ancestor'
  now?: Date
}

/** SRS cards due today or earlier, optionally scoped to a tag. Built
 *  entirely from `core.typedBlocks`' existing capabilities:
 *   - `where … target` traverses the `next-review-date` ref into its
 *     daily note and compares the daily note's `daily-note:date`.
 *   - `match … referencedBy` (ancestor scope) is the tag filter.
 *   - archived cards are EXCLUDED rather than matched on
 *     `archived: false`: most cards never set the property, and SQL's
 *     `archived = 0` never matches a NULL (unset) column, so a match
 *     would drop every card that's never been archived. */
export const buildDueCardsQuery = ({
  workspaceId,
  tagBlockId,
  scope = 'ancestor',
  now,
}: DueCardsQueryInput): TypedBlockQuery => ({
  workspaceId,
  types: [SRS_SM25_TYPE],
  where: {
    [srsNextReviewDateProp.name]: {
      target: {[dailyNoteDateProp.name]: {lt: dueBoundary(now)}},
    },
  },
  exclude: [{scope: 'self', where: {[srsArchivedProp.name]: true}}],
  ...(tagBlockId ? {match: [{scope, referencedBy: {id: tagBlockId}}]} : {}),
  order: 'created-asc',
})

/** Every block carrying the deck's tag ON ITSELF, cards and non-cards
 *  alike. `selectNewCards` narrows this to the ones that aren't cards yet.
 *
 *  Two deliberate differences from `buildDueCardsQuery`:
 *
 *  - Scope is always `self`, never the deck's `ancestor` default. An
 *    *existing* card may inherit deck membership from a tagged ancestor
 *    page, but ENROLLING a block is only ever triggered by a tag on the
 *    block itself. Ancestor scope here would enqueue every bullet under a
 *    tagged page — answers, prose, scratch notes — as a new card.
 *  - No type filter, because the predicate language has no "does NOT carry
 *    type X" primitive (`types` is positive-only; `exclude` predicates
 *    carry `where`/`referencedBy`/`id`, and the types property is a list,
 *    so no `where` operator expresses non-membership). The tag narrows the
 *    scan to `block_references`; `selectNewCards` applies the type test to
 *    that result.
 *
 *  An absent `tagBlockId` (the untagged "all due" deck, or a tag whose page
 *  doesn't exist) targets `UNRESOLVED_TAG_ID`, so the query matches nothing:
 *  with no tag there is no "tagged for SRS" set to collect from. The filter
 *  is kept rather than dropped — an omitted `referencedBy` would collect
 *  every block in the workspace — and a sentinel id is used rather than a
 *  null, which the predicate validator rejects outright. */
export const buildTaggedCandidatesQuery = ({
  workspaceId,
  tagBlockId,
}: Pick<DueCardsQueryInput, 'workspaceId' | 'tagBlockId'>): TypedBlockQuery => ({
  workspaceId,
  referencedBy: {id: tagBlockId || UNRESOLVED_TAG_ID},
  order: 'created-asc',
})

/** The tagged blocks that aren't cards yet — "tagged for SRS but with no
 *  SRS metadata". Carrying the type IS the metadata: every scheduling
 *  property is written in the same tx that adds it (`applySrsReschedulePlan`),
 *  so there is no half-enrolled state to distinguish, and a card that's
 *  merely not due today must NOT come back as new. */
export const selectNewCards = (candidates: readonly BlockData[]): BlockData[] =>
  candidates.filter(data => !getBlockTypes(data).includes(SRS_SM25_TYPE))
