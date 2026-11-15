import type {Block} from '@/data/block'
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
  next.focus()
  return document.activeElement === next
}

export const navigatePlaceholder = async (element: HTMLElement, scope: string | undefined, direction: -1 | 1, ui: Block) => {
  if (!scope) return
  const rows = rowsIn(scope)
  const index = rows.indexOf(element)
  const next = index < 0 ? undefined : rows[index + direction]
  if (!next) return
  if (next.matches(selector(scope))) next.focus()
  else {
    const id = scopeRowBlockId(next)
    if (id) await enterEditModeForBlock(ui.repo.block(id), ui, scope, {start: direction === -1 ? Number.MAX_SAFE_INTEGER : 0})
  }
}

export const fieldPlaceholder = (fieldId: string, scope: string | undefined): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[data-property-placeholder]')].find(element =>
    element.dataset.propertyPlaceholder === fieldId && element.dataset.outlinePlaceholderScope === scope && isVisibleElement(element))

/** An explicit pick waits for its new row to render; ordinary block focus never does this. */
export const focusPickedPlaceholder = (fieldId: string, scope: string | undefined, stillCurrent: () => boolean) => {
  const focus = () => {
    if (!stillCurrent()) return true
    const target = fieldPlaceholder(fieldId, scope)
    target?.focus()
    return !!target
  }
  if (focus()) return
  const observer = new MutationObserver(() => { if (focus()) observer.disconnect() })
  observer.observe(document.body, {childList: true, subtree: true, attributes: true})
}

export const placeholderEscapeTarget = (element: HTMLElement, scope: string | undefined, ownerId: string): string | undefined => {
  if (!scope) return undefined
  const rows = rowsIn(scope)
  const child = rows.slice(0, rows.indexOf(element)).reverse().find(row =>
    row.parentElement?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId === ownerId && scopeRowBlockId(row))
  return child && scopeRowBlockId(child)
}
