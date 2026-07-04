/**
 * Ephemeral "asked Claude" marks — instant chip feedback between the
 * Ask Claude action and the daemon's claim (which replaces the mark
 * with real `claude:status` props). Local-only by design: the graph
 * carries the authoritative lifecycle; this is just optimistic UI.
 */
import { CallbackSet } from '@/utils/callbackSet.js'

/** A mark the daemon never answers (daemon down, watcher missing)
 *  quietly expires instead of showing "queued" forever. */
export const ASKED_TTL_MS = 60_000

const askedAt = new Map<string, number>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const changed = new CallbackSet('claude-tasks-asked')

export const markAskedClaude = (blockId: string): void => {
  askedAt.set(blockId, Date.now())
  // Expiry must NOTIFY, not just be lazily observed: useSyncExternalStore
  // consumers only re-read the snapshot on a notification, so without
  // this timer an unanswered mark would show "queued" until some
  // unrelated render happened to call isAskedClaude again.
  clearTimeout(expiryTimers.get(blockId))
  expiryTimers.set(blockId, setTimeout(() => {
    expiryTimers.delete(blockId)
    if (askedAt.delete(blockId)) changed.notify()
  }, ASKED_TTL_MS))
  changed.notify()
}

export const clearAskedClaude = (blockId: string): void => {
  clearTimeout(expiryTimers.get(blockId))
  expiryTimers.delete(blockId)
  if (askedAt.delete(blockId)) changed.notify()
}

/** The time check stays as defense in depth — timers can be throttled
 *  well past the TTL in background tabs. */
export const isAskedClaude = (blockId: string): boolean => {
  const at = askedAt.get(blockId)
  if (at === undefined) return false
  if (Date.now() - at > ASKED_TTL_MS) {
    askedAt.delete(blockId)
    return false
  }
  return true
}

export const subscribeAskedClaude = (listener: () => void): (() => void) =>
  changed.add(listener)
