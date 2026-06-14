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
    local.localUpdatedAt === stagingUpdatedAt &&
    local.localUpdatedAt !== 0
  ) {
    // EQUAL NONZERO stamps ⟺ identical content (invariant I1): the server
    // floor+bump strictly advances the stamp on any content change, so two
    // rows can share a nonzero stamp only if neither changed content. The one
    // deliberate skip — a stale in-flight server read carrying different
    // content under the same ms-stamp would otherwise clobber a local edit on
    // disk and resurface after reload (the in-memory cache gate can't guard the
    // persistent write). See commit 429fd4b2.
    //
    // The `!== 0` exemption (invariant I2) is required, not cosmetic: two
    // devices that minted the same deterministic id both sit at 0; without the
    // exemption the insert-or-skip loser would equal-stamp-skip forever and
    // never converge to the server's created_at/created_by/user_updated_at (or
    // even content, if the default template changed between the mints). A
    // 0-stamped local row always yields.
    return { kind: 'skip-stale' }
  }

  // Otherwise apply: the server row is newer truth, or this is a 0-stamped
  // pristine default yielding to the server. Strictly-newer-local protection
  // is intentionally gone — a genuinely-newer local edit is either pending
  // (caught above) or already acked, and an acked edit's echo (server stamp
  // >= local via the floor+bump) re-asserts it. The only cost is a transient
  // revert in rescan paths (drainWorkspace) during the ack-to-echo window;
  // steady-state queue-driven drains can't hit it (the next delivery for the
  // id IS the echo). That disk transient stays OFF the UI: the cache write is
  // LWW (`applySyncInvalidation` → `applyIfNewer`), which rejects the older
  // value, so the row self-heals on the echo without a visible flash. (A
  // permanently-rejected edit rolls back on the next reload, when the cache
  // rehydrates from the server-healed disk.)
  return { kind: 'apply', decrypt: materializability === 'decrypt' }
}
