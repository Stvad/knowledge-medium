/**
 * App-root mount that drives the down-lane (design §8/§9) — background replication of
 * the active workspace's media bytes to the local OPFS store, so its images are
 * available offline. Mounted via `appMountsFacet`. Renders nothing.
 *
 * It:
 *   - runs a down-lane pass for the ACTIVE workspace, re-arming when the user SWITCHES
 *     workspaces (the effect's `workspaceId` dep) so only opened workspaces replicate
 *     (the §8 scope rule);
 *   - schedules the pass off the cold-start window (deep idle), re-runs it once initial
 *     sync SETTLES (so blocks that just arrived get walked) and on reconnect (`online`,
 *     to retry offline misses), plus a slow periodic sweep for the §9 backstop
 *     self-heal + the budget tail.
 *
 * The pass itself is single-owner across tabs + a no-op in local-only / signed-out
 * (see {@link runDownLaneReconcile}); this component is just the per-tab arming.
 * (Durable origin storage for the byte store, §8, is requested once at boot — origin-
 * wide — by `@/requestPersistentStorage.js`, so it isn't this component's concern.)
 */

import { useEffect } from 'react'
import { useRepo } from '@/context/repo.js'
import { onFirstSync } from '@/data/internals/firstSync.js'
import { getActiveUserId, getPowerSyncDb } from '@/data/repoProvider.js'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from '@/utils/scheduleIdle.js'
import { DOWN_LANE_SWEEP_INTERVAL_MS, runDownLaneReconcile } from './assetDownLane.js'

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

    // Initial pass off the cold-start window (genuine idle, force-run by the fallback),
    // and again once initial sync settles so just-arrived blocks get walked.
    scheduleDeepIdle(pass, CATCHUP_DEEP_IDLE)
    const userId = getActiveUserId()
    const disposeFirstSync = userId ? onFirstSync(getPowerSyncDb(userId), pass) : () => {}

    // Reconnect retries offline misses; the slow sweep heals the §9 backstop (a late
    // origin upload) + advances the budget tail.
    window.addEventListener('online', pass)
    const sweep = setInterval(pass, DOWN_LANE_SWEEP_INTERVAL_MS)

    return () => {
      cancelled = true
      disposeFirstSync()
      window.removeEventListener('online', pass)
      clearInterval(sweep)
    }
  }, [repo, workspaceId])

  return null
}
