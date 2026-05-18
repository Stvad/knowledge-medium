import { useEffect, useLayoutEffect, useMemo } from 'react'
import type {
  FocusEvent,
  PointerEvent,
} from 'react'
import { useInEditMode } from '@/data/globalState.ts'
import { isElementProperlyVisible } from '@/utils/dom.ts'
import type {
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.ts'
import {
  useVisualNavigationTarget,
  visualNavigationSurfaceFromContext,
} from './navigation.ts'

const VISUAL_FOCUS_CLASS = '[&>.block-body>div:first-child]:bg-muted/95'

const mergeClassName = (...parts: Array<string | undefined>): string | undefined => {
  const className = parts.filter(Boolean).join(' ')
  return className.length ? className : undefined
}

export function VisualNavigationShellDecorator({
  resolveContext,
  shellRef,
  contentRef,
  state,
  children,
}: BlockShellDecoratorProps) {
  const {block, uiStateBlock} = resolveContext
  const blockContext = resolveContext.blockContext ?? {}
  const inEditMode = useInEditMode(block.id)
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

  useLayoutEffect(() => {
    if (!active || inEditMode) return

    const element = shellRef.current
    if (!element) return

    const activeElement = document.activeElement
    if (activeElement === element || element.contains(activeElement)) return
    if (activeElement && activeElement !== document.body) return

    element.focus({preventScroll: true})
  }, [active, inEditMode, shellRef])

  useEffect(() => {
    if (!active) return
    const element = contentRef.current
    if (element && !isElementProperlyVisible(element)) {
      element.scrollIntoView({behavior: 'instant', block: 'nearest'})
    }
  }, [active, contentRef])

  const nextState = useMemo<BlockShellState>(() => ({
    shellProps: {
      ...state.shellProps,
      className: mergeClassName(
        state.shellProps.className,
        active ? VISUAL_FOCUS_CLASS : undefined,
      ),
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
