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
import { useIsBackgroundSubtree } from '@/context/backgroundSubtree.js'

interface ResolvedActivation {
  context: ActionContextType
  dependencies: BaseShortcutDependencies
}

/**
 * Stable identity so a suspended subtree's effect stops re-running as its
 * caller's `activations` array churns. Purely an effect-churn saving with no
 * observable behaviour riding on it — the effect early-returns on an empty
 * list and registers no cleanup either way — so no test pins it.
 */
const NO_ACTIVATIONS: readonly ResolvedActivation[] = []

/**
 * Hook to activate any number of shortcut contexts described by facet contributions.
 *
 * Registers through `claim`/`release` rather than `activate`/`deactivate`
 * (ActiveContexts.tsx) because this is the funnel EVERY declarative surface
 * lands in, and several surfaces routinely want the same context type at once
 * — two panels each holding a multi-select, a parent and a descendant inside
 * one video-player scope, several kept-alive layout sessions. A by-type
 * release would let whichever of them tears down first delete a sibling's
 * live registration, and nothing would re-register it (the survivor's effect
 * deps never moved), leaving the context owned by nobody.
 *
 * This is the single funnel for DECLARATIVE activation — `useActionContext`
 * and its per-context wrappers below, `useShortcutSurfaceActivations` (and
 * so every block surface, including `BlockEditor`'s EDIT_MODE_CM),
 * `PanelRenderer`, `TopLevelRenderer`, `CommandPalette` and `ReviewSession`
 * all land here — so it is also where {@link useIsBackgroundSubtree}
 * is honoured: a suspended subtree resolves to NO activations, which makes
 * the register/deregister effect below deactivate everything the subtree
 * owns and re-register it when suspension lifts. See
 * `backgroundSubtree.tsx` for why that is a separate context rather
 * than a `blockContext` flag, and for the one-commit constraint the by-type
 * `deactivate` imposes on a handover between two mounted subtrees.
 */
export function useActionContextActivations(
  activations: readonly ActionContextActivation[],
): void {
  const uiStateBlock = useUIStateBlock()
  const suspended = useIsBackgroundSubtree()
  // Subscribe to the STABLE dispatch context — this hook is called by every
  // block that registers shortcut surfaces, so re-rendering them all on every
  // activation change would be a fan-out nightmare.
  const {claim, release} = useActiveContextsDispatch()

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

    const tokens = activeActivations.map(activation =>
      claim(activation.context, activation.dependencies),
    )

    return () => {
      for (const token of tokens) release(token)
    }
  }, [activeActivations, claim, release])
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

/** The context carries no actions, so it needs nothing beyond what
 *  `useActionContext` supplies itself. Hoisted for a stable identity. */
const NO_DEPS = {}

/**
 * Shadow the surface underneath a modal, for as long as `open`.
 *
 * ONE owner because there are two kinds of caller and only one of them is
 * obvious. `DialogHost` covers everything opened through `openDialog`; a
 * component that renders `Dialog` itself — because what puts it on screen is
 * not a call but a piece of state — covers nothing until it says so here, and
 * a modal that forgets looks completely correct: Radix makes the app
 * pointer-inert and traps focus, so only the KEYBOARD leaks, and it leaks into
 * whatever context was active when the modal appeared. An editor is usually
 * what that is, and its Enter binding both writes a block and swallows the key
 * the dialog's own button was waiting for.
 *
 * Today the second kind has one caller here and three that have not been
 * audited (km-qdc2): quick-find, find-replace and the shortcut-help overlay are
 * all toggle-driven app mounts rendering `Dialog` directly.
 *
 * Costs a suspend: the funnel below resolves the workspace's UI-state block
 * even for a context that carries no dependencies (km-bli8). A caller that must
 * keep working when that read fails needs its own boundary — see
 * `MigrationGate`.
 *
 * Claim/release is per REGISTRATION (see `useActionContextActivations`), so two
 * modals at once is the ordinary case and neither tears down the other's.
 */
export function useModalShadowing(open: boolean): void {
  useActionContext(ActionContextTypes.DIALOG, NO_DEPS, open)
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
