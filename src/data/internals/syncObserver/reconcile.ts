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

import { SEALED_COLUMNS, type Materializability } from '@/sync/transform.js'
import { BLOCK_STORAGE_COLUMNS, type BlockRow } from '@/data/blockSchema.js'

/** Local state for the block id a staging row targets. */
export interface LocalRowState {
  /** True if PowerSync's upload queue (`ps_crud`) holds an unsent local
   *  edit for this block id. A pending edit always wins over an incoming
   *  snapshot regardless of stamps — the echo will reconcile. */
  readonly hasPendingUpload: boolean
}

export type ReconcileAction =
  /** Materialize the staging row into `blocks` — unless {@link localHoldsStagedRow}
   *  finds there is nothing to write. `decrypt` = run the content columns
   *  through the e2ee open; false = copy through. */
  | { readonly kind: 'apply'; readonly decrypt: boolean }
  /** Workspace not materializable yet — leave the row in staging. */
  | { readonly kind: 'defer' }
  /** Materializable, but a pending local edit must not be clobbered. */
  | { readonly kind: 'skip-stale' }

type SyncedColumn = (typeof BLOCK_STORAGE_COLUMNS)[number]['name']

/** The columns `blocks` and `blocks_synced` share, minus the `id` they are
 *  joined on. Derived, not listed: every reader below CLEARS something (a skip,
 *  a gap, a flag) on a match, so a column missing here is a false clear. A
 *  storage column added without an ALTER reaching both tables fails loudly in
 *  the SQL readers ("no such column", aborting client-schema bootstrap) rather
 *  than silently comparing fewer. */
const COMPARED_COLUMNS: readonly SyncedColumn[] = BLOCK_STORAGE_COLUMNS
  .map(column => column.name)
  .filter(name => name !== 'id')

const SEALED: readonly SyncedColumn[] = SEALED_COLUMNS

/** The compared columns e2ee never seals, so any reader can compare them —
 *  `updated_at` among them. */
const CLEAR_COLUMNS = COMPARED_COLUMNS.filter(name => !SEALED.includes(name))

const columnsMatch = (
  columns: readonly SyncedColumn[], local: BlockRow, staged: BlockRow,
): boolean => columns.every(name => local[name] === staged[name])

/**
 * Does the app-visible `blocks` row already hold exactly this staged row?
 *
 * The drain's one no-op test: when it holds, applying would rewrite the row
 * with what it already says, so the drain writes nothing — which is what keeps
 * the echo of this device's own write from re-materializing and re-firing the
 * derived-index triggers.
 *
 * A COMPARISON, not a stamp check, and it has to be. Equal `updated_at` is no
 * proof of an equal row: the server merges every column of a patch on its own
 * (`apply_block_patches`' COALESCE), so one version can carry columns from two
 * authors, and its un-drifted path can ack an author's write BELOW the stamp
 * that author keeps locally — leaving a version a later peer write can land on
 * exactly (#1163, and #1162 for the display stamp). A stamp-only skip there
 * drops the peer's columns before they reach disk, permanently.
 *
 * `staged` must be DECODED — compare ciphertext to local plaintext and every
 * e2ee row reads as different. A reader that cannot decode asks
 * {@link blocksAlreadyReflects} instead.
 */
export const localHoldsStagedRow = (
  local: BlockRow | null | undefined,
  staged: BlockRow,
): boolean => local != null && columnsMatch(COMPARED_COLUMNS, local, staged)

/**
 * The pre-decode gate for one staging row: defer it, let a pending local edit
 * win, or go on to apply it. Pending is decided here, before the row is opened,
 * so a ciphertext that would only be skipped is never decoded.
 *
 * No stamps: what is left after this — whether the decoded row differs from
 * the local one at all — is {@link localHoldsStagedRow}'s question. A
 * strictly-newer NON-pending local row is deliberately not protected: a
 * genuinely-newer local edit is either pending (caught here) or already acked,
 * and an acked edit's echo re-asserts it. The cost is a transient revert in
 * rescan paths (drainWorkspace) during the ack-to-echo window, kept OFF the UI
 * by the cache's LWW write (`applySyncInvalidation` → `applyIfNewer`, which
 * rejects the older value).
 *
 * @param materializability how the row's workspace can be materialized
 * @param local             local state for this block id
 */
export const decideStagingRow = (
  materializability: Materializability,
  local: LocalRowState,
): ReconcileAction => {
  if (materializability === 'defer') {
    return { kind: 'defer' }
  }
  // The app-visible `blocks` table is not PowerSync-managed under Layout B, so
  // this guards the local/remote merge PowerSync's CRUD machinery would do for
  // a managed table: never let a server snapshot overwrite an unsent edit.
  if (local.hasPendingUpload) {
    return { kind: 'skip-stale' }
  }
  return { kind: 'apply', decrypt: materializability === 'decrypt' }
}

