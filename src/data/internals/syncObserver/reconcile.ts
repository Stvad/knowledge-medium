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
    //
    // Residual blind spot (accepted, tracked): I1 assumes equal nonzero stamps
    // come from the SAME write. Two clients that independently mint the SAME
    // deterministic id in the SAME millisecond with DIVERGENT content produce
    // equal nonzero stamps from *different* writes — I1 misreads them as
    // identical and skips, so the insert-or-touch echo (apply_block_creates) is
    // consumed and the loser strands. The fix is NOT to advance the touch's
    // stamp server-side: that would force every id collision (the common
    // fresh-client bootstrap) to re-materialize + reindex on every device and
    // break the "newer stamp ⟺ changed content" coupling this whole gate relies
    // on — re-opening #244 for non-minted creators. The fix is to systemMint
    // (stamp 0) the deterministic-id creators so both mints yield via I2 above.
    // Matrix-message ingest (agent-extensions/) is the last nonzero-stamp
    // deterministic creator; until it mints at 0 this stays a real — but
    // astronomically rare (same id, same ms, divergent content) — gap.
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

/**
 * Is any staged row one the drain would actually APPLY?
 *
 * `blocks_synced_changes` being non-empty is not the same claim as "my view of
 * `blocks` is behind". Every local write echoes back down the sync stream and
 * re-stages itself, so a device that is writing has a near-permanently
 * non-empty queue built entirely from rows it already has — and a pass that
 * refuses while rows are staged then refuses because of its own progress.
 *
 * The exclusion is not a heuristic about who wrote the row: it is
 * {@link decideStagingRow}'s invariant I1 — the rule this file exists to
 * state, which is why the SQL lives beside it rather than at its call site.
 * Equal NONZERO stamps ⟺ identical content,
 * because the server strictly advances `updated_at` on any content change, so
 * such a row resolves `skip-stale` and changes nothing. Counting it as a gap
 * reports work the drain is about to discard.
 *
 * The identity holds only while the client's proposed stamp is at or below
 * server-now: `blocks_clamp_updated_at` clamps a FUTURE stamp down on insert,
 * and a create gets no floor to restore it. A device whose clock leads the
 * server therefore sees its own creates echo back with a LOWER stamp, reads a
 * genuine gap, and gains nothing here — correctly, since the drain really
 * would rewrite those rows.
 *
 * Everything unproven is a gap, deliberately: a missing synced row, a missing
 * local row, and I2's `0` sentinel (a speculative deterministic-id mint, where
 * equal stamps do NOT imply equal content and the local row always yields).
 * Rows held by I1's sibling `hasPendingUpload` skip are NOT excluded — that
 * would mean reading `ps_crud` per call, and over-reporting is the safe
 * direction for a predicate whose callers refuse on it.
 *
 * SCOPE — this reads the QUEUE, so it cannot see `observer.materializeWorkspace`,
 * which rewrites `blocks` straight from `blocks_synced` and stages nothing
 * (`clientSchema.ts`: "that is the BIG path… every cheap probe for 'still
 * materializing' is wrong"). A null answer means no QUEUED work, not that
 * `blocks` is at rest. Threading the observer's in-flight state in is the
 * standing fix for that, and is not done here.
 *
 * ONE statement, not two. Two are two read snapshots: a drain window
 * committing between them lets rows the first arm never reached slip under
 * the second arm's offset, and the pair then reports no gap while
 * genuinely-gapped rows are still staged (measured). That part is
 * correctness.
 *
 * The depth arm coming first is NOT: when both would fire, either answer is a
 * gap and every caller defers the same way. It buys the better message and
 * lets `LIMIT 1` skip the joined scan in the one case where that scan cannot
 * short-circuit (measured 0.001s vs 0.013s on a 200k queue). It also rests on
 * SQLite evaluating UNION ALL arms in order, which is observed rather than
 * promised — fine for a preference, which is why nothing correctness-bearing
 * is built on it.
 *
 * Bind `[STAGED_SCAN_LIMIT, STAGED_SCAN_LIMIT]`; the result's `why` names
 * which arm fired.
 */
export const STAGED_VIEW_GAP_SQL = `
  SELECT why FROM (
    SELECT 'deep' AS why FROM (SELECT 1 FROM blocks_synced_changes LIMIT 1 OFFSET ?)
    UNION ALL
    SELECT 'draining' AS why
      FROM (SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq LIMIT ?) c
      LEFT JOIN blocks_synced s ON s.id = c.id
      LEFT JOIN blocks b ON b.id = c.id
     WHERE c.op = 'delete'
        OR s.id IS NULL
        OR b.id IS NULL
        OR b.updated_at = 0
        OR b.updated_at <> s.updated_at
  ) LIMIT 1`

