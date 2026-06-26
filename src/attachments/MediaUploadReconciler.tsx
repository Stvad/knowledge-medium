/**
 * App-root mount that drives the up-lane's opportunistic recovery (design §9).
 * Mounted via `appMountsFacet`, it:
 *   - waits for the active user's PowerSync initial sync to SETTLE (so more synced
 *     blocks are materialized and get promoted this boot rather than the next),
 *     then runs the boot reconciler once — promote recoverable `staged` records,
 *     then drain;
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

    // onFirstSync fires the callback once initial sync has settled (immediately
    // if it already has) and returns a disposer; gate the reconcile on it so the
    // most synced blocks are materialized + promoted this boot (a miss just defers
    // to the next boot — never destructive, since the reconciler doesn't reap).
    const disposeFirstSync = onFirstSync(getPowerSyncDb(userId), () => {
      void runUploadReconcile(userId, repo).catch((err) =>
        console.warn('[media] upload reconcile failed', err),
      )
    })

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
