import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useLayoutEffect,
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

export interface ActiveContextEntry {
  activationId: string
  dependencies: BaseShortcutDependencies
}

export type ActiveContextsMap = ReadonlyMap<ActionContextType, readonly ActiveContextEntry[]>

export interface ActiveContextsDispatch {
  /**
   * Activate a context with validated dependencies. If the context is already
   * active for this activation id it is replaced and moved to the end of that
   * context's activation list.
   */
  activate: (
    context: ActionContextType,
    dependencies: BaseShortcutDependencies,
    activationId?: string
  ) => void
  /** Deactivate one activation of a context. No-op when inactive. */
  deactivate: (context: ActionContextType, activationId?: string) => void
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
  // We want `activate` to stay reference-stable so consumers via the
  // dispatch context don't re-render when the runtime regenerates, but
  // also to read the *latest* runtime when called. useEffectEvent would
  // fit the bill but cannot cross component boundaries (and we expose
  // activate through context). useLayoutEffect refreshes the ref
  // synchronously after each commit, so by the time any user event /
  // effect calls activate, runtimeRef.current is up to date.
  const runtimeRef = useRef(runtime)
  useLayoutEffect(() => {
    runtimeRef.current = runtime
  }, [runtime])

  const [active, setActive] = useState<ActiveContextsMap>(() => new Map())

  const activate = useCallback(
    (
      context: ActionContextType,
      dependencies: BaseShortcutDependencies,
      activationId = context,
    ) => {
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
        const previousEntries = prev.get(context) ?? []
        const nextEntries = [
          ...previousEntries.filter(entry => entry.activationId !== activationId),
          {activationId, dependencies},
        ]
        const next = new Map(prev)
        // Re-insert the context at the end to keep prior context-level
        // last-active-wins semantics for fallback dispatch and UI ordering.
        next.delete(context)
        next.set(context, nextEntries)
        return next
      })
    },
    [],
  )

  const deactivate = useCallback((context: ActionContextType, activationId = context) => {
    setActive(prev => {
      const previousEntries = prev.get(context)
      if (!previousEntries) return prev

      const nextEntries = previousEntries.filter(entry => entry.activationId !== activationId)
      const next = new Map(prev)
      if (nextEntries.length) {
        next.set(context, nextEntries)
      } else {
        next.delete(context)
      }
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
 * on every activation change — use sparingly (HotkeyReconciler, useRunAction).
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
