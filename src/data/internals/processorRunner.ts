/**
 * Post-commit processor framework (spec §5.7, §7).
 *
 * Two firing channels:
 *   1. Field-watching processors fire when a tx wrote to one of the
 *      named fields on `blocks`. Engine determines this by walking the
 *      tx's snapshots map: for each (id, before, after) where any
 *      watched field changed value, the row is added to the
 *      processor's CommittedEvent.changedRows. If at least one row
 *      changed, the processor fires once with the aggregated list.
 *
 *   2. Explicit processors fire only when a tx called
 *      `tx.afterCommit(name, args)`. Args are validated by the
 *      processor's `scheduledArgsSchema` at enqueue time so a buggy
 *      caller fails the originating tx (clean rollback) instead of
 *      failing silently when the processor would otherwise fire.
 *
 * The framework does NOT auto-open a writeTransaction for the processor
 * (v4.32 — see §5.7). `apply(event, ctx)` runs as a plain async function
 * with `ctx = { db, repo }`. Pure-side-effect processors do nothing more;
 * write processors open their own `ctx.repo.tx(...)` when they decide to
 * write. This avoids holding a writer slot through read phases (the
 * shape that produced the §10 / `tasks/processor-tx-deadlock.md`
 * deadlock under PowerSync's serialized single-connection config) and
 * lets pure-side-effect processors skip the writer cost entirely.
 *
 * Failures are caught + logged so a crashing processor can't poison
 * subsequent jobs.
 *
 * Stage-1.5 deferred:
 *   - per-block content debouncing (§7.2 row "Trigger on content change"):
 *     v1 ships every fire immediately. The dispatcher ordering is
 *     append-only and sequential, so two close-together content writes
 *     run parseReferences twice — that's slightly more work than the
 *     legacy debounced behavior, but is easier to reason about and
 *     covers correctness. Add coalescing if profiling shows pain.
 */

import {
  CodecError,
  type AnyPostCommitProcessor,
  type ChangedRow,
  type CommittedEvent,
  type ProcessorCtx,
  type User,
} from '@/data/api'
import type { AfterCommitJob } from './txEngine'
import type { SnapshotsMap } from './txSnapshots'
import type { PowerSyncDb } from './commitPipeline'
import type { Repo } from './repo'

/** Tx-grain inputs the runner needs to decide what fires + with which
 *  changedRows. Built by the commit pipeline from the snapshots map +
 *  collected afterCommit jobs. */
export interface CommittedTxOutcome {
  txId: string
  user: User
  workspaceId: string | null
  /** Snapshots map walked into a flat list. */
  snapshots: SnapshotsMap
  /** afterCommit jobs scheduled by the user fn. */
  afterCommitJobs: AfterCommitJob[]
  /** Processor registry snapshot taken at tx start (spec §3, §8). The
   *  runner iterates this — not its own current registry — so a
   *  `setFacetRuntime` call landing mid-flight can't change which
   *  processors fire (or with what apply fn) for an already-running tx. */
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
}

/** Internal helper — convert a snapshots map entry into a ChangedRow. */
const toChangedRow = (id: string, before: ChangedRow['before'], after: ChangedRow['after']): ChangedRow =>
  ({id, before, after})

/** True iff `before.field !== after.field`. Both can be null
 *  (insert / hard-delete); JSON.stringify equality is sufficient for
 *  the structured fields (`properties`, `references`). */
const fieldChanged = (
  before: ChangedRow['before'],
  after: ChangedRow['after'],
  field: string,
): boolean => {
  // Insert: every field is "new".
  if (before === null) return after !== null
  // Hard-delete: treat as a change in every field.
  if (after === null) return true
  const a = (before as unknown as Record<string, unknown>)[field]
  const b = (after as unknown as Record<string, unknown>)[field]
  // Strict equality is right for primitives; JSON.stringify covers
  // properties (Record<string, unknown>) and references (BlockReference[]).
  return a === b ? false : JSON.stringify(a) !== JSON.stringify(b)
}

/** Build per-processor changedRows from the tx's snapshots. */
const collectFieldMatches = (
  processor: AnyPostCommitProcessor,
  snapshots: SnapshotsMap,
): ChangedRow[] => {
  if (processor.watches.kind !== 'field') return []
  if (processor.watches.table !== 'blocks') return []  // only blocks today
  const out: ChangedRow[] = []
  for (const [id, entry] of snapshots) {
    if (processor.watches.fields.some(f => fieldChanged(entry.before, entry.after, f as string))) {
      out.push(toChangedRow(id, entry.before, entry.after))
    }
  }
  return out
}

export class ProcessorRunner {
  private readonly repo: Repo
  private readonly db: PowerSyncDb
  /** In-flight processor promises. Tracked so tests (and any caller
   *  who needs deterministic ordering) can `awaitIdle()` before
   *  assertions. Each promise removes itself from the set on
   *  settlement (success or failure). */
  private readonly pending: Set<Promise<void>> = new Set()

