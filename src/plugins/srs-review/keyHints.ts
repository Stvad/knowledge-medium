import type { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import {
  SRS_DEFAULT_GRADE_SIGNAL,
  SRS_GRADE_ACTION_IDS,
  SRS_REVEAL_ACTION_ID,
} from './actions.ts'

/** The keys shown on one grade button: its own grade action, plus the
 *  reveal chord on the default-grade button — `srs-review.reveal` casts
 *  that grade once the answer is up, so the button would otherwise
 *  under-report what triggers it. Deduped: the settings UI permits binding
 *  both to one chord (warning that the loser is shadowed), and either
 *  winner grades the same, so listing it twice would only look broken. */
export const gradeButtonHint = (
  hints: ReadonlyMap<string, string>,
  signal: SrsSignal,
): string | undefined => {
  const gradeActionId = SRS_GRADE_ACTION_IDS.get(signal)
  const parts = new Set([
    gradeActionId ? hints.get(gradeActionId) : undefined,
    signal === SRS_DEFAULT_GRADE_SIGNAL ? hints.get(SRS_REVEAL_ACTION_ID) : undefined,
  ].filter(Boolean))
  return parts.size > 0 ? [...parts].join(' · ') : undefined
}
