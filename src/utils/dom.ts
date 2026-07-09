export type VerticalVisibilityBounds = Readonly<{
  top: number
  bottom: number
}>

const windowVisibilityBounds = (): VerticalVisibilityBounds => ({
  top: 0,
  bottom: window.innerHeight || document.documentElement.clientHeight,
})

export const getElementScrollportBounds = (element: HTMLElement): VerticalVisibilityBounds => {
  const windowBounds = windowVisibilityBounds()
  let ancestor = element.parentElement

  while (ancestor) {
    const {overflowY} = window.getComputedStyle(ancestor)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      const rect = ancestor.getBoundingClientRect()
      return {
        top: Math.max(windowBounds.top, rect.top),
        bottom: Math.min(windowBounds.bottom, rect.bottom),
      }
    }
    ancestor = ancestor.parentElement
  }

  return windowBounds
}

export const isElementProperlyVisible = (
  element: HTMLElement,
  visibilityBounds: VerticalVisibilityBounds = windowVisibilityBounds(),
): boolean => {
  const rect = element.getBoundingClientRect()
  const viewportHeight = Math.max(0, visibilityBounds.bottom - visibilityBounds.top)
  if (viewportHeight <= 0) return false

  const elementHeight = rect.height

  // Get computed line height for this element
  const computedStyle = window.getComputedStyle(element)
  const lineHeight = parseFloat(computedStyle.lineHeight) ||
    parseFloat(computedStyle.fontSize) * 1.2 // Fallback to 1.2 * fontSize

  // Use line height as minimum visibility threshold
  const minVisibleHeight = lineHeight

  // Calculate how much of the element is visible vertically
  const visibleTop = Math.max(visibilityBounds.top, rect.top)
  const visibleBottom = Math.min(visibilityBounds.bottom, rect.bottom)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)

  // For small elements (shorter than viewport): require at least one line height to be visible
  if (elementHeight <= viewportHeight) {
    return visibleHeight >= minVisibleHeight
  }

  // For large elements (taller than viewport): check if a reasonable portion is visible
  // and that we're not at an awkward position (like showing just the very top or bottom)
  const heightRatio = visibleHeight / viewportHeight
  const elementVisibilityRatio = visibleHeight / elementHeight

  // For tall elements, we want either:
  // 1. A good chunk of the viewport is filled (at least 60%), OR
  // 2. We're showing a reasonable portion of the element (at least 20%), OR
  // 3. At least a line height is visible (prevents tiny slivers)
  return heightRatio >= 0.6 || elementVisibilityRatio >= 0.2 || visibleHeight >= minVisibleHeight
}

export const isEditorElement = (element: Element | null): boolean => {
  if (!element) return false

  return element instanceof HTMLTextAreaElement || Boolean(element.closest('.cm-editor'))
}

export const shouldExitEditModeAfterBlur = (activeElement: Element | null): boolean =>
  !isEditorElement(activeElement)
