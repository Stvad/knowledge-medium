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
import { actionContextsFacet } from '@/extensions/core.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {
  ActionContextTypes,
  ActionContextType,
  BaseShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'

export type ActiveContextsMap = ReadonlyMap<ActionContextType, BaseShortcutDependencies>

/**
 * Opaque receipt for ONE claim on a context, returned by
 * {@link ActiveContextsDispatch.claim} and handed back to `release`. Identity
 * — not the context type — is what a release matches on, so a surface can
 * only ever retract its OWN claim. The `context` field is carried so `release`
 * needs no side table; treat it as bookkeeping, not API.
 */
export interface ActivationToken {
  readonly context: ActionContextType
}

/** One claim on a context. `seq` is the global activation counter at the
 *  moment the claim was last (re-)made — see `visibleContexts`. */
interface ActivationEntry {
  readonly token: ActivationToken
  readonly seq: number
  readonly dependencies: BaseShortcutDependencies
}

interface ActivationState {
  /** Monotonic activation counter; also the seq of the most recent claim. */
  readonly seq: number
  /** Per context type, the claims currently held, oldest first. */
  readonly stacks: ReadonlyMap<ActionContextType, readonly ActivationEntry[]>
}

const EMPTY_ACTIVATION_STATE: ActivationState = {seq: 0, stacks: new Map()}

/**
 * Project the claim stacks down to the one-entry-per-type map the rest of the
 * shortcut system reads: the newest claim wins (last-activated-wins, exactly
 * as when this was a flat map), and a type disappears only once its LAST
 * claim is released.
 *
 * Key order is load-bearing, which is why entries carry `seq`:
 * `computeInstallableContexts` takes the last modal in iteration order and
 * `compareContexts` breaks priority ties by activation recency
 * (resolve.ts:69-78, 104-118). Iterating `stacks` directly would order types
 * by their FIRST claim; sorting by `seq` reproduces the "re-inserted at the
 * end on every activation" order the flat map had — and when a newer claim is
 * released, the resurfaced older claim correctly reclaims its OWN place in
 * that order rather than jumping to the end.
 */
const visibleContexts = ({stacks}: ActivationState): ActiveContextsMap => {
  const tops: [ActionContextType, ActivationEntry][] = []
  for (const [context, stack] of stacks) {
    const top = stack.at(-1)
    if (top) tops.push([context, top])
  }
  tops.sort(([, a], [, b]) => a.seq - b.seq)
  return new Map(tops.map(([context, entry]) => [context, entry.dependencies]))
}

/** The live CodeMirror editor view from the active EDIT_MODE_CM context, or
 *  undefined when nothing is in edit mode. Centralizes the EDIT_MODE_CM-deps
 *  cast shared by the command palette and the mobile keyboard toolbar (the map
 *  values are the generic `BaseShortcutDependencies`, so each reader otherwise
 *  hand-rolls the same narrowing). */
export const editorViewFromActiveContexts = (
  contexts: ActiveContextsMap,
): CodeMirrorEditModeDependencies['editorView'] | undefined =>
  (contexts.get(ActionContextTypes.EDIT_MODE_CM) as CodeMirrorEditModeDependencies | undefined)?.editorView

export interface ActiveContextsDispatch {
  /**
   * Activate a context with validated dependencies, IMPERATIVELY — the
   * "enter a mode" path an action handler takes (date-scrub's hold, a
   * leader chord's modal context). One claim per context type per provider:
   * calling it again just refreshes that claim and moves it to the end of
   * the activation order, and `deactivate` retracts it. Components must NOT
   * use this to register a surface — `claim`/`release` (via
   * `useActionContextActivations`) is that path, and it is the one that
   * survives a sibling releasing the same type.
   */
  activate: (context: ActionContextType, dependencies: BaseShortcutDependencies) => void
  /** Retract the imperative claim `activate` made on this context. No-op when
   *  there is none. Deliberately does NOT touch claims made via `claim`. */
  deactivate: (context: ActionContextType) => void
  /**
   * Register ONE claim on a context and get a receipt back. Concurrent claims
   * on the same type stack up — the newest is what handlers see — so several
   * surfaces can legitimately want the same context at once (two panels each
   * holding a multi-select, a parent and a descendant inside one video-player
   * scope, several kept-alive layout sessions) without their teardowns
   * clobbering each other.
   */
  claim: (context: ActionContextType, dependencies: BaseShortcutDependencies) => ActivationToken
  /** Retract exactly the claim `token` identifies. If it was the visible one,
   *  the next-newest claim on that type takes over; if it was underneath, the
   *  visible entry is untouched. Unknown/already-released tokens are a no-op,
   *  so a cleanup that outlives a provider remount stays safe. */
  release: (token: ActivationToken) => void
}

