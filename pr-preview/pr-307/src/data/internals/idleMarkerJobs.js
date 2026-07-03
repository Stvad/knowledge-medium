import { scheduleIdle } from "../../utils/scheduleIdle.js";
//#region src/data/internals/idleMarkerJobs.ts
/**
* Idle-deferred, marker-gated maintenance jobs for the data layer.
*
* `Repo` runs three one-time-per-workspace maintenance passes off the
* cold-start critical path — ref-typed-property reprojection, workspace
* backfills, and the reconcile rescan. Each one hand-rolled the same two
* mechanisms: an idle-deferred scheduler tracking its in-flight promises in
* a pending set (so tests can drain it), and a lazy in-memory mirror of its
* completion markers in `client_schema_state`.
*
* This module owns both mechanisms once:
*   - `PendingIdleJobs` — a pending-set drain barrier over an injectable
*     idle scheduler (defaults to `scheduleIdle`; the data-layer callers all
*     inject `scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE)` so the catch-ups run on
*     genuine idle off the cold-start window). One instance per job kind so
*     each `await*` test helper drains only its own work.
*   - `MarkerStore` — the lazy prefixed-key set: load once, then `has` /
*     `set` / `clear` in memory + write-through to `client_schema_state`.
*/
/** Tracks idle-deferred jobs so deterministic tests can wait for them.
*  `schedule` defers `task` via the configured scheduler — `scheduleIdle`
*  by default (next idle frame in the browser, task tick under Node/jsdom),
*  or a `scheduleDeepIdle` wrapper for work that must stay out of the
*  cold-start window. The task's promise is added to the pending set when
*  the deferred callback fires and removed on settle. `drain` awaits
*  everything whose timer has already fired — it does NOT advance timers,
*  so fake-timer callers must bump the clock first. */
var PendingIdleJobs = class {
	pending = /* @__PURE__ */ new Set();
	/** @param scheduler defers a callback off the critical path. Defaults to
	*  `scheduleIdle`; pass a `scheduleDeepIdle(fn, opts)` wrapper for jobs
	*  that should run only on genuine idle, never near boot. Both share the
	*  Node/jsdom `setTimeout(0)` test path, so drain helpers are unaffected. */
	constructor(scheduler = scheduleIdle) {
		this.scheduler = scheduler;
	}
	/** Defer `task` off the critical path. Fire-and-forget: the caller's path
	*  is not blocked. The promise enters the pending set only once the
	*  deferred callback runs (mirroring the historical hand-rolled behavior). */
	schedule(task) {
		this.scheduler(() => {
			const p = task().finally(() => {
				this.pending.delete(p);
			});
			this.pending.add(p);
		});
	}
	/** Await every job whose deferral timer has already fired. Loops so a
	*  job that settles while we await an earlier one is still drained;
	*  terminates because these jobs never schedule further jobs. */
	async drain() {
		while (this.pending.size > 0) await Promise.all([...this.pending]);
	}
	get size() {
		return this.pending.size;
	}
};
/** Lazy in-memory mirror of a prefixed family of completion markers in
*  `client_schema_state` (e.g. all `reproject_ref:%` rows). One SQL
*  round-trip per lifetime on first access; afterwards `has` is a pure
*  Set lookup and `set` / `clear` write through to the table while
*  keeping the mirror coherent. Entries are stored as the key *suffix*
*  (everything after `prefix`); callers build the suffix (the markers are
*  per-workspace, so it's typically `<workspaceId>:<name>`). */
var MarkerStore = class {
	cache = null;
	constructor(db, prefix, selectSql, recordSql, clearSql) {
		this.db = db;
		this.prefix = prefix;
		this.selectSql = selectSql;
		this.recordSql = recordSql;
		this.clearSql = clearSql;
	}
	/** Load the marker set on first call, then keep it in-memory. Legacy
	*  keys that don't share the current suffix shape load as inert entries
	*  that never match a current lookup — the caller simply re-runs once. */
	async load() {
		if (this.cache !== null) return this.cache;
		const rows = await this.db.getAll(this.selectSql);
		const set = /* @__PURE__ */ new Set();
		for (const r of rows) set.add(r.key.slice(this.prefix.length));
		this.cache = set;
		return set;
	}
	async has(suffix) {
		return (await this.load()).has(suffix);
	}
	async set(suffix) {
		await this.db.execute(this.recordSql, [`${this.prefix}${suffix}`]);
		this.cache?.add(suffix);
	}
	async clear(suffix) {
		if (!this.clearSql) throw new Error("[MarkerStore] clear() called on a store without clearSql");
		await this.db.execute(this.clearSql, [`${this.prefix}${suffix}`]);
		this.cache?.delete(suffix);
	}
	/** Drop the in-memory mirror so the next access re-reads from the
	*  table. Used by tests / migrations that mutate the table out-of-band. */
	reset() {
		this.cache = null;
	}
};
//#endregion
export { MarkerStore, PendingIdleJobs };

//# sourceMappingURL=idleMarkerJobs.js.map