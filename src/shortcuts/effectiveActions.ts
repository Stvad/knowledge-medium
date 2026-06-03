import {
  actionDecoratorsFacet,
  actionOverridesFacet,
  actionsFacet,
} from '@/extensions/core.js'
import type { FacetRuntime } from '@/extensions/facet.js'
import type {
  ActionConfig,
  ActionDecorator,
  ActionOverride,
} from '@/shortcuts/types.js'
import { applyKeybindingOverrides } from './applyKeybindingOverrides.ts'
import { keybindingOverridesFacet } from './keybindingOverrides.ts'
import { resolve, type ResolutionContext } from './resolve.ts'

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

/**
 * The active action for an id, resolved through the shared precedence core
 * so this (the imperative `runActionById` / `useRunAction` path) and the
 * keyboard path can't diverge. Behaviour change vs the old pure
 * reverse-activation lookup: a `global`-vs-scoped id collision now resolves
 * to `global` (reserved top tier) instead of to whichever was activated
 * most recently. Modal shadowing is NOT applied here — imperative
 * invocation finds an action in any active context (see `resolve`).
 */
export const getActiveActionById = (
  actions: readonly ActionConfig[],
  ctx: ResolutionContext,
  actionId: string,
): ActionConfig | null => resolve(actions, ctx, {kind: 'action', actionId})[0] ?? null
