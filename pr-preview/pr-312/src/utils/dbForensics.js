import { IdbKeyedStore } from "./idbKeyedStore.js";
import { scanForZeroPages } from "./opfsPageScan.js";
//#region src/utils/dbForensics.ts
/**
* Out-of-band forensic breadcrumbs for local-DB corruption.
*
* The recurring iPad OPFS corruptions (issue #284, [[ipad-opfs-corruption-1gib-page]])
* give us a clear END STATE but no record of the SEQUENCE that produced it, so
* we can't discriminate the candidate mechanisms (non-durable flush on process
* kill vs a WebKit-OPFS boundary bug vs a coop-lock/handle issue). This module
* records the breadcrumbs that would tell them apart, and captures a full
* forensic snapshot the moment corruption is detected.
*
* Everything here lives in IndexedDB, NOT in the OPFS SQLite file — the thing we
* are debugging is that file being corrupt, so forensic state must survive it.
* It is strictly best-effort: every public method swallows its own errors, so a
* failure to record instrumentation can never break boot, sync, or recovery.
*
* Dependency-free of `repoProvider`/`repo` (like `localDbCorruption`): callers
* pass the resolved `.db` filename and any DB-side context, so this can be
* imported from the DB-open path without a cycle.
*/
var FORENSICS_DB = "km-db-forensics";
var FORENSICS_STORE = "forensics";
var CURRENT_SESSION_KEY = "session:current";
var META_KEY = "meta";
var UNCLEAN_PREFIX = "unclean:";
var SNAPSHOT_PREFIX = "snapshot:";
var MAX_SESSION_EVENTS = 24;
var MAX_UNCLEAN_ARCHIVES = 20;
var MAX_SNAPSHOTS = 10;
var DB_FILE_SIBLING_SUFFIXES = [
	"-journal",
	"-wal",
	"-shm"
];
var VISIBILITY_PREFIX = "visibility:";
var warn = (msg, err) => console.warn(`[db-forensics] ${msg}`, err);
/**
* Best-effort forensic recorder. Construct with a custom store only in tests;
* production uses the {@link dbForensics} singleton.
*/
var DbForensics = class {
	constructor(store = new IdbKeyedStore(FORENSICS_DB, FORENSICS_STORE)) {
		this.store = store;
	}
	sessionMutex = Promise.resolve();
	snapshotSeq = 0;
	get(key) {
		return this.store.tx("readonly", (s) => s.get(key));
	}
	async put(key, value) {
		await this.store.tx("readwrite", (s) => s.put(value, key));
	}
	/** Run `op` after all previously-enqueued session mutations complete. `op`
	*  never rejects (bodies self-catch); the chain still guards against it. */
	enqueue(op) {
		const result = this.sessionMutex.then(op, op);
		this.sessionMutex = result.then(() => void 0, () => void 0);
		return result;
	}
	/**
	* Open a new session and detect whether the PREVIOUS one ended uncleanly (no
	* graceful `pagehide` before the process died). Returns whether the last
	* session was unclean plus the running count. Best-effort: on any failure
	* returns a benign default.
	*/
	recordSessionStart(opts) {
		return this.enqueue(async () => {
			try {
				const previous = await this.get(CURRENT_SESSION_KEY);
				const meta = await this.get(META_KEY) ?? { uncleanShutdownCount: 0 };
				let uncleanShutdown = false;
				if (previous && !previous.cleanShutdown) {
					uncleanShutdown = true;
					meta.uncleanShutdownCount += 1;
					await this.put(`${UNCLEAN_PREFIX}${previous.startedAt}`, previous);
					await this.trimByPrefix(UNCLEAN_PREFIX, MAX_UNCLEAN_ARCHIVES);
					await this.put(META_KEY, meta);
				}
				const now = Date.now();
				const session = {
					startedAt: now,
					lastSeenAt: now,
					cleanShutdown: false,
					lastVisibilityState: typeof document !== "undefined" ? document.visibilityState : null,
					userId: opts.userId,
					userAgent: navigator.userAgent,
					dbSizeAtStart: await safeDbSize(opts.dbFilename),
					events: [{
						t: now,
						type: "start"
					}]
				};
				await this.put(CURRENT_SESSION_KEY, session);
				return {
					uncleanShutdown,
					uncleanShutdownCount: meta.uncleanShutdownCount
				};
			} catch (err) {
				warn("recordSessionStart failed", err);
				return {
					uncleanShutdown: false,
					uncleanShutdownCount: 0
				};
			}
		});
	}
	/** Mark the current session as ended cleanly. Call on `pagehide`. */
	markCleanShutdown() {
		return this.setCleanShutdown(true, "clean-shutdown");
	}
	/** Un-mark clean shutdown — the session is live again (bfcache `pageshow` /
	*  Page-Lifecycle `resume`). Without this, a `pagehide`→restore→hard-kill
	*  sequence would read as clean on the next boot (false negative). */
	clearCleanShutdown() {
		return this.setCleanShutdown(false, "resume");
	}
	setCleanShutdown(value, eventType) {
		return this.enqueue(async () => {
			try {
				const current = await this.get(CURRENT_SESSION_KEY);
				if (!current) return;
				current.cleanShutdown = value;
				current.lastSeenAt = Date.now();
				current.events = appendCapped(current.events, {
					t: current.lastSeenAt,
					type: eventType
				});
				await this.put(CURRENT_SESSION_KEY, current);
			} catch (err) {
				warn("setCleanShutdown failed", err);
			}
		});
	}
	/** Append a lifecycle breadcrumb (visibilitychange / freeze / resume …). */
	recordLifecycleEvent(type) {
		return this.enqueue(async () => {
			try {
				const current = await this.get(CURRENT_SESSION_KEY);
				if (!current) return;
				const now = Date.now();
				current.lastSeenAt = now;
				if (type.startsWith(VISIBILITY_PREFIX)) current.lastVisibilityState = type.slice(11);
				current.events = appendCapped(current.events, {
					t: now,
					type
				});
				await this.put(CURRENT_SESSION_KEY, current);
			} catch (err) {
				warn("recordLifecycleEvent failed", err);
			}
		});
	}
	/**
	* Gather and persist a full forensic snapshot: OPFS inventory + sizes, storage
	* estimate, a zero-page scan (reused if the caller already ran one), the
	* current session + unclean-shutdown count, and any caller-supplied DB-side
	* context. Call on `SQLITE_CORRUPT` detection.
	*
	* NOTE: the byte scan (`safeScan`) reads the live OPFS `.db` unlocked. That's
	* acceptable here because it only runs on the corruption path, where the sync
	* worker is already failing to APPLY (not committing writes), so torn reads are
	* unlikely; and it's best-effort — a throw just yields `{error}` while the
	* cheap fields (inventory/estimate/session/sql) are still captured. We do NOT
	* scan on every boot (that unlocked full-file read would contend with the live
	* writer and could report torn-write false positives).
	*/
	async captureCorruptionSnapshot(opts) {
		try {
			const session = await this.get(CURRENT_SESSION_KEY) ?? null;
			const meta = await this.get(META_KEY) ?? { uncleanShutdownCount: 0 };
			const at = Date.now();
			const snapshot = {
				at,
				reason: opts.reason,
				userAgent: navigator.userAgent,
				dbFilename: opts.dbFilename,
				session,
				meta,
				opfs: await safeOpfsInventory(opts.dbFilename),
				estimate: await safeStorageEstimate(),
				scan: opts.scan ?? await safeScan(opts.dbFilename),
				sql: opts.sql
			};
			await this.put(`${SNAPSHOT_PREFIX}${at}-${this.snapshotSeq++}`, snapshot);
			await this.trimByPrefix(SNAPSHOT_PREFIX, MAX_SNAPSHOTS);
			return snapshot;
		} catch (err) {
			warn("captureCorruptionSnapshot failed", err);
			return null;
		}
	}
	/** Dump everything for download/inspection. Best-effort. */
	async exportAll() {
		const out = {};
		try {
			await this.store.scanByPrefix("readonly", "", (cursor) => {
				out[String(cursor.key)] = cursor.value;
			});
		} catch (err) {
			warn("exportAll failed", err);
		}
		return out;
	}
	/** Keep only the newest `keep` records under `prefix` (keys are `<prefix><ts>[-seq]`). */
	async trimByPrefix(prefix, keep) {
		const keys = [];
		await this.store.scanByPrefix("readonly", prefix, (cursor) => {
			if (typeof cursor.key === "string") keys.push(cursor.key);
		});
		if (keys.length <= keep) return;
		keys.sort((a, b) => tsOf(a, prefix) - tsOf(b, prefix));
		const doomed = keys.slice(0, keys.length - keep);
		for (const key of doomed) await this.store.tx("readwrite", (s) => s.delete(key));
	}
};
/** App singleton. */
var dbForensics = new DbForensics();
var tsOf = (key, prefix) => {
	const parsed = parseInt(key.slice(prefix.length), 10);
	return Number.isNaN(parsed) ? 0 : parsed;
};
var appendCapped = (arr, item, cap = MAX_SESSION_EVENTS) => {
	const next = [...arr, item];
	return next.length > cap ? next.slice(next.length - cap) : next;
};
var openOpfsFile = async (name) => {
	try {
		return await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
	} catch {
		return null;
	}
};
var safeDbSize = async (dbFilename) => {
	const file = await openOpfsFile(dbFilename);
	return file ? file.size : null;
};
var safeScan = async (dbFilename) => {
	try {
		const file = await openOpfsFile(dbFilename);
		if (!file) return null;
		return await scanForZeroPages(file);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
};
var safeStorageEstimate = async () => {
	try {
		if (typeof navigator.storage?.estimate !== "function") return { error: "estimate unavailable" };
		const { usage, quota } = await navigator.storage.estimate();
		return {
			usage,
			quota
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
};
var safeOpfsInventory = async (dbFilename) => {
	try {
		const root = await navigator.storage.getDirectory();
		const wanted = new Set([dbFilename, ...DB_FILE_SIBLING_SUFFIXES.map((s) => dbFilename + s)]);
		const entries = [];
		let ahpPools = 0;
		let otherFiles = 0;
		for await (const [name, handle] of iterateEntries(root)) {
			if (name.startsWith(".ahp-")) {
				ahpPools++;
				continue;
			}
			if (!wanted.has(name)) {
				otherFiles++;
				continue;
			}
			let size = null;
			if (handle.kind === "file") try {
				size = (await handle.getFile()).size;
			} catch {
				size = null;
			}
			entries.push({
				name,
				kind: handle.kind,
				size
			});
		}
		entries.push({
			name: `(.ahp-* pools)`,
			kind: "directory",
			size: ahpPools
		});
		entries.push({
			name: `(other entries)`,
			kind: "directory",
			size: otherFiles
		});
		return entries;
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
};
var iterateEntries = (root) => root.entries();
//#endregion
export { DbForensics, dbForensics };

//# sourceMappingURL=dbForensics.js.map