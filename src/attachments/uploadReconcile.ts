/**
 * The boot reconciler (design §9/§11) — the recovery half of the capture staging
 * contract. Runs once at app start, single-owner, per user.
 *
 * It walks the user's `staged` records — the ones a capture wrote BEFORE its block
 * tx and never promoted (the capturing session crashed/closed between the durable
 * stage and the post-commit flip), and does ONE thing:
 *
 *   - block present (materialized in `blocks`) → promote `staged` → `pending`, so
 *     its bytes drain. Recovers a crash AFTER the block tx committed but BEFORE the
 *     in-session promote.
 *   - otherwise → LEAVE it staged. It's either a committed block not yet
 *     materialized (a locked-e2ee / not-yet-hydrated workspace — it promotes on a
 *     later boot once it materializes; it couldn't drain while locked anyway), or
 *     the rare true orphan (a crash in the tiny stage→commit window; a CAUGHT tx
 *     throw already cleans up inline, §11).
 *
 * Why no reap: a `staged` record is non-drainable, so an orphan never uploads on
 * its own — leaving it costs only its bytes, which the §16 content-refcount GC
 * reclaims (no live-or-soft-deleted block carries the hash). Reaping here would
 * need to PROVE a block never committed, which means distinguishing it from a
 * committed-but-unmaterialized one (locked e2ee, observer lag, quarantine) — and a
 * wrong guess deletes the only copy of a real block's un-uploaded bytes. Trading a
 * near-zero, GC-reclaimable byte leak for "can never reap a live block's bytes" is
 * the right call; orphan reclamation belongs to §16 GC, not this hot recovery path.
 *
 * `pending` records are left to {@link drainUploads}; `failed` to §9 recovery.
 */

import type { ByteUploadStore } from './uploadStore.js'

export interface UploadReconcileDeps {
  readonly store: ByteUploadStore
  /** Is the asset block materialized (present, not tombstoned) in the user's
   *  `blocks`? A `false` here is non-committal — it only means "don't promote
   *  yet" (a later boot retries), never "reap", so a plain `blocks` read is enough:
   *  a committed-but-unmaterialized block (locked e2ee / unhydrated) simply waits. */
  readonly isBlockPresent: (workspaceId: string, blockId: string) => Promise<boolean>
}

export interface ReconcileSummary {
  readonly promoted: number
  readonly kept: number
}

export const reconcileUploads = async (
  userId: string,
  deps: UploadReconcileDeps,
): Promise<ReconcileSummary> => {
  const staged = await deps.store.listByStatus(userId, 'staged')
  let promoted = 0
  let kept = 0

  for (const rec of staged) {
    if (await deps.isBlockPresent(rec.workspaceId, rec.assetBlockId)) {
      await deps.store.promote(userId, rec.assetBlockId)
      promoted += 1
    } else {
      kept += 1 // not (yet) materialized — promote on a later boot; never reap
    }
  }

  return { promoted, kept }
}
