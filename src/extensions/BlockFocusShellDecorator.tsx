import { useEffect, useLayoutEffect, useMemo } from 'react'
import type { FocusedBlockLocation } from '@/data/properties.js'
import { defineFacet, isFunction } from '@/facets/facet.js'
import { useInEditMode, useInFocus, useIsActivePanel, useUIStateBlock } from '@/data/globalState.js'
import {
  getElementScrollportBounds,
  isElementProperlyVisible,
  type VerticalVisibilityBounds,
} from '@/utils/dom.js'
import type {
  BlockShellDecoratorContribution,
  BlockShellDecoratorProps,
  BlockShellState,
} from '@/extensions/blockInteraction.js'

type FocusViewportPolicy = (panelId: string, location: FocusedBlockLocation) => boolean

/** An implicit focus move may follow the viewport without moving it. */
export const preserveViewportOnFocusFacet = defineFacet<FocusViewportPolicy>({
  id: 'core.preserve-viewport-on-focus',
  validate: isFunction<FocusViewportPolicy>,
})

const isSurfaceActive = (state: BlockShellState): boolean =>
  typeof state.shortcutSurfaceOptions.surfaceActive === 'boolean'
    ? state.shortcutSurfaceOptions.surfaceActive
    : true

const MIN_VISIBLE_FOCUSED_ROW_LINE_COUNT = 1

const isLongFocusedRowMeaningfullyVisible = (
  element: HTMLElement,
  visibilityBounds: VerticalVisibilityBounds,
): boolean => {
  const rect = element.getBoundingClientRect()
  const viewportHeight = Math.max(0, visibilityBounds.bottom - visibilityBounds.top)
  if (viewportHeight <= 0 || rect.height < viewportHeight) return false

  const computedStyle = window.getComputedStyle(element)
  const lineHeight = parseFloat(computedStyle.lineHeight) ||
    parseFloat(computedStyle.fontSize) * 1.2

  const visibleTop = Math.max(visibilityBounds.top, rect.top)
  const visibleBottom = Math.min(visibilityBounds.bottom, rect.bottom)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)
  return visibleHeight >= lineHeight * MIN_VISIBLE_FOCUSED_ROW_LINE_COUNT
}

export const shouldScrollFocusedBlockIntoView = (
  focusedRowElement: HTMLElement | null,
  contentElement: HTMLElement | null,
): contentElement is HTMLElement => {
  if (!contentElement) return false
  const visibilityBounds = getElementScrollportBounds(contentElement)
  if (isElementProperlyVisible(contentElement, visibilityBounds)) return false
  // A focused row can be tall enough that its top content is above the scrollport
  // while the user still has about a line of that same row in view. Descendants
  // do not count here; visible children should not hide an off-screen focus row.
  return focusedRowElement
    ? !isLongFocusedRowMeaningfullyVisible(focusedRowElement, visibilityBounds)
    : true
}

export function BlockFocusShellDecorator({
  resolveContext,
  shellRef,
  contentRef,
  state,
  children,
}: BlockShellDecoratorProps) {
  const {block, uiStateBlock} = resolveContext
  const renderScopeId = resolveContext.blockContext?.renderScopeId
  const blockInFocus = useInFocus(block.id)
  const inEditMode = useInEditMode(block.id)
  // Gate the highlight on "this surface owns keystrokes": when the
  // user crosses panels (j/l in spatial-nav, or a click), only the
  // focused block in the *active* panel gets a highlight.
  // The inactive panel still has its `focusedBlockLocation` set —
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
    const focusedRowElement = element?.parentElement instanceof HTMLElement
      ? element.parentElement
      : element
    if (shouldScrollFocusedBlockIntoView(focusedRowElement, element)) {
      const policies = block.repo.facetRuntime?.read(preserveViewportOnFocusFacet)
      if (renderScopeId && policies?.some(preserve => preserve(uiStateBlock.id, {blockId: block.id, renderScopeId}))) return
      element.scrollIntoView({behavior: 'smooth', block: 'nearest'})
    }
  }, [active, contentRef, block, uiStateBlock, renderScopeId])

  const nextState = useMemo<BlockShellState>(() => ({
    shellProps: {
      ...state.shellProps,
      'data-block-focused': active ? 'true' : undefined,
    },
    shortcutSurfaceOptions: state.shortcutSurfaceOptions,
  }), [active, state.shellProps, state.shortcutSurfaceOptions])

  return <>{children(nextState)}</>
}

export const blockFocusShellDecorator: BlockShellDecoratorContribution = () =>
  BlockFocusShellDecorator
