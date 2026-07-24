/**
 * Arrival-processor seam (PR #288 slice A follow-up — a no-op extraction of
 * what used to be a hand-inlined block in `materialize.ts`).
 *
 * `materializeStagingRows`'s Phase-2 write tx runs a small, fixed set of
 * "arrival processors" AFTER every candidate in the window has been
 * upserted, but still INSIDE that same write tx and strictly before
 * `applyOutcome`'s invalidation fan-out — so a reader never observes a
 * content change whose derived column lags behind. It is deliberately NOT
 * the same-tx processor machinery (`@/data/api/sameTxProcessor.ts`) — this
 * seam is much narrower:
 *
 *   - no `Tx` facade — a processor writes via the raw `TxDb.execute` the
 *     surrounding Phase-2 tx already has open (see the CRITICAL INVARIANT
 *     below for why that's load-bearing, not just a shortcut);
 *   - no registry-snapshot-at-tx-start semantics, no scheduling, no
 *     `ProcessorRejection`/rollback story — sync-applied rows are not a
 *     user-initiated `repo.tx`, so there is no user fn to roll back;
 *   - no `watches` declaration and no field-change pre-filter. That was
 *     tried and removed: the arrival processor here must visit rows whose
 *     content did NOT change (to correct their `snapshots` entry), so a
 *     watch could not gate anything, and a decorative declaration bought
 *     only a second copy of `processorRunner.ts`'s field-diff. A processor
 *     that needs a field diff computes the one it actually means. If a
 *     later member wants the same diff, extract and SHARE the existing
 *     helper rather than growing a parallel one here.
 *
 * CRITICAL INVARIANT: an arrival processor may write ONLY device-local
 * state, and must never cause `tx_context.source` to be set. The
 * upload-routing triggers in `clientSchema.ts` fire ONLY when
 * `tx_context.source IS NOT NULL`, and `materializeStagingRows` nulls that
 * column before Phase 2 (defence in depth — NULL is already the resting
 * state, and `runTx` sets its own source unconditionally at the top of every
 * local tx rather than inheriting whatever was left behind). `runArrival-
 * Processors` re-checks the column after each processor under
 * `devAssertionsEnabled()`, so a member that violates this fails loudly in
 * CI/dev instead of silently echo-uploading a sync-applied row back to the
 * server as a fresh local edit.
 *
 * "Device-local" means the COLUMN, not the table. `reference_target_id` is
 * absent from `BLOCK_UPLOAD_COLUMNS` (`clientSchema.ts`), so deriving it
 * here is genuinely local. `properties_json` and `references_json` ARE in
 * that list — so a future member deriving one of those (the PROJECT /
 * NORMALIZE candidates in issue #404 items 6 and 2) is a CATEGORICALLY
 * different move, not an incremental one: the value would never reach the
 * server, leaving its copy permanently stale with no path to correct it,
 * and every peer computing its own. Note the `no-raw-synced-table-writes`
 * lint rule is disabled for this whole directory (`eslint.config.js`) and is
 * table-granular anyway, so it will NOT catch that — decide it deliberately.
 *
 * NEVER open a `repo.tx` (or any `db.writeTransaction`) from inside a handler.
 * Besides stamping a source, it DEADLOCKS: PowerSync serialises every write
 * tx on one non-reentrant mutex, and no call site passes a timeout — the
 * inner call would wait for a permit only the suspended outer call can
 * release, freezing every subsequent write on the client. Writes go through
 * the raw `tx.execute` the surrounding write tx already holds. Work that
 * genuinely needs its own tx belongs in a deferred repair scheduled AFTER
 * the drain (see `onAliasTargetsAdded` in `materialize.ts`), not here.
 */

import type { BlockData } from '@/data/api'
import { devAssertionsEnabled } from '@/data/internals/devAssertions.js'
import type { TxDb } from '@/data/internals/txEngine.js'
import { deriveReferenceColumns } from '@/data/internals/referenceTargetProcessor.js'
import type { MaterializeDeps, SyncSnapshot } from './materialize.js'

/** One id the arrival-processor pass runs over this window: its pre-write
 *  snapshot (`before`, null on a fresh arrival) and the post-upsert snapshot
 *  (`after`) Phase 2 already produced. */
export interface ArrivalChangedRow {
  readonly id: string
  readonly before: BlockData | null
  readonly after: BlockData
}

