import { CallbackSet } from '@/utils/callbackSet'

export interface SrsClipboardEntry {
  sourceBlockId: string
  sourceWorkspaceId: string
}

let entry: SrsClipboardEntry | null = null
const listeners = new CallbackSet<[]>('srsClipboard')

export const getSrsClipboard = (): SrsClipboardEntry | null => entry

export const setSrsClipboard = (next: SrsClipboardEntry | null): void => {
  entry = next
  listeners.notify()
}

export const clearSrsClipboard = (): void => setSrsClipboard(null)

export const subscribeSrsClipboard = (cb: () => void): (() => void) => listeners.add(cb)
