export interface SavedSelection {
  range: Range
  start: Node
  end: Node
}

export const captureSelection = (): SavedSelection | null => {
  const selection = document.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0).cloneRange()
  return {range, start: range.startContainer, end: range.endContainer}
}

export const restoreSelection = (saved: SavedSelection | null): void => {
  const selection = document.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  // Ranges relocate into a parent when their nodes are removed. Only restore
  // while both original endpoints still belong to the captured range.
  if (saved && saved.start.isConnected && saved.end.isConnected &&
    saved.range.startContainer === saved.start && saved.range.endContainer === saved.end) {
    selection.addRange(saved.range)
  }
}

/** Evaluate DOM-selection predicates without disturbing palette input editing. */
export const withSelection = <T>(saved: SavedSelection | null, read: () => T): T => {
  const current = captureSelection()
  const focused = document.activeElement
  try {
    restoreSelection(saved)
    return read()
  } finally {
    restoreSelection(current)
    // Restoring a contenteditable range can move browser focus to its editor.
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) {
      focused.focus()
    }
  }
}
