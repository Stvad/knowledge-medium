/**
 * App-root mount that drives the §16 media byte GC (docs/media-attachments/byte-gc-design.md)
 * — background reclamation of the byte prefixes of workspaces the active user no longer has
 * access to (revoke / leave / workspace delete). Mounted via `appMountsFacet`. Renders
 * nothing.
 *
 * USER-scoped, not workspace-scoped (it enumerates ALL of the user's stored workspace
 * prefixes, including ones no longer open), so unlike the down-lane replicator it does not
 * depend on the active workspace. It:
 *   - runs a sweep once initial sync SETTLES (the local `workspaces`/`blocks` view is
 *     authoritative only then — `armSharedLaneTriggers` fires the settle callback
 *     synchronously when already-synced, so an already-settled session sweeps shortly after
 *     mount) and on RECONNECT;
 *   - re-runs on a slow periodic interval so the grace clock advances across a long session.
 *
 * EVERY pass is deep-idle-scheduled + coalesced, so reclamation never runs on the cold-start
 * / navigation hot path. There is deliberately NO unconditional cold-mount pass: the sweep
 * is best-effort (a left workspace's wasted bytes, never required work), and it gates on
 * `hasSynced` internally anyway ({@link runMediaGcSweep}).
 */

import { useEffect } from 'react'
import { getActiveUserId } from '@/data/repoProvider.js'
import { GC_SWEEP_INTERVAL_MS, runMediaGcSweep } from './assetGc.js'
import { armSharedLaneTriggers } from './laneArming.js'
import { coalescedDeepIdlePass } from './laneSchedule.js'

export const MediaGcSweeper = (): null => {
  useEffect(() => {
    const userId = getActiveUserId()
    if (!userId) return
    // Every trigger runs the sweep off the hot path (deep idle) and coalesces (the
    // synchronous already-synced settle callback + a periodic tick that land together
    // collapse into one pass); `cancel` stops a queued pass once this effect tears down.
    const { schedulePass, cancel } = coalescedDeepIdlePass(
      runMediaGcSweep,
      '[media] byte GC sweep failed',
    )

    // Sweep once initial sync settles (also fires synchronously if already settled → the
    // initial pass) and on reconnect; both idle-deferred via schedulePass. The first-sync
    // trigger binds to the MOUNT-time user (the effect has no user dep), but that's only a
    // latency detail, not a correctness one: `runMediaGcSweep` re-reads the live active user
    // every pass, so a post-account-switch user still gets correctly-scoped sweeps — just via
    // the periodic interval / reconnect rather than its own first-sync-settle.
    const disposeShared = armSharedLaneTriggers(userId, schedulePass, schedulePass)
    const sweep = setInterval(schedulePass, GC_SWEEP_INTERVAL_MS)

    return () => {
      cancel()
      disposeShared()
      clearInterval(sweep)
    }
  }, [])

  return null
}