/** Is a row the drain cannot apply invisible to every reader anyway? A staged
 *  tombstone whose local row is absent or already tombstoned shows the block to
 *  nobody on either side — and every protected pass reads `deleted = 0`. Left
 *  flagged it would be a gap that no drain can ever clear and no pass can ever
 *  be harmed by. */
const isInvisibleEitherWay = (staged: BlockRow, local: BlockRow | undefined): boolean =>
  staged.deleted === 1 && (local === undefined || local.deleted === 1)

/**
 * Does `blocks` already say everything this staged row would — asked by a
 * reader that CANNOT decode it?
 *
 * The question `blocks_synced.needs_apply` records an answer to, asked by the
 * drain for a row it could not open (workspace not materializable, ciphertext
 * that would not decode). {@link localHoldsStagedRow} is the same question for
 * a reader that can; this one sees the sealed columns only as ciphertext, so:
 *
 *   - every CLEAR column must match, `updated_at` included;
 *   - a nonzero stamp then vouches for the sealed columns it cannot read: the
 *     server strictly advances `updated_at` on a content change, so two rows at
 *     one nonzero stamp share content unless a write landed on a stamp the
 *     server never issued (below). Stamp 0 vouches for nothing — independent
 *     deterministic-id mints all sit there — but a row matching in every
 *     column needs no vouching, so an identical stamp-0 row still passes.
 *
 * What the vouch costs, accepted: a peer's write landing on a stamp this device
 * holds (#1163) that differs ONLY in sealed columns reads as reflected. A user
 * edit carries its own `user_updated_at` and `updated_by`, so only a bookkeeping
 * (`skipMetadata`) write can diverge that quietly — and the drain itself
 * compares the whole decoded row the moment it can open it. The vouch likewise
 * misreads two INDEPENDENT mints of one deterministic id in the same
 * millisecond (#744). Do not close that by advancing the create-touch's stamp
 * server-side — every fresh-client bootstrap would re-materialize; the fix is
 * on the creator side, at stamp 0, which never vouches.
 *
 * Two SQL readers restate this, since SQL cannot call it:
 * {@link STAGED_VIEW_GAP_SQL} (negated) and {@link SEED_STAGING_NEEDS_APPLY_SQL},
 * both through {@link blocksReflectsStagedSql}, which is derived from the same
 * column lists so the three cannot disagree about WHICH columns are compared.
 */
export const blocksAlreadyReflects = (
  staged: BlockRow,
  local: BlockRow | undefined,
): boolean =>
  (local !== undefined
    && columnsMatch(CLEAR_COLUMNS, local, staged)
    && (local.updated_at !== 0 || columnsMatch(SEALED, local, staged)))
  || isInvisibleEitherWay(staged, local)

/** {@link blocksAlreadyReflects}'s column arms in SQL, over a live-row alias and
 *  a staged-row alias. `IS` rather than `=` so NULL matches NULL — `parent_id`
 *  is NULL on a top-level block on both sides, and `user_updated_at` is
 *  nullable too. The tombstone arm is NOT included: the seed has its own, and
 *  the gap probe deliberately counts tombstones. */
const blocksReflectsStagedSql = (local: string, staged: string): string => {
  const match = (columns: readonly SyncedColumn[]) =>
    columns.map(name => `${local}.${name} IS ${staged}.${name}`).join(' AND ')
  return `(${match(CLEAR_COLUMNS)} AND (${local}.updated_at <> 0 OR (${match(SEALED)})))`
}

/**
 * Is any staged row one the drain would actually APPLY?
 *
 * `blocks_synced_changes` being non-empty is not "my view of `blocks` is
 * behind": every local write echoes back down the sync stream and
 * re-stages itself, so a pass that refuses on staged rows refuses on its
 * own progress.
 *
 * The exclusion is a row `blocks` already reflects — {@link localHoldsStagedRow}'s
 * no-op, as far as SQL can see it, which is {@link blocksAlreadyReflects}: SQL
 * cannot open a sealed column, so a nonzero stamp vouches for those. The drain
 * writes nothing for such a row, so counting it as a gap reports work the
 * drain is about to discard. Not exempt: a device whose clock leads the
 * server, whose own creates echo back with a LOWER stamp and read a genuine gap
 * — correctly, since the drain really would rewrite those rows.
 *
 * Everything else unproven is a gap, deliberately (a missing synced/local
 * row, and rows held by the `hasPendingUpload` skip, since excluding those
 * would mean reading `ps_crud` per call).
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
        OR NOT ${blocksReflectsStagedSql('b', 's')}
  ) LIMIT 1`

/** How many staged rows the benign-echo probe examines per call.
 *
 *  {@link stagedViewGapReason} is asked from inside a write transaction, and
 *  its own success case is the one where no row qualifies — so `LIMIT 1` never
 *  short-circuits, and an unbounded scan of a large queue would sit inside the
 *  write lock. Past the bound we report a gap rather than scanning on: that
 *  much undrained backlog IS a real gap, and the pass resumes on the next
 *  attempt. Re-measure before changing it; wa-sqlite/OPFS (the browser
 *  substrate) is what matters, not native SQLite. */