/** What an arrival processor gets to do its job: the open Phase-2 write tx
 *  (reads see this window's own uncommitted upserts — needed so a
 *  definition/alias target arriving alongside its referencing rows
 *  resolves within the same window) and the full `MaterializeDeps` bag, so
 *  each processor pulls whatever dep it specifically needs — and can gate
 *  on that dep being absent, as `deriveReferenceTargetArrivalProcessor`
 *  does with `referenceTargetLookups` — without the runner having to know
 *  processor-specific deps. */
export interface ArrivalProcessorCtx {
  readonly tx: TxDb
  readonly deps: MaterializeDeps
}

/** Per-row work an arrival processor does. The runner calls it once per
 *  applied id, wrapped in a try/catch so a single throwing row is quarantined
 *  rather than aborting the pass — see {@link runArrivalProcessors}. It
 *  mutates `snapshots` in place for the id it settles. */
export type ArrivalRowHandler = (
  row: ArrivalChangedRow,
  snapshots: Map<string, SyncSnapshot>,
) => Promise<void>

/**
 * A single arrival-path processor, split into once-per-window setup
 * (`prepare`) and per-row work (the {@link ArrivalRowHandler} it returns).
 *
 * The split exists for per-row quarantine. If `prepare` handed back one
 * `apply(allRows)` and that threw on a malformed row, the throw would abort
 * the whole Phase-2 write tx; the observer would retry the window; the same
 * row would throw again — a deterministic poison row wedging the drain (and
 * everything queued behind it) forever, AND starving every row ordered after
 * it in the window, since a window-level catch can't get past it either. So
 * the runner drives the per-row loop itself and catches around each row,
 * exactly as the decrypt path a few frames up quarantines an undecryptable
 * row. Expensive once-per-window setup (building alias lookups) lives in
 * `prepare` so it isn't paid per row.
 *
 * `prepare` returns `null` to opt the processor out of this window entirely
 * (e.g. a required dep is absent) — cheaper and clearer than a handler that
 * no-ops every row.
 *
 * A quarantined row is a graceful degradation, not corruption: its synced
 * content already committed in the Phase-2 upsert; only this processor's
 * device-local derivation is skipped, and the handler is written so the row's
 * `snapshots` entry still reflects the untouched DB column (see the derive
 * handler). The row re-derives on its next content edit or a `drainWorkspace`
 * re-pass.
 */
export interface ArrivalProcessor {
  readonly name: string
  readonly prepare: (ctx: ArrivalProcessorCtx) => Promise<ArrivalRowHandler | null>
}

/**
 * Run every registered arrival processor over the current `snapshots` map.
 * Called once, AFTER the Phase-2 apply loop has upserted every candidate in
 * the window (so alias/index triggers from this window's own upserts have
 * already fired) and BEFORE the `removed` hard-delete loop populates any
 * further entries — `snapshots` at this point holds exactly the ids the
 * window applied, each with a non-null `after`. Returns the ids quarantined
 * (a handler threw); the pass never rejects for a per-row failure.
 */
export const runArrivalProcessors = async (
  tx: TxDb,
  snapshots: Map<string, SyncSnapshot>,
  deps: MaterializeDeps,
  processors: readonly ArrivalProcessor[],
): Promise<string[]> => {
  const ctx: ArrivalProcessorCtx = { tx, deps }
  const quarantined: string[] = []
  for (const processor of processors) {
    // Rebuild per processor from the LIVE map, so a later member sees an
    // earlier one's snapshot amendments.
    const rows: ArrivalChangedRow[] = []
    for (const [id, snap] of snapshots) {
      if (!snap.after) continue
      rows.push({id, before: snap.before, after: snap.after})
    }
    if (rows.length === 0) continue
    const handle = await processor.prepare(ctx)
    if (handle === null) continue
    for (const row of rows) {
      try {
        await handle(row, snapshots)
      } catch (err) {
        // Quarantine THIS row so a deterministic poison row can't wedge the
        // drain or starve the rows after it. The handler leaves the row's
        // snapshot reflecting the untouched DB column, so skipping it is a
        // consistent no-derivation, not a lie to the invalidation fan-out.
        console.warn(
          `[arrivalProcessors] ${processor.name} quarantined ${row.id}:`, err,
        )
        quarantined.push(row.id)
      }
    }
    if (devAssertionsEnabled()) {
      // L2 dev/test-only enforcement of the module's CRITICAL INVARIANT (off
      // in prod). A processor that stamps `tx_context.source` — directly, or
      // by reaching for a write path that does — turns every remaining write
      // in this window into an upload, echoing sync-applied rows back to the
      // server as fresh local edits. That failure is silent at runtime and
      // would surface only as mysterious upload traffic and clobbered peers,
      // so catch it at the point of violation, naming the processor. This
      // runs OUTSIDE the per-row try/catch, so an invariant violation is
      // fatal (rolls back the tx) even if it surfaced via a quarantined row.
      const ctxRow = await tx.getOptional<{source: string | null}>(
        'SELECT source FROM tx_context WHERE id = 1',
      )
      if (ctxRow?.source != null) {
        throw new Error(
          `[arrivalProcessors] ${processor.name} left tx_context.source = `
          + `${JSON.stringify(ctxRow.source)} — an arrival processor must write only `
          + 'device-local state and must never stamp a tx source (see this module\'s '
          + 'CRITICAL INVARIANT). Every later write in this window would upload.',
        )
      }
    }
  }
  return quarantined
}

