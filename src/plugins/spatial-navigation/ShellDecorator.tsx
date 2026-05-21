import { useCallback, useId, useMemo, useSyncExternalStore } from 'react'
import type { Ref, FocusEvent, PointerEvent } from 'react'
import type {
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.ts'
import { surfaceFromContext } from './surface.ts'
import {
  getSpatialFocusedInstance,
  subscribeSpatialFocus,
} from './focusStore.ts'

// Matches the kernel `BlockFocusShellDecorator` rule so our highlight
// looks identical to the default focused-block treatment. Reused
// during the debounce window when the persisted prop hasn't moved
// yet but spatial nav has.
const FOCUSED_BLOCK_CLASS = '[&>.block-body>div:first-child]:bg-muted/95'

const mergeClassName = (...parts: Array<string | undefined>): string | undefined => {
  const className = parts.filter(Boolean).join(' ')
  return className.length ? className : undefined
}

const applyRef = (ref: Ref<HTMLDivElement> | undefined, el: HTMLDivElement | null): void => {
  if (!ref) return
  if (typeof ref === 'function') ref(el)
  else (ref as { current: HTMLDivElement | null }).current = el
}

/**
 * Shell-decorator contract for spatial navigation:
 *   - tag the shell element with data attributes the walker queries.
 *   - expose the instance id to the shortcut surface so action
 *     handlers can locate the source DOM element.
 *
 * What this decorator deliberately does NOT do:
 *   - subscribe to per-panel focused props. Reading focusedBlockId /
 *     focusedVisualTargetKey via usePropertyValue here would attach
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
 * Instance identity comes from React `useId()` — stable across
 * re-renders of the same React position, distinct across positions
 * (so two backlink entries that pull the same block under different
 * groups get distinct instance ids and the walker won't loop on them).
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
  const instanceId = useId()
  const panelId = typeof blockContext.panelId === 'string' ? blockContext.panelId : undefined

  const upstreamRef = state.shellProps.ref
  const wrappedRef = useCallback((el: HTMLDivElement | null) => {
    applyRef(upstreamRef, el)
    if (el) {
      el.dataset.blockInstance = instanceId
      el.dataset.blockSurface = surface
      if (panelId) el.dataset.panelIdHint = panelId
    }
  }, [instanceId, panelId, surface, upstreamRef])

  // Snapshot is a single string per render; the selector below returns
  // a boolean. `useSyncExternalStore`'s Object.is bail-out means only
  // the two blocks whose membership flips actually re-render — so the
  // fan-out across a large panel is bounded.
  const focusedInstance = useSyncExternalStore(
    subscribeSpatialFocus,
    getSpatialFocusedInstance,
    getSpatialFocusedInstance,
  )
  const spatiallyFocused = focusedInstance === instanceId

  const nextState = useMemo<BlockShellState>(() => ({
    shellProps: {
      ...state.shellProps,
      ref: wrappedRef,
      className: mergeClassName(
        state.shellProps.className,
        spatiallyFocused ? FOCUSED_BLOCK_CLASS : undefined,
      ),
      onFocus: (event: FocusEvent<HTMLElement>) => {
        state.shellProps.onFocus?.(event)
      },
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        state.shellProps.onPointerDownCapture?.(event)
      },
    },
    shortcutSurfaceOptions: {
      ...state.shortcutSurfaceOptions,
      visualTargetId: instanceId,
    },
  }), [instanceId, spatiallyFocused, state.shellProps, state.shortcutSurfaceOptions, wrappedRef])

  return <>{children(nextState)}</>
}
