import {
  actionDecoratorsFacet,
  actionOverridesFacet,
  actionsFacet,
} from '@/extensions/core.js'
import type { FacetRuntime } from '@/extensions/facet.js'
import type {
  ActionConfig,
  ActionContextType,
  ActionDecorator,
  ActionOverride,
} from '@/shortcuts/types.js'
import type { ActiveContextsMap } from './ActiveContexts.tsx'
import { applyKeybindingOverrides } from './applyKeybindingOverrides.ts'
import { keybindingOverridesFacet } from './keybindingOverrides.ts'

export const actionRuntimeKey = (
  action: Pick<ActionConfig, 'context' | 'id'>,
): string => `${action.context}:${action.id}`

/** Sentinel `actionId` that matches every action. Use sparingly — most
 *  overrides/decorators target a specific id. The keybindings module
 *  ships one wildcard decorator that reads the
 *  `keybindingOverridesFacet` and rewrites whichever actions the user
 *  has remapped; that needs to inspect every action so it can also
 *  strip a default chord that lost a collision to a user override. */
export const WILDCARD_ACTION_ID = '*'

const matchesAction = (
  target: Pick<ActionOverride | ActionDecorator, 'actionId' | 'context'>,
  action: Pick<ActionConfig, 'id' | 'context'>,
): boolean =>
  (target.actionId === WILDCARD_ACTION_ID || target.actionId === action.id) &&
  (target.context === undefined || target.context === action.context)

/** The action list after `actionOverridesFacet` and
 *  `actionDecoratorsFacet` have been applied but before any
 *  keybinding-override rewrites. Used by the settings UI so it can
 *  preview an unsaved `StoredKeybindingOverrides` map without waiting
 *  for the runtime rebuild that happens after the canonical prefs
 *  block subscription fires. */
export const getActionsBeforeKeybindingOverrides = (runtime: FacetRuntime): readonly ActionConfig[] => {
  const overrides = runtime.read(actionOverridesFacet)
  const decorators = runtime.read(actionDecoratorsFacet)
  const out: ActionConfig[] = []

  for (const rawAction of runtime.read(actionsFacet)) {
    let action: ActionConfig | null = rawAction

    for (const override of overrides) {
      if (!action || !matchesAction(override, action)) continue
      action = override.apply(action as never) as ActionConfig | null
    }

    for (const decorator of decorators) {
      if (!action || !matchesAction(decorator, action)) continue
      action = decorator.decorate(action as never) as ActionConfig
    }

    if (action) out.push(action)
  }

  return out
}

export const getEffectiveActions = (runtime: FacetRuntime): readonly ActionConfig[] => {
  // Keybinding overrides run as a final pass — they need cross-action
  // visibility (the "default loses on chord collision" rule reads
  // every other action's effective binding), which the per-action
  // override/decorator pipeline above can't express cleanly.
  return applyKeybindingOverrides(
    getActionsBeforeKeybindingOverrides(runtime),
    runtime.read(keybindingOverridesFacet),
  )
}

export const getActiveActionById = (
  actions: readonly ActionConfig[],
  active: ActiveContextsMap,
  actionId: string,
): ActionConfig | null => {
  const byContext = new Map<ActionContextType, ActionConfig>()
  for (const action of actions) {
    if (action.id === actionId) byContext.set(action.context, action)
  }

  for (const context of Array.from(active.keys()).toReversed()) {
    const action = byContext.get(context)
    if (action) return action
  }

  return null
}
