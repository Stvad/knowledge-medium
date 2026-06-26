/**
 * The boot reconciler (design §9/§11) — the recovery half of the capture
 * staging contract. Runs AFTER PowerSync reports initial sync settled (so an
 * absent block means truly-absent, not not-yet-hydrated), single-owner, per user.
 *
 * It walks the user's `staged` records — the ones a capture wrote BEFORE its block
 * tx and that never got promoted (the capturing session crashed/closed between
 * the durable stage and the post-commit flip):
 *
 *   - block PRESENT  → promote `staged` → `pending`. Recovers a crash AFTER the
 *     block tx committed but BEFORE the in-session promote: the asset exists, so
 *     its bytes must upload.
 *   - block ABSENT, record from an OLDER boot → REAP: delete the record AND its
 *     orphan OPFS bytes. The block tx never committed (or was undone before sync),
 *     so uploading would orphan an object — drop the never-referenced bytes.
 *   - block ABSENT, record from the CURRENT boot → KEEP. This is an in-flight
 *     capture in some tab of this same boot whose tx hasn't committed yet; the
 *     `generation` stamp (set at boot, monotonic per page load) is what
 *     distinguishes "my session's in-flight" from "a dead session's orphan", so we
 *     never reap a capture that's mid-commit.
 *
 * `pending` records are left to {@link drainUploads} (the caller runs the drain
 * right after this); `failed` records are left for §9 opportunistic recovery.
 */

import type { ByteStore } from './byteStore.js'
import type { ByteUploadStore } from './uploadStore.js'

export interface UploadReconcileDeps {
  readonly store: ByteUploadStore
  readonly byteStore: ByteStore
  /** Is the asset block live (present, not tombstoned) in the user's DB? Gated by
   *  the caller on the settled checkpoint, so `false` means truly-absent. */
  readonly isBlockPresent: (workspaceId: string, blockId: string) => Promise<boolean>
  /** This boot's generation stamp. A `staged` record with a strictly smaller
   *  generation is from a dead session (reapable); an equal one is in-flight. */
  readonly currentGeneration: number
}

export interface ReconcileSummary {
  readonly promoted: number
  readonly reaped: number
  readonly kept: number
}

export const reconcileUploads = async (
  userId: string,
  deps: UploadReconcileDeps,
): Promise<ReconcileSummary> => {
  const staged = await deps.store.listByStatus(userId, 'staged')
  let promoted = 0
  let reaped = 0
  let kept = 0

  for (const rec of staged) {
    if (await deps.isBlockPresent(rec.workspaceId, rec.assetBlockId)) {
      await deps.store.promote(userId, rec.assetBlockId)
      promoted += 1
    } else if (rec.generation < deps.currentGeneration) {
      // Orphan from a dead session — drop the record AND its never-referenced bytes.
      await deps.store.delete(userId, rec.assetBlockId)
      await deps.byteStore.delete(userId, rec.workspaceId, rec.contentKey)
      reaped += 1
    } else {
      // Current-boot in-flight capture (tx not yet committed) — leave it.
      kept += 1
    }
  }

  return { promoted, reaped, kept }
}
