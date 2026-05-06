export const PROPERTY_CREATE_REQUEST_EVENT = 'tm:property-create-request'

export interface PropertyCreateRequestDetail {
  blockId: string
  initialName: string
  seq: number
}

let propertyCreateRequestSeq = 0
const pendingCreateRequests = new Map<string, PropertyCreateRequestDetail>()

export const requestPropertyCreate = (args: {
  blockId: string
  initialName?: string
}): PropertyCreateRequestDetail => {
  const detail: PropertyCreateRequestDetail = {
    blockId: args.blockId,
    initialName: args.initialName ?? '',
    seq: ++propertyCreateRequestSeq,
  }
  pendingCreateRequests.set(args.blockId, detail)

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROPERTY_CREATE_REQUEST_EVENT, {detail}))
  }

  return detail
}

export const consumePendingPropertyCreateRequest = (
  blockId: string,
): PropertyCreateRequestDetail | undefined => {
  const detail = pendingCreateRequests.get(blockId)
  if (detail) pendingCreateRequests.delete(blockId)
  return detail
}

export const subscribePropertyCreateRequests = (
  blockId: string,
  handler: (detail: PropertyCreateRequestDetail) => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {}

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PropertyCreateRequestDetail>).detail
    if (!detail || detail.blockId !== blockId) return
    pendingCreateRequests.delete(blockId)
    handler(detail)
  }

  window.addEventListener(PROPERTY_CREATE_REQUEST_EVENT, listener)
  return () => window.removeEventListener(PROPERTY_CREATE_REQUEST_EVENT, listener)
}

const PROPERTY_ROW_SELECTOR = '[data-property-row="true"]'
const PROPERTY_FOCUSABLE_SELECTOR = [
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[contenteditable="true"]',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const isVisibleElement = (element: HTMLElement): boolean => {
  if (typeof window === 'undefined' || !window.getComputedStyle) return true
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

const isFocusableElement = (element: HTMLElement): boolean => {
  if (!isVisibleElement(element)) return false
  if ('disabled' in element && element.disabled === true) return false
  return true
}

export const getPropertyRows = (blockId: string): HTMLElement[] => {
  if (typeof document === 'undefined') return []
  return Array.from(document.querySelectorAll<HTMLElement>(PROPERTY_ROW_SELECTOR))
    .filter(row => row.dataset.blockId === blockId && isVisibleElement(row))
}

export const getPropertyRowFocusTarget = (row: HTMLElement): HTMLElement | null =>
  Array.from(
    row.querySelectorAll<HTMLElement>(`[data-property-value="true"] ${PROPERTY_FOCUSABLE_SELECTOR}`),
  ).find(isFocusableElement) ??
  Array.from(row.querySelectorAll<HTMLElement>(PROPERTY_FOCUSABLE_SELECTOR))
    .find(isFocusableElement) ?? null

const placeCaret = (target: HTMLElement, edge: 'start' | 'end') => {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const pos = edge === 'start' ? 0 : target.value.length
    try {
      target.setSelectionRange(pos, pos)
    } catch {
      // Some input types (date, number) do not support text selection.
    }
  }
}

export const focusPropertyRowElement = (
  row: HTMLElement,
  edge: 'start' | 'end' = 'end',
): boolean => {
  const target = getPropertyRowFocusTarget(row)
  if (!target) return false
  target.focus()
  placeCaret(target, edge)
  return true
}

export const focusPropertyRow = (
  blockId: string,
  position: 'first' | 'last',
): boolean => {
  const rows = getPropertyRows(blockId)
  const row = position === 'first' ? rows[0] : rows.at(-1)
  return row ? focusPropertyRowElement(row, position === 'first' ? 'start' : 'end') : false
}

export const focusPropertyRowByName = (
  blockId: string,
  name: string,
): boolean => {
  const row = getPropertyRows(blockId)
    .find(candidate => candidate.dataset.propertyName === name)
  return row ? focusPropertyRowElement(row) : false
}

export const focusPropertyRowByNameWhenReady = (
  blockId: string,
  name: string,
  attempts = 8,
): void => {
  if (focusPropertyRowByName(blockId, name)) return
  if (attempts <= 0 || typeof requestAnimationFrame === 'undefined') return
  requestAnimationFrame(() => focusPropertyRowByNameWhenReady(blockId, name, attempts - 1))
}

export const focusAdjacentPropertyRow = (
  blockId: string,
  currentRow: HTMLElement,
  direction: -1 | 1,
): boolean => {
  const rows = getPropertyRows(blockId)
  const index = rows.indexOf(currentRow)
  if (index < 0) return false
  const next = rows[index + direction]
  return next ? focusPropertyRowElement(next, direction < 0 ? 'end' : 'start') : false
}
