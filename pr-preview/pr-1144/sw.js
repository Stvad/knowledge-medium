(function() {
	//#region src/sw/assets.ts
	/**
	* Which same-origin runtime assets the service worker serves cache-first from
	* the generation cache. Kept globals-free (primitives in, boolean out — no
	* `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
	* tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
	* (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
	*
	* `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
	* extension; the SW ALSO serves cache-first by `request.destination` (below), so
	* strictly the served set is a superset of the precached set. That superset is
	* empty in practice — every emitted dist asset carries a recognized extension,
	* so a destination-matched request always also matches by extension and was
	* precached. Importing the ONE extension definition here (instead of duplicating
	* the literal in the build script and diffing it in a test) keeps the two in
	* lockstep on the axis the precache is actually built from; the invariant that
	* closes the gap is "every served asset has a recognized extension", which holds
	* for our own emitted output.
	*/
	var ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/;
	var ASSET_DESTINATIONS = new Set([
		"script",
		"style",
		"worker",
		"font",
		"image"
	]);
	/**
	* True for a same-origin request the SW serves cache-first within the
	* generation. Match by `request.destination` first (covers the common cases a
	* browser labels) with an extension fallback for anything left as an empty
	* destination.
	*/
	var isCacheableAsset = (destination, pathname, sameOrigin) => sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname));
	//#endregion
	//#region src/data/dbFileSiblings.ts
	/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
	var WRITE_AHEAD_SIDECAR_SUFFIXES = ["-wa0", "-wa1"];
	/**
	* SQLite's own crash-recovery files. These must be removed BEFORE the main
	* `.db`: left beside a fresh database of the same name, SQLite replays them.
	*
	* Wider than what this app produces, deliberately: deletion should clear
	* anything SQLite could replay, whoever wrote it. Restoring is the opposite and
	* uses a narrower whitelist — see `exportSqliteDb`.
	*/
	var SQLITE_JOURNAL_SUFFIXES = [
		"-journal",
		"-wal",
		"-shm"
	];
	[...SQLITE_JOURNAL_SUFFIXES, ...WRITE_AHEAD_SIDECAR_SUFFIXES];
	//#endregion
	//#region src/sw/preview.ts
	/**
	* PR-preview subtree gating. github.io is ONE origin for production
	* (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
	* production/root SW's scope is a PREFIX of every preview path, and since we
	* never `clients.claim()`, the production SW controls a freshly-opened preview
	* page until it reloads — and would otherwise cache the preview's shell +
	* assets under production's OWN keys, poisoning the offline production shell
	* with an unmerged build. So a SW refuses to serve/cache a preview subtree it
	* doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
	*
	* Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
	* directly and shared without dragging worker types.
	*/
	var PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//;
	/**
	* True when this SW must NOT touch a request: the request targets a preview
	* subtree that this scope does not own. A preview-scoped SW (its own scope is
	* under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
	*/
	var isForeignPreviewRequest = (ownScopeIsPreview, pathname) => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname);
	//#endregion
	//#region src/sw/ledger.ts
	/**
	* Pure decisions over the generation ledger — an install-ordered list of
	* BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
	* (reading/writing the ledger Response in the meta cache); the retention math
	* lives here so it unit-tests without a cache.
	*
	* Each deploy is an immutable generation with its own km-shell-<id> /
	* km-assets-<id> caches. On activate we keep the most recent `keep`
	* generations (so a tab still on a prior build has a consistent cache to read
	* from) and GC the rest.
	*/
	/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
	var computeKeepIds = (ledger, keep) => ledger.slice(Math.max(0, ledger.length - keep));
	/**
	* The ids that have aged out of the keep-window and whose caches should be
	* GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
	*/
	var computeExpiredIds = (ledger, keep) => ledger.slice(0, Math.max(0, ledger.length - keep));
	/**
	* Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
	* on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
	* (written before timestamps existed) — the latter has no timestamp, which the
	* sweeper reads as "staleness unprovable → never reap". Anything else (null,
	* garbage, non-array ids) degrades to an empty ledger.
	*/
	var normalizeLedger = (raw) => {
		if (Array.isArray(raw)) return {
			ids: raw,
			updatedAt: void 0
		};
		if (raw && typeof raw === "object" && Array.isArray(raw.ids)) {
			const { ids, updatedAt } = raw;
			return {
				ids,
				updatedAt: typeof updatedAt === "number" ? updatedAt : void 0
			};
		}
		return {
			ids: [],
			updatedAt: void 0
		};
	};
	/**
	* Decide which OTHER-scope generation caches a sweep should reclaim. Cache
	* Storage is shared per-origin, so a client accumulates the caches of every PR
	* preview it ever visited; once a PR is merged/closed its preview SW never runs
	* again to GC them, so they leak forever. This sweep (run from any active SW's
	* activate) reclaims them — but ONLY:
	*   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
	*     is NEVER a preview scope, so it can never be reaped here — the sweep is
	*     structurally incapable of touching prod caches.
	*   - that are STALE: a numeric updatedAt older than staleMs. A legacy
	*     untimestamped ledger (updatedAt undefined) is never reaped — we can't
	*     prove it's abandoned. The current scope's own ledger was just re-stamped
	*     on install, so it's fresh and self-excluded.
	* A generation id still referenced by any KEPT (non-reaped) ledger is spared —
	* two deploys can in principle share a build sha, and we must not delete a cache
	* a live scope depends on. The stale ledger ENTRY is removed regardless (the
	* scope is gone), even when its cache was shared-protected.
	*/
	var computeReapableCaches = ({ ledgers, now, staleMs, selfScopeUrl }) => {
		const isPreviewScope = (scopeUrl) => {
			try {
				return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname);
			} catch {
				return false;
			}
		};
		const isStale = (l) => typeof l.updatedAt === "number" && now - l.updatedAt > staleMs;
		const reapable = ledgers.filter((l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l));
		const reapableSet = new Set(reapable);
		const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids));
		const reapIds = /* @__PURE__ */ new Set();
		for (const l of reapable) for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id);
		return {
			reapIds: [...reapIds],
			ledgerScopeUrls: reapable.map((l) => l.scopeUrl)
		};
	};
	//#endregion
	//#region src/utils/idbKeyedStore.ts
	/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
	var promisifyRequest = (request) => new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
	*  A readwrite write is only durable once the tx commits — `onsuccess` fires
	*  earlier, while the tx is still open — so a caller that navigates/reloads
	*  right after a write can have an un-committed tx rolled back. Handlers are
	*  registered synchronously by the caller (before any await) so an `oncomplete`
	*  that fires before we start awaiting can't be missed. */
	var txCommitted = (transaction) => new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
	});
	/** Record-id prefix for all of an owner's records. The trailing `:` plus
	*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
	*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
	*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
	var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
	/** Composite record id. Each segment is encoded so a delimiter inside an id
	*  can't make two distinct `(owner, id)` pairs collide. */
	var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
	/**
	* A cached connection to one named DB + one object store, with commit-durable
	* transactions. Each instance owns its own connection handle, so constructing a
	* fresh instance against the same DB models a page reload (a new tab/handle
	* reopening persisted data) — which is exactly how the consumers' tests verify
	* durability.
	*/
	var IdbKeyedStore = class {
		dbPromise = null;
		constructor(dbName, storeName, version = 1) {
			this.dbName = dbName;
			this.storeName = storeName;
			this.version = version;
		}
		openDb() {
			if (!this.dbPromise) {
				const opened = new Promise((resolve, reject) => {
					const request = indexedDB.open(this.dbName, this.version);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
					};
					request.onsuccess = () => {
						const db = request.result;
						db.onclose = () => {
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						db.onversionchange = () => {
							db.close();
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						resolve(db);
					};
					request.onerror = () => reject(request.error);
				}).catch((err) => {
					if (this.dbPromise === opened) this.dbPromise = null;
					throw err;
				});
				this.dbPromise = opened;
			}
			return this.dbPromise;
		}
		/**
		* Open a transaction and return its object store plus a commit fence. PRIVATE
		* and footgun-laden by design — the caller must issue its first request
		* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
		* on an error path) or a tx abort surfaces as an unhandled rejection. The public
		* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
		* that contract so callers never have to.
		*/
		async openTransaction(mode) {
			const transaction = (await this.openDb()).transaction(this.storeName, mode);
			const committed = txCommitted(transaction);
			return {
				store: transaction.objectStore(this.storeName),
				committed
			};
		}
		/**
		* Run `body` against the store within one transaction and resolve on the
		* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
		* issue its first request synchronously — it is invoked in the same task that
		* created the tx (see the file header on activeness). If `body` rejects (or the
		* commit fence does), the fence's rejection is observed here so it can't surface
		* as an unhandled rejection, and the original error propagates. Use for cursor
		* scans / read-modify-write; single-request ops use {@link tx}.
		*/
		async runTransaction(mode, body) {
			const { store, committed } = await this.openTransaction(mode);
			try {
				const result = await body(store);
				await committed;
				return result;
			} catch (err) {
				committed.catch(() => {});
				throw err;
			}
		}
		/**
		* Run a single request against the store, resolving on the transaction COMMIT
		* (durability). The common case; multi-request / cursor work uses
		* {@link runTransaction}.
		*/
		async tx(mode, run) {
			return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
		}
		/**
		* Walk every record whose key starts with `prefix` (the per-owner namespace
		* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
		* commit-durable transaction. A value cursor, because `visit` reads
		* `cursor.value`; the `:`-delimited prefix is collision-free across owners, so
		* a scan never reaches a sibling owner. `visit` is synchronous
		* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
		* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
		* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
		* readwrite scan's partial writes) and rejects with that error.
		*/
		async scanByPrefix(mode, prefix, visit) {
			await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					try {
						if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
						cursor.continue();
					} catch (err) {
						try {
							store.transaction.abort();
						} catch {}
						reject(err);
					}
				};
				request.onerror = () => reject(request.error);
			}));
		}
		/**
		* Delete every record whose key starts with `prefix`, in one commit-durable
		* readwrite transaction. One ranged delete rather than a value cursor: a
		* cursor deserialises every record in the store to test its key, and some
		* stores hold multi-MB records. The range is exactly "starts with": every
		* key from `prefix` up to, excluding, the prefix with its last code unit
		* incremented.
		*/
		async deleteByPrefix(prefix) {
			const last = prefix.charCodeAt(prefix.length - 1);
			if (last === 65535) throw new Error("deleteByPrefix: the prefix has no successor");
			const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
			await this.tx("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, upper, false, true)));
		}
	};
	//#endregion
	//#region src/sw/bootStore.ts
	/**
	* The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
	* a cold launch answers them without touching Cache Storage. On iOS the first
	* Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
	* which cache or how many entries (measured against an IndexedDB open in the
	* same worker: 17 ms); Cache Storage stays the store for everything lazy.
	*
	* Entries are keyed by build id, so a worker only ever serves its own
	* generation's bytes and the activate GC reaps a generation by prefix.
	*/
	var bootKeyPrefix = (buildId) => idbKeyPrefix(buildId);
	var bootKey = (buildId, url) => idbRecordId(buildId, url);
	var idbBootStore = () => {
		const store = new IdbKeyedStore("km-boot", "entries");
		return {
			get: (key) => store.tx("readonly", (s) => s.get(key)),
			putAll: (entries) => store.runTransaction("readwrite", async (s) => {
				for (const [key, entry] of entries) s.put(entry, key);
			}),
			deletePrefix: (prefix) => store.deleteByPrefix(prefix)
		};
	};
	//#endregion
	//#region src/sw/previewDatabases.ts
	var SERVICE_WORKER_META_CACHE = "km-meta";
	var PREVIEW_DATABASE_RECORD_BASENAME = "__km_database__";
	var previewDatabaseRecordInfo = (recordUrl, ledgerBasename) => {
		try {
			const url = new URL(recordUrl);
			const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`;
			const markerIndex = url.pathname.indexOf(marker);
			if (markerIndex < 0) return null;
			const encodedName = url.pathname.slice(markerIndex + marker.length);
			if (!encodedName || encodedName.includes("/")) return null;
			const scopePath = url.pathname.slice(0, markerIndex + 1);
			return {
				scopeUrl: `${`${url.origin}${scopePath}`}${ledgerBasename}`,
				name: decodeURIComponent(encodedName)
			};
		} catch {
			return null;
		}
	};
	//#endregion
	//#region src/sw/worker.ts
	/**
	* The service worker's orchestration — ledger I/O, install precache, activate
	* GC, and fetch routing — as a factory parameterized by its globals
	* (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
	* entry (src/sw/sw.ts) constructs one of these with the real globals + injected
	* build config and wires it to the SW events; tests construct one with an
	* in-memory CacheStorage and a stub fetch and drive install/activate/fetch
	* directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
	* makes it importable + unit-testable outside a worker.
	*
	* The versioning model this implements is documented in the sw.ts header.
	*/
	var CACHE_PREFIX = "km-";
	var VENDOR_HOSTS = new Set(["esm.sh"]);
	var SHELL_PATHS = [
		"./",
		"./index.html",
		"./manifest.webmanifest",
		"./icon.svg",
		"./icon-192.png",
		"./icon-512.png",
		"./icon-maskable.png",
		"./apple-touch-icon.png"
	];
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const SHELL_URLS = SHELL_PATHS.map(toScopeUrl);
		const PRECACHE_ASSETS = config.precacheAssets.map(toScopeUrl);
		const PRECACHE_REST_ASSETS = config.precacheRestAssets.map(toScopeUrl);
		const PRECACHE_VENDOR = config.precacheVendor;
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [
			[SHELL_CACHE, [SHELL_URL]],
			[ASSET_CACHE, PRECACHE_ASSETS],
			[VENDOR_CACHE, PRECACHE_VENDOR]
		];
		const BOOT_URLS = new Set(BOOT_SET.flatMap(([, urls]) => urls));
		const deleteGeneration = (id) => [
			caches.delete(`${CACHE_PREFIX}shell-${id}`),
			caches.delete(`${CACHE_PREFIX}assets-${id}`),
			env.bootStore?.deletePrefix(bootKeyPrefix(id)).catch(() => void 0)
		];
		const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname);
		const LEDGER_BASENAME = "__km_generations__";
		const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`);
		const readLedgerEntry = async () => {
			try {
				const res = await (await caches.open(META_CACHE)).match(LEDGER_KEY);
				if (!res) return {
					ids: [],
					updatedAt: void 0
				};
				return normalizeLedger(await res.json());
			} catch {
				return {
					ids: [],
					updatedAt: void 0
				};
			}
		};
		const readLedger = async () => (await readLedgerEntry()).ids;
		const writeLedgerEntry = async (entry) => {
			const cache = await caches.open(META_CACHE);
			const nextEntry = {
				...entry,
				updatedAt: now()
			};
			await cache.put(LEDGER_KEY, new Response(JSON.stringify(nextEntry), { headers: { "content-type": "application/json" } }));
		};
		let ledgerMutationChain = Promise.resolve();
		const mutateLedgerEntry = async (mutate) => {
			const run = ledgerMutationChain.then(async () => {
				await writeLedgerEntry(await mutate(await readLedgerEntry()));
			});
			ledgerMutationChain = run.catch(() => {});
			await run;
		};
		const recordGeneration = async (id) => {
			await mutateLedgerEntry((entry) => {
				const ids = entry.ids.filter((x) => x !== id);
				ids.push(id);
				return {
					...entry,
					ids
				};
			});
		};
		const writeLedger = async (ids) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids
			}));
		};
		const trimLedger = async () => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: computeKeepIds(entry.ids, keepGenerations)
			}));
		};
		let lastTouchAt = 0;
		const maybeTouchOwnLedger = (waitUntil) => {
			if (!OWN_SCOPE_IS_PREVIEW) return;
			const t = now();
			if (t - lastTouchAt <= config.touchIntervalMs) return;
			lastTouchAt = t;
			const touch = (async () => {
				try {
					await mutateLedgerEntry((entry) => entry);
				} catch {}
			})();
			if (waitUntil) waitUntil(touch);
		};
		const install = async () => {
			await recordGeneration(buildId);
			const [shell, assets, vendor] = await Promise.all([
				caches.open(SHELL_CACHE),
				caches.open(ASSET_CACHE),
				caches.open(VENDOR_CACHE)
			]);
			const fetchInto = (cache, url, mode) => fetch(new Request(url, { cache: mode })).then((res) => res && res.ok ? cache.put(url, res) : null).catch(() => null);
			const runPooled = async (items, limit, task) => {
				let next = 0;
				const worker = async () => {
					while (next < items.length) await task(items[next++]);
				};
				await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
			};
			await Promise.all(SHELL_URLS.map((u) => fetchInto(shell, u, "reload")));
			await Promise.all([runPooled(PRECACHE_ASSETS, 16, (u) => fetchInto(assets, u, "no-cache")), runPooled(PRECACHE_VENDOR, 16, (u) => fetchInto(vendor, u, "default"))]);
			await seedBootStore();
			await runPooled(PRECACHE_REST_ASSETS, 16, (u) => fetchInto(assets, u, "no-cache"));
		};
		const seedBootStore = async () => {
			const store = env.bootStore;
			if (!store) return;
			try {
				for (const [cacheName, urls] of BOOT_SET) {
					const cache = await caches.open(cacheName);
					const entries = [];
					for (const url of urls) {
						const cached = await cache.match(url);
						if (!cached) continue;
						entries.push([bootKey(buildId, url), {
							status: cached.status,
							contentType: cached.headers.get("content-type") ?? "application/octet-stream",
							body: await cached.arrayBuffer()
						}]);
					}
					await store.putAll(entries);
				}
			} catch {}
		};
		const bootStoreFirst = async (url, fallback) => {
			const store = env.bootStore;
			if (store && BOOT_URLS.has(url)) try {
				const entry = await store.get(bootKey(buildId, url));
				if (entry) {
					env.mark?.("bootStoreHitAt");
					return new Response(entry.body, {
						status: entry.status,
						headers: { "content-type": entry.contentType }
					});
				}
			} catch {}
			return fallback();
		};
		const activate = async () => {
			const ledger = await readLedger();
			const keepIds = new Set(computeKeepIds(ledger, keepGenerations));
			const expiredIds = computeExpiredIds(ledger, keepGenerations);
			await Promise.all(expiredIds.flatMap(deleteGeneration));
			if (ledger.length > keepIds.size) try {
				await trimLedger();
			} catch {}
			try {
				await sweepStalePreviewGenerations();
			} catch {}
		};
		const sweepStalePreviewGenerations = async () => {
			const meta = await caches.open(META_CACHE);
			const ledgers = [];
			const databaseRecords = [];
			for (const req of await meta.keys()) {
				if (req.url.endsWith(`/${LEDGER_BASENAME}`)) {
					const res = await meta.match(req);
					if (!res) continue;
					const { ids, updatedAt } = normalizeLedger(await res.json().catch(() => null));
					ledgers.push({
						scopeUrl: req.url,
						ids,
						updatedAt
					});
					continue;
				}
				const recordInfo = previewDatabaseRecordInfo(req.url, LEDGER_BASENAME);
				if (recordInfo) {
					const res = await meta.match(req);
					const raw = res ? await res.json().catch(() => null) : null;
					databaseRecords.push({
						...recordInfo,
						recordUrl: req.url,
						updatedAt: databaseRecordUpdatedAt(raw)
					});
				}
			}
			const sweepNow = now();
			const plan = computeReapableCaches({
				ledgers,
				now: sweepNow,
				staleMs: config.staleScopeMs,
				selfScopeUrl: LEDGER_KEY
			});
			await Promise.all([
				sweepStalePreviewDatabases(meta, {
					ledgerScopeUrls: plan.ledgerScopeUrls,
					knownLedgerScopeUrls: ledgers.map(({ scopeUrl }) => scopeUrl),
					databaseRecords,
					sweepNow,
					staleMs: config.staleScopeMs
				}),
				...plan.reapIds.flatMap(deleteGeneration),
				...plan.ledgerScopeUrls.map((url) => meta.delete(url))
			]);
		};
		const databaseRecordUpdatedAt = (raw) => {
			if (!raw || typeof raw !== "object") return void 0;
			const { updatedAt } = raw;
			return typeof updatedAt === "number" ? updatedAt : void 0;
		};
		const previewIdForScopeUrl = (scopeUrl) => {
			try {
				return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null;
			} catch {
				return null;
			}
		};
		const isDatabaseNameForPreviewScope = (databaseName, scopeUrl) => {
			const previewId = previewIdForScopeUrl(scopeUrl);
			if (!previewId) return false;
			const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^kmp-v\\d+~${escapedPreviewId}~[A-Za-z0-9_-]*\\.db$`).test(databaseName);
		};
		const databaseRecordsToSweep = (ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs) => {
			const reapedScopes = new Set(ledgerScopeUrls);
			const knownScopes = new Set(knownLedgerScopeUrls);
			const records = [];
			const seen = /* @__PURE__ */ new Set();
			for (const record of databaseRecords) {
				const orphanedStaleRecord = typeof record.updatedAt === "number" && sweepNow - record.updatedAt > staleMs && !knownScopes.has(record.scopeUrl);
				if (!reapedScopes.has(record.scopeUrl) && !orphanedStaleRecord) continue;
				if (!isDatabaseNameForPreviewScope(record.name, record.scopeUrl)) continue;
				const key = `${record.scopeUrl}\n${record.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
			return records;
		};
		const sweepStalePreviewDatabases = async (meta, { ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs }) => {
			const databases = databaseRecordsToSweep(ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs);
			await Promise.all(databases.map(async ({ name, recordUrl }) => {
				try {
					await deleteOpfsSqliteDatabase(name);
					await deleteIndexedDatabase(name).catch(() => {});
				} catch {
					return;
				}
				await meta.delete(recordUrl).catch(() => false);
			}));
		};
		const deleteOpfsSqliteDatabase = async (databaseName) => {
			if (typeof env.storage?.getDirectory !== "function") return;
			const root = await env.storage.getDirectory();
			const journalFailure = (await Promise.allSettled(SQLITE_JOURNAL_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)))).find((result) => result.status === "rejected");
			if (journalFailure) throw journalFailure.reason;
			await removeOpfsEntryIfExists(root, databaseName);
			await Promise.allSettled(WRITE_AHEAD_SIDECAR_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)));
		};
		const removeOpfsEntryIfExists = async (root, name) => {
			try {
				await root.removeEntry(name);
			} catch (err) {
				if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
			}
		};
		const deleteIndexedDatabase = async (databaseName) => {
			const idb = env.indexedDB;
			if (typeof idb?.deleteDatabase !== "function") return;
			if (typeof idb.databases === "function") {
				const existing = await idb.databases().catch(() => null);
				if (existing && !existing.some((db) => db.name === databaseName)) return;
			}
			await new Promise((resolve, reject) => {
				const request = idb.deleteDatabase(databaseName);
				let settled = false;
				const settle = (fn) => {
					if (settled) return;
					settled = true;
					fn();
				};
				request.onsuccess = () => settle(resolve);
				request.onerror = () => settle(() => reject(request.error));
				request.onblocked = () => settle(() => reject(/* @__PURE__ */ new Error(`IndexedDB delete blocked for ${databaseName}`)));
			});
		};
		const isNavigationRequest = (request) => request.mode === "navigate" || request.method === "GET" && (request.headers.get("accept")?.includes("text/html") ?? false);
		const isSameOrigin = (url) => url.origin === env.origin;
		const isVendor = (url) => VENDOR_HOSTS.has(url.hostname);
		const shellCacheFirst = async (request, shellURL) => {
			const cache = await caches.open(SHELL_CACHE);
			env.mark?.("shellCacheOpenedAt");
			const cached = await cache.match(shellURL);
			env.mark?.("shellCacheMatchedAt");
			if (cached) return cached;
			const fresh = await fetch(request);
			if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {});
			return fresh;
		};
		const assetCacheFirst = async (request) => {
			const assets = await caches.open(ASSET_CACHE);
			const cached = await assets.match(request) || await (await caches.open(SHELL_CACHE)).match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		const cacheFirst = async (request, cacheName) => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		/**
		* Route a GET request. Returns a Response promise for the entry to
		* `respondWith`, or undefined to NOT intercept (let the browser handle it —
		* non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
		* like version.json that must stay fresh).
		*/
		const handleFetch = (request, waitUntil) => {
			if (request.method !== "GET") return void 0;
			const url = new URL(request.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
			maybeTouchOwnLedger(waitUntil);
			if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return void 0;
			if (isNavigationRequest(request) && isSameOrigin(url)) {
				if (url.pathname === scopeURL.pathname || url.href.split(/[?#]/)[0] === SHELL_URL) return bootStoreFirst(SHELL_URL, () => shellCacheFirst(request, SHELL_URL));
				return shellCacheFirst(request, SHELL_URL);
			}
			if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) return bootStoreFirst(request.url, () => assetCacheFirst(request));
			if (isVendor(url)) return bootStoreFirst(request.url, () => cacheFirst(request, VENDOR_CACHE));
		};
		return {
			install,
			activate,
			handleFetch,
			readLedger,
			writeLedger,
			recordGeneration
		};
	};
	//#endregion
	//#region src/sw/sw.ts
	var bootMarks = {
		timeOrigin: performance.timeOrigin,
		evaluatedAt: 0,
		firstNavReceivedAt: 0,
		firstNavAnsweredAt: 0
	};
	var mark = (name) => {
		if (!bootMarks[name]) bootMarks[name] = performance.now();
	};
	var sw = createServiceWorker({
		buildId: "5497438d8b9f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 336 * 60 * 60 * 1e3,
		touchIntervalMs: 1440 * 60 * 1e3,
		precacheAssets: JSON.parse("[\"/knowledge-medium/pr-preview/pr-1144/app.css\",\"/knowledge-medium/pr-preview/pr-1144/assets/FacadeVFS-DS1JLDjD.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/OPFSCoopSyncVFS-DUK8kT25.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/OPFSWriteAheadVFS-BUN0LxDR.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/WASQLiteDB.worker-C-3Jt4AW.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/wa-sqlite-CcLbPFAt.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/wa-sqlite-XZW__iJk.wasm\",\"/knowledge-medium/pr-preview/pr-1144/assets/wa-sqlite-async-atB8hSqL.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/wa-sqlite-async-rHzzC98y.wasm\",\"/knowledge-medium/pr-preview/pr-1144/assets/writeAheadVfsProbe.worker-BWKVI_xt.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/app-C2oUvK4u.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/rolldown-runtime-DfajK13Y.js\",\"/knowledge-medium/pr-preview/pr-1144/index.js\"]"),
		precacheRestAssets: JSON.parse("[\"/knowledge-medium/pr-preview/pr-1144/apple-touch-icon.png\",\"/knowledge-medium/pr-preview/pr-1144/assets/AccessHandlePoolVFS-NySbHfrn.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/IDBBatchAtomicVFS-Bsmoh6xT.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/SharedSyncImplementation.worker-DLI2cC4_.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/mc-wa-sqlite-BrCENXz4.js\",\"/knowledge-medium/pr-preview/pr-1144/assets/mc-wa-sqlite-CnHbhWvs.wasm\",\"/knowledge-medium/pr-preview/pr-1144/assets/mc-wa-sqlite-async-D6idQS2r.wasm\",\"/knowledge-medium/pr-preview/pr-1144/assets/mc-wa-sqlite-async-xmNgTawq.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/AccessHandlePoolVFS-Ce5uDLys.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/FacadeVFS-C2kles4R.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/IDBBatchAtomicVFS-DEFHQpf1.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/OPFSCoopSyncVFS-eyVifM2G.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/OPFSWriteAheadVFS-Ct8j6A5J.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/Preview-CxemEFou.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/babel-1OIjZQ46.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/dash.all.min-D7KuawX-.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/dist-7Q-q6Ibu.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/dist-BLjvutrM.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/dist-hfILCBJ6.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/hls-CzNtN_XV.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/mc-wa-sqlite-Hm_lYmSw.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/mc-wa-sqlite-async-CqbaD6dG.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-B455trNI.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-BMevzMr6.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-By-SXZxu.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-CSiufGGb.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-Cj6UQSXf.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-CmSRMeaB.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-D9Vn_uC8.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/react-Z9-7TG4v.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/wa-sqlite-CJqXmFCC.js\",\"/knowledge-medium/pr-preview/pr-1144/chunks/wa-sqlite-async-COEhKvbr.js\",\"/knowledge-medium/pr-preview/pr-1144/extension-utilities.css\",\"/knowledge-medium/pr-preview/pr-1144/icon-192.png\",\"/knowledge-medium/pr-preview/pr-1144/icon-512.png\",\"/knowledge-medium/pr-preview/pr-1144/icon-maskable.png\",\"/knowledge-medium/pr-preview/pr-1144/icon-maskable.svg\",\"/knowledge-medium/pr-preview/pr-1144/icon.svg\",\"/knowledge-medium/pr-preview/pr-1144/mc-wa-sqlite-async.wasm\",\"/knowledge-medium/pr-preview/pr-1144/mc-wa-sqlite.wasm\",\"/knowledge-medium/pr-preview/pr-1144/src/App.js\",\"/knowledge-medium/pr-preview/pr-1144/src/appUpdate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/appVersion.js\",\"/knowledge-medium/pr-preview/pr-1144/src/bootstrap/initialLayout.js\",\"/knowledge-medium/pr-preview/pr-1144/src/bootstrap/resolveWorkspace.js\",\"/knowledge-medium/pr-preview/pr-1144/src/bootstrap/workspaceBootstrap.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/BlockComponent.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/BlockCrumbs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/BlockEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/BlockLoadingPlaceholder.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/BlockProperties.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/BlockSearchPicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ConfirmBulkDeleteDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/Header.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/LazyBlockComponent.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/Login.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/editModeKeepalive.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/EnumOptionsConfigEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/RefPropertyEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/RefTargetTypePicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/SelectPropertyEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/TypesPropertyEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/defaults.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/kernelValuePresets.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/selectablePresets.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyEditors/typesPropertyUi.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/AddPropertyForm.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/PropertyPicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/PropertyRow.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/Rows.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/declarationOnly.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/layout.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/model.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/shapeUi.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/shapes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/usePropertyEditingActivation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanel/visibility.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/propertyPanelSections.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/BlockEmbed.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/BlockRef.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/ReferenceLink.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/cycleGuard.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/cycleGuardContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/referenceLayout.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/references/useBlockRefAncestors.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/BlockInfoDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/BlockTypeBlockRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/BulletHoverCard.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/CodeMirrorContentRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/DefaultBlockRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/LayoutRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/MarkdownContentRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/MissingDataRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/PanelRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/PropertySchemaBlockRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/TopLevelRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/blockTitleText.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/fieldCreationKeydown.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/renderer/layoutRootContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/typeChip/TypeChip.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/typeChip/chipStyle.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/anchored-floating.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/button.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/card.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/checkbox.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/collapsible.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/command.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/context-menu.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/dialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/dropdown-menu.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/floating-listbox.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/input.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/kbd.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/label.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/ui/textarea.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/useEditModeYieldKeepalive.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/util/FocusedRowLazyMount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/util/LazyViewportMount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/util/LocalDbCorruptionFallback.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/util/error.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/util/lazyMountRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/util/suspense.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/workspace/CreateWorkspaceDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/workspace/PendingInvitations.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/workspace/WorkspaceKeyGate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/workspace/WorkspaceSettingsDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/components/workspace/WorkspaceSwitcher.js\",\"/knowledge-medium/pr-preview/pr-1144/src/context/backgroundSubtree.js\",\"/knowledge-medium/pr-preview/pr-1144/src/context/block.js\",\"/knowledge-medium/pr-preview/pr-1144/src/context/layoutWsContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/context/repo.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/aliasClaim.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/blockData.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/blockType.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/changeScope.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/codecs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/derivedData.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/errors.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/events.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/handle.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/mutator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/processor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/propertySchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/query.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/sameTxProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/tx.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/typedBlockQuery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/user.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/valuePresetCore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/api/valuePresets.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/block.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/blockCache.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/blockId.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/blockLiveness.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/blockMerge.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/blockSchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/blockTypes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/clientContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/dbFileSiblings.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/definitionSeeds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/derivedIds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/facetBridge.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/facets.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/globalState.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/aliasClaimRederiveProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/ancestorBatch.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/blockTypeTypeifyProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/clientSchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/commitPipeline.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/devAssertions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/firstSync.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/freshInitialLoad.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/graphBackfillClaim.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/handleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/idleMarkerJobs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/jsonCanonical.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/kernelInvalidation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/kernelProcessors.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/kernelQueries.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/mergeTypeMembershipProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/normalizeReferencesProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/poolInstrumentation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/processorRunner.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/propertyCellBackfill.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/propertyChildrenProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/propertyDefinitionChangeProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/propertyDefinitionSynthesis.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/propertyKeyScan.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/propertySchemaResolution.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/raiseProtocol.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/refProjection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/referenceTargetProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/sqlBinds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/syncObserver/arrivalProcessors.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/syncObserver/invalidate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/syncObserver/materialize.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/syncObserver/observer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/syncObserver/reconcile.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/timingMetrics.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/treeQueries.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/txEngine.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/txSnapshots.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/typedBlockQuery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/internals/undoManager.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/invalidation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/kernelDataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/kernelPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/kernelValuePresetCores.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/localDbCorruptionSignal.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/localDbStorage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/localDbVfs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/localSchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/maintenance.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/mergeProperties.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/metricsConsoleHook.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/migrationsPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/mutators.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/orderKey.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/orderKeyPlacement.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/pluginStateExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/projectorRuntime.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/properties.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/propertiesPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/propertyChildren.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/propertyDefinitionMetadata.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/propertyDefinitionRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/propertySeeds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/recentsPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/referenceBlock.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/releasePowerSyncConnection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/repo.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/repoProvider.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/rowProperty.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/seedIdentityLedger.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/stateBlocks.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/structuralEditPolicy.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/subtreeDelete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/syncedTableSqlRecognizer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/syncedTableWriteGuard.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/targets.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typeColors.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typeDefinitionMetadata.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typeDefinitionRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typeExtraction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typeSeeds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typeTagger.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typedRecords.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/typesPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/userPrefs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/userSchemasService.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/userTypesService.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/valuePresetRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/visibleChildren.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/workspaceSchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/workspaces.js\",\"/knowledge-medium/pr-preview/pr-1144/src/data/writeAheadVfsProbe.worker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/BlockPasteShellDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/autocomplete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/codeMirrorExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/contentFlush.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/defaultInteractions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/editSettleSignal.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/insertImage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/syntaxContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/editor/triggerMatch.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/AppRuntimeProvider.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/BlockFocusShellDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/ExtensionRenderBoundary.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/PanelContentRecovery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/apiCatalog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/approveExtensionHere.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/batchableKeyedStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/blockInteraction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/blockSelectionAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/compileExtensionModule.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/compiledModuleCache.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/continuousGestures.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/core.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/defaultRenderers.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/dialogAppMount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/dynamicExtensionSeeds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/dynamicExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/exampleExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/extensionApprovalStatus.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/extensionLoadErrorToast.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/extensionLoadErrors.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/extensionLookup.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/extensionToggles.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/extensionUtilitiesCss.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/liveRuntime.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/overridesCache.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/pluginIds.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/processorRejectionToast.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/runtimeActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/runtimeContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/staticAppExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/staticDataExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/toastAppMount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/useOverrides.js\",\"/knowledge-medium/pr-preview/pr-1144/src/extensions/useShortcutSurfaceActivations.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/discoverToggleTree.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/resolveAppRuntime.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/runtimeEvents.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/togglable.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/variantFacet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/facets/verbFacet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/block.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/propertySchemas.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/typeRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useAncestorCrumbs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useAutocompleteListbox.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useDebouncedSearch.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useDebouncedValue.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useIsFocalRender.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useMinuteClock.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/usePanelLayoutProjection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/usePendingInvitations.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useRendererRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/hooks/useWorkspaces.js\",\"/knowledge-medium/pr-preview/pr-1144/src/lib/utils.js\",\"/knowledge-medium/pr-preview/pr-1144/src/main.js\",\"/knowledge-medium/pr-preview/pr-1144/src/markdown/MarkdownImage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/markdown/blockSeparators.js\",\"/knowledge-medium/pr-preview/pr-1144/src/markdown/defaultMarkdownExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/markdown/extensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/markdown/renderMarkdownHtml.js\",\"/knowledge-medium/pr-preview/pr-1144/src/minimal-editor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/paste/captureMediaVerb.js\",\"/knowledge-medium/pr-preview/pr-1144/src/paste/decision.js\",\"/knowledge-medium/pr-preview/pr-1144/src/paste/operations.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/account-header/AccountHeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/account-header/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/AgentStatusChip.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/askAgent.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/askedStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/cancelAgent.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/chipState.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/resumeCommand.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-dispatch-companion/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/AgentTokensDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/BridgePairingDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/authoringCatalog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/bridge.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/commands.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/dataModelGuide.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/describeRuntime.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/extensionLint.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/grainAudit.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/healthCommand.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/presetIdentity.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/propertyRegistrationAudit.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/protocol.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/serialization.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/tokens.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/agent-runtime/watchEvents.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/AliasCollisionToast.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/DuplicateNameBanner.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/collisionMerge.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/mergeCollisionAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/pageStyling.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/rejectionToast.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/alias/syncProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/app-intents/appIntents.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/app-intents/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/app-update-prompt/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/app-update-prompt/status.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/MediaBlockRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/MediaDownLaneReplicator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/MediaUploadReconciler.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/assetDownLane.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/assetResolver.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/assetUpload.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/audit/audit.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/audit/paginate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/audit/report.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/audit/scan.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/audit/supabaseAuditIO.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/audit/types.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/blobStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/byteStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/downLane.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/insertImageContribution.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/laneArming.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/laneLock.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/mediaBlock.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/mediaCapture.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/mediaViewers.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/mediaViewersFacet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/pasteCapture.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/resolver.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/retryUploadsAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/storagePaths.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/uploadDrain.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/uploadLaneStatus.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/uploadReconcile.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/uploadRecovery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/uploadStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/attachments/useAssetObjectUrl.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks-view/BacklinksEmptyState.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks-view/BacklinksViewSection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks-view/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks-view/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks-view/prop.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/BacklinkFilters.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/BlockEntry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/LinkedReferences.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/dailyNoteDefaults.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/filterProperty.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/inline-counts/applies.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/inline-counts/countQuery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/inline-counts/expansionStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/inline-counts/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/inline-counts/useBacklinkCount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/propertyEditorOverride.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/propertyFilter.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/query.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/resolveFilter.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/useBacklinks.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/backlinks/useStoredBacklinkFilter.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/birthday/BirthdayCelebration.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/birthday/BirthdayOverlay.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/birthday/gate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/birthday/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/birthday/wolfTheme.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-info/BlockMetaCard.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-info/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/AddTagDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/BlockTagsConfigEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/addTagAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/appendTag.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/config.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/block-tagging/propertyEditorOverride.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/BreadcrumbList.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/BreadcrumbRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/Breadcrumbs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/breadcrumbPreview.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/CharacterCountDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/blockType.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/charCount.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/profiles.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/character-counter/properties.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/colemak-keybindings/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/command-palette/CommandPalette.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/command-palette/HeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/command-palette/context.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/command-palette/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/command-palette/toggleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/command-palette/useCommandPaletteActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/cursor-follows-scroll/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/cursor-follows-scroll/settleScheduler.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/cursor-follows-scroll/viewportAnchor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/CalendarGrid.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/DailyNotePicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/DateKeyboardScrubController.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/DateNavDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/DateScrubOverlay.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/HeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/ReschedulePicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/SpreadDatesDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/blockDateAdapter.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/calendar.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dailyNotes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dateScrubActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dateScrubGesture.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dateScrubGestureActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dateScrubRecognizer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/deletionGuard.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/dueQuery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/landing.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/localSchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/referenceDateAdapter.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/rescheduleAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/spreadBlockDates.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/spreadDatesAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/today.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/daily-notes/wikilinkDateDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/ConsistencyAuditDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/audit.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/auditAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/diagnosticsSource.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/schedule.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/data-integrity/store.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-maintenance/action.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-maintenance/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-maintenance/plugin.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/DbMirrorSettingsDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/changeMarker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/diagnostics.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/fileSystemAccess.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/filenames.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/mirror.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/runLock.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/runtimeHealth.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/schedule.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/db-mirror/store.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/default-themes/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/default-themes/themes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/diagnostics/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/diagnostics/useDiagnostics.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extension-prompts/dismissals.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extension-prompts/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extension-prompts/status.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extension-prompts/store.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/ExtensionsSettings.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/config.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/effect.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/propertyEditorOverride.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extensions-settings/useToggleTree.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extract-type/ExtractTypeDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extract-type/FindTypeInstancesDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extract-type/PropertyShapePicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extract-type/action.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/extract-type/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/FindReplaceDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/HeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/search.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/toggleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/find-replace/types.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/LocationPropertyEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/MapView.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/blockTypes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/codeMirrorExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/codecs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/createOrFindPlace.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/currentLocation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/geoContentDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/googlePlacesClient.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/locationsPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/mapViewport.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/pickCurrentLocation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/placeAutocomplete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/placeNameCollision.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/properties.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/propertyEditorOverrides.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/query.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/geo/usePlaceSearch.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/config.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/grouping.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/propertyEditorOverride.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/query.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/resolveConfig.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/useGroupedBacklinks.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/interaction-metrics/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/interaction-metrics/record.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/interaction-metrics/recordStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/interaction-metrics/schedule.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/interaction-metrics/sessionContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/KeyCaptureInput.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/KeybindingsEditor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/config.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/effect.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/keyCapture.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/overrideStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/keybindings-settings/propertyEditorOverride.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/HeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/LeftSidebar.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/shortcuts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/left-sidebar/toggleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/merge-blocks/MergePicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/merge-blocks/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/merge-blocks/mergeAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/merge-blocks/strategy.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-bottom-nav/Button.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-bottom-nav/MobileBottomNav.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-bottom-nav/defaultItems.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-bottom-nav/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-bottom-nav/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-keyboard-toolbar/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-keyboard-toolbar/defaultItems.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-keyboard-toolbar/facet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/mobile-keyboard-toolbar/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/move-blocks/MoveDestinationPicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/move-blocks/blockSubtreeMembership.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/move-blocks/contextMenuItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/move-blocks/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/move-blocks/moveAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/move-blocks/moveBlocks.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/TutorialBanner.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/action.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/bannerDismissal.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/landing.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/outline.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/onboarding/seed.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/PerfTrendDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/analyze.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/diagnosticsSource.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/load.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/monitorRun.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/schedule.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/series.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/store.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/trendAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/perf-monitor/verdict.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/plain-outliner/clickToEditAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/plain-outliner/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/plain-outliner/interactions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/ConfirmMigrationDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/MigrationGate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/MigrationGateDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/action.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/localRunMessage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/plugin.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/properties-migration/progressReport.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/HeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/QuickFind.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/recents.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/resultItems.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/selection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/quick-find/toggleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/recents/HeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/recents/RecentsPageBlockRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/recents/grouping.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/recents/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/recents/target.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/codeMirrorExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/contentPrefill.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/inlineDeletedBlockRefsProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/invalidation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/localSchema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/markdown/blockrefs/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/markdown/wikilinks/Wikilink.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/markdown/wikilinks/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/mergeRetargetProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/parseFence.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/referenceParser.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/referenceProjection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/referencesProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/renameProcessor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/references/spanReplacement.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/action.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/content.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/effect.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/ids.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/import.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/plan.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/plugin.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/promotion.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/properties.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/references.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/report.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/roamMemo.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/runtime.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/schemaReconciliation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/srsMarkers.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/todo.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/typeCandidates.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/roam-import/types.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/search-health/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/search-health/store.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/shortcut-help/ShortcutHelpOverlay.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/shortcut-help/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/shortcut-help/model.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/shortcut-help/toggleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/shortcut-help/useKeyInspector.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/PanelFocusRecovery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/ShellDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/exclusionsFacet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/shell.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/surface.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/spatial-navigation/walker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/RescheduleToast.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/indicator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/moveSrsState.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/rescheduleDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/scheduler.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/srsClipboard.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-rescheduling/swipeRightDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/DailyNoteReviewHint.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/DeckPicker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/ReviewControls.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/ReviewDeckRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/ReviewSession.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/archive.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/deck.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/dueQuery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/gradeDecision.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/keyHints.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/reviewCardLayout.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/reviewProgress.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/srs-review/useDueCards.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/startup-metrics/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/startup-metrics/record.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/storage-persistence/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/storage-persistence/persistenceStatus.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/storage-persistence/requestAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/supertags/TypeChipsDecorator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/supertags/codeMirrorExtensions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/supertags/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/supertags/typeAutocomplete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/SwipeActionMenu.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/anchor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/events.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/gestureActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/swipe-quick-actions/swipeRecognizer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/RejectionDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/SystemStatusHeaderItem.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/model.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/queueCounts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/rejectedHelpers.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/system-status/rematerializeAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/theme-toggle/ThemeToggle.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/theme-toggle/effect.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/theme-toggle/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/theme-toggle/theme.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/todo/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/todo/dataExtension.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/todo/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/todo/schema.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/update-indicator/UpdateIndicator.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/update-indicator/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/update-indicator/loadTimes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/VideoNotesRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/VideoPlayerRenderer.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/VideoTimeStamp.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/markdown.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/notes.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/registry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/remark-timestamps.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/video-player/view.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/vim-normal-mode/actions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/vim-normal-mode/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/vim-normal-mode/interactions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/plugins/workspace-header/index.js\",\"/knowledge-medium/pr-preview/pr-1144/src/registerServiceWorker.js\",\"/knowledge-medium/pr-preview/pr-1144/src/requestPersistentStorage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/services/powersync.js\",\"/knowledge-medium/pr-preview/pr-1144/src/services/supabase.js\",\"/knowledge-medium/pr-preview/pr-1144/src/services/uploadErrorClassifier.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/ActiveContexts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/HotkeyReconciler.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/WipeLocalDataDialog.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/actionDispatch.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/actionRefItems.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/applyKeybindingOverrides.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/blockActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/canonicalizeChord.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/defaultContexts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/defaultShortcuts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/effectiveActions.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/gestureAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/gestureBinding.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/holdRegistry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/keybindingConflicts.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/keybindingOverrides.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/pointerAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/resolve.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/runAction.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/sequenceMatcher.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/types.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/useActionContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/useActionDiscovery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/shortcuts/utils.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sw/assets.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sw/bootStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sw/previewDatabases.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/byteTransform.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/aad.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/aead.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/base32.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/base64url.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/binaryEnvelope.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/byteAead.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/canary.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/contentHash.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/contentKey.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/derivedIdNamespace.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/envelope.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/hex.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/crypto/workspaceKey.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/flows/createEncryptedWorkspace.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/flows/unlockWorkspaceWithKey.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/keyStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/modePin.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/resolveWorkspaceEntry.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/resolver.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/keys/workspaceAccess.js\",\"/knowledge-medium/pr-preview/pr-1144/src/sync/transform.js\",\"/knowledge-medium/pr-preview/pr-1144/src/themeBootDefaults.js\",\"/knowledge-medium/pr-preview/pr-1144/src/types.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/ClientLocalSettings.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/array.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/backlinkAutocomplete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/blockCrumbs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/blockrefAutocomplete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/cadencedIdleJob.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/callbackSet.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/clientId.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/codemirror.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/codemirrorCompletion.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/copy.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/dailyPage.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/dbForensics.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/dbForensicsHooks.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/deleteBlockThroughUi.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/dialogs.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/dom.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/downloadBlob.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/exportSqliteDb.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/flipSlide.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/fnv1a.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/fuzzyRank.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/idbKeyedStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/idleCallbackPolyfill.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/keyboardAwareScroll.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/keyboardViewport.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/lastWorkspace.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/layoutSessionDom.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/layoutSessionId.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/linkTargetAutocomplete.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/localDbCorruption.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/localDbRecovery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/markdownParser.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/memoize.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/nameFieldCommit.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/nameList.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/navigation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/opfsPageScan.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/panelHistory.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/panelLayoutProjection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/panelScrollAnchor.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/platform.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/pluralize.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/propertyCreation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/propertyNavigation.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/propertyValueContext.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/react.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/relativeDate.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/relativeTime.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/renderScope.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/resolvedThenable.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/routing.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/safeMode.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/scheduleIdle.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/selection.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/softKeyboardGrab.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/startupTimeline.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/state.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/string.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/templateLiterals.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/time.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/toast.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/toggleStore.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/types.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/viewTransition.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/viewport.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/workspaceRecovery.js\",\"/knowledge-medium/pr-preview/pr-1144/src/utils/workspaceSnapshotStore.js\",\"/knowledge-medium/pr-preview/pr-1144/vite.svg\",\"/knowledge-medium/pr-preview/pr-1144/wa-sqlite-async.wasm\",\"/knowledge-medium/pr-preview/pr-1144/wa-sqlite.wasm\"]"),
		precacheVendor: JSON.parse("[\"https://esm.sh/react-dom@19.2.6\",\"https://esm.sh/react-dom@19.2.6/client\",\"https://esm.sh/react-dom@19.2.6/es2022/cjs/react-dom-server-legacy.browser.production.mjs\",\"https://esm.sh/react-dom@19.2.6/es2022/cjs/react-dom-server.browser.production.mjs\",\"https://esm.sh/react-dom@19.2.6/es2022/client.mjs\",\"https://esm.sh/react-dom@19.2.6/es2022/react-dom.mjs\",\"https://esm.sh/react-dom@19.2.6/es2022/server.mjs\",\"https://esm.sh/react-dom@19.2.6/server\",\"https://esm.sh/react@19.2.6\",\"https://esm.sh/react@19.2.6/compiler-runtime\",\"https://esm.sh/react@19.2.6/es2022/compiler-runtime.mjs\",\"https://esm.sh/react@19.2.6/es2022/jsx-runtime.mjs\",\"https://esm.sh/react@19.2.6/es2022/react.mjs\",\"https://esm.sh/react@19.2.6/jsx-runtime\",\"https://esm.sh/scheduler@%5E0.27.0?target=es2022\",\"https://esm.sh/scheduler@0.27.0/es2022/scheduler.mjs\"]")
	}, {
		caches,
		fetch,
		origin: self.location.origin,
		now: () => Date.now(),
		storage: navigator.storage,
		indexedDB,
		mark,
		bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : void 0
	});
	self.addEventListener("install", (event) => {
		event.waitUntil(sw.install());
		self.skipWaiting();
	});
	self.addEventListener("activate", (event) => {
		event.waitUntil(sw.activate());
	});
	self.addEventListener("message", (event) => {
		if (event.data === "SKIP_WAITING") self.skipWaiting();
		if (event.data === "BOOT_MARKS") event.ports[0]?.postMessage(bootMarks);
	});
	self.addEventListener("fetch", (event) => {
		const response = sw.handleFetch(event.request, (p) => event.waitUntil(p));
		if (response && event.request.mode === "navigate" && !bootMarks.firstNavReceivedAt) {
			mark("firstNavReceivedAt");
			response.then(() => mark("firstNavAnsweredAt"), () => {});
		}
		if (response) event.respondWith(response);
	});
	mark("evaluatedAt");
	//#endregion
})();
