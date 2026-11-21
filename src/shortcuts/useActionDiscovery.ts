import { useEffect, useMemo, useState } from 'react'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import type { FacetRuntime } from '@/facets/facet.js'
import { useActiveContextsState, type ActiveContextsMap } from './ActiveContexts.js'
import { actionRuntimeKey, getEffectiveActions } from './effectiveActions.js'
import { keybindingOverridesFacet } from './keybindingOverrides.js'
import { contextConfigsByTypeFrom } from './runAction.js'
import type {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  ActiveContextInfo,
  ShortcutBinding,
} from './types.js'

/**
 * The shared "what actions exist, and in which active contexts" discovery both
 * the command palette and the shortcut-help overlay build on. It resolves the
 * effective action list ONCE (transforms + keybinding overrides applied), the
 * active-context configs, and each action's effective binding — the surface
 * both features re-derive on top of, rather than each re-walking the facets.
 *
 * The list is UNFILTERED on purpose: the palette hides its own opener and
 * `isVisible === false` actions, while the help overlay wants every bound
 * action (including the palette opener) shown. Layer those product-specific
 * filters in the consumer, not here.
 *
 * Override-reactive: keybinding overrides are pushed in place via
 * `setRuntimeContributions` (no runtime identity change), so a `useMemo` keyed
 * on `runtime` alone would keep serving stale chords after a mid-session remap.
 * Subscribing to the facet's change listener (the same mechanism
 * `HotkeyReconciler` uses) bumps a generation that re-resolves the actions.
 */
export interface ActionDiscovery {
  readonly runtime: FacetRuntime
  /** Raw active-context state (context type → the handler's dependencies). */
  readonly active: ActiveContextsMap
  /** Every registered context config, keyed by type. */
  readonly contextConfigsByType: Map<ActionContextType, ActionContextConfig>
  /** All effective actions (transforms + overrides applied), UNFILTERED. */
  readonly actions: readonly ActionConfig[]
  /** Active contexts as `{config, dependencies}`, config-resolved and
   *  filtered to registered types. */
  readonly activeContexts: ActiveContextInfo[]
  /** The effective binding(s) for an action — its post-override
   *  `defaultBinding`, or an empty list when it has none. */
  readonly bindingsFor: (action: Pick<ActionConfig, 'context' | 'id'>) => readonly ShortcutBinding[]
}

const NO_BINDINGS: readonly ShortcutBinding[] = []

/**
 * The effective action list, re-resolved when the user remaps a key.
 *
 * Keybinding overrides are pushed in place via `setRuntimeContributions`,
 * which leaves `runtime` identity untouched — so a `useMemo` keyed on
 * `runtime` alone serves stale chords after a mid-session remap. Watching
 * the facet is what closes that.
 *
 * Overrides are the ONLY in-place input that can change this list.
 * `getEffectiveActions` also reads `actionsFacet` and
 * `actionTransformsFacet`: transforms only arrive through extension
 * resolution, which builds a fresh runtime, and while actions ARE
 * contributed in place (theme-toggle, birthday), an added action can't
 * alter another's binding — the collision-strip pass reads the overrides
 * list, never other actions' defaults.
 *
 * Narrower than {@link useActionDiscovery}: no active-contexts
 * subscription, so consumers don't re-render on every focus move.
 */
export function useEffectiveActions(): readonly ActionConfig[] {
  const runtime = useAppRuntime()
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    return runtime.onFacetChange(keybindingOverridesFacet.id, () => {
      setGeneration(g => g + 1)
    })
  }, [runtime])
  return useMemo(
    () => getEffectiveActions(runtime),
    // `generation` re-resolves after an in-place override change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, generation],
  )
}

export function useActionDiscovery(): ActionDiscovery {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()
  const allActions = useEffectiveActions()

  const contextConfigsByType = useMemo(
    () => contextConfigsByTypeFrom(runtime),
    [runtime],
  )

  const {actions, bindingsFor} = useMemo(() => {
    const bindingsByActionId = new Map<string, ShortcutBinding[]>()
    for (const action of allActions) {
      if (!action.defaultBinding) continue
      bindingsByActionId.set(actionRuntimeKey(action), [{
        ...action.defaultBinding,
        action: action.id,
      }])
    }
    const getBindings = (action: Pick<ActionConfig, 'context' | 'id'>): readonly ShortcutBinding[] =>
      bindingsByActionId.get(actionRuntimeKey(action)) ?? NO_BINDINGS
    return {actions: allActions, bindingsFor: getBindings}
  }, [allActions])

  const activeContexts = useMemo<ActiveContextInfo[]>(
    () => Array.from(active.entries()).flatMap(([type, dependencies]) => {
      const config = contextConfigsByType.get(type)
      return config ? [{config, dependencies}] : []
    }),
    [active, contextConfigsByType],
  )

  return {runtime, active, contextConfigsByType, actions, activeContexts, bindingsFor}
}
