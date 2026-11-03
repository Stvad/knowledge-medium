/**
 * Tiny module-level open/closed store for a globally-mounted UI surface
 * (command palette, find-replace, quick-find, left sidebar). The surface
 * is mounted once via `appMountsFacet` and reads `isOpen()` with
 * `useSyncExternalStore`; actions and header buttons flip it directly.
 *
 * This is the typed replacement for the old `window.CustomEvent` toggle
 * bus — same single-instance, global semantics, but no stringly event
 * names and no manual add/removeEventListener lifecycle. It's the same
 * mechanism the app's own `DialogHost` uses for the dialog queue, and
 * the one the extension authoring lint now blesses. Cross-plugin /
 * external callers reach a surface through its action id
 * (`runActionById`), never by importing the store.
 */
import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet'

export interface ToggleStore {
  /** Current open state. Pass as `useSyncExternalStore`'s getSnapshot. */
  isOpen(): boolean
  /** Subscribe to changes. Pass as `useSyncExternalStore`'s subscribe. */
  subscribe(callback: () => void): () => void
  /** Set open state explicitly (e.g. a dialog's `onOpenChange`). */
  set(open: boolean): void
  open(): void
  close(): void
  toggle(): void
}

export const createToggleStore = (label?: string): ToggleStore => {
  let open = false
  const subscribers = new CallbackSet(label)
  const set = (next: boolean): void => {
    if (next === open) return
    open = next
    subscribers.notify()
  }
  return {
    isOpen: () => open,
    subscribe: callback => subscribers.add(callback),
    set,
    open: () => set(true),
    close: () => set(false),
    toggle: () => set(!open),
  }
}

/**
 * The keyed sibling of `ToggleStore`: a set of keys, each on or off, such as
 * which blocks have an inline section expanded. Deliberately ephemeral, per-tab
 * module state and never block data: expanding is a transient view action, and
 * writing it to blocks would put every peek into history and sync traffic.
 */
export interface KeyedToggleSet {
  /** Reactive: is `key` on? */
  useHas(key: string): boolean
  toggle(key: string): void
  add(key: string): void
}

export const createKeyedToggleSet = (label?: string): KeyedToggleSet => {
  const keys = new Set<string>()
  const subscribers = new CallbackSet(label)
  const subscribe = (callback: () => void): (() => void) => subscribers.add(callback)
  return {
    useHas: key => useSyncExternalStore(subscribe, () => keys.has(key)),
    toggle: key => {
      if (!keys.delete(key)) keys.add(key)
      subscribers.notify()
    },
    add: key => {
      keys.add(key)
      subscribers.notify()
    },
  }
}
