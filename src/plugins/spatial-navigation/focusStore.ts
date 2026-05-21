/**
 * Module-level focused-instance store, updated synchronously the moment
 * spatial navigation lands on a new instance. Persistence (the IDB
 * write of `focusedBlockIdProp` / `focusedVisualTargetKeyProp`) is
 * debounced separately and runs ~200ms after a burst settles — too
 * slow for visual feedback during a held-down key.
 *
 * The kernel's `BlockFocusShellDecorator` drives the focus highlight
 * from `useInFocus(block.id)` which reads the persisted prop. During
 * a debounce window the prop hasn't moved yet, so the highlight
 * sits on the burst's starting block. Without browser-native
 * `:focus` styling (DefaultBlockRenderer removes the outline at
 * shell level) the user sees no visual movement until the debounce
 * fires — felt as the plugin being "slow".
 *
 * Our shell decorator subscribes to this store via
 * `useSyncExternalStore`. The snapshot is a single string (or null);
 * selector-style consumers compare against their own instance id and
 * only re-render on flip, so the fan-out is bounded to at most two
 * blocks per nav step.
 */

let currentInstanceKey: string | null = null
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

export const setSpatialFocusedInstance = (instanceKey: string | null): void => {
  if (currentInstanceKey === instanceKey) return
  currentInstanceKey = instanceKey
  notify()
}

export const subscribeSpatialFocus = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getSpatialFocusedInstance = (): string | null => currentInstanceKey

/** Test-only. */
export const __resetSpatialFocusedInstanceForTesting = (): void => {
  currentInstanceKey = null
  listeners.clear()
}
