import type { TypedBlockQuery } from '@/data/api'
import { dueByDailyNoteRef } from '@/plugins/daily-notes/dueQuery.js'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsNextReviewDateProp,
} from '@/plugins/srs-rescheduling'

/** Re-exported for the plugin's public surface. The definition lives with
 *  daily notes because the cutoff is a property of how they encode dates. */
export { dueBoundary } from '@/plugins/daily-notes/dueQuery.js'

/** A tag id can never legitimately be this string, so a `referencedBy`
 *  filter against it matches nothing. Used when a deck names a tag
 *  whose page doesn't exist yet — the deck should show zero due cards,
 *  not (as an unfiltered query would) every due card in the workspace. */
export const UNRESOLVED_TAG_ID = 'srs-review:unresolved-tag'

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
 *   - `dueByDailyNoteRef` traverses the `next-review-date` ref into its
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
  where: dueByDailyNoteRef(srsNextReviewDateProp.name, now),
  exclude: [{scope: 'self', where: {[srsArchivedProp.name]: true}}],
  ...(tagBlockId ? {match: [{scope, referencedBy: {id: tagBlockId}}]} : {}),
  order: 'created-asc',
})
