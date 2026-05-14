import {
  actionDecoratorsFacet,
  actionOverridesFacet,
  actionsFacet,
} from '@/extensions/core.ts'
import type { FacetRuntime } from '@/extensions/facet.ts'
import type {
  ActionConfig,
  ActionContextType,
  ActionDecorator,
  ActionOverride,
} from '@/shortcuts/types.ts'
import type { ActiveContextsMap } from './ActiveContexts.tsx'

export const actionRuntimeKey = (
  action: Pick<ActionConfig, 'context' | 'id'>,
): string => `${action.context}:${action.id}`

const matchesAction = (
  target: Pick<ActionOverride | ActionDecorator, 'actionId' | 'context'>,
  action: Pick<ActionConfig, 'id' | 'context'>,
): boolean =>
  target.actionId === action.id &&
  (target.context === undefined || target.context === action.context)

export const getEffectiveActions = (runtime: FacetRuntime): readonly ActionConfig[] => {
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
