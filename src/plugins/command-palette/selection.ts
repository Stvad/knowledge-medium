export interface SavedSelection {
  range: Range
  start: Node
  end: Node
}

const captureRange = (): SavedSelection | null => {
  const selection = document.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0).cloneRange()
  return {range, start: range.startContainer, end: range.endContainer}
}

const isEditable = (node: Node): boolean => {
  const element = node instanceof Element ? node : node.parentElement
  return element instanceof HTMLElement && element.isContentEditable
}

/** Editor selections belong to editor state; replaying them would steal focus. */
export const captureSelection = (): SavedSelection | null => {
  const saved = captureRange()
  return saved && !isEditable(saved.start) && !isEditable(saved.end) ? saved : null
}

export const restoreSelection = (saved: SavedSelection | null): void => {
  const selection = document.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  // Ranges relocate into a parent when their nodes are removed. Only restore
  // while both original endpoints still belong to the captured range.
  if (saved && saved.range.commonAncestorContainer.isConnected &&
    saved.range.startContainer === saved.start && saved.range.endContainer === saved.end) {
    selection.addRange(saved.range)
  }
}

/** Evaluate DOM-selection predicates without disturbing palette input editing. */
export const withSelection = <T>(saved: SavedSelection | null, read: () => T): T => {
  const current = captureRange()
  const focused = document.activeElement
  const inputSelection = focused instanceof HTMLInputElement && focused.selectionStart !== null ? {
    input: focused, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection,
  } : null
  try {
    restoreSelection(saved)
    return read()
  } finally {
    restoreSelection(current)
    // A document Range does not encode an input's native caret or selection.
    if (inputSelection) {
      inputSelection.input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined)
    }
  }
}
