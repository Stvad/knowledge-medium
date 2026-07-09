import { createContext, useContext, useMemo, useState, ReactNode } from 'react'
import { BlockContextType } from '@/types.js'

export const BlockContext = createContext<BlockContextType>({})

const EMPTY_VISIBILITY_IDS: readonly string[] = Object.freeze([])

const withNestedSurfaceVisibilityBoundary = (
  overrides: Partial<BlockContextType>,
): Partial<BlockContextType> => {
  if (!overrides.isNestedSurface) return overrides
  return {
    // Render visibility policy is scoped to a rendered surface occurrence.
    // A backlink/SRS reveal path must not leak into an embedded/ref/breadcrumb
    // surface that happens to be mounted inside it.
    forceOpenBlockIds: EMPTY_VISIBILITY_IDS,
    forceClosedBlockIds: EMPTY_VISIBILITY_IDS,
    ...overrides,
  }
}

const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  if (Object.is(a, b)) return true
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is(a[k], b[k])) return false
  }
  return true
}

/** Shallow-equal stabilizer: return the previous reference whenever
 *  every own key in `next` is `Object.is`-equal to the corresponding
 *  key in the previous value. Callers can then pass inline object
 *  literals without forcing every downstream consumer of the context
 *  to re-render. Context propagation goes by identity — even with
 *  React Compiler auto-memoizing JSX inputs and `React.memo`
 *  gating props, a new context value reaches every consumer.
 *
 *  Implemented via "adjusting state during render" (see React docs):
 *  when `next` diverges from the stored reference, schedule an update
 *  and return the new value for this render, so consumers see the
 *  fresh values without a one-frame delay. */
const useStableShallow = <T extends Record<string, unknown>>(next: T): T => {
  const [stable, setStable] = useState<T>(next)
  if (stable !== next && !shallowEqual(stable, next)) {
    setStable(next)
    return next
  }
  return stable
}

export const BlockContextProvider = ({ children, initialValue}: { children: ReactNode, initialValue: BlockContextType }) => {
  const stable = useStableShallow(initialValue)
  return (
    <BlockContext value={stable}>
      {children}
    </BlockContext>
  )
}

export const NestedBlockContextProvider = (
  {children, overrides}: { children: ReactNode, overrides: Partial<BlockContextType> },
) => {
  const context = useContext(BlockContext)
  const normalizedOverrides = withNestedSurfaceVisibilityBoundary(overrides)
  // Stabilize overrides via shallow compare so call sites can pass
  // inline `{layoutBoundary: false, ...}` literals without
  // re-rendering every BlockComponent on every parent render.
  const stableOverrides = useStableShallow(normalizedOverrides)
  const value = useMemo(() =>
    ({...context, ...stableOverrides}), [context, stableOverrides])

  return (
    <BlockContext value={value}>
      {children}
    </BlockContext>
  )
}

export const useBlockContext = () => {
  const context = useContext(BlockContext)
  if (!context) {
    throw new Error('useBlockContext must be used within a BlockContextProvider')
  }
  return context
}
