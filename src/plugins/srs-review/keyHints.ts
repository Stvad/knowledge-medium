import { useEffect, useMemo, useState } from 'react'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { toChordArray } from '@/shortcuts/canonicalizeChord.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { keybindingOverridesFacet } from '@/shortcuts/keybindingOverrides.js'
import type { ActionConfig, ActionContextType } from '@/shortcuts/types.js'
import { formatChord } from '@/plugins/keybindings-settings/keyCapture.ts'

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
