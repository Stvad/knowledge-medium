/**
 * The trigger-arming both byte-replication lane mounts share — the up-lane
 * ({@link import('./MediaUploadReconciler.js').MediaUploadReconciler}) and the down-lane
 * ({@link import('./MediaDownLaneReplicator.js').MediaDownLaneReplicator}). Re-run a
 * handler once initial sync SETTLES (blocks that just arrived get processed — §9) and on
 * RECONNECT (`online`). Returns a dispose that unregisters both; call it from the effect
 * cleanup.
 *
 * Only this common pair is centralized: the lane-specific triggers genuinely diverge and
 * stay in each mount — the up-lane's `visibilitychange` + its required, unconditional
 * boot reconcile; the down-lane's deep-idle initial pass + periodic sweep. Folding those
 * in would make this a config-bag with a knob per difference (run-at-mount vs deferred,
 * user- vs workspace-scoped, one handler vs two), worse than two readable components.
 *
 * `onSettle` and `onReconnect` are separate because the up-lane runs a full reconcile on
 * settle but only a drain on reconnect; the down-lane passes the same `pass` for both.
 *
 * First-sync needs a user (its db is per-user), so it's armed ONLY when `userId` is set.
 * The reconnect listener is armed regardless: a signed-out down-lane mount still wants it
 * (its `pass` re-checks auth + sync at fire time), and the up-lane only reaches here with
 * a user anyway.
 */

import { onFirstSync } from '@/data/internals/firstSync.js'
import { getPowerSyncDb } from '@/data/repoProvider.js'

export const armSharedLaneTriggers = (
  userId: string | null,
  onSettle: () => void,
  onReconnect: () => void,
): (() => void) => {
  const disposeFirstSync = userId ? onFirstSync(getPowerSyncDb(userId), onSettle) : () => {}
  window.addEventListener('online', onReconnect)
  return () => {
    disposeFirstSync()
    window.removeEventListener('online', onReconnect)
  }
}
