import type {Block} from '@/data/block'
import {enterEditModeForBlock, scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction'
import {isVisibleElement} from '@/utils/propertyNavigation'

const selector = (scope: string) => `[data-outline-placeholder-scope="${CSS.escape(scope)}"]`
const rowsIn = (scope: string) => [...document.querySelectorAll<HTMLElement>(`${scopeRowSelector(scope)}, ${selector(scope)}`)].filter(isVisibleElement)

/** Only navigation sees drawings; structural selection and editing still use block queries. */
export const focusAdjacentPlaceholder = (blockId: string, scope: string | undefined, direction: -1 | 1): boolean => {
  if (!scope || typeof document === 'undefined') return false
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
    if (id) await enterEditModeForBlock(ui.repo.block(id), ui, scope, {start: 0})
  }
}
