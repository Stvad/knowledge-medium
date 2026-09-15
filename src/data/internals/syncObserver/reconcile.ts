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
 * The decision answers, for one staging row: apply it now (and how), leave
 * it staged (see {@link ReconcileAction}'s `defer` / `skip-stale`), or —
 * for a row that left the synced set — hard-delete the local copy.
 *
 * A *plaintext* workspace is always materializable (copy-through, no key)
 * — "no WK" is NOT the defer test, or plaintext rows would strand in
 * staging forever.
 */

import type { Materializability } from '@/sync/transform.js'
import { BLOCK_STORAGE_COLUMNS } from '@/data/blockSchema.js'

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
 * Does the app-visible `blocks` row already hold exactly this staged version?
 *
 * INVARIANT I1 — equal NONZERO stamps ⟺ identical content: the server floor+bump
 * strictly advances `updated_at` on any content change, so two rows can share a
 * nonzero stamp only if neither changed content.
 *
 * The `!== 0` exemption (invariant I2) is required, not cosmetic: two devices
 * that minted the same deterministic id both sit at 0; without the exemption the
 * insert-or-skip loser would equal-stamp-skip forever and never converge to the
 * server's created_at/created_by/user_updated_at (or even content, if the
 * default template changed between the mints). A 0-stamped local row always
 * yields.
 *
 * Standing alone, and not inlined in {@link decideStagingRow}, because it
 * answers a question that does NOT depend on materializability: a drain that
 * cannot apply a row still needs to know whether leaving it unapplied hides
 * anything (`materialize.ts`, the `needs_apply` flag), and a second expression
 * of this rule at that site is how the two come to disagree.
 *
 * TWO more statements of it live in SQL, which cannot call this, so a change
 * here needs a matching change in BOTH — and they state it differently, which is
 * why neither is obvious from the other. {@link STAGED_VIEW_GAP_SQL} carries its
 * NEGATION over a left join (`b.updated_at = 0 OR b.updated_at <> s.updated_at`),
 * with the no-local-row case split out into its own `b.id IS NULL` disjunct.
 * {@link SEED_STAGING_NEEDS_APPLY_SQL} carries it as one arm of three — this, a
 * tombstone invisible on both sides, or every synced column matching. That last
 * one is the seed's alone and is deliberately wider than the drain; see its
 * header.
 *
 * Holds only for two SYNCED writes to one id: two INDEPENDENT mints of the same
 * deterministic id in the same millisecond also share a nonzero stamp, and I1
 * misreads them as identical (accepted, #744). Do not close that by advancing
 * the touch's stamp server-side — it would break the "newer stamp ⟺ changed
 * content" coupling this gate rests on, and make every fresh-client bootstrap
 * re-materialize. The fix belongs on the creator side, at stamp 0.
 */
export const localHoldsStagedVersion = (
  localUpdatedAt: number | null,
  stagedUpdatedAt: number,
): boolean =>
  // `!== null` states the no-local-row case rather than guarding it: the staged
  // stamp is never null, so the equality below already answers false. Deleting
  // it fails nothing.
  localUpdatedAt !== null && localUpdatedAt !== 0 && localUpdatedAt === stagedUpdatedAt

/** One row's version as the "already reflects" question reads it — the staged
 *  row, and the live `blocks` row when there is one. */
export interface RowVersion {
  readonly updatedAt: number
  readonly deleted: boolean
}

/** Is a row the drain cannot apply invisible to every reader anyway? A staged
 *  tombstone whose local row is absent or already tombstoned shows the block to
 *  nobody on either side — and every protected pass reads `deleted = 0`. Left
 *  flagged it would be a gap that no drain can ever clear and no pass can ever
 *  be harmed by. */
const isInvisibleEitherWay = (staged: RowVersion, local: RowVersion | undefined): boolean =>
  staged.deleted && (local === undefined || local.deleted)

/**
 * Does `blocks` already say everything this staged row would?
 *
 * The question `blocks_synced.needs_apply` records an answer to, and the reason
 * a drain that CANNOT apply a row still has something to decide. Two ways to be
 * satisfied without applying anything, and {@link SEED_STAGING_NEEDS_APPLY_SQL}
 * carries both in SQL — which is why this lives here beside it rather than at
 * its one call site in `materialize.ts`.
 *
 * The seed has a THIRD, comparing every synced column, which this cannot: it is
 * handed a {@link RowVersion}, and reading full rows here to match would put a
 * per-row full-row read in the drain's hot path for a shape only a one-shot
 * pass meets. So the two genuinely differ, on purpose — see the seed's header
 * for what that costs.
 */
export const blocksAlreadyReflects = (
  staged: RowVersion,
  local: RowVersion | undefined,
): boolean =>
  localHoldsStagedVersion(local?.updatedAt ?? null, staged.updatedAt)
  || isInvisibleEitherWay(staged, local)

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
  if (localHoldsStagedVersion(local.localUpdatedAt, stagingUpdatedAt)) {
    // I1 (see the predicate): this snapshot is the version `blocks` already
    // holds. The one deliberate skip — a stale in-flight server read carrying
    // different content under the same ms-stamp would otherwise clobber a local
    // edit on disk and resurface after reload (the in-memory cache gate can't
    // guard the persistent write).
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
 * `blocks_synced_changes` being non-empty is not "my view of `blocks` is
 * behind": every local write echoes back down the sync stream and
 * re-stages itself, so a pass that refuses on staged rows refuses on its
 * own progress.
 *
 * The exclusion is {@link decideStagingRow}'s invariant I1 (equal NONZERO
 * stamps ⟺ identical content, since the server strictly advances
 * `updated_at` on any content change) — the rule this file exists to
 * state, which is why the SQL lives beside the predicate. Such a row
 * resolves `skip-stale`, so counting it as a gap reports work the drain
 * is about to discard. Exempt: a device whose clock leads the server,
 * whose own creates echo back with a LOWER stamp and read a genuine gap —
 * correctly, since the drain really would rewrite those rows.
 *
 * Everything else unproven is a gap, deliberately (a missing synced/local
 * row, I2's `0` sentinel, and rows held by the `hasPendingUpload` skip,
 * since excluding those would mean reading `ps_crud` per call).
 *
 * SCOPE — this reads the QUEUE, so it cannot see
 * `observer.materializeWorkspace`, which rewrites `blocks` straight from
 * `blocks_synced` and stages nothing; a null answer means no QUEUED work,
 * not that `blocks` is at rest.
 *
 * ONE statement, not two: two read snapshots let a drain window
 * committing between them slip rows under the second arm's offset. Arm
 * order is a preference, not correctness — nothing rests on UNION ALL
 * evaluation order.
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

/** How many staged rows the benign-echo probe examines per call.
 *
 *  The probe runs inside a write transaction, and its own success case is
 *  the one where no row qualifies — so `LIMIT 1` never short-circuits, and
 *  an unbounded scan of a large queue would sit inside the write lock.
 *  Past the bound we report a gap rather than scanning on: that much
 *  undrained backlog IS a real gap, and the pass resumes on the next
 *  attempt. Re-measure before changing it; wa-sqlite/OPFS (the browser
 *  substrate) is what matters, not native SQLite. */
export const STAGED_SCAN_LIMIT = 10_000

/**
 * How many of a workspace's downloaded rows has the drain not applied?
 *
 * The durable half of the question {@link STAGED_VIEW_GAP_SQL} asks about work
 * in flight. That one reads the QUEUE, so it sees only rows still waiting to be
 * drained — and a row can be behind with the queue long since consumed:
 * `materializeStagingRows` writes nothing when the workspace is not
 * materializable (no key yet, mode unresolved, a key-store read that failed) or
 * when the ciphertext does not decode, while `drainQueueOnce` deletes the queue
 * rows either way. Nothing is then in progress, so no amount of waiting changes
 * the answer.
 *
 * It reads the flag the drain itself sets — see `STAGING_NEEDS_APPLY_COLUMN`,
 * which carries the rule. Deliberately NOT a comparison of staged against live
 * rows: the drain already makes exactly this decision per row, with inputs
 * (the upload queue, the decode result) that no query over the two tables can
 * see, and a second predicate approximating the first from outside is how the
 * two come to disagree.
 *
 * A row still in the QUEUE is not this arm's business, and excluding it is not
 * an optimization — it is what keeps the two predicates from double-counting.
 * Every delivery lands unapplied by default, so a device that is merely WRITING
 * has its own echoes sitting flagged until the drain judges them; counted here
 * they would make a long uploading pass refuse on its own progress, which is
 * exactly the bug {@link STAGED_VIEW_GAP_SQL}'s benign-echo exclusion exists to
 * prevent. So the queue arm owns rows the drain has not reached, this one owns
 * rows it reached and could not apply, and the two are disjoint by construction.
 *
 * CHEAP, unlike the join it replaced: `idx_blocks_synced_needs_apply` holds
 * only unapplied rows, so the healthy answer is an empty range. That is what
 * lets every caller ask it at the same altitude — once before a pass AND again
 * inside each writing transaction — instead of a cheap approximation in the
 * hot path and an expensive truth at the top.
 *
 * Bind `[workspaceId, cap]`; `cap` bounds only the COUNT (so a wholly
 * unapplied workspace stops counting early), never the coverage.
 */
const WORKSPACE_UNAPPLIED_WHERE = `
     WHERE s.workspace_id = ? AND s.needs_apply = 1
       AND NOT EXISTS (SELECT 1 FROM blocks_synced_changes c WHERE c.id = s.id)`

export const WORKSPACE_UNAPPLIED_SQL = `
  SELECT COUNT(*) AS behind FROM (
    SELECT 1 FROM blocks_synced s
    ${WORKSPACE_UNAPPLIED_WHERE}
     LIMIT ?
  )`

/**
 * The same rows {@link WORKSPACE_UNAPPLIED_SQL} counts, by id — what an
 * operator-invoked rematerialization re-delivers to the drain.
 *
 * Shares the WHERE clause rather than restating it, because the remedy naming a
 * different set than the refusal counts is the failure that matters here: rows
 * the operator is told about but the pass never looks at, or the reverse.
 *
 * Unbounded, unlike the count: the caller materializes every id it gets back,
 * in the same windows the queue drain uses, so the list is the work rather than
 * a message. Bind `[workspaceId]`.
 */
export const WORKSPACE_UNAPPLIED_IDS_SQL = `
  SELECT s.id FROM blocks_synced s
  ${WORKSPACE_UNAPPLIED_WHERE}
   ORDER BY s.id`

/** The same rows again, counted to the end rather than to the cap.
 *
 *  For a before/after PAIR, which is a subtraction — see
 *  `Repo.workspaceUnappliedExactCount` for why the capped sibling gives the
 *  wrong answer there. Bind `[workspaceId]`. */
export const WORKSPACE_UNAPPLIED_EXACT_COUNT_SQL = `
  SELECT COUNT(*) AS behind FROM blocks_synced s
  ${WORKSPACE_UNAPPLIED_WHERE}`

/** Count cap for {@link WORKSPACE_UNAPPLIED_SQL}. The number only shapes the
 *  message an operator reads — "some" and "all of them" are different
 *  diagnoses — so it stops where that distinction stops paying. */
export const WORKSPACE_UNAPPLIED_COUNT_CAP = 1_000

/** Every synced column equal, `IS` rather than `=` so NULL matches NULL — the
 *  witness is `parent_id`, NULL on a top-level block on both sides, and
 *  `user_updated_at` is nullable too.
 *
 *  Derived from {@link BLOCK_STORAGE_COLUMNS}, not listed: this clause CLEARS a
 *  flag, so a column missing from it is a false clear. `id` is excluded — it is
 *  the join. The list is the columns the two tables SHARE; a storage column
 *  added without an ALTER reaching both fails loudly here ("no such column",
 *  aborting client-schema bootstrap) rather than silently comparing fewer. */
const STORAGE_COLUMNS_IDENTICAL = BLOCK_STORAGE_COLUMNS
  .map(column => column.name)
  .filter(name => name !== 'id')
  .map(name => `b.${name} IS blocks_synced.${name}`)
  .join(' AND ')

/**
 * One-time seed for `needs_apply` on a device that already has staged rows.
 *
 * The column arrives defaulting to "unapplied", which is right for every future
 * delivery and wrong for everything already on disk — so this clears it for the
 * rows a drain demonstrably already handled. THREE ways to demonstrate it:
 *
 *   - the live row carries the SAME nonzero stamp (I1 — identical content, the
 *     drain would skip it);
 *   - the row is a tombstone on both sides, invisible to every reader either way;
 *   - every synced column is identical.
 *
 * The third does NOT violate I2, and someone will eventually think it does. I2
 * exempts stamp 0 because equal stamps THERE do not imply equal content — two
 * devices minting the same deterministic id both sit at 0. That is a claim about
 * what a STAMP proves. Comparing the columns proves it directly, without the
 * stamp, and a row whose every column matches needs no applying by definition:
 * `blocks` already holds the staged version, which is the whole claim the flag
 * makes. (A LOSING deterministic mint differs in `created_at`, so this arm does
 * not fire on the case I2 is about.)
 *
 * DELIBERATELY WIDER THAN THE DRAIN, which is the one place this file tolerates
 * that. {@link blocksAlreadyReflects} answers the first two arms only: it is
 * handed a {@link RowVersion}, and giving it the third would mean a full-row
 * read per row in the drain's hot path to serve a shape only a one-shot pass
 * meets. The cost of the fork is that the drain re-flags such a row if it
 * re-delivers into a non-materializable window, and the marker means this pass
 * will not clear it again — over-reporting, so a refusal rather than a loss, and
 * the operator verb clears it.
 *
 * Still an APPROXIMATION in its first two arms — they cannot see the upload
 * queue or a decode result — and that is tolerable only because this runs ONCE
 * and is dead afterwards. It errs toward leaving the flag SET, which reads as a
 * gap and refuses: equality rather than `>=`, because a strictly-newer local row
 * is an acked edit that `decideStagingRow` would APPLY over, not skip, and its
 * echo re-delivers and re-judges it anyway.
 *
 * ONE statement, deliberately, even at the 320k-row scale it exists for: it
 * runs once, at boot, with nothing else contending for the write lock, and was
 * measured at 296ms there on native SQLite. A chunked version needs a
 * termination signal, and the two cheap ones are both unavailable — PowerSync
 * exposes no affected-row count, and `changes()` is per-connection while reads
 * and writes may not share one. Counting the remaining rows per chunk instead
 * makes the pass quadratic, which is how it was written first and why this note
 * exists.
 */
export const SEED_STAGING_NEEDS_APPLY_SQL = `
  UPDATE blocks_synced SET needs_apply = 0
   WHERE needs_apply = 1
     AND (
           EXISTS (
             SELECT 1 FROM blocks b
              WHERE b.id = blocks_synced.id
                AND b.updated_at <> 0
                AND b.updated_at = blocks_synced.updated_at
           )
           OR (
             blocks_synced.deleted = 1
             AND COALESCE(
                   (SELECT b.deleted FROM blocks b WHERE b.id = blocks_synced.id), 1
                 ) = 1
           )
           OR EXISTS (
             SELECT 1 FROM blocks b
              WHERE b.id = blocks_synced.id
                AND ${STORAGE_COLUMNS_IDENTICAL}
           )
         )
`
