import { useMemo } from 'react'
import type { Facet } from '@/facets/facet.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { actionRuntimeKey, getEffectiveActions } from './effectiveActions.js'
import type { ActionConfig, ActionContextType } from './types.js'

/**
 * A UI contribution that references an action by id — the shared shape behind
 * the mobile bottom nav (`mobileBottomNavItemsFacet`) and the mobile keyboard
 * toolbar (`mobileKeyboardToolbarItemsFacet`). The surface reads the resolved
 * action's icon + description for presentation; a contribution that doesn't
 * resolve (or resolves to an icon-less action) is skipped.
 */
export interface ActionRefContribution {
  /** Stable identity — dedup key + React key. Distinct from `actionId`: the same
   *  action can appear under two items, and a duplicate `id` is a double-mount. */
  id: string
  /** The action referenced — dispatched on tap, and read for icon/label. */
  actionId: string
  /** Disambiguates the lookup when an id is registered under multiple contexts
   *  (e.g. `undo` is both GLOBAL and normal-mode). Defaults per surface. */
  context?: ActionContextType
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isActionRefContribution = (value: unknown): value is ActionRefContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || typeof value.context === 'string')

export interface ResolvedActionRef {
  item: ActionRefContribution
  /** The registered action, or undefined when nothing matches the
   *  `actionId` + context (e.g. the contributing plugin is disabled). */
  action: ActionConfig | undefined
}

/**
 * Read an action-ref facet and resolve each item to its registered action (the
 * presentation/dispatch source), defaulting the lookup context. Memoized on the
 * runtime so the effective-action index is rebuilt only when the runtime
 * changes — NOT on every focus/edit transition (the surfaces also subscribe to
 * active-contexts and would otherwise rebuild the whole action pipeline per
 * render). Shared by the mobile bottom nav + keyboard toolbar.
 *
 * Invariant: items should reference STATICALLY-registered actions. The memo keys
 * on `runtime` identity, which does NOT change when an action is added/removed in
 * place via `setRuntimeContributions` (the theme + keybinding-override writers do
 * this) — so an item pointing at such a runtime-added action wouldn't resolve
 * until the next runtime swap. Every current contribution references a static
 * action, so this holds; revisit (subscribe to the actions facet) if that breaks.
 */
export function useActionRefItems(
  facet: Facet<ActionRefContribution, readonly ActionRefContribution[]>,
  defaultContext: ActionContextType,
): ResolvedActionRef[] {
  const runtime = useAppRuntime()
  return useMemo(() => {
    const actionsByKey = new Map(getEffectiveActions(runtime).map(a => [actionRuntimeKey(a), a]))
    return runtime.read(facet).map(item => ({
      item,
      action: actionsByKey.get(
        actionRuntimeKey({id: item.actionId, context: item.context ?? defaultContext}),
      ),
    }))
  }, [runtime, facet, defaultContext])
}
