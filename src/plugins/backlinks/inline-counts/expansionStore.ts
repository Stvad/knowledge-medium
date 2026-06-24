import { useSyncExternalStore } from 'react'

/** Which blocks have their inline backlinks manually expanded, this
 *  session. Deliberately ephemeral module state (a `Set` of block ids),
 *  NOT a persisted block property: expansion is a transient view action,
 *  and writing it to block data would pollute history + sync traffic for
 *  every block the user peeks at. Roam's inline references expansion is
 *  likewise session-scoped.
 *
 *  Keyed by block id alone — ids are globally unique, and the set lives
 *  only for the tab's lifetime, so no workspace qualifier is needed. */
const expanded = new Set<string>()
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const toggleBacklinkExpansion = (blockId: string): void => {
  if (expanded.has(blockId)) expanded.delete(blockId)
  else expanded.add(blockId)
  emit()
}

/** Reactive: is this block's inline backlinks section expanded? */
export const useBacklinkExpansion = (blockId: string): boolean =>
  useSyncExternalStore(subscribe, () => expanded.has(blockId))
