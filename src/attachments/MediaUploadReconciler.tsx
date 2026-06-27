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
 *   - re-arms the drain on reconnect (`online`) and tab refocus
 *     (`visibilitychange` → visible), so a capture that `defer`red (workspace was
 *     locked) or hit a transient upload error recovers in-session, not only at the
 *     next boot.
 *
 * Renders nothing. The happy path doesn't need this (capture arms the drain right
 * after commit); this is crash/close recovery + the in-session retry sweep.
 */

import { useEffect } from 'react'
import { useRepo } from '@/context/repo.js'
import { onFirstSync } from '@/data/internals/firstSync.js'
import { getActiveUserId, getPowerSyncDb } from '@/data/repoProvider.js'
import { armUploadDrain, runUploadReconcile } from './assetUpload.js'

export const MediaUploadReconciler = (): null => {
  const repo = useRepo()
  useEffect(() => {
    const userId = getActiveUserId()
    if (!userId) return

    const reconcile = () =>
      void runUploadReconcile(userId, repo).catch((err) =>
        console.warn('[media] upload reconcile failed', err),
      )

    // Required work — runs even with NO initial sync (offline / never-synced):
    // promotes locally-present `staged` records and drains a prior session's
    // `pending` uploads. Idempotent + lane-locked, so it's safe to re-run.
    reconcile()
    // Opportunistic re-run once initial sync settles, so `staged` records whose
    // blocks only just arrived via that sync also promote this boot (a miss merely
    // defers to the next boot — never destructive, since the reconciler doesn't reap).
    const disposeFirstSync = onFirstSync(getPowerSyncDb(userId), reconcile)

    // In-session retry sweep — single-owner drain on reconnect / refocus. Reads
    // the CURRENT active user at fire time (not the effect-time `userId`), so a
    // sweep always targets whoever is signed in now, independent of whether an
    // account switch happens to remount this component.
    const sweep = () => {
      const active = getActiveUserId()
      if (active) armUploadDrain(active)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') sweep()
    }
    window.addEventListener('online', sweep)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      disposeFirstSync()
      window.removeEventListener('online', sweep)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [repo])
  return null
}
