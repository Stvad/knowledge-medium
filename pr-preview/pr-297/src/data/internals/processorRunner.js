import { CodecError } from "../api/errors.js";
import "../api/index.js";
//#region src/data/internals/processorRunner.ts
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
/** Internal helper — convert a snapshots map entry into a ChangedRow. */
var toChangedRow = (id, before, after) => ({
	id,
	before,
	after
});
/** True iff `before.field !== after.field`. Both can be null
*  (insert / hard-delete); JSON.stringify equality is sufficient for
*  the structured fields (`properties`, `references`). */
var fieldChanged = (before, after, field) => {
	if (before === null) return after !== null;
	if (after === null) return true;
	const a = before[field];
	const b = after[field];
	return a === b ? false : JSON.stringify(a) !== JSON.stringify(b);
};
/** Build per-processor changedRows from the tx's snapshots. */
var collectFieldMatches = (processor, snapshots) => {
	if (processor.watches.kind !== "field") return [];
	if (processor.watches.table !== "blocks") return [];
	const out = [];
	for (const [id, entry] of snapshots) if (processor.watches.fields.some((f) => fieldChanged(entry.before, entry.after, f))) out.push(toChangedRow(id, entry.before, entry.after));
	return out;
};
var ProcessorRunner = class {
	repo;
	db;
	/** In-flight processor promises. Tracked so tests (and any caller
	*  who needs deterministic ordering) can `awaitIdle()` before
	*  assertions. Each promise removes itself from the set on
	*  settlement (success or failure). */
	pending = /* @__PURE__ */ new Set();
	constructor(repo, db) {
		this.repo = repo;
		this.db = db;
	}
	/** Wait until every currently-pending processor (synchronous + any
	*  already-fired delayed jobs) resolves. Does NOT advance timers —
	*  delayed jobs that haven't started yet aren't pending. Tests that
	*  need to flush a delayed job should use vi.useFakeTimers /
	*  vi.runAllTimers (or just sleep). */
	async awaitIdle() {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}
	/** Dispatch all matching processors for one committed tx. Called by
	*  Repo after `repo.tx` resolves. Walks the tx's processor snapshot
	*  (`outcome.processors`), not the runner's current registry — that's
	*  the §3/§8 contract: a tx fires the processors that were registered
	*  when it started, even if `setFacetRuntime` has since replaced them.
	*  Errors in any one processor are caught + logged; subsequent ones
	*  still run. */
	async dispatch(outcome) {
		if (outcome.workspaceId === null) return;
		for (const [name, processor] of outcome.processors) {
			if (processor.watches.kind !== "field") continue;
			const changedRows = collectFieldMatches(processor, outcome.snapshots);
			if (changedRows.length === 0) continue;
			const event = {
				txId: outcome.txId,
				changedRows,
				user: outcome.user,
				workspaceId: outcome.workspaceId
			};
			this.track(this.runOne(processor, event, name, outcome.propertySchemas));
		}
		for (const job of outcome.afterCommitJobs) {
			const processor = outcome.processors.get(job.processorName);
			if (processor === void 0) {
				console.warn(`[processorRunner] explicit job for "${job.processorName}" missing from tx snapshot — should have failed at enqueue`);
				continue;
			}
			if (processor.watches.kind !== "explicit") {
				console.warn(`[processorRunner] explicit job for "${job.processorName}" but processor watches.kind = "${processor.watches.kind}" — should have failed at enqueue`);
				continue;
			}
			const event = {
				txId: outcome.txId,
				changedRows: [],
				user: outcome.user,
				workspaceId: outcome.workspaceId,
				scheduledArgs: job.args
			};
			if (job.delayMs && job.delayMs > 0) setTimeout(() => {
				this.track(this.runOne(processor, event, job.processorName, outcome.propertySchemas));
			}, job.delayMs);
			else this.track(this.runOne(processor, event, job.processorName, outcome.propertySchemas));
		}
	}
	track(p) {
		this.pending.add(p);
		p.finally(() => this.pending.delete(p));
	}
	/** Invoke the processor's apply with a `{db, repo}` ctx. The framework
	*  does not wrap apply in a writeTransaction (v4.32) — apply is a
	*  plain async fn that reads via `ctx.db` and (if it needs to write)
	*  opens its own tx via `ctx.repo.tx(...)`. Errors are caught + logged
	*  with the processor name + txId so one buggy processor can't poison
	*  the dispatch loop. */
	async runOne(processor, event, name, propertySchemas) {
		try {
			const ctx = {
				db: this.db,
				repo: this.repo,
				propertySchemas
			};
			await processor.apply(event, ctx);
		} catch (err) {
			const reason = err instanceof CodecError ? `[${err.expected}]` : err instanceof Error ? err.message : String(err);
			console.error(`[processorRunner] processor "${name}" failed for tx ${event.txId}: ${reason}`);
		}
	}
};
//#endregion
export { ProcessorRunner };

//# sourceMappingURL=processorRunner.js.map