import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useInEditMode, useInFocus, useIsActivePanel, useUIStateBlock } from '@/data/globalState.js'
import { isElementProperlyVisible } from '@/utils/dom.js'
import type {
  BlockShellDecoratorContribution,
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.js'

const FOCUSED_BLOCK_CLASS = '[&>.block-body>div:first-child]:bg-accent/40'

const mergeClassName = (...parts: Array<string | undefined>): string | undefined => {
  const className = parts.filter(Boolean).join(' ')
  return className.length ? className : undefined
}

const isSurfaceActive = (state: BlockShellState): boolean =>
  typeof state.shortcutSurfaceOptions.surfaceActive === 'boolean'
    ? state.shortcutSurfaceOptions.surfaceActive
    : true

const MIN_VISIBLE_LONG_SHELL_LINE_COUNT = 1

const isLongShellMeaningfullyVisible = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  if (viewportHeight <= 0 || rect.height < viewportHeight) return false

  const computedStyle = window.getComputedStyle(element)
  const lineHeight = parseFloat(computedStyle.lineHeight) ||
    parseFloat(computedStyle.fontSize) * 1.2

  const visibleTop = Math.max(0, rect.top)
  const visibleBottom = Math.min(viewportHeight, rect.bottom)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)
  return visibleHeight >= lineHeight * MIN_VISIBLE_LONG_SHELL_LINE_COUNT
}

export const shouldScrollFocusedBlockIntoView = (
  shellElement: HTMLElement | null,
  contentElement: HTMLElement | null,
): contentElement is HTMLElement => {
  if (!contentElement) return false
  if (isElementProperlyVisible(contentElement)) return false
  // A long block can already fill the viewport while its top content row is
  // above it; focusing that block should not yank the viewport back to the top
  // while the user still has about a line of that block in view.
  return shellElement ? !isLongShellMeaningfullyVisible(shellElement) : true
}

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
  // Gate the highlight on "this surface owns keystrokes": when the
  // user crosses panels (j/l in spatial-nav, or a click), only the
  // focused block in the *active* panel shows the bg-accent/40
  // class. The inactive panel still has its `focusedBlockLocation` set —
  // which we need so the highlight reappears when the user comes
  // back via h/k/j/l — but suppressing the visual until then makes
  // "where am I right now" unambiguous, and reading the per-panel
  // marker on return ("here's where you left off") becomes the
  // visual orientation cue. Non-panel surfaces (no layoutSession in
  // context) trivially return true from useIsActivePanel.
  const panelBlock = useUIStateBlock()
  const panelActive = useIsActivePanel(panelBlock)
  const active = blockInFocus && isSurfaceActive(state) && panelActive

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
    if (shouldScrollFocusedBlockIntoView(shellRef.current, element)) {
      // Once the block is genuinely off-screen, keep the existing
      // top-content-row alignment and smooth catch-up at the viewport edge.
      element.scrollIntoView({behavior: 'smooth', block: 'nearest'})
    }
  }, [active, contentRef, shellRef])

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

export const blockFocusShellDecorator: BlockShellDecoratorContribution = () =>
  BlockFocusShellDecorator
