export interface SrsClipboardEntry {
  sourceBlockId: string
  sourceWorkspaceId: string
}

let entry: SrsClipboardEntry | null = null
const listeners = new Set<() => void>()

export const getSrsClipboard = (): SrsClipboardEntry | null => entry

export const setSrsClipboard = (next: SrsClipboardEntry | null): void => {
  entry = next
  for (const l of listeners) l()
}

export const clearSrsClipboard = (): void => setSrsClipboard(null)

export const subscribeSrsClipboard = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
