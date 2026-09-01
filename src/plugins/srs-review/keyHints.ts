import { useEffect, useMemo, useState } from 'react'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { toChordArray } from '@/shortcuts/canonicalizeChord.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { keybindingOverridesFacet } from '@/shortcuts/keybindingOverrides.js'
import type { ActionConfig, ActionContextType } from '@/shortcuts/types.js'
import { formatChord } from '@/plugins/keybindings-settings/keyCapture.ts'
import type { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'
import {
  SRS_DEFAULT_GRADE_SIGNAL,
  SRS_GRADE_ACTION_IDS,
  SRS_REVEAL_ACTION_ID,
} from './actions.ts'

/** Formatted key hint per action id, for the actions of one context.
 *
 *  An action with no effective binding — unbound, or its default chord
 *  stripped by another action's override — is ABSENT, not an empty
 *  string: absence is what makes a caller drop the hint rather than
 *  render an empty one.
 *
 *  First chord only. These sit inline on a button, where the full list
 *  ("Space Enter") costs more room than it buys; the shortcut-help
 *  overlay is the surface that shows every chord. */
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

/** The same map against the live runtime. Overrides are pushed in place,
 *  leaving `runtime` identity unchanged, so the facet listener — not the
 *  memo's deps — is what keeps this current after a remap (same reason
 *  `useActionDiscovery` watches that facet).
 *
 *  Not `useActionDiscovery` itself: it also subscribes to the
 *  active-contexts map, re-rendering its consumer on every focus move,
 *  and a hint depends on none of that. */
export const useActionKeyHints = (context: ActionContextType): ReadonlyMap<string, string> => {
  const runtime = useAppRuntime()
  const [generation, setGeneration] = useState(0)
  useEffect(
    () => runtime.onFacetChange(keybindingOverridesFacet.id, () => setGeneration(g => g + 1)),
    [runtime],
  )
  return useMemo(
    () => keyHintsByActionId(getEffectiveActions(runtime), context),
    // `generation` re-resolves after an in-place override change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, context, generation],
  )
}
