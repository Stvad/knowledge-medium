//#region src/plugins/agent-runtime/watchEvents.ts
var DEFAULT_SETTLE_MS = 1e3;
var DEFAULT_TTL_MS = 10 * 6e4;
/** Collapse change bursts before re-running the watcher query. */
var CHANGE_THROTTLE_MS = 250;
/** How long a blur (notifyBlockSettled) keeps its block quiet-exempt in
*  flush emits — covers the editor's debounced content commit plus the
*  recheck below. */
var BLUR_EXEMPT_MS = 2500;
/** Second look after a blur: the editor flushes its debounced commit on
*  unmount, so the write may land shortly AFTER the blur signal. */
var BLUR_RECHECK_MS = 600;
/** Bound on settledBlocks per event — a mass change (import, sync burst)
*  degrades to an un-exempted tick, not an unbounded payload. */
var MAX_SETTLED_IDS = 128;
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
	lastEmittedById: /* @__PURE__ */ new Map(),
	currentById: /* @__PURE__ */ new Map(),
	pendingSettledIds: /* @__PURE__ */ new Set(),
	settleTimer: null,
	computing: false,
	recheck: false,
	disposeOnChange: null
});
var rowsById = (rows) => {
	const byId = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const id = row?.id;
		if (typeof id === "string" && id) byId.set(id, JSON.stringify(row));
	}
	return byId;
};
var watchTablesFor = (spec) => spec.kind === "backlinks" ? BACKLINKS_WATCH_TABLES : spec.tables ?? ["blocks"];
var createWatchEventsRegistry = (now = Date.now) => {
	const entries = /* @__PURE__ */ new Map();
	let transport = null;
	const setTransport = (next) => {
		transport = next;
	};
	/** blockId → exempt-until. Blocks the user explicitly left (blur /
	*  action) — the only ids a flush emit may report as settled. */
	const blurredUntil = /* @__PURE__ */ new Map();
	const isBlurredNow = (blockId) => {
		const until = blurredUntil.get(blockId);
		if (until === void 0) return false;
		if (now() > until) {
			blurredUntil.delete(blockId);
			return false;
		}
		return true;
	};
	/** Emit the watcher's event and advance its emitted-state reference.
	*  `timeConfirmed` (settle timer ran its full course) may report every
	*  pending id as settled; a blur FLUSH may only report ids whose
	*  quiet the user confirmed by leaving them — a concurrently-syncing
	*  edit from another device must not ride the exemption. */
	const emitSettled = (consumer, runtime, timeConfirmed) => {
		const settled = [...runtime.pendingSettledIds].filter((id) => timeConfirmed || isBlurredNow(id)).slice(0, MAX_SETTLED_IDS);
		if (timeConfirmed) {
			runtime.pendingSettledIds.clear();
			runtime.lastEmittedById = new Map(runtime.currentById);
		} else for (const id of settled) {
			runtime.pendingSettledIds.delete(id);
			const current = runtime.currentById.get(id);
			if (current === void 0) runtime.lastEmittedById.delete(id);
			else runtime.lastEmittedById.set(id, current);
		}
		const send = transport;
		if (!send) return;
		send({
			type: "watcher-settled",
			consumer,
			watcher: runtime.name,
			...settled.length > 0 ? { settledBlocks: settled } : {}
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
			emitSettled(consumer, runtime, true);
		}, runtime.settleMs);
	};
	const computeLoop = async (db, consumer, runtime) => {
		runtime.computing = true;
		try {
			do {
				runtime.recheck = false;
				const rows = await db.getAll(runtime.sql, runtime.params);
				const fingerprint = JSON.stringify(rows);
				runtime.currentById = rowsById(rows);
				if (runtime.fingerprint !== null && fingerprint !== runtime.fingerprint) {
					for (const [id, json] of runtime.currentById) if (runtime.lastEmittedById.get(id) !== json) runtime.pendingSettledIds.add(id);
					for (const id of runtime.lastEmittedById.keys()) if (!runtime.currentById.has(id)) runtime.pendingSettledIds.add(id);
					armSettle(consumer, runtime);
				} else if (runtime.fingerprint === null) runtime.lastEmittedById = new Map(runtime.currentById);
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
			db,
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
	/** Blur / explicit-signal path: the user is DONE with `blockId`, so
	*  don't wait out the settle window for changes it caused. Recompute
	*  now, flush any pending settle that involves this block, and look
	*  once more shortly after — the editor's debounced content commit
	*  usually lands just AFTER the blur signal. */
	const notifyBlockSettled = (blockId) => {
		blurredUntil.set(blockId, now() + BLUR_EXEMPT_MS);
		const flushPass = async () => {
			for (const [consumer, entry] of [...entries]) {
				if (now() - entry.lastRefreshedMs > entry.ttlMs) {
					disposeConsumer(consumer);
					continue;
				}
				for (const runtime of entry.runtimes) {
					if (!runtime.computing) await computeLoop(entry.db, consumer, runtime).catch((error) => {
						console.warn(`watch-events: ${consumer}/${runtime.name} query failed`, error);
					});
					if (runtime.settleTimer !== null && runtime.pendingSettledIds.has(blockId)) {
						clearTimeout(runtime.settleTimer);
						runtime.settleTimer = null;
						emitSettled(consumer, runtime, false);
						if (runtime.pendingSettledIds.size > 0) armSettle(consumer, runtime);
					}
				}
			}
		};
		flushPass();
		setTimeout(() => {
			flushPass();
		}, BLUR_RECHECK_MS);
	};
	const disposeAll = () => {
		for (const consumer of [...entries.keys()]) disposeConsumer(consumer);
	};
	return {
		register,
		setTransport,
		notifyBlockSettled,
		disposeAll
	};
};
/** The app-wide instance: commands.ts registers into it, bridge.ts owns
*  its transport lifecycle. */
var watchEventsRegistry = createWatchEventsRegistry();
//#endregion
export { createWatchEventsRegistry, watchEventsRegistry };

//# sourceMappingURL=watchEvents.js.map