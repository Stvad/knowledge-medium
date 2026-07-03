//#region src/plugins/agent-runtime/watchEvents.ts
var DEFAULT_SETTLE_MS = 1e3;
var DEFAULT_TTL_MS = 10 * 6e4;
/** Collapse change bursts before re-running the watcher query. */
var CHANGE_THROTTLE_MS = 250;
/** Backlink watchers get a canned query so consumers never hand-roll
*  reference-table SQL: any edit to (or arrival/removal of) a block
*  referencing the target changes the fingerprint. */
var BACKLINKS_WATCH_SQL = `
  SELECT br.source_id AS id, coalesce(b.user_updated_at, b.updated_at) AS edited_at
    FROM block_references br JOIN blocks b ON b.id = br.source_id
   WHERE br.target_id = ? AND b.deleted = 0
   ORDER BY br.source_id`;
var BACKLINKS_WATCH_TABLES = ["blocks", "block_references"];
var watcherRuntimeFor = (spec) => ({
	name: spec.name,
	sql: spec.kind === "backlinks" ? BACKLINKS_WATCH_SQL : spec.sql,
	params: spec.kind === "backlinks" ? [spec.targetId] : spec.params ?? [],
	settleMs: spec.settleMs ?? DEFAULT_SETTLE_MS,
	fingerprint: null,
	settleTimer: null,
	computing: false,
	recheck: false,
	disposeOnChange: null
});
var watchTablesFor = (spec) => spec.kind === "backlinks" ? BACKLINKS_WATCH_TABLES : spec.tables ?? ["blocks"];
var createWatchEventsRegistry = (now = Date.now) => {
	const entries = /* @__PURE__ */ new Map();
	let transport = null;
	const setTransport = (next) => {
		transport = next;
	};
	const emitSettled = (consumer, runtime) => {
		const send = transport;
		if (!send) return;
		send({
			type: "watcher-settled",
			consumer,
			watcher: runtime.name
		}).catch((error) => {
			console.warn(`watch-events: failed to push ${consumer}/${runtime.name} event`, error);
		});
	};
	const disposeRuntime = (runtime) => {
		runtime.disposeOnChange?.();
		runtime.disposeOnChange = null;
		if (runtime.settleTimer !== null) clearTimeout(runtime.settleTimer);
		runtime.settleTimer = null;
	};
	const disposeConsumer = (consumer) => {
		const entry = entries.get(consumer);
		if (!entry) return;
		for (const runtime of entry.runtimes) disposeRuntime(runtime);
		entries.delete(consumer);
	};
	const armSettle = (consumer, runtime) => {
		if (runtime.settleTimer !== null) clearTimeout(runtime.settleTimer);
		runtime.settleTimer = setTimeout(() => {
			runtime.settleTimer = null;
			emitSettled(consumer, runtime);
		}, runtime.settleMs);
	};
	const computeLoop = async (db, consumer, runtime) => {
		runtime.computing = true;
		try {
			do {
				runtime.recheck = false;
				const rows = await db.getAll(runtime.sql, runtime.params);
				const fingerprint = JSON.stringify(rows);
				if (runtime.fingerprint !== null && fingerprint !== runtime.fingerprint) armSettle(consumer, runtime);
				runtime.fingerprint = fingerprint;
			} while (runtime.recheck);
		} finally {
			runtime.computing = false;
		}
	};
	const requestCompute = (db, consumer, runtime) => {
		const entry = entries.get(consumer);
		if (!entry) return;
		if (now() - entry.lastRefreshedMs > entry.ttlMs) {
			disposeConsumer(consumer);
			return;
		}
		if (runtime.computing) {
			runtime.recheck = true;
			return;
		}
		computeLoop(db, consumer, runtime).catch((error) => {
			console.warn(`watch-events: ${consumer}/${runtime.name} query failed`, error);
		});
	};
	/** Replace `consumer`'s registration. Idempotent: an identical spec
	*  only refreshes the TTL, preserving fingerprints and settle timers
	*  (a periodic re-register must not swallow a pending event). Resolves
	*  after the baseline query of every NEW watcher, so a successful
	*  response means the watchers are armed. */
	const register = async (db, registration) => {
		const { consumer, watchers } = registration;
		const ttlMs = registration.ttlMs ?? DEFAULT_TTL_MS;
		const specJson = JSON.stringify({
			watchers,
			ttlMs
		});
		const existing = entries.get(consumer);
		if (existing && existing.specJson === specJson) {
			existing.lastRefreshedMs = now();
			return {
				consumer,
				registered: existing.runtimes.map((runtime) => runtime.name),
				unchanged: true
			};
		}
		disposeConsumer(consumer);
		if (watchers.length === 0) return {
			consumer,
			registered: [],
			unchanged: false
		};
		const entry = {
			specJson,
			ttlMs,
			lastRefreshedMs: now(),
			runtimes: watchers.map(watcherRuntimeFor)
		};
		entries.set(consumer, entry);
		try {
			await Promise.all(entry.runtimes.map((runtime) => computeLoop(db, consumer, runtime)));
		} catch (error) {
			disposeConsumer(consumer);
			throw error;
		}
		watchers.forEach((spec, index) => {
			const runtime = entry.runtimes[index];
			runtime.disposeOnChange = db.onChange({
				onChange: () => requestCompute(db, consumer, runtime),
				onError: (error) => console.warn(`watch-events: ${consumer}/${runtime.name} subscription error`, error)
			}, {
				tables: watchTablesFor(spec),
				throttleMs: CHANGE_THROTTLE_MS
			});
		});
		return {
			consumer,
			registered: entry.runtimes.map((runtime) => runtime.name),
			unchanged: false
		};
	};
	const disposeAll = () => {
		for (const consumer of [...entries.keys()]) disposeConsumer(consumer);
	};
	return {
		register,
		setTransport,
		disposeAll
	};
};
/** The app-wide instance: commands.ts registers into it, bridge.ts owns
*  its transport lifecycle. */
var watchEventsRegistry = createWatchEventsRegistry();
//#endregion
export { createWatchEventsRegistry, watchEventsRegistry };

//# sourceMappingURL=watchEvents.js.map