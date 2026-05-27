import { useCallback, useMemo } from 'react'
import type { Ref, FocusEvent, PointerEvent } from 'react'
import type {
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.js'
import { surfaceFromContext } from './surface.ts'

const applyRef = (ref: Ref<HTMLDivElement> | undefined, el: HTMLDivElement | null): void => {
  if (!ref) return
  if (typeof ref === 'function') ref(el)
  else (ref as { current: HTMLDivElement | null }).current = el
}

/**
 * Shell-decorator contract for spatial navigation:
 *   - tag the shell element with data attributes the walker queries.
 *
 * What this decorator deliberately does NOT do:
 *   - subscribe to per-panel focused props. Reading focused location
 *     via usePropertyValue here would attach
 *     a hook subscription per block in the panel; every focus change
 *     then re-renders every block in the panel. That's the
 *     performance pitfall the user hit with the previous plugin.
 *     `useShortcutSurfaceActivations` already reads focus reactively
 *     via `useInFocus(block.id)` — that hook is per-block by
 *     construction, so it doesn't fan out the way subscribing on the
 *     panel block does.
 *   - own a visual "active" highlight class. Focus is communicated by
 *     the browser's native focus on the shell element (the shell has
 *     tabIndex=0 and we call .focus() on navigation). CSS targets
 *     `:focus-visible` for the highlight.
 *
 * Tagging is done via a callback ref wrapped around the original
 * shellRef. That way the data attributes are set synchronously the
 * moment React attaches the element — independently of useEffect
 * ordering, which broke top-level blocks (the parent decorator's
 * effect saw the ref still null on first commit).
 */
export function SpatialNavigationShellDecorator({
  resolveContext,
  state,
  children,
}: BlockShellDecoratorProps) {
  const blockContext = resolveContext.blockContext ?? {}
  const surface = surfaceFromContext(blockContext)
  const panelId = typeof blockContext.panelId === 'string' ? blockContext.panelId : undefined
  const renderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : undefined

  const upstreamRef = state.shellProps.ref
  // Callback ref runs synchronously the instant React attaches the
  // element. Switched from useEffect because the parent decorator's
  // effect would observe `shellRef.current === null` for some blocks
  // (notably the panel's top-level block, where the inner Collapsible
  // hadn't committed by the time the decorator's effect ran).
  const wrappedRef = useCallback((el: HTMLDivElement | null) => {
    applyRef(upstreamRef, el)
    if (el) {
      el.dataset.blockNavItem = 'true'
      el.dataset.blockSurface = surface
      if (renderScopeId) el.dataset.renderScopeId = renderScopeId
      else delete el.dataset.renderScopeId
      if (panelId) el.dataset.panelIdHint = panelId
      else delete el.dataset.panelIdHint
    }
  }, [panelId, renderScopeId, surface, upstreamRef])

  const nextState = useMemo<BlockShellState>(() => ({
    shellProps: {
      ...state.shellProps,
      ref: wrappedRef,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        state.shellProps.onFocus?.(event)
      },
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        state.shellProps.onPointerDownCapture?.(event)
      },
    },
    shortcutSurfaceOptions: state.shortcutSurfaceOptions,
  }), [state.shellProps, state.shortcutSurfaceOptions, wrappedRef])

  return <>{children(nextState)}</>
}
