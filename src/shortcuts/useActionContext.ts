import { useEffect, useMemo } from 'react'
import { shortcutManager } from './ActionManager.ts';
import { ActionContextType, BaseShortcutDependencies, ActionContextTypes } from './types'
import { useUIStateBlock } from '@/data/globalState.ts'

/**
 * Hook to activate a shortcut context
 * @param context The context to activate
 * @param dependencies Dependencies to pass to the handlers
 * @param enabled Whether the context is enabled (defaults to true)
 */
export function useActionContext(
  context: ActionContextType,
  dependencies: BaseShortcutDependencies | null = null,
  enabled: boolean = true
): void {
  const uiStateBlock = useUIStateBlock()

  const depsWithUiState = useMemo(() => ({
    ...(dependencies ?? {}),
    uiStateBlock,
  }), [dependencies, uiStateBlock])

  useEffect(() => {
    console.log(`[useShortcutContext] Effect running for context: ${context}`, {
      enabled,
      dependencies: depsWithUiState,
    });
    
    if (!enabled) return;
    
    shortcutManager.activateContext(context, depsWithUiState);
    
    return () => {
      console.log(`[useShortcutContext] Cleanup running for context: ${context}`);
      shortcutManager.deactivateContext(context);
    };
  }, [context, depsWithUiState, enabled]);
}

/**
 * Hook for normal mode shortcuts
 */
export function useNormalModeShortcuts(dependencies: any, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.NORMAL_MODE, dependencies, enabled);
}

/**
 * Hook for edit mode shortcuts
 * This will automatically deactivate normal mode shortcuts due to priority
 */
export function useEditModeShortcuts(dependencies: any, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.EDIT_MODE, dependencies, enabled);
}

/**
 * Hook for property editing shortcuts
 */
export function usePropertyEditingShortcuts(dependencies: any = {}, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.PROPERTY_EDITING, dependencies, enabled);
}

/**
 * Hook for command palette shortcuts
 */
export function useCommandPaletteShortcuts(dependencies: any, enabled: boolean = true): void {
  useActionContext(ActionContextTypes.COMMAND_PALETTE, dependencies, enabled);
}
