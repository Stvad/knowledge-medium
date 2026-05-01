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

export type ActiveContextsMap = ReadonlyMap<ActionContextType, BaseShortcutDependencies>

/**
 * Opaque token returned from `activate`. Pass back to `deactivate` so the
 * provider can release the *specific* claim this caller made — necessary
 * when several components race to register the same context-type.
 */
export type ActivationHandle = symbol

interface ActivationEntry {
  handle: ActivationHandle
  dependencies: BaseShortcutDependencies
}

export interface ActiveContextsDispatch {
  /**
   * Claim a context with validated dependencies. Multiple concurrent claims
   * for the same context-type are tracked as a stack — the most recent claim
   * is what handlers see, so last-mount-wins still holds. Returns a handle;
   * keep it and pass to `deactivate` so the provider releases *this* claim
   * even if newer claims have been pushed on top.
   */
  activate: (
    context: ActionContextType,
    dependencies: BaseShortcutDependencies,
  ) => ActivationHandle
  /**
   * Release the claim identified by `handle`. If the handle is the active
   * one for its context, the previous claim (if any) becomes active again;
   * otherwise the entry is just removed from the stack. No-op for unknown
   * handles, so unmount cleanup after a provider remount stays safe.
   */
  deactivate: (handle: ActivationHandle) => void
}

/**
 * Split into two contexts so that consumers of the *dispatch* (most blocks, via
 * `useActionContextActivations`) don't re-render when the active-contexts map
 * changes. Only the few consumers that need to read the map subscribe to the
 * state context.
 */
const ActiveContextsStateCtx = createContext<ActiveContextsMap | null>(null)
const ActiveContextsDispatchCtx = createContext<ActiveContextsDispatch | null>(null)

const computeTopMap = (
  stacks: ReadonlyMap<ActionContextType, readonly ActivationEntry[]>,
): ActiveContextsMap => {
  const result = new Map<ActionContextType, BaseShortcutDependencies>()
  for (const [context, stack] of stacks) {
    const top = stack[stack.length - 1]
    if (top) result.set(context, top.dependencies)
  }
  return result
}

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

  // Internal: stacks of active claims per context. The visible state
  // (`active`) is the top of each stack — re-derived after every mutation.
  // Tracking by handle (rather than by context-type alone) is what makes
  // overlapping claims safe: when component A unmounts after component B
  // has already pushed a new claim, A's deactivate only removes A's entry
  // from the stack; B's claim is preserved.
  const stacksRef = useRef<Map<ActionContextType, ActivationEntry[]>>(new Map())
  const handleContextRef = useRef<Map<ActivationHandle, ActionContextType>>(new Map())
  const [active, setActive] = useState<ActiveContextsMap>(() => new Map())

  const refreshState = useCallback(() => {
    setActive(computeTopMap(stacksRef.current))
  }, [])

  const activate = useCallback(
    (context: ActionContextType, dependencies: BaseShortcutDependencies): ActivationHandle => {
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

      const handle: ActivationHandle = Symbol(`activation:${context}`)
      const stack = stacksRef.current.get(context) ?? []
      stack.push({handle, dependencies})
      stacksRef.current.set(context, stack)
      handleContextRef.current.set(handle, context)

      refreshState()
      return handle
    },
    [refreshState],
  )

  const deactivate = useCallback((handle: ActivationHandle) => {
    const context = handleContextRef.current.get(handle)
    if (!context) return
    handleContextRef.current.delete(handle)

    const stack = stacksRef.current.get(context)
    if (!stack) return

    const idx = stack.findIndex(entry => entry.handle === handle)
    if (idx === -1) return

    stack.splice(idx, 1)
    if (stack.length === 0) {
      stacksRef.current.delete(context)
    }

    refreshState()
  }, [refreshState])

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