  constructor(repo: Repo, db: PowerSyncDb) {
    this.repo = repo
    this.db = db
  }

  /** Wait until every currently-pending processor (synchronous + any
   *  already-fired delayed jobs) resolves. Does NOT advance timers —
   *  delayed jobs that haven't started yet aren't pending. Tests that
   *  need to flush a delayed job should use vi.useFakeTimers /
   *  vi.runAllTimers (or just sleep). */
  async awaitIdle(): Promise<void> {
    while (this.pending.size > 0) {
      // Snapshot — new jobs scheduled while we wait will be in `pending`
      // when this batch settles, and the loop catches them.
      await Promise.allSettled([...this.pending])
    }
  }

  /** Dispatch all matching processors for one committed tx. Called by
   *  Repo after `repo.tx` resolves. Walks the tx's processor snapshot
   *  (`outcome.processors`), not the runner's current registry — that's
   *  the §3/§8 contract: a tx fires the processors that were registered
   *  when it started, even if `setFacetRuntime` has since replaced them.
   *  Errors in any one processor are caught + logged; subsequent ones
   *  still run. */
  async dispatch(outcome: CommittedTxOutcome): Promise<void> {
    if (outcome.workspaceId === null) {
      // Zero-write tx — no field-watching processors fire (no
      // snapshots), and tx.afterCommit threw WorkspaceNotPinnedError
      // during the user fn so afterCommitJobs is also empty. Bail.
      return
    }

    // Field-watching processors: fire each at most once per tx.
    for (const [name, processor] of outcome.processors) {
      if (processor.watches.kind !== 'field') continue
      const changedRows = collectFieldMatches(processor, outcome.snapshots)
      if (changedRows.length === 0) continue
      const event: CommittedEvent<undefined> = {
        txId: outcome.txId,
        changedRows,
        user: outcome.user,
        workspaceId: outcome.workspaceId,
      }
      this.track(this.runOne(processor, event, name))
    }

    // Explicit processors: one job per `tx.afterCommit` call. The tx's
    // afterCommit primitive validates registration + watches.kind +
    // scheduledArgs at enqueue time (txEngine.afterCommit), so under
    // normal flow every job here corresponds to a still-valid processor
    // in `outcome.processors`. The defensive checks below catch the
    // pathological case of the snapshot itself being mutated post-tx
    // (which shouldn't happen — we hand out a frozen Map) and log
    // instead of crashing the dispatcher.
    for (const job of outcome.afterCommitJobs) {
      const processor = outcome.processors.get(job.processorName)
      if (processor === undefined) {
        console.warn(
          `[processorRunner] explicit job for "${job.processorName}" missing from tx snapshot — should have failed at enqueue`,
        )
        continue
      }
      if (processor.watches.kind !== 'explicit') {
        console.warn(
          `[processorRunner] explicit job for "${job.processorName}" but processor watches.kind = "${processor.watches.kind}" — should have failed at enqueue`,
        )
        continue
      }
      const event: CommittedEvent<unknown> = {
        txId: outcome.txId,
        changedRows: [],
        user: outcome.user,
        workspaceId: outcome.workspaceId,
        scheduledArgs: job.args,
      }
      if (job.delayMs && job.delayMs > 0) {
        // Wrap the delay + the run in a single tracked promise so
        // awaitIdle() — once the timer has fired — waits for the run
        // too. Until the timer fires there's nothing pending, which
        // matches the spec: §16.4 calls out that delayMs is real
        // wall-clock time and not part of the synchronous commit step.
        setTimeout(() => {
          this.track(this.runOne(processor, event, job.processorName))
        }, job.delayMs)
      } else {
        this.track(this.runOne(processor, event, job.processorName))
      }
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  /** Invoke the processor's apply with a `{db, repo}` ctx. The framework
   *  does not wrap apply in a writeTransaction (v4.32) — apply is a
   *  plain async fn that reads via `ctx.db` and (if it needs to write)
   *  opens its own tx via `ctx.repo.tx(...)`. Errors are caught + logged
   *  with the processor name + txId so one buggy processor can't poison
   *  the dispatch loop. */
  private async runOne(
    processor: AnyPostCommitProcessor,
    event: CommittedEvent<unknown>,
    name: string,
  ): Promise<void> {
    try {
      const ctx: ProcessorCtx = {
        db: this.db,
        repo: this.repo,
      }
      await processor.apply(event, ctx)
    } catch (err) {
      // Codec errors at enqueue time fail the originating tx; here at
      // fire time we're past that boundary, so log loudly and move on.
      const reason = err instanceof CodecError
        ? `[${err.expected}]`
        : (err instanceof Error ? err.message : String(err))
      console.error(
        `[processorRunner] processor "${name}" failed for tx ${event.txId}: ${reason}`,
      )
    }
  }
}
