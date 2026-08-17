import { useEffect, useMemo } from 'react'
import { useActiveContextsDispatch } from '@/shortcuts/ActiveContexts.js'
import {
  ActionContextType,
  ActionContextActivation,
  BaseShortcutDependencies,
  ActionContextTypes,
  PropertyEditingDependencies,
  BlockShortcutDependencies,
  CodeMirrorEditModeDependencies,
} from './types'
import { useUIStateBlock } from '@/data/globalState.js'
import { useShortcutSurfacesSuspended } from '@/shortcuts/ShortcutSurfaceSuspension.js'

interface ResolvedActivation {
  context: ActionContextType
  dependencies: BaseShortcutDependencies
}

/** Stable identity, so a suspended subtree's effect doesn't re-run per render. */
const NO_ACTIVATIONS: readonly ResolvedActivation[] = []

/**
 * Hook to activate any number of shortcut contexts described by facet contributions.
 *
 * This is the single funnel for DECLARATIVE activation — `useActionContext`
 * and its per-context wrappers below, `useShortcutSurfaceActivations`, and
 * `ReviewSession` all land here — so it is also where
 * {@link useShortcutSurfacesSuspended} is honoured: a suspended subtree
 * resolves to NO activations, which makes the register/deregister effect
 * below deactivate everything the subtree owns and re-register it when
 * suspension lifts. See `ShortcutSurfaceSuspension.tsx` for why that is a
 * separate context rather than a `blockContext` flag.
 */
export function useActionContextActivations(
  activations: readonly ActionContextActivation[],
): void {
  const uiStateBlock = useUIStateBlock()
  const suspended = useShortcutSurfacesSuspended()
  // Subscribe to the STABLE dispatch context — this hook is called by every
  // block that registers shortcut surfaces, so re-rendering them all on every
  // activation change would be a fan-out nightmare.
  const {activate, deactivate} = useActiveContextsDispatch()

  const activeActivations = useMemo(() => suspended ? NO_ACTIVATIONS : activations
    .filter(activation => activation.enabled !== false)
    .map(activation => ({
      context: activation.context,
      dependencies: {
        ...(activation.dependencies ?? {}),
        uiStateBlock,
      } as BaseShortcutDependencies,
    })),
  [activations, uiStateBlock, suspended])

  useEffect(() => {
    if (!activeActivations.length) return

    for (const activation of activeActivations) {
      activate(activation.context, activation.dependencies)
    }

    return () => {
      for (const activation of activeActivations) {
        deactivate(activation.context)
      }
    }
  }, [activeActivations, activate, deactivate])
}

/**
 * Hook to activate a shortcut context
 * @param context The context to activate
 * @param dependencies Dependencies to pass to the handlers
 * @param enabled Whether the context is enabled (defaults to true)
 */
export function useActionContext(
  context: ActionContextType,
  dependencies: Omit<BaseShortcutDependencies, 'uiStateBlock'> | null = null,
  enabled: boolean = true,
): void {
  const activations = useMemo<readonly ActionContextActivation[]>(() => [{
    context,
    dependencies: dependencies as Record<string, unknown> | null,
    enabled,
  }], [context, dependencies, enabled])

  useActionContextActivations(activations)
}

/**
 * Hook for normal mode shortcuts
 */
export function useNormalModeShortcuts(dependencies: Omit<BlockShortcutDependencies, 'uiStateBlock'>, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.NORMAL_MODE, dependencies, enabled)
}

/**
 * Hook for CodeMirror edit mode shortcuts
 */
export function useCodeMirrorEditModeShortcuts<T extends boolean>(
  dependencies: T extends true
    ? Omit<CodeMirrorEditModeDependencies, 'uiStateBlock'>
    : Partial<CodeMirrorEditModeDependencies>,
  enabled: T
): void {
  useActionContext(ActionContextTypes.EDIT_MODE_CM, dependencies, enabled)
}

/**
 * Hook for property editing shortcuts
 */
export function usePropertyEditingShortcuts(dependencies: Omit<PropertyEditingDependencies, 'uiStateBlock'>, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.PROPERTY_EDITING, dependencies, enabled)
}
