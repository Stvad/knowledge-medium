/**
 * Imperative "mount this lazy row now" channel.
 *
 * `LazyViewportMount` normally decides for itself when to swap a placeholder
 * for real content, driven by an `IntersectionObserver`. That is the right
 * default for scrolling, but it makes a not-yet-mounted row unreachable by
 * anything that isn't scrolling — most importantly keyboard navigation, which
 * resolves its target from the block model and then writes the panel's focus.
 * A focus write that lands on a placeholder is a dead end: no shell to
 * highlight, none to take DOM focus, none to scroll into view, and
 * `useInFocus` false for every mounted row — so normal mode (activated off
 * that hook) goes quiet and the next keystroke has nothing to walk from.
 *
 * This is the one place that reasoning is written out; the call sites point
 * here rather than restating it.
 *
 * Shape, and why:
 *
 *   - **A request is a standing want, not an edge.** `requestLazyMount`
 *     returns a withdraw function and the want lives until it's called. A
 *     row that registers *after* the request still mounts — which is the
 *     common case, not a corner: mounting a parent renders no children until
 *     its `childIds` handle resolves (`useChildIds` returns `[]` while
 *     loading), so a focus write onto that first child routinely precedes
 *     the child's own registration. An edge-triggered request would be
 *     dropped there and the stall would survive the fix.
 *   - **Many rows can be pending under one key.** The same block renders in
 *     every panel, embed and recents row that shows it, so registration
 *     fans out to a set and a request mounts all of them. Keeping one slot
 *     per key would let a second copy evict the first, stranding a
 *     placeholder that can never be reached again (its effect won't re-run).
 *     Fanning out also means the key needs no render scope: whichever copy
 *     the focused location refers to is necessarily among the ones mounted.
 *
 * Registration is keyed, so a request costs a lookup rather than a
 * broadcast, and no `LazyViewportMount` has to subscribe to focus state —
 * subscribing per-row is exactly the fan-out the spatial-navigation shell
 * decorator documents as the pitfall to avoid.
 *
 * A key with no registration and no want is simply nothing pending: either
 * the row is already mounted, or it isn't rendered at all (deleted,
 * collapsed away, on a page nobody has open). Both are correctly no-ops.
 */

/** Cache key for a lazily-mounted block row. Shared by the component that
 *  registers under it (`LazyBlockComponent`) and the callers that request a
 *  mount by block id, so the two can't drift apart. */
export const lazyBlockCacheKey = (blockId: string): string => `block:${blockId}`

const pendingMounts = new Map<string, Set<() => void>>()
/** key -> how many callers currently want it. Counted, not a flag: two panels
 *  can focus the same block, and one withdrawing must not cancel the other's
 *  standing want (which would leave the second panel's row deferred forever
 *  once its placeholder registers). */
const wantedKeys = new Map<string, number>()

/** Register `mount` as a way to force a row for `cacheKey` to mount. Returns
 *  the unregister function (effect-cleanup shaped). Only rows currently
 *  showing a placeholder should register. If the key is already wanted, this
 *  mounts straight away instead of registering. */
export const registerPendingLazyMount = (cacheKey: string, mount: () => void): (() => void) => {
  if (wantedKeys.has(cacheKey)) {
    // Someone is already waiting on this key — mount rather than defer.
    mount()
    return () => {}
  }
  const mounts = pendingMounts.get(cacheKey) ?? new Set<() => void>()
  mounts.add(mount)
  pendingMounts.set(cacheKey, mounts)
  return () => {
    const current = pendingMounts.get(cacheKey)
    if (!current) return
    current.delete(mount)
    if (current.size === 0) pendingMounts.delete(cacheKey)
  }
}

/** Ask every row for `cacheKey` to mount, and keep wanting it so rows that
 *  render later mount too. Returns the withdraw function — call it when the
 *  reason for wanting the row is gone (effect-cleanup shaped), otherwise a
 *  stale want would keep eagerly mounting that block elsewhere. */
export const requestLazyMount = (cacheKey: string): (() => void) => {
  wantedKeys.set(cacheKey, (wantedKeys.get(cacheKey) ?? 0) + 1)
  const mounts = pendingMounts.get(cacheKey)
  if (mounts) {
    // Drop the registrations before invoking: each `mount()` re-renders its
    // row, whose cleanup would otherwise mutate the set being iterated.
    pendingMounts.delete(cacheKey)
    for (const mount of mounts) mount()
  }
  let withdrawn = false
  return () => {
    if (withdrawn) return
    withdrawn = true
    const remaining = (wantedKeys.get(cacheKey) ?? 1) - 1
    if (remaining > 0) wantedKeys.set(cacheKey, remaining)
    else wantedKeys.delete(cacheKey)
  }
}

/** Test-only: drop all registrations and wants. */
export const __resetLazyMountRegistryForTesting = (): void => {
  pendingMounts.clear()
  wantedKeys.clear()
}
