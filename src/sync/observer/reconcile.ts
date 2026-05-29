/**
 * Layout B observer — per-row reconciliation decision (design doc §9.2).
 *
 * Under Layout B, PowerSync writes every downloaded blocks row (plaintext
 * AND e2ee) into a `blocks_synced` staging table, and a JS observer turns
 * each staging row into the app-visible plaintext `blocks` table. This
 * module is the PURE decision at the heart of that observer — separated
 * from the PowerSync/DB wiring so it can be exhaustively unit-tested,
 * since the observer is the load-bearing complexity the doc flags and the
 * part that can't be integration-tested without a live sync backend.
 *
 * The decision answers, for one staging row: apply it now (and how), or
 * leave it staged, or — for a row that left the synced set — hard-delete
 * the local copy.
 *
 * Two distinct "don't apply" reasons, which the original "just decrypt and
 * copy" framing conflated:
 *
 *   - DEFER: the workspace isn't materializable yet — it's e2ee but the WK
 *     isn't loaded (locked pin, or never-pinned key-required), or it's
 *     encryption-uncertain (quarantine). The row stays in staging and is
 *     re-processed when the workspace becomes materializable (WK paste /
 *     plaintext confirm). NOTE: a *plaintext* workspace is always
 *     materializable (copy-through, no key) — "no WK" is NOT the defer
 *     test, or plaintext rows would strand in staging forever.
 *
 *   - SKIP_STALE: the workspace IS materializable, but a pending local
 *     edit is newer than this staging snapshot. Applying would clobber an
 *     unsynced local edit; instead let the upload echo reconcile when it
 *     returns. This is the ps_crud / updated_at gate the doc calls out.
 */

/** How a workspace's rows should be materialized into `blocks`. */
export type Materializability =
  /** e2ee with the WK loaded — decrypt the content columns. */
  | 'decrypt'
  /** plaintext workspace — copy the row through unchanged (no key). */
  | 'copy'
  /** e2ee without WK (locked / key-required) or encryption-uncertain —
   *  can't turn into plaintext yet; leave staged. */
  | 'defer'

/** Local state for the block id a staging row targets. */
export interface LocalRowState {
  /** `updated_at` of the current app-visible `blocks` row, or null if the
   *  app has no row for this id yet. */
  readonly localUpdatedAt: number | null
  /** True if PowerSync's upload queue (`ps_crud`) holds an unsent local
   *  edit for this block id. A pending edit always wins over an incoming
   *  snapshot regardless of stamps — the echo will reconcile. */
  readonly hasPendingUpload: boolean
}

export type ReconcileAction =
  /** Materialize the staging row into `blocks`. `decrypt` = run the
   *  content columns through the e2ee open; false = copy through. */
  | { readonly kind: 'apply'; readonly decrypt: boolean }
  /** Workspace not materializable yet — leave the row in staging. */
  | { readonly kind: 'defer' }
  /** Materializable, but a newer/pending local edit must not be clobbered. */
  | { readonly kind: 'skip-stale' }

/**
 * Decide what to do with one inserted/updated staging row.
 *
 * @param materializability how the row's workspace can be materialized
 * @param stagingUpdatedAt  `updated_at` of the incoming staging row
 * @param local             local state for this block id
 */
export const decideStagingRow = (
  materializability: Materializability,
  stagingUpdatedAt: number,
  local: LocalRowState,
): ReconcileAction => {
  if (materializability === 'defer') {
    return { kind: 'defer' }
  }

  // Materializable workspace. Guard the local/remote merge that PowerSync's
  // CRUD machinery normally does for raw tables — the app-visible `blocks`
  // table is no longer PowerSync-managed under Layout B.
  if (local.hasPendingUpload) {
    // An unsent local edit exists for this id: never let an older server
    // snapshot overwrite it. The upload echo reconciles when it returns.
    return { kind: 'skip-stale' }
  }
  if (local.localUpdatedAt !== null && local.localUpdatedAt >= stagingUpdatedAt) {
    // Local row is at least as new as this snapshot. First-writer-wins on
    // EQUAL stamps too, mirroring BlockCache.applyIfNewer's `<=`: a stale
    // in-flight server read can carry different content under the same
    // ms-stamp. Unlike the cache (in-memory, transient), the Layout B observer
    // materializes into the persistent SQLite `blocks` table, so applying an
    // equal-stamp snapshot would overwrite the local edit on disk and resurface
    // it after a reload — the cache gate can't guard that write. Skip it.
    return { kind: 'skip-stale' }
  }

  return { kind: 'apply', decrypt: materializability === 'decrypt' }
}
