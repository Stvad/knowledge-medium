import { createContext, useContext, useMemo, useState, ReactNode } from 'react'
import type { BlockContextType, RenderVisibilityPolicy } from '@/types.js'
import { EMPTY_RENDER_VISIBILITY_POLICY } from '@/utils/renderVisibility.js'

export type ResolvedBlockContext = BlockContextType & {
  renderVisibilityPolicy: RenderVisibilityPolicy
}

export const BlockContext = createContext<ResolvedBlockContext>({
  renderVisibilityPolicy: EMPTY_RENDER_VISIBILITY_POLICY,
})

export type RenderSurfaceOverrides =
  Omit<Partial<BlockContextType>, 'scopeRootId' | 'renderScopeId' | 'renderVisibilityPolicy'> &
  Required<Pick<BlockContextType, 'scopeRootId' | 'renderScopeId' | 'renderVisibilityPolicy'>>

export type NestedBlockContextOverrides =
  Omit<Partial<BlockContextType>, 'scopeRootId' | 'renderScopeId' | 'renderVisibilityPolicy'>

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
  const normalizedValue: ResolvedBlockContext = {
    ...initialValue,
    renderVisibilityPolicy: initialValue.renderVisibilityPolicy ?? EMPTY_RENDER_VISIBILITY_POLICY,
  }
  const stable = useStableShallow(normalizedValue)
  return (
    <BlockContext value={stable}>
      {children}
    </BlockContext>
  )
}

const MergedBlockContextProvider = (
  {children, overrides}: { children: ReactNode, overrides: Partial<BlockContextType> },
) => {
  const context = useContext(BlockContext)
  // Stabilize overrides via shallow compare so call sites can pass
  // inline `{layoutBoundary: false, ...}` literals without
  // re-rendering every BlockComponent on every parent render.
  const stableOverrides = useStableShallow(overrides)
  const value = useMemo<ResolvedBlockContext>(() => ({
    ...context,
    ...stableOverrides,
    renderVisibilityPolicy:
      stableOverrides.renderVisibilityPolicy ?? context.renderVisibilityPolicy,
  }), [context, stableOverrides])

  return (
    <BlockContext value={value}>
      {children}
    </BlockContext>
  )
}

/** Inherit the current render surface while overriding ordinary block context. */
export const NestedBlockContextProvider = (
  {children, overrides}: {children: ReactNode, overrides: NestedBlockContextOverrides},
) => (
  <MergedBlockContextProvider overrides={overrides}>
    {children}
  </MergedBlockContextProvider>
)

/** Establish a new rendered block surface. The caller must explicitly provide
 *  identity, scope boundary, and the complete visibility policy so occurrence-
 *  local reveal state cannot leak in from the parent surface. */
export const RenderSurfaceProvider = (
  {children, overrides}: {children: ReactNode, overrides: RenderSurfaceOverrides},
) => (
  <MergedBlockContextProvider overrides={overrides}>
    {children}
  </MergedBlockContextProvider>
)

export const useBlockContext = () => {
  const context = useContext(BlockContext)
  if (!context) {
    throw new Error('useBlockContext must be used within a BlockContextProvider')
  }
  return context
}
