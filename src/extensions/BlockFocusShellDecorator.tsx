import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useInEditMode, useInFocus, useIsActivePanel, useUIStateBlock } from '@/data/globalState.js'
import { isElementProperlyVisible } from '@/utils/dom.js'
import type {
  BlockShellDecoratorContribution,
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.js'

// `block-keyboard-focused` is a marker for the CSS rule (see index.css)
// that puts `view-transition-name: keyboard-focus` on the inner content
// row. Combined with `withMoveTransition` around the focus prop write,
// this lets the browser match the highlight between the old and new
// focused blocks and slide it instead of cutting.
const FOCUSED_BLOCK_CLASS = 'block-keyboard-focused [&>.block-body>div:first-child]:bg-muted/95'

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
  // Gate the highlight on "this surface owns keystrokes": when the
  // user crosses panels (j/l in spatial-nav, or a click), only the
  // focused block in the *active* panel shows the bg-muted/95
  // class. The inactive panel still has its `focusedBlockId` set —
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
    if (element && !isElementProperlyVisible(element)) {
      // `block: 'nearest'` already gates this to boundary-crossings
      // (in-viewport focus moves are no-ops), so making it smooth costs
      // nothing for j/k stepping within the visible window but makes
      // the catch-up at the edge feel less like a hard jump.
      element.scrollIntoView({behavior: 'smooth', block: 'nearest'})
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

export const blockFocusShellDecorator: BlockShellDecoratorContribution = () =>
  BlockFocusShellDecorator
