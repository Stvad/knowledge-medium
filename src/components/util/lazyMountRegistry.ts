/**
 * Imperative "mount this lazy row now" channel.
 *
 * `LazyViewportMount` normally decides for itself when to swap a placeholder
 * for real content, driven by an `IntersectionObserver`. That is the right
 * default for scrolling, but it makes a not-yet-mounted row unreachable by
 * anything that isn't scrolling — most importantly keyboard navigation, which
 * resolves its target from the block model and then writes the panel's focus.
 * A focus write that lands on a placeholder has no shell to highlight, no
 * shell to take DOM focus, and no shell to scroll into view; normal mode
 * (which activates off `useInFocus`) simply goes quiet.
 *
 * So focus writers announce their target here and the pending row mounts
 * itself in response. Registration is keyed and one-per-key, so a request is
 * an O(1) lookup rather than a broadcast — no `LazyViewportMount` has to
 * subscribe to focus state (subscribing per-row is exactly the fan-out the
 * spatial-navigation shell decorator documents as the pitfall to avoid).
 *
 * A key with no entry means "nothing pending under that key" — either the row
 * is already mounted, or it isn't rendered at all (deleted, collapsed away, on
 * a page nobody has open). Both are correctly a no-op, which is why
 * `requestLazyMount` reports whether it actually found a pending row: callers
 * that need to distinguish "not mounted yet" from "genuinely gone" (focus
 * recovery) can.
 */

/** Cache key for a lazily-mounted block row. Shared by the component that
 *  registers under it (`LazyBlockComponent`) and the callers that request a
 *  mount by block id, so the two can't drift apart. */
export const lazyBlockCacheKey = (blockId: string): string => `block:${blockId}`

const pendingMounts = new Map<string, () => void>()

/** Register `mount` as the way to force the row for `cacheKey` to mount.
 *  Returns the unregister function (effect-cleanup shaped). Only rows that
 *  are currently showing a placeholder should be registered. */
export const registerPendingLazyMount = (cacheKey: string, mount: () => void): (() => void) => {
  pendingMounts.set(cacheKey, mount)
  return () => {
    // Guard against clobbering a newer registration for the same key: a
    // remount (StrictMode double-effect, or the same block re-rendered
    // elsewhere) registers before the old effect cleans up.
    if (pendingMounts.get(cacheKey) === mount) pendingMounts.delete(cacheKey)
  }
}

/** Ask the row for `cacheKey` to mount now. Returns true when a pending row
 *  was found and asked (i.e. the caller should expect it to appear on a
 *  subsequent commit), false when nothing is pending under that key. */
export const requestLazyMount = (cacheKey: string): boolean => {
  const mount = pendingMounts.get(cacheKey)
  if (!mount) return false
  mount()
  return true
}

/** Test-only: drop all registrations. */
export const __resetLazyMountRegistryForTesting = (): void => {
  pendingMounts.clear()
}
