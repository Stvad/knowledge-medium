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
 *   - block ABSENT but the workspace is NOT materializable (locked e2ee) → KEEP.
 *     Absence here is INCONCLUSIVE: a committed-and-synced block in a locked e2ee
 *     workspace is withheld from `blocks` (it stays in `blocks_synced` until the
 *     WK arrives), so `isBlockPresent` reads false even though the block exists.
 *     Reaping would delete the only copy of a real block's un-uploaded bytes. The
 *     record can't drain while locked anyway, so we leave it `staged` for a later
 *     boot/unlock to promote.
 *   - block ABSENT (workspace materializable), record from an OLDER boot → REAP:
 *     delete the record, and its OPFS bytes too UNLESS a block still carries the
 *     same content hash. The block tx never committed (or was undone before sync),
 *     so its queue record is an orphan — but the asset block may still exist
 *     SOFT-DELETED (an undone-but-not-redone paste, absent from the `deleted = 0`
 *     view yet still carrying the hash), whose bytes a redo must resolve. So the
 *     byte delete is content-refcount-gated exactly like §16 GC / §8 eviction:
 *     drop the record always, keep the bytes whenever any block still references
 *     the hash.
 *   - block ABSENT (workspace materializable), record from the CURRENT boot → KEEP.
 *     This is an in-flight capture in some tab of this same boot whose tx hasn't
 *     committed yet; the `generation` stamp (set at boot, monotonic per page load)
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
  /** Is the asset block materialized (present, not tombstoned) in the user's
   *  `blocks`? Gated by the caller on the settled checkpoint. NOTE: a committed-
   *  and-synced block in a LOCKED e2ee workspace is NOT materialized into `blocks`
   *  (it waits in `blocks_synced`), so this reads `false` for it — which is why a
   *  reap is additionally gated on {@link isWorkspaceMaterializable}. */
  readonly isBlockPresent: (workspaceId: string, blockId: string) => Promise<boolean>
  /** Can this workspace be materialized right now (plaintext / unlocked e2ee)?
   *  When `false` (locked e2ee), an absent block is INCONCLUSIVE — it may be a
   *  committed-and-synced block withheld from `blocks` until unlock — so we must
   *  NOT reap (that would destroy the only copy of its un-uploaded bytes). */
  readonly isWorkspaceMaterializable: (workspaceId: string) => Promise<boolean>
  /** Does any live-or-soft-deleted block in the workspace still carry this content
   *  hash? Gates the byte delete exactly like §16 GC / §8 eviction: the asset block
   *  may survive soft-deleted (an undone paste), so we drop the orphan record but
   *  KEEP the bytes whenever a carrier remains (so a redo still resolves them). */
  readonly hashHasCarrier: (workspaceId: string, contentHash: string) => Promise<boolean>
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
    } else if (!(await deps.isWorkspaceMaterializable(rec.workspaceId))) {
      // Locked e2ee: absence is inconclusive (the block may be committed-and-synced
      // but withheld from `blocks`). Never reap — keep it staged for unlock/reboot.
      kept += 1
    } else if (rec.generation < deps.currentGeneration) {
      // Orphan from a dead session in a materializable workspace — the block
      // genuinely never committed. Drop the record; delete its bytes only if no
      // other (live or soft-deleted) block still carries the hash (dedup/undo).
      await deps.store.delete(userId, rec.assetBlockId)
      if (!(await deps.hashHasCarrier(rec.workspaceId, rec.contentHash))) {
        await deps.byteStore.delete(userId, rec.workspaceId, rec.contentKey)
      }
      reaped += 1
    } else {
      // Current-boot in-flight capture (tx not yet committed) — leave it.
      kept += 1
    }
  }

  return { promoted, reaped, kept }
}
