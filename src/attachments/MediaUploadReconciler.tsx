/**
 * App-root mount that runs the up-lane boot reconciler (design §9). Mounted via
 * `appMountsFacet`, it waits for the active user's PowerSync initial sync to
 * SETTLE (so an absent asset block is truly-absent, not merely not-yet-hydrated),
 * then promotes recoverable `staged` records, reaps orphans, and drains — once.
 *
 * Renders nothing. The happy-path upload doesn't need this (capture arms the drain
 * right after commit); this is purely crash/close recovery for captures that
 * staged-then-died before the post-commit promote.
 */

import { useEffect } from 'react'
import { useRepo } from '@/context/repo.js'
import { onFirstSync } from '@/data/internals/firstSync.js'
import { getActiveUserId, getPowerSyncDb } from '@/data/repoProvider.js'
import { runUploadReconcile } from './assetUpload.js'

export const MediaUploadReconciler = (): null => {
  const repo = useRepo()
  useEffect(() => {
    const userId = getActiveUserId()
    if (!userId) return
    // onFirstSync fires the callback once initial sync has settled (immediately
    // if it already has) and returns a disposer; gate the reconcile on it so we
    // never reap a block that simply hasn't downloaded yet.
    return onFirstSync(getPowerSyncDb(userId), () => {
      void runUploadReconcile(userId, repo).catch((err) =>
        console.warn('[media] upload reconcile failed', err),
      )
    })
  }, [repo])
  return null
}
