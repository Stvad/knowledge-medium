import { useSyncExternalStore } from 'react'

/** Module-level store of which block currently shows its swipe-action menu.
 *  Module scope is fine here: at most one block has the menu open at a time
 *  across the whole app, so a singleton matches the UX. The gesture handler
 *  (per-block contribution) and the global overlay component both reach
 *  this store; threading it through React context would only add ceremony. */

let activeBlockId: string | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

export const setActiveSwipeBlockId = (id: string | null): void => {
  if (activeBlockId === id) return
  activeBlockId = id
  emit()
}

export const getActiveSwipeBlockId = (): string | null => activeBlockId

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useActiveSwipeBlockId = (): string | null =>
  useSyncExternalStore(subscribe, getActiveSwipeBlockId, getActiveSwipeBlockId)
