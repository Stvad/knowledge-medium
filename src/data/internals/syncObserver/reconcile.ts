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
 *   - SKIP_STALE: the workspace IS materializable, but the local row wins —
 *     it has a pending upload, or a nonzero `updated_at` at-or-above this
 *     staging snapshot's (a stale/equal-stamp delivery under server-enforced
 *     monotonicity). Applying would clobber an authoritative local row on disk
 *     and flash the UI; instead let the upload echo / a strictly-newer server
 *     row reconcile. This is the ps_crud / updated_at gate the doc calls out.
 */

// `Materializability` is sync-seam vocabulary shared with the §6 resolver;
// it lives in the data-free `@/sync/transform` layer. `materialize.ts`
// re-exports it for the observer's callers; reconcile only consumes it.
import type { Materializability } from '@/sync/transform.js'

/** Local state for the block id a staging row targets. */
export interface LocalRowState {
  /** `updated_at` (row-version) of the current app-visible `blocks` row, or
   *  null if the app has no row for this id yet. `0` is the pristine sentinel
   *  (a speculative deterministic-id mint, never user-edited). */
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
 * The gate's input is now trustworthy: the server enforces `updated_at`
 * monotonicity (an unconditional floor + a +1 bump on any content change), so
 * a staging row's stamp is a reliable row-version. That collapses the old
 * strict/healing + provenance machinery to three cases.
 *
 * @param materializability how the row's workspace can be materialized
 * @param stagingUpdatedAt  `updated_at` (row-version) of the incoming staging row
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
    // An unsent local edit exists for this id: never let a server snapshot
    // overwrite it. The upload echo reconciles when it returns.
    return { kind: 'skip-stale' }
  }
  if (
    local.localUpdatedAt !== null &&
    local.localUpdatedAt >= stagingUpdatedAt &&
    local.localUpdatedAt !== 0
  ) {
    // NEWER-OR-EQUAL nonzero local row wins. Under server-enforced updated_at
    // monotonicity (an unconditional floor + a +1 bump on any content change),
    // the server can never hand back a stamp <= a nonzero local one for newer
    // content — so a staging stamp at-or-below a nonzero local stamp is, by
    // definition, a stale delivery, and the local row is authoritative:
    //   - strictly-newer (local > staging): an acked local edit facing a stale
    //     in-flight replay, or a value already materialized from a newer server
    //     delivery. Protecting it keeps the edit on disk AND off the UI — no
    //     transient revert, no stale-echo flash; the real echo (stamp >= local)
    //     re-asserts it through the normal queue.
    //   - equal nonzero (local == staging): identical content by invariant I1;
    //     the one guard against an equal-ms stale read carrying DIFFERENT
    //     content clobbering a local edit on disk and resurfacing on reload
    //     (the in-memory cache gate can't guard the persistent write — 429fd4b2).
    //
    // The `!== 0` exemption (invariant I2) is load-bearing: a 0-stamped pristine
    // local default ALWAYS yields to the server (falls through to apply) — the
    // deterministic-id heal and the cross-device convergence path (two devices
    // minting the same id both sit at 0). This protection is safe to hold now
    // that new shadows can't form (mints are 0-stamped via the systemMint
    // 0-hold) and the legacy nonzero-shadow population was reconciled by the
    // recovery rollout before it shipped — so protecting nonzero local rows
    // strands nothing. (This is the protection e7fc79b2 had to relax back when
    // speculative defaults were minted with a real `now` stamp.)
    return { kind: 'skip-stale' }
  }

  // Otherwise apply: the server row is strictly newer (real new truth), or a
  // 0-stamped pristine default yielding to the server.
  return { kind: 'apply', decrypt: materializability === 'decrypt' }
}
