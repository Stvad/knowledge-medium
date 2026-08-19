/**
 * App-root mount that drives the down-lane (design §8/§9) — background replication of
 * the active workspace's media bytes to the local OPFS store, so its images are
 * available offline. Mounted via `appMountsFacet`. Renders nothing.
 *
 * It:
 *   - runs a down-lane pass for the ACTIVE workspace, re-arming when the user SWITCHES
 *     workspaces (the effect's `workspaceId` dep) so only opened workspaces replicate
 *     (the §8 scope rule);
 *   - schedules EVERY pass off the cold-start / navigation hot path (deep idle) and
 *     coalesces overlapping triggers: the initial catch-up, the once-initial-sync-SETTLES
 *     re-run (so blocks that just arrived get walked), the reconnect retry (`online`), and
 *     a slow periodic sweep for the §9 backstop self-heal + the budget tail. Routing the
 *     settle re-run through idle is load-bearing: `onFirstSync` fires its callback
 *     SYNCHRONOUSLY when the db has already synced (e.g. a workspace switch after initial
 *     sync), so a direct pass would scan + fetch during navigation.
 *
 * The pass itself is single-owner per (user, workspace) across tabs + a no-op in
 * local-only / signed-out (see {@link runDownLaneReconcile}); this component is just the
 * per-tab arming.
 * (Durable origin storage for the byte store, §8, is requested once at boot — origin-
 * wide — by `@/requestPersistentStorage.js`, so it isn't this component's concern.)
 */

import { useEffect } from 'react'
import { useRepo } from '@/context/repo.js'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from '@/utils/scheduleIdle.js'
import { DOWN_LANE_SWEEP_INTERVAL_MS, runDownLaneReconcile } from './assetDownLane.js'
import { armSharedLaneTriggers } from './laneArming.js'

export const MediaDownLaneReplicator = (): null => {
  const repo = useRepo()
  const workspaceId = useActiveWorkspaceId()

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    const pass = (): void => {
      if (cancelled) return // a workspace switch / unmount already tore this arming down
      void runDownLaneReconcile(repo, workspaceId).catch((err) =>
        console.warn('[media] down-lane reconcile failed', err),
      )
    }

    // EVERY trigger goes through here: defer the pass to a genuine idle window (never the
    // cold-start / navigation hot path) and COALESCE — the `scheduled` guard collapses
    // overlapping triggers (notably a workspace switch's initial + the SYNCHRONOUS
    // onFirstSync settle) into a single pass.
    let scheduled = false
    const schedulePass = (): void => {
      if (scheduled) return
      scheduled = true
      scheduleDeepIdle(() => {
        scheduled = false
        pass()
      }, CATCHUP_DEEP_IDLE)
    }

    schedulePass() // initial catch-up
    // Shared lane triggers: re-run once initial sync settles (just-arrived blocks get
    // walked) and on reconnect (retry offline misses) — both idle-deferred via schedulePass.
    const disposeShared = armSharedLaneTriggers(repo.user.id, schedulePass, schedulePass)
    // The slow sweep heals the §9 backstop (a late origin upload) + advances the budget tail.
    const sweep = setInterval(schedulePass, DOWN_LANE_SWEEP_INTERVAL_MS)

    return () => {
      cancelled = true
      disposeShared()
      clearInterval(sweep)
    }
  }, [repo, workspaceId])

  return null
}
