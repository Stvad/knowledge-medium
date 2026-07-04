import { cycleScanSql } from "../treeQueries.js";
import { materializeStagingRows } from "./materialize.js";
import { applySyncInvalidation } from "./invalidate.js";
//#region src/data/internals/syncObserver/observer.ts
/** Drain-throttle window (ms). Matches the row_events tail default — coalesces
*  sync-burst arrivals into one batched drain. */
var DEFAULT_THROTTLE_MS = 100;
/** Max queued changes materialized per drain window. Draining a large backlog in
*  bounded, individually-committed windows (rather than one unbounded pass) keeps
*  memory flat, makes progress durable across reloads/crashes, and lets the UI
*  fill in as it goes: the queue is consumed per window, so an interrupted drain
*  resumes from the last committed window instead of restarting from zero. */
var DEFAULT_DRAIN_CHUNK = 1e3;
/** PowerSync raises this from in-flight queries when the connection closes
*  mid-drain (tab close / signOut / test teardown). Benign — there's nobody
*  left to materialize for. Identified by name to avoid a runtime dep on
*  `@powersync/common`. */
var isConnectionClosedError = (err) => !!err && typeof err === "object" && err.name === "ConnectionClosedError";
/**
* The §4.7 cycle-scan starting set: ids whose parent_id actually moved while
* the row stayed live (a fresh insert or a delete can't close a loop on its
* own; a content edit doesn't change reachability), grouped by the row's
* current workspace. Relocated from rowEventsTail's inline selection.
*/
var cycleScanCandidatesByWorkspace = (snapshots) => {
	const byWorkspace = /* @__PURE__ */ new Map();
	for (const [id, { before, after }] of snapshots) {
		if (!before || before.deleted) continue;
		if (!after || after.deleted) continue;
		if (before.parentId === after.parentId) continue;
		const workspaceId = after.workspaceId;
		if (!workspaceId) continue;
		const list = byWorkspace.get(workspaceId);
		if (list) list.push(id);
		else byWorkspace.set(workspaceId, [id]);
	}
	return byWorkspace;
};
var startBlocksSyncedObserver = (args) => {
	const { db, cache, handleStore, deps, getInvalidationRules, onCycleDetected } = args;
	const throttleMs = args.throttleMs ?? DEFAULT_THROTTLE_MS;
	const drainChunk = Math.max(1, args.drainChunkSize ?? DEFAULT_DRAIN_CHUNK);
	const rules = () => getInvalidationRules?.() ?? [];
	const onError = args.onError ?? ((err) => {
		if (!isConnectionClosedError(err)) console.warn("[blocksSyncedObserver] drain error:", err);
	});
	let disposed = false;
	let unsubscribe = null;
	let chain = Promise.resolve();
	/** §4.7 detection-only telemetry. One bounded, truncation-safe scan per
	*  workspace whose parent_id mutations might have closed a loop. A scan
	*  failure is reported but never aborts the drain (matches rowEventsTail). */
	const runCycleScan = async (snapshots) => {
		if (!onCycleDetected) return;
		for (const [workspaceId, ids] of cycleScanCandidatesByWorkspace(snapshots)) try {
			const hits = await db.getAll(cycleScanSql(ids.length), ids);
			if (hits.length === 0) continue;
			const startIds = hits.map((hit) => hit.start_id).sort();
			console.warn(`[blocksSyncedObserver] cycleDetected ws=${workspaceId} startIds=${JSON.stringify(startIds)}`);
			onCycleDetected({
				workspaceId,
				startIds,
				txIdsInvolved: []
			});
		} catch (err) {
			onError(err);
		}
	};
	/** Post-materialization side effects shared by every drain path: invalidate
	*  cache + handles (writing the cache via the LWW gate — see
	*  `applySyncInvalidation`), then run cycle detection. */
	const applyOutcome = async (outcome) => {
		applySyncInvalidation(cache, handleStore, outcome.snapshots, rules());
		await runCycleScan(outcome.snapshots);
	};
	/** Materialize one bounded window + run its invalidation. The shared per-window
	*  step of both drain paths (queue-driven {@link drainQueueOnce} and
	*  workspace-rescan {@link materializeWorkspace}); they differ only in where
	*  the window's ids come from and what bookkeeping follows it. */
	const applyWindow = async (upserted, removed) => {
		await applyOutcome(await materializeStagingRows(db, {
			upserted,
			removed
		}, deps));
	};
	const drainQueueOnce = async () => {
		for (;;) {
			if (disposed) return;
			const rows = await db.getAll("SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq LIMIT ?", [drainChunk]);
			if (rows.length === 0) return;
			const maxSeq = rows[rows.length - 1].seq;
			const opById = /* @__PURE__ */ new Map();
			for (const row of rows) opById.set(row.id, row.op);
			const upserted = [];
			const removed = [];
			for (const [id, op] of opById) (op === "upsert" ? upserted : removed).push(id);
			await applyWindow(upserted, removed);
			await db.execute("DELETE FROM blocks_synced_changes WHERE seq <= ?", [maxSeq]);
			if (rows.length < drainChunk) return;
		}
	};
	const materializeWorkspace = async (workspaceId) => {
		if (disposed) return;
		const ids = (await db.getAll("SELECT id FROM blocks_synced WHERE workspace_id = ? ORDER BY id", [workspaceId])).map((row) => row.id);
		for (let i = 0; i < ids.length; i += drainChunk) {
			if (disposed) return;
			await applyWindow(ids.slice(i, i + drainChunk), []);
		}
	};
	const enqueue = (work) => {
		const next = chain.then(async () => {
			if (disposed) return;
			try {
				await work();
			} catch (err) {
				onError(err);
			}
		}, () => {});
		chain = next;
		return next;
	};
	const flush = () => enqueue(drainQueueOnce);
	const drainWorkspace = (workspaceId) => enqueue(() => materializeWorkspace(workspaceId));
	unsubscribe = db.onChange({
		onChange: () => {
			flush();
		},
		onError
	}, {
		tables: ["blocks_synced_changes"],
		throttleMs
	});
	flush();
	return {
		flush,
		drainWorkspace,
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe?.();
			unsubscribe = null;
		}
	};
};
//#endregion
export { cycleScanCandidatesByWorkspace, startBlocksSyncedObserver };

//# sourceMappingURL=observer.js.map