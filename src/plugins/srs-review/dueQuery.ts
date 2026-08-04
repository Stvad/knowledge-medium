import type { BlockData, TypedBlockQuery } from '@/data/api'
import { getBlockTypes } from '@/data/properties.js'
import { dueByDailyNoteRef } from '@/plugins/daily-notes/dueQuery.js'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
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
  // `sourceField: ''` restricts this to CONTENT references — the `[[Tag]]`
  // the user actually typed into the block. `block_references` also holds a
  // row per typed ref *property* (`source_field` = the property name; see
  // `references/localSchema.ts`), so an unqualified filter would treat a
  // block whose unrelated `project` ref happens to point at the deck's tag
  // page as "tagged for review". Enrolment WRITES, so it takes the narrow
  // reading; the due query stays unqualified because merely listing an
  // existing card is harmless.
  referencedBy: {id: tagBlockId || UNRESOLVED_TAG_ID, sourceField: ''},
  order: 'created-asc',
})

/** Names of every property `applySrsReschedulePlan` writes. Presence of ANY
 *  of them means the block has been scheduled before, whatever its types
 *  say. */
const SRS_SCHEDULING_PROP_NAMES: readonly string[] = [
  srsIntervalProp.name,
  srsFactorProp.name,
  srsNextReviewDateProp.name,
  srsReviewCountProp.name,
  srsGradeProp.name,
  srsSnapshotHistoryProp.name,
  srsArchivedProp.name,
]

const hasStoredSrsState = (data: BlockData): boolean =>
  SRS_SCHEDULING_PROP_NAMES.some(name => data.properties[name] !== undefined)

/** `getBlockTypes` decodes strictly (no try/catch), and unlike every other
 *  caller this one runs over ARBITRARY user blocks: the candidates query
 *  returns every block referencing the tag, not a set already known to be
 *  well-formed. A single malformed `types` value — legacy, imported, synced
 *  or raw-written — would throw here and take the whole deck down, since
 *  this runs during `useReviewDeckCards`' render.
 *
 *  An unreadable value is treated as "can't classify", which excludes it:
 *  the same conservative direction as `hasStoredSrsState` — when in doubt,
 *  don't enrol. Being invisible to the deck is recoverable; enrolling a
 *  block we couldn't read is not. */
const lacksSrsType = (data: BlockData): boolean => {
  try {
    return !getBlockTypes(data).includes(SRS_SM25_TYPE)
  } catch {
    return false
  }
}

/** The tagged blocks that aren't cards yet — "tagged for SRS but with no
 *  SRS metadata".
 *
 *  Missing the type is NOT sufficient on its own, and treating it as such
 *  would destroy review history. Removing a type is a generic, one-click
 *  operation in the type editor (`TypesPropertyEditor` → `repo.setBlockTypes`),
 *  and `_removeTypeInTx` rewrites ONLY the types array — a mature card whose
 *  `srs-sm2.5` chip is removed keeps its `interval`, `factor` and its whole
 *  `snapshot-history`, and keeps the deck's tag. Enrol that as "new" and the
 *  first grade runs `basisFromBlock`, which ignores stored properties when
 *  the type is absent (`hasSrsType ? data.properties : {}`) and reschedules
 *  from the SM-2.5 defaults — overwriting real history with a single fresh
 *  snapshot, under a "New" badge that reads as "nothing to lose".
 *
 *  So a candidate qualifies only if it carries neither the type NOR any
 *  property the scheduler writes. A de-typed card falls through both tests
 *  and stays invisible to the deck, exactly as before this feature existed;
 *  re-adding its type restores it as the mature card it still is. */
export const selectNewCards = (candidates: readonly BlockData[]): BlockData[] =>
  candidates.filter(data => lacksSrsType(data) && !hasStoredSrsState(data))
