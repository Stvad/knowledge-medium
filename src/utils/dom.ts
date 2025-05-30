export const isElementProperlyVisible = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect()
  const windowHeight = window.innerHeight || document.documentElement.clientHeight

  const elementHeight = rect.height

  // Get computed line height for this element
  const computedStyle = window.getComputedStyle(element)
  const lineHeight = parseFloat(computedStyle.lineHeight) ||
    parseFloat(computedStyle.fontSize) * 1.2 // Fallback to 1.2 * fontSize

  // Use line height as minimum visibility threshold
  const minVisibleHeight = lineHeight

  // Calculate how much of the element is visible vertically
  const visibleTop = Math.max(0, rect.top)
  const visibleBottom = Math.min(windowHeight, rect.bottom)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)

  // For small elements (shorter than viewport): require at least one line height to be visible
  if (elementHeight <= windowHeight) {
    return visibleHeight >= minVisibleHeight
  }

  // For large elements (taller than viewport): check if a reasonable portion is visible
  // and that we're not at an awkward position (like showing just the very top or bottom)
  const heightRatio = visibleHeight / windowHeight
  const elementVisibilityRatio = visibleHeight / elementHeight

  // For tall elements, we want either:
  // 1. A good chunk of the viewport is filled (at least 60%), OR
  // 2. We're showing a reasonable portion of the element (at least 20%), OR
  // 3. At least a line height is visible (prevents tiny slivers)
  return heightRatio >= 0.6 || elementVisibilityRatio >= 0.2 || visibleHeight >= minVisibleHeight
}
