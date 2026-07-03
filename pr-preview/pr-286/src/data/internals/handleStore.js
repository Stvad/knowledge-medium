import isEqual from "../../../node_modules/lodash-es/isEqual.js";
import { collectPluginInvalidationsFromSnapshots, pluginInvalidationSize } from "../invalidation.js";
//#region src/data/internals/handleStore.ts
/**
* HandleStore + LoaderHandle (spec §5.1, §9.1, §9.2).
*
* HandleStore is the central registry for `Handle<T>` instances.
*
*   - Identity rule: same key (`(name, stable typed serialization(args))`)
*     → same handle instance returned from `getOrCreate`.
*   - Ref-count GC: handles dispose `gcTimeMs` after refCount reaches zero
*     (drained subscribers + drained in-flight loads).
*   - Invalidation index: handles declare `Dependency`s during `resolve`;
*     the store walks an inverted index when `invalidate(change)` fires.
*
* LoaderHandle is the base implementation used by Repo's collection
* factories (`repo.children`, `repo.subtree`, etc.). It plumbs:
*
*   - peek / load / subscribe / read / status (the Handle<T> surface),
*   - structural diffing (lodash.isEqual default; spec §9.4),
*   - dependency declaration via a `ResolveContext` passed to the loader,
*   - retain/release wiring on subscribe/unsubscribe so the store can GC.
*
* Block does NOT register here — it has its own row-grain subscription
* via BlockCache.subscribe and is identity-stable through `Repo.blockFacades`.
* The Handle interface on Block (§5.2) is a structural fit on top of those
* existing primitives; HandleStore is the home for collection handles only.
*/
/** Default GC delay — after refCount hits zero the handle waits this
*  long before disposing, so a quick re-subscribe (re-render) doesn't
*  thrash. */
var DEFAULT_GC_TIME_MS = 5e3;
/** Coordinates notify-fan-out across multiple handles invalidated by the
*  same `ChangeNotification`. Without this, each handle's loader settles
*  on its own task and fires its notify independently; if loaders settle
*  in different macrotasks (the common case for SQL-backed loaders), the
*  browser can paint between them. The visible symptom on indent/move:
*  the moved block disappears from its old parent's list, layout collapses,
*  then it reappears under the new parent on the next paint.
*
*  Semantics:
*    - Each handle invalidated as part of one `store.invalidate(...)`
*      call registers itself with the batch via `register()` and MUST
*      call `finish(notifyOrNull)` exactly once for that registration —
*      with a notify thunk if it wants to fire after the barrier, or
*      `null` to release its slot (errors, deferred-no-listeners,
*      mid-load coalescing, structural-diff no-ops).
*    - The barrier closes once `close()` has been called AND all
*      registered slots have finished. At that point every queued notify
*      runs synchronously in registration order, landing in one
*      microtask so React 18 auto-batching captures them in one commit.
*    - Slots that finish synchronously during the invalidate walk are
*      drained the same way; if all matched handles short-circuit, the
*      barrier flushes immediately on `close()`.
*    - Mid-load handles forward `null` and don't re-register their
*      post-settle reload into this batch; that reload's notify lands
*      in its own microtask. The dominant indent/move case is ready
*      handles, so the batch covers the symptom; mid-load is a
*      best-effort fallback.
*/
var NotifyBatch = class {
	remaining = 0;
	closed = false;
	flushed = false;
	queue = [];
	/** Reserve a slot — must be paired with exactly one `finish(...)`. */
	register() {
		if (this.flushed) throw new Error("NotifyBatch.register after flush");
		this.remaining++;
	}
	/** Release a slot, optionally contributing a notify to flush when the
	*  barrier closes. Pass `null` for "no notify from this slot." */
	finish(notify) {
		if (notify) this.queue.push(notify);
		this.remaining--;
		this.maybeFlush();
	}
	/** Signal that no more `register()` calls will arrive. If the slot
	*  count is already zero this flushes immediately. */
	close() {
		this.closed = true;
		this.maybeFlush();
	}
	maybeFlush() {
		if (!this.closed || this.remaining > 0 || this.flushed) return;
		this.flushed = true;
		const ns = this.queue.splice(0);
		for (const n of ns) try {
			n();
		} catch (err) {
			console.error("NotifyBatch flush error:", err);
		}
	}
};
/** Mutable counter object for handle-related metrics (perf-baseline
*  follow-up #4). One instance per HandleStore; LoaderHandles read it
*  through `store.metrics` so handle-level events (loader runs,
*  mid-load invalidations, structural-diff dedup) aggregate across the
*  full lifetime of the store rather than being lost when handles GC.
*
*  Counters are plain `number` fields and increment inline; the cost
*  is sub-nanosecond in the hot path. Snapshot via `snapshot()` for a
*  frozen plain-object view consumers can diff between samples. */
var HandleStoreMetrics = class {
	/** Total invalidate(...) calls that did not early-return. The
	*  empty-store + empty-change short-circuits are NOT counted (those
	*  are the cost-free path; counting them would inflate the average
	*  walk-per-call ratio). */
	invalidations = 0;
	/** Total handles iterated across all invalidate calls. With the
	*  current linear walk this equals `invalidations × handles.size`
	*  on average; with the inverted-index optimisation it should drop
	*  to `handlesMatched`. Watching this in production is the fastest
	*  way to verify the optimisation has the intended effect. */
	handlesWalked = 0;
	/** Total handles whose `matches(change)` returned true. */
	handlesMatched = 0;
	/** Total `LoaderHandle.invalidate()` calls. Equals `handlesMatched`
	*  unless callers invalidate handles directly (e.g. tests). */
	loaderInvalidations = 0;
	/** Total `runLoader()` invocations — actual loader function calls
	*  against SQL. Smaller than `loaderInvalidations` because:
	*    - mid-load invalidations are coalesced via `pendingReinvalidate`
	*      (they don't kick a fresh runLoader, they piggyback on the
	*      already-inflight settle path),
	*    - the cold `load()` from `subscribe()` also bumps this. */
	loaderRuns = 0;
	/** `LoaderHandle.invalidate()` calls that arrived while a load was
	*  inflight — these flip `pendingReinvalidate` instead of starting
	*  a new runLoader. */
	midLoadInvalidations = 0;
	/** Microtask-scheduled reloads triggered by `pendingReinvalidate`
	*  during the settle path. Pairs with `midLoadInvalidations` (each
	*  midLoad event eventually produces at most one reload, modulo
	*  coalescing). */
	reloadsAfterSettle = 0;
	/** `notify(value)` calls where the structural diff (spec §9.4)
	*  determined the value was unchanged → listener walk skipped. */
	notifiesSkippedByDiff = 0;
	/** `notify(value)` calls that actually walked the listener set. */
	notifiesFired = 0;
	/** Invalidations that hit a handle with zero subscribers and no
	*  inflight load — the handle was marked stale instead of eagerly
	*  re-running its loader. The next `.load()` will re-resolve. This
	*  counter exists to verify the optimisation is firing in workloads
	*  where slow `.load()`-only queries (e.g. alias autocomplete) used
	*  to thrash on every block write. */
	loaderInvalidationsDeferred = 0;
	/** ctx.depend(...) calls that registered a dep the loader had already
	*  declared in this same run — the duplicate is dropped instead of
	*  re-pushed. Drives down the matches() walk cost for handles that
	*  walk a graph and accidentally re-depend on shared nodes (e.g.
	*  many-ancestors converging on a common root). A non-zero value here
	*  is a hint that a resolver is over-registering — usually harmless,
	*  but the counter exists so we can see how much work the dedup is
	*  actually saving. */
	depsDeduplicatedAtRegistration = 0;
	reset() {
		this.invalidations = 0;
		this.handlesWalked = 0;
		this.handlesMatched = 0;
		this.loaderInvalidations = 0;
		this.loaderRuns = 0;
		this.midLoadInvalidations = 0;
		this.reloadsAfterSettle = 0;
		this.notifiesSkippedByDiff = 0;
		this.notifiesFired = 0;
		this.loaderInvalidationsDeferred = 0;
		this.depsDeduplicatedAtRegistration = 0;
	}
	/** Frozen plain-object snapshot. Safe to keep as a baseline for
	*  diffing — does not share state with the live counter. */
	snapshot() {
		return Object.freeze({
			invalidations: this.invalidations,
			handlesWalked: this.handlesWalked,
			handlesMatched: this.handlesMatched,
			loaderInvalidations: this.loaderInvalidations,
			loaderRuns: this.loaderRuns,
			midLoadInvalidations: this.midLoadInvalidations,
			reloadsAfterSettle: this.reloadsAfterSettle,
			notifiesSkippedByDiff: this.notifiesSkippedByDiff,
			notifiesFired: this.notifiesFired,
			loaderInvalidationsDeferred: this.loaderInvalidationsDeferred,
			depsDeduplicatedAtRegistration: this.depsDeduplicatedAtRegistration
		});
	}
};
/** Identity-stable registry of handles. */
var HandleStore = class {
	handles = /* @__PURE__ */ new Map();
	gcTimeMs;
	schedule;
	/** Metrics counters. LoaderHandle bumps handle-level fields through
	*  this same object so all aggregates share one snapshot. */
	metrics = new HandleStoreMetrics();
	constructor(opts) {
		this.gcTimeMs = opts?.gcTimeMs ?? DEFAULT_GC_TIME_MS;
		this.schedule = opts?.schedule ?? ((cb, ms) => {
			const t = setTimeout(cb, ms);
			return () => clearTimeout(t);
		});
	}
	/** Returns the GC delay in ms (used by LoaderHandle for its own
	*  scheduling). */
	getGcTimeMs() {
		return this.gcTimeMs;
	}
	getScheduler() {
		return this.schedule;
	}
	/** Get-or-create. Identity rule: same key → same instance. */
	getOrCreate(key, factory) {
		const existing = this.handles.get(key);
		if (existing) return existing;
		const created = factory();
		this.handles.set(key, created);
		return created;
	}
	/** Remove a key (called by the handle itself on dispose). */
	remove(key) {
		this.handles.delete(key);
	}
	/** Walk all registered handles, invalidate the ones whose deps match. */
	invalidate(change) {
		if (this.handles.size === 0) return;
		if ((!change.rowIds || sizeOf(change.rowIds) === 0) && (!change.parentIds || sizeOf(change.parentIds) === 0) && (!change.workspaceIds || sizeOf(change.workspaceIds) === 0) && (!change.tables || sizeOf(change.tables) === 0) && pluginInvalidationSize(change.plugin) === 0) return;
		this.metrics.invalidations++;
		const snapshot = Array.from(this.handles.values());
		const matched = [];
		for (const h of snapshot) {
			this.metrics.handlesWalked++;
			h.observeDuringLoad(change);
			if (h.matches(change)) {
				this.metrics.handlesMatched++;
				matched.push(h);
			}
		}
		if (matched.length <= 1) {
			for (const h of matched) h.invalidate();
			return;
		}
		const batch = new NotifyBatch();
		for (const h of matched) {
			batch.register();
			h.invalidate(batch);
		}
		batch.close();
	}
	/** Test/debug: how many handles are currently registered. */
	size() {
		return this.handles.size;
	}
	/** Snapshot of live-state aggregates over registered handles. Pairs
	*  with `metrics.snapshot()` (counters) to give a complete read on
	*  the store with one call. Use this to find fat-handle outliers
	*  (resolvers declaring lots of deps) without having to walk
	*  `this.handles` from a devtools eval.
	*
	*  `topHeavy` is the K=3 handles with the most deps. Three is enough
	*  to spot a pattern (one outlier vs a cluster) and small enough to
	*  surface in a log line. */
	snapshotInventory() {
		const counts = [];
		let totalDeps = 0;
		let maxDeps = 0;
		for (const [key, h] of this.handles) {
			const n = h.depCount();
			counts.push({
				key,
				depCount: n
			});
			totalDeps += n;
			if (n > maxDeps) maxDeps = n;
		}
		const sortedDescByDepCount = counts.slice().sort((a, b) => b.depCount - a.depCount);
		const topHeavy = Object.freeze(sortedDescByDepCount.slice(0, 3).map((c) => Object.freeze({ ...c })));
		const sortedAsc = counts.map((c) => c.depCount).sort((a, b) => a - b);
		return Object.freeze({
			handleCount: counts.length,
			totalDeps,
			maxDeps,
			p50Deps: nearestRankPercentile(sortedAsc, 50),
			p95Deps: nearestRankPercentile(sortedAsc, 95),
			topHeavy
		});
	}
	/** Dispose every handle (test cleanup). */
	clear() {
		const snapshot = Array.from(this.handles.values());
		for (const h of snapshot) h.dispose();
		this.handles.clear();
	}
};
var sizeOf = (xs) => xs instanceof Set ? xs.size : xs.length;
/** Nearest-rank percentile over an ascending-sorted, non-empty array.
*  Returns 0 for an empty input so callers don't need a guard. */
var nearestRankPercentile = (sortedAsc, p) => {
	if (sortedAsc.length === 0) return 0;
	const rank = Math.ceil(p / 100 * sortedAsc.length);
	return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
};
/** Generic loader-backed handle. The collection factories (`repo.children`,
*  `repo.subtree`, etc.) construct one of these with a key + loader. */
var LoaderHandle = class {
	key;
	store;
	loader;
	equality;
	value = void 0;
	notifiedValue = void 0;
	hasNotifiedValue = false;
	status_ = "idle";
	error = void 0;
	listeners = /* @__PURE__ */ new Set();
	deps = [];
	/** Inflight `load()` promise — dedup'd. Cleared once it settles. */
	inflight = null;
	/** Suspense throw target — same as `inflight` while loading; let the
	*  caller `await` the same promise React threw. */
	suspendingPromise = null;
	/** Ref count = subscribers + inflight (1 if loading). Drives GC. */
	refCount = 0;
	cancelGc = null;
	disposed = false;
	/** Set when `invalidate()` fires while a load is in flight. The
	*  inflight load may have already read stale data from SQL before the
	*  invalidating commit landed, so its result cannot be trusted on
	*  its own. We let the load settle (so the suspending promise React
	*  is awaiting still resolves) and immediately re-run the loader to
	*  pick up the post-invalidation state. */
	pendingReinvalidate = false;
	/** Changes observed while this load is in flight. Recorded
	*  unconditionally (not gated on `matches`) so deps that the loader
	*  declares LATER — e.g. per-row deps published by `hydrateRows` after
	*  SQL returns — can be checked against the queue once the loader
	*  settles. Without this, a child-row commit landing between SQL
	*  read and per-row `ctx.depend(...)` would slip past `matches`
	*  (only the upfront `parent-edge` dep is known at that point) and
	*  the handle would settle with stale `BlockData[]`. */
	changesDuringLoad = [];
	/** Set when an invalidation lands on a handle with zero subscribers
	*  and no inflight load. Eagerly re-running the loader for nobody is
	*  pure waste — and worse, the run blocks write transactions on the
	*  same SQLite connection (alias-autocomplete saw ~640ms reads
	*  pacing block-creation writes). Instead we mark stale; the next
	*  `.load()` bypasses the cached-value short-circuit and re-resolves.
	*  Subscribed handles ignore this flag — they still re-run eagerly
	*  so listeners stay in sync. */
	stale = false;
	constructor(args) {
		this.store = args.store;
		this.key = args.key;
		this.loader = args.loader;
		this.equality = args.equality ?? isEqual;
		const gcMs = this.store.getGcTimeMs();
		if (gcMs > 0) this.cancelGc = this.store.getScheduler()(() => this.dispose(), gcMs);
	}
	peek() {
		return this.value;
	}
	status() {
		return this.status_;
	}
	load() {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error(`Handle ${this.key} has been disposed`));
		if (this.inflight) return this.inflight;
		if (this.status_ === "ready" && this.value !== void 0 && !this.stale) return Promise.resolve(this.value);
		return this.runLoader();
	}
	/** Actually run the loader. Skips the cached-value short-circuit; used
	*  by `load()` (cold path) and `invalidate()` (force re-resolve).
	*
	*  Dep visibility during the load:
	*    - Each `ctx.depend(dep)` call is published to `this.deps`
	*      immediately so a mid-load `invalidate({…})` can match
	*      upfront-declared deps even before the loader awaits SQL.
	*    - On load success we replace `this.deps` with the freshly-
	*      collected list (drops any deps from the prior resolve that
	*      this resolve didn't re-declare).
	*    - On load failure we restore the prior deps so the next attempt
	*      still has a sensible matching baseline. */
	runLoader(batch) {
		this.store.metrics.loaderRuns++;
		this.pendingReinvalidate = false;
		this.changesDuringLoad = [];
		this.stale = false;
		this.status_ = this.value === void 0 ? "loading" : this.status_;
		this.error = void 0;
		this.retain();
		const priorDeps = this.deps;
		this.deps = priorDeps.slice();
		const collected = [];
		const collectedKeys = /* @__PURE__ */ new Set();
		const priorKeys = /* @__PURE__ */ new Set();
		for (const d of priorDeps) priorKeys.add(depKey(d));
		const onDep = (dep) => {
			const k = depKey(dep);
			if (collectedKeys.has(k)) {
				this.store.metrics.depsDeduplicatedAtRegistration++;
				return;
			}
			collectedKeys.add(k);
			collected.push(dep);
			if (!priorKeys.has(k)) this.deps.push(dep);
		};
		const p = this.loader({ depend(dep) {
			onDep(dep);
		} }).then((value) => {
			if (this.disposed) throw new Error(`Handle ${this.key} disposed mid-load`);
			this.deps = collected;
			if (!this.pendingReinvalidate) {
				for (const change of this.changesDuringLoad) if (this.matchesAgainst(collected, change)) {
					this.pendingReinvalidate = true;
					break;
				}
			}
			this.changesDuringLoad = [];
			const needsPostSettleReload = this.pendingReinvalidate && !this.disposed;
			this.value = value;
			this.status_ = "ready";
			this.error = void 0;
			this.inflight = null;
			this.suspendingPromise = null;
			const willNotify = !this.hasNotifiedValue || !this.equality(this.notifiedValue, value);
			if (needsPostSettleReload) batch?.finish(null);
			else if (willNotify) if (batch) batch.finish(() => this.notify(value));
			else this.notify(value);
			else {
				this.store.metrics.notifiesSkippedByDiff++;
				batch?.finish(null);
			}
			this.release();
			if (needsPostSettleReload) {
				this.pendingReinvalidate = false;
				if (this.listeners.size === 0) {
					this.stale = true;
					this.store.metrics.loaderInvalidationsDeferred++;
				} else {
					this.store.metrics.reloadsAfterSettle++;
					queueMicrotask(() => {
						if (this.disposed) return;
						if (this.inflight) return;
						this.runLoader().catch(() => {});
					});
				}
			}
			return value;
		}, (err) => {
			batch?.finish(null);
			if (!this.disposed) {
				this.deps = priorDeps;
				this.changesDuringLoad = [];
				this.status_ = "error";
				this.error = err;
				this.inflight = null;
				this.suspendingPromise = null;
				this.release();
				if (this.pendingReinvalidate) {
					this.pendingReinvalidate = false;
					if (this.listeners.size === 0) {
						this.stale = true;
						this.store.metrics.loaderInvalidationsDeferred++;
					} else {
						this.store.metrics.reloadsAfterSettle++;
						queueMicrotask(() => {
							if (this.disposed) return;
							if (this.inflight) return;
							this.runLoader().catch(() => {});
						});
					}
				}
			}
			throw err;
		});
		this.inflight = p;
		this.suspendingPromise = p;
		return p;
	}
	subscribe(listener) {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		this.retain();
		if ((this.status_ === "idle" || this.stale) && !this.inflight) this.load().catch(() => {});
		return () => {
			if (!this.listeners.delete(listener)) return;
			this.release();
		};
	}
	read() {
		if (this.status_ === "ready" && this.value !== void 0) return this.value;
		if (this.status_ === "error") throw this.error;
		if (this.suspendingPromise) throw this.suspendingPromise;
		throw this.load();
	}
	matches(change) {
		return this.matchesAgainst(this.deps, change);
	}
	matchesAgainst(deps, change) {
		if (deps.length === 0) return false;
		for (const dep of deps) if (matchesDep(dep, change)) return true;
		return false;
	}
	depCount() {
		return this.deps.length;
	}
	observeDuringLoad(change) {
		if (this.inflight) this.changesDuringLoad.push(change);
	}
	invalidate(batch) {
		if (this.disposed) {
			batch?.finish(null);
			return;
		}
		this.store.metrics.loaderInvalidations++;
		if (this.inflight) {
			this.store.metrics.midLoadInvalidations++;
			this.pendingReinvalidate = true;
			batch?.finish(null);
			return;
		}
		if (this.listeners.size === 0) {
			this.stale = true;
			this.store.metrics.loaderInvalidationsDeferred++;
			batch?.finish(null);
			return;
		}
		this.runLoader(batch).catch(() => {});
	}
	retain() {
		if (this.disposed) return;
		this.refCount++;
		if (this.cancelGc) {
			this.cancelGc();
			this.cancelGc = null;
		}
	}
	release() {
		if (this.disposed) return;
		if (this.refCount === 0) return;
		this.refCount--;
		if (this.refCount === 0) {
			const gcMs = this.store.getGcTimeMs();
			if (gcMs <= 0) {
				this.dispose();
				return;
			}
			this.cancelGc = this.store.getScheduler()(() => this.dispose(), gcMs);
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.cancelGc) {
			this.cancelGc();
			this.cancelGc = null;
		}
		this.listeners.clear();
		this.deps = [];
		this.changesDuringLoad = [];
		this.value = void 0;
		this.notifiedValue = void 0;
		this.hasNotifiedValue = false;
		this.status_ = "idle";
		this.inflight = null;
		this.suspendingPromise = null;
		this.store.remove(this.key);
	}
	notify(value) {
		if (this.listeners.size === 0) return;
		this.notifiedValue = value;
		this.hasNotifiedValue = true;
		this.store.metrics.notifiesFired++;
		const snapshot = Array.from(this.listeners);
		for (const fn of snapshot) try {
			fn(value);
		} catch (err) {
			console.error(`HandleStore listener error on ${this.key}:`, err);
		}
	}
	/** Test-only: snapshot of declared dependencies. */
	__depsForTest() {
		return this.deps;
	}
};
/** Canonical key for a `Dependency` used by the registration-time dedup
*  in `LoaderHandle.runLoader`. Two deps that produce the same key are
*  invalidation-equivalent: they match exactly the same set of
*  `ChangeNotification`s. SEP is `\x00` to avoid collisions between
*  fields (a channel literally named `"row"` won't collide with a row
*  dep's id). */
var depKey = (dep) => {
	switch (dep.kind) {
		case "row": return `row\x00${dep.id}`;
		case "parent-edge": return `pe\x00${dep.parentId}`;
		case "workspace": return `ws\x00${dep.workspaceId}`;
		case "table": return `tbl\x00${dep.table}`;
		case "plugin": return `p\x00${dep.channel}\x00${dep.key}`;
	}
};
var matchesDep = (dep, change) => {
	switch (dep.kind) {
		case "row": return change.rowIds ? has(change.rowIds, dep.id) : false;
		case "parent-edge": return change.parentIds ? has(change.parentIds, dep.parentId) : false;
		case "workspace": return change.workspaceIds ? has(change.workspaceIds, dep.workspaceId) : false;
		case "table": return change.tables ? has(change.tables, dep.table) : false;
		case "plugin": {
			const keys = change.plugin?.get(dep.channel);
			return keys ? has(keys, dep.key) : false;
		}
	}
};
var has = (xs, target) => {
	if (xs instanceof Set) return xs.has(target);
	for (const x of xs) if (x === target) return true;
	return false;
};
var stableKeyValue = (value, seen) => {
	if (value === void 0) return ["undefined"];
	if (value === null) return ["null"];
	if (typeof value === "boolean") return ["boolean", value];
	if (typeof value === "string") return ["string", value];
	if (typeof value === "bigint") return ["bigint", value.toString()];
	if (typeof value === "number") {
		if (Number.isNaN(value)) return ["number", "NaN"];
		if (Object.is(value, -0)) return ["number", "-0"];
		if (value === Infinity) return ["number", "Infinity"];
		if (value === -Infinity) return ["number", "-Infinity"];
		return ["number", value];
	}
	if (typeof value === "function" || typeof value === "symbol") throw new Error(`[handleKey] unsupported query arg value type: ${typeof value}`);
	if (value instanceof Date) return ["date", Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString()];
	if (seen.has(value)) throw new Error("[handleKey] cannot key cyclic query args");
	seen.add(value);
	try {
		if (Array.isArray(value)) return ["array", value.map((item) => stableKeyValue(item, seen))];
		const obj = value;
		return ["object", Object.keys(obj).sort().map((key) => [key, stableKeyValue(obj[key], seen)])];
	} finally {
		seen.delete(value);
	}
};
var stableArgsKey = (args) => JSON.stringify(stableKeyValue(args, /* @__PURE__ */ new WeakSet()));
/** Compose a Handle key from a name + optional args. Used by Repo
*  factories to construct identity-stable keys. */
var handleKey = (name, args) => args === void 0 ? name : `${name}:${stableArgsKey(args)}`;
/** Compute a `ChangeNotification` from a tx's per-id snapshots map.
*  Used by the TxEngine fast path (§9.3): post-commit, the engine
*  passes its snapshots map here and feeds the result into
*  `handleStore.invalidate(...)`.
*
*  Rules:
*    - `rowIds`: every id touched by the tx (any field change is enough
*       to invalidate row deps).
*    - `parentIds`: union of `before.parentId` / `after.parentId` when
*       the row's *membership* in a parent's live-children set changed
*       (creation, soft-deletion, restore, parent move), or the live
*       sibling order changed under the same parent (`order_key` update).
*       Pure content / property edits don't fire parent-edge deps.
*    - `workspaceIds`: every workspace_id touched (covers backlinks
*       handles' coarse workspace dep).
*    - `plugin`: channel/key invalidations emitted by plugin rules.
*
*  Note: `tables` is intentionally NOT auto-emitted. The `kind:'table'`
*  dep mechanism is still wired through `handleStore.invalidate(...)`,
*  but no production query depends on it — auto-emitting `['blocks']`
*  on every commit walked the channel for nothing. A plugin that
*  genuinely needs a coarse-table fallback should call
*  `handleStore.invalidate({tables: [...]})` directly, or (better)
*  contribute an `InvalidationRule` that emits a narrow plugin channel.
*/
var snapshotsToChangeNotification = (snapshots, invalidationRules = []) => {
	const rowIds = /* @__PURE__ */ new Set();
	const parentIds = /* @__PURE__ */ new Set();
	const workspaceIds = /* @__PURE__ */ new Set();
	for (const [id, entry] of snapshots) {
		rowIds.add(id);
		if (entry.before?.workspaceId) workspaceIds.add(entry.before.workspaceId);
		if (entry.after?.workspaceId) workspaceIds.add(entry.after.workspaceId);
		const beforeParent = entry.before?.parentId ?? null;
		const afterParent = entry.after?.parentId ?? null;
		const beforeOrderKey = entry.before?.orderKey;
		const afterOrderKey = entry.after?.orderKey;
		const beforeLive = !!entry.before && !entry.before.deleted;
		const afterLive = !!entry.after && !entry.after.deleted;
		if (!beforeLive && afterLive && afterParent !== null) parentIds.add(afterParent);
		else if (beforeLive && !afterLive && beforeParent !== null) parentIds.add(beforeParent);
		else if (beforeLive && afterLive && beforeParent !== afterParent) {
			if (beforeParent !== null) parentIds.add(beforeParent);
			if (afterParent !== null) parentIds.add(afterParent);
		} else if (beforeLive && afterLive && beforeParent !== null && beforeOrderKey !== afterOrderKey) parentIds.add(beforeParent);
	}
	return {
		rowIds,
		parentIds,
		workspaceIds,
		plugin: collectPluginInvalidationsFromSnapshots(invalidationRules, snapshots)
	};
};
//#endregion
export { HandleStore, HandleStoreMetrics, LoaderHandle, handleKey, snapshotsToChangeNotification, stableArgsKey };

//# sourceMappingURL=handleStore.js.map