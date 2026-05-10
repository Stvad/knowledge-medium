export interface AnchorRect {
  top: number
  height: number
}

const escapeCssIdent = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

export const blockSelector = (blockId: string): string =>
  `[data-block-id="${escapeCssIdent(blockId)}"]`

export const findSwipeActionBlockElement = (
  panelRoot: HTMLElement,
  blockId: string,
): HTMLElement | null => {
  const matches = Array.from(panelRoot.querySelectorAll<HTMLElement>(blockSelector(blockId)))
  return matches.find(element => element.classList.contains('tm-block'))
    ?? matches.find(element => element.querySelector('.block-content'))
    ?? matches[0]
    ?? null
}

export const findSwipeActionAnchorElement = (
  panelRoot: HTMLElement,
  blockId: string,
): HTMLElement | null => {
  const blockElement = findSwipeActionBlockElement(panelRoot, blockId)
  return blockElement?.querySelector<HTMLElement>('.block-content') ?? blockElement
}

export const getSwipeActionAnchorRect = (
  panelRoot: HTMLElement,
  blockId: string,
): AnchorRect | null => {
  const element = findSwipeActionAnchorElement(panelRoot, blockId)
  if (!element) return null

  const rect = element.getBoundingClientRect()
  return {top: rect.top, height: rect.height}
}