export const STAGED_SCAN_LIMIT = 10_000

/**
 * The two reads a view gap needs from a database, as METHODS rather than as a
 * handle — so a caller holding the write lock can supply its own transaction
 * without `Tx` growing a raw-SQL escape hatch. `Repo.workspaceViewGap` builds
 * the default over the Repo's own connection.
 *
 * BOTH, never one. The two queries look independent and are not: the drain
 * turns a QUEUED row into an UNAPPLIED one in a single pass — it writes
 * nothing for a row it cannot apply, then deletes the queue entry separately —
 * so whichever arm a caller skips is the one the drain has just moved the row
 * into. They are a pair for that reason, not for convenience.
 *
 * `Tx` restates these two signatures rather than extending this interface:
 * `data/api` imports nothing from `data/internals`, and that edge is not worth
 * opening for a dedupe.
 */
export interface ViewGapReads {
  stagedSyncViewGap(): Promise<string | null>
  workspaceUnappliedCount(workspaceId: string): Promise<number>
}

/** Serves {@link ViewGapReads} from any reader — the Repo's handle outside a
 *  transaction, a transaction's own handle inside one. */
export const viewGapReadsOver = (reader: {
  get<T>(sql: string, params?: unknown[]): Promise<T>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
}): ViewGapReads => ({
  stagedSyncViewGap: () => stagedViewGapReason(reader),
  workspaceUnappliedCount: async workspaceId => {
    const {behind} = await reader.get<{behind: number}>(
      WORKSPACE_UNAPPLIED_SQL, [workspaceId, WORKSPACE_UNAPPLIED_COUNT_CAP],
    )
    return behind
  },
})

/**
 * Is synced data still on its way into `blocks`, and why — the IN-FLIGHT half
 * of a view gap, as {@link STAGED_VIEW_GAP_SQL} sees it. Null when nothing is
 * staged.
 *
 * Takes its reader rather than a handle, because it is asked from both sides
 * of the write lock: `Repo.syncViewGap` asks it on the Repo's connection, and
 * `Tx.stagedSyncViewGap` asks it on the transaction's own. One owner for the
 * query AND its wording — the two callers must not be able to disagree about
 * what counts as draining.
 */
export const stagedViewGapReason = async (
  reader: {getOptional: <T>(sql: string, params?: unknown[]) => Promise<T | null>},
): Promise<string | null> => {
  const staged = await reader.getOptional<{why: string}>(
    STAGED_VIEW_GAP_SQL, [STAGED_SCAN_LIMIT, STAGED_SCAN_LIMIT],
  )
  if (staged?.why === 'deep') {
    return `more than ${STAGED_SCAN_LIMIT.toLocaleString()} synced rows are staged, `
      + 'so this device is behind on materializing them into `blocks`'
  }
  return staged !== null ? 'synced rows are still draining into `blocks`' : null
}

/**
 * How many downloaded rows remain flagged for local verification?
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
 * It reads the flag maintained by the drain or conservatively seeded on upgrade
 * — see `STAGING_LOCAL_COLUMNS`,
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
 * flagged rows with no pending delivery, including legacy rows never judged by
 * the drain. The two sets are disjoint by construction.
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

/**
 * One-time seed for `needs_apply` on a device that already has staged rows.
 *
 * The column arrives defaulting to "unapplied", which is right for every future
 * delivery and wrong for everything already on disk — so this clears it for the
 * rows a drain demonstrably already handled: the drain's own judgment for a row
 * it cannot open, {@link blocksAlreadyReflects}, tombstone arm included.
 *
 * Encrypted stamp-zero rows cannot satisfy stored-column equality against local
 * plaintext, even when decryption would show identical content. They stay flagged
 * until the drain can decrypt and judge them; the flag is not proof of data loss.
 *
 * Still an APPROXIMATION — it cannot see the upload queue or a decode result —
 * and that is tolerable only because this runs ONCE and is dead afterwards. It
 * errs toward leaving the flag SET, which reads as a gap and refuses: equality
 * rather than `>=`, because a strictly-newer local row is an acked edit that the
 * drain would APPLY over, not skip, and its echo re-delivers and re-judges it
 * anyway.
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
                AND ${blocksReflectsStagedSql('b', 'blocks_synced')}
           )
           OR (
             blocks_synced.deleted = 1
             AND COALESCE(
                   (SELECT b.deleted FROM blocks b WHERE b.id = blocks_synced.id), 1
                 ) = 1
           )
         )
`
