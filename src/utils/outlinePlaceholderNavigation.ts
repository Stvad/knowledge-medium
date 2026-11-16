import type {Block} from '@/data/block'
import {focusBlock} from '@/data/properties'
import {enterEditModeForBlock, scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction'
import {isVisibleElement} from '@/utils/propertyNavigation'

const selector = (scope: string) => `[data-outline-placeholder-scope="${CSS.escape(scope)}"]`
const rowsIn = (scope: string) => [...document.querySelectorAll<HTMLElement>(`${scopeRowSelector(scope)}, ${selector(scope)}`)].filter(isVisibleElement)

/** Only navigation sees drawings; structural selection and editing still use block queries. */
export const focusAdjacentPlaceholder = (blockId: string, scope: string | undefined, direction: -1 | 1): boolean => {
  if (!scope || typeof document === 'undefined') return false
  if (!document.querySelector(selector(scope))) return false
  const rows = rowsIn(scope)
  const index = rows.findIndex(row => scopeRowBlockId(row) === blockId)
  const next = index < 0 ? undefined : rows[index + direction]
  if (!next?.matches(selector(scope))) return false
  focusPlaceholder(next)
  return document.activeElement === next
}

export const focusPlaceholder = (element: HTMLElement, edit = true) => {
  element.dataset.placeholderMode = edit ? 'active' : 'landed'
  element.focus()
}

export const navigatePlaceholder = async (element: HTMLElement | string, scope: string | undefined, direction: number, ui: Block, edit = true) => {
  if (!scope || !document.querySelector(selector(scope))) return false
  const rows = rowsIn(scope)
  const index = rows.findIndex(row => typeof element === 'string' ? scopeRowBlockId(row) === element : row === element)
  const next = index < 0 ? undefined : rows[Math.max(0, Math.min(rows.length - 1, index + direction))]
  if (!next || next === element) return false
  if (next.matches(selector(scope))) focusPlaceholder(next, edit)
  else {
    const id = scopeRowBlockId(next)
    if (id && edit) await enterEditModeForBlock(ui.repo.block(id), ui, scope, {start: direction < 0 ? Number.MAX_SAFE_INTEGER : 0})
    else if (id) { await focusBlock(ui, id, {renderScopeId: scope}); next.focus() }
  }
  return true
}

export const placeholderEscapeTarget = (element: HTMLElement, scope: string | undefined, ownerId: string): string | undefined => {
  if (!scope) return undefined
  const rows = rowsIn(scope)
  const child = rows.slice(0, rows.indexOf(element)).reverse().find(row =>
    row.parentElement?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId === ownerId && scopeRowBlockId(row))
  return child && scopeRowBlockId(child)
}
