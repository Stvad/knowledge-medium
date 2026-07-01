/**
 * App-root mount that drives the up-lane's opportunistic recovery (design §9).
 * Mounted via `appMountsFacet`, it:
 *   - runs the boot reconciler at mount (promote recoverable `staged` records, then
 *     drain `pending`) — UNCONDITIONALLY, because draining a prior session's pending
 *     uploads is REQUIRED work that must not be gated on initial sync: `onFirstSync`
 *     never fires in a connected-but-never-synced / offline session (see firstSync.ts),
 *     so gating here would strand a whole session's un-uploaded bytes;
 *   - re-runs it once initial sync SETTLES, to also promote `staged` records whose
 *     blocks only just arrived via that sync (the reconcile is idempotent + the drain
 *     is lane-locked, so the already-synced double-fire is harmless);
 *   - re-arms the drain on tab refocus (`visibilitychange` → visible), so a capture
 *     that `defer`red (workspace was locked) or hit a transient upload error recovers
 *     in-session, not only at the next boot;
 *   - drives the §9 failed-upload RECOVERY actor ({@link runUploadRecovery}) on the
 *     recovery triggers the design lists — app-start, reconnect (`online`), and a slow
 *     periodic sweep (every few hours, so a long-lived tab still heals once a poisoned /
 *     occupied content path frees) — each doing a cheap content-path probe → requeue a
 *     freed path / clear an already-uploaded one / keep a poisoned one. Refocus stays
 *     drain-only (cheap): recovery is the sparser, probe-driven trigger set. (The fourth
 *     recovery trigger, explicit user-retry, is the diagnostics warning's Retry button.)
 *
 * Renders nothing. The happy path doesn't need this (capture arms the drain right
 * after commit); this is crash/close recovery + the in-session retry/recovery sweeps.
 */

import { useEffect } from 'react'
import { useRepo } from '@/context/repo.js'
import { getActiveUserId } from '@/data/repoProvider.js'
import { armUploadDrain, RECOVERY_SWEEP_INTERVAL_MS, runUploadReconcile, runUploadRecovery } from './assetUpload.js'
import { armSharedLaneTriggers } from './laneArming.js'

export const MediaUploadReconciler = (): null => {
  const repo = useRepo()
  useEffect(() => {
    const userId = getActiveUserId()
    if (!userId) return

    const reconcile = () =>
      void runUploadReconcile(userId, repo).catch((err) =>
        console.warn('[media] upload reconcile failed', err),
      )

    // The §9 failed-upload recovery pass (probe → 3-way → drive the requeued via the
    // drain). Reads the CURRENT active user at fire time (like `sweep`), so it always
    // targets whoever is signed in now, independent of any account-switch remount.
    const recover = () => {
      const active = getActiveUserId()
      if (active) runUploadRecovery(active)
    }

    // Required work — runs even with NO initial sync (offline / never-synced):
    // promotes locally-present `staged` records and drains a prior session's
    // `pending` uploads. Idempotent + lane-locked, so it's safe to re-run.
    reconcile()
    // App-start recovery: un-stick any `failed` records left by a prior session.
    recover()

    // In-session retry sweep — single-owner drain on refocus. Reads the CURRENT active
    // user at fire time (not the effect-time `userId`), so a sweep always targets whoever
    // is signed in now, independent of whether an account switch remounts this component.
    const sweep = () => {
      const active = getActiveUserId()
      if (active) armUploadDrain(active)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') sweep()
    }
    // Shared lane triggers: re-run the full reconcile once initial sync settles (promote
    // `staged` blocks that just arrived — a miss merely defers to the next boot, never
    // destructive since the reconciler doesn't reap), and run RECOVERY on reconnect (it
    // drains the requeued records too, so it subsumes the old reconnect drain-sweep).
    const disposeShared = armSharedLaneTriggers(userId, reconcile, recover)
    document.addEventListener('visibilitychange', onVisible)
    // The slow periodic §9 sweep: a long-lived online tab still heals once a poisoned /
    // occupied path frees, rather than waiting on a restart it may never get.
    const recoverySweep = setInterval(recover, RECOVERY_SWEEP_INTERVAL_MS)
    return () => {
      disposeShared()
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(recoverySweep)
    }
  }, [repo])
  return null
}
