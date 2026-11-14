import type {Block} from '@/data/block'
import {enterEditModeForBlock, scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction'

import {isVisibleElement} from '@/utils/propertyNavigation'

export const navigatePendingProperty = async (
  surface: HTMLElement,
  renderScopeId: string,
  direction: -1 | 1,
  ui: Block,
): Promise<void> => {
  const pendingSelector = `[data-pending-property-scope-id="${CSS.escape(renderScopeId)}"]`
  const rows = [...surface.ownerDocument.querySelectorAll<HTMLElement>(`${scopeRowSelector(renderScopeId)}, ${pendingSelector}`)]
    .filter(isVisibleElement)
  if (direction < 0) rows.reverse()
  const position = direction < 0 ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING
  const target = rows.find(row => surface.compareDocumentPosition(row) & position)
  if (!target) return
  if (target.matches(pendingSelector)) {
    target.querySelector<HTMLInputElement>('input')?.focus()
    return
  }
  const blockId = scopeRowBlockId(target)
  if (blockId) await enterEditModeForBlock(ui.repo.block(blockId), ui, renderScopeId, {start: 0})
}