/** How many staged rows the benign-echo probe will examine per call.
 *
 *  The probe runs INSIDE the backfill's write transaction, and the echo case
 *  it exists for is precisely the one where no row qualifies — so `LIMIT 1`
 *  never short-circuits and the scan runs to the end. Measured at 0.7us/row
 *  under `@powersync/node` and ~4.5us/row under a plain sqlite3 build, so an
 *  unbounded scan of a 200k-row queue costs somewhere between 150ms and 900ms
 *  per batch against the ~430ms whole-batch budget `TARGET_INSERT_ROWS` exists
 *  to protect — and the browser's wa-sqlite/OPFS, the substrate that actually
 *  matters, is measured by neither. Revisit the bound only with a number from
 *  the environment you are bounding. The bigger the backlog the narrowing is
 *  meant to tolerate, the more the tolerating costs.
 *
 *  Past the bound we report a gap rather than scanning on. That is not a
 *  fallback to the old bug: ~10 drain windows' worth of undrained rows means
 *  this device has a real materialization backlog, and yielding so the drain
 *  can catch up is the correct answer — the pass resumes on the next attempt,
 *  which is cheap because its progress is derived from the data.
 *
 *  For an OPERATOR pass that attempt is a person clicking again, not a
 *  re-arm: `scheduleWorkspaceBackfills` filters operator triggers out, by
 *  design (the deliberate act is the point). A long uploading pass can put
 *  itself over this bound with its own echoes, so that is a real ending an
 *  operator can hit — they are told what happened and that re-running
 *  continues, which is the whole contract of a resumable pass. */
export const STAGED_SCAN_LIMIT = 10_000

/**
 * How many of a workspace's downloaded rows has `blocks` not caught up with?
 *
 * The durable half of the question {@link STAGED_VIEW_GAP_SQL} asks about work
 * in flight. That one reads the QUEUE, so it sees only rows still waiting to be
 * drained — and a row can be behind with the queue long since consumed:
 * `materializeStagingRows` writes nothing when the workspace is not
 * materializable (no key yet, mode unresolved, a key-store read that failed) or
 * when the ciphertext does not decode, while `drainQueueOnce` deletes the queue
 * rows either way. Nothing is then in progress, so no amount of waiting changes
 * the answer and no in-flight flag can report it.
 *
 * Two ways to be behind, and the second is the one an id-only anti-join misses:
 * the row was never materialized at all, or it materialized once and a NEWER
 * delivery was left staged on top of it. The second is the ordinary shape of an
 * e2ee workspace whose key is evicted mid-session — every existing block keeps
 * its stale plaintext row while arrivals pile up unreadable, so presence proves
 * nothing.
 *
 * It cannot distinguish a workspace that is one drain away from complete from
 * one that will never complete, and it does not try: both mean this device
 * cannot see the whole graph, which is the only thing its callers ask. That
 * includes the case where the rows are permanently undecryptable — a one-way
 * pass over a graph with unreadable blocks in it should refuse, and keep
 * refusing, rather than migrate what it happens to be able to read.
 *
 * Deliberately NARROWER than its sibling, because this answer is durable and
 * drives a "waiting will not help" verdict, where over-reporting would be a lie
 * rather than a cheap safety margin. Two conjuncts, and both are needed:
 *
 *   1. `blocks` is BEHIND — missing the row, holding I2's `0` sentinel (a
 *      speculative mint, which always yields), or holding an older stamp. Only
 *      the SERVER being ahead counts, not the sibling's `<>`: a newer local row
 *      is an unsent edit whose own upload echo settles it.
 *   2. and applying it would CHANGE what a live-row scan sees. Every protected
 *      pass reads `deleted = 0`, so a row tombstoned on both sides is invisible
 *      either way — and counted, one corrupt tombstone would block the
 *      workspace forever over something nothing reads. A tombstone whose local
 *      row is still LIVE stays a gap: the passes can see it and the server says
 *      it is gone. `COALESCE(b.deleted, 1)` reads a missing local row as
 *      already-absent, which is what it is.
 *
 * EXPENSIVE, unlike its sibling: `blocks_synced` carries no index but its
 * primary key (a passive landing zone by design), and the healthy answer is
 * zero, so the scan cannot short-circuit and every one of the workspace's
 * downloaded rows is read. That is why it is not folded into the per-
 * transaction predicate — call it ONCE, before a pass, not per batch. What a
 * pass falls behind on WHILE it runs is answered in memory instead, by
 * `BlocksSyncedObserver.leftBehindEpoch`.
 *
 * Bind `[workspaceId, cap]`; `cap` bounds only the COUNT (so a wholly
 * unmaterialized workspace stops counting early), never the coverage.
 */
export const WORKSPACE_MATERIALIZATION_GAP_SQL = `
  SELECT COUNT(*) AS behind FROM (
    SELECT 1 FROM blocks_synced s
      LEFT JOIN blocks b ON b.id = s.id
     WHERE s.workspace_id = ?
       AND (b.id IS NULL OR b.updated_at = 0 OR s.updated_at > b.updated_at)
       AND (s.deleted = 0 OR COALESCE(b.deleted, 1) = 0)
     LIMIT ?
  )`

/** Count cap for {@link WORKSPACE_MATERIALIZATION_GAP_SQL}. The number only
 *  shapes the message an operator reads — "some" and "all of them" are
 *  different diagnoses — so it stops where that distinction stops paying. */
export const WORKSPACE_MATERIALIZATION_GAP_COUNT_CAP = 1_000
