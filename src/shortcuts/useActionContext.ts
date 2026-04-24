import { useEffect, useMemo } from 'react'
import { actionManager } from './ActionManager.ts'
import {
  ActionContextType,
  ActionContextActivation,
  BaseShortcutDependencies,
  ActionContextTypes,
  PropertyEditingDependencies,
  CommandPaletteDependencies,
  BlockShortcutDependencies,
  CodeMirrorEditModeDependencies,
} from './types'
import { useUIStateBlock } from '@/data/globalState.ts'

/**
 * Hook to activate any number of shortcut contexts described by facet contributions.
 */
export function useActionContextActivations(
  activations: readonly ActionContextActivation[],
): void {
  const uiStateBlock = useUIStateBlock()

  const activeActivations = useMemo(() => activations
    .filter(activation => activation.enabled !== false)
    .map(activation => ({
      context: activation.context,
      dependencies: {
        ...(activation.dependencies ?? {}),
        uiStateBlock,
      } as BaseShortcutDependencies,
    })),
  [activations, uiStateBlock])

  useEffect(() => {
    if (!activeActivations.length) return

    for (const activation of activeActivations) {
      actionManager.activateContext(activation.context, activation.dependencies)
    }

    return () => {
      for (const activation of activeActivations) {
        actionManager.deactivateContext(activation.context)
      }
    }
  }, [activeActivations])
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

/**
 * Hook for command palette shortcuts
 */
export function useCommandPaletteShortcuts(dependencies: Omit<CommandPaletteDependencies, 'uiStateBlock'>, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.COMMAND_PALETTE, dependencies, enabled)
}
