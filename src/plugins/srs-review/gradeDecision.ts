/**
 * "Should this card be graded, dropped, or neither yet?"
 *
 * A session's queue is FROZEN at snapshot time but graded against LIVE block
 * state, so by the time the user presses a key the card may no longer be what
 * it was. Pulled out of the component as a pure function because the
 * interesting cases are all timing ones that are painful to stage through the
 * UI but trivial to state directly.
 */
import type { BlockData } from '@/data/api'
import { getBlockTypes } from '@/data/properties.js'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsNextReviewDateProp,
} from '@/plugins/srs-rescheduling'

/** Whether a block is still a live, schedulable review card — mirrors the
 *  deck's membership conditions (`buildDueCardsQuery`): it must carry the SRS
 *  type AND a non-empty next-review date AND not be archived.
 *
 *  Every read is inside the try, `getBlockTypes` included: it decodes strictly
 *  and a malformed `types` value would otherwise throw out of a grade handler
 *  (same hazard `selectNewCards` guards against). Unreadable state means "not
 *  a live card", which routes to the conservative branch rather than crashing
 *  the session. */
export const isLiveSrsCard = (data: BlockData): boolean => {
  try {
    if (!getBlockTypes(data).includes(SRS_SM25_TYPE)) return false
    const archivedRaw = data.properties[srsArchivedProp.name]
    if (archivedRaw !== undefined && srsArchivedProp.codec.decode(archivedRaw)) return false
    const dateRaw = data.properties[srsNextReviewDateProp.name]
    return dateRaw !== undefined && srsNextReviewDateProp.codec.decode(dateRaw).length > 0
  } catch {
    return false
  }
}

export type GradeDecision =
  /** Enrolled card, or a block currently in the deck's new set. */
  | 'grade'
  /** Left review since the queue was snapshotted — skip without writing. */
  | 'drop'
  /** Can't tell yet; do nothing at all and let the user try again. */
  | 'wait'

export interface GradeDecisionInput {
  /** Live membership of the deck's new set. Empty while the tagged-candidates
   *  query is still resolving, which is exactly why `ready` is needed. */
  isNew: boolean
  /** Have BOTH the due and candidates queries resolved? */
  ready: boolean
}

/**
 * A restored session is the case that forces the three-way answer. Its queue,
 * index and `revealed` flag all come back synchronously from persisted
 * progress, so the grade controls are live on the very first render — while
 * `newIds` is still empty because the candidates query hasn't resolved. A
 * genuine new card graded in that window looks identical to one whose tag was
 * removed: no SRS type, not in the new set.
 *
 * Treating that as `drop` skips a valid card, tells the user it "is no longer
 * in spaced repetition", and never enrols it. So membership may only be judged
 * negative once `ready` — until then the answer is `wait`, which consumes
 * nothing and leaves the card in place.
 */
export const decideGrade = (
  data: BlockData | null | undefined,
  {isNew, ready}: GradeDecisionInput,
): GradeDecision => {
  // A block that can't be loaded at all is gone regardless of readiness.
  if (!data) return 'drop'
  // `isNew` is only trustworthy as a POSITIVE signal before `ready`: it can
  // be true only once the candidates query has produced this id.
  if (isLiveSrsCard(data) || isNew) return 'grade'
  return ready ? 'drop' : 'wait'
}

/**
 * Whether to offer the controls that only work on an ENROLLED card —
 * Reschedule and Archive. `archiveSrsCard` returns false for a block with no
 * SRS type (surfacing "Couldn't archive this card"), and the SRS date adapter
 * doesn't claim an unenrolled block, so neither does anything useful for a new
 * card.
 *
 * Shares `decideGrade`'s readiness rule deliberately, rather than restating
 * `!isNew` at the call site: gating grading on `ready` while leaving these
 * controls on the raw flag is precisely the drift that shipped once already —
 * the session gated one and not the other, so a restored session briefly
 * offered both for a new card. One rule, one place.
 */
export const showsEnrolledCardActions = ({isNew, ready}: GradeDecisionInput): boolean =>
  ready && !isNew
