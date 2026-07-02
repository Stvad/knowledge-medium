/**
 * The coalesced, idle-deferred pass scheduler shared by the background byte-lane mounts
 * ({@link import('./MediaGcSweeper.js').MediaGcSweeper} and
 * {@link import('./MediaDownLaneReplicator.js').MediaDownLaneReplicator}).
 *
 * Both mounts re-arm the SAME background pass from several triggers (an initial catch-up,
 * the first-sync settle, a reconnect, a periodic sweep) and each needs the identical
 * machinery: (a) run every pass off the cold-start / navigation hot path (deep idle),
 * (b) COALESCE overlapping triggers into a single pass, and (c) stop firing once the
 * mounting effect is torn down. That machinery is byte-for-byte the same between the mounts,
 * so it lives here. What DIFFERS — the work each pass does, and which triggers arm it —
 * stays in each mount (the same "centralize the identical part, keep the divergent part
 * inline" split {@link import('./laneArming.js')} draws for the trigger wiring).
 */

import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from '@/utils/scheduleIdle.js'

export interface CoalescedIdlePass {
  /** Arm a pass on the next deep-idle window. Overlapping arms before that window fires
   *  COALESCE into one pass. A no-op after {@link CoalescedIdlePass.cancel}. */
  readonly schedulePass: () => void
  /** Tear-down (call from the effect cleanup): a pass already sitting in the idle queue
   *  won't run its `work`. */
  readonly cancel: () => void
}

/** Build a {@link CoalescedIdlePass} that runs `work` on deep idle — coalescing overlapping
 *  arms into one pass and swallowing (log-only, under `warnLabel`) a rejected `work`. */
export const coalescedDeepIdlePass = (
  work: () => Promise<void>,
  warnLabel: string,
): CoalescedIdlePass => {
  let cancelled = false
  let scheduled = false
  return {
    schedulePass: () => {
      if (scheduled) return
      scheduled = true
      scheduleDeepIdle(() => {
        scheduled = false
        if (cancelled) return // the effect was torn down while this pass sat in the idle queue
        void work().catch((err) => console.warn(warnLabel, err))
      }, CATCHUP_DEEP_IDLE)
    },
    cancel: () => {
      cancelled = true
    },
  }
}
