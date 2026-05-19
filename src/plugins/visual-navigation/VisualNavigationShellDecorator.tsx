import { useMemo } from 'react'
import type {
  FocusEvent,
  PointerEvent,
} from 'react'
import type {
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.ts'
import {
  useVisualNavigationTarget,
  visualNavigationSurfaceFromContext,
} from './navigation.ts'

export function VisualNavigationShellDecorator({
  resolveContext,
  shellRef,
  contentRef,
  state,
  children,
}: BlockShellDecoratorProps) {
  const {block, uiStateBlock} = resolveContext
  const blockContext = resolveContext.blockContext ?? {}
  const {
    targetId,
    active,
    activate,
  } = useVisualNavigationTarget({
    blockId: block.id,
    uiStateBlock,
    panelId: typeof blockContext.panelId === 'string' ? blockContext.panelId : undefined,
    layoutSessionBlockId: typeof blockContext.layoutSessionBlockId === 'string'
      ? blockContext.layoutSessionBlockId
      : undefined,
    surface: visualNavigationSurfaceFromContext(blockContext),
    elementRef: shellRef,
    anchorElementRef: contentRef,
  })

  const nextState = useMemo<BlockShellState>(() => ({
    shellProps: {
      ...state.shellProps,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        state.shellProps.onFocus?.(event)
        activate()
      },
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        state.shellProps.onPointerDownCapture?.(event)
        activate()
      },
    },
    shortcutSurfaceOptions: {
      ...state.shortcutSurfaceOptions,
      surfaceActive: active,
      visualTargetId: targetId,
    },
  }), [activate, active, state.shellProps, state.shortcutSurfaceOptions, targetId])

  return <>{children(nextState)}</>
}
