import type {Block} from '@/data/block'
import {enterEditModeForBlock, scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction'

import {isVisibleElement} from '@/utils/propertyNavigation'

const pendingPropertySelector = (renderScopeId: string) =>
  `[data-pending-property-scope-id="${CSS.escape(renderScopeId)}"]`

const drawnRows = (document: Document, renderScopeId: string) =>
  [...document.querySelectorAll<HTMLElement>(`${scopeRowSelector(renderScopeId)}, ${pendingPropertySelector(renderScopeId)}`)]
    .filter(isVisibleElement)

/** Defence in depth: a detached source has no adjacent drawn row. */
const adjacentRow = (rows: HTMLElement[], index: number, direction: -1 | 1) =>
  index < 0 ? undefined : rows[index + direction]

/** Defence in depth: a global command or incomplete surface may have no pending input. */
export const focusAdjacentPendingProperty = (
  blockId: string,
  renderScopeId: string | undefined,
  direction: -1 | 1,
): boolean => {
  if (!renderScopeId || typeof document === 'undefined') return false
  const rows = drawnRows(document, renderScopeId)
  const current = rows.findIndex(row => scopeRowBlockId(row) === blockId)
  const target = adjacentRow(rows, current, direction)
  if (!target?.matches(pendingPropertySelector(renderScopeId))) return false
  const input = target.querySelector<HTMLInputElement>('input')
  if (!input) return false
  input.focus()
  return document.activeElement === input
}

export const navigatePendingProperty = async (
  surface: HTMLElement,
  renderScopeId: string,
  direction: -1 | 1,
  ui: Block,
): Promise<void> => {
  const rows = drawnRows(surface.ownerDocument, renderScopeId)
  const target = adjacentRow(rows, rows.indexOf(surface), direction)
  if (!target) return
  if (target.matches(pendingPropertySelector(renderScopeId))) {
    target.querySelector<HTMLInputElement>('input')?.focus()
    return
  }
  const blockId = scopeRowBlockId(target)
  if (blockId) await enterEditModeForBlock(ui.repo.block(blockId), ui, renderScopeId, {start: 0})
}
