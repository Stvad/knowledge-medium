import { useCallback, useId, useMemo } from 'react'
import type { Ref, FocusEvent, PointerEvent } from 'react'
import type {
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.ts'
import { focusedBlockIdProp, focusedVisualTargetKeyProp } from '@/data/properties'
import { usePropertyValue } from '@/hooks/block'
import { surfaceFromContext } from './surface.ts'

const applyRef = (ref: Ref<HTMLDivElement> | undefined, el: HTMLDivElement | null): void => {
  if (!ref) return
  if (typeof ref === 'function') ref(el)
  else (ref as { current: HTMLDivElement | null }).current = el
}

/**
 * Shell-decorator contract for spatial navigation:
 *   - tag the shell element with data attributes the walker queries.
 *   - mirror the panel-block's focused props into `active` so the
 *     block can render its highlight without going through any
 *     registry.
 *
 * Distinct from the old visual-navigation decorator in two ways:
 *   (1) NO `registerVisualNavigationTarget` — no JS-side registry.
 *       Mounting just sets data attributes; unmounting just removes
 *       them. Re-renders that recreate the DOM element pick up the
 *       attributes again on the new node — there is no stale state
 *       to clear.
 *   (2) Instance identity comes from React `useId()`. Two mount
 *       positions of the same block (e.g. two backlink entries
 *       pulling the same block under different groups) get distinct
 *       instance ids by construction, so the walker can move past
 *       both without looping.
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
  const {block, uiStateBlock} = resolveContext
  const blockContext = resolveContext.blockContext ?? {}

  const surface = surfaceFromContext(blockContext)
  // `instanceId` is stable across re-renders of the same React position
  // and unique across positions, including two backlink entries that
  // resolve to the same data block. The walker uses this as the
  // `data-block-instance` value.
  const instanceId = useId()
  const panelId = typeof blockContext.panelId === 'string' ? blockContext.panelId : undefined

  // Reactive read of which instance the panel block considers focused.
  // Panel ui-state-block === panel block (see getUIStateBlock in
  // src/data/stateBlocks.ts) so this naturally scopes to the panel.
  const [focusedBlockId] = usePropertyValue(uiStateBlock, focusedBlockIdProp)
  const [focusedVisualTargetKey] = usePropertyValue(uiStateBlock, focusedVisualTargetKeyProp)

  const active =
    focusedBlockId === block.id &&
    (focusedVisualTargetKey == null || focusedVisualTargetKey === instanceId)

  const upstreamRef = state.shellProps.ref
  // Callback ref runs synchronously the instant React attaches the
  // element. Switched from useEffect because the parent decorator's
  // effect would observe `shellRef.current === null` for some blocks
  // (notably the panel's top-level block, where the inner Collapsible
  // hadn't committed by the time the decorator's effect ran).
  const wrappedRef = useCallback((el: HTMLDivElement | null) => {
    applyRef(upstreamRef, el)
    if (el) {
      el.dataset.blockInstance = instanceId
      el.dataset.blockSurface = surface
      if (panelId) el.dataset.panelIdHint = panelId
    }
  }, [instanceId, panelId, surface, upstreamRef])

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
    shortcutSurfaceOptions: {
      ...state.shortcutSurfaceOptions,
      surfaceActive: active,
      visualTargetId: instanceId,
    },
  }), [active, instanceId, state.shellProps, state.shortcutSurfaceOptions, wrappedRef])

  return <>{children(nextState)}</>
}
