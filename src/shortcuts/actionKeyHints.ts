import { useMemo } from 'react'
import { toChordArray } from './canonicalizeChord.js'
import { formatChord } from './formatChord.js'
import type { ActionConfig, ActionContextType } from './types.js'
import { useEffectiveActions } from './useActionDiscovery.js'

/** Compact controls show the first effective chord. */
export const formatActionKeyHint = (
  action: Pick<ActionConfig, 'defaultBinding'> | undefined,
): string | undefined => {
  const [chord] = toChordArray(action?.defaultBinding?.keys ?? [])
  return chord ? formatChord(chord) : undefined
}

export const getActionKeyHint = (
  actions: readonly ActionConfig[],
  context: ActionContextType,
  id: string,
): string | undefined => formatActionKeyHint(actions.find(action =>
  action.context === context && action.id === id && action.defaultBinding,
))

export const keyHintsByActionId = (
  actions: readonly ActionConfig[],
  context: ActionContextType,
): ReadonlyMap<string, string> => {
  const hints = new Map<string, string>()
  for (const action of actions) {
    if (action.context !== context || hints.has(action.id)) continue
    const hint = formatActionKeyHint(action)
    if (hint) hints.set(action.id, hint)
  }
  return hints
}

export const useActionKeyHint = (context: ActionContextType, id: string): string | undefined => {
  const actions = useEffectiveActions()
  return useMemo(() => getActionKeyHint(actions, context, id), [actions, context, id])
}

export const useActionKeyHints = (context: ActionContextType): ReadonlyMap<string, string> => {
  const actions = useEffectiveActions()
  return useMemo(() => keyHintsByActionId(actions, context), [actions, context])
}

export const shortcutTitle = (label: string, hint: string | undefined): string =>
  hint ? `${label} (${hint})` : label