/**
 * `core.deriveReferenceTarget`'s arrival-path mirror (PR #288 slice A):
 * sync-applied rows never pass through `repo.tx`, so the same-tx processor
 * of that name (`@/data/internals/referenceTargetProcessor.ts`) never fires
 * for them — this stamps the LOCAL `reference_target_id` column for
 * content-changed arrivals instead, inside the same Phase-2 write tx.
 *
 * Content-changed rows (including a fresh arrival,
 * `before === null`) re-derive via `deriveReferenceColumns` — the same
 * resolution seam the same-tx processor uses, so the two write paths agree
 * on BOTH local columns (`reference_target_id` + `is_field_form`)
 * — and deleted/tombstoned arrivals derive too: a content edit that syncs
 * while the row is tombstoned would otherwise leave a stale column that a
 * later content-unchanged restore never repairs. Content-unchanged rows
 * keep the current column value (the UPSERT never touches
 * `reference_target_id` — it's outside `UPDATE_ASSIGNMENTS` — so an
 * unchanged-content arrival's column already holds the right value); the
 * SQL `UPDATE` only runs when the derived value actually differs from that
 * current value. Either way the `snapshots` entry is corrected to carry the
 * final value — the staging row has no such column, so the Phase-2 apply
 * loop's `parseBlockRow(plaintext)` said `null` regardless of what the
 * table holds, and the invalidation fan-out reads `snapshots`, not the
 * table.
 *
 * Gated on `deps.referenceTargetLookups` being provided: `prepare` returns
 * `null` for a storage-only harness that doesn't wire it up, opting the
 * processor out of the window.
 */
export const deriveReferenceTargetArrivalProcessor: ArrivalProcessor = {
  name: 'sync.deriveReferenceTargetAtArrival',
  prepare: async (ctx) => {
    if (!ctx.deps.referenceTargetLookups) return null
    const lookups = ctx.deps.referenceTargetLookups(ctx.tx)
    return async (row, snapshots) => {
      const { id, before, after } = row
      const currentColumn = before?.referenceTargetId ?? null
      const currentBit = before?.isFieldForm ?? false
      // Set the snapshot to the DB columns FIRST — the upsert left both local
      // columns untouched (outside `UPDATE_ASSIGNMENTS`), so the `before` row
      // is what the table actually holds, while the Phase-2 `parseBlockRow`
      // of the staging row put `null`/`false` there (staging has no local
      // columns). Doing this before the throwable derive means a quarantined
      // row's snapshot still matches the DB rather than lying to the
      // invalidation fan-out.
      snapshots.set(id, {
        before,
        after: { ...after, referenceTargetId: currentColumn, isFieldForm: currentBit },
      })
      const contentChanged = before === null || before.content !== after.content
      if (!contentChanged) return
      const derived = await deriveReferenceColumns(after.content, after.workspaceId, lookups)
      const derivedTarget = derived.targetId ?? null
      if (derivedTarget !== currentColumn || derived.isFieldForm !== currentBit) {
        await ctx.tx.execute(
          'UPDATE blocks SET reference_target_id = ?, is_field_form = ? WHERE id = ?',
          [derivedTarget, derived.isFieldForm ? 1 : null, id],
        )
        snapshots.set(id, {
          before,
          after: {
            ...after,
            referenceTargetId: derivedTarget,
            isFieldForm: derived.isFieldForm,
          },
        })
      }
    }
  },
}

/** The arrival-processor registry — derive is currently the seam's only
 *  member. */
export const ARRIVAL_PROCESSORS: readonly ArrivalProcessor[] = [
  deriveReferenceTargetArrivalProcessor,
]
