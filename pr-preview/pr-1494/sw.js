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
		buildId: "3a9040a99fe6-c9e65293",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/\":\"cac4bb480bfb72a7\",\"/knowledge-medium/pr-preview/pr-1494/index.html\":\"cac4bb480bfb72a7\",\"/knowledge-medium/pr-preview/pr-1494/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1494/assets/FacadeVFS-DDzDoXQb.js\":\"88fb3b82c8f4be76\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSCoopSyncVFS-D6fh1LJ-.js\":\"15272f3165e9553d\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSWriteAheadVFS-BdXFnIdy.js\":\"12d7759f9ba21da5\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-BuYG0Vu4.js\":\"9aef91e3b228c1fa\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-DMahT6nB.js\":\"5a8713cc2d77d753\",\"/knowledge-medium/pr-preview/pr-1494/assets/worker-DruwuQVf.js\":\"558d3c84ce58be64\",\"/knowledge-medium/pr-preview/pr-1494/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1494/chunks/app-DA-dge-H.js\":\"31ae9070449df430\",\"/knowledge-medium/pr-preview/pr-1494/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1494/index.js\":\"d79ab1d104890bdd\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1494/assets/AccessHandlePoolVFS-czjKvoK8.js\":\"4c6f78150b31ddf5\",\"/knowledge-medium/pr-preview/pr-1494/assets/IDBBatchAtomicVFS-BPlA0-Jt.js\":\"e37f03300ccae2ec\",\"/knowledge-medium/pr-preview/pr-1494/assets/MemoryVFS-BvB6_Ih_.js\":\"f8579640e18927a0\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-BCzro9hp.js\":\"e7cd9ce1b0552bad\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-DM7tM7bE.js\":\"6d3f0f51f90af024\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1494/chunks/AccessHandlePoolVFS-B-BusBMB.js\":\"d0809d57e525070b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/FacadeVFS-iu3kEQ3w.js\":\"ebec41d7a58ffe43\",\"/knowledge-medium/pr-preview/pr-1494/chunks/IDBBatchAtomicVFS-CY9hEKlT.js\":\"6b2b003c06b3c9bb\",\"/knowledge-medium/pr-preview/pr-1494/chunks/MemoryVFS-BNasZnfL.js\":\"aeddc4ec9ad25cc1\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSCoopSyncVFS-C7TtBMv4.js\":\"6f0258f82c8c4e40\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSWriteAheadVFS-mDDaICta.js\":\"a2be8e6c6acd83e7\",\"/knowledge-medium/pr-preview/pr-1494/chunks/Preview-D18HVyvy.js\":\"dcc8797def971b1b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1494/chunks/card-CU9DXycv.js\":\"0a207bfb001e60a2\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-CppzRKWD.js\":\"b6e6adcbffdb3419\",\"/knowledge-medium/pr-preview/pr-1494/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-CceK_Fdb.js\":\"ed404cb6b108b360\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-async-CwkRYy2M.js\":\"a131ede70603fa7b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-6kEKO8Ne.js\":\"5de0869ce2b14f9b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BSHB44Mo.js\":\"986b095ceb4a6914\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BazZ2n2u.js\":\"faacd77292b82b56\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BfumeX_W.js\":\"b16738b0bc4dc3ba\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BtyUZHfo.js\":\"b14550ded9713f57\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-C7TBogpO.js\":\"5f7c63972d3adade\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-Cf4wXCgJ.js\":\"88dd2b2075ccef87\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DOVFg5Xl.js\":\"848840606a197915\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server-legacy.browser.production-C51gy8ZI.js\":\"0066afac31d5990d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.browser.production-BxXqorRj.js\":\"bcc052330aac2f60\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.edge.production-BA7XrUl-.js\":\"7ca4491c8597f5f9\",\"/knowledge-medium/pr-preview/pr-1494/chunks/server.browser-BDveIb-x.js\":\"ef240545306bee79\",\"/knowledge-medium/pr-preview/pr-1494/chunks/textarea-C7uFtXF9.js\":\"228871ca211cfb2d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/ui-BRu6DqwL.js\":\"975bf049d18d25ec\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-I6WDVGPA.js\":\"7c32fc4ed5607a2d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-async-YGB7qMsX.js\":\"6ee122600e960138\",\"/knowledge-medium/pr-preview/pr-1494/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1494/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/src/App.js\":\"d6a1194c3e0c8740\",\"/knowledge-medium/pr-preview/pr-1494/src/appUpdate.js\":\"f4b2ea3d05942597\",\"/knowledge-medium/pr-preview/pr-1494/src/appVersion.js\":\"fb34144c0ddf1c55\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/initialLayout.js\":\"0c0b42bf415ef7e4\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/openWorkspaceData.js\":\"40ccc43c52b9e8aa\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/resolveWorkspace.js\":\"ac145eb52a51e03d\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/workspaceBootstrap.js\":\"60b6f25731456214\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockComponent.js\":\"3da3d6efa807e9c6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockCrumbs.js\":\"f839abc0f857ed5c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockEditor.js\":\"db32a50e76bc5806\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockLoadingPlaceholder.js\":\"2f2d145e0a40fc31\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockProperties.js\":\"cb54133057167fe6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockSearchPicker.js\":\"f03a3d7f72d5a93e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ConfirmBulkDeleteDialog.js\":\"976129998dbb1c8e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DividerHandle.js\":\"4d43da81294ae5ec\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DraftEditor.js\":\"26fe87ecb9ec2664\",\"/knowledge-medium/pr-preview/pr-1494/src/components/GutterPill.js\":\"5c2c304b1cb93e7e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Header.js\":\"c0715154a1cf09fb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/LazyBlockComponent.js\":\"714f2188a4afffcd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Login.js\":\"dba74e53fbec0be6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ZoomableSurface.js\":\"51c1edec42fabf0a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/editModeKeepalive.js\":\"a8091b9f25e616cb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f2a97c76c3795ed0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f3e553e5fbb9f89f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefPropertyEditor.js\":\"0c088a337f10388b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefTargetTypePicker.js\":\"30dad0480ec4a70a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/SelectPropertyEditor.js\":\"099add7259cb604a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/TypesPropertyEditor.js\":\"5faeb5b5f97eb82b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/defaults.js\":\"315047734f26177d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/kernelValuePresets.js\":\"4b2756753074b220\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/selectablePresets.js\":\"a5cc3f90f2a59886\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/typesPropertyUi.js\":\"b15f516aa86f7e6b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/AddPropertyForm.js\":\"7f92cbaea3277edf\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyPicker.js\":\"5cf6283d0ae3468c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyRow.js\":\"068186f6cd52d0c2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/Rows.js\":\"0ad579e9441441ca\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/actions.js\":\"d1a8c15ff66404cc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/declarationOnly.js\":\"c70cd465cffc7b70\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/layout.js\":\"96ca037fc035b34a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/model.js\":\"e4355ff3c69c3179\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapeUi.js\":\"944383ae3c0c4c12\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapes.js\":\"de52c04ae412e2c4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/usePropertyEditingActivation.js\":\"367f2907391d258f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/visibility.js\":\"d725def5ab89d47d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanelSections.js\":\"74b32af9b0039338\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockEmbed.js\":\"5c66d031def0e217\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockLink.js\":\"afbdc1c7ec6cac9d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockRef.js\":\"90041962231ffa31\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/ReferenceLink.js\":\"17e666784cdb6a82\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuard.js\":\"041c018000cbab51\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuardContext.js\":\"33f4672be7ba3fe0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/linkInteraction.js\":\"6c94296bd31c73ec\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/referenceLayout.js\":\"fa4200d4c8bf10bc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/useBlockRefAncestors.js\":\"ec769c4457f25ce0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockGutter.js\":\"cfa0ff8f9448730c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockInfoDialog.js\":\"cdbe1b3dc93e5ead\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockTypeBlockRenderer.js\":\"0ffa2c28ddeaedb4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BulletHoverCard.js\":\"df8350948e34811b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorContentRenderer.js\":\"182c407b185c46d2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c5dd132d5c684b3b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ColumnResizeHandles.js\":\"5d903d06c89ede84\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6e5eb7c226380222\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/DefaultBlockRenderer.js\":\"b9d36a79aff2973a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/LayoutRenderer.js\":\"cf0f602c8b89d4bd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MarkdownContentRenderer.js\":\"899fad6886cec1d5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MissingDataRenderer.js\":\"0a55a3f9ce820bb7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PanelRenderer.js\":\"c44ad2ccac00c055\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PropertySchemaBlockRenderer.js\":\"288373694e9094aa\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/TopLevelRenderer.js\":\"e92d9a6b5fe6d44c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockGutterMode.js\":\"e70296609ec80f4b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockTitleText.js\":\"b7c8ee52b43842c2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/fieldCreationKeydown.js\":\"5902fff012fce7a6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/layoutRootContext.js\":\"956c954cb57d5fdc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/TypeChip.js\":\"da5ecc3890d00764\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/chipStyle.js\":\"5bbf35d10495bfb9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/anchored-floating.js\":\"0f745d973c857bbd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/button.js\":\"225ee71c4dc8a787\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/card.js\":\"a214d89ca960902f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/checkbox.js\":\"ca23d09bf8193fba\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/collapsible.js\":\"861fd79d633b1d67\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/command.js\":\"99f8f33afc5afb9a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/context-menu.js\":\"e9f85c49a423506f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dialog.js\":\"121b1cabdaf38e74\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dropdown-menu.js\":\"b3469235179b3d8d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/floating-listbox.js\":\"6c58f65502941627\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/index.js\":\"5f30f76f96da0ce3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/input.js\":\"ff6a2ec3b0c0f2b2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/kbd.js\":\"fd13c3a87fe8d245\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/label.js\":\"88f2da560a374e40\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/textarea.js\":\"9e43535c474ae563\",\"/knowledge-medium/pr-preview/pr-1494/src/components/useEditModeYieldKeepalive.js\":\"2a53dee14690b488\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/BootFallback.js\":\"c47411e3f4ed1d9e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/FocusedRowLazyMount.js\":\"7b50ed0565e8657c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LazyViewportMount.js\":\"11348b8ecd523b29\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LocalDbCorruptionFallback.js\":\"b308871055e97b5d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/error.js\":\"b515d46d522b11a6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/lazyMountRegistry.js\":\"c2501ed944454948\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/suspense.js\":\"f84745fc97cd2610\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/CreateWorkspaceDialog.js\":\"c84b05a8262edc97\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/PendingInvitations.js\":\"b063ea78602e6f96\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/SyncProgress.js\":\"1cc8f2b0c4598fc0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/UnlockProgress.js\":\"778403c71dab4ccf\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceKeyGate.js\":\"d38220025e46fdb7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSettingsDialog.js\":\"7a49d6782232f6d7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSwitcher.js\":\"0b7b8bda89f20115\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSyncGate.js\":\"c77506efbdd2b982\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlow.js\":\"73f1941d25587227\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlowHost.js\":\"477f12ecfc060de2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/EncryptionSection.js\":\"916deaef3712df19\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/attachmentPrompts.js\":\"b02acc360e0ad94e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/bundleFolderPrompts.js\":\"10f22b2aee8ca6d5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowDeps.js\":\"cb133f6e46bd3c39\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowStore.js\":\"61758dc98cb43891\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/flowUi.js\":\"1c550d3a75787814\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/useConversionRun.js\":\"9834d1b71517418e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/keyUi.js\":\"4a7f371597952754\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnKeyLoss.js\":\"e18982876e70e6b5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnServerE2ee.js\":\"ce0a194d5f283e9c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/workspaceUnlocked.js\":\"97738dbffeb37c47\",\"/knowledge-medium/pr-preview/pr-1494/src/context/backgroundSubtree.js\":\"22766a819394a021\",\"/knowledge-medium/pr-preview/pr-1494/src/context/block.js\":\"972817e25c60f2f2\",\"/knowledge-medium/pr-preview/pr-1494/src/context/layoutWsContext.js\":\"e26e73be9a1ff46f\",\"/knowledge-medium/pr-preview/pr-1494/src/context/propertyDisplay.js\":\"4c88de316e721034\",\"/knowledge-medium/pr-preview/pr-1494/src/context/repo.js\":\"14a8d0d414b88e02\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasClaim.js\":\"ca4a37b3c5a7e880\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasSeatNamespace.js\":\"5b339993d7eb3886\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockData.js\":\"ecaebb479d30b3bb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockType.js\":\"9365eb0f69183c47\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/changeScope.js\":\"a9c00e84c06b3c12\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/codecs.js\":\"e21f6c49288cd549\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/derivedData.js\":\"2e098007d5c5a23b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/errors.js\":\"bf330a4f3c370cf1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/events.js\":\"809af5d530e84a59\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/handle.js\":\"2b59562955832637\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/index.js\":\"41bcd5e89d0b1968\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/mutator.js\":\"7fdcc79251d5532d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/processor.js\":\"4f1ff1787858b785\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/propertySchema.js\":\"ca779b41589e7900\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/query.js\":\"5df659d76081d31a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/sameTxProcessor.js\":\"ed11309eb2a3c848\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/schema.js\":\"2b59562955832637\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/tx.js\":\"2b59562955832637\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/typedBlockQuery.js\":\"82483631d8ec84c6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/user.js\":\"430e9465a68de4bb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresetCore.js\":\"37ffe6f5c05a5fa2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresets.js\":\"3b925035a8bbd092\",\"/knowledge-medium/pr-preview/pr-1494/src/data/attachmentCleanerIOVerb.js\":\"2b3bf63250b726ef\",\"/knowledge-medium/pr-preview/pr-1494/src/data/block.js\":\"46b599858c101f5b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockCache.js\":\"fef4d598dbe5e456\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockId.js\":\"69f7567b666614e7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockLiveness.js\":\"2f37ceb306408676\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockMerge.js\":\"b9551629176239e4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockSchema.js\":\"dd6e2d255613a3c3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypeLookup.js\":\"1aa4c1b7aa4a19e5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypes.js\":\"1f356708bf47d515\",\"/knowledge-medium/pr-preview/pr-1494/src/data/clientContext.js\":\"09606fd92143d4b8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/dbFileSiblings.js\":\"1a982b3469094110\",\"/knowledge-medium/pr-preview/pr-1494/src/data/definitionSeeds.js\":\"bf4cc734db77bfbe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/derivedIds.js\":\"18fc326380453c66\",\"/knowledge-medium/pr-preview/pr-1494/src/data/drawnSubtree.js\":\"23ce0000ee354156\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facetBridge.js\":\"9c52d4fa7bca833d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facets.js\":\"1b6d619af507e154\",\"/knowledge-medium/pr-preview/pr-1494/src/data/globalState.js\":\"0c94577a0a06bf3b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/aliasClaimRederiveProcessor.js\":\"a5f9bda9742c21e7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/ancestorBatch.js\":\"b3a16abdf9d21f99\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/blockTypeTypeifyProcessor.js\":\"7927dd48995c64ed\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/clientSchema.js\":\"101170a14c75da25\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/commitPipeline.js\":\"85287638ba4c0fcb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/devAssertions.js\":\"f916e6e1e514d716\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/firstSync.js\":\"e49b3ab8e0512185\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/freshInitialLoad.js\":\"8ddf17b46c753ecd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/graphBackfillClaim.js\":\"be91876417169552\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/handleStore.js\":\"da058bc3069ffc25\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/idleMarkerJobs.js\":\"8d0cd43823e9dc2c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initialDownload.js\":\"500c89186bcba90c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initializeClientDatabase.js\":\"1fb05019d376cc92\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/jsonCanonical.js\":\"3b6273fce85cc179\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelInvalidation.js\":\"543d09f3acb74aae\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelProcessors.js\":\"a1362b1c5a3f52ea\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelQueries.js\":\"1b9361dc25257149\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/mergeTypeMembershipProcessor.js\":\"4431c14bd4dec769\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/normalizeReferencesProcessor.js\":\"422049b54e4b68f0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/poolInstrumentation.js\":\"4a7ebfd283b75332\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/processorRunner.js\":\"30df1065e684167c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyCellBackfill.js\":\"7a6eab99eed499bf\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildMint.js\":\"8c912c3e21eca968\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildrenProcessor.js\":\"7ab095b511556935\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3df24f64b8e99c9b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionSynthesis.js\":\"b7c449e5a7491d9f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyKeyScan.js\":\"3ac17482711db5db\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertySchemaResolution.js\":\"b3a827605fa7fb27\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyValueEdits.js\":\"447304df00aa6514\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/raiseProtocol.js\":\"801b140c72b8febb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/readBatch.js\":\"dd7846883ae6776a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/refProjection.js\":\"910a711cb6c428c3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetLookups.js\":\"eda8f8557aaae12d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetProcessor.js\":\"8c1cc030d2a9f017\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/replayMerge.js\":\"1ad9ca2f80d9009b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/sqlBinds.js\":\"169b43b7566b977c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"266201b8bbeacb5d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/arrivalProcessors.js\":\"7cd29c0aad2e0f31\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/invalidate.js\":\"20bbffb86fcfe3c3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/materialize.js\":\"1cebda6c44fe1379\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/observer.js\":\"292365637197607e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/reconcile.js\":\"bd6297494c1b58e7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/timingMetrics.js\":\"5cbdcd7dbab28a44\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/treeQueries.js\":\"a7e0eac77967dab6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txEngine.js\":\"8b58dac13e1364b8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txSnapshots.js\":\"3d8a6e8aff574c1c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/typedBlockQuery.js\":\"f6f2ad5d791ef538\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/undoManager.js\":\"76865c3e8d44f770\",\"/knowledge-medium/pr-preview/pr-1494/src/data/invalidation.js\":\"44a9d6d3ebe98a7f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelDataExtension.js\":\"26ed8b67b8f9e059\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelPage.js\":\"127f18c6e2c62162\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelValuePresetCores.js\":\"912242727bda967d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbCorruptionSignal.js\":\"3e137816b99e8b42\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbStorage.js\":\"52e05fa09dec6155\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbVfs.js\":\"885bb3fa0c6c1eef\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localSchema.js\":\"9e7034b12ae1b2c5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/maintenance.js\":\"cd5fadcd40e248d9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mergeProperties.js\":\"e51b74194e66cf2e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/metricsConsoleHook.js\":\"de9d5496d1d9b9fb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/migrationsPage.js\":\"57596c21f52b3415\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mutators.js\":\"ad8e44b5d66da76a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKey.js\":\"d51d51b8cd9d3e69\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKeyPlacement.js\":\"5bc4c4bda08b841c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineGroupGestures.js\":\"e9c8d6e8434c11f8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineSurface.js\":\"0b17ed566f86eb69\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingEditorContent.js\":\"100afd9e3f7e7bbb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingUploadsSql.js\":\"f527124f790139a7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pluginStateExtensions.js\":\"80cc5de546ab941b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/powerSyncLogger.js\":\"1fc5d69143f02000\",\"/knowledge-medium/pr-preview/pr-1494/src/data/projectorRuntime.js\":\"410b0483dea248c2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/properties.js\":\"246789d9997c2d85\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertiesPage.js\":\"13283aa5db248b49\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyChildren.js\":\"35aa28b80eb893ce\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionFanout.js\":\"db43ee281d8e6c88\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionMetadata.js\":\"72f5bc165eb46790\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionRegistry.js\":\"92376ea3112a43d6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDisplayMode.js\":\"a106306e14dfe107\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyRowCreation.js\":\"c7c6dc7fafe026f5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySchemaCreation.js\":\"628640edd9a4dce4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySeeds.js\":\"5e234084f552e8fe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/recentsPage.js\":\"5f1232ebe9e2d335\",\"/knowledge-medium/pr-preview/pr-1494/src/data/referenceBlock.js\":\"ba62ad092d71fa43\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rejectedUploads.js\":\"f13765dbf745a9aa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/releasePowerSyncConnection.js\":\"46d410e58c7f128c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repo.js\":\"3bcc9f2f4a395160\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repoProvider.js\":\"2c45ba3ba2a132e7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rowProperty.js\":\"9c654865effd34e4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/searchFilter.js\":\"af012dd0a29dd1ac\",\"/knowledge-medium/pr-preview/pr-1494/src/data/seedIdentityLedger.js\":\"b1eb116fac21b3b9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/stateBlocks.js\":\"fc93a1a95fbc2f65\",\"/knowledge-medium/pr-preview/pr-1494/src/data/structuralEditPolicy.js\":\"47e96dad268a2e3a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/subtreeDelete.js\":\"fde75dde03019fe8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncStreamLock.js\":\"919dce3e2b19c8dd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableSqlRecognizer.js\":\"7b62d35e1ead8f45\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableWriteGuard.js\":\"b6d2241f0073f990\",\"/knowledge-medium/pr-preview/pr-1494/src/data/targets.js\":\"91a0e0d539b74f16\",\"/knowledge-medium/pr-preview/pr-1494/src/data/treeOrder.js\":\"00dc760df1cba9ae\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeColors.js\":\"ad7962bb6ec31824\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionMetadata.js\":\"ed334480ea955ed6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionRegistry.js\":\"5f22cd9c8669e96d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeExtraction.js\":\"29d93df3b160e7ca\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeInitialValues.js\":\"8391e25330effb76\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typePropertyGroups.js\":\"204f687dee8a60be\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeSeeds.js\":\"4158ddc4663ebe15\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeTagger.js\":\"c4d67a3f9deb9244\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typedRecords.js\":\"294fbefef740f0ca\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typesPage.js\":\"863adcdcc88cebb6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userPrefs.js\":\"7dbacc656383424a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userSchemasService.js\":\"b9936f23d6816952\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userTypesService.js\":\"b3510a312393eb76\",\"/knowledge-medium/pr-preview/pr-1494/src/data/valuePresetRegistry.js\":\"0f6cc4fdfd25229a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/visibleChildren.js\":\"bcceaca27c9ed686\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceConversion.js\":\"28eb9ba87a3496cf\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceFirstSync.js\":\"cec7ecc170f7a3df\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceIdNamespace.js\":\"a718977d4f556b1a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceSchema.js\":\"ef1f125ddd60dcd0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaces.js\":\"5d4bdf38b2990006\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadLog.js\":\"bfd9de05ccb86330\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/BlockPasteShellDecorator.js\":\"edec18b7c847894d\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/atTrigger.js\":\"d1c4467c7a51dcd1\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/autocomplete.js\":\"43955afdbace43f5\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/codeMirrorExtensions.js\":\"87ad394d224a14c6\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/contentFlush.js\":\"a497c4fb65cc3db9\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/defaultInteractions.js\":\"cce54bc4e03245a3\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/editSettleSignal.js\":\"3f01bde4beff159c\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/insertImage.js\":\"45892ef2e804b669\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceCompletionRange.js\":\"d45b6ce2311c1d9b\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceTargetTypes.js\":\"74bcdf7d1b901ef6\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/syntaxContext.js\":\"4ed420b1bba166a3\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/triggerMatch.js\":\"113ea982ab7ff9dd\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/AppRuntimeProvider.js\":\"07b9826a98cc49bd\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/BlockFocusShellDecorator.js\":\"bea4b23ce54d8cf2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/ExtensionRenderBoundary.js\":\"d5b2ab293cbfa935\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/PanelContentRecovery.js\":\"008cb8819ca600ec\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/apiCatalog.js\":\"21e3eed09ff820c6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/approveExtensionHere.js\":\"fd029337611ba023\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/armedCutAppMount.js\":\"6d886837b93141e8\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/batchableKeyedStore.js\":\"62bbaa487d6a471e\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockInteraction.js\":\"4ca07f6eabfb6ce9\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockSelectionAction.js\":\"0edbaffa9453210d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compileExtensionModule.js\":\"7fbd6d89cf7f97c6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compiledModuleCache.js\":\"b1095cc10389330d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/continuousGestures.js\":\"a2a4928c0c39ea2d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/core.js\":\"158a5c54de04be94\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/defaultRenderers.js\":\"27baf211d86aaad0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/definitionFanoutAppMount.js\":\"6337aa736a54293f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dialogAppMount.js\":\"fce12f1b2a2130a5\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensionSeeds.js\":\"b6f97b66e0fdce72\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensions.js\":\"22c19b6628816703\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/exampleExtensions.js\":\"b4fbf66e592d4dd9\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionApprovalStatus.js\":\"bf6e3e1f384a0103\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrorToast.js\":\"13cdaee59497a03a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrors.js\":\"87767ac5f7dc282a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLookup.js\":\"68a3d813a3621947\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionToggles.js\":\"db9fb26d91b8809d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionUtilitiesCss.js\":\"16e93ed4b0bed4f1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/kernelPageDeletionGuard.js\":\"b5794979b68d24a1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/liveRuntime.js\":\"bd0c074e853fd141\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/openExtensionsSettings.js\":\"7bf211254bcf7fa6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/overridesCache.js\":\"4c452b853d1a7985\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/pluginIds.js\":\"56d83653776bee0b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/processorRejectionToast.js\":\"2dde2a113820da54\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeActions.js\":\"daf6fbaaa97b0d90\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeContext.js\":\"333a186ec1d1e5b1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticAppExtensions.js\":\"462ed8f304025e06\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticDataExtensions.js\":\"202f879e7b8755b4\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/toastAppMount.js\":\"bd516b789dd803bf\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useOverrides.js\":\"d939f0959707f6f5\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useShortcutSurfaceActivations.js\":\"9e11d79e7a8684c4\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/discoverToggleTree.js\":\"651845ccd48fff6c\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/facet.js\":\"95e3b3fb5746354a\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/resolveAppRuntime.js\":\"3203a2d5d49df2f1\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/runtimeEvents.js\":\"f5f72d068dbb8dcd\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/togglable.js\":\"5907ecdc47df89b9\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/variantFacet.js\":\"87bec45352d564c8\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/verbFacet.js\":\"95916badd072881f\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/block.js\":\"5846068175891422\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/focusedChild.js\":\"8f859ef07785a0d2\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/propertySchemas.js\":\"0f1234f4b2693022\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/typeRegistry.js\":\"6b23155a81561d1a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAncestorCrumbs.js\":\"8e4936760df5bade\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAutocompleteListbox.js\":\"405f4f7943a2204a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedSearch.js\":\"5f3208ad3eb59bf8\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedValue.js\":\"2c5d486a5d49b344\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsFocalRender.js\":\"78d062d1296ae0af\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsReadOnly.js\":\"6ee3c09b21e896e7\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMaterializeBacklog.js\":\"628fda96b16b309c\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMinuteClock.js\":\"c3c5c3a1edd53fb0\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePanelLayoutProjection.js\":\"2dd0a09c1b6866b3\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePendingInvitations.js\":\"bc0a06515e23f0d9\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRendererRegistry.js\":\"71374d978e6090f6\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRetainedFieldRows.js\":\"409cb7dc755a761f\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useWorkspaces.js\":\"b7edc4127cc0c092\",\"/knowledge-medium/pr-preview/pr-1494/src/lib/utils.js\":\"419bbcd84421c1ca\",\"/knowledge-medium/pr-preview/pr-1494/src/main.js\":\"e95923218cb4a4f3\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/MarkdownImage.js\":\"647d9a746c05678b\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/blockSeparators.js\":\"8868615fafce1301\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/context.js\":\"b9164d775da35c5f\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/defaultMarkdownExtension.js\":\"bb9695e66cd92c51\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/extensions.js\":\"b1c61af0b28f1237\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/renderMarkdownHtml.js\":\"c2d77c90dbd817c4\",\"/knowledge-medium/pr-preview/pr-1494/src/minimal-editor.js\":\"082ac756c9c76abe\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/armedCut.js\":\"edc470a824f1f0cd\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/captureMediaVerb.js\":\"8895cf3cf15c20a5\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/clipboard.js\":\"981b0b8da86fd1db\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/decision.js\":\"dbef5f1d36ba4b20\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/operations.js\":\"bfc42a8836671386\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/AccountHeaderItem.js\":\"8451cc6342416db0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/index.js\":\"f1cfe8c85f009f71\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"69590c464b673fb3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askAgent.js\":\"9b1c76134d597cb9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askedStore.js\":\"125104c155603d17\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"43fe00d436fbbf0c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/chipState.js\":\"194c765c95a99a61\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/dataExtension.js\":\"18cbf3f7998186a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/index.js\":\"5b2796b5f07381d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b9a1b52d897d9b4d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/schema.js\":\"a21e080276b28a0a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/AgentTokensDialog.js\":\"aa2e0d156a4681b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e835d5e60652d1da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/addMedia.js\":\"e62da0106834b45f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/backlinks.js\":\"200cf37e3638f2b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/block.js\":\"005f4ac5be2cd275\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/context.js\":\"df2f441c22b2eb2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/displayIds.js\":\"65e61fd1928b11b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/index.js\":\"0c5e06a77df69290\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/outline.js\":\"d7bfb9166891e0f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/properties.js\":\"58e197b18b7530b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/refs.js\":\"4f38cac5b74588e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"45b44c6cb22a4bc6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/search.js\":\"ef6f4b1e73b69d38\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/shared.js\":\"115099d0a13cbbc7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c558f45a081976d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/text.js\":\"b0944ea0275b64a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentWrites.js\":\"4e30ca9f72362a4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/authoringCatalog.js\":\"54c568edb950da44\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/blockRefTargets.js\":\"8c0b673f9077be5e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridge.js\":\"5a2564ace1054741\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridgeLoop.js\":\"b2bbacf29c1e3056\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/changeHistory.js\":\"b9a21c0f4fe95ad1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commands.js\":\"ce7e7041309b56ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commentsCommands.js\":\"ba2bd90c245f3822\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataExtension.js\":\"3ad17f712bf0a643\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataModelGuide.js\":\"38630a0b1232f4b1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/describeRuntime.js\":\"d8a21ba3c3cd4a05\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/extensionLint.js\":\"e766ee126d4113ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/grainAudit.js\":\"b92da58faea6fc0d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/healthCommand.js\":\"aff978b152cc365b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/index.js\":\"56cfe3da34c6f295\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/presetIdentity.js\":\"e00d00f19db3ce86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"218c4a7950556438\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/readMedia.js\":\"11ebc1558a77de95\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/schema.js\":\"9cae8fa6cfd30c5d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/serialization.js\":\"62f940d7bf40f699\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/targets.js\":\"73379202947f9ec4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/tokens.js\":\"035c5b65fdc8c5cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/watchEvents.js\":\"e22e8fcf3c295143\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/workspaceGuard.js\":\"ccb056aa8e46e65e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/writeCommands.js\":\"603edc6bb901078a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/AliasCollisionToast.js\":\"f9c566a6dc8c713b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/DuplicateNameBanner.js\":\"8b96915f054d1803\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/collisionMerge.js\":\"6c7493c7ffe02266\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/dataExtension.js\":\"8512b7f676fbe665\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/index.js\":\"ab9ee00bbc738f54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/mergeCollisionAction.js\":\"46183efc49badc4c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/pageStyling.js\":\"29a4f738c7507e09\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/rejectionToast.js\":\"ac57416c7a5d6f72\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/syncProcessor.js\":\"0c895893cec0f842\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/actions.js\":\"8b31f45d1e8817ed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/addComment.js\":\"cd5d9f50f6f516f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchor.js\":\"ecd6e9a500ead46a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchorState.js\":\"d510c2842df2c706\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/commentLinks.js\":\"5d6f2ff94173e70a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/confirmThreadDeletion.js\":\"6a9602e802a45b78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/container.js\":\"c8bce2c4aaf3ea5e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/dataExtension.js\":\"159f12e1640ad0bb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/deleteComment.js\":\"83e36e57e0f85a35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/highlights.js\":\"a643e286bf12d09c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/index.js\":\"0541bb9eb8759e9b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/linkedCommentsPill.js\":\"54509fac749adc24\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/margin.js\":\"e4733b0635d1ed05\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/marginSchema.js\":\"9ffd2eba9cf67954\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/newComment.js\":\"b996714959c9fd45\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ownThreadPicker.js\":\"26593e12ae59b8bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/placement.js\":\"ddf76bf2dcdb362d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/queries.js\":\"8830509123805000\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotePosition.js\":\"1ba613215a2849a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedIn.js\":\"655b58821d019fc9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedRange.js\":\"7a180730beed1174\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/rangeRefs.js\":\"7e358105d77f9e30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readHighlights.js\":\"8b485ecebaa51130\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelection.js\":\"166a58b94a789001\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelectionUi.js\":\"dc8b5423f7f546fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/reanchor.js\":\"80c4e1e631dd6280\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/schema.js\":\"d7bf41503cd1f4f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scope.js\":\"536814b0cf45c46a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scopeThreads.js\":\"84b269a41981996d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/splitRetarget.js\":\"9f0ea4ef129cbf1f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestionCard.js\":\"d73af5aada9a561a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestions.js\":\"1bdcea19e067dd70\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaries.js\":\"a03df430795e37a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaryBatch.js\":\"b7c7efa10c258f18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/surface.js\":\"bc7054e2e99b3cd6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threadNavigation.js\":\"e50e31ca3a7e0f53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threads.js\":\"38358f913eb8d738\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ui.js\":\"4df0cda737a474f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/uiStore.js\":\"8b813090bce8f952\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/appIntents.js\":\"5b0cf45f9318e132\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/index.js\":\"a6037095db0e0380\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/index.js\":\"f6bc43ea5281b6d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/status.js\":\"b5e676002ce0c0bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"21085531b20f8431\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaBlockRenderer.js\":\"2604b324c952862e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2b534392325ddcd2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaUploadReconciler.js\":\"7e2c346b0f99b144\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetDownLane.js\":\"c563713bbf4fefdb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetResolver.js\":\"d0827776989de44f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetUpload.js\":\"90a1201412c8da4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/attachmentCleanerIO.js\":\"d52dc8859ccfae4d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/supabaseAuditIO.js\":\"80127273f079d267\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/blobStore.js\":\"35a1b2ad97517b8d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/byteStore.js\":\"0b258073d37a49b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanerIO.js\":\"35e94651be5d63cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanupAttachments.js\":\"aeb66d3c1fe94dce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/dataExtension.js\":\"5d6b05e3dae12677\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/downLane.js\":\"dc3cb78173194935\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/index.js\":\"9ff7f0998859f2f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/insertImageContribution.js\":\"a8b38433c2bc95f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneArming.js\":\"8880fe1ab21aa86f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneLock.js\":\"f21ce8291de62b29\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaBlock.js\":\"4d15a7a0f85f00ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaCapture.js\":\"6bed55c2446baf56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewers.js\":\"906d92795b9a9e1d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewersFacet.js\":\"c87e494d09e4c215\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/pasteCapture.js\":\"1c810818bc48f36f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/resolver.js\":\"cb4be59df1760204\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/retryUploadsAction.js\":\"213d7da57558c3ea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/storagePaths.js\":\"e2048969e1f95e4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadDrain.js\":\"5f62034bcf18c5b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadLaneStatus.js\":\"a16700f0b19699b1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadReconcile.js\":\"1feab41c89318b02\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadRecovery.js\":\"665b8018fab09451\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadStore.js\":\"4067cb2f9fb9535f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/useAssetObjectUrl.js\":\"24fa5e8690a208ab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8fab7f403fb4b70d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksViewSection.js\":\"dd867af2baf17709\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/facet.js\":\"71ac04421dc57059\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/index.js\":\"8ff150c03adbdec6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/prop.js\":\"60615deb39b195c2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinkFilters.js\":\"f783eebd76f94f0a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"60ff214757abdeba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BlockEntry.js\":\"c0b353fceebd5219\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/LinkedReferences.js\":\"7ee12def9c489c7f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cf9fca287d1ef66e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dailyNoteDefaults.js\":\"773abcc5410ffdff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dataExtension.js\":\"35c588ef82af108b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/edgeExclusions.js\":\"44417844ddb89a2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/filterProperty.js\":\"15509253bd36ed2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/index.js\":\"b1333bd882aedd3c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"23ac4c4306e9e836\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/applies.js\":\"7da065dbc7010082\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/countQuery.js\":\"7c9879328b024c8d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/expansionStore.js\":\"12c228d4aa50cf27\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/index.js\":\"6ddd22d3e854eb65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bcd2ab1bd0d7e16d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/presentationInvalidation.js\":\"1260dd21e3ecde20\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyEditorOverride.js\":\"5de354c7db14deb3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyFilter.js\":\"784b0e63ca7ff56f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/query.js\":\"bcc24c4dd01f6633\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/resolveFilter.js\":\"e860f0388d3bd931\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sourceBatch.js\":\"a4b95d5bc1d54178\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sources.js\":\"3036b566570af6e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useBacklinks.js\":\"385e2b6f29ae839a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c139fa484eb44390\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayCelebration.js\":\"9688fdfe808395b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayOverlay.js\":\"4ba938bd6ff4efee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/gate.js\":\"900258b5c3a5d6e5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/index.js\":\"d1e2f555d17a626a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/wolfTheme.js\":\"418a5f557ccc1a14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/BlockDragLayer.js\":\"592ed9a698c9fd6d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dragController.js\":\"556723e74c014398\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dropTarget.js\":\"303c9aca9f4a0c44\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/index.js\":\"1ae8302e19b1491d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/projection.js\":\"3324d06c037a5638\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/BlockMetaCard.js\":\"9d91cbef74a968a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/index.js\":\"186a30f877ffbad2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/AddTagDialog.js\":\"566d124f1656eb17\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3b6eb08f8a88bf26\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/TagNameIssueHint.js\":\"e7a9edbc603bf750\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/addTagAction.js\":\"0c6a1349063c3426\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/appendTag.js\":\"0bb24bd6e5a7541c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/config.js\":\"b9ab1c73651174e4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/dataExtension.js\":\"4f1a68f0503747c2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/index.js\":\"e662d4837984056d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/propertyEditorOverride.js\":\"6acda6d1f5e0c0d5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbList.js\":\"726cd3655f7cd424\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c917ea54db9ea9bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f65aa67e2667b3c8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"506a45ef40d500d5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6766ba4163a061a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/index.js\":\"b48f2e3620b2a5d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"35808f870c1db81b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/CharacterCountItem.js\":\"efdc4c8a6be35a13\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/ProfilePropertyEditor.js\":\"87e06e0795ec8677\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/actions.js\":\"6485ed31e11a895b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/blockType.js\":\"1574c3553f8954db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/charCount.js\":\"8bc6642cfda12e0b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/dataExtension.js\":\"5dc6f547b344f3c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/index.js\":\"a63d28e06a1a20d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/profiles.js\":\"ef475bf4b59b057f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/properties.js\":\"e0c09bd859041415\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/textCounts.js\":\"ca176cbd8a737dc3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/colemak-keybindings/index.js\":\"49829abde033812c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/CommandPalette.js\":\"9b7ada4ba245283f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/HeaderItem.js\":\"5957e1915164ee82\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/context.js\":\"a818c20b73607894\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/index.js\":\"fa9f5dedb578dbbd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/selection.js\":\"5a4d3ab7ced7813f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/toggleStore.js\":\"661026ac52017d40\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/useCommandPaletteActions.js\":\"f9c76a4430dbb7cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/ContributorBadges.js\":\"2ff72cb4ac20c29b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/author.js\":\"7738f4d7fbab70ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/codeMirrorExtensions.js\":\"75bf7d3825a899d5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/dataExtension.js\":\"005153636b0e7ad9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/index.js\":\"86c191379550ef54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/mentionAutocomplete.js\":\"2c983a5ca3be77d5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/processor.js\":\"3d51711b86009d8b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/profiles.js\":\"326e8f90289a8576\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/queries.js\":\"2fe8950b6734eeb8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/schema.js\":\"95f31cc97097670b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"479ec3c6e4b3f278\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c61f564a546c1e3a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/index.js\":\"4907678353cdf1af\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fa525d42482b21b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5ba3269f75afa343\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/CalendarGrid.js\":\"e9db1589eaa110c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DailyNotePicker.js\":\"73854411369ac490\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f5404c9cedc907cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateNavDecorator.js\":\"b08e89f92b32c2c5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateScrubOverlay.js\":\"516fd0e34268c9dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/HeaderItem.js\":\"e59891039b216ccf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/ReschedulePicker.js\":\"257a9744fc810464\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4edffcc6f5307fd7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/actions.js\":\"520d243eba8608eb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/blockDateAdapter.js\":\"219eaa6bc3306b1c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/calendar.js\":\"b5271e750de772a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dailyNotes.js\":\"460dc98acae39ad3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dataExtension.js\":\"ab49b87b4d1a6bce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubActions.js\":\"a8e8c0570c917a80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGesture.js\":\"73cf370e0a24e969\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bc0aa0ef05a621df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubRecognizer.js\":\"753a10d57e9034b5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/deletionGuard.js\":\"fcb7d5118e6449e5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dueQuery.js\":\"d6fd084c59de8e17\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/index.js\":\"dae3ed8fe2c77d54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/landing.js\":\"d82983c49802329a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/localSchema.js\":\"ab17c81f8344c7da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/referenceDateAdapter.js\":\"a454ccd20c44f8e2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/rescheduleAction.js\":\"f957ab0f7d2c886d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/schema.js\":\"464ea7ac7853f653\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadBlockDates.js\":\"7fbfe273d45cfa56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadDatesAction.js\":\"c517917fed7aa650\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/today.js\":\"7471b5dbd3126330\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ce17fa2e93e2787b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3eb59f76e02b0464\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/audit.js\":\"6abee3af4d3c87c7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditAction.js\":\"49b693b104be0929\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditRanges.js\":\"81fa016bc47cf34b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/diagnosticsSource.js\":\"a4f94a81623f8477\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/divergenceScan.js\":\"bdc6c1e2b0b6cd3e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/index.js\":\"50fb70c3feaea0e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f112d0ba69a1f2d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/referencesMirror.js\":\"390af980242bc10e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/rowJson.js\":\"545bd94d540d45c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/schedule.js\":\"20998c1caee83566\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/store.js\":\"adb7755a8ca74b8e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/action.js\":\"bb4acbd0de144491\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/index.js\":\"d42578809fae75c5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/plugin.js\":\"cababbb76e29eeaa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2b1f47587d2aa2a5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/actions.js\":\"62a9fe18ade13286\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/changeMarker.js\":\"b9528c22e44fd906\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/diagnostics.js\":\"f29f135ffb61d8d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/fileSystemAccess.js\":\"ebbd92b71ba002fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/filenames.js\":\"388686a3b0e40cf7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/index.js\":\"7f03f4edf0297d45\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/mirror.js\":\"60a7278ce06560ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runLock.js\":\"c2ae40aa8d5bfce2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runtimeHealth.js\":\"7e2a3a3722f78ce6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/schedule.js\":\"34fb7f3299c7210e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/store.js\":\"f394a104b1be5d5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/index.js\":\"004a4eb7f84a0b11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/themes.js\":\"0e47e7138b6d4b49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/facet.js\":\"28b0426bb45ab607\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/useDiagnostics.js\":\"88b2c87455245cf2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/dismissals.js\":\"5de6db603af1130d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/index.js\":\"b34bb2d883e284c5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/status.js\":\"4395d024d213a7c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/store.js\":\"b5ae014b85ae5ac0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"92259a53530f7bac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a515253430fd6ce2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/actions.js\":\"f9a816909b5d9c65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/config.js\":\"a92809ecd026c741\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/dataExtension.js\":\"6932a7b9b3dfae3d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/effect.js\":\"fc87fa0f37c712c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/index.js\":\"f75355fa3d77a7ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2eaf8d83ed0d9666\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/useToggleTree.js\":\"7f3385ea3e7eb6d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/ExtractTypeDialog.js\":\"429296920cc496f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"863d6ad21d705404\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/PropertyShapePicker.js\":\"6ef1f2f1393272e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/action.js\":\"206690ac3056da30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/index.js\":\"04b0a5aa59257ebf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/FindReplaceDialog.js\":\"a8f93c61da65c18a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/HeaderItem.js\":\"475607ccb6a90fbc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/dataExtension.js\":\"51bb1abc5350db06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/index.js\":\"bdbd68b6f3794ab3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/search.js\":\"36b7956a755da468\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/toggleStore.js\":\"7018aff6161f0115\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/LocationPropertyEditor.js\":\"9535cb82d7c5359b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/MapView.js\":\"c0c1eea2411fd683\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/blockTypes.js\":\"2b45ba27bc7f8ec0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/codeMirrorExtensions.js\":\"0aeb76645c5b642e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/createOrFindPlace.js\":\"76705e934dab9d7f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/currentLocation.js\":\"37e039e9d2069e91\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/dataExtension.js\":\"e153ed5179dff808\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/geoContentDecorator.js\":\"4016f2c4da4051da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/googlePlacesClient.js\":\"fc3010079b0ebf3c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/index.js\":\"6073575bad0a0a10\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/locationsPage.js\":\"b1db4f8781df3417\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/mapViewport.js\":\"df0fd7f96408e877\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/pickCurrentLocation.js\":\"3d33072c46bc8a41\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeAutocomplete.js\":\"214cd9dbdb0909c1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeNameCollision.js\":\"10f024d26b1e1bc9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/properties.js\":\"2a1c07dffe55eb86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/propertyEditorOverrides.js\":\"596b9ca4bc4f9f55\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/query.js\":\"f097243c9999f9d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/usePlaceSearch.js\":\"9deac4b8b5ec06a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ef57557bde19b904\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7b43e8378543ce74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a0c70a7b2078c46a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/config.js\":\"90251d995e42c445\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/dataExtension.js\":\"45d1afa4489ee1b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/facet.js\":\"46a0e379e9ca5a49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/grouping.js\":\"b586ccc77dc66744\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/index.js\":\"120c73da4e0bf536\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a545c92a32f82b6e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/query.js\":\"3f68adbe400b1579\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/resolveConfig.js\":\"da5d31bb84c7833a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6aff7f9b347c0321\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7847e90fa821efbc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlDocumentContent.js\":\"463807525cc58b04\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlFrame.js\":\"4e349091b312f2d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/actions.js\":\"468127fb7febf9a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/blockType.js\":\"ee647254650cb991\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/confirmRunScripts.js\":\"10813312be2030ed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/dataExtension.js\":\"ed5addecf49ce385\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameAnnotations.js\":\"e498e0d3ce8ed895\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameDocument.js\":\"04dcdbedc6549692\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameTheme.js\":\"812ed36474a189d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/index.js\":\"6802d51da827833b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/scriptConsent.js\":\"e124923106a948a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/sourceMap.js\":\"433b68f49d2ed77e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/useDocumentScripts.js\":\"110d62327a9b53ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/index.js\":\"32e84104e8f43d17\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/record.js\":\"b7156aa76b735709\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/recordStore.js\":\"19aacfd57e0b32cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/responsiveness.js\":\"f7fa3455e16eb4d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/schedule.js\":\"a074d17510581145\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/sessionContext.js\":\"6f85648a87a5acd1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0f4c40d9b5602b14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"09f8396d9ada2c5b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/actions.js\":\"e7d3bfb422417632\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/config.js\":\"88f143d923d65d53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/dataExtension.js\":\"16c6407d5a2d750d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/effect.js\":\"da7e2d0bbad684a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/index.js\":\"8839f2bcbaca3940\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/keyCapture.js\":\"67d727d024fb342f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/overrideStore.js\":\"5a17639f4359b17b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"931b4102938a029d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/HeaderItem.js\":\"ced33352fca6531e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/LeftSidebar.js\":\"b9eb2539440e31f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/actions.js\":\"58263f09b3c1240f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/facet.js\":\"411b7d0f5d5b1b8e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/index.js\":\"2da0ea7da168e972\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/shortcuts.js\":\"60b4d9dd553c6df1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/toggleStore.js\":\"96dddc7282d797ed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/MergePicker.js\":\"c8736f2c87166902\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/index.js\":\"d7b5a406918ad0b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/mergeAction.js\":\"49b054293e7c793d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/strategy.js\":\"d43217812992fba5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/Button.js\":\"8b4b2d2c5fa203f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"cb16b15b79a94a8a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9d3496c92bb456ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/facet.js\":\"34fc6099308f4738\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/index.js\":\"cc7930499f4850ea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ed0c864341f8e977\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/actions.js\":\"23a7f72ebdcd08e2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c715138255366ab8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7c05902d90425734\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/index.js\":\"8de20305bd96dfd7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/MoveDestinationPicker.js\":\"eeff3d1030f71514\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2af50c8e9f78ae18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/contextMenuItem.js\":\"0e31d36b11d75a53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/index.js\":\"309290f88df9cd13\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveAction.js\":\"757c8c70e07a0ee5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveBlocks.js\":\"1f0bff13481b026d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/selectionAfterMove.js\":\"cbd8b0e375ca22cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/TutorialBanner.js\":\"e09419ee944b0f0b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/action.js\":\"08365bf072d0a87b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/bannerDismissal.js\":\"30996ef05ff22fd2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/documents/cheatSheet.js\":\"0ed4fc80e050b2ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/index.js\":\"6b9b8a1a07135e07\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/keys.js\":\"75d32ee87ff4bd95\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/landing.js\":\"ae1622c2c60ee0b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/outline.js\":\"34716fcb5f17460a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/seed.js\":\"7b97f7bc3c9f35ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f40b48da57a8ba9e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/analyze.js\":\"bdc7ac3a349aab61\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/diagnosticsSource.js\":\"6c258591cee74bc3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/index.js\":\"7e684fdd6014054d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/load.js\":\"3127225fa770fa43\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/monitorRun.js\":\"8ccc46aec09e8897\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/schedule.js\":\"6e41a9e8a26eab10\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/series.js\":\"5e4b9fd181e42646\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/store.js\":\"a287dcd19c5f165b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/trendAction.js\":\"dff4da0a625eaa7b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/verdict.js\":\"e8dc58af462387b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/clickToEditAction.js\":\"334432a5b271f98f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/index.js\":\"54accebe9cf0afb4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/interactions.js\":\"e34c5cad25f97b81\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d1cf234a59d0db56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGate.js\":\"6e9427cd0c01ed5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGateDialog.js\":\"9c810af92119caea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/action.js\":\"582156dd616ef1ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/index.js\":\"3fd09bbb0498cbc1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/localRunMessage.js\":\"10bc19bf8ac48af8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/plugin.js\":\"881066a3e3361780\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/progressReport.js\":\"b79508a4761800c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/sweepProgress.js\":\"7c73e6bfcd9270e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/FieldRowRenderer.js\":\"71df5dffda8141e4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/ValueRowRenderer.js\":\"f56d1c7e3fd5bedd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/actions.js\":\"be72903a0b90a50c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/autocomplete.js\":\"2b0b3f130d2742bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/fieldRow.js\":\"8f144694b5cc9afb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/index.js\":\"b366a7948acce31e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/referenceWarning.js\":\"7ebd5fda4c07ea36\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueAutocomplete.js\":\"0a180f5c7820d0fe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueSchema.js\":\"6c3295933f5f6e69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/HeaderItem.js\":\"e8827c8621c67f49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/QuickFind.js\":\"b97531b27a4b1f11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/index.js\":\"04e2284d964ab1b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/recents.js\":\"7ea77cfabefc2c7c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/resultItems.js\":\"bdf04d7026f581d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/selection.js\":\"a4d46a990fd2c280\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/toggleStore.js\":\"b2effb116f3436ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/HeaderItem.js\":\"f2deb075be1e4dd3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2cae553dbd067877\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/grouping.js\":\"6039a5b0d86df0a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/index.js\":\"1d054210a40bd402\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/target.js\":\"5a4d7609164d432f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/codeMirrorExtensions.js\":\"3cd1c8e52ba9dae0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/contentPrefill.js\":\"cd3f925593247f43\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/dataExtension.js\":\"3e64c2017e5dab53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/index.js\":\"53084a279f3ee20b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e59927b3ff12d1b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/invalidation.js\":\"62624b113f113a91\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/localSchema.js\":\"68f595e4aeec7cc0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/index.js\":\"7cca489ca661f70a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b7e8934f43f4b654\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/index.js\":\"405b6385c4d6c7a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/referenceNode.js\":\"8300bc49438368c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fa0e662e56f02504\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"90eec5ac98624325\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/index.js\":\"a4c97c56028bb998\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b7defeae0d2ff212\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"393004d20d243abc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/mergeRetargetProcessor.js\":\"61b252126b6f76ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/parseFence.js\":\"c6aa88ae2dacc653\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceParser.js\":\"787778d2821722fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceProjection.js\":\"b478cbfc0f354fc0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referencesProcessor.js\":\"338ecb310039268c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/renameProcessor.js\":\"e408cef718878f4f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/spanReplacement.js\":\"67745601796e07dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/htmlToOutline.js\":\"3f2a21bb0d59a006\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/index.js\":\"e1f0f4b1546bf4db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fb4498750bc11cb9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/pasteDecision.js\":\"3694b4d654a89257\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/action.js\":\"7178216420517399\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/blockIds.js\":\"f9aa955033054dc7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/content.js\":\"605e220ce8826983\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/effect.js\":\"1c96342198e04106\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/ids.js\":\"eb902e00be57520c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/import.js\":\"d2ffa0e3e6df66f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/index.js\":\"b95be59d3ce4dc4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plan.js\":\"f10408ef1f0a6d8d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plugin.js\":\"0df546a67ceb3c59\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/promotion.js\":\"99f9a11693deef4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/properties.js\":\"052150533435f147\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/references.js\":\"3aaf331f60082c29\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/report.js\":\"4bd8a0fa195e8fc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/roamMemo.js\":\"6d1a421c904265ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/runtime.js\":\"290ecd0d489d94f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/schemaReconciliation.js\":\"756d524d149b6e43\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/srsMarkers.js\":\"4ba863ab404eeddb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/todo.js\":\"9bca84aa4c0b80a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/typeCandidates.js\":\"aaf405668ad3846a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/types.js\":\"18cac49abdcf94a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/index.js\":\"b2d0c6b3f2ca4f50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/store.js\":\"386aca5636df72e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/HeaderItem.js\":\"d47d22afdec37550\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9497d7f7e7c900f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/index.js\":\"dc08a77938059e25\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/model.js\":\"11f39c06ec7d861e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/toggleStore.js\":\"0bc9898d42139974\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/useKeyInspector.js\":\"6edbae1d0aa7554f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8d9780dad5551e9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/ShellDecorator.js\":\"f7e366117685c0fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/actions.js\":\"4495c967818e8736\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7eea83a866e36e69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/index.js\":\"3714a18a21af8523\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/shell.js\":\"056e29a504a112cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/surface.js\":\"b0679f24fb13bf97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/walker.js\":\"696f02d86fdcce76\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d7f94522c2fc8ab2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/dataExtension.js\":\"374a6cf8a9d8896e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/index.js\":\"6ef1db35d7a75fb3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/indicator.js\":\"1f2584c7fadb667f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/moveSrsState.js\":\"787d93c00d80af58\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1f2d248cf118c769\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/scheduler.js\":\"a491d6fb152e7397\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/schema.js\":\"786f0b81cf2a0a21\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ff0ed2229e7db1d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsClipboard.js\":\"8ed23a92d049546d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"314acecfabff98ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DailyNoteReviewHint.js\":\"913ccda73f86133c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DeckPicker.js\":\"479a4fb4aa903f7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewControls.js\":\"d299e210d02632c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewDeckRenderer.js\":\"42da0046b26fc015\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewSession.js\":\"20aeb44883a65fbc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/actions.js\":\"671dd3355e04f6dd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/archive.js\":\"95ff8777d85175f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dataExtension.js\":\"83bf520d60ef9d84\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/deck.js\":\"3d648232d081739e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dueQuery.js\":\"c3a686010a6420ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/gradeDecision.js\":\"2d4bd2dbd22a220e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/index.js\":\"6d5a1549b2c72a2c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/keyHints.js\":\"cb23f4112737f6d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewCardLayout.js\":\"77dfa8683c8d8f48\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewProgress.js\":\"e8f575c31aaed72c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/schema.js\":\"887e97c07e03a034\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/useDueCards.js\":\"6d626ec6dfded0ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/index.js\":\"f44b938c1dadfab1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/record.js\":\"ed5e49967806dd65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/index.js\":\"289a4198093026b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/persistenceStatus.js\":\"457c40bc6ae9d27c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/requestAction.js\":\"5c3a8147f6d518da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/TypeChipsDecorator.js\":\"962b615b10288f38\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/codeMirrorExtensions.js\":\"03a58dd8106cc156\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/index.js\":\"b0dbefd492f594e5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/typeAutocomplete.js\":\"0f2bc523fa8523d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"cdae925358e48c6c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/actions.js\":\"b617e44b33600aa0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/anchor.js\":\"7dfba6f5612dfed1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/events.js\":\"4f625f1972818023\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/gestureActions.js\":\"3f2937c487cafb97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/index.js\":\"44d0ab5824fc734b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0fb4d4d864a481ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/collect.js\":\"1e4e89148721547e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/index.js\":\"9845472125a499ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/record.js\":\"be4f0ab124bb7ad8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/RejectionDialog.js\":\"83648f2337db65c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c1316cecc63989d5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/index.js\":\"6b07b00159a5c851\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/model.js\":\"bd3e4673e2a78ea9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/queueCounts.js\":\"01f85d99be349a00\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rejectedHelpers.js\":\"ae3a6e658a7ce98d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rematerializeAction.js\":\"3b1a2caefe1d98c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/useHysteresis.js\":\"657136b25a6d6a85\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/ColumnHeaders.js\":\"fc54a1a128ae1ce4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/QueryUi.js\":\"b45eb5ac57bb0121\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/TableLayout.js\":\"3d87c64118039a26\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/actions.js\":\"0120cbe09b349ec7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/cellEdits.js\":\"95a18588795692e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/columns.js\":\"01cfec3f5ffdc68e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/controller.js\":\"2ba0c1f96f6674bc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/convert.js\":\"3e29d15c7d41ba94\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/dataExtension.js\":\"b3664ac14bbd1b44\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/index.js\":\"412d9d2f4a878d86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/keys.js\":\"46c8f623d599f4d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/model.js\":\"ca4243d420f60a4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/navigation.js\":\"3507e0daaa5e21c5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/backfill.js\":\"7fed8d4518441d34\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/format.js\":\"bcd68b88772290f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/parse.js\":\"bbe710804cbc6200\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/queryValue.js\":\"8f2423820a64eb50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/source.js\":\"51ce6a72622ec16c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/registry.js\":\"8e361450c6ff2591\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowGutter.js\":\"3371f89f9de2f38c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowVerbs.js\":\"e813bd3c9404fb20\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/schema.js\":\"87e07f5e4c9531ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/sort.js\":\"fdcc25d023c6bab3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/effect.js\":\"582e8dd1dac229cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/index.js\":\"489d68f979827ceb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/theme.js\":\"1f31e11a8c254757\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/actions.js\":\"57df2bcbe2375095\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/dataExtension.js\":\"354285c1cd7085bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/index.js\":\"2957abfd9f66ccac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/schema.js\":\"b616932630ce693f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/TouchSelectionLayer.js\":\"aa1fa19692e5a89a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/actions.js\":\"bc724171d08f6bb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/defaultItems.js\":\"7e4f8226e267ab06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/facet.js\":\"9b60dc623ffc88b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/holdRecognizer.js\":\"43bd27592abe97f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/index.js\":\"514a15c2fbc85cf2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/UpdateIndicator.js\":\"800d2553837fb224\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/index.js\":\"f37c31193adbbaf0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/loadTimes.js\":\"0febf1413beda5e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoNotesRenderer.js\":\"37f1ac30d5fe7cce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoPlayerRenderer.js\":\"f6709abae5132150\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoTimeStamp.js\":\"bf964adc6e82cc26\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/actions.js\":\"9da2aa17cda0bc65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/index.js\":\"e851f3b5365bb662\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/markdown.js\":\"402b28ce018d44a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/notes.js\":\"fd4a396bc2fe7306\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/registry.js\":\"bb9e2f73a1d50cb4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/remark-timestamps.js\":\"39d105a8fdcd1cea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/view.js\":\"1d0616cbde09cd44\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/LinkHints.js\":\"8266eed9f7cd15f8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/index.js\":\"8b094541591d4142\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/model.js\":\"882d0e9058993084\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/settings.js\":\"7c7314518cc6e8d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/actions.js\":\"88b26a3d4922a4e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/index.js\":\"b6239006a08051a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/interactions.js\":\"93e4ef39058b6320\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/workspace-header/index.js\":\"483ec86278b664a2\",\"/knowledge-medium/pr-preview/pr-1494/src/registerServiceWorker.js\":\"19bf773212d16406\",\"/knowledge-medium/pr-preview/pr-1494/src/requestPersistentStorage.js\":\"bb04ed6699ec5702\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authRequestDeadline.js\":\"5e4bdbdeae9d0bae\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authStorage.js\":\"9254bbedd4f620a7\",\"/knowledge-medium/pr-preview/pr-1494/src/services/powersync.js\":\"ada8fad53cb62ed6\",\"/knowledge-medium/pr-preview/pr-1494/src/services/supabase.js\":\"217b332eea01e6eb\",\"/knowledge-medium/pr-preview/pr-1494/src/services/uploadErrorClassifier.js\":\"b99f37cb98f205dc\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/ActiveContexts.js\":\"01a5b61de8aca57b\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/HotkeyReconciler.js\":\"38057d8d9e4fd4ad\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/WipeLocalDataDialog.js\":\"ee28f5367270ad52\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionDispatch.js\":\"f7be57ffb89c28b9\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionRefItems.js\":\"df8e23789150f191\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/applyKeybindingOverrides.js\":\"eacb83f4acf07fae\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockActions.js\":\"2c80e16a1b14bca2\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockMergeGesture.js\":\"9973da03564dad53\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/canonicalizeChord.js\":\"0e001d2bc320d451\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultContexts.js\":\"9f9d25a5427b6398\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultShortcuts.js\":\"cd85ad2c528809e7\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/effectiveActions.js\":\"965b3a7369f4bae7\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureAction.js\":\"7b40ea71a57b100e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureBinding.js\":\"35c73465f75bc6e1\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/holdRegistry.js\":\"9d54c8958adc4ea6\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingConflicts.js\":\"7eb8b46d8af718a0\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingOverrides.js\":\"58eb9e5e84baa29c\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/pointerAction.js\":\"859383222a5533d3\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/resolve.js\":\"81af6aa43f117b4e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/runAction.js\":\"23a5b01e700363ad\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/sequenceMatcher.js\":\"041f325bf0cc6024\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/types.js\":\"ee64e5032b4d9458\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionContext.js\":\"6e7f0945fda3b4c2\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionDiscovery.js\":\"6e38103e823f7013\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/utils.js\":\"d645b098bed38c59\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/bootStore.js\":\"3a538c37d28ef3c5\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/previewDatabases.js\":\"a4a407fc9f5cf9bc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/byteTransform.js\":\"1bb9fd82e4c18421\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/attachmentCleaner.js\":\"1aea71132addf562\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/attachmentParts.js\":\"ad0198206ff5fada\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleParts.js\":\"ebab0a0db424ce62\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleRecord.js\":\"0ac625c77972ed7d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/manifest.js\":\"230d9febb730f3a1\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/takeBundle.js\":\"fbdcff1b5f9e97d3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/verifyBundle.js\":\"6900a547cb5e71be\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/cleaningStage.js\":\"35fbc5a593ab8288\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionKey.js\":\"959e07e217d84fce\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionServer.js\":\"675643d696269f79\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flip.js\":\"3d4b142562900357\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flipAttempts.js\":\"414c7b861cf65e9b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/pages.js\":\"0fac6b05f3f6a01b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/preflight.js\":\"d575918a1ba159b3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/reseal.js\":\"cb7928fb0dd7baf5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runConversion.js\":\"dcb1ae76d83445fc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runLock.js\":\"d413bceadef8570b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealing.js\":\"2c2274e0f6d3608c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealingStage.js\":\"bbf938b6abe40220\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/stage.js\":\"5b2295adee1092cb\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/verifyReseal.js\":\"a19830a4171d744a\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aad.js\":\"5ebf7399603898f9\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aead.js\":\"b0bfdf67e949d1f3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base32.js\":\"60884a4ba790c22e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base64url.js\":\"ea335000516b2fb4\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/binaryEnvelope.js\":\"9202ed3192559001\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/byteAead.js\":\"2848945ee2cf94dd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/canary.js\":\"5579ba9519d6e1a4\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentHash.js\":\"ad7c042ccbc33e28\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentKey.js\":\"6f952c80ed106782\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/derivedIdNamespace.js\":\"8c758106fa6ff903\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/envelope.js\":\"d741fe190ed489de\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/hex.js\":\"85e46ec5be59c542\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/sha256Hex.js\":\"ca416f5d0afcf105\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/workspaceKey.js\":\"0922d50da0704101\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/conversionState.js\":\"b47f0077aba3995c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e01320f92a315c87\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/pastedKey.js\":\"6f447a877ff6a8d2\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bb3be3e364539109\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2cf565323a92f27e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/keyStore.js\":\"ddb295af2c1e0c13\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/mintWorkspaceKey.js\":\"f44409c84361763a\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/modePin.js\":\"47e5a1ef44e279ec\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/openWorkspaceKeys.js\":\"41f0b4b147d6ab67\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolveWorkspaceEntry.js\":\"b5c284a773878897\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolver.js\":\"522735bb7d31602e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/workspaceAccess.js\":\"139b87340d387ff4\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/transform.js\":\"eb8d8405b111f255\",\"/knowledge-medium/pr-preview/pr-1494/src/themeBootDefaults.js\":\"df94efc9f712741c\",\"/knowledge-medium/pr-preview/pr-1494/src/types.js\":\"dd0148a09ccbcef3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/ClientLocalSettings.js\":\"33951e7f404e940f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/abortableSleep.js\":\"d8cc8030add2694c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/array.js\":\"21fdbb9698db2b0d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/backlinkAutocomplete.js\":\"ee87dca47650ea3d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockCrumbs.js\":\"715027a81f733ec9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockrefAutocomplete.js\":\"a6c30c556a4f80c1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/cadencedIdleJob.js\":\"dcad59406df52cde\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/callbackSet.js\":\"18da9788b9e71c0e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/clientId.js\":\"30981c4e1a9543c0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirror.js\":\"7fa980060200e723\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirrorCompletion.js\":\"aa16fb4828a24d8e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/copy.js\":\"c9bc068551ff581a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dailyPage.js\":\"e5860ac7b48fef55\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensics.js\":\"8416e896e5fc08ec\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensicsHooks.js\":\"92cd727c78ad8c26\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/deleteBlockThroughUi.js\":\"eafd08be25c68896\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dialogs.js\":\"248cee7ef5ccd2a1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dom.js\":\"7f7ffd69cfa3d389\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/downloadBlob.js\":\"e620eb01273b214b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/exportSqliteDb.js\":\"4d8f1e7eb93355d8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fileSystemAccess.js\":\"f9df9735005361e1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/flipSlide.js\":\"12dc392e868c166e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fnv1a.js\":\"d0470199788b2ab8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/formatBytes.js\":\"60f5a63c43294fa4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fuzzyRank.js\":\"0beda52d63049ad0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idbKeyedStore.js\":\"ef421fb59d49be30\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idleCallbackPolyfill.js\":\"f5c1fc4e8dedb923\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardAwareScroll.js\":\"5fe3eceeaba83aa9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardViewport.js\":\"7f5d0f22204ccb79\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/lastWorkspace.js\":\"37543f0e6e088388\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutColumns.js\":\"23290419da2b46c7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionDom.js\":\"5ef7720d37d601e9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionId.js\":\"55b36934022eddcb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkClickGestures.js\":\"df15574034fedd57\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkTargetAutocomplete.js\":\"b5e8995ab5a2fa0c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbCorruption.js\":\"db9c293a29e7e2a8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbRecovery.js\":\"af20cb2d34559b73\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/markdownParser.js\":\"057558f433eedeee\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/memoize.js\":\"5764420037498a46\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameFieldCommit.js\":\"fb3acc16cc466e1f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameList.js\":\"af11f4386874e626\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/navigation.js\":\"f1935d6381a9f4e0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/omnilinerNamespace.js\":\"bdf5b2fd9444a8ce\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/opfsPageScan.js\":\"c3afad650af417a3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelClearance.js\":\"b14b8e0cb605f0ed\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelHistory.js\":\"ac7c0f060791a895\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLanes.js\":\"a98d2dee57753ccd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLayoutProjection.js\":\"8107e95b91a4a2cb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelScrollAnchor.js\":\"52cab88d119dade8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelUrlFlags.js\":\"7cf036fb7ad1a077\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/platform.js\":\"17f9718d37deed9f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/pluralize.js\":\"6fe95c5ec1fe4fe9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyCreation.js\":\"9404d2bc150cd3ec\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyNavigation.js\":\"85ee3c75fb663fc4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyValueContext.js\":\"f285285bb9b9ed08\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/react.js\":\"46342049395b5dca\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeDate.js\":\"d0cec69d30e3dda6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeTime.js\":\"bfade8f3427dff29\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/renderScope.js\":\"1ecfbf3a21b3d57f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/resolvedThenable.js\":\"23df23c11d528242\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/routing.js\":\"44b25032cc4c6ffb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/safeMode.js\":\"d0fe26ad113ff851\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/scheduleIdle.js\":\"c1fa87de7ffe739a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/screenWakeLock.js\":\"02f16badc13bf00b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/selection.js\":\"f7485d6d8efe688f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/softKeyboardGrab.js\":\"230ec80ca359e559\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/startupTimeline.js\":\"86400d3b56151769\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/state.js\":\"a08879cfed4297f2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/string.js\":\"0442185ef0abd3bf\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/surfaceZoom.js\":\"1dfc648d127c1cab\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/time.js\":\"122eeb2db8fdc2eb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toast.js\":\"a1ade8e3e6c91970\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toggleStore.js\":\"99c288249488c65e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/untilStopped.js\":\"df9c371f5de7629f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/userActivity.js\":\"7e307588e25144cc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewTransition.js\":\"ce06ffe6d0aed601\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewport.js\":\"7a88eda400e614b0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/webLock.js\":\"55425df7d10222e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceRecovery.js\":\"cef6dc155060f920\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceSnapshotStore.js\":\"8ba30be898834b22\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-compiler-runtime.js\":\"83657e7bfdfca516\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-client.js\":\"95a80ea727f2f069\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server-edge.js\":\"32f083cba575fad2\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server.js\":\"3b201bc2f82143c1\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static-edge.js\":\"30331af648b43074\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static.js\":\"73bb55b98e7c0bfa\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-test-utils.js\":\"0307d71b706a9011\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom.js\":\"acaffe9f3ff2818a\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-runtime.js\":\"d376e372f7b43e15\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react.js\":\"4e0902b92f53e24f\",\"/knowledge-medium/pr-preview/pr-1494/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
