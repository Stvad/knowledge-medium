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
import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from '@/utils/scheduleIdle.js'
import { GC_SWEEP_INTERVAL_MS, runMediaGcSweep } from './assetGc.js'
import { armSharedLaneTriggers } from './laneArming.js'

export const MediaGcSweeper = (): null => {
  useEffect(() => {
    const userId = getActiveUserId()
    if (!userId) return
    let cancelled = false
    const pass = (): void => {
      if (cancelled) return // unmount / account switch already tore this arming down
      void runMediaGcSweep().catch((err) => console.warn('[media] byte GC sweep failed', err))
    }

    // Defer every trigger to a genuine idle window and COALESCE overlapping ones (the
    // synchronous already-synced settle callback + a periodic tick that land together
    // collapse into one pass).
    let scheduled = false
    const schedulePass = (): void => {
      if (scheduled) return
      scheduled = true
      scheduleDeepIdle(() => {
        scheduled = false
        pass()
      }, CATCHUP_DEEP_IDLE)
    }

    // Sweep once initial sync settles (also fires synchronously if already settled → the
    // initial pass) and on reconnect; both idle-deferred via schedulePass.
    const disposeShared = armSharedLaneTriggers(userId, schedulePass, schedulePass)
    const sweep = setInterval(schedulePass, GC_SWEEP_INTERVAL_MS)

    return () => {
      cancelled = true
      disposeShared()
      clearInterval(sweep)
    }
  }, [])

  return null
}
