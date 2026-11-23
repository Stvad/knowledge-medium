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
		buildId: "4619e8abf237-8997435b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/\":\"6a955cc1e1d5f8e7\",\"/knowledge-medium/pr-preview/pr-1494/index.html\":\"6a955cc1e1d5f8e7\",\"/knowledge-medium/pr-preview/pr-1494/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1494/assets/FacadeVFS-DDzDoXQb.js\":\"88fb3b82c8f4be76\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSCoopSyncVFS-D6fh1LJ-.js\":\"15272f3165e9553d\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSWriteAheadVFS-BdXFnIdy.js\":\"12d7759f9ba21da5\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-BuYG0Vu4.js\":\"9aef91e3b228c1fa\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-DMahT6nB.js\":\"5a8713cc2d77d753\",\"/knowledge-medium/pr-preview/pr-1494/assets/worker-DruwuQVf.js\":\"558d3c84ce58be64\",\"/knowledge-medium/pr-preview/pr-1494/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1494/chunks/app-BfZp2UIG.js\":\"5a1fa6a60bb2dd02\",\"/knowledge-medium/pr-preview/pr-1494/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1494/index.js\":\"48a0714ac2646357\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1494/assets/AccessHandlePoolVFS-czjKvoK8.js\":\"4c6f78150b31ddf5\",\"/knowledge-medium/pr-preview/pr-1494/assets/IDBBatchAtomicVFS-BPlA0-Jt.js\":\"e37f03300ccae2ec\",\"/knowledge-medium/pr-preview/pr-1494/assets/MemoryVFS-BvB6_Ih_.js\":\"f8579640e18927a0\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-BCzro9hp.js\":\"e7cd9ce1b0552bad\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-DM7tM7bE.js\":\"6d3f0f51f90af024\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1494/chunks/AccessHandlePoolVFS-CcQS-415.js\":\"679842f5358baf30\",\"/knowledge-medium/pr-preview/pr-1494/chunks/FacadeVFS-D8AZ2SyY.js\":\"ff740a3ba484af88\",\"/knowledge-medium/pr-preview/pr-1494/chunks/IDBBatchAtomicVFS-BwWXbnv8.js\":\"548afa9103090e76\",\"/knowledge-medium/pr-preview/pr-1494/chunks/MemoryVFS-DdcnFoKw.js\":\"2fcf697e8f0fca25\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSCoopSyncVFS-BGy4ACYh.js\":\"92a0dcbd4ad985c6\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSWriteAheadVFS-_BrU2c_4.js\":\"f40cd6b7f7391fa8\",\"/knowledge-medium/pr-preview/pr-1494/chunks/Preview-C3JxJeIP.js\":\"d06c5c73777f0f9b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1494/chunks/card-cw-ctcmZ.js\":\"9bdbb561f5ba2c63\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-DBDDLRGr.js\":\"c63fde75dc24e6f0\",\"/knowledge-medium/pr-preview/pr-1494/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-CceK_Fdb.js\":\"ed404cb6b108b360\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-async-CwkRYy2M.js\":\"a131ede70603fa7b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-B-2DOixG.js\":\"d47cadcc34bfbcab\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-C2CjzvLT.js\":\"02e2fe5b11ab9e26\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-D7KJPLkh.js\":\"b4c4df0db0863396\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DBFZzOU_.js\":\"d6f5ee5241e39008\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DDej45-f.js\":\"f4a833591d90cee4\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DIWMApBU.js\":\"96d49ca479bee1f6\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DROeTqQb.js\":\"7c12b930f5d15873\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-U7vQ8mEt.js\":\"0ce434773b063628\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server-legacy.browser.production-Bh4oDiUV.js\":\"ff02d55d319a796d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.browser.production-DPVC4nJO.js\":\"3836dbb6a0ec810f\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.edge.production-Buqd9hid.js\":\"810ea2c54f60a5ba\",\"/knowledge-medium/pr-preview/pr-1494/chunks/server.browser-BOejKP9i.js\":\"fe941d18dafd7b90\",\"/knowledge-medium/pr-preview/pr-1494/chunks/textarea-BPNQtjeT.js\":\"0d1e0c3084da93e4\",\"/knowledge-medium/pr-preview/pr-1494/chunks/ui-pPi3Cu_f.js\":\"90bd1013ea4ea895\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-I6WDVGPA.js\":\"7c32fc4ed5607a2d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-async-YGB7qMsX.js\":\"6ee122600e960138\",\"/knowledge-medium/pr-preview/pr-1494/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1494/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/src/App.js\":\"e5e68aba6cc4f0c7\",\"/knowledge-medium/pr-preview/pr-1494/src/appUpdate.js\":\"9ba669f628e49975\",\"/knowledge-medium/pr-preview/pr-1494/src/appVersion.js\":\"dc9df2da04dfa549\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/initialLayout.js\":\"0263cab96715889f\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/openWorkspaceData.js\":\"d7e960f73adc4d69\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/resolveWorkspace.js\":\"bb62ca013ecd7b6d\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/workspaceBootstrap.js\":\"1020ff45fec9114b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockComponent.js\":\"4c37b7502269733a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockCrumbs.js\":\"a4d2a69549790ae6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockEditor.js\":\"20517a8cc6129c22\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockLoadingPlaceholder.js\":\"3b2ba256c9f9bf4c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockProperties.js\":\"68eaedfccc064d3e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockSearchPicker.js\":\"138eee9b15e5036f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ConfirmBulkDeleteDialog.js\":\"d98a27c14fd8f762\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DividerHandle.js\":\"ebb7a709b04006cb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DraftEditor.js\":\"f0cac76a55065b9b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/GutterPill.js\":\"8fa860837772a01f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Header.js\":\"c0b06102c7156c8f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/LazyBlockComponent.js\":\"22dab0503a4e2cc4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Login.js\":\"9c4fee1b7331b2fd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ZoomableSurface.js\":\"f6639d609db12f77\",\"/knowledge-medium/pr-preview/pr-1494/src/components/editModeKeepalive.js\":\"22ffa03300b0f29a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyDisplay/PropertyDisplayScope.js\":\"60e409d6d9bcd567\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f1564b95dc4b4b66\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefPropertyEditor.js\":\"b2cb3e94a949bfe3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefTargetTypePicker.js\":\"1682c10ec798257c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/SelectPropertyEditor.js\":\"3e559f0512a8a9ba\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/TypesPropertyEditor.js\":\"daef31f1a133a9c9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/defaults.js\":\"f431c3ace79791a6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/kernelValuePresets.js\":\"7b538e932c412c30\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/selectablePresets.js\":\"15990b6852166c7d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/typesPropertyUi.js\":\"9f069c02cfff114b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/AddPropertyForm.js\":\"a1dc5d8b7358a7ab\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyPicker.js\":\"5900f448349ecd39\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyRow.js\":\"a76f362f692ed81c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/Rows.js\":\"e456c46f8c602ce6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/actions.js\":\"197f80f1918fa5c5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/declarationOnly.js\":\"e10e88bc69e5a395\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/layout.js\":\"4f3e04893c9a2397\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/model.js\":\"b79586a6d9735c2a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapeUi.js\":\"67b10954c61c578c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapes.js\":\"113c3925662e5c66\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/usePropertyEditingActivation.js\":\"915b978690e4ede8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/visibility.js\":\"ea487b1f2c2940ce\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanelSections.js\":\"4bd7006dc94f7b7b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockEmbed.js\":\"bf8ffbabb14ff4c4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockLink.js\":\"880f22c39a815170\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockRef.js\":\"c29b0a177b4ba3ec\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/ReferenceLink.js\":\"657d5c26529e5316\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuard.js\":\"60965e3358d708ca\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuardContext.js\":\"a3ebbc5e29169976\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/linkInteraction.js\":\"9353aa2f9253d5df\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/referenceLayout.js\":\"15f6e20df7a1c627\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/useBlockRefAncestors.js\":\"327e7ea8441064c7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockGutter.js\":\"1d1870b9b10a9ac9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockInfoDialog.js\":\"39aad7ca6408f4fe\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockTypeBlockRenderer.js\":\"d5de181320e43ca5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BulletHoverCard.js\":\"e9ee5709a35e9186\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorContentRenderer.js\":\"042071fdba96020e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b0fe22ec0d2eddea\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ColumnResizeHandles.js\":\"030aa21694412b6b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0260e2bdb6ceaab2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/DefaultBlockRenderer.js\":\"dca7b2be7f8fdd6f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/LayoutRenderer.js\":\"d8a18e828c445c1e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MarkdownContentRenderer.js\":\"c626c96790a171f2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MissingDataRenderer.js\":\"5e9709c6aa97f2d9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PanelRenderer.js\":\"0d36ed7d9357fc31\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PropertySchemaBlockRenderer.js\":\"eafd657ccb7fb9a9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/TopLevelRenderer.js\":\"b21936331f5df719\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockGutterMode.js\":\"96d330ea80674fed\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockTitleText.js\":\"951ac44a55bc299d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/fieldCreationKeydown.js\":\"8d141e507554c307\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/layoutRootContext.js\":\"308a50d205f34911\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/TypeChip.js\":\"654249aead3fa7a8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/chipStyle.js\":\"eec6e57b515d3283\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/anchored-floating.js\":\"2c7be5022bb393ba\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/button.js\":\"51df75bf91b8940f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/card.js\":\"a3fdbdae143b4a2b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/checkbox.js\":\"012b6be96f25ce1e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/collapsible.js\":\"619ba671db28690b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/command.js\":\"61cdfdd6e5e06099\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/context-menu.js\":\"15996a1bad5ca560\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dialog.js\":\"504889a7fb38eafb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dropdown-menu.js\":\"4c479c4e5fdeeb81\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/floating-listbox.js\":\"f434657e2345b14d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/index.js\":\"17bc81cb21bf442d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/input.js\":\"d9eba3cb1ccb08c7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/kbd.js\":\"3d648b47a6f11cd8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/label.js\":\"fadac5603d2c1b6a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/textarea.js\":\"175f43e1d8b5486f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/useEditModeYieldKeepalive.js\":\"5271ad593d8e357a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/BootFallback.js\":\"56a47f77e11d6fe6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/FocusedRowLazyMount.js\":\"c94f7010fc1afa36\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LazyViewportMount.js\":\"7d7342fd4745f876\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LocalDbCorruptionFallback.js\":\"60a9de4145f24bfb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/error.js\":\"f62a3d0e60f0a6b2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/lazyMountRegistry.js\":\"90b1f139aa2e881e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/suspense.js\":\"832b9eea7a91210c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/CreateWorkspaceDialog.js\":\"3136537d025a2475\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/PendingInvitations.js\":\"175d0e9c197b49fc\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/SyncProgress.js\":\"df96d8310ddcd534\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/UnlockProgress.js\":\"5c579c8e77501927\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceKeyGate.js\":\"67c9d5760650e383\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSettingsDialog.js\":\"b6d0b8c34d958464\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSwitcher.js\":\"d255ca8eb9db0411\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSyncGate.js\":\"0fc8303a984ec4eb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlow.js\":\"9281237bcde64a8c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlowHost.js\":\"c3541a7b306f978a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/EncryptionSection.js\":\"9055819317ad904a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/attachmentPrompts.js\":\"6a6e09cf5080fa4c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/bundleFolderPrompts.js\":\"eeeded9976850c7c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowDeps.js\":\"77393c7e05ff4c06\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowStore.js\":\"bd39cc69a4573de6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/flowUi.js\":\"a5e6651423611ea8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/useConversionRun.js\":\"7fa697a4292a4fb3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/keyUi.js\":\"004d11244ac19175\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnKeyLoss.js\":\"f7d3d2bda38d32e4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnServerE2ee.js\":\"c0f27dd987f0018f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/workspaceUnlocked.js\":\"f1f4ec28fd8a1545\",\"/knowledge-medium/pr-preview/pr-1494/src/context/backgroundSubtree.js\":\"c66308320707f527\",\"/knowledge-medium/pr-preview/pr-1494/src/context/block.js\":\"d16bf84f63200587\",\"/knowledge-medium/pr-preview/pr-1494/src/context/layoutWsContext.js\":\"b4abc90837309682\",\"/knowledge-medium/pr-preview/pr-1494/src/context/propertyDisplay.js\":\"4a08e58301963146\",\"/knowledge-medium/pr-preview/pr-1494/src/context/repo.js\":\"88a536af998729a2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasClaim.js\":\"098e262ec1ec3c8a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasSeatNamespace.js\":\"5bf35166dcec7da5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockData.js\":\"d04b3d1565265742\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockType.js\":\"fd5ba68fba411a0e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/changeScope.js\":\"167ae42c2f34c6fc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/codecs.js\":\"8fbcae9968796935\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/derivedData.js\":\"529f81ce81ba89cb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/errors.js\":\"a24fede3e3537756\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/events.js\":\"91b611c59b1fe641\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/handle.js\":\"cb467a260e45fef2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/index.js\":\"094307cc26e98439\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/mutator.js\":\"0e4bebb394e98139\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/processor.js\":\"acf8430207ce5dd7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/propertySchema.js\":\"22dc652ef355a31c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/query.js\":\"7a153f7f3bdda15c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/sameTxProcessor.js\":\"0a1ef3d5c9e425ff\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/schema.js\":\"cb467a260e45fef2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/tx.js\":\"cb467a260e45fef2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/typedBlockQuery.js\":\"ec7b12a36fa9b38d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/user.js\":\"f29a1bf8be457a1a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresetCore.js\":\"09237fbb986cd180\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresets.js\":\"141de51c54c8fbde\",\"/knowledge-medium/pr-preview/pr-1494/src/data/attachmentCleanerIOVerb.js\":\"df957a1042241e72\",\"/knowledge-medium/pr-preview/pr-1494/src/data/block.js\":\"5d98950596cf3cb9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockCache.js\":\"a12be848924f225e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockId.js\":\"623ad89cabcebf46\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockLiveness.js\":\"04954e5e3f711a93\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockMerge.js\":\"33bd15e43cfbd493\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockSchema.js\":\"3848878631235c7b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypeLookup.js\":\"caeee5dce6dec174\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypes.js\":\"2b8c6b9ea8417f56\",\"/knowledge-medium/pr-preview/pr-1494/src/data/childrenView.js\":\"9aa4697fc656f028\",\"/knowledge-medium/pr-preview/pr-1494/src/data/clientContext.js\":\"26c337f0c1f0360a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/dbFileSiblings.js\":\"fb285e582364821c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/definitionSeeds.js\":\"cf71c1f66c905dae\",\"/knowledge-medium/pr-preview/pr-1494/src/data/derivedIds.js\":\"df4dd7a6c3d147df\",\"/knowledge-medium/pr-preview/pr-1494/src/data/drawnSubtree.js\":\"00533f09b30bed14\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facetBridge.js\":\"3180d49c570ed17c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facets.js\":\"6e35ce2e297429c0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/globalState.js\":\"ddefad7c2e4a84d8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/aliasClaimRederiveProcessor.js\":\"b92b6343649d65ea\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/ancestorBatch.js\":\"35607813907a7b73\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/blockTypeTypeifyProcessor.js\":\"25af398bac0a33c5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/clientSchema.js\":\"71eb05b897506a32\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/commitPipeline.js\":\"16a4dfa6970a3ce8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/devAssertions.js\":\"9ddf959e22958715\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/firstSync.js\":\"6df02683fb4a8993\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/freshInitialLoad.js\":\"68740725be085f78\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/graphBackfillClaim.js\":\"78bbe42656f3b4ea\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/handleStore.js\":\"de59f6dc3ba285ad\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/idleMarkerJobs.js\":\"17a824b75cebba52\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initialDownload.js\":\"6054a2227842236d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initializeClientDatabase.js\":\"ff52273c9fae9503\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/jsonCanonical.js\":\"cce22a62d271bc29\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelInvalidation.js\":\"7536cd42e0e81466\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelProcessors.js\":\"e84cedec59617d05\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelQueries.js\":\"d6744a0036fe2db4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/mergeTypeMembershipProcessor.js\":\"24e47dd01c5d803f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/normalizeReferencesProcessor.js\":\"1f711dc2d0135ab1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/poolInstrumentation.js\":\"e7fb31cdb2975ee8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/processorRunner.js\":\"397e520bfc5df3ca\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyCellBackfill.js\":\"b1a09209726ee363\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildMint.js\":\"4f4836efb2439def\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildrenProcessor.js\":\"662b8671e894addc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2404c1bc13391ded\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionSynthesis.js\":\"e30b44a4313f8b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyKeyScan.js\":\"549beb2d4fc3147c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertySchemaResolution.js\":\"a4a44f10dac1dc89\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyValueEdits.js\":\"dec8dbeb074a2e0a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/raiseProtocol.js\":\"8dd0a9ceb672c978\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/readBatch.js\":\"295511c07a566131\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/refProjection.js\":\"bfc2a30e4370ad77\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetLookups.js\":\"7482733eb80a2aa9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetProcessor.js\":\"67f34aac3020b13e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/replayMerge.js\":\"b3ae78fb954215bf\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/sqlBinds.js\":\"939134d13696759e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"92c32c84c2d64099\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/arrivalProcessors.js\":\"0b640e7e762444d3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/invalidate.js\":\"f6f02d618c538904\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/materialize.js\":\"6a5f4aa6343bc4fe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/observer.js\":\"64bea8ce997d1248\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/reconcile.js\":\"91e8427190c7a673\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/timingMetrics.js\":\"bf8135597e0f0882\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/treeQueries.js\":\"634b0c9d3273ac0f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txEngine.js\":\"4c652e8336c9552d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txSnapshots.js\":\"e520eee19b47f322\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/typedBlockQuery.js\":\"ed33fd9944ff3573\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/undoManager.js\":\"648c4d0386f98f83\",\"/knowledge-medium/pr-preview/pr-1494/src/data/invalidation.js\":\"e69b011f4f823706\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelDataExtension.js\":\"f0d85cc3f7d559e0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelPage.js\":\"ee8c99bb91dade01\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelValuePresetCores.js\":\"58ebc682e79da624\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbCorruptionSignal.js\":\"0bc7740b75e316a5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbStorage.js\":\"c82b71493c801c20\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbVfs.js\":\"7103124c35e41892\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localSchema.js\":\"204803a5a37b7903\",\"/knowledge-medium/pr-preview/pr-1494/src/data/maintenance.js\":\"9df551f771643bcc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mergeProperties.js\":\"08d0aab19f4c106c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/metricsConsoleHook.js\":\"69437f5a92f904f8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/migrationsPage.js\":\"b1b322a05917fb4e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mutators.js\":\"977441985c1324d3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKey.js\":\"e87ebaf3a25f87e9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKeyPlacement.js\":\"026b28b4fbcfdc2a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineGroupGestures.js\":\"329111ecd087e3d0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineSurface.js\":\"6fcbfe58fbca0a29\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingEditorContent.js\":\"14b5c757487614b2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingUploadsSql.js\":\"fdf72ca4642a8751\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pluginStateExtensions.js\":\"767c9f64303b0e54\",\"/knowledge-medium/pr-preview/pr-1494/src/data/powerSyncLogger.js\":\"f7a5fd38ed472a4d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/projectorRuntime.js\":\"476c0b99b4e2ad9c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/properties.js\":\"a796c3bebe3d1bed\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertiesPage.js\":\"79d406167eac1570\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyChildren.js\":\"96695b5d17156b88\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionFanout.js\":\"158a4b3685964689\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionMetadata.js\":\"a2f31e5885e884de\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionRegistry.js\":\"74059462ba953976\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDisplayMode.js\":\"4fc1dfdf3d517bbb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyRowCreation.js\":\"77ca09d261029e66\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySchemaCreation.js\":\"8cd9132fd06c36c2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySeeds.js\":\"ad74e434333bce40\",\"/knowledge-medium/pr-preview/pr-1494/src/data/recentsPage.js\":\"02a75838c32744da\",\"/knowledge-medium/pr-preview/pr-1494/src/data/referenceBlock.js\":\"2137d0b7d18dd214\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rejectedUploads.js\":\"3e8c0dacf451016f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/releasePowerSyncConnection.js\":\"4bc1be2df1cb1c7d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repo.js\":\"0df12d6628b16b86\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repoProvider.js\":\"f5052073c834dab2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rowProperty.js\":\"11dda4562c00d4a6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/searchFilter.js\":\"4109291f8c985c51\",\"/knowledge-medium/pr-preview/pr-1494/src/data/seedIdentityLedger.js\":\"29d38fb394b5ad46\",\"/knowledge-medium/pr-preview/pr-1494/src/data/stateBlocks.js\":\"22b7f3c69761538c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/structuralEditPolicy.js\":\"5aea1e34e424c4ae\",\"/knowledge-medium/pr-preview/pr-1494/src/data/subtreeDelete.js\":\"c60d2c91fd460882\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncStreamLock.js\":\"bd36332c5c96e4b2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableSqlRecognizer.js\":\"0b8bcfb22127d95c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableWriteGuard.js\":\"548f8451887a2401\",\"/knowledge-medium/pr-preview/pr-1494/src/data/targets.js\":\"096bad5f631db908\",\"/knowledge-medium/pr-preview/pr-1494/src/data/treeOrder.js\":\"8ec4fbf7f101ec14\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeColors.js\":\"478e20e35f5c8efc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionMetadata.js\":\"7ee27fad803a5e20\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionRegistry.js\":\"eabb1acae025693d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeExtraction.js\":\"ed6a04b8b3064f96\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeInitialValues.js\":\"6c86e2df8640a17e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typePropertyGroups.js\":\"71a55ed7a671beb6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeSeeds.js\":\"35c2ec81c7c72831\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeTagger.js\":\"8ab91c096ef2cdba\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typedRecords.js\":\"31de55299c279a87\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typesPage.js\":\"a0cbe636aab55fda\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userPrefs.js\":\"e23f6cbdea91c8fa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userSchemasService.js\":\"696003c41bd71e55\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userTypesService.js\":\"393a2cdd74a31f03\",\"/knowledge-medium/pr-preview/pr-1494/src/data/valuePresetRegistry.js\":\"7f3350b141525adc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/visibleChildren.js\":\"40eefbfbf7beff24\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceConversion.js\":\"35cdcdbd51887a12\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceFirstSync.js\":\"0bbe97ab18047b8e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceIdNamespace.js\":\"733b08b24d545a37\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceSchema.js\":\"c8c2b2a319e5b0f1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaces.js\":\"7f7444d1fa04c5e7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadLog.js\":\"abc89ce85c66cca2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/BlockPasteShellDecorator.js\":\"e1009f1cb0078748\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/atTrigger.js\":\"d8157683f4b2babb\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/autocomplete.js\":\"fa18ffcc98629aa0\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/codeMirrorExtensions.js\":\"7f9bddfc036a0471\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/contentFlush.js\":\"127b6c94ded85300\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/defaultInteractions.js\":\"c4570553ec049cc4\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/editSettleSignal.js\":\"c4345d593704059f\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/insertImage.js\":\"ed5ecd22c72b7463\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceCompletionRange.js\":\"1f7e63695b02df13\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceTargetTypes.js\":\"862bebd9881729f3\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/syntaxContext.js\":\"8059cee56573c875\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/triggerMatch.js\":\"6ed7d860d7316ea7\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/AppRuntimeProvider.js\":\"c96da1c77921f397\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/BlockFocusShellDecorator.js\":\"fdd0115e77a7d2b2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/ExtensionRenderBoundary.js\":\"d659c6857a64103c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/PanelContentRecovery.js\":\"ab553ad826fe8c44\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/apiCatalog.js\":\"a67dc70eecf7aae4\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/approveExtensionHere.js\":\"1023dab04375bd84\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/armedCutAppMount.js\":\"e096c97a58590e8f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/batchableKeyedStore.js\":\"8204b69f07f4c8ef\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockInteraction.js\":\"ee4757973b8d258f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockSelectionAction.js\":\"71fe9a36c90f8bc8\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compileExtensionModule.js\":\"5400fc024fe3e065\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compiledModuleCache.js\":\"1144d077d525407f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/continuousGestures.js\":\"947e611c2d34129b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/core.js\":\"644cb7b2cc5def2c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/defaultRenderers.js\":\"7a96a98a1717cc82\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/definitionFanoutAppMount.js\":\"60f1c69a3ab6fc52\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dialogAppMount.js\":\"da2e6a262cfd4226\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensionSeeds.js\":\"114e1ab3eb36ee0c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensions.js\":\"d9e9006d02c2c694\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/exampleExtensions.js\":\"aa877c9db24a7ec0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionApprovalStatus.js\":\"f4232f6303739341\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrorToast.js\":\"8f770214f579a70d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrors.js\":\"0a1bf6b204830e03\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLookup.js\":\"c0d87af7cfc86b23\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionToggles.js\":\"fcb42d2e3af93805\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionUtilitiesCss.js\":\"f1deabed88202dbf\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/kernelPageDeletionGuard.js\":\"c67e7569afd8b250\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/liveRuntime.js\":\"c0ef571fe290d20d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/openExtensionsSettings.js\":\"800378a7bae7bc32\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/overridesCache.js\":\"8a26ae71a80789b3\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/pluginIds.js\":\"01a4a9ada8073ca0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/processorRejectionToast.js\":\"76027757122de80a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeActions.js\":\"f830391b25971d7b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeContext.js\":\"8e55d8b05077d1e6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticAppExtensions.js\":\"7e46cbaacc0b47b9\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticDataExtensions.js\":\"57f71aa8b4f61cbd\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/toastAppMount.js\":\"7c3a03f48b0713a9\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useOverrides.js\":\"1b8d117339e01038\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useShortcutSurfaceActivations.js\":\"39f5fb2bf98e9715\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/discoverToggleTree.js\":\"7694ac519468d583\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/facet.js\":\"4bcce20d5ff022e9\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/resolveAppRuntime.js\":\"8585bff16edad9eb\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/runtimeEvents.js\":\"6f90dd9508137c7a\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/togglable.js\":\"fd18a84d0a28855f\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/variantFacet.js\":\"07fdd8ea4ffd1895\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/verbFacet.js\":\"fd25ab74f404fc53\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/block.js\":\"b8efdd750a7e977a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/focusedChild.js\":\"b03859b914978e0e\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/propertySchemas.js\":\"428d1cd9f530821c\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/typeRegistry.js\":\"095d156cf0a7ca31\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAncestorCrumbs.js\":\"3be838b04d7668d0\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAutocompleteListbox.js\":\"e6b75b62d5621071\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedSearch.js\":\"3d97257f4aab4319\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedValue.js\":\"19814e62447a3a4d\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsFocalRender.js\":\"409c3a52bfc59b54\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsReadOnly.js\":\"c542ce16a5052f54\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMaterializeBacklog.js\":\"5ef8af248c5a3ae7\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMinuteClock.js\":\"b2d6949fd875428a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePanelLayoutProjection.js\":\"f9e65af900cc41ba\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePendingInvitations.js\":\"8b18d4175c2934f4\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRendererRegistry.js\":\"a474e7e72efc3d52\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRetainedFieldRows.js\":\"b2c9f58c5dc7a90c\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useWorkspaces.js\":\"10566a9fa273c7d9\",\"/knowledge-medium/pr-preview/pr-1494/src/lib/utils.js\":\"067fbbf2637e6074\",\"/knowledge-medium/pr-preview/pr-1494/src/main.js\":\"d45e2a41f8a08063\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/MarkdownImage.js\":\"7fbe37aba5ea986c\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/blockSeparators.js\":\"ae26241d42c67fbb\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/context.js\":\"2200842d0eedb917\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/defaultMarkdownExtension.js\":\"f786d4138e9f5801\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/extensions.js\":\"3c5bf8af0075363f\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/renderMarkdownHtml.js\":\"50679ffd9453a45c\",\"/knowledge-medium/pr-preview/pr-1494/src/minimal-editor.js\":\"2756840000259085\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/armedCut.js\":\"6d8a53772c818502\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/captureMediaVerb.js\":\"6998cb4ad59d8b27\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/clipboard.js\":\"ba87c3a834227371\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/decision.js\":\"43f92b62fb6582ab\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/operations.js\":\"94bca03924331348\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/AccountHeaderItem.js\":\"7a65b9b93036df4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/index.js\":\"6102e997cdab4507\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ee30dd8d31bcf092\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askAgent.js\":\"55b6242c1bad620b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askedStore.js\":\"12ea4e1ed52d7b47\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8b21f53c951b9167\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/chipState.js\":\"adf0a42d23bfbd75\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/dataExtension.js\":\"47403bdc7deac944\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/index.js\":\"ca461d8dc4425557\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2e3715a839ab8b48\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/schema.js\":\"a013466a6eebca38\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d640b45a79db26d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3c96995fcf16e2d5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/addMedia.js\":\"fd5b06e7b6ad4c39\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/backlinks.js\":\"57cd7f94233e4073\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/block.js\":\"1f2c0ac3ba0f6bef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/context.js\":\"7d7bce1b1238c1b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/displayIds.js\":\"19f465f4e4a9894f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/index.js\":\"6e621e1822c113bb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/outline.js\":\"e7d530e6c78e1296\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/properties.js\":\"8eea0171079aea04\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/refs.js\":\"21350f97e2f61220\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b5f3ffdc236b7778\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/search.js\":\"cc6b67c35167d148\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/shared.js\":\"a6cd2091192bc1de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2055e666ab5147db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/text.js\":\"74ae90a1da208832\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentWrites.js\":\"8ed711759bcf8648\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/authoringCatalog.js\":\"e997b2e463c8c1c0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/blockRefTargets.js\":\"708a82f4e82b36db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridge.js\":\"972a94bfafce0085\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridgeLoop.js\":\"6593a3b2ed54b1d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/changeHistory.js\":\"191a244f0e419bf3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commands.js\":\"f1c7e6d9df61252c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commentsCommands.js\":\"b26c49988defb39e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataExtension.js\":\"9abd80956327337c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataModelGuide.js\":\"b7cff15b2d48c535\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/describeRuntime.js\":\"6622d3b4a8a910ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/extensionLint.js\":\"7af515ea66547349\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/grainAudit.js\":\"fe28690080863fed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/healthCommand.js\":\"7a011f090f50a070\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/index.js\":\"6cfe31361e6ccd4c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/presetIdentity.js\":\"5bf824aed8fda0e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"15ed3093b2767e31\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/readMedia.js\":\"34983cc3bba31e21\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/schema.js\":\"8d19a159490d772a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/serialization.js\":\"e65cf83337bc3520\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/targets.js\":\"fa73a076d5d182ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/tokens.js\":\"29e379fe8b08d2ed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/watchEvents.js\":\"c25affbc614f10bc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/workspaceGuard.js\":\"d8b77699435786ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/writeCommands.js\":\"4187da75da64cafd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/AliasCollisionToast.js\":\"b8083b031f5c387c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/DuplicateNameBanner.js\":\"808957f112e95ad3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/collisionMerge.js\":\"18bdad30908011f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/dataExtension.js\":\"ed9767c0034ab6f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/index.js\":\"c00966fd1aa43221\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/mergeCollisionAction.js\":\"3893dc8a7210f8da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/pageStyling.js\":\"a938835697cead91\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/rejectionToast.js\":\"3afdc0fbc2a3771d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/syncProcessor.js\":\"2ea4a6d40fa05a35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/actions.js\":\"5b05adedcb05771a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/addComment.js\":\"f6c868d40368f3a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchor.js\":\"f776ceb681f09a35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchorState.js\":\"99cefd2948512c8f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/commentLinks.js\":\"549ad1461888b94a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/confirmThreadDeletion.js\":\"71a657992af5c5e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/container.js\":\"0c3eb8446fd3d04a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/dataExtension.js\":\"226a5445864c0816\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/deleteComment.js\":\"0b6ad3e8838a7176\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/highlights.js\":\"b95fe940570125d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/index.js\":\"047fdb39777f1d15\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/linkedCommentsPill.js\":\"fd7500b67d769e18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/margin.js\":\"8b6561a99c4d7d4c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/marginSchema.js\":\"92d7dd5fd908aeb7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/newComment.js\":\"ec549a1b7f391a30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ownThreadPicker.js\":\"ce3dc0b51349475a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/placement.js\":\"b38625d6ab8f39b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/queries.js\":\"ffe061738d96d656\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotePosition.js\":\"bfa9cd45e31b35ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedIn.js\":\"2b211b6de455cf9b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedRange.js\":\"5ace8e0c149be7cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/rangeRefs.js\":\"8f846ee4f8bd1055\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readHighlights.js\":\"4806c31f1526e616\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelection.js\":\"8cc6594b97ad2396\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelectionUi.js\":\"3247306b78f5ad34\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/reanchor.js\":\"4eb1d09c6594810a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/schema.js\":\"11b9ba95492a5b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scope.js\":\"bead134f0103b420\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scopeThreads.js\":\"97b9d955998fcf2f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/splitRetarget.js\":\"d0d40cf62ea5af62\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestionCard.js\":\"7ed42946ebf8f779\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestions.js\":\"5342684ce7ce13a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaries.js\":\"f4f1d64539820e4f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaryBatch.js\":\"f8f0152d96167a22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/surface.js\":\"993fbe7b1caff6e2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threadNavigation.js\":\"c3702271e2e16383\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threads.js\":\"9a825157f0e6b5b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ui.js\":\"eeb1bc85e418e29f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/uiStore.js\":\"87398750eda132bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/appIntents.js\":\"dfbb8873dd3a8ba5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/index.js\":\"b97663bfac9b9be7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/index.js\":\"05d68a66ebbf1bc1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/status.js\":\"fc868b19d3452440\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6c812bf70b238a35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaBlockRenderer.js\":\"8676e465033a662c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7673d8f26bdd28b5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaUploadReconciler.js\":\"13c0de4781198da3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetDownLane.js\":\"d34d1f4210c1544d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetResolver.js\":\"9564776f2004a0d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetUpload.js\":\"a9eb8e5137eb7a2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/attachmentCleanerIO.js\":\"b443a2ba6dbab6cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4465cf5ca0253380\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/blobStore.js\":\"3a3dd04ea003361c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/browserMedia.js\":\"faae77c16c63d279\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/byteStore.js\":\"0f53d97d213a91ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanerIO.js\":\"04ebb975b3752070\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanupAttachments.js\":\"5da0ee544cdafdef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/dataExtension.js\":\"9443303c01840cc7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/downLane.js\":\"5062a927881ea442\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/index.js\":\"6737c4407bc1b7ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/insertImageContribution.js\":\"54788e4d71a43779\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneArming.js\":\"51f0db47d679a6dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneLock.js\":\"f27d5a215a440ed1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaBlock.js\":\"f2e72cfbdcc14b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaCapture.js\":\"39faeab1de5bc0d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaLanes.js\":\"5b30b79b00c3298b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewers.js\":\"482c98628d90b90f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewersFacet.js\":\"9878f79835a25d37\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/pasteCapture.js\":\"3d957ce1088fccc5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/resolver.js\":\"7306db219611d66c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/retryUploadsAction.js\":\"51e787924d55f187\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/storagePaths.js\":\"785caecc0acc3abe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadDrain.js\":\"7f5c73fb1e7986f2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadLaneStatus.js\":\"9e257fb57081662e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadReconcile.js\":\"ea5ad66384860cb6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadRecovery.js\":\"28e70030916124aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadStore.js\":\"84b52077a442aa34\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/useAssetObjectUrl.js\":\"96ac3826c96bba0c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cbfc88e45a213335\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksViewSection.js\":\"df27062092fee60c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/facet.js\":\"e01b5ef4e41acf20\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/index.js\":\"2d56c18844f1ff51\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/prop.js\":\"10893f5e2fd154f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinkFilters.js\":\"8b07e4be372badf1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cb934f0c37d88c9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BlockEntry.js\":\"b994c39fd17beafd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/LinkedReferences.js\":\"e52bd59c6b440307\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8b4a63210c98330d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dailyNoteDefaults.js\":\"592ee6be042dff14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dataExtension.js\":\"a372feba6fb6e983\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/edgeExclusions.js\":\"ea1644fe580f5fb5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/filterProperty.js\":\"5ab20d3657cc747b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/index.js\":\"6fd8d3b7cc262975\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"47d426f78d7967a5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/applies.js\":\"027a06bb345531bc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/countQuery.js\":\"86183c61efc1aef8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/expansionStore.js\":\"92d1851595973db2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/index.js\":\"0de585b548370f70\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8e4d6fdb1cadc690\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/presentationInvalidation.js\":\"2e1ac8610671341d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyEditorOverride.js\":\"b40cb6882feb190f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyFilter.js\":\"b22d16190987f2ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/query.js\":\"9af88a6383b99067\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/resolveFilter.js\":\"7df32f0e9a50cd28\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sourceBatch.js\":\"528cf92c3afc5db5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sources.js\":\"38886ffd5954977a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useBacklinks.js\":\"9a70de809cc365f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"87d5e82666f0d431\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayCelebration.js\":\"cb3b65bc7b8f58ee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayOverlay.js\":\"0356461d3125921a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/gate.js\":\"60cab8129024e591\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/index.js\":\"ee734699172e01f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/wolfTheme.js\":\"9a11863bdf756efb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/BlockDragLayer.js\":\"4dae2070ccc8d941\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dragController.js\":\"134d744a581cb530\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dropTarget.js\":\"1ba57e1a989e662b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/index.js\":\"351afb533500ed7f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/projection.js\":\"1761a8da3c2d4153\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/BlockMetaCard.js\":\"5a8d525dd88eb19d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/index.js\":\"797de25799fd05ab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/AddTagDialog.js\":\"fbd8228b6d16d0ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"706009bce380144f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/TagNameIssueHint.js\":\"668a9741ef90638f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/addTagAction.js\":\"cd62c4065aeb0784\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/appendTag.js\":\"7bb36af7fd379825\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/config.js\":\"0a864312780d21dd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/dataExtension.js\":\"197604e2a57373fd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/index.js\":\"37c5bbec137c44c8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/propertyEditorOverride.js\":\"3ac8437b251f91c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b31550c834c92a4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0cf7072de995746c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d875a42a7f5837f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"028217ac4b298175\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"21f1892aa7a58d0d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/index.js\":\"d4ba08c09f953487\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"469ebbdc3cfe8f6a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/CharacterCountItem.js\":\"fbeb788d1899d000\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c18315761d529861\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/actions.js\":\"b388d1121183cd64\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/blockType.js\":\"b711e8c79478e315\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/charCount.js\":\"6aefc42104aa7e46\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/dataExtension.js\":\"d3505f817c9d8026\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/index.js\":\"ab1aad6ead48afef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/profiles.js\":\"120bfc198047396f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/properties.js\":\"04bbb956debef71a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/textCounts.js\":\"0133c19423d7c777\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/colemak-keybindings/index.js\":\"0f36e09e076acd04\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/CommandPalette.js\":\"97d0e9046ff03603\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/HeaderItem.js\":\"f843f5d54efd0bca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/context.js\":\"9106c4d9c2335fb1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/index.js\":\"d84b63df5d8f32ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/selection.js\":\"cf1719890afa7f8f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/toggleStore.js\":\"7b8d2c99d6334ecb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/useCommandPaletteActions.js\":\"f0d7f4b1fce11a26\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/ContributorBadges.js\":\"9701b8aac0747104\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/author.js\":\"b443bf7d1905881e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/codeMirrorExtensions.js\":\"a99d9c14fbd583ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/dataExtension.js\":\"1877658d45e70f3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/index.js\":\"80563cbf9ccbd49c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/mentionAutocomplete.js\":\"d0fe7d03ab05e3d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/processor.js\":\"606f0567ab5b832d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/profiles.js\":\"ffb9f0bd6f58e9a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/queries.js\":\"a0cc8f5b7a614d3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/schema.js\":\"59cbdc81b3a2f0cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"218aa8a234415e90\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a82dcaab42fa91b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/index.js\":\"97a23950354de559\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"698e624cafb8e352\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"688d8ed37db2de97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/CalendarGrid.js\":\"042f85055cbe621d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DailyNotePicker.js\":\"33ce4ebe56c5b465\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7991503294f239ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateNavDecorator.js\":\"3a8fe2f91720d8e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateScrubOverlay.js\":\"03edd08e16b07284\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/HeaderItem.js\":\"e24b28ceefc938e5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/ReschedulePicker.js\":\"ce295801d18cc32f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9ab25a4c749749aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/actions.js\":\"194343cc247a716c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/blockDateAdapter.js\":\"749a2a63ace03a08\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/calendar.js\":\"b6b3b1ac2f42eeb8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dailyNotes.js\":\"ce6620cfc9293391\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dataExtension.js\":\"887d33d9dffb3fb1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubActions.js\":\"aefb0dd34092da5e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGesture.js\":\"3b4a93c610cc531b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c8ab7c2057d7c1db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubRecognizer.js\":\"342631608a1b9155\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/deletionGuard.js\":\"1b056233a8a8ae70\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dueQuery.js\":\"9d092a0d0636d39d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/index.js\":\"9b29f5a3f20a4436\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/landing.js\":\"1d6a77ed4123453f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/localSchema.js\":\"abe751676a2c94c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/referenceDateAdapter.js\":\"ee0459e02322cbec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/rescheduleAction.js\":\"16e440df8641f017\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/schema.js\":\"1bd71dbff6c7c26b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadBlockDates.js\":\"f3bc35a67bd6e475\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadDatesAction.js\":\"f9df313e14dec81c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/today.js\":\"d183cbdc99b4eb2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e07bbd2000bc7d34\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e2cb25003c3e1ea4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/audit.js\":\"37047a0b0be5a6b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditAction.js\":\"5327999f840d1c70\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditRanges.js\":\"469ffb7a7e838c52\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/diagnosticsSource.js\":\"5be0d50504179c7a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/divergenceScan.js\":\"37e7b27134ef680d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/index.js\":\"30a5365894661aa6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9eaff613ce575ce4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/referencesMirror.js\":\"fc6d32ff8b4a36a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/rowJson.js\":\"6dd8f457a37d06eb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/schedule.js\":\"ceab7428ab781262\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/store.js\":\"a3fefdbd5117568f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/action.js\":\"518734384cc66350\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/index.js\":\"d1eb7cc1eacf13f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/plugin.js\":\"796b851a842e32ed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bb18147d3fd81499\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/actions.js\":\"3a69f997a96e396d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/changeMarker.js\":\"bb798862d96e02fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/diagnostics.js\":\"311e27cc30dc6436\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/fileSystemAccess.js\":\"729af017dc3dce62\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/filenames.js\":\"9af21e0fb149a589\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/index.js\":\"0d182f03d929b2de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/mirror.js\":\"e549d45a3f269d7a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runLock.js\":\"a808e49ce33a15d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runtimeHealth.js\":\"ec85e451c6a7e813\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/schedule.js\":\"4e2249183ec44492\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/store.js\":\"111d5e3a748aca21\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/index.js\":\"2e86b4a112660bc4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/themes.js\":\"d5ae5f8da47eb317\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/facet.js\":\"fc6b6ac26b6c2510\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/useDiagnostics.js\":\"f3bb729686825c35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/dismissals.js\":\"ccfa1b7b5f5af102\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/index.js\":\"007517d3e3d16ffe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/status.js\":\"6c9037ba23a4a4d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/store.js\":\"944778003a4e7a14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"badb24ebdadb73c7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsSettings.js\":\"08d04d59fb00825a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/actions.js\":\"7ac296181cee33fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/config.js\":\"3bb4b061a3f931cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/dataExtension.js\":\"fac34a32e24465cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/effect.js\":\"4a10a4d6ac25b756\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/index.js\":\"ab510cb5c20d355b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/propertyEditorOverride.js\":\"262fc9fe11de64f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/useToggleTree.js\":\"3be7f5c068558a96\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/ExtractTypeDialog.js\":\"555be6f20a151c7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f537a567230a9075\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/PropertyShapePicker.js\":\"e45c615e98f973ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/action.js\":\"366a9946fc64d175\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/index.js\":\"8239c55ef4fe928c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/FindReplaceDialog.js\":\"55503a35af684f64\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/HeaderItem.js\":\"5edae4ed4bd5c2e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/dataExtension.js\":\"ffd46ca414775421\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/index.js\":\"f42270822f0d3650\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/search.js\":\"426a08018d7add9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/toggleStore.js\":\"92e2928ca250e2f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/LocationPropertyEditor.js\":\"a7132314e3074c53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/MapView.js\":\"4c04b362b4b545bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/blockTypes.js\":\"7d0e130c1e265342\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/codeMirrorExtensions.js\":\"93ff8e0417c28a77\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/createOrFindPlace.js\":\"3198fbaa47e32786\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/currentLocation.js\":\"de830ace24df96a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/dataExtension.js\":\"2af5038556d29e5b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/geoContentDecorator.js\":\"82b3d11cd6f39e33\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/googlePlacesClient.js\":\"553572f0e40d17a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/index.js\":\"700b7498ece6dcf7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/locationsPage.js\":\"7cc3416c051de14d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/mapViewport.js\":\"0e06175fa88047fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/pickCurrentLocation.js\":\"2d3fe6096edfe41b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeAutocomplete.js\":\"debd2a3237b2fec5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeNameCollision.js\":\"21db6b44da3f17cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/properties.js\":\"38e83ead8dcfa20c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/propertyEditorOverrides.js\":\"790f742ac408ee1c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/query.js\":\"30e34c570695d203\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/usePlaceSearch.js\":\"ef5f800384473555\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"373b316f04911151\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9d7ee1d296f529f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7ba91c7e9ded85df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/config.js\":\"7d739882dadf1dd7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/dataExtension.js\":\"c54bb2802efc1f28\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/facet.js\":\"a11fe8c1dc833006\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/grouping.js\":\"0d7728350c3dc0c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/index.js\":\"e9d2f986c051e9fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5baa57ae1509f318\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/query.js\":\"a911675ade8f5c37\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/resolveConfig.js\":\"1f9db65ea11dcc7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9cde66e7b7e0f73e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"89853d487126b373\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlDocumentContent.js\":\"0988b09f1c781d93\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlFrame.js\":\"78d3f46d20130cc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/actions.js\":\"2510dfa2b0662861\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/blockType.js\":\"549e43007cbbb8ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/confirmRunScripts.js\":\"307cb30b17daffaf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/dataExtension.js\":\"a3836385c00e8eda\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameAnnotations.js\":\"2c5506c9f61247e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameDocument.js\":\"3589afc157cb3a80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameTheme.js\":\"f204f826eb656d32\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/index.js\":\"22c250bca5fcfe79\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/scriptConsent.js\":\"36cda957138ac48e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/sourceMap.js\":\"e56c44ab9f3ac3de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/useDocumentScripts.js\":\"0736101ec6ec3659\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/index.js\":\"30d537845d3b3fe3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/record.js\":\"ef52aaf7e60dfe4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/recordStore.js\":\"e25ce0c3d10151a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/responsiveness.js\":\"b9a6f15498869d1a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/schedule.js\":\"ac5c37c6ad3bcda7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/sessionContext.js\":\"cc02085dd96f0aeb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d2a90358e1a11a6c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7abbc38f933fe663\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/actions.js\":\"133c7176363db4bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/config.js\":\"6894b8ba733214cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/dataExtension.js\":\"45b1f64c6c8b403c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/effect.js\":\"9c90f5dce9145bc6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/index.js\":\"39da6084c035feaf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/keyCapture.js\":\"d2e92ce8ada19644\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/overrideStore.js\":\"88babcd273a4ec6b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cb39f4a084f1d1a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/HeaderItem.js\":\"e835e94eb375f7d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/LeftSidebar.js\":\"83bd210f63acbcb3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/actions.js\":\"8f5b35c8449d5159\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/facet.js\":\"d5270c876ecf54d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/index.js\":\"8c150f1e9c46dae9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/shortcuts.js\":\"c0442af56012a067\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/toggleStore.js\":\"78c33b07a05758f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/MergePicker.js\":\"f1f107783dcf8e40\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/index.js\":\"bde44c5f0c66e1d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/mergeAction.js\":\"547a89d38b43362e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/strategy.js\":\"5e8737374772de27\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/Button.js\":\"6e81fe9a46909319\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8553faf5dbbc9173\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/defaultItems.js\":\"dd6ba695da54fb66\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/facet.js\":\"2b5cf1a5e2547ebc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/index.js\":\"9265978d2fa6b957\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9951504834686301\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c50814f2cc5218de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a33c4798b7e289a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/facet.js\":\"bf008d7db45c5fd6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/index.js\":\"961c88cdc5f2d41a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/MoveDestinationPicker.js\":\"69c254205b527c5f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b7bd7e831977dd97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/contextMenuItem.js\":\"4c434fb423da5831\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/index.js\":\"2a2e956b49885f9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveAction.js\":\"9b38ab0c38f018ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveBlocks.js\":\"78ef515013b38cd2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/selectionAfterMove.js\":\"f6847fc59f905a2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/TutorialBanner.js\":\"bba35e9f8f9b6f6a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/action.js\":\"e610ca665644b0ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/bannerDismissal.js\":\"8ba1f8ee1788b675\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/documents/cheatSheet.js\":\"ee33cd7c0f8f04c1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/index.js\":\"5b5e715d59bb50a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/keys.js\":\"29a898ecd7272cb6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/landing.js\":\"46a502952b17db50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/outline.js\":\"6e7f98022da6f1a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/seed.js\":\"4b3a1191d6032e8b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1d9ab6c707b165b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/analyze.js\":\"6c97081dba6ef46c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/diagnosticsSource.js\":\"29c076425a50603e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/index.js\":\"7bddb9bcefc02683\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/load.js\":\"538e086f8d0f08a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/monitorRun.js\":\"455f3ee38453afc9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/schedule.js\":\"209b51dde15b9850\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/series.js\":\"89eb49fcc33e4306\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/store.js\":\"ee97324674a2be62\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/trendAction.js\":\"c74716c32708175a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/verdict.js\":\"266945e259afc255\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/clickToEditAction.js\":\"47a655a7a006b1e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/index.js\":\"dcb0a955246da7bc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/interactions.js\":\"38342ead6fbc2c79\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"dd922ae381c973fd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGate.js\":\"2054d84d464e1e99\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGateDialog.js\":\"440929f59cd61942\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/action.js\":\"a4188885c6fb24ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/index.js\":\"4dc24e9577862827\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/localRunMessage.js\":\"514c5fee25c3eecc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/plugin.js\":\"23fd8ac980c86f74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/progressReport.js\":\"8194dc355c290993\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/sweepProgress.js\":\"7b6f59b8bcab6eff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/FieldRowRenderer.js\":\"e79744f4205e83e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/ValueRowRenderer.js\":\"a08fe97b6186e65a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/actions.js\":\"9e6e0b3c4b978807\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/autocomplete.js\":\"e25425660ab07fe9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/fieldRow.js\":\"57233629c201027e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/index.js\":\"ad85babb3ff94911\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/referenceWarning.js\":\"29f828f8cdf7c042\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueAutocomplete.js\":\"9e3fc698018839a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueSchema.js\":\"c720760f113100f8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/HeaderItem.js\":\"84989d546b8c9231\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/QuickFind.js\":\"582a99b23b724f3c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/index.js\":\"05a28ea04b0c0270\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/recents.js\":\"4a41f7a6bdb9d1a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/resultItems.js\":\"63ec39cd374cbe06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/selection.js\":\"32ec22695ec62b01\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/toggleStore.js\":\"7de7b0c5c0e4bcb9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/HeaderItem.js\":\"28c790b0f49134c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0f8169ff1bfbf6e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/grouping.js\":\"5a02c9ed19de68fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/index.js\":\"f13e404aae9d7bef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/target.js\":\"d858de0af432708d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/codeMirrorExtensions.js\":\"b596de44634d11c2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/contentPrefill.js\":\"dd13822640c104e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/dataExtension.js\":\"43d2ff3e703e574f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/index.js\":\"1abfd67fe87b46d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d6f8cd2758a48c7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/invalidation.js\":\"874a600860ef4271\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/localSchema.js\":\"0a951bec127723ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/index.js\":\"1961f9b8a76b0f9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f271de952204106f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/index.js\":\"1fb045f5ede6128d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/referenceNode.js\":\"c6f93f60049d1ccd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d9980cd288e46cb3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1cfea107d2cd0419\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/index.js\":\"883eb29994f10dc9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e4ad15ed94167f3e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5c3882b9baa4f9fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/mergeRetargetProcessor.js\":\"ce61ea2e506d6cd7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/parseFence.js\":\"a702ec349a28ff83\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceParser.js\":\"e5e866d0f2f8071a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceProjection.js\":\"c9072ddef5576581\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referencesProcessor.js\":\"8e6bb74d51f92cd9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/renameProcessor.js\":\"6f50f8c0cc50c5f8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/spanReplacement.js\":\"96ba108d82ad4d77\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/htmlToOutline.js\":\"751c095cf00427de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/index.js\":\"02cd5ab33e942e50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1120424eca0f9405\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/pasteDecision.js\":\"8acfc1b0c64d3966\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/action.js\":\"3deb9756fdffd972\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/blockIds.js\":\"127f9859a61ca9a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/content.js\":\"844dbed5a4258e5b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/effect.js\":\"2834516972183071\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/ids.js\":\"cf446b444c0c418d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/import.js\":\"b07771ffed665210\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/index.js\":\"3fac7019002cb2a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plan.js\":\"9dd6e349fc2e73f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plugin.js\":\"a0ce58a873e0a7ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/promotion.js\":\"461e7f6faf7145f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/properties.js\":\"24a20a4501cd2c1e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/references.js\":\"cd48491a10a2d5a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/report.js\":\"0c9a92a18ef8146c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/roamMemo.js\":\"c9908645e0f67cec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/runtime.js\":\"905daa619c3be8b7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/schemaReconciliation.js\":\"b5b283faad63193b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/srsMarkers.js\":\"ee29447205f45c19\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/todo.js\":\"985ec8076f50ef55\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/typeCandidates.js\":\"eaa955816d101e6d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/types.js\":\"f9fde272483cd64b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/index.js\":\"1a5bef85bdb08b95\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/store.js\":\"9db9f3369175604e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/HeaderItem.js\":\"63345fb13e093099\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3c6a012bd9179987\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/index.js\":\"034607b7c6d99716\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/model.js\":\"f92d10aaaf035533\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/toggleStore.js\":\"81655e3d3fa8b2a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/useKeyInspector.js\":\"eb6cbce71a84b065\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"61094c18ca4c7818\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/ShellDecorator.js\":\"2b6f0ebe8cddb514\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/actions.js\":\"4bbcf29dd2154611\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/exclusionsFacet.js\":\"76a9785ea0b80613\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/index.js\":\"3d0164a8379aa307\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/shell.js\":\"7fabc33a29fe390a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/surface.js\":\"6912530f67e0b02a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/walker.js\":\"7a789d6af39e7175\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6396101fc51b50fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/dataExtension.js\":\"45bebb908d387281\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/index.js\":\"667ba92ccd2fc939\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/indicator.js\":\"0bf3733fb97568f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/moveSrsState.js\":\"c4b4d2becfed8263\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0ab75c7acb8d40b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/scheduler.js\":\"33ee26b30e327eea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/schema.js\":\"8561bbaf04ecb92e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e6ab29a2b2963d25\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsClipboard.js\":\"0c1fdc198f220383\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ef0e67c299c93927\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DailyNoteReviewHint.js\":\"dc7636f74772ba60\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DeckPicker.js\":\"14dbc6ea14573a19\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewControls.js\":\"65a32fd99f45b3e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewDeckRenderer.js\":\"982acb608e065a93\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewSession.js\":\"0a64472c452de902\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/actions.js\":\"15840117cfaba833\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/archive.js\":\"ff7b66da0b9b86b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dataExtension.js\":\"cabdc30f2aac7c24\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/deck.js\":\"c8341d5343cd0454\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dueQuery.js\":\"67bcf3d69eac2494\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/gradeDecision.js\":\"aa4d0486133d22e2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/index.js\":\"ab2cc591af8687de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/keyHints.js\":\"80cd9fdc9ae15a66\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewCardLayout.js\":\"8ec0d638cf28e917\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewProgress.js\":\"2a176aa878b82481\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/schema.js\":\"7e350a36b9717c6f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/useDueCards.js\":\"b82c207b850e15ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/index.js\":\"4768efc614e64bc8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/record.js\":\"9b53069bf8f9d7b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/index.js\":\"14feac327fad65ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/persistenceStatus.js\":\"3c3334641220a75a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/requestAction.js\":\"3d1dc6e5db575b21\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/TypeChipsDecorator.js\":\"0ec6cf523bae9b69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/codeMirrorExtensions.js\":\"e8f60e396b9ee976\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/index.js\":\"6ace28b6045111d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/typeAutocomplete.js\":\"435ac8e10720beb4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"454372d7f65c28f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/actions.js\":\"106d25cb5c2debf8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/anchor.js\":\"d672fdffe2a40f10\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/events.js\":\"11a1d66c6613bc55\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/gestureActions.js\":\"ea43e65c937058df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/index.js\":\"07c7b4e67f0bb74a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cb7e18832dbadedc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/collect.js\":\"8f7105e6ce920c7f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/index.js\":\"14658302af5f5bf9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/record.js\":\"87dd66b464a79601\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/RejectionDialog.js\":\"0c09a0cbde6f5cdc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fd5d4892e653db93\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/index.js\":\"19e7db1d9f6e79a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/model.js\":\"56f61253c6ac4185\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/queueCounts.js\":\"c7a94cd7a14df0f2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rejectedHelpers.js\":\"ba7213daf725a901\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rematerializeAction.js\":\"45a160a532bf37b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/useHysteresis.js\":\"72457415b8e1f8e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/ColumnHeaders.js\":\"7b67205d8b4d280e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/QueryUi.js\":\"d30fb75f3818d9da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/TableLayout.js\":\"843f8a4a57918db2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/actions.js\":\"b8838c7dbf2bb4c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/cellEdits.js\":\"82a4e9fb52e2afbe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/childrenViews.js\":\"bcd1a26bc60ff90f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/columns.js\":\"ae8f5bd75e00fdc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/controller.js\":\"4a7f545721e3aa54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/convert.js\":\"c8897228d6443655\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/dataExtension.js\":\"8adf93922151f81b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/index.js\":\"3864b6c7fe7a6d13\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/keys.js\":\"7d70a21524cd4bdd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/model.js\":\"d723b5f08c79b0ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/backfill.js\":\"76c04439f1197874\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/completion.js\":\"b7d2ffa209755001\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/format.js\":\"5335250310caad00\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/parse.js\":\"8541a7ffcdbda718\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/queryValue.js\":\"29cf837a2f21a5aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/source.js\":\"0f0768e7f06428fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/registry.js\":\"36bbebc2779e17b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowGutter.js\":\"31c75da0f887bfb4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowVerbs.js\":\"6aa4f59ccad050a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/schema.js\":\"ea79398a2d9e13f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/sort.js\":\"96c589fd2b5c9b13\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/effect.js\":\"8ec96efdf59b4a40\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/index.js\":\"3328c8fe40ba9ca5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/theme.js\":\"aeaf1ae0a39068ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/actions.js\":\"2117e7d31bb619be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/dataExtension.js\":\"1334568f809d53ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/index.js\":\"56215fd22374dacd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/schema.js\":\"add8550d4324702a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a3694b0ad6e202c3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/actions.js\":\"15fbb5347c003122\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/defaultItems.js\":\"7001ee5b5abf2ad9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/facet.js\":\"423e6478e5812d36\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/holdRecognizer.js\":\"9ae4d14bb5915f06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/index.js\":\"e0fbcc2edc5a58a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/UpdateIndicator.js\":\"b9c25315374a8851\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/index.js\":\"7e7175692a07999e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/loadTimes.js\":\"98241ad9bc05ec6e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoNotesRenderer.js\":\"38f1f0254e53d915\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoPlayerRenderer.js\":\"6dc0588f9c4dc7a5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoTimeStamp.js\":\"aab65bea8035b21d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/actions.js\":\"b5c982c524443a9c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/index.js\":\"7128ba37d6b410eb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/markdown.js\":\"6fc1c1e43ee95ddd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/notes.js\":\"0292195a479773b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/registry.js\":\"56a31670d80f93aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/remark-timestamps.js\":\"726e35280d636781\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/view.js\":\"bf1e443ac49cde7a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/LinkHints.js\":\"f587b0622405fb78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/index.js\":\"6b85383eacafdd86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/model.js\":\"f46299b18d370514\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/settings.js\":\"540cfc0a61b92d37\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/actions.js\":\"b6084a5ed5f350b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/index.js\":\"426becc89c3d714b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/interactions.js\":\"c159b058e833132d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/workspace-header/index.js\":\"27299ca09b7a14bf\",\"/knowledge-medium/pr-preview/pr-1494/src/registerServiceWorker.js\":\"e1701ab805266305\",\"/knowledge-medium/pr-preview/pr-1494/src/requestPersistentStorage.js\":\"7610b50ff544e677\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authRequestDeadline.js\":\"469acbc59795d6ec\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authStorage.js\":\"2f39fd53f5b6d1eb\",\"/knowledge-medium/pr-preview/pr-1494/src/services/powersync.js\":\"5efd119e640740ea\",\"/knowledge-medium/pr-preview/pr-1494/src/services/supabase.js\":\"c01cdd867ea136d3\",\"/knowledge-medium/pr-preview/pr-1494/src/services/uploadErrorClassifier.js\":\"078e0174d653a6b1\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/ActiveContexts.js\":\"429f86ceb3e60468\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/HotkeyReconciler.js\":\"ec81a8d9379b482c\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/WipeLocalDataDialog.js\":\"d6fc13e21fd7f9e9\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionDispatch.js\":\"2197905ba26428ab\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionRefItems.js\":\"34dc528943e4f75f\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/applyKeybindingOverrides.js\":\"45aa236804adb56b\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockActions.js\":\"19751746a597c36b\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockMergeGesture.js\":\"39e7cd80609857f0\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/canonicalizeChord.js\":\"4701289e5e819c6d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultContexts.js\":\"54ea8b51dad9245f\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultShortcuts.js\":\"e11c66af0471f79e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/effectiveActions.js\":\"a527810120b33787\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureAction.js\":\"1ffdebc4b1ed2bc5\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureBinding.js\":\"b12ca62eacda26a7\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/holdRegistry.js\":\"4c42bda5532a04e4\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingConflicts.js\":\"fcb2bdd75b9efd9d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingOverrides.js\":\"74db7b6191bf1912\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/pointerAction.js\":\"3ccc8945a2b9b6d9\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/resolve.js\":\"58da3ebb7a39d399\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/runAction.js\":\"e171b37e48d02efb\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/sequenceMatcher.js\":\"6798278c8e34f8c0\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/types.js\":\"f87b23cd670046d9\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionContext.js\":\"95c4ae9d0705a49e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionDiscovery.js\":\"bb0b02dfa1d77444\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/utils.js\":\"6df69a899887c513\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/bootStore.js\":\"a05a69abce463a3c\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/previewDatabases.js\":\"661464857c3515cd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/byteTransform.js\":\"78a7196698798969\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/attachmentCleaner.js\":\"c4202afa50b9e0d2\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/attachmentParts.js\":\"5be9f74da8a79403\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleParts.js\":\"499e4bce3c16244a\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleRecord.js\":\"f97cc23a3b28c453\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/manifest.js\":\"88998bf963c20789\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/takeBundle.js\":\"e829ae8f3ccd2524\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/verifyBundle.js\":\"92cd7e738dfa7040\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/cleaningStage.js\":\"fe590bfd70cbb795\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionKey.js\":\"68036f461df15d07\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionServer.js\":\"631de6df43a51f53\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flip.js\":\"36f59f90fa334420\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flipAttempts.js\":\"9f0b5aeeb54d23b3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/pages.js\":\"688544c8485de54f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/preflight.js\":\"3351f3d95c2a084c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/reseal.js\":\"561bd852e0f933bd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runConversion.js\":\"79445498f5332f19\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runLock.js\":\"c3452fdc3bdeb3ab\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealing.js\":\"49baead402bc696b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealingStage.js\":\"256611824786b514\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/stage.js\":\"25f0e41f44189cbd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/verifyReseal.js\":\"5f00feeaaa428351\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aad.js\":\"8d8c71de25b9befc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aead.js\":\"50e606c3f9801d45\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base32.js\":\"43f5e01bf2e42ec4\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base64url.js\":\"60e2e8b2eb1015e0\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/binaryEnvelope.js\":\"f383f1f8e5dce4b3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/byteAead.js\":\"f7fa611c73116ec5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/canary.js\":\"f90dff02dea8a034\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentHash.js\":\"251c4a615a4bae28\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentKey.js\":\"8f2b8bf3609b2e45\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/derivedIdNamespace.js\":\"58413171b8bf20f1\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/envelope.js\":\"0d68fc3380d62f49\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/hex.js\":\"4d8d5c72469e4084\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/sha256Hex.js\":\"f5cf0a878c3742b9\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/workspaceKey.js\":\"b0d0da700c3372c6\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/conversionState.js\":\"451e42768e103c75\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dba8ecbdce28673c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/pastedKey.js\":\"987fac0d78e69f28\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"af3a403d1de1c0c5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/upgradeWorkspacePin.js\":\"21bd797baaaebbd8\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/keyStore.js\":\"9cdfdae53bd229dd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/mintWorkspaceKey.js\":\"0b37cef6ac0281ac\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/modePin.js\":\"41d7403e29982a1f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/openWorkspaceKeys.js\":\"8c60c2534f9d547f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolveWorkspaceEntry.js\":\"c3b9b08f9474f7b5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolver.js\":\"d09c88de416f7655\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/workspaceAccess.js\":\"dd774214b736a385\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/transform.js\":\"b65bef3f47758a3a\",\"/knowledge-medium/pr-preview/pr-1494/src/themeBootDefaults.js\":\"268cb5cb01d6a47d\",\"/knowledge-medium/pr-preview/pr-1494/src/types.js\":\"bc51f651d293fc9a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/ClientLocalSettings.js\":\"6b61236c85830d5b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/abortableSleep.js\":\"cec9f515b8b27509\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/array.js\":\"36fc40e57c3521b5\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/backlinkAutocomplete.js\":\"46916fce6f1fede7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockCrumbs.js\":\"706a51ccca189341\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockrefAutocomplete.js\":\"2e806052eaea1f54\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/cadencedIdleJob.js\":\"15fb167ef78f8ec2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/callbackSet.js\":\"979bc9760e842cba\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/clientId.js\":\"629c511b53b4c5ce\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirror.js\":\"c7b71381fdc8d65f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirrorCompletion.js\":\"a333347709558bc9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/copy.js\":\"2457b38cc0117347\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dailyPage.js\":\"3f06b1ff90ef2e97\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensics.js\":\"739abf6d4c0a9663\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensicsHooks.js\":\"277864e96708d133\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/deleteBlockThroughUi.js\":\"8a1278fad7aaae79\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dialogs.js\":\"9345d11e0c6119b9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dom.js\":\"18266e05848d5436\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/downloadBlob.js\":\"36a6ef58d97ed013\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/drawnWalk.js\":\"d246a63ac4a5285e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/exportSqliteDb.js\":\"0c3c0f7d2117165b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fileSystemAccess.js\":\"72fbd0983c8b25fb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/flipSlide.js\":\"3e0cab113c0e4279\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fnv1a.js\":\"37059c397e2697d7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/formatBytes.js\":\"24f5ce7abc1a7767\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fuzzyRank.js\":\"1c4657b343581e90\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idbKeyedStore.js\":\"0713c8549204f457\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idleCallbackPolyfill.js\":\"6d139d297cf02043\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardAwareScroll.js\":\"bedd4bb72e3a2186\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardViewport.js\":\"f16f8f962e8590bd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/lastWorkspace.js\":\"6c4d5ee6bf3b65a9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutColumns.js\":\"45bb00db361e61f4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionDom.js\":\"86bc91f2c314b0f9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionId.js\":\"1863399431f67cc2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkClickGestures.js\":\"ebad7a2fcdcfa582\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkTargetAutocomplete.js\":\"97294804a8a55f11\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbCorruption.js\":\"a01243ec8a53291a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbRecovery.js\":\"e6236f00e4b638b0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/markdownParser.js\":\"461b34e65639ccc3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/memoize.js\":\"e603bc7a91ae1ed6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameFieldCommit.js\":\"35b3e516d2c99d09\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameList.js\":\"bae8da155e40dc5b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/navigation.js\":\"9dc577863e868ffc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/omnilinerNamespace.js\":\"3aec426eaf34f1ee\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/opfsPageScan.js\":\"13ddf0862c9de02f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelClearance.js\":\"f9eeb6f4d6917820\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelHistory.js\":\"e26c3a3803f6f4f1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLanes.js\":\"932b06f18db6e6a6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLayoutProjection.js\":\"3d37b70c25c64540\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelScrollAnchor.js\":\"ea347e8941728237\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelUrlFlags.js\":\"e3fdabafb0f6dec6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/platform.js\":\"3c8f4af5d208d7ff\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/pluralize.js\":\"76ddacfe346d9218\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyCreation.js\":\"31b7fd509261c880\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyNavigation.js\":\"63636b8c45505427\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyValueContext.js\":\"1c47115d2b143171\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/react.js\":\"2bcb5d79aa005df4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeDate.js\":\"cf8d8ac3a4d876e1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeTime.js\":\"835b674b637d5d84\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/renderScope.js\":\"3eb8c9068c151b08\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/resolvedThenable.js\":\"87a3289fb5c8201a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/routing.js\":\"41d7db679cdbd460\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/safeMode.js\":\"1edb363aaf56cb78\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/scheduleIdle.js\":\"12bafeaa4d24528c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/screenWakeLock.js\":\"405cb71a3f62bed8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/selection.js\":\"6c147b971b810be4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/softKeyboardGrab.js\":\"a3a95ef3c994c300\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/startupTimeline.js\":\"d40583e4a7f233fc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/state.js\":\"32149012d3a52b7e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/string.js\":\"43658537fc246a30\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/surfaceZoom.js\":\"349c97e310225822\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/time.js\":\"409ad1e31d5204ea\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toast.js\":\"f45d93383e783863\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toggleStore.js\":\"3f74274e1140c3a3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/untilStopped.js\":\"f9bc2b104bbc309e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/userActivity.js\":\"4d0a5ebc3d25de65\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewTransition.js\":\"01fdb2ab24f2e4f5\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewport.js\":\"877ccd2c34b56da1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/webLock.js\":\"f410b23849e63624\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceRecovery.js\":\"a7b2c2b181cc894e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceSnapshotStore.js\":\"98111d50b0e7eb94\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-compiler-runtime.js\":\"779a13f0c2b9e72f\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-client.js\":\"875332308de1d308\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server-edge.js\":\"03b070f7a2b7ca2b\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server.js\":\"0f853408862ebad5\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static-edge.js\":\"775cb770d176d0da\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static.js\":\"20c44b4f6be17705\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-test-utils.js\":\"6629e04f4a8f468e\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom.js\":\"96fccb582bcc8e46\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-runtime.js\":\"7e36db95972ce401\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react.js\":\"8f5822082c15a335\",\"/knowledge-medium/pr-preview/pr-1494/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
