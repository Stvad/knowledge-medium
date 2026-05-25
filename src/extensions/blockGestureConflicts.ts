/**
 * Block-level gesture conflict facet.
 *
 * Touch gestures on a block (single-finger swipe, two-finger date
 * scrub, future siblings) coexist on the same content surface and
 * need to coordinate so a single physical interaction doesn't fire
 * multiple semantic gestures. Each gesture module registers a
 * contribution; at activation time the gesture calls
 * `claimBlockGesture(...)`, which evicts whoever else holds the slot
 * for that block by invoking their `onCancel(blockId)`.
 *
 * The slot is per-block, not global — concurrent gestures on different
 * blocks don't interfere — and re-claiming the same slot with the same
 * id is a no-op so a gesture that activates twice in a row doesn't
 * cancel itself.
 *
 * Replaces an ad-hoc cross-plugin call (date-scrub importing
 * swipe-quick-actions's `cancelSwipeCandidate` by name) — adding a
 * third gesture only needs another contribution, not another import.
 */
import { defineFacet, type FacetRuntime } from '@/extensions/facet.js'

export interface BlockGestureConflictContribution {
  /** Stable id identifying this gesture across claims and lookups.
   *  Matched against the recorded claim to decide whose `onCancel`
   *  fires on eviction. */
  readonly id: string
  /** Drop any in-flight state this gesture holds for `blockId`. Must
   *  be safe to call at any point in the gesture's lifecycle — fires
   *  when another gesture takes the slot, which can happen before the
   *  gesture has committed to anything visible. */
  readonly onCancel: (blockId: string) => void
}

const isBlockGestureConflictContribution = (
  value: unknown,
): value is BlockGestureConflictContribution =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as BlockGestureConflictContribution).id === 'string' &&
  typeof (value as BlockGestureConflictContribution).onCancel === 'function'

export const blockGestureConflictsFacet = defineFacet<
  BlockGestureConflictContribution,
  readonly BlockGestureConflictContribution[]
>({
  id: 'core.block-gesture-conflicts',
  validate: isBlockGestureConflictContribution,
})

// Active claim per block, keyed by gesture id. Module-level so that
// claims persist across the discrete touch events that drive a single
// gesture, and so that two surface contributions on the same block can
// see each other's claims without threading state through every call
// site.
const activeGestureByBlockId = new Map<string, string>()

const findContribution = (
  runtime: FacetRuntime | null,
  gestureId: string,
): BlockGestureConflictContribution | null => {
  if (!runtime) return null
  for (const contribution of runtime.read(blockGestureConflictsFacet)) {
    if (contribution.id === gestureId) return contribution
  }
  return null
}

/** Record `gestureId` as the active block-level gesture on `blockId`.
 *  If a different gesture had been holding the slot, fire its
 *  `onCancel(blockId)` so it can drop in-flight state. Re-claiming
 *  with the same id is a no-op — a gesture that activates twice (e.g.
 *  passes its threshold and then commits) doesn't cancel itself. */
export const claimBlockGesture = (
  runtime: FacetRuntime | null,
  blockId: string,
  gestureId: string,
): void => {
  const previous = activeGestureByBlockId.get(blockId)
  if (previous === gestureId) return
  activeGestureByBlockId.set(blockId, gestureId)
  if (previous === undefined) return
  findContribution(runtime, previous)?.onCancel(blockId)
}

/** Drop the claim if `gestureId` currently holds it. No-op otherwise —
 *  another gesture may have already evicted us (in which case it owns
 *  the slot now and our `onCancel` has already fired). */
export const releaseBlockGesture = (
  blockId: string,
  gestureId: string,
): void => {
  if (activeGestureByBlockId.get(blockId) === gestureId) {
    activeGestureByBlockId.delete(blockId)
  }
}

/** Test-only: wipe the claim map between cases. Production code
 *  doesn't need this — claims clean themselves up via
 *  releaseBlockGesture / eviction. */
export const __resetBlockGestureClaimsForTest = (): void => {
  activeGestureByBlockId.clear()
}
