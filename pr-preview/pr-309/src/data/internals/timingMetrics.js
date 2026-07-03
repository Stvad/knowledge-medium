//#region src/data/internals/timingMetrics.ts
/**
* Timing-based metrics: bounded reservoir + DB / query wrappers
* (perf-baseline follow-up #4 extension).
*
* Counterpart to the simple-counter metrics on HandleStore / BlockCache.
* Where those answer "how often", these answer "how long":
*
*   - `DbMetrics` aggregates wall-clock timings for every PowerSyncDb
*     call site that flows through the Repo (`getAll`, `getOptional`,
*     `get`, `execute`, `writeTransaction`). Use to tell whether
*     a slow cold-start lives in raw SQL roundtrip cost or above it.
*   - `QueryMetrics` keys by query name (e.g. `core.subtree`,
*     `plugin:tasks/dueSoon`) and records the wall-clock time of each
*     `loader(ctx)` invocation. Re-resolves (LoaderHandle.invalidate)
*     count as separate samples — the dispatcher path runs the loader
*     fresh each time, and that's the unit you care about for "open
*     page → ms to settle".
*
* Approximate percentiles via a fixed-capacity ring buffer (default 256
* samples). Cheap, bounded memory, and accurate enough for the
* "is this 10 ms or 100 ms?" decisions we'd make from a debug panel.
* For higher-precision distributions, use the bench harness instead —
* this exists for in-app awareness, not benchmark output.
*
* Cost: a `performance.now()` pair + ring-buffer write per call. At
* the rates the data layer hits (a few thousand SQL calls/sec under
* worst-case sync bursts) that's well under 1% of wall time.
*/
/** Approximate-percentile ring buffer. Records the last `capacity`
*  samples; `snapshot()` sorts a copy on demand. `calls` is the total
*  observed across the lifetime of the reservoir (not bounded by
*  capacity), so consumers can still read "how many samples have we
*  seen?" even after the buffer wrapped. */
var TimingReservoir = class {
	capacity;
	samples;
	writeIdx = 0;
	filled = false;
	callsTotal = 0;
	sumMs = 0;
	constructor(capacity = 256) {
		if (capacity <= 0) throw new Error(`TimingReservoir capacity must be positive, got ${capacity}`);
		this.capacity = capacity;
		this.samples = [];
	}
	record(ms) {
		this.callsTotal++;
		this.sumMs += ms;
		if (!this.filled && this.samples.length < this.capacity) {
			this.samples.push(ms);
			if (this.samples.length === this.capacity) this.filled = true;
			return;
		}
		this.samples[this.writeIdx] = ms;
		this.writeIdx = (this.writeIdx + 1) % this.capacity;
	}
	reset() {
		this.samples.length = 0;
		this.writeIdx = 0;
		this.filled = false;
		this.callsTotal = 0;
		this.sumMs = 0;
	}
	/** Frozen plain-object summary. Percentile values are 0 when
	*  `sampleCount === 0` (no samples yet); consumers should branch
	*  on that field rather than treating 0 as a real measurement. */
	snapshot() {
		const n = this.samples.length;
		if (n === 0) return Object.freeze({
			calls: this.callsTotal,
			sampleCount: 0,
			meanMs: 0,
			p50Ms: 0,
			p95Ms: 0,
			p99Ms: 0,
			minMs: 0,
			maxMs: 0,
			totalMs: this.sumMs
		});
		const sorted = this.samples.slice().sort((a, b) => a - b);
		const at = (q) => sorted[Math.min(n - 1, Math.floor(n * q))];
		let windowSum = 0;
		for (const s of sorted) windowSum += s;
		return Object.freeze({
			calls: this.callsTotal,
			sampleCount: n,
			meanMs: windowSum / n,
			p50Ms: at(.5),
			p95Ms: at(.95),
			p99Ms: at(.99),
			minMs: sorted[0],
			maxMs: sorted[n - 1],
			totalMs: this.sumMs
		});
	}
};
/** Aggregate timings for every PowerSyncDb call that flows through the
*  Repo (read calls + writeTransaction wall-clock). One instance per
*  Repo. */
var DbMetrics = class {
	getAll = new TimingReservoir();
	getOptional = new TimingReservoir();
	get = new TimingReservoir();
	execute = new TimingReservoir();
	/** Total `db.writeTransaction(...)` wall time, including commit
	*  overhead. Tx-internal SQL calls (via the LockContext) are timed
	*  separately under their respective fields above — so a single
	*  `mutate.setContent` typically registers 1 writeTransaction sample
	*  AND a handful of `getAll`/`execute` samples for the inner work. */
	writeTransaction = new TimingReservoir();
	reset() {
		this.getAll.reset();
		this.getOptional.reset();
		this.get.reset();
		this.execute.reset();
		this.writeTransaction.reset();
	}
	snapshot() {
		return Object.freeze({
			getAll: this.getAll.snapshot(),
			getOptional: this.getOptional.snapshot(),
			get: this.get.snapshot(),
			execute: this.execute.snapshot(),
			writeTransaction: this.writeTransaction.snapshot()
		});
	}
};
/** Per-query-name resolve timings. Keys are full query names
*  (`core.subtree`, `plugin:foo/bar`, …). Empty entries don't appear
*  in the snapshot — only queries that actually ran are surfaced. */
var QueryMetrics = class {
	perName = /* @__PURE__ */ new Map();
	/** Record one `loader(ctx)` invocation for `queryName`. Lazily
	*  creates a reservoir on first call so unused queries cost nothing.
	*  Capacity defaults to 256 — same as the DbMetrics reservoirs. */
	record(queryName, ms) {
		let r = this.perName.get(queryName);
		if (!r) {
			r = new TimingReservoir();
			this.perName.set(queryName, r);
		}
		r.record(ms);
	}
	reset() {
		for (const r of this.perName.values()) r.reset();
		this.perName.clear();
	}
	snapshot() {
		const out = {};
		for (const [name, r] of this.perName) out[name] = r.snapshot();
		return Object.freeze(out);
	}
};
/** Wrap a `PowerSyncDb` with timing instrumentation. Returns a Proxy
*  over the input — five methods (`getAll`, `getOptional`, `get`,
*  `execute`, `writeTransaction`) are intercepted and timed; everything
*  else (`onChange`, `close`, …) passes through to the original db.
*  This means consumers like `exportSqliteDb` that need
*  PowerSyncDatabase-only methods continue to work without us
*  re-declaring them.
*
*  `writeTransaction` also wraps the LockContext passed to the callback
*  so tx-internal SQL is timed under the same metrics buckets.
*
*  Type-erased to `unknown` here so the module doesn't import
*  `PowerSyncDb`; `Repo` casts at the call site (it owns the
*  `PowerSyncDb` type contract). */
var wrapDbWithMetrics = (rawDb, metrics) => {
	const db = rawDb;
	const wrappedTx = wrapTxDb.bind(null, metrics);
	const timedWriteTransaction = async (fn) => {
		const t0 = performance.now();
		try {
			return await db.writeTransaction(async (tx) => fn(wrappedTx(tx)));
		} finally {
			metrics.writeTransaction.record(performance.now() - t0);
		}
	};
	const timedGetAll = async (sql, params) => {
		const t0 = performance.now();
		try {
			return await db.getAll(sql, params);
		} finally {
			metrics.getAll.record(performance.now() - t0);
		}
	};
	const timedGetOptional = async (sql, params) => {
		const t0 = performance.now();
		try {
			return await db.getOptional(sql, params);
		} finally {
			metrics.getOptional.record(performance.now() - t0);
		}
	};
	const timedGet = async (sql, params) => {
		const t0 = performance.now();
		try {
			return await db.get(sql, params);
		} finally {
			metrics.get.record(performance.now() - t0);
		}
	};
	const timedExecute = async (sql, params) => {
		const t0 = performance.now();
		try {
			return await db.execute(sql, params);
		} finally {
			metrics.execute.record(performance.now() - t0);
		}
	};
	const overrides = {
		writeTransaction: timedWriteTransaction,
		getAll: timedGetAll,
		getOptional: timedGetOptional,
		get: timedGet,
		execute: timedExecute
	};
	return new Proxy(db, { get(target, prop, receiver) {
		if (typeof prop === "string" && prop in overrides) return overrides[prop];
		const value = Reflect.get(target, prop, receiver);
		if (typeof value === "function") return value.bind(target);
		return value;
	} });
};
/** LockContext-shape wrapper used inside writeTransaction. Same idea
*  as wrapDbWithMetrics: time every read/exec call going through the
*  tx so `mutate.X` shows up under both `writeTransaction` (wall) and
*  the per-call buckets (its inner SQL). */
var wrapTxDb = (metrics, tx) => ({
	execute: async (sql, params) => {
		const t0 = performance.now();
		try {
			return await tx.execute(sql, params);
		} finally {
			metrics.execute.record(performance.now() - t0);
		}
	},
	getAll: async (sql, params) => {
		const t0 = performance.now();
		try {
			return await tx.getAll(sql, params);
		} finally {
			metrics.getAll.record(performance.now() - t0);
		}
	},
	getOptional: async (sql, params) => {
		const t0 = performance.now();
		try {
			return await tx.getOptional(sql, params);
		} finally {
			metrics.getOptional.record(performance.now() - t0);
		}
	},
	get: async (sql, params) => {
		const t0 = performance.now();
		try {
			return await tx.get(sql, params);
		} finally {
			metrics.get.record(performance.now() - t0);
		}
	}
});
//#endregion
export { DbMetrics, QueryMetrics, TimingReservoir, wrapDbWithMetrics };

//# sourceMappingURL=timingMetrics.js.map