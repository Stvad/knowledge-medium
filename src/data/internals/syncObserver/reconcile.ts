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

// `Materializability` is sync-seam vocabulary shared with the §6 resolver;
// it lives in the data-free `@/sync/transform` layer (re-exported below for
// the observer's existing callers).
import type { Materializability } from '@/sync/transform.js'
export type { Materializability } from '@/sync/transform.js'

/** Local state for the block id a staging row targets. */
export interface LocalRowState {
  /** `updated_at` of the current app-visible `blocks` row, or null if the
   *  app has no row for this id yet. */
  readonly localUpdatedAt: number | null
  /** True if PowerSync's upload queue (`ps_crud`) holds an unsent local
   *  edit for this block id. A pending edit always wins over an incoming
   *  snapshot regardless of stamps — the echo will reconcile. */
  readonly hasPendingUpload: boolean
  /** True iff the local `blocks` row is THIS client's own pristine
   *  speculative default — `updated_by === system:<currentUserId>` (see
   *  `systemAuthor`). Such a row was minted on read-as-absent before the
   *  server's authoritative version materialized; under the strict gate it
   *  yields to an older server row (heals the shadow) where a real edit
   *  keeps strictly-newer protection. Exact-match the CURRENT user (not any
   *  `system:*`) so only a row we minted ourselves yields — a `system:other`
   *  row that arrived via sync is already server truth. */
  readonly isOwnSystemMint: boolean
}

/** Which conflict rule the gate applies when a non-pending local row is
 *  strictly newer than the incoming staging snapshot.
 *
 *   - `strict` (steady state): the server wins ONLY for this client's own
 *     pristine system mint (heals the shadow); a real local edit keeps
 *     strictly-newer protection so the upload-window replay can't clobber it.
 *
 *   - `healing` (one-time recovery rescan): the server always wins on a
 *     strictly-newer non-pending row — the interim rule. Needed because
 *     shadows minted by PRE-provenance code are stamped with the real user,
 *     so `strict` would protect them as if they were edits and re-permanent
 *     them. Pending + equal-stamp guards still hold, so the blast radius is
 *     the same as the already-shipped interim relaxation. */
export type ReconcileMode = 'strict' | 'healing'

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
 * @param mode              strict (steady state) or healing (recovery rescan)
 */
export const decideStagingRow = (
  materializability: Materializability,
  stagingUpdatedAt: number,
  local: LocalRowState,
  mode: ReconcileMode = 'strict',
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
    // The local row is newer-or-equal to this incoming snapshot. Decide whether
    // that local row is authoritative (protect it) or a speculative default the
    // server should overwrite (heal).
    if (local.localUpdatedAt === stagingUpdatedAt) {
      // EQUAL stamps. A stale in-flight server read can carry different content
      // under the same ms-stamp; applying it would overwrite a local edit on
      // disk and resurface after reload (the in-memory cache gate can't guard
      // the persistent write). The one deliberate skip in both modes — see
      // commit 429fd4b2.
      return { kind: 'skip-stale' }
    }
    // STRICTLY newer local row. The shadow/replay ambiguity the doc calls out:
    // both a speculative default and a just-uploaded edit present as
    // non-pending + strictly-newer-than-staging. The discriminator is write
    // provenance:
    //   - healing mode: server always wins (interim rule) — heals pre-provenance
    //     shadows, which are stamped with the real user and so look like edits.
    //   - strict mode: server wins ONLY for this client's own pristine system
    //     mint (heals the new-style shadow); a real edit is protected so the
    //     upload-window replay can't clobber it (the QuickFind-freeze canary).
    const serverWins = mode === 'healing' || local.isOwnSystemMint
    if (!serverWins) {
      return { kind: 'skip-stale' }
    }
    // else fall through to apply — the server's older value heals the default.
  }

  return { kind: 'apply', decrypt: materializability === 'decrypt' }
}