/**
 * Split into two contexts so that consumers of the *dispatch* (most blocks, via
 * `useActionContextActivations`) don't re-render when the active-contexts map
 * changes. Only the few consumers that need to read the map subscribe to the
 * state context.
 */
const ActiveContextsStateCtx = createContext<ActiveContextsMap | null>(null)
const ActiveContextsDispatchCtx = createContext<ActiveContextsDispatch | null>(null)

const shallowEqualDependencies = (
  a: BaseShortcutDependencies | undefined,
  b: BaseShortcutDependencies,
): boolean => {
  if (!a) return false
  if (Object.is(a, b)) return true
  const aRecord = a as unknown as Record<string, unknown>
  const bRecord = b as unknown as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.is(aRecord[key], bRecord[key])) return false
  }
  return true
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

  // ALL claim state lives in `useState` and is only ever moved through
  // FUNCTIONAL updaters — deliberately not the "mutate a stacksRef, then push
  // an eagerly-computed snapshot through setState" shape the reverted attempt
  // used (a7483fa), whose stale-window docs/activeContexts-ownership-bug.md
  // flagged as untraced. Two properties follow that the ref shape doesn't
  // give you: claims batched into one commit compose, instead of racing on a
  // snapshot taken at call time; and every updater below is a pure function
  // of `prev` (`seq: prev.seq + 1`, fresh Maps, nothing outside mutated), so
  // React re-invoking one — which StrictMode does — cannot double-count.
  const [state, setState] = useState<ActivationState>(EMPTY_ACTIVATION_STATE)
  const active = useMemo(() => visibleContexts(state), [state])

  // The imperative `activate`/`deactivate` pair is a singleton claim per
  // context type, so it needs a stable token per type rather than a fresh one
  // per call — otherwise a handler that re-enters a mode without exiting it
  // would pile up claims nothing ever releases.
  const imperativeTokens = useRef(new Map<ActionContextType, ActivationToken>())

  const validate = useCallback(
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
    },
    [],
  )

  /** Push (or refresh) `token`'s claim on `context` and make it the newest. */
  const applyClaim = useCallback(
    (token: ActivationToken, dependencies: BaseShortcutDependencies) => {
      setState(prev => {
        const stack = prev.stacks.get(token.context) ?? []
        const index = stack.findIndex(entry => entry.token === token)
        const existing = index === -1 ? undefined : stack[index]
        // Same short-circuit the flat map had ("already last, same deps →
        // don't churn state"), re-expressed against the stack: the claim must
        // be top of its own stack AND the most recent activation overall.
        if (
          existing !== undefined && index === stack.length - 1 && existing.seq === prev.seq &&
          shallowEqualDependencies(existing.dependencies, dependencies)
        ) return prev

        const seq = prev.seq + 1
        const stacks = new Map(prev.stacks)
        stacks.set(token.context, [
          ...stack.filter(entry => entry.token !== token),
          {token, seq, dependencies},
        ])
        return {seq, stacks}
      })
    },
    [],
  )

  const releaseToken = useCallback((token: ActivationToken) => {
    setState(prev => {
      const stack = prev.stacks.get(token.context)
      if (!stack?.some(entry => entry.token === token)) return prev
      const remaining = stack.filter(entry => entry.token !== token)
      const stacks = new Map(prev.stacks)
      if (remaining.length) stacks.set(token.context, remaining)
      else stacks.delete(token.context)
      return {seq: prev.seq, stacks}
    })
  }, [])

  const claim = useCallback(
    (context: ActionContextType, dependencies: BaseShortcutDependencies): ActivationToken => {
      validate(context, dependencies)
      const token: ActivationToken = {context}
      applyClaim(token, dependencies)
      return token
    },
    [validate, applyClaim],
  )

  const activate = useCallback(
    (context: ActionContextType, dependencies: BaseShortcutDependencies) => {
      validate(context, dependencies)
      const existing = imperativeTokens.current.get(context)
      const token = existing ?? {context}
      if (!existing) imperativeTokens.current.set(context, token)
      applyClaim(token, dependencies)
    },
    [validate, applyClaim],
  )

  const deactivate = useCallback((context: ActionContextType) => {
    const token = imperativeTokens.current.get(context)
    if (token) releaseToken(token)
  }, [releaseToken])

  // `dispatch` is stable across renders so consumers that only need
  // activate/deactivate/claim/release do not re-render on activation changes.
  const dispatch = useMemo<ActiveContextsDispatch>(
    () => ({activate, deactivate, claim, release: releaseToken}),
    [activate, deactivate, claim, releaseToken],
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
