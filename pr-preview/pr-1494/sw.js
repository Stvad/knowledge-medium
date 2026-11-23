(function() {
	// src/sw/assets.ts
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
	var ASSET_DESTINATIONS = /* @__PURE__ */ new Set([
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
	/**
	* The fingerprint the build stamps for each precached file and the worker
	* recomputes over the bytes it fetched: hex SHA-256 cut to 64 bits, enough to
	* tell two builds' bytes apart. The one definition both sides use.
	*/
	var contentDigest = async (bytes) => {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	// src/data/dbFileSiblings.ts
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
	// src/sw/preview.ts
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
	// src/sw/ledger.ts
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
	// src/utils/idbKeyedStore.ts
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
		dbName;
		storeName;
		version;
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
	// src/sw/bootStore.ts
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
	// src/sw/previewDatabases.ts
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
	// src/sw/worker.ts
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
	var VENDOR_HOSTS = /* @__PURE__ */ new Set(["esm.sh"]);
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const resolveManifest = (manifest) => Object.entries(manifest).map(([path, digest]) => [toScopeUrl(path), digest]);
		const SHELL_ENTRIES = resolveManifest(config.precacheShell);
		const PRECACHE_ENTRIES = resolveManifest(config.precacheAssets);
		const PRECACHE_REST_ENTRIES = resolveManifest(config.precacheRestAssets);
		const PRECACHE_ASSETS = PRECACHE_ENTRIES.map(([url]) => url);
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [[SHELL_CACHE, [SHELL_URL]], [ASSET_CACHE, PRECACHE_ASSETS]];
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
				const entry = await readLedgerEntry();
				await writeLedgerEntry(await mutate(entry));
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
		const forgetGeneration = async (id) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: entry.ids.filter((x) => x !== id)
			}));
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
			try {
				await precache();
			} catch (err) {
				await Promise.allSettled(deleteGeneration(buildId));
				await forgetGeneration(buildId).catch(() => {});
				throw err;
			}
		};
		const precache = async () => {
			await recordGeneration(buildId);
			const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSET_CACHE)]);
			const fetchInto = async (cache, url, digest, mode) => {
				const res = await fetch(new Request(url, { cache: mode })).catch(() => null);
				if (!res || !res.ok) return;
				const body = await res.clone().arrayBuffer().catch(() => null);
				if (!body) return;
				if (await contentDigest(body) !== digest) throw new Error(`[sw] ${url} differs from build ${buildId}'s copy; another deploy is being served`);
				await cache.put(url, res).catch(() => {});
			};
			const runPooled = async (entries, limit, task) => {
				let next = 0;
				let failure;
				const worker = async () => {
					while (!failure && next < entries.length) {
						const [url, digest] = entries[next++];
						try {
							await task(url, digest);
						} catch (err) {
							failure ??= { err };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
				if (failure) throw failure.err;
			};
			await runPooled(SHELL_ENTRIES, SHELL_ENTRIES.length, (u, d) => fetchInto(shell, u, d, "reload"));
			await runPooled(PRECACHE_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
			await seedBootStore();
			await runPooled(PRECACHE_REST_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
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
			if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE);
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
	// src/sw/sw.ts
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
		buildId: "d4d855ba4e7e-7eaac040",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/\":\"2063d8e634375465\",\"/knowledge-medium/pr-preview/pr-1494/index.html\":\"2063d8e634375465\",\"/knowledge-medium/pr-preview/pr-1494/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1494/assets/FacadeVFS-DDzDoXQb.js\":\"88fb3b82c8f4be76\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSCoopSyncVFS-D6fh1LJ-.js\":\"15272f3165e9553d\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSWriteAheadVFS-BdXFnIdy.js\":\"12d7759f9ba21da5\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-BuYG0Vu4.js\":\"9aef91e3b228c1fa\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-DMahT6nB.js\":\"5a8713cc2d77d753\",\"/knowledge-medium/pr-preview/pr-1494/assets/worker-DruwuQVf.js\":\"558d3c84ce58be64\",\"/knowledge-medium/pr-preview/pr-1494/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1494/chunks/app-DmX0OER4.js\":\"d90fe61cd45b02d2\",\"/knowledge-medium/pr-preview/pr-1494/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1494/index.js\":\"41be4a431fee3f60\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1494/assets/AccessHandlePoolVFS-czjKvoK8.js\":\"4c6f78150b31ddf5\",\"/knowledge-medium/pr-preview/pr-1494/assets/IDBBatchAtomicVFS-BPlA0-Jt.js\":\"e37f03300ccae2ec\",\"/knowledge-medium/pr-preview/pr-1494/assets/MemoryVFS-BvB6_Ih_.js\":\"f8579640e18927a0\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-BCzro9hp.js\":\"e7cd9ce1b0552bad\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-DM7tM7bE.js\":\"6d3f0f51f90af024\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1494/chunks/AccessHandlePoolVFS-COFSSn1O.js\":\"a2d36dd77e3dd82e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/FacadeVFS-CWH4g-cC.js\":\"6e062ed83b187a3b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/IDBBatchAtomicVFS-BoRDr3Cx.js\":\"66e0a83085967fea\",\"/knowledge-medium/pr-preview/pr-1494/chunks/MemoryVFS-C-yontUU.js\":\"9bfc4f1f7cfe277e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSCoopSyncVFS-yNwQZyW3.js\":\"bd33657e44d14a8e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSWriteAheadVFS-388W_LNr.js\":\"67a639e0d3d8e5f3\",\"/knowledge-medium/pr-preview/pr-1494/chunks/Preview-DEsEtd2c.js\":\"99d4d8f76259839b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1494/chunks/card-pEcHLVDE.js\":\"479f36ee72d99259\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-CSVjB_Pg.js\":\"024340d9b86e6100\",\"/knowledge-medium/pr-preview/pr-1494/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-CceK_Fdb.js\":\"ed404cb6b108b360\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-async-CwkRYy2M.js\":\"a131ede70603fa7b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-B7w56MYD.js\":\"9cfc65c94bf9c70d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BbXLSOwp.js\":\"3844647f002ec26a\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BlGEFsoR.js\":\"f176ae15076c6825\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-CSp4tBUP.js\":\"b1f051b9e3e2cf91\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-CXTnO08W.js\":\"5eb7a7b2d831baff\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DB3WqdTV.js\":\"7618ce7e7f97f1f7\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DnvJr7C6.js\":\"ff339f1b62d4997f\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server-legacy.browser.production-CkEsDyKv.js\":\"6965ca2d4836364a\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.browser.production-CJiROuNF.js\":\"0d2125676f6ef145\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.edge.production-BY63FMzT.js\":\"2c9089b1349ecc1c\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-uTw3XVqm.js\":\"7d6ae9a8dc52d2d3\",\"/knowledge-medium/pr-preview/pr-1494/chunks/server.browser-dLHrQOJQ.js\":\"acd1c26e53b382b8\",\"/knowledge-medium/pr-preview/pr-1494/chunks/textarea-DGrrqB4o.js\":\"29014e72fe812cc0\",\"/knowledge-medium/pr-preview/pr-1494/chunks/ui-lFYmcRMw.js\":\"1af0d33152497394\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-I6WDVGPA.js\":\"7c32fc4ed5607a2d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-async-YGB7qMsX.js\":\"6ee122600e960138\",\"/knowledge-medium/pr-preview/pr-1494/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1494/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/src/App.js\":\"bae61bbd99f888d4\",\"/knowledge-medium/pr-preview/pr-1494/src/appUpdate.js\":\"b5c19fc123e42a33\",\"/knowledge-medium/pr-preview/pr-1494/src/appVersion.js\":\"43fa63d4e9468daf\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/initialLayout.js\":\"6094bb8fe2ba6141\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/openWorkspaceData.js\":\"4c862948a626b495\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/resolveWorkspace.js\":\"2913e29fd35bb840\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/workspaceBootstrap.js\":\"5bb5912d51495c19\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockComponent.js\":\"ca0dfedc04e375ca\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockCrumbs.js\":\"fcdffd61034f4669\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockEditor.js\":\"5f02a6747ae20b34\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockLoadingPlaceholder.js\":\"27072392aa0c8f3b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockProperties.js\":\"30f7921ddeabbcda\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockSearchPicker.js\":\"2c163eed3d27ce56\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ConfirmBulkDeleteDialog.js\":\"3f407107f848becb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DividerHandle.js\":\"b33236bd17e0f9ae\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DraftEditor.js\":\"102519a2903eafc2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/GutterPill.js\":\"0912cfa92ea9afa0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Header.js\":\"390edfce3c064af8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/LazyBlockComponent.js\":\"8c39af6b0fa108ce\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Login.js\":\"7d846a2acf35a231\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ZoomableSurface.js\":\"f7f0bd7dc8702922\",\"/knowledge-medium/pr-preview/pr-1494/src/components/editModeKeepalive.js\":\"895b364b840df2e5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7a1ded516337a383\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"54cefeafa8a43bc5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefPropertyEditor.js\":\"3c21ca01c630bd93\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefTargetTypePicker.js\":\"00d022012e712339\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/SelectPropertyEditor.js\":\"e3ea937a5947f53e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/TypesPropertyEditor.js\":\"e3fec50c4d368069\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/defaults.js\":\"3ce6cbd0f6a0057f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/kernelValuePresets.js\":\"48f44f11b06b3066\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/selectablePresets.js\":\"76f8217a6b2c5c13\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/typesPropertyUi.js\":\"0ca45d5627c06ea7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/AddPropertyForm.js\":\"0ba505752a61ad86\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyPicker.js\":\"b894ad80787a1df7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyRow.js\":\"af3a53f2aa2594fb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/Rows.js\":\"3531b3e9261d3087\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/actions.js\":\"2883597201b8c0b8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/declarationOnly.js\":\"f6bd9d55cf5f0d35\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/layout.js\":\"0ae924cc9dec6170\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/model.js\":\"b3a91ef165b6c9ad\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapeUi.js\":\"672fd4643978d6bc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapes.js\":\"00d4959c5b77779d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/usePropertyEditingActivation.js\":\"46a35ba214cf7e27\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/visibility.js\":\"74598249308fd119\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanelSections.js\":\"3a2effc3af2e9c8b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockEmbed.js\":\"ec06a5b83eed9407\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockLink.js\":\"8304a6aa0634e5bd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockRef.js\":\"a570d70649c77aa6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/ReferenceLink.js\":\"c5a415d4526490ea\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuard.js\":\"7d642c353b59252f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuardContext.js\":\"802e1da1a0374210\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/linkInteraction.js\":\"cbb3457ebcf1fa78\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/referenceLayout.js\":\"c010cb303fe44280\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/useBlockRefAncestors.js\":\"013b1fe7e680f43a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockGutter.js\":\"c09d7597e3a02dbb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockInfoDialog.js\":\"65d09edc6e85b173\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockTypeBlockRenderer.js\":\"10b2c8cbe03a3626\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BulletHoverCard.js\":\"23c526bf94fd61aa\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorContentRenderer.js\":\"b0192a125a11feff\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2063f5c113308800\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ColumnResizeHandles.js\":\"b2370ee97f80fb95\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"53432f9e0c72d6e0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/DefaultBlockRenderer.js\":\"881fcb74d4a469e2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/LayoutRenderer.js\":\"8b82394065e6472f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MarkdownContentRenderer.js\":\"b7d78081468b57d7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MissingDataRenderer.js\":\"f231fb54444b39f5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PanelRenderer.js\":\"cdf48df7ffe2677a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PropertySchemaBlockRenderer.js\":\"39871c8cf604b3c6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/TopLevelRenderer.js\":\"fce538be2a4eb568\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockGutterMode.js\":\"949dc2f8ead17098\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockTitleText.js\":\"9d92131bd350dca3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/fieldCreationKeydown.js\":\"ce478abe0a7caa03\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/layoutRootContext.js\":\"ae242007f8bc4470\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/TypeChip.js\":\"d4683f6a39f97cf2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/chipStyle.js\":\"ea1ae076906844f1\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/anchored-floating.js\":\"530720a541bf57c4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/button.js\":\"112f8d941aa6dacd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/card.js\":\"52c0efecc37c75b5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/checkbox.js\":\"3fa13db704b8b935\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/collapsible.js\":\"91df708d0b378a83\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/command.js\":\"9ce3109a4c74d0d2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/context-menu.js\":\"bf2f323169f4a884\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dialog.js\":\"96be1de3c2634fc5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dropdown-menu.js\":\"fc50f3546e12c3d5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/floating-listbox.js\":\"4dbf53293995bcc7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/index.js\":\"629e3c9c5bbee166\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/input.js\":\"afffff4049442f81\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/kbd.js\":\"906b5961e7fd5aff\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/label.js\":\"069a94a470c9c7e3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/textarea.js\":\"1aa297bb62c4c7da\",\"/knowledge-medium/pr-preview/pr-1494/src/components/useEditModeYieldKeepalive.js\":\"a6c2f009bd60eebc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/BootFallback.js\":\"a015151f02ad8316\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/FocusedRowLazyMount.js\":\"e13d330e380e9767\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LazyViewportMount.js\":\"3c80e1ce5090d8a4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LocalDbCorruptionFallback.js\":\"05eef175dd60cc38\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/error.js\":\"25b8bbc135d9828f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/lazyMountRegistry.js\":\"34f9b7f598310af4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/suspense.js\":\"57f942f99eba16f7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/CreateWorkspaceDialog.js\":\"f54c773b875d2680\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/PendingInvitations.js\":\"3b9b345a44d9cea9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/SyncProgress.js\":\"a9cec2644e0fc091\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/UnlockProgress.js\":\"aacba312f095da0f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceKeyGate.js\":\"6db23356ca954f8e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSettingsDialog.js\":\"711c2ff5f4a4bc33\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSwitcher.js\":\"e6bd8f9129f66679\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSyncGate.js\":\"bd801a03663ffb44\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlow.js\":\"328f9944ea2f2c5e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlowHost.js\":\"16bffe066c0b8c62\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/EncryptionSection.js\":\"a70b8762a6e2ca6a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/attachmentPrompts.js\":\"7dec21a66330320a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/bundleFolderPrompts.js\":\"17d1a169eee439fc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowDeps.js\":\"f19868d88900c2dd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowStore.js\":\"050a178952eb1300\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/flowUi.js\":\"d954340075b78adb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/useConversionRun.js\":\"a22263236097150f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/keyUi.js\":\"1997e3b7f585c609\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnKeyLoss.js\":\"f3ddfae252ca8335\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnServerE2ee.js\":\"4ed13fec6641fc08\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/workspaceUnlocked.js\":\"18599d2dd8e9f464\",\"/knowledge-medium/pr-preview/pr-1494/src/context/backgroundSubtree.js\":\"9080e922d35c3984\",\"/knowledge-medium/pr-preview/pr-1494/src/context/block.js\":\"4b577fdf494e1c4e\",\"/knowledge-medium/pr-preview/pr-1494/src/context/layoutWsContext.js\":\"214df6631113f3a4\",\"/knowledge-medium/pr-preview/pr-1494/src/context/propertyDisplay.js\":\"f0f0be1e714810d0\",\"/knowledge-medium/pr-preview/pr-1494/src/context/repo.js\":\"5cb12a974e3bdb8e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasClaim.js\":\"2d77c43fcdd696d1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasSeatNamespace.js\":\"a81f6443c1a90bf5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockData.js\":\"a1d127b5979cf50f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockType.js\":\"4ecf91c88bebe3f0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/changeScope.js\":\"c7500a28e4b7e140\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/codecs.js\":\"bd73ff14024f6de4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/derivedData.js\":\"67691ede9e2995b8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/errors.js\":\"5dfe4c71427a40d8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/events.js\":\"328a2c0e6720b7ab\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/handle.js\":\"ba126c09a29f4062\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/index.js\":\"c35baad967755bf2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/mutator.js\":\"10a298efa1758571\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/processor.js\":\"ffa21702d5f12b16\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/propertySchema.js\":\"3269c63296ce35c1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/query.js\":\"9f075d05e37f4366\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/sameTxProcessor.js\":\"1fa0bfe2787d5853\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/schema.js\":\"ba126c09a29f4062\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/tx.js\":\"ba126c09a29f4062\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/typedBlockQuery.js\":\"f0d521f4c42dac99\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/user.js\":\"1e252669d8113e68\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresetCore.js\":\"67f097979661efd0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresets.js\":\"07fed8fb85c9cb30\",\"/knowledge-medium/pr-preview/pr-1494/src/data/attachmentCleanerIOVerb.js\":\"eea727e4d8de1418\",\"/knowledge-medium/pr-preview/pr-1494/src/data/block.js\":\"d7101d6d262f149e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockCache.js\":\"25d6062c79a8095b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockId.js\":\"ee7891f66d291c2b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockLiveness.js\":\"c80604156c0cb709\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockMerge.js\":\"65b0d23576a06e2d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockSchema.js\":\"41f8f11b2a23b851\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypeLookup.js\":\"bba406a331f15c11\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypes.js\":\"ac05def3ac6d7fd8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/childrenView.js\":\"404b03e869483fad\",\"/knowledge-medium/pr-preview/pr-1494/src/data/clientContext.js\":\"322f8ce449d35ef1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/dbFileSiblings.js\":\"6865fcd869c5af9c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/definitionSeeds.js\":\"29d5bbfcd8a23a5a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/derivedIds.js\":\"dc15e7eda0d04397\",\"/knowledge-medium/pr-preview/pr-1494/src/data/drawnSubtree.js\":\"7f6f5d47daa58e71\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facetBridge.js\":\"930255f0cb543be3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facets.js\":\"0bf7f2443787684f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/globalState.js\":\"22ec2e55c45b1bc3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/aliasClaimRederiveProcessor.js\":\"b421e4fadf8b8a45\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/ancestorBatch.js\":\"8fd84500988f2bba\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/blockTypeTypeifyProcessor.js\":\"ef813b295289571e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/clientSchema.js\":\"44bcdf567ebab412\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/commitPipeline.js\":\"03ff49aa62a6bcc5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/devAssertions.js\":\"061f52939990d78d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/firstSync.js\":\"abd4240222c5558f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/freshInitialLoad.js\":\"5836bbe8a53f6aa5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/graphBackfillClaim.js\":\"592062d3bde801ca\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/handleStore.js\":\"fca4453663b2de31\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/idleMarkerJobs.js\":\"35047abe0396e8b0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initialDownload.js\":\"1fac7fe4840a7390\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initializeClientDatabase.js\":\"e0f371efe5d3d006\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/jsonCanonical.js\":\"cb4670bca67751a4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelInvalidation.js\":\"db0a4467bbf48fad\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelProcessors.js\":\"b0c0c3bc7a8df3c6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelQueries.js\":\"eed956fef8e0c537\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/mergeTypeMembershipProcessor.js\":\"4fb6afcd14305199\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/normalizeReferencesProcessor.js\":\"ba15538864741ba2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/poolInstrumentation.js\":\"0ae74ce5e0e891fd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/processorRunner.js\":\"fb8ddb1b299c701f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyCellBackfill.js\":\"465a451879f4cd37\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildMint.js\":\"7cee64ab675fe96b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildrenProcessor.js\":\"5e81e684729df034\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionChangeProcessor.js\":\"48fc98ced5e9a09a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionSynthesis.js\":\"68d67a817740d5a3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyKeyScan.js\":\"ad97051e16140d22\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertySchemaResolution.js\":\"a293858cc660d51e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyValueEdits.js\":\"63e0ce72824dfa69\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/raiseProtocol.js\":\"03effa041a610195\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/readBatch.js\":\"f50f0b75cd8a21b2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/refProjection.js\":\"2b4dae198f3aa51c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetLookups.js\":\"ea94162c62caa60d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetProcessor.js\":\"07b98d8d45e4ecf7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/replayMerge.js\":\"3bfb48c5bbac3c87\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/sqlBinds.js\":\"9fac0ffe237d2d3d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c03c598b215b5859\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/arrivalProcessors.js\":\"8cc44d288f6dc8d2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/invalidate.js\":\"cad8dbc44e901330\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/materialize.js\":\"9909c447a9b1472e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/observer.js\":\"bcb436750203113e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/reconcile.js\":\"b9730d0a9324ea14\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/timingMetrics.js\":\"dd77f64bab2dfca0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/treeQueries.js\":\"b9bcb8cb091a2629\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txEngine.js\":\"0f46b58ca29e884d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txSnapshots.js\":\"d57a01dadb3f8627\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/typedBlockQuery.js\":\"f13e2f0347be95d4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/undoManager.js\":\"6952b33e7c90afc8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/invalidation.js\":\"734bf815601f4a63\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelDataExtension.js\":\"2b3863d9bbf18e6e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelPage.js\":\"b09c318d3c383e84\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelValuePresetCores.js\":\"c7bc991a3583e587\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbCorruptionSignal.js\":\"8ea651a8c70fbbfd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbStorage.js\":\"0948d050d8e6c284\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbVfs.js\":\"54993e9e2c99295f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localSchema.js\":\"ac230aff2619e979\",\"/knowledge-medium/pr-preview/pr-1494/src/data/maintenance.js\":\"41514751c8394296\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mergeProperties.js\":\"3b0772fbacabd4eb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/metricsConsoleHook.js\":\"879117a0b7e2e723\",\"/knowledge-medium/pr-preview/pr-1494/src/data/migrationsPage.js\":\"794c0ba58bdd947a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mutators.js\":\"47e184a064259052\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKey.js\":\"88a68607c6496b14\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKeyPlacement.js\":\"3feb84e5964023c6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineGroupGestures.js\":\"59f1abf54696034d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineSurface.js\":\"15c14ecdd0df2ba1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingEditorContent.js\":\"1c0ebb52d77476af\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingUploadsSql.js\":\"f680bc1bfb642aeb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pluginStateExtensions.js\":\"88d6f876112b65ba\",\"/knowledge-medium/pr-preview/pr-1494/src/data/powerSyncLogger.js\":\"d8498d2bc9fcdda4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/projectorRuntime.js\":\"35042c57acb795ff\",\"/knowledge-medium/pr-preview/pr-1494/src/data/properties.js\":\"49b1f6f0d8231d2e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertiesPage.js\":\"95533a5488f513f2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyChildren.js\":\"1436a632a2662f58\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionFanout.js\":\"80aa39c273c7e559\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionMetadata.js\":\"2a0c8899ff6b880c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionRegistry.js\":\"22563e4bcf530483\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDisplayMode.js\":\"271c1380a6abdc7c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyRowCreation.js\":\"798b59a884567b83\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySchemaCreation.js\":\"8d1b0e61839ce2e1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySeeds.js\":\"4850d8f8a3d4e4a3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/recentsPage.js\":\"5448e9c52cb5c197\",\"/knowledge-medium/pr-preview/pr-1494/src/data/referenceBlock.js\":\"2a24b10ceda9ca5f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rejectedUploads.js\":\"8dd3a8e1c1932ff6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/releasePowerSyncConnection.js\":\"a916f56b6877de19\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repo.js\":\"65eb546b55c44f88\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repoProvider.js\":\"e40080dc36eff202\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rowProperty.js\":\"e7d730c0dfa77694\",\"/knowledge-medium/pr-preview/pr-1494/src/data/searchFilter.js\":\"848f8f2599dca6fb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/seedIdentityLedger.js\":\"73fda1992e1c545b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/stateBlocks.js\":\"40e5db30ddab4eaa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/structuralEditPolicy.js\":\"0c81a59c45342e98\",\"/knowledge-medium/pr-preview/pr-1494/src/data/subtreeDelete.js\":\"573ba1c020a8fd63\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncStreamLock.js\":\"91ee924da9879f92\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableSqlRecognizer.js\":\"6b2dc491bed565c0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableWriteGuard.js\":\"a829463754193299\",\"/knowledge-medium/pr-preview/pr-1494/src/data/targets.js\":\"c059b04784bd55b8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/treeOrder.js\":\"9ad81574002984db\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeColors.js\":\"a407d99430b01d68\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionMetadata.js\":\"6be99f16c5e41d81\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionRegistry.js\":\"46991808ae880903\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeExtraction.js\":\"bff7bdd2fb8da5ea\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeInitialValues.js\":\"8c76e5554e9a605c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typePropertyGroups.js\":\"830885bc4db06afe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeSeeds.js\":\"baedac7aceb7410d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeTagger.js\":\"90ea8a104f3ad0b9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typedRecords.js\":\"b6fe1b4eb4afa395\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typesPage.js\":\"47ffef7f9d360090\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userPrefs.js\":\"d7731589da535c81\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userSchemasService.js\":\"9f22fd2f630f2b52\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userTypesService.js\":\"45a6e6f997ffd5c5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/valuePresetRegistry.js\":\"029ca5a9f4bfb28b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/visibleChildren.js\":\"53c5674a758685ea\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceConversion.js\":\"82185934ff99ee7e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceFirstSync.js\":\"30d409fdec62e8d0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceIdNamespace.js\":\"55f17861b8e54d6a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceSchema.js\":\"edc6885027ebb218\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaces.js\":\"446db5de4f5981fa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadLog.js\":\"01af06584bf04d85\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/BlockPasteShellDecorator.js\":\"acc80c39f5759f47\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/atTrigger.js\":\"ad515d7b75153d87\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/autocomplete.js\":\"8b14e894c6d98976\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/codeMirrorExtensions.js\":\"f1eda841e763b47d\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/contentFlush.js\":\"fc219bc59ad47788\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/defaultInteractions.js\":\"2606409d878a3017\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/editSettleSignal.js\":\"10ffd7e391388bc8\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/insertImage.js\":\"927ba871841e771a\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceCompletionRange.js\":\"7926f88ac864a0d0\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceTargetTypes.js\":\"1c25facb41c344f3\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/syntaxContext.js\":\"76d3873c2c025bdd\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/triggerMatch.js\":\"f4e0cf0342f7b97d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/AppRuntimeProvider.js\":\"bb81db3036f31274\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/BlockFocusShellDecorator.js\":\"98857dbb5094cdc4\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/ExtensionRenderBoundary.js\":\"ee2ef327aa29af7a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/PanelContentRecovery.js\":\"b252a8597389ea4e\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/apiCatalog.js\":\"2a814d9a979c4439\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/approveExtensionHere.js\":\"bc1862f9d8117783\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/armedCutAppMount.js\":\"527cb91188e4612e\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/batchableKeyedStore.js\":\"a48870ec30e483b0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockInteraction.js\":\"0ba850c29bcd42d3\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockSelectionAction.js\":\"1de7be09b2c95050\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compileExtensionModule.js\":\"0a9da9e75521e8e1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compiledModuleCache.js\":\"8b03434e34a4af0b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/continuousGestures.js\":\"b9b8ce176236d2a4\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/core.js\":\"1c608a9f77e6ce54\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/defaultRenderers.js\":\"270be59abb712b01\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/definitionFanoutAppMount.js\":\"94834e3f0a03042c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dialogAppMount.js\":\"12539f8666cf7a19\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensionSeeds.js\":\"199ffdf512e403a2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensions.js\":\"4bf92567cef438e8\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/exampleExtensions.js\":\"00e465ce999983cb\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionApprovalStatus.js\":\"903ae94e172c556c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrorToast.js\":\"c3a79b7ff2206c78\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrors.js\":\"ea97bb5023098e10\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLookup.js\":\"61059a4bd365e7b2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionToggles.js\":\"c91d1932d15529ef\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionUtilitiesCss.js\":\"909bc53512b9a56f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/kernelPageDeletionGuard.js\":\"8dbc47682d0cdc2a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/liveRuntime.js\":\"fc96c62b51e73263\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/openExtensionsSettings.js\":\"4639544533f28982\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/overridesCache.js\":\"ba8052596a0a525a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/pluginIds.js\":\"9f4222ce2c6b7e3f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/processorRejectionToast.js\":\"fc664ccc71d7f936\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeActions.js\":\"bcc89bde1999aa11\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeContext.js\":\"0c393e390dd2b83d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticAppExtensions.js\":\"1bba39fe1499c7d2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticDataExtensions.js\":\"8843db4f4bdc29f7\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/toastAppMount.js\":\"f2f76769c8586d87\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useOverrides.js\":\"bb5d57092e996a40\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useShortcutSurfaceActivations.js\":\"10ad5afb860771bf\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/discoverToggleTree.js\":\"34d5c078086d96f2\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/facet.js\":\"7ea47e7dd0bb0c6f\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/resolveAppRuntime.js\":\"59a5499a510d407a\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/runtimeEvents.js\":\"92a752615ccd7235\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/togglable.js\":\"5f035dabe91237a5\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/variantFacet.js\":\"89ef03b8c4d1a6dc\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/verbFacet.js\":\"fe9774f34e082b69\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/block.js\":\"8a31353c9a8f3fee\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/focusedChild.js\":\"bf8645c02faf6d55\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/propertySchemas.js\":\"f372b45034620ac3\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/typeRegistry.js\":\"0f499462df5547b9\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAncestorCrumbs.js\":\"79cadb3b5083f390\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAutocompleteListbox.js\":\"d21654785c3af4ea\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedSearch.js\":\"99bd9f8b70202701\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedValue.js\":\"59f28500b99fe1da\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsFocalRender.js\":\"745e43f6f0cbc178\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsReadOnly.js\":\"23a7a5bee61410b1\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMaterializeBacklog.js\":\"e3c65a8c7a31bb47\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMinuteClock.js\":\"b0728ed3c0fbe312\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePanelLayoutProjection.js\":\"196e1ea04738068a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePendingInvitations.js\":\"c44fb0a41521f72c\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRendererRegistry.js\":\"8acc571221cc2599\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRetainedFieldRows.js\":\"f022a82e740027ce\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useWorkspaces.js\":\"bdcc1ceb02db3bbc\",\"/knowledge-medium/pr-preview/pr-1494/src/lib/utils.js\":\"59fcf6f16461721f\",\"/knowledge-medium/pr-preview/pr-1494/src/main.js\":\"a7acf1e19066b15a\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/MarkdownImage.js\":\"5298a7ac57614478\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/blockSeparators.js\":\"b611343318e1c5b0\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/context.js\":\"51395de84374a3d5\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/defaultMarkdownExtension.js\":\"b5bb6e89ca8463c8\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/extensions.js\":\"a32bb1ffec14753c\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/renderMarkdownHtml.js\":\"6d95d50833877e6a\",\"/knowledge-medium/pr-preview/pr-1494/src/minimal-editor.js\":\"ecc58f29f7f1e31e\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/armedCut.js\":\"58af6a9324e700f0\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/captureMediaVerb.js\":\"045301fa50980c43\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/clipboard.js\":\"c6de77f368a7249b\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/decision.js\":\"a53161c62de9cf10\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/operations.js\":\"061c47ee7ddc1654\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/AccountHeaderItem.js\":\"2d1ffd39d7ad45cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/index.js\":\"779af8bdb5a6635f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"44033bb1fcfdbdc7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askAgent.js\":\"c9b55f5e4a3ca1a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askedStore.js\":\"4a3b60f8987a3825\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"99bb0b119fb9e8f8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/chipState.js\":\"71a6631e7dac960e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9078d4b512633394\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/index.js\":\"d6c41f87ef4d6d14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"485b404f66ad0361\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/schema.js\":\"e4fefabfc4c5876b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/AgentTokensDialog.js\":\"68c4893e45f98abc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/BridgePairingDialog.js\":\"154468d6edcc4a97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/addMedia.js\":\"311abda74aabd121\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f14d49c1fbf28e20\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/block.js\":\"34fb8cf3551e2d6a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/context.js\":\"bc1faa43e1b9b523\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/displayIds.js\":\"eac94aacde1b9627\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/index.js\":\"f26ea3d81ac02ae6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/outline.js\":\"f43e67925262937e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/properties.js\":\"bc20552c06967aec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/refs.js\":\"2539cadf5bad56f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ee6bd7034dd774d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/search.js\":\"bebfe96463db8991\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/shared.js\":\"28d1f50bbb0bd6a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"53d76787e5458a40\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/text.js\":\"9ce137d047634f7b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentWrites.js\":\"d093338d8ca58356\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/authoringCatalog.js\":\"946fb10f72095d59\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/blockRefTargets.js\":\"160207aff3eb433f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridge.js\":\"f66e2b98298d2609\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridgeLoop.js\":\"f38742ba9d437a39\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/changeHistory.js\":\"f192f5e3a6930676\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commands.js\":\"6515d8985f022907\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commentsCommands.js\":\"ff9178977fc9e6f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataExtension.js\":\"c84800384bf57d88\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataModelGuide.js\":\"cf7ab3db56f11dec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/describeRuntime.js\":\"cf18a258b7529452\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/extensionLint.js\":\"df2c544635436fc9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/grainAudit.js\":\"d8437384136302d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/healthCommand.js\":\"0df8077abf0680a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/index.js\":\"344fb89b6ea36c3a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/presetIdentity.js\":\"5927aabe2ecc0f9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"daa960441e9b5831\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/readMedia.js\":\"c09a06a3e4121c85\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/schema.js\":\"6f44d3f4ff717116\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/serialization.js\":\"c5c529d2404684ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/targets.js\":\"88cdccbdb7458dd0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/tokens.js\":\"fa7aae2a89c5dee6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/watchEvents.js\":\"a085407dd7d77844\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/workspaceGuard.js\":\"9831db1d2c6f5b78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/writeCommands.js\":\"9c3c3484ffb007d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/AliasCollisionToast.js\":\"67178d57dd76ecee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/DuplicateNameBanner.js\":\"19e69241e751173c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/collisionMerge.js\":\"0f8164d5ba0f3e80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/dataExtension.js\":\"281b3ae32981f10b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/index.js\":\"76d05fbbc255db89\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/mergeCollisionAction.js\":\"2d3c08fdec4d1f9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/pageStyling.js\":\"9b05d04f2100bf1d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/rejectionToast.js\":\"2948b5c816a2c8f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/syncProcessor.js\":\"52fc66466e309fc1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/actions.js\":\"ffd79893a1eec5d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/addComment.js\":\"fc54e123422c3e0f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchor.js\":\"ea0185faf8f12404\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchorState.js\":\"f2fd7a1da742f176\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/commentLinks.js\":\"37cc53828bb532a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/confirmThreadDeletion.js\":\"ac370abf65975674\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/container.js\":\"d56fe605c63c9e2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/dataExtension.js\":\"156bb2c8680b9b74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/deleteComment.js\":\"0691b308af05b3ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/highlights.js\":\"70dcf58a78e061bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/index.js\":\"f38c5ccb799a2ffc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/linkedCommentsPill.js\":\"87be903212e71611\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/margin.js\":\"cb2b169b165b8d71\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/marginSchema.js\":\"12c6029a21d03e1b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/newComment.js\":\"e22be09faf936150\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ownThreadPicker.js\":\"913e6a8b8f2389cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/placement.js\":\"ae4eaed804f45295\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/queries.js\":\"004998aedd463dfd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotePosition.js\":\"ef0408ef319a17f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedIn.js\":\"ca7c0d04780c44de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedRange.js\":\"901390c21dca1e44\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/rangeRefs.js\":\"7cd94aa300c827b1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readHighlights.js\":\"43fb89e665e24ddb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelection.js\":\"ebc969df64ab174d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelectionUi.js\":\"1b1342b913b6dceb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/reanchor.js\":\"c0075657933d3e32\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/schema.js\":\"6a2d7f56fde61f24\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scope.js\":\"67f3c37af0ea8662\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scopeThreads.js\":\"453c3a2566011bb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/splitRetarget.js\":\"b4d678e3ca2d1839\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestionCard.js\":\"3873e896a0cc5ae6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestions.js\":\"6538750162d54e0c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaries.js\":\"c0eb133e461c0c55\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaryBatch.js\":\"dec5c8a929ff320a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/surface.js\":\"9c55c3f07cfb8c11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threadNavigation.js\":\"7176639905b80851\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threads.js\":\"ddb1b462a72d04b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ui.js\":\"acf6318578a207a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/uiStore.js\":\"14ec8be45b610da7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/appIntents.js\":\"26fc9fc58abfb5f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/index.js\":\"b271e0bd803df95a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/index.js\":\"649ab1ba04b3fc63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/status.js\":\"d2d0aac4fbeddcb7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"155e3fab819fa922\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaBlockRenderer.js\":\"f78ade4060b71a74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0ca2fc674aa9528b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaUploadReconciler.js\":\"df98a53dc3730fe8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetDownLane.js\":\"aaab6da834ee0faa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetResolver.js\":\"1e11e98363a9a107\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetUpload.js\":\"d45f32fa08423eba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/attachmentCleanerIO.js\":\"27ec5b6505645aaf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8f2ed9a38e74af66\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/blobStore.js\":\"209394168a9585a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/browserMedia.js\":\"95094cec5e5a0c22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/byteStore.js\":\"f4165096063c45ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanerIO.js\":\"73c162171cbd7fce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanupAttachments.js\":\"a3a69fec4da7ca56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/dataExtension.js\":\"d9219c29ed969a61\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/downLane.js\":\"55c0595e290c84ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/index.js\":\"8c553a547f13f17d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/insertImageContribution.js\":\"5d45de9e30fef2a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneArming.js\":\"771806143aa5457a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneLock.js\":\"27b9504ab650b89a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaBlock.js\":\"7d0a3b44c2858034\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaCapture.js\":\"ed40977600149ef0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaLanes.js\":\"715275d48c954e4d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewers.js\":\"5af21ef50c978af6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewersFacet.js\":\"c8e431af38e32980\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/pasteCapture.js\":\"f7dc92347e6c32d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/resolver.js\":\"ecf5392e01af0b61\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/retryUploadsAction.js\":\"63459e7681d06076\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/storagePaths.js\":\"21021589241ef505\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadDrain.js\":\"ddadd2e0681868e9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadLaneStatus.js\":\"0535d904798d2470\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadReconcile.js\":\"e8e21fa333e5c010\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadRecovery.js\":\"a07c1281f686d731\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadStore.js\":\"075b57b2638c8eba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/useAssetObjectUrl.js\":\"f2ac7e9140c2b760\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"177b08d920e591be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b27182e26b7eaf8e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/facet.js\":\"26d66a3d42aad26d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/index.js\":\"8b39c3f3c83875b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/prop.js\":\"f70c0599f5de8fca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinkFilters.js\":\"3faf117a947573ed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"405ab723b88ee67a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BlockEntry.js\":\"c036db16d4268327\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/LinkedReferences.js\":\"83f84eb0e4eb79c8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"166e6c20d8b45787\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dailyNoteDefaults.js\":\"efa29bf8e77bb028\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dataExtension.js\":\"57c601c9aad259eb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/edgeExclusions.js\":\"d696363c988e3ee8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/filterProperty.js\":\"dd738e9fb8f6c790\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/index.js\":\"edeb19c1f101ff61\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b914382edbf5b74f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/applies.js\":\"3ca883f3a8d6f382\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/countQuery.js\":\"f9c36fa327247067\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d5738c474618f393\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/index.js\":\"378f8fc595223268\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bfbec0dba4b7bd7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/presentationInvalidation.js\":\"24363234eb01cd17\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyEditorOverride.js\":\"abeccc2414aee778\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyFilter.js\":\"713f16686bf4eaac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/query.js\":\"2b22a7f5710b2df0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/resolveFilter.js\":\"3e5418194b93119c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sourceBatch.js\":\"10117a597d61fa80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sources.js\":\"2d2e49f86c6334ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useBacklinks.js\":\"6cb1141e83fdceb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d0ad642b3a738a87\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayCelebration.js\":\"04d549edb521f2e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayOverlay.js\":\"79cd67252210a612\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/gate.js\":\"93c2e93ea871c9ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/index.js\":\"b324b602c42f2daf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/wolfTheme.js\":\"a0748efcf76f8ac0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/BlockDragLayer.js\":\"75317b941796c276\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dragController.js\":\"c80c40f51d051d49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dropTarget.js\":\"7b13ccccc9e02222\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/index.js\":\"94f924e97079a057\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/projection.js\":\"938a019a6880c9ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/BlockMetaCard.js\":\"d8fe3c8d132b69de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/index.js\":\"2cb3fbcc3080a911\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/AddTagDialog.js\":\"5beaa6ed2e4979c8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"75955d756d5f3fa4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/TagNameIssueHint.js\":\"d385b61b3d77da34\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/addTagAction.js\":\"7bee73e64abadcca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/appendTag.js\":\"d6e714de8e740ad1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/config.js\":\"0835f27db1e6af01\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/dataExtension.js\":\"efbed9f4b6243f09\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/index.js\":\"dae021f2bc476aa0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/propertyEditorOverride.js\":\"94b178f8d463fbe8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbList.js\":\"819a08917156ba8b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fb5b5f4eb54baec3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4e1d664ea9a13c3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1ec5d939bf695c80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"da95229be913b25f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/index.js\":\"d55357c36783d196\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"419ac206ae461a2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/CharacterCountItem.js\":\"6130683fe49de227\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b748e02155a207fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/actions.js\":\"3e7d430fb0c27963\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/blockType.js\":\"3dd0083c0e0f0372\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/charCount.js\":\"5f0906639cdea68a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/dataExtension.js\":\"8b4d97ee86e270f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/index.js\":\"ca54de93fed29be9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/profiles.js\":\"12e77da11d710df3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/properties.js\":\"16a670dc4702eb3b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/textCounts.js\":\"0bcc139d1763dd49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/colemak-keybindings/index.js\":\"fefed27ad4464423\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/CommandPalette.js\":\"44c0570c4782511f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/HeaderItem.js\":\"25d8243ed12bc2d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/context.js\":\"6c6e127c67d9325a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/index.js\":\"ff4ffbca370c5234\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/selection.js\":\"d5a60a4d35efde6b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/toggleStore.js\":\"d681164bfbfdd793\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/useCommandPaletteActions.js\":\"77b5caae5b4eaf4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/ContributorBadges.js\":\"a545c421d85a3007\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/author.js\":\"1db5040a4c96f093\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/codeMirrorExtensions.js\":\"19b1c1754ae71c0c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/dataExtension.js\":\"ccb8c5f661e1b575\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/index.js\":\"9fd04d9a297e82b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/mentionAutocomplete.js\":\"3014d4480d0c4689\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/processor.js\":\"483612175086468f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/profiles.js\":\"28b31be6eeb266aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/queries.js\":\"ebfb01959bbb9123\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/schema.js\":\"5004aeb680276358\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1ea5046e00011a69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2bc95a22ecda7ded\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/index.js\":\"938b0d8c6b7e3646\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"02f8148c784d5b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"80ba5a84164c1fc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/CalendarGrid.js\":\"802b7f786de5fc97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DailyNotePicker.js\":\"5ab8c08ed16ddfbc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0212954fc7dd964f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateNavDecorator.js\":\"c2a391ead7b7271d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateScrubOverlay.js\":\"4b02804ce5050354\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/HeaderItem.js\":\"4ab87dd7cb77a816\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/ReschedulePicker.js\":\"796a16698d5b7ad3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8feaadcfc3287ded\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/actions.js\":\"1719c7263181d692\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/blockDateAdapter.js\":\"44187b604b6c9ac1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/calendar.js\":\"a44eaed7e30ed63a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dailyNotes.js\":\"244b854a972d52ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dataExtension.js\":\"73e833eb70655e7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubActions.js\":\"e0209a835149b1b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGesture.js\":\"0142aa24916275eb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGestureActions.js\":\"43028604897db519\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7c67b1907d0bd1d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/deletionGuard.js\":\"c1e032d2aa79729f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dueQuery.js\":\"182f37a9755452bb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/index.js\":\"364040f0f850b121\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/landing.js\":\"e4cdad4a3d8e5cb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/localSchema.js\":\"ae00c327fe8da972\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/referenceDateAdapter.js\":\"c32e36b77eed2f0d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/rescheduleAction.js\":\"a6e5d56cbde6959b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/schema.js\":\"170de519925bafe1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadBlockDates.js\":\"30826f582d7dbc9b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadDatesAction.js\":\"40b4981bbc331a6e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/today.js\":\"4d9903c39e3267f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d5e78e0c4d7818ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9b5fbcd85dece90d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/audit.js\":\"b025d316807126bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditAction.js\":\"2d76ccb91f403ed6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditRanges.js\":\"eafe6d99a16b8a09\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/diagnosticsSource.js\":\"10491fefa0351185\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/divergenceScan.js\":\"5147f6c2916ab638\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/index.js\":\"fe05547f01926923\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/propertyChildrenChecks.js\":\"64042ffe887063ea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/referencesMirror.js\":\"896b0857a4071b71\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/rowJson.js\":\"13169edf05d97d1e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/schedule.js\":\"e4143199a8a41621\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/store.js\":\"9d5f5e7a1fcabb22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/action.js\":\"57ef191b5e8baed3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/index.js\":\"6875c89f234a0148\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/plugin.js\":\"83fc9e489f8585f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a584e7444263762b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/actions.js\":\"1b94db45eb48ce42\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/changeMarker.js\":\"b6b99ae4f7b85196\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/diagnostics.js\":\"9283bcee93fb672d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/fileSystemAccess.js\":\"f9b4aa305d3d47d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/filenames.js\":\"66673d150b4b36d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/index.js\":\"d5b6bc62174c5088\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/mirror.js\":\"74bdb6bd6268b416\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runLock.js\":\"8af32b109711c15f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runtimeHealth.js\":\"90a40d7b1ec808fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/schedule.js\":\"4b2cbc6a95cd5546\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/store.js\":\"d93d38b16535385d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/index.js\":\"634612ac24fda902\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/themes.js\":\"98b3dca5e5c16ffa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/facet.js\":\"7e0e45f4097a1abd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/useDiagnostics.js\":\"af66dcdafbbfdc78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/dismissals.js\":\"1030b93f4d504a21\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/index.js\":\"86c3f083c1fbac59\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/status.js\":\"371807fbca64ae7f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/store.js\":\"f8ba7c16d35d4d58\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e3fe9168f737df78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c451a784c8869400\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/actions.js\":\"6cc048547d700bf7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/config.js\":\"12d02f9fae09a5fd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/dataExtension.js\":\"d27de70b807eb938\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/effect.js\":\"ca49d7001f6bc972\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/index.js\":\"2533e2d15549ed06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3abd68668da30f5c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/useToggleTree.js\":\"06a533a7efc12ed6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/ExtractTypeDialog.js\":\"98049eab190878f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f56552b4ae29f6bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/PropertyShapePicker.js\":\"5d7d29ac7d264bd5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/action.js\":\"ee13764cf402be86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/index.js\":\"93b461b5136da997\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/FindReplaceDialog.js\":\"4cc128026bdb9ec8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/HeaderItem.js\":\"c35cef0761353bf7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/dataExtension.js\":\"4c6bb3f123f7aa7c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/index.js\":\"9d6cb5a760c72129\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/search.js\":\"6ca30b09c542981b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/toggleStore.js\":\"031f9fa868e4fbc6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/LocationPropertyEditor.js\":\"193d413845ef5dbd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/MapView.js\":\"f3fd5fe01841ec18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/blockTypes.js\":\"19478bd174dd635b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/codeMirrorExtensions.js\":\"9cf2f6ecedc3de22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/createOrFindPlace.js\":\"2c812cdc984a116a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/currentLocation.js\":\"b860a577976bb14f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/dataExtension.js\":\"62c95fcf76385dc0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/geoContentDecorator.js\":\"bc0cde119118881c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/googlePlacesClient.js\":\"a073b77065733fae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/index.js\":\"33dbf2247ed3434e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/locationsPage.js\":\"4c151a2db7a2f2f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/mapViewport.js\":\"b49d7506c0a19afe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/pickCurrentLocation.js\":\"77616bc8897a166e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeAutocomplete.js\":\"7717666b4ee2fe71\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeNameCollision.js\":\"c39361511a5b38a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/properties.js\":\"c6e15172f0eecd9c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/propertyEditorOverrides.js\":\"5c0075b2c4080e55\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/query.js\":\"ed5395b7a5228058\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/usePlaceSearch.js\":\"30e24d48ca0816ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1aa7c5f03ce39857\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ec0ac386ccce4f19\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4c29a09c1f9633c3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/config.js\":\"c9d4b0f9d97e19ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/dataExtension.js\":\"874bf81e78eb8ee8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/facet.js\":\"7cf9f3f00ca3b383\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/grouping.js\":\"addb7a1449b73c36\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/index.js\":\"559c529d5a875ffb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"904f9bdf883a7c88\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/query.js\":\"7b198321045a9e66\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/resolveConfig.js\":\"859e9773cd329de2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8b7b21f514be1fc5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"aa5020772dec4290\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlDocumentContent.js\":\"32bf6cbf05681e34\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlFrame.js\":\"ffcba186962c318b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/actions.js\":\"1ade08a51b1c88d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/blockType.js\":\"961c6230319c183c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/confirmRunScripts.js\":\"99bb7a1aa4a182b7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/dataExtension.js\":\"e920f588687c52f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameAnnotations.js\":\"6e91cc3338e102c2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameDocument.js\":\"3600142dd6956355\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameTheme.js\":\"ea6a1d44463e433b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/index.js\":\"60ab7dda140cd6cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/scriptConsent.js\":\"81e18701b9e21401\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/sourceMap.js\":\"58d7b4ff02d36fb7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/useDocumentScripts.js\":\"2938fd96ab8f4c83\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/index.js\":\"539a588261c86412\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/record.js\":\"092a748beee0988a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/recordStore.js\":\"151b873e9ca53c9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/responsiveness.js\":\"bbbf3598788805bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/schedule.js\":\"4868b29848eefce1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/sessionContext.js\":\"6dc2ef81ba580b7a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1f1b5029f0acef22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ab9e84a8bde01ecb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/actions.js\":\"aa2fe7140f1e91f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/config.js\":\"1c92f0d4e68189e5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/dataExtension.js\":\"c5054818138159d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/effect.js\":\"1a8a4f8912d38591\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/index.js\":\"c38e36b66a1d9816\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/keyCapture.js\":\"fe977a1ecb89a500\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/overrideStore.js\":\"9ddc89aa4ecfaa0e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5a8c277450c0fbab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/HeaderItem.js\":\"77de6e29a2b75da5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/LeftSidebar.js\":\"052697e7243f1030\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/actions.js\":\"a1dea8e37e0e82df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/facet.js\":\"6e7bfa9a062383f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/index.js\":\"9c2c15b43b31c462\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/shortcuts.js\":\"14fe811e8f4b4e05\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/toggleStore.js\":\"e9a07d2f33f97ed8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/MergePicker.js\":\"f229975755facc65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/index.js\":\"ff5334de9f88efde\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/mergeAction.js\":\"e2921ac31d976c19\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/strategy.js\":\"24ee28fb68791b60\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/Button.js\":\"e383a65f577cce5d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b35baf9d9ddf2c3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/defaultItems.js\":\"bbf994eac5154f0d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/facet.js\":\"1aea9e7b86340407\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/index.js\":\"6d07f8d1337c3b8f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4d2aa86dad5233a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5e399dda31e8825e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"213d193a028d0daa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f6935656a8f3ab62\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/index.js\":\"74afdb3b384e108f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/MoveDestinationPicker.js\":\"dbabc6e902bdd9af\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/blockSubtreeMembership.js\":\"17c8789c63647767\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/contextMenuItem.js\":\"6728beefa00630e2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/index.js\":\"cb89987a9f6dc9a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveAction.js\":\"bee5fb1d9d53f9d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveBlocks.js\":\"9d4f7739d0be2ddf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/selectionAfterMove.js\":\"83aa3c32fccf6446\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/TutorialBanner.js\":\"92ff673edc358ee9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/action.js\":\"37dbb680fdef70a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/bannerDismissal.js\":\"8800bd3ce9557913\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/documents/cheatSheet.js\":\"874f8635cca49e0d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/index.js\":\"a3abf4ca1284786a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/keys.js\":\"47a3c6be9775a66c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/landing.js\":\"e1b348840b30fb30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/outline.js\":\"ccfa5f9545b19578\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/seed.js\":\"cf50cb9213948021\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f5aa3df134c98189\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/analyze.js\":\"98dcd897e371fddf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/diagnosticsSource.js\":\"c987e90e016f76c1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/index.js\":\"b233c5fc78e20b23\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/load.js\":\"f4b9b60131da88af\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/monitorRun.js\":\"e0b7d5a6f3980292\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/schedule.js\":\"03632bfaa6479d2f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/series.js\":\"dbe460894cc72c4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/store.js\":\"78b304cf82f08add\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/trendAction.js\":\"0e9e1f716616d880\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/verdict.js\":\"50b32eff6abbc36c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/clickToEditAction.js\":\"649241097a3db31b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/index.js\":\"16053c6f2c2b0095\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/interactions.js\":\"0554eec6a52598df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9a926a9eb7530f72\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGate.js\":\"f4cab02e2643716d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGateDialog.js\":\"1658a760e28510cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/action.js\":\"511488ec079e5e24\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/index.js\":\"e0babbb0f5e92171\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/localRunMessage.js\":\"3f83850bbdfd6117\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/plugin.js\":\"6b44dd83b07c9ff8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/progressReport.js\":\"582a1b2a1cb9a3c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/sweepProgress.js\":\"86ecd119f8e737f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/FieldRowRenderer.js\":\"14c8cc011a7120e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/ValueRowRenderer.js\":\"bbbe06206816576d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/actions.js\":\"ecfb6c51ab4e98fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/autocomplete.js\":\"170f514945f31225\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/fieldRow.js\":\"1e5c5504f314d325\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/index.js\":\"dcdc84acc9f3e925\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/referenceWarning.js\":\"b30f52ecd115936c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueAutocomplete.js\":\"0d5f43820d51c81a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueSchema.js\":\"7c185501aa644a81\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/HeaderItem.js\":\"12a79eca284b0467\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/QuickFind.js\":\"27fa64cc3c3e17bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/index.js\":\"d6a901032f17933d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/recents.js\":\"9797b2b4dd50e7a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/resultItems.js\":\"3ea928ed2cbadc2d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/selection.js\":\"ae470b176a1002a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/toggleStore.js\":\"a6e4fd1dfdfc0579\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/HeaderItem.js\":\"c62453bf5e1c5bb0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8a64e84b1b6f30b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/grouping.js\":\"eb151ad1211a887b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/index.js\":\"a442963d4085aa2c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/target.js\":\"d02a089c540f322a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/codeMirrorExtensions.js\":\"205fa89072a0303a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/contentPrefill.js\":\"96d6e4590dad7643\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/dataExtension.js\":\"1ed432aaa25f027a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/index.js\":\"57df977c759293da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"77807b50e45ad586\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/invalidation.js\":\"f9bce1ead2d89c9b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/localSchema.js\":\"cb85ecb385d14faa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/index.js\":\"f2b5df0bd5093934\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e33087faf1f25a54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/index.js\":\"410f984aff76206a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/referenceNode.js\":\"a6ed83594e0e8e18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fd5864d72b28197c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"0945d9340b45114a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/index.js\":\"a1edbc07fd3763c0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bf2ec972f8fb1e94\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e706f83311930cde\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/mergeRetargetProcessor.js\":\"050ec50febf88ebf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/parseFence.js\":\"4b8aeb21e2a0c568\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceParser.js\":\"957ca617d461e38e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceProjection.js\":\"fe2903c906fa4497\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referencesProcessor.js\":\"5ff2c1570ea6d2ab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/renameProcessor.js\":\"b524abdc9ede3c39\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/spanReplacement.js\":\"395ba31357282321\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/htmlToOutline.js\":\"e2f57514470e966f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/index.js\":\"6c500e2ed0529fbd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f6c0a13da13b869c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/pasteDecision.js\":\"24f787cc1c96e11c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/action.js\":\"880f72e0443c09a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/blockIds.js\":\"02087fc745295a2d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/content.js\":\"2f6ccc2c5f1b9e35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/effect.js\":\"c2c5c26e21e71105\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/ids.js\":\"ccf9e78c2b786891\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/import.js\":\"c8f45b09de78c3f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/index.js\":\"b28a14e3854ce047\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plan.js\":\"8d1f39688efb4f1d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plugin.js\":\"6a9b1c1321aeaf7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/promotion.js\":\"d4d41d01f1154ad1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/properties.js\":\"baa62ff05f8da9fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/references.js\":\"9511fb6b51270950\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/report.js\":\"24e5db328e2b030a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/roamMemo.js\":\"e5c8d17bff602fc3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/runtime.js\":\"a2a8e32169d873a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/schemaReconciliation.js\":\"569d384f26c82cfe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/srsMarkers.js\":\"3a84adaeb472ecc7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/todo.js\":\"d5d35650ef619cd3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/typeCandidates.js\":\"8287791181e41154\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/types.js\":\"75edb6f010ff93c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/index.js\":\"3c314439c09e1740\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/store.js\":\"cc105ae694b34aa8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/HeaderItem.js\":\"af92c97a877c4a42\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"57393cdfb054dab0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/index.js\":\"360063b572fc0afc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/model.js\":\"93458dcd01d52f89\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/toggleStore.js\":\"515e938d09fd11ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/useKeyInspector.js\":\"04219150524e4004\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d3b869146610d275\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/ShellDecorator.js\":\"cbe12ff1844c0432\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/actions.js\":\"fd8aec38ef0e056a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0491f800d166c1ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/index.js\":\"50977d91d720fa4c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/shell.js\":\"a0418cf99189b75c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/surface.js\":\"bd463d5ce263f778\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/walker.js\":\"293f3b60f2ab9929\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/RescheduleToast.js\":\"515fae1ad0cd1019\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/dataExtension.js\":\"589f4ca52ed19eb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/index.js\":\"1c36e74f9f206b89\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/indicator.js\":\"11ad148ca7618fcc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/moveSrsState.js\":\"21bce88ba504daef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2741a4a51aa46a58\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/scheduler.js\":\"bb074c78374c37a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/schema.js\":\"b87f3345bc045e4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e4d06e8ba46b1145\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsClipboard.js\":\"be62025b6b967aef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a7762f9a4237869e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7b4df1c82817ce29\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DeckPicker.js\":\"e2b0184f47c36137\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewControls.js\":\"0a33135f5cfc4c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e47c8a0f4a3ec4fd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewSession.js\":\"5edcb4a07abe1db8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/actions.js\":\"9ec539be5c13df2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/archive.js\":\"e93b7d04df7db678\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dataExtension.js\":\"49071f2ddeed82ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/deck.js\":\"9855fa457f4da51d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dueQuery.js\":\"08efd9d745c87d6a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/gradeDecision.js\":\"bf67dba3a0ca50c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/index.js\":\"25c60f7819e7e172\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/keyHints.js\":\"5cc617495805855d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewCardLayout.js\":\"81483bedf4ab2d57\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewProgress.js\":\"edc42e208f8499dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/schema.js\":\"9006c22b5bce5a23\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/useDueCards.js\":\"be470ec2d67cca93\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/index.js\":\"33773a96105d6d4c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/record.js\":\"d58a149997799f88\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/index.js\":\"9b84f5acdfc9997b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/persistenceStatus.js\":\"e0656eab9599e021\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/requestAction.js\":\"e02154277867f682\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/TypeChipsDecorator.js\":\"e3e9f3148b993774\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/codeMirrorExtensions.js\":\"5baf20250c0de6e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/index.js\":\"361f1d42432a31d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/typeAutocomplete.js\":\"e537873b539a87f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"da1404825e32d6aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/actions.js\":\"eb536d354fad27dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/anchor.js\":\"9d02dc824b13e2d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/events.js\":\"ee414922c351aef4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/gestureActions.js\":\"d51ad7e726b28105\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/index.js\":\"33076c4d47895330\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9ce5c4e7867e8974\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/collect.js\":\"f8f261734073b0d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/index.js\":\"f042da06f5bf83e9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/record.js\":\"59c0990be13b5eca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/RejectionDialog.js\":\"e5f4bd2fc8fdaf27\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f07f8ad0c4138c45\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/index.js\":\"3d455b04188e7a4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/model.js\":\"3b1d137401756b53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/queueCounts.js\":\"22d61213c86d7475\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rejectedHelpers.js\":\"4110360211b50f12\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rematerializeAction.js\":\"b0518057f5076327\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/useHysteresis.js\":\"11aa80a570361883\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/ColumnHeaders.js\":\"3c65528138fb3348\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/QueryUi.js\":\"fb65e7d26bb8d520\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/TableLayout.js\":\"981c1b073b17033a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/actions.js\":\"5928ea32f06010b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/cellEdits.js\":\"10579a333539668b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/childrenViews.js\":\"5a8de40a475b3133\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/columns.js\":\"a26f12d71a03fffd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/controller.js\":\"a902ce32ca84b2b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/convert.js\":\"6a0c88d69d2e7b05\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/dataExtension.js\":\"b9c476c2d95a2cab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/index.js\":\"ece683dbdc9f963e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/keys.js\":\"52f580d17bb54dab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/model.js\":\"97b50f0008c658d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/navigation.js\":\"9a6979edb5ba02ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/backfill.js\":\"2683a3762a10f27a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/completion.js\":\"876c0a7ae9e5904c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/format.js\":\"f7e9949dc9be4345\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/parse.js\":\"e84f47815eece6a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/queryValue.js\":\"d40dcd3178841023\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/source.js\":\"07696909545aac12\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/registry.js\":\"8914d4fbbd08fae9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowGutter.js\":\"e645299153a3e457\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowVerbs.js\":\"a333caec07499330\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/schema.js\":\"521c078bb25aef59\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/sort.js\":\"d553965a018e6b3b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/effect.js\":\"dbcb711a36a69be2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/index.js\":\"827aaf12085c838b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/theme.js\":\"7b6ada9f7dea0650\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/actions.js\":\"e78d0de87e823177\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/dataExtension.js\":\"058e412a69c9d8b5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/index.js\":\"00768e3f869a115c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/schema.js\":\"96532abdd3072698\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/TouchSelectionLayer.js\":\"58f1e5becf9aabe5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/actions.js\":\"1a6e5524007d42ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/defaultItems.js\":\"fe946cddb7d126b5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/facet.js\":\"c0229f8f6e4a6c2c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/holdRecognizer.js\":\"bbc73177794736d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/index.js\":\"cbb2f5201380e716\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/UpdateIndicator.js\":\"e4a2eabe9f5101d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/index.js\":\"3c9c0b36716fdeb7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/loadTimes.js\":\"e98b7f3c375129ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoNotesRenderer.js\":\"dc402a06f59c78cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoPlayerRenderer.js\":\"469697a60f1cdc1d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoTimeStamp.js\":\"1ddd05107b1143d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/actions.js\":\"a49aef7eb6144880\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/index.js\":\"91d2937d215d6774\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/markdown.js\":\"5bb16b18e8f99db3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/notes.js\":\"2b984ea51501c2a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/registry.js\":\"62a61d6aaa403343\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/remark-timestamps.js\":\"2bd6564c48215fbd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/view.js\":\"1477c84f3b859cea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/LinkHints.js\":\"2723746bc7168ccc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/index.js\":\"f1fb58f5eec88d49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/model.js\":\"55f190f448b6c716\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/settings.js\":\"5ce19a43acb4297c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/actions.js\":\"598b76e73ed2510c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/index.js\":\"23706361f8e0f220\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/interactions.js\":\"8c25a383f341f731\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/workspace-header/index.js\":\"a2f6f96bb6c44565\",\"/knowledge-medium/pr-preview/pr-1494/src/registerServiceWorker.js\":\"5d757e050f455c58\",\"/knowledge-medium/pr-preview/pr-1494/src/requestPersistentStorage.js\":\"7868e9a842702652\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authRequestDeadline.js\":\"b648749b92b476ea\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authStorage.js\":\"3d3ecc2be6c9d1a9\",\"/knowledge-medium/pr-preview/pr-1494/src/services/powersync.js\":\"ef2b3fbb1ee9ecfc\",\"/knowledge-medium/pr-preview/pr-1494/src/services/supabase.js\":\"66f99930b7fdf151\",\"/knowledge-medium/pr-preview/pr-1494/src/services/uploadErrorClassifier.js\":\"eb6c76a27636ae3d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/ActiveContexts.js\":\"69e1812ee7475118\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/HotkeyReconciler.js\":\"962ff64c5f5c24af\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/WipeLocalDataDialog.js\":\"7eff40f8f89abdfb\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionDispatch.js\":\"d084f33e347a9766\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionRefItems.js\":\"8cb38f2b8c4ea66e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/applyKeybindingOverrides.js\":\"fbe95fd5e5f9e364\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockActions.js\":\"a88332b30d0c57e0\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockMergeGesture.js\":\"c9dfc648318cbb39\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/canonicalizeChord.js\":\"321b8c50e1dd896e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultContexts.js\":\"138d09313718a79a\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultShortcuts.js\":\"6ad63cb157869506\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/effectiveActions.js\":\"815ea2de17a72e3c\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureAction.js\":\"18c7927380db708f\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureBinding.js\":\"382719cbbe7a0e3f\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/holdRegistry.js\":\"ee8d76d6c12528fc\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingConflicts.js\":\"64aae26244f4cd2f\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingOverrides.js\":\"25d61d04bd4288a8\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/pointerAction.js\":\"a1ac54c7cc3dec67\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/resolve.js\":\"8ae95168f2301d75\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/runAction.js\":\"5d3df3cf2c140807\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/sequenceMatcher.js\":\"4de9bdcdd4de13ff\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/types.js\":\"9d8eb3b9d6e737c2\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionContext.js\":\"39d184b65b409d91\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionDiscovery.js\":\"e1ab2af224a5ee6d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/utils.js\":\"6c4ab8b345c1442b\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/bootStore.js\":\"e483d351453037bc\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/previewDatabases.js\":\"1f9e84cfa32941ec\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/byteTransform.js\":\"122acae6f2ad428b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/attachmentCleaner.js\":\"eb8a83257e9fac8e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/attachmentParts.js\":\"3cddeed9b57046b4\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleParts.js\":\"e8b97fdf4602c48b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleRecord.js\":\"9140322afdfecb4d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/manifest.js\":\"952eb4ec17dba5e8\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/takeBundle.js\":\"5d0451823b0addd6\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/verifyBundle.js\":\"8286fcfa74638fe9\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/cleaningStage.js\":\"45b028aaaa914c1c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionKey.js\":\"a39c50ecd7a15b4f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionServer.js\":\"1a5c761e46a1b778\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flip.js\":\"6153d714f4d40014\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flipAttempts.js\":\"9f503a59edd02512\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/pages.js\":\"6003537d3f2972e6\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/preflight.js\":\"4f058382d6f56d74\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/reseal.js\":\"f693c5054aab9cd5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runConversion.js\":\"db85c9c4c58b1ee9\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runLock.js\":\"5a590ad135b5033d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealing.js\":\"f3cdc1b6c0d536bc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealingStage.js\":\"28eddb7e8ba8afe6\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/stage.js\":\"f01ea6b9f162f53c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/verifyReseal.js\":\"194a7731e60c3d10\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aad.js\":\"cd38cd961f1a3815\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aead.js\":\"14dfec482cff32b2\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base32.js\":\"b4b09f98a2b5d834\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base64url.js\":\"e6eb3e455b3a6603\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/binaryEnvelope.js\":\"264ab388f06fd3c8\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/byteAead.js\":\"f135caba71da83c0\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/canary.js\":\"1e3a6b652c8afe28\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentHash.js\":\"6f8d6558212fe9db\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentKey.js\":\"e5831e63d43c6b01\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/derivedIdNamespace.js\":\"8edcc4047f695d0e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/envelope.js\":\"0cc4113eaf542ac5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/hex.js\":\"ac7e401cf9f028f0\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/sha256Hex.js\":\"16432d9178e45e6b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/workspaceKey.js\":\"bb4d3eaf40da75d3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/conversionState.js\":\"5a7d2b29402af535\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8932ec8439fbb6a6\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/pastedKey.js\":\"30c4815b9f4ce204\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"307bf09a57673287\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c6db79c4ff150321\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/keyStore.js\":\"70d5f6be75fa0463\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/mintWorkspaceKey.js\":\"6768060cc1e1a99d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/modePin.js\":\"e8b2018b06bc5c55\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/openWorkspaceKeys.js\":\"6c6bf9230f525ede\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolveWorkspaceEntry.js\":\"087f0772365b41a3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolver.js\":\"83e6893d422a7069\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/workspaceAccess.js\":\"e0b73cebfbc7e0cc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/transform.js\":\"2d0a3f26c406a4a4\",\"/knowledge-medium/pr-preview/pr-1494/src/themeBootDefaults.js\":\"48d8d133e9421563\",\"/knowledge-medium/pr-preview/pr-1494/src/types.js\":\"70e2617249427267\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/ClientLocalSettings.js\":\"c2fe434de2e1ca73\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/abortableSleep.js\":\"1c78592cbe1ee521\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/array.js\":\"071c825027ec188d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/backlinkAutocomplete.js\":\"ddc67482528397ee\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockCrumbs.js\":\"a84ed86f01b7570a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockrefAutocomplete.js\":\"254c6d370f7dd117\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/cadencedIdleJob.js\":\"87340263b7db20bf\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/callbackSet.js\":\"c9d4077a2b974fec\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/clientId.js\":\"65c26a1091902caf\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirror.js\":\"dc44f6913450c4f9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirrorCompletion.js\":\"4b5de8713d728b27\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/copy.js\":\"356442338d2f0444\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dailyPage.js\":\"a2776c4416324d10\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensics.js\":\"9a058dfca4befe74\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensicsHooks.js\":\"2980491926618794\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/deleteBlockThroughUi.js\":\"de7cb7a45279b2b1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dialogs.js\":\"b9f88c7768d069c6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dom.js\":\"ecf0d87db8a83f50\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/downloadBlob.js\":\"86b67829ad7bc270\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/exportSqliteDb.js\":\"e066ac6d37e1e9f8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fileSystemAccess.js\":\"fd4f8e413131a1e4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/flipSlide.js\":\"b23f99801cb33c92\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fnv1a.js\":\"2156e87fbc31da10\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/formatBytes.js\":\"a685856695d24f5a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fuzzyRank.js\":\"0c74131f7da4d300\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idbKeyedStore.js\":\"d17f8d6e083a98c6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idleCallbackPolyfill.js\":\"bf0471d0f822c0eb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardAwareScroll.js\":\"15cc1197384b9ca5\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardViewport.js\":\"91852449a1ffc806\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/lastWorkspace.js\":\"fd782b86b567fc69\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutColumns.js\":\"f982b9a37d5397af\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionDom.js\":\"8b16e731992bdae0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionId.js\":\"89b148ec09bc5346\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkClickGestures.js\":\"e7d593145460cf0e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkTargetAutocomplete.js\":\"a16a076fdd40f551\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbCorruption.js\":\"ebcd7a19460db2d6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbRecovery.js\":\"649045d492082f33\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/markdownParser.js\":\"ed95b031db0e6456\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/memoize.js\":\"30f0c4bf111dfafe\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameFieldCommit.js\":\"a720b4eaec30e0cb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameList.js\":\"74b46e15f994e1a0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/navigation.js\":\"0f0ce3d2e7966ee5\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/omnilinerNamespace.js\":\"2e0fd80a958dc312\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/opfsPageScan.js\":\"b05e6078652954e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelClearance.js\":\"380481025c85e1cd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelHistory.js\":\"d4f6d88b5d0454c7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLanes.js\":\"3f5767172f3b5931\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLayoutProjection.js\":\"ce4e8289b9775be7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelScrollAnchor.js\":\"94943a259f283d59\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelUrlFlags.js\":\"a196a9f007e68b7e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/platform.js\":\"9f0ba437a4665909\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/pluralize.js\":\"ee4ea8871aa268b3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyCreation.js\":\"a8ce414a42f19b58\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyNavigation.js\":\"842d3592a3b6acea\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyValueContext.js\":\"19173216223f8d52\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/react.js\":\"31d44d696be1739f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeDate.js\":\"43b9e3971b5bdcb8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeTime.js\":\"9625822f1a2749d2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/renderScope.js\":\"bbe3803a268eae96\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/resolvedThenable.js\":\"9234d4cb4b922e0c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/routing.js\":\"75aa71f5952fdbae\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/safeMode.js\":\"ad8395ec447be360\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/scheduleIdle.js\":\"b9fec2a443903838\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/screenWakeLock.js\":\"0731591319466e27\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/selection.js\":\"6e46aca23e7d7e75\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/softKeyboardGrab.js\":\"c306b0bf853f15dc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/startupTimeline.js\":\"cfcbc136a49c9a1d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/state.js\":\"0ab80256c677f0e5\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/string.js\":\"acd88c680b162e00\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/surfaceZoom.js\":\"7708b2993bfb71fc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/time.js\":\"31bf4693ab4e9449\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toast.js\":\"0e695c898589fdb9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toggleStore.js\":\"321d80bc29dcee2b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/untilStopped.js\":\"b8a39b1917dfb652\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/userActivity.js\":\"ca0adacc5ca0284c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewTransition.js\":\"22f2527f1c218cc7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewport.js\":\"eec6cfa1d42bf1fd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/webLock.js\":\"b7b4392fddb740ab\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceRecovery.js\":\"7d2d8cf7e2d5330f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceSnapshotStore.js\":\"546325590912e54b\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-compiler-runtime.js\":\"b5c1dd84eae24207\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-client.js\":\"27f96976c71c57ac\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server-edge.js\":\"96448a6994abeb76\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server.js\":\"8142368dfb19cda2\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static-edge.js\":\"ff3fc5cba08a9082\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static.js\":\"dbc0a118395613de\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-test-utils.js\":\"62cf0b24c0a8d8d9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom.js\":\"6822765701e3d012\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-runtime.js\":\"6759a79534f1d0e9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react.js\":\"762b691e784a0319\",\"/knowledge-medium/pr-preview/pr-1494/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
})();
