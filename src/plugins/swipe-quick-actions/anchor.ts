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

export const blockSelector = (blockId: string, renderScopeId?: string): string =>
  `[data-block-id="${escapeCssIdent(blockId)}"]` +
  (renderScopeId ? `[data-render-scope-id="${escapeCssIdent(renderScopeId)}"]` : '')

export const findSwipeActionBlockElement = (
  panelRoot: HTMLElement,
  blockId: string,
  renderScopeId?: string,
): HTMLElement | null => {
  const matches = Array.from(
    panelRoot.querySelectorAll<HTMLElement>(blockSelector(blockId, renderScopeId)),
  )
  return matches.find(element => element.classList.contains('tm-block'))
    ?? matches.find(element => element.querySelector('.block-content'))
    ?? matches[0]
    ?? null
}

export const findSwipeActionAnchorElement = (
  panelRoot: HTMLElement,
  blockId: string,
  renderScopeId?: string,
): HTMLElement | null => {
  const blockElement = findSwipeActionBlockElement(panelRoot, blockId, renderScopeId)
  return blockElement?.querySelector<HTMLElement>('.block-content') ?? blockElement
}

export const getSwipeActionAnchorRect = (
  panelRoot: HTMLElement,
  blockId: string,
  renderScopeId?: string,
): AnchorRect | null => {
  const element = findSwipeActionAnchorElement(panelRoot, blockId, renderScopeId)
  if (!element) return null

  const rect = element.getBoundingClientRect()
  return {top: rect.top, height: rect.height}
}
