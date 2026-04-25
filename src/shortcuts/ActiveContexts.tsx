import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { actionContextsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import {
  ActionContextType,
  BaseShortcutDependencies,
} from '@/shortcuts/types.ts'

export type ActiveContextsMap = ReadonlyMap<ActionContextType, BaseShortcutDependencies>

export interface ActiveContextsDispatch {
  /**
   * Activate a context with validated dependencies. If the context is already
   * active it is moved to the end of the activation order (matching prior
   * singleton semantics).
   */
  activate: (context: ActionContextType, dependencies: BaseShortcutDependencies) => void
  /** Deactivate a context. No-op when inactive. */
  deactivate: (context: ActionContextType) => void
}

/**
 * Split into two contexts so that consumers of the *dispatch* (most blocks, via
 * `useActionContextActivations`) don't re-render when the active-contexts map
 * changes. Only the few consumers that need to read the map subscribe to the
 * state context.
 */
const ActiveContextsStateCtx = createContext<ActiveContextsMap | null>(null)
const ActiveContextsDispatchCtx = createContext<ActiveContextsDispatch | null>(null)

export function ActiveContextsProvider({children}: PropsWithChildren) {
  const runtime = useAppRuntime()
  // Ref so the stable activate() callback can read the latest context configs
  // without being re-created (and thereby invalidating every consuming effect)
  // when the runtime regenerates.
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime

  const [active, setActive] = useState<ActiveContextsMap>(() => new Map())

  const activate = useCallback(
    (context: ActionContextType, dependencies: BaseShortcutDependencies) => {
      const configs = runtimeRef.current.read(actionContextsFacet)
      const config = configs.find(c => c.type === context)
      if (!config) {
        throw new Error(`[ActiveContexts] Attempted to activate unregistered context: ${context}`)
      }
      if (!config.validateDependencies(dependencies)) {
        throw new Error(
          `[ActiveContexts] Invalid dependencies provided for context ${context}. Activation failed.`,
        )
      }

      setActive(prev => {
        const next = new Map(prev)
        // Re-insert at end to keep activation order deterministic for
        // command-palette display and last-active-wins semantics.
        next.delete(context)
        next.set(context, dependencies)
        return next
      })
    },
    [],
  )

  const deactivate = useCallback((context: ActionContextType) => {
    setActive(prev => {
      if (!prev.has(context)) return prev
      const next = new Map(prev)
      next.delete(context)
      return next
    })
  }, [])

  // `dispatch` is stable across renders so consumers that only need
  // activate/deactivate do not re-render on activation changes.
  const dispatch = useMemo<ActiveContextsDispatch>(
    () => ({activate, deactivate}),
    [activate, deactivate],
  )

  return (
    <ActiveContextsDispatchCtx.Provider value={dispatch}>
      <ActiveContextsStateCtx.Provider value={active}>
        {children}
      </ActiveContextsStateCtx.Provider>
    </ActiveContextsDispatchCtx.Provider>
  )
}

/**
 * Read the map of currently-active contexts. Consumers of this hook re-render
 * on every activation change — use sparingly (HotkeyReconciler,
 * useAvailableActions, useRunAction).
 */
export function useActiveContextsState(): ActiveContextsMap {
  const state = useContext(ActiveContextsStateCtx)
  if (state === null) {
    throw new Error('useActiveContextsState must be used within an ActiveContextsProvider')
  }
  return state
}

/**
 * Access the stable {activate, deactivate} callbacks. Consumers of this hook
 * do NOT re-render on activation changes, which is the common case for block
 * components that only register/unregister their shortcut surfaces.
 */
export function useActiveContextsDispatch(): ActiveContextsDispatch {
  const dispatch = useContext(ActiveContextsDispatchCtx)
  if (!dispatch) {
    throw new Error('useActiveContextsDispatch must be used within an ActiveContextsProvider')
  }
  return dispatch
}
