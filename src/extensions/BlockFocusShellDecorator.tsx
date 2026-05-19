import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useInEditMode, useInFocus } from '@/data/globalState.ts'
import { isElementProperlyVisible } from '@/utils/dom.ts'
import type {
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.ts'

const FOCUSED_BLOCK_CLASS = '[&>.block-body>div:first-child]:bg-muted/95'

const mergeClassName = (...parts: Array<string | undefined>): string | undefined => {
  const className = parts.filter(Boolean).join(' ')
  return className.length ? className : undefined
}

const isSurfaceActive = (state: BlockShellState): boolean =>
  typeof state.shortcutSurfaceOptions.surfaceActive === 'boolean'
    ? state.shortcutSurfaceOptions.surfaceActive
    : true

export function BlockFocusShellDecorator({
  resolveContext,
  shellRef,
  contentRef,
  state,
  children,
}: BlockShellDecoratorProps) {
  const {block} = resolveContext
  const blockInFocus = useInFocus(block.id)
  const inEditMode = useInEditMode(block.id)
  const active = blockInFocus && isSurfaceActive(state)

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
        active ? FOCUSED_BLOCK_CLASS : undefined,
      ),
    },
    shortcutSurfaceOptions: state.shortcutSurfaceOptions,
  }), [active, state.shellProps, state.shortcutSurfaceOptions])

  return <>{children(nextState)}</>
}
