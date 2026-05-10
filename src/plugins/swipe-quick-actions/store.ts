import { useSyncExternalStore } from 'react'

/** Which block currently shows its swipe-action menu, plus the exact DOM
 *  element that was swiped. The same block can be rendered in multiple
 *  panels, so storing only the id and resolving via document-wide
 *  querySelector would let the menu anchor to a different instance than
 *  the one the user actually touched. The element ref pins the menu to
 *  the right row.
 *
 *  Module scope is fine here: at most one block has the menu open at a
 *  time across the whole app, so a singleton matches the UX. The
 *  gesture handler (per-block contribution) and the global overlay
 *  component both reach this store; threading it through React context
 *  would only add ceremony. */

export interface ActiveSwipeTarget {
  blockId: string
  /** The element bearing `data-block-id` for the swiped block. The
   *  overlay measures this directly; if it becomes detached (block
   *  re-rendered, panel torn down) the overlay closes itself. */
  element: HTMLElement
}

let activeTarget: ActiveSwipeTarget | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

export const setActiveSwipeTarget = (next: ActiveSwipeTarget | null): void => {
  if (
    activeTarget === next ||
    (activeTarget && next && activeTarget.blockId === next.blockId && activeTarget.element === next.element)
  ) {
    return
  }
  activeTarget = next
  emit()
}

/** Convenience wrapper for callers that only want to clear the menu —
 *  most dismiss paths (Escape, outside-tap, action-run) don't have an
 *  element to hand. */
export const clearActiveSwipeTarget = (): void => {
  setActiveSwipeTarget(null)
}

export const getActiveSwipeTarget = (): ActiveSwipeTarget | null => activeTarget

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useActiveSwipeTarget = (): ActiveSwipeTarget | null =>
  useSyncExternalStore(subscribe, getActiveSwipeTarget, getActiveSwipeTarget)
