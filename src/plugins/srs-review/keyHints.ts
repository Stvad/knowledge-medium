import { useMemo } from 'react'
import { toChordArray } from '@/shortcuts/canonicalizeChord.js'
import { useEffectiveActions } from '@/shortcuts/useActionDiscovery.js'
import type { ActionConfig, ActionContextType } from '@/shortcuts/types.js'
import { formatChord } from '@/plugins/keybindings-settings/keyCapture.ts'
import type { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import {
  SRS_DEFAULT_GRADE_SIGNAL,
  SRS_GRADE_ACTION_IDS,
  SRS_REVEAL_ACTION_ID,
} from './actions.ts'

/** Formatted key hint per action id, for the actions of one context. An
 *  action with no effective binding is ABSENT, not an empty string, so a
 *  caller drops the hint rather than rendering an empty one. First chord
 *  only: these sit inline on a button, and the shortcut-help overlay is
 *  the surface that lists every chord. */
export const keyHintsByActionId = (
  actions: readonly ActionConfig[],
  context: ActionContextType,
): ReadonlyMap<string, string> => {
  const hints = new Map<string, string>()
  for (const action of actions) {
    if (action.context !== context) continue
    const [chord] = toChordArray(action.defaultBinding?.keys ?? [])
    if (chord) hints.set(action.id, formatChord(chord))
  }
  return hints
}

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

/** The same map against the live runtime, following the user's remaps. */
export const useActionKeyHints = (context: ActionContextType): ReadonlyMap<string, string> => {
  const actions = useEffectiveActions()
  return useMemo(() => keyHintsByActionId(actions, context), [actions, context])
}
