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
		buildId: "c268265c20b6-3b6164ca",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/\":\"7b55702998e41faf\",\"/knowledge-medium/pr-preview/pr-1494/index.html\":\"7b55702998e41faf\",\"/knowledge-medium/pr-preview/pr-1494/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1494/assets/FacadeVFS-DDzDoXQb.js\":\"88fb3b82c8f4be76\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSCoopSyncVFS-D6fh1LJ-.js\":\"15272f3165e9553d\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSWriteAheadVFS-BdXFnIdy.js\":\"12d7759f9ba21da5\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-BuYG0Vu4.js\":\"9aef91e3b228c1fa\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-DMahT6nB.js\":\"5a8713cc2d77d753\",\"/knowledge-medium/pr-preview/pr-1494/assets/worker-DruwuQVf.js\":\"558d3c84ce58be64\",\"/knowledge-medium/pr-preview/pr-1494/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1494/chunks/app-D0ruc82j.js\":\"82635af7f6584478\",\"/knowledge-medium/pr-preview/pr-1494/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1494/index.js\":\"a111556f9246e9da\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1494/assets/AccessHandlePoolVFS-czjKvoK8.js\":\"4c6f78150b31ddf5\",\"/knowledge-medium/pr-preview/pr-1494/assets/IDBBatchAtomicVFS-BPlA0-Jt.js\":\"e37f03300ccae2ec\",\"/knowledge-medium/pr-preview/pr-1494/assets/MemoryVFS-BvB6_Ih_.js\":\"f8579640e18927a0\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-BCzro9hp.js\":\"e7cd9ce1b0552bad\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-DM7tM7bE.js\":\"6d3f0f51f90af024\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1494/chunks/AccessHandlePoolVFS-DpYJ2_8G.js\":\"108bfcbdc37f1cab\",\"/knowledge-medium/pr-preview/pr-1494/chunks/FacadeVFS-ChFbLfyg.js\":\"e5f5e0de2ed9bd89\",\"/knowledge-medium/pr-preview/pr-1494/chunks/IDBBatchAtomicVFS-j3qWeuiO.js\":\"411a3e8c17db50f2\",\"/knowledge-medium/pr-preview/pr-1494/chunks/MemoryVFS-CVkz_ttn.js\":\"4986709d0bd01cab\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSCoopSyncVFS-C0tVIeTI.js\":\"8d4c1d6196076527\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSWriteAheadVFS-J0ZA1aTL.js\":\"a81fb0c68e15129b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/Preview-Cx65fIRd.js\":\"cd9950df25e40492\",\"/knowledge-medium/pr-preview/pr-1494/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1494/chunks/card-BmeAxgfa.js\":\"8d8957b1953a6598\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-D3TTERyp.js\":\"39ecfc674cee979b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-CceK_Fdb.js\":\"ed404cb6b108b360\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-async-CwkRYy2M.js\":\"a131ede70603fa7b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BIVvoofv.js\":\"887376c6ba9a2f59\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BJSQOfMm.js\":\"9ac7a14469ac9f68\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BMJDrKMV.js\":\"402c5c4dcff69db7\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-BWSxna_k.js\":\"ec48e08a38d2ea25\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-CH4oN5rr.js\":\"f1d25f93edae7cc7\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-D10-bof8.js\":\"ec52c68d45aa74f3\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DK_qEexw.js\":\"16ceff367c5fe1a1\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-UTqe6Ci9.js\":\"2c522ad6125eb058\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server-legacy.browser.production-DQ_5Ra-w.js\":\"4f9d5cd3a187fde2\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.browser.production-DX8aiJ8Z.js\":\"0d7df6e029e575f5\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.edge.production-BQACYYeI.js\":\"5ade29350c0226e4\",\"/knowledge-medium/pr-preview/pr-1494/chunks/server.browser-Dawt5NoF.js\":\"7c564414745453e6\",\"/knowledge-medium/pr-preview/pr-1494/chunks/textarea-CVe-nyF3.js\":\"6d12297411c5f119\",\"/knowledge-medium/pr-preview/pr-1494/chunks/ui-CjkFUy7g.js\":\"e7e34995b422e406\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-I6WDVGPA.js\":\"7c32fc4ed5607a2d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-async-YGB7qMsX.js\":\"6ee122600e960138\",\"/knowledge-medium/pr-preview/pr-1494/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1494/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/src/App.js\":\"197f56e3b3ce0067\",\"/knowledge-medium/pr-preview/pr-1494/src/appUpdate.js\":\"802272bb70323de0\",\"/knowledge-medium/pr-preview/pr-1494/src/appVersion.js\":\"9e125dc07cd1019c\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/initialLayout.js\":\"aa77336259eac312\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/openWorkspaceData.js\":\"d1c911fdb193ad7a\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/resolveWorkspace.js\":\"7af75a943fcad9ab\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/workspaceBootstrap.js\":\"174393d75fbc740e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockComponent.js\":\"cf81d78250ba246c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockCrumbs.js\":\"1cf0d65defd4663b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockEditor.js\":\"993a40ccd8c9915f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockLoadingPlaceholder.js\":\"4879a3608d13406d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockProperties.js\":\"fd4205d1ade2c127\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockSearchPicker.js\":\"46473a94c3a81502\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ConfirmBulkDeleteDialog.js\":\"f6ee094d53c8d948\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DividerHandle.js\":\"e046d62ad3e6514c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DraftEditor.js\":\"74ae00b19f8eb4a5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/GutterPill.js\":\"2980b8e754919d21\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Header.js\":\"ff281596bd8ea9c5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/LazyBlockComponent.js\":\"ebcc5ff43839eb3d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Login.js\":\"8a4f5fabefb77065\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ZoomableSurface.js\":\"18c9b93705354b12\",\"/knowledge-medium/pr-preview/pr-1494/src/components/editModeKeepalive.js\":\"1f75472dd6c4f745\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9d71a501e98f26f5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"198c9200cf2da851\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefPropertyEditor.js\":\"bf9d9c9c6a226ff8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefTargetTypePicker.js\":\"0ed9418079ba5e71\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/SelectPropertyEditor.js\":\"2a2186d799d7ef46\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/TypesPropertyEditor.js\":\"32838933981347df\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/defaults.js\":\"2b6bfd2875daa8d2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/kernelValuePresets.js\":\"fe18566e8d9e9896\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/selectablePresets.js\":\"f28a6d9796a5721b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/typesPropertyUi.js\":\"7a5aa39cbf2e02c6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/AddPropertyForm.js\":\"3e04e84a2419131f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyPicker.js\":\"bd009a35c7b4327e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyRow.js\":\"2be3c6f41cd5ea60\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/Rows.js\":\"8252af1ec2fae3e6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/actions.js\":\"8601c43cdd1c7166\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/declarationOnly.js\":\"bd34a1414a1870b7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/layout.js\":\"ef868da058ddb6de\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/model.js\":\"9978c5cebd33f0cb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapeUi.js\":\"5ebe83d9846731c1\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapes.js\":\"236d44011c762220\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ca5827d108283368\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/visibility.js\":\"b978fa2b140ecbca\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanelSections.js\":\"98d5b0dc2a28f24a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockEmbed.js\":\"7bc6057c76f56182\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockLink.js\":\"becb287dc89eb208\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockRef.js\":\"52746bf6c833b344\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/ReferenceLink.js\":\"bf42aa9b4205ab48\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuard.js\":\"39f2c065be0a19ef\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuardContext.js\":\"fe9565e1e0b4b589\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/linkInteraction.js\":\"e1017b39a12ad1df\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/referenceLayout.js\":\"91ba13deaa047d54\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/useBlockRefAncestors.js\":\"dee3f6a99123c0d3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockGutter.js\":\"40cd5b22c1727ce0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockInfoDialog.js\":\"6530ae042a52da3f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockTypeBlockRenderer.js\":\"bc2b38ffcc74ffed\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BulletHoverCard.js\":\"29eb69531aaf3c9a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorContentRenderer.js\":\"4583615a173101f6\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0e0428d2c80619bd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ColumnResizeHandles.js\":\"3fd9c282f23bf9f3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"06ef85d8009b2e88\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/DefaultBlockRenderer.js\":\"5b1280e2763e0fdb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/LayoutRenderer.js\":\"85480b1d63b4445f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MarkdownContentRenderer.js\":\"3cd135eaca93f20d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MissingDataRenderer.js\":\"cb01bd7faeb7655b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PanelRenderer.js\":\"f94540ae54a127d3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PropertySchemaBlockRenderer.js\":\"90b9ae45906daae8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/TopLevelRenderer.js\":\"e545ed33c921dc46\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockGutterMode.js\":\"f8803cd99be5b2ff\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockTitleText.js\":\"7a6baf114d5c3864\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/fieldCreationKeydown.js\":\"3f6a9b5a3cc0e4c4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/layoutRootContext.js\":\"5cfaa415e0734dcf\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/TypeChip.js\":\"74c83a45f4b31270\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/chipStyle.js\":\"bbe9b71b2575bf4f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/anchored-floating.js\":\"5bff545c536a7c01\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/button.js\":\"5f269b15526cac83\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/card.js\":\"26c969782b34a142\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/checkbox.js\":\"41d3435b75d5b097\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/collapsible.js\":\"104d376866eaf10a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/command.js\":\"b7b75115007c7c15\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/context-menu.js\":\"74ff991e27b0a4f4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dialog.js\":\"40f3feb73122f36b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dropdown-menu.js\":\"c8cb0862d495a584\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/floating-listbox.js\":\"cb51f4999a031280\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/index.js\":\"bba7f0520be26285\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/input.js\":\"02ce8bf22710e26a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/kbd.js\":\"1d4c2f3d15880de5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/label.js\":\"8c94a0da82f4ac56\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/textarea.js\":\"70cd7421cb4e04e8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/useEditModeYieldKeepalive.js\":\"4efae78353c42cec\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/BootFallback.js\":\"4d34b256b31262c3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/FocusedRowLazyMount.js\":\"85ca125ee110f642\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LazyViewportMount.js\":\"2197d3cddec61030\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LocalDbCorruptionFallback.js\":\"3f64e976dbd8437b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/error.js\":\"214f1277d2753105\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/lazyMountRegistry.js\":\"e216b92f03c7006c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/suspense.js\":\"61ff2bc1d09d16f9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/CreateWorkspaceDialog.js\":\"35cb2ae6e7201213\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/PendingInvitations.js\":\"69d588fe0fcff4fe\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/SyncProgress.js\":\"744d1fa64b41a0c0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/UnlockProgress.js\":\"03d34ca5cded6d9b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceKeyGate.js\":\"85275b993654edde\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSettingsDialog.js\":\"c506ea1680c94591\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSwitcher.js\":\"8e5b0f77c5c186ae\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSyncGate.js\":\"05b09687ecc0eb47\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlow.js\":\"a285f48a6407066d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlowHost.js\":\"5e2c307dc0098fef\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/EncryptionSection.js\":\"efbb2388a324364a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/attachmentPrompts.js\":\"9023f2c079081b2a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6c579dac8b766b51\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowDeps.js\":\"4b2811e7d2cd2ea8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowStore.js\":\"91c1511f6143f11f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/flowUi.js\":\"98e4d0065f8c6907\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/useConversionRun.js\":\"e6f6c5540817d9e9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/keyUi.js\":\"619de9476422c3d5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnKeyLoss.js\":\"d6b9b423e2c32851\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnServerE2ee.js\":\"7d27e9678e1e4c4e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/workspaceUnlocked.js\":\"0997773687b02dbb\",\"/knowledge-medium/pr-preview/pr-1494/src/context/backgroundSubtree.js\":\"5fe831fec6d69be6\",\"/knowledge-medium/pr-preview/pr-1494/src/context/block.js\":\"8a012b20ca5371f1\",\"/knowledge-medium/pr-preview/pr-1494/src/context/layoutWsContext.js\":\"71812ac74c95ff00\",\"/knowledge-medium/pr-preview/pr-1494/src/context/propertyDisplay.js\":\"2154fa87e3d57382\",\"/knowledge-medium/pr-preview/pr-1494/src/context/repo.js\":\"6af957140485c73b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasClaim.js\":\"c4a48e5f836e863f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasSeatNamespace.js\":\"b679cd52459f6ee7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockData.js\":\"88f663ae1be09a26\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockType.js\":\"c18c704b64b8ad1d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/changeScope.js\":\"ce59140cb0f10e00\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/codecs.js\":\"2e919bc3d10b8874\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/derivedData.js\":\"8301eb2db3acef7b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/errors.js\":\"fe9c948322fbbebe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/events.js\":\"b8bc9ca653512d81\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/handle.js\":\"9dcecb4dc42b15d8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/index.js\":\"7c7af171c9d01050\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/mutator.js\":\"0a4ccfd929865384\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/processor.js\":\"6148e301d55a75a7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/propertySchema.js\":\"5a3783215ff98db9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/query.js\":\"d830443a78116fd4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/sameTxProcessor.js\":\"82b7cfb183490e61\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/schema.js\":\"9dcecb4dc42b15d8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/tx.js\":\"9dcecb4dc42b15d8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/typedBlockQuery.js\":\"478adc4af0d63741\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/user.js\":\"15742bdea7e0628e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresetCore.js\":\"e57d509786ba9ccc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresets.js\":\"0b7977d600a4c294\",\"/knowledge-medium/pr-preview/pr-1494/src/data/attachmentCleanerIOVerb.js\":\"772abcf6c4903583\",\"/knowledge-medium/pr-preview/pr-1494/src/data/block.js\":\"ef59b7b6f43bb7f5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockCache.js\":\"aa6ff72692401673\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockId.js\":\"006cc3c2c777ecf1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockLiveness.js\":\"b0e7f86d9e00f8b0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockMerge.js\":\"707b7ae237a01403\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockSchema.js\":\"8d03fee1002301f5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypeLookup.js\":\"ebd229328277cfe2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypes.js\":\"e12b9f7b0c167796\",\"/knowledge-medium/pr-preview/pr-1494/src/data/childrenView.js\":\"907713b6e456ac21\",\"/knowledge-medium/pr-preview/pr-1494/src/data/clientContext.js\":\"2983b46a86c3dd03\",\"/knowledge-medium/pr-preview/pr-1494/src/data/dbFileSiblings.js\":\"9df398e637865dd2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/definitionSeeds.js\":\"ad7013804b49b838\",\"/knowledge-medium/pr-preview/pr-1494/src/data/derivedIds.js\":\"914b047b6f37fdfb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/drawnSubtree.js\":\"bf106e2953e36447\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facetBridge.js\":\"1a596bd326a791be\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facets.js\":\"48d92ba8ba5a3537\",\"/knowledge-medium/pr-preview/pr-1494/src/data/globalState.js\":\"260d27f2089623d1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/aliasClaimRederiveProcessor.js\":\"e5c954cc74c81b7f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/ancestorBatch.js\":\"b15e57ea110c88ad\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/blockTypeTypeifyProcessor.js\":\"1a10592ac0ea37d9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/clientSchema.js\":\"04f23dcbe3067618\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/commitPipeline.js\":\"ebca5316c2e72c7e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/devAssertions.js\":\"59e218d163db726d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/firstSync.js\":\"0e13ff63a8be36c2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/freshInitialLoad.js\":\"b24a3d41534dd73a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/graphBackfillClaim.js\":\"a1482a964528bb69\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/handleStore.js\":\"fee49aa086843640\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/idleMarkerJobs.js\":\"88597836538a07f0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initialDownload.js\":\"8939ed0b1d1bef1b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initializeClientDatabase.js\":\"f4d57bfe62fd6f48\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/jsonCanonical.js\":\"5a8a0238295bf6d3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelInvalidation.js\":\"a6869f02cf05adc3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelProcessors.js\":\"72296d9be803f438\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelQueries.js\":\"13482047bb61e18d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/mergeTypeMembershipProcessor.js\":\"576ae6b3f81fd56f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/normalizeReferencesProcessor.js\":\"f0b978b64d44a206\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/poolInstrumentation.js\":\"dc63f64f276b2ed8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/processorRunner.js\":\"c9d8aebec8cc899d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyCellBackfill.js\":\"fe147330ccc0e754\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildMint.js\":\"60d4ac5fcdab8a39\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildrenProcessor.js\":\"ae08494ddf1667c1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4556d519e2223eab\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionSynthesis.js\":\"c10bd646702cf58b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyKeyScan.js\":\"43c96e608ccc56fb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertySchemaResolution.js\":\"ded5739076dc1255\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyValueEdits.js\":\"dd73cdcb899beab6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/raiseProtocol.js\":\"afc96b985c897ebd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/readBatch.js\":\"fe79af49de0c36ba\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/refProjection.js\":\"89c21161931a6bed\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetLookups.js\":\"73dccad6f0b58249\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetProcessor.js\":\"cf6626fd3e98af0e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/replayMerge.js\":\"cf3edc90594e5cfa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/sqlBinds.js\":\"eba91611ecc8e3f5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1dd27867c12eacaa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/arrivalProcessors.js\":\"3334ef4478952c01\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/invalidate.js\":\"1d22f440062c07b8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/materialize.js\":\"6adecc35ad306600\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/observer.js\":\"fe3fff6864bba871\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/reconcile.js\":\"1e6c8239cc268869\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/timingMetrics.js\":\"8e004148e33af126\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/treeQueries.js\":\"5cf6fb928d4fdd61\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txEngine.js\":\"c81ad1fbc1670fdc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txSnapshots.js\":\"39b8b4e62df26d9e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/typedBlockQuery.js\":\"69035aab8d2cf94f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/undoManager.js\":\"6cc4ead6a5777b78\",\"/knowledge-medium/pr-preview/pr-1494/src/data/invalidation.js\":\"bbe36e50eee469b9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelDataExtension.js\":\"cc3de4acec4c5d1f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelPage.js\":\"7da018334c546760\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelValuePresetCores.js\":\"0aa4632aa12e1223\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbCorruptionSignal.js\":\"79a2573749bd4bc8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbStorage.js\":\"29fda0f49e17326e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbVfs.js\":\"74cf855a5450d739\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localSchema.js\":\"f1b2e329e924299c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/maintenance.js\":\"0e0d96f92032003c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mergeProperties.js\":\"6d6977378e8353f9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/metricsConsoleHook.js\":\"5dffc3f878fa3ab7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/migrationsPage.js\":\"0fc29d14ce1b0873\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mutators.js\":\"381226d190fc179f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKey.js\":\"32d5bd71eea89202\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKeyPlacement.js\":\"a010f24201a1af8e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineGroupGestures.js\":\"f50184ba790281fd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineSurface.js\":\"4d45f1c5091ee7f7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingEditorContent.js\":\"7b7ed228365a5874\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingUploadsSql.js\":\"644f2034216dd8cb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pluginStateExtensions.js\":\"7a1d8b521d11746f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/powerSyncLogger.js\":\"b04a1c9a66f19e02\",\"/knowledge-medium/pr-preview/pr-1494/src/data/projectorRuntime.js\":\"f9a6cc06a30dcc66\",\"/knowledge-medium/pr-preview/pr-1494/src/data/properties.js\":\"7021a21bd42cda9b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertiesPage.js\":\"87daf22651d3ebfd\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyChildren.js\":\"58b4556eea021c55\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionFanout.js\":\"908ba34a1a20ea7c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionMetadata.js\":\"38e1578ee867aee6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionRegistry.js\":\"b860fe6cf68f7cc2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDisplayMode.js\":\"34e0f8c4f45badc1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyRowCreation.js\":\"ef91bc845b077252\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySchemaCreation.js\":\"8a156b24343b51b0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySeeds.js\":\"6103bdb2dc69a63b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/recentsPage.js\":\"1952ef135d142b6f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/referenceBlock.js\":\"08766b2c0244e596\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rejectedUploads.js\":\"36b26a58ad096f7a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/releasePowerSyncConnection.js\":\"c0bbe4bf25c90497\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repo.js\":\"e12d1e723a59ced8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repoProvider.js\":\"7078a3abf589e5cf\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rowProperty.js\":\"5a1e43020e9e0868\",\"/knowledge-medium/pr-preview/pr-1494/src/data/searchFilter.js\":\"2eb9123f3910486c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/seedIdentityLedger.js\":\"542f432062d9b418\",\"/knowledge-medium/pr-preview/pr-1494/src/data/stateBlocks.js\":\"5872e7b5961d407a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/structuralEditPolicy.js\":\"ac3c233f469c1102\",\"/knowledge-medium/pr-preview/pr-1494/src/data/subtreeDelete.js\":\"a2d15f584e47ed47\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncStreamLock.js\":\"87a1b05712eb27af\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableSqlRecognizer.js\":\"3a20f5c3ac2ec42a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableWriteGuard.js\":\"49d020c20d4bddf2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/targets.js\":\"64f77dc3011f8630\",\"/knowledge-medium/pr-preview/pr-1494/src/data/treeOrder.js\":\"4fb06a634a2f9fcb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeColors.js\":\"4f845081f0872537\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionMetadata.js\":\"3966a67da1963049\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionRegistry.js\":\"f7ffeb5e80f8e525\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeExtraction.js\":\"f9051b286e478359\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeInitialValues.js\":\"c4f43df6e3cb8d08\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typePropertyGroups.js\":\"ddd28f74c3545cb9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeSeeds.js\":\"37285914604b052c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeTagger.js\":\"6905e0d543afe5a8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typedRecords.js\":\"51dd2148a9f956e8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typesPage.js\":\"0d7b69925c171f05\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userPrefs.js\":\"02364b7b69e49b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userSchemasService.js\":\"fdfaed8739526268\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userTypesService.js\":\"37eed116c5108f02\",\"/knowledge-medium/pr-preview/pr-1494/src/data/valuePresetRegistry.js\":\"183d6dfb2110976d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/visibleChildren.js\":\"55ccb37c7897f41d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceConversion.js\":\"9a03decdbe5a8180\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceFirstSync.js\":\"8cd636e5ad4353c6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceIdNamespace.js\":\"66a6bed2ec4c9c05\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceSchema.js\":\"ab93fbfc5114132d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaces.js\":\"5be4c586ec6880ce\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadLog.js\":\"191c7a2f1539cbf6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/BlockPasteShellDecorator.js\":\"b63489bfbf0adc9c\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/atTrigger.js\":\"9ea56681214ee407\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/autocomplete.js\":\"92a262c7ed506ba4\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/codeMirrorExtensions.js\":\"d6e56bd709ade7e2\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/contentFlush.js\":\"a3dc46184af1ff2b\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/defaultInteractions.js\":\"e813900f35cb04c8\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/editSettleSignal.js\":\"adfb8df094dd5435\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/insertImage.js\":\"bd45b10ca727ac13\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceCompletionRange.js\":\"27f0abe475d91668\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceTargetTypes.js\":\"da56307764a9e246\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/syntaxContext.js\":\"fa63cb2933cfe3a6\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/triggerMatch.js\":\"2777b6c2ae7c4815\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/AppRuntimeProvider.js\":\"a43e9c35847128ed\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/BlockFocusShellDecorator.js\":\"5d08b5f276b473f0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/ExtensionRenderBoundary.js\":\"41514618a38f7bf1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/PanelContentRecovery.js\":\"c5bbbaf3491ebde9\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/apiCatalog.js\":\"1344a265eff5c87c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/approveExtensionHere.js\":\"c154532138c89b45\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/armedCutAppMount.js\":\"8f805c56ed765153\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/batchableKeyedStore.js\":\"91339c23c3ccc2e1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockInteraction.js\":\"9e0d3c1c1c435a78\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockSelectionAction.js\":\"6e796394bcb73d93\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compileExtensionModule.js\":\"ed11c22752aa66d1\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compiledModuleCache.js\":\"061c0e43ee27af8d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/continuousGestures.js\":\"94eac38e074684f4\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/core.js\":\"66035ed7650b313b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/defaultRenderers.js\":\"6863cb807b705124\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/definitionFanoutAppMount.js\":\"4983257ea18bc5e8\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dialogAppMount.js\":\"5db7530f4c047a82\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensionSeeds.js\":\"6bd20978eb0e0218\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensions.js\":\"edbf3f2174d78199\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/exampleExtensions.js\":\"d8d4dec819df74cb\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionApprovalStatus.js\":\"45cb3fbdff4f5358\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrorToast.js\":\"c58c4bbf946e9abc\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrors.js\":\"e4cd83ad07b31d95\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLookup.js\":\"ea3eb9c061465bc6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionToggles.js\":\"e319bdc543f20293\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionUtilitiesCss.js\":\"73b5bb510edecda3\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/kernelPageDeletionGuard.js\":\"36063400077ff4dd\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/liveRuntime.js\":\"8a183db28c931ef6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/openExtensionsSettings.js\":\"c707a3acc1ce9574\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/overridesCache.js\":\"2b612ac147646b78\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/pluginIds.js\":\"3e39f43b10ae7881\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/processorRejectionToast.js\":\"40962b3970b24d62\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeActions.js\":\"47b0018a065c81fc\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeContext.js\":\"f2db8176fe7cc7b0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticAppExtensions.js\":\"6df4b6ef0a060494\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticDataExtensions.js\":\"c8334ea5aa55583e\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/toastAppMount.js\":\"2648406be9f190de\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useOverrides.js\":\"f02e3cdb9844810d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useShortcutSurfaceActivations.js\":\"502988dd8f347578\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/discoverToggleTree.js\":\"6f17fd6d8c379a41\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/facet.js\":\"a4da8f471f5aa809\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/resolveAppRuntime.js\":\"ed31ead6db9fab7f\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/runtimeEvents.js\":\"f43de5acd527c500\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/togglable.js\":\"1d866d1424f1de56\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/variantFacet.js\":\"2dc3402c5699665b\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/verbFacet.js\":\"b8daadd2a8053f9a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/block.js\":\"9d9089942d2e73af\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/focusedChild.js\":\"e721483d9c00fb93\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/propertySchemas.js\":\"d3a96ebde34cbce0\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/typeRegistry.js\":\"134b40459ae738ba\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAncestorCrumbs.js\":\"c49971108757fb9a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAutocompleteListbox.js\":\"1b060c9ce3dc61a3\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedSearch.js\":\"3f10753987f5ab29\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedValue.js\":\"c30ef91a1eba1985\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsFocalRender.js\":\"aedf1482cd1f3823\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsReadOnly.js\":\"0ddc7f2d7b77b5fd\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMaterializeBacklog.js\":\"10befd8eef1978a8\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMinuteClock.js\":\"d958500c1488070a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePanelLayoutProjection.js\":\"471d3f2d07045fdd\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePendingInvitations.js\":\"95ecc44df560ed0a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRendererRegistry.js\":\"ed23e1e494f62553\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRetainedFieldRows.js\":\"19f840aabb232712\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useWorkspaces.js\":\"29456ce086ce69a9\",\"/knowledge-medium/pr-preview/pr-1494/src/lib/utils.js\":\"01b269cbb9a4d564\",\"/knowledge-medium/pr-preview/pr-1494/src/main.js\":\"3dc1f2a5831b4aeb\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/MarkdownImage.js\":\"8d7f104ad7693005\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/blockSeparators.js\":\"f8fa84701e615135\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/context.js\":\"322692ffc4425dda\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/defaultMarkdownExtension.js\":\"555ad00f82d3dec1\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/extensions.js\":\"a1c825e58d778f06\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/renderMarkdownHtml.js\":\"d26924d54551a0c6\",\"/knowledge-medium/pr-preview/pr-1494/src/minimal-editor.js\":\"d9a9dce3956fb282\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/armedCut.js\":\"9c3a2c2325884794\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/captureMediaVerb.js\":\"3b982ad82c4bbedd\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/clipboard.js\":\"e4a8f9824fb2f106\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/decision.js\":\"301d2c9a518c0770\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/operations.js\":\"dd833602718b037c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/AccountHeaderItem.js\":\"b04464e331cf4432\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/index.js\":\"b0cdb7eac1934ff4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d49682e2f29227a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askAgent.js\":\"bf41d69508945bcc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askedStore.js\":\"b46103935e9cb098\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8fd55fa19de84af4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/chipState.js\":\"6f999589b3a326bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2ed215d05f05b639\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/index.js\":\"2e64451798b47f91\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e7d8c14fc351f689\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/schema.js\":\"4b8ffd645407c08c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/AgentTokensDialog.js\":\"80f2b6275ed1ac86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e1fc55f8bb80d6d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/addMedia.js\":\"06ad67affce2a140\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e3514e9894d8f178\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/block.js\":\"b651d0f226af5fa2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/context.js\":\"c0d048ccad46ac95\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3aeb44ec093957cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/index.js\":\"b2537fc21a4a45ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/outline.js\":\"14d6dbe58577838c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/properties.js\":\"62b17ebcb9a380fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/refs.js\":\"b528ac8bef3c1cdf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1967e81d7dc21b13\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/search.js\":\"c14ddaa5b99629c3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/shared.js\":\"943a5bc2f4a8f12a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d52b4818eb8a06b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/text.js\":\"fb771d7e33ea7b38\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentWrites.js\":\"5cb4dbd396dd9a72\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/authoringCatalog.js\":\"85883c8e7c7c634f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/blockRefTargets.js\":\"81c8532abfe96f60\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridge.js\":\"4f75989be7382455\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridgeLoop.js\":\"c083254e8bc74843\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/changeHistory.js\":\"b0a6e971b4a19f9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commands.js\":\"09c68f3ef46af5bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commentsCommands.js\":\"dd42ee019ca7b89e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataExtension.js\":\"a2297b80fc542530\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataModelGuide.js\":\"02b73f9c6eaaa7ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/describeRuntime.js\":\"a64e43664b9baec7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/extensionLint.js\":\"9168743299cb61d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/grainAudit.js\":\"9109c8f4b7481269\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/healthCommand.js\":\"fe9971a8f9c66002\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/index.js\":\"bb61eb3e0f138c57\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/presetIdentity.js\":\"20afbdcc22987c6f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2fb8c2176757f3cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/readMedia.js\":\"263107ce617cfb3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/schema.js\":\"4a290fac3156fafa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/serialization.js\":\"12184ce71bd762ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/targets.js\":\"bff506bf747ff4df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/tokens.js\":\"a58adae2e6138a5c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/watchEvents.js\":\"fe940bff77cae01d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/workspaceGuard.js\":\"c2ac73c73d9ce940\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/writeCommands.js\":\"75f40c919074c7ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/AliasCollisionToast.js\":\"5f1f3d54e7485f30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/DuplicateNameBanner.js\":\"45f0a9829eb58375\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/collisionMerge.js\":\"c329e8b475dde230\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/dataExtension.js\":\"d7b6131a69db36ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/index.js\":\"7bd7f10a322de16a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/mergeCollisionAction.js\":\"1ad6a99b3b95395f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/pageStyling.js\":\"108d6fc2ed5b5c0f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/rejectionToast.js\":\"304c5020e88682e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/syncProcessor.js\":\"f1324675b8a9b594\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/actions.js\":\"72b8861c41ed853e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/addComment.js\":\"867b3019235ebfff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchor.js\":\"c2a9e42805d8c00c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchorState.js\":\"49946debb9c85898\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/commentLinks.js\":\"415f55b5c509d00c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/confirmThreadDeletion.js\":\"091e0679709119f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/container.js\":\"532df901d1aa6e63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/dataExtension.js\":\"c02fb217800b8d9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/deleteComment.js\":\"8728df9eced24355\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/highlights.js\":\"7ef493cad099b69a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/index.js\":\"2464715bf395e7a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/linkedCommentsPill.js\":\"0eebaa05ba766f22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/margin.js\":\"ea1a1418e4eea1a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/marginSchema.js\":\"741d97bb45b36388\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/newComment.js\":\"aa6fdb76141e1917\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ownThreadPicker.js\":\"b1a0421a989924c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/placement.js\":\"c40d3368b3dc38ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/queries.js\":\"6b71800d8e8acb7b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotePosition.js\":\"a87dec89ddda0f5b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedIn.js\":\"93aa566b53042505\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedRange.js\":\"69bd190decfe6998\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/rangeRefs.js\":\"7c7bad587bd12224\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readHighlights.js\":\"88c3a5062f58f41c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelection.js\":\"65d232b4f64fe527\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelectionUi.js\":\"ea06c3d12c981100\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/reanchor.js\":\"cd5f4b517de918aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/schema.js\":\"e3715fb72db03d36\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scope.js\":\"94890455bdc41b4f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scopeThreads.js\":\"d0f75c4a5b238c58\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/splitRetarget.js\":\"c2697a40c36dd5b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestionCard.js\":\"4c7d4b3ec8eed6ab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestions.js\":\"82a758655c1b86f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaries.js\":\"a67324b9fdfb737a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaryBatch.js\":\"83d5c13b6915a484\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/surface.js\":\"13480458449db9ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threadNavigation.js\":\"07cdeed82e4d0940\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threads.js\":\"41b28d4b7414310e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ui.js\":\"4c4b4da658d6ae01\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/uiStore.js\":\"9d75ed3efb6ecfa7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/appIntents.js\":\"94936394e812789c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/index.js\":\"967359bba552e42e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/index.js\":\"f4f977c696cdf2bc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/status.js\":\"e0f828ef63a1815a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f5c9c848b8528651\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaBlockRenderer.js\":\"c29443d6fb2ca093\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c3a5fc57d752f31b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaUploadReconciler.js\":\"9b49fd473e3d160a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetDownLane.js\":\"63f04e8509a12c42\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetResolver.js\":\"429d60e0f07a8b4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetUpload.js\":\"4598f0eaaef0e45c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/attachmentCleanerIO.js\":\"c6033b250d90355e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a6182053b8408fa4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/blobStore.js\":\"235c0a5d625d9930\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/browserMedia.js\":\"cc09c46c40066a69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/byteStore.js\":\"5e3827c38efed51c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanerIO.js\":\"a999055fb5b63cb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanupAttachments.js\":\"da8d8ab88ac3e560\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/dataExtension.js\":\"45c67085a628e031\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/downLane.js\":\"77909c21d551c699\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/index.js\":\"d0e5d109e8430d9c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/insertImageContribution.js\":\"be84cd6a80f6df62\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneArming.js\":\"3335857a3149379d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneLock.js\":\"6ff6f03d41b54d87\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaBlock.js\":\"00fc72663adc8942\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaCapture.js\":\"94538e67b048b4a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaLanes.js\":\"ff543954207959cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewers.js\":\"b0a8e2a369685d05\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewersFacet.js\":\"069c9614d89dcc9e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/pasteCapture.js\":\"e196baf683abd72d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/resolver.js\":\"9f8b75e641bac6a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/retryUploadsAction.js\":\"1233531c73ef8518\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/storagePaths.js\":\"364e6674fb7c3c28\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadDrain.js\":\"592d84a5159a9287\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadLaneStatus.js\":\"d37df572ee661676\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadReconcile.js\":\"a8cfeb04717550ea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadRecovery.js\":\"7ca8c8e72de3dd82\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadStore.js\":\"9900337c4b5eaae5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/useAssetObjectUrl.js\":\"e98cadf243b36a47\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"445577dcd5051fcf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7951038b9002b2dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/facet.js\":\"31f65500dfb96501\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/index.js\":\"1f1882d669ba576e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/prop.js\":\"30ca586fa1dcbc09\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinkFilters.js\":\"d6ab08df6676de14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"791ac9f4057c9785\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BlockEntry.js\":\"e4f61a1d13882781\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/LinkedReferences.js\":\"b53959afba21277d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0dff9caf76f1d51c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dailyNoteDefaults.js\":\"6c0ceb246c983ff2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dataExtension.js\":\"8ea1487cb0b37fe5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/edgeExclusions.js\":\"964b3b0a58be45da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/filterProperty.js\":\"d260289a2b5e599e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/index.js\":\"acade1facfad69ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3459c1d6d4c3b4d8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/applies.js\":\"837a6058388beb2d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/countQuery.js\":\"9d0bd7b306516ddf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2bd48cb892f8e338\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/index.js\":\"75f2c8681379b853\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"30dca22d7f710ca4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/presentationInvalidation.js\":\"fdc71fb5f339c1e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyEditorOverride.js\":\"5c9e117c20b1e989\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyFilter.js\":\"d68154eef089cc68\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/query.js\":\"776d4a2d5416c3ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/resolveFilter.js\":\"02db591ad323e5f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sourceBatch.js\":\"335b1d7babfa6e9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sources.js\":\"85ad741e21b3fa4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useBacklinks.js\":\"f3c09288c5620625\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9e186c92ad1c5875\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayCelebration.js\":\"b06ca8dc1245dfed\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayOverlay.js\":\"f101d9be7d700cca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/gate.js\":\"317179a3b3358901\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/index.js\":\"858b6845005e1d4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/wolfTheme.js\":\"6f945e963ab0491d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/BlockDragLayer.js\":\"a852f59e636b8a27\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dragController.js\":\"496deda930406b41\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dropTarget.js\":\"76d0faae5b7cb58b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/index.js\":\"0bc6dc76ad1cb57d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/projection.js\":\"17c4d4ce1c0ed876\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/BlockMetaCard.js\":\"44e791a3e4d9cdef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/index.js\":\"d4fac3e70372873a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/AddTagDialog.js\":\"28ded1162f33148e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a1665877512540d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/TagNameIssueHint.js\":\"8a9df1a5e3ffd387\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/addTagAction.js\":\"3145e48e917205a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/appendTag.js\":\"8014ef059a3709b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/config.js\":\"c3458f7e035f69d2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/dataExtension.js\":\"883a1dab45e5313e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/index.js\":\"7e796d8643f0979a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/propertyEditorOverride.js\":\"e098c051be4833b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0b9a304276ecc507\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"125242bfbe27dbb4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/Breadcrumbs.js\":\"85b491258a5fa543\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1ed5b152bfa929a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e053087d2562cb4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/index.js\":\"3a64f2ec7b821a28\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e3e420261b043868\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/CharacterCountItem.js\":\"1df893e5ee1986b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a43c752f4378d287\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/actions.js\":\"fffa4677342969cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/blockType.js\":\"bd9b64c71e94a90a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/charCount.js\":\"017c7febfbe19e97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/dataExtension.js\":\"ba54476f2ae809cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/index.js\":\"88c5e6e4efb969d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/profiles.js\":\"25ddef2731036641\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/properties.js\":\"fe5b54093813b6ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/textCounts.js\":\"982dcf47e99db778\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/colemak-keybindings/index.js\":\"b5c66d38b0fc3b56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/CommandPalette.js\":\"fd8d5b03ad5020f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/HeaderItem.js\":\"91dd61b89756c767\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/context.js\":\"3fbe9e016e5acf20\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/index.js\":\"ffa8749a9a57809a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/selection.js\":\"0cdbd75543f4c819\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/toggleStore.js\":\"364db1e8aaaf75bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/useCommandPaletteActions.js\":\"222287666e32016c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/ContributorBadges.js\":\"673a2f3107d68d78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/author.js\":\"d7651edb1235bd7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/codeMirrorExtensions.js\":\"c8d8959f66b49254\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/dataExtension.js\":\"93c45459e71b91f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/index.js\":\"c974cbdb23779d4b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/mentionAutocomplete.js\":\"b273fc6ad4f4e068\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/processor.js\":\"5afdc3859f1710ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/profiles.js\":\"1c7cd133cbd58b17\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/queries.js\":\"4244f99d51a9a285\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/schema.js\":\"4defff1c61dc54f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"05538a37b23c8e22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c4fe1ad5230c0c89\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/index.js\":\"256ee634ee568881\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"13b1676dbde860f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cd44a7df5c39325f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/CalendarGrid.js\":\"bd43691bb4aaa9e2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DailyNotePicker.js\":\"71fdc8ffcc7438a5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"daa34564b2887cf1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateNavDecorator.js\":\"5f97da81482ef222\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateScrubOverlay.js\":\"f4cbd3454600b31d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/HeaderItem.js\":\"bd9988860e4cce4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/ReschedulePicker.js\":\"ae011ffeeef9cae9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/SpreadDatesDialog.js\":\"968416dcabaf245c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/actions.js\":\"e206c46317475363\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/blockDateAdapter.js\":\"2da5286286939c5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/calendar.js\":\"923acb304383eb2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dailyNotes.js\":\"e0a2477e525fd956\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dataExtension.js\":\"16a81ec9c9972674\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubActions.js\":\"0c92f17fd289c6b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGesture.js\":\"3cddbbdbc11c8c19\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ddd0963baa405d0d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubRecognizer.js\":\"88cd2005d35ae480\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/deletionGuard.js\":\"650e6598ead765c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dueQuery.js\":\"7952c57dd8f2fe78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/index.js\":\"1795a0afdebd7c18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/landing.js\":\"0f6af83ad7bdb122\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/localSchema.js\":\"9dc05cceea0b51b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/referenceDateAdapter.js\":\"d72979d452dbf9f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/rescheduleAction.js\":\"6d2f14f255793fcd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/schema.js\":\"2f42cf4d7d22a5f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadBlockDates.js\":\"0fdc89d8e5e9ce3c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadDatesAction.js\":\"fd86e4edd3824a74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/today.js\":\"457952bbe1cf7e18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4ce02d7db9f1b26f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b872f8d2aa7568df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/audit.js\":\"828e130ede9783ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditAction.js\":\"623e17355883d931\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditRanges.js\":\"2ec928beeaf2166e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/diagnosticsSource.js\":\"69b4ac4aa11bb2fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/divergenceScan.js\":\"e1c16021e081694f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/index.js\":\"d6371a04cc7fabc0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fbc36240cf852853\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/referencesMirror.js\":\"445be26b0a96a4a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/rowJson.js\":\"9fbb3bead0e0e0aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/schedule.js\":\"5401ce004b580186\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/store.js\":\"15a1f2a4dd4ef85b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/action.js\":\"c783e25a1c8e9854\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/index.js\":\"b606a7d99be13bdc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/plugin.js\":\"4badf2ce98e3d4c8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"129ee69f9b2714e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/actions.js\":\"057a915a2052a909\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/changeMarker.js\":\"837031793ca620b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/diagnostics.js\":\"11353f5d0b99c93d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/fileSystemAccess.js\":\"384467ad0484fd16\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/filenames.js\":\"092d188f6f3a5115\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/index.js\":\"90984b5d7569baad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/mirror.js\":\"ad2ce62f993877c0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runLock.js\":\"b28ef7a0736fed37\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runtimeHealth.js\":\"2a222290b8aab9f1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/schedule.js\":\"b98f3b52d17601b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/store.js\":\"77b718c452eff603\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/index.js\":\"320e06480f91e405\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/themes.js\":\"948fa957a94a6252\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/facet.js\":\"6b93c805ea835a41\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/useDiagnostics.js\":\"a16740aa634a1e22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/dismissals.js\":\"7f71e20da41ab4e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/index.js\":\"011ecb992b912460\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/status.js\":\"0ff572eb86942fcc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/store.js\":\"bc2ef4a9b342c690\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0c8a54fd146f3d1e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9513f0dc76f83f0e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/actions.js\":\"d68352146033f1b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/config.js\":\"b69e1a5bafd26e7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/dataExtension.js\":\"01b5a7236203c985\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/effect.js\":\"36a52c840c72f132\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/index.js\":\"ab7f4583c675d9e5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8b5efe8a0979dd5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/useToggleTree.js\":\"bfb2951f1bcdfe39\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/ExtractTypeDialog.js\":\"69c70e7f55b6f848\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b7cc47a980274ca4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/PropertyShapePicker.js\":\"3ab42a417900e38e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/action.js\":\"7379802a7c9f5c10\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/index.js\":\"fe96c88b53f2fa5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/FindReplaceDialog.js\":\"a4a4c54e0bf924b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/HeaderItem.js\":\"0bd35711c8b7bf81\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/dataExtension.js\":\"0dbb7128bebd31e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/index.js\":\"f0e5e7edd9197e32\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/search.js\":\"641edf1c81a901cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/toggleStore.js\":\"0ece9d8e8e895d11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/LocationPropertyEditor.js\":\"1e6e8eaa27066f69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/MapView.js\":\"0f083b820fc75a2d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/blockTypes.js\":\"a562676d259c527d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/codeMirrorExtensions.js\":\"e36de15610b46eef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/createOrFindPlace.js\":\"35d1fe8f67beebf6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/currentLocation.js\":\"36fd2dd1d7866728\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/dataExtension.js\":\"40172aa0568f6b27\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/geoContentDecorator.js\":\"01eb155d5d5f2646\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/googlePlacesClient.js\":\"a5d8c73d77be1ce0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/index.js\":\"6ad194ea095eee16\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/locationsPage.js\":\"1f7a702f5d3e08e9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/mapViewport.js\":\"42554f6ea352e70e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/pickCurrentLocation.js\":\"a31f0b7234eb5f9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeAutocomplete.js\":\"0522d8b44f5b51a2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeNameCollision.js\":\"4de223008a883b04\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/properties.js\":\"af87a6d9dcfec2ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/propertyEditorOverrides.js\":\"88cfb37338cf3abf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/query.js\":\"128fbf39c14c69ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/usePlaceSearch.js\":\"ec1889599c418802\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"543c7d2a77eebaa9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3cd65799de65acae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2d493db0003e22ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/config.js\":\"c237f61cf1e33576\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/dataExtension.js\":\"c2d53803f1ec15fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/facet.js\":\"831d87fcbf58df67\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/grouping.js\":\"d162132b4d18539f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/index.js\":\"fb48d968d5faf04a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"443eee4a61dcf006\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/query.js\":\"261a6513298fd4cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/resolveConfig.js\":\"96275f05fd989a06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c8f8986078de6855\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4a8c8add305ec6d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlDocumentContent.js\":\"669898827e421e09\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlFrame.js\":\"c46f25c572bdd614\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/actions.js\":\"9040369f07caca81\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/blockType.js\":\"3816a6f4e8c4f838\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/confirmRunScripts.js\":\"dbff3e9597667163\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/dataExtension.js\":\"eaa242e03e9fea04\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameAnnotations.js\":\"e41ed96818e6fe9c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameDocument.js\":\"8cbdf6353897bb1a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameTheme.js\":\"7f43b8e82173ec2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/index.js\":\"125b284c756c43bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/scriptConsent.js\":\"ccc27c7a5faebd0f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/sourceMap.js\":\"04841d1ba79b8395\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/useDocumentScripts.js\":\"189304bdc73a859d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/index.js\":\"54cd4780523b36ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/record.js\":\"d08ffda66f8b2bcd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/recordStore.js\":\"add7376afb6e133d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/responsiveness.js\":\"b3d6cb5bd4c84675\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/schedule.js\":\"0b0ebe239b12d7aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/sessionContext.js\":\"b078277bd9dbcc83\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a09cec682da3fc0b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b16a2c42be23cb39\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/actions.js\":\"38d671cf3f2d17d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/config.js\":\"3ec2a71825801fee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/dataExtension.js\":\"574f82b309b3876d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/effect.js\":\"2539f83176d6d53b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/index.js\":\"ff1a602fc756cc63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/keyCapture.js\":\"fe6bf152f2eaeb11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/overrideStore.js\":\"222a37881c817a1d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"90cd8bfdce5def57\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/HeaderItem.js\":\"e5b78b0a8084d9a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/LeftSidebar.js\":\"8581897331f39244\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/actions.js\":\"9df9d8305161d53d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/facet.js\":\"9ed5565e5c511f78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/index.js\":\"dc0c6d5e54f98ff3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/shortcuts.js\":\"0ea40e3774189856\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/toggleStore.js\":\"af6f632b1c9a5a74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/MergePicker.js\":\"6907238c35760408\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/index.js\":\"4da0e71a5c2afe5e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/mergeAction.js\":\"bf8a6978c80b6b65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/strategy.js\":\"186b8aadd3a0924b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/Button.js\":\"652155b9ae0de4c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7aff2e0d5c55adee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9e1ae9f0b2eb4772\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/facet.js\":\"561600df8bcab989\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/index.js\":\"58a145783fce9d5f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"49d405b2b992b5fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5044eda3b846db2a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b6a5993b16ba3df2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8cf873355c6a2b7c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/index.js\":\"b6d5888288153c7a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c6665b0c609c8ea4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fabbf8fd27193fa8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/contextMenuItem.js\":\"2f54a25aa1d3552f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/index.js\":\"bbb0125b6828f6d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveAction.js\":\"5d376b5392765a97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveBlocks.js\":\"09eed7a9c51d5977\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/selectionAfterMove.js\":\"73e9c198e960af32\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/TutorialBanner.js\":\"f13a6233097d51f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/action.js\":\"25ea9a5330e3e80d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/bannerDismissal.js\":\"2cc620675750342e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/documents/cheatSheet.js\":\"c3500287a2cd6c58\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/index.js\":\"b431eb5e02a15c8d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/keys.js\":\"86428ed929ec6641\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/landing.js\":\"75b21cf6669428cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/outline.js\":\"1a755998a1197c6c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/seed.js\":\"0a24a78f351bd7e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/PerfTrendDialog.js\":\"dae340436da337cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/analyze.js\":\"9ac7b78a8647547f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/diagnosticsSource.js\":\"ba8ef5b097c13694\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/index.js\":\"1dac0af40c17aef2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/load.js\":\"bf53c17c9f579027\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/monitorRun.js\":\"b39b4b74569c1fc3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/schedule.js\":\"4a77646c8b986b92\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/series.js\":\"ddccf8d6a47050ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/store.js\":\"09f6aafc7e60995e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/trendAction.js\":\"c136b02d96d10bec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/verdict.js\":\"54ccf9238c6457f5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/clickToEditAction.js\":\"a78203cf629889fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/index.js\":\"e9ee82cdc05d6127\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/interactions.js\":\"cd3a7b39715e413f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"cad708fc3026661c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGate.js\":\"683183caaf88783c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGateDialog.js\":\"f9c28de21f5be699\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/action.js\":\"c4c62b0a87f42357\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/index.js\":\"e766dcf083686b33\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/localRunMessage.js\":\"038c0397f446a4d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/plugin.js\":\"802475ff23225ec1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/progressReport.js\":\"e9fe69e6c21157d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/sweepProgress.js\":\"6534ff708d1073ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/FieldRowRenderer.js\":\"3c2c7b59f69721b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/ValueRowRenderer.js\":\"298c7115fce10bfd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/actions.js\":\"2af84e0cc565799e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/autocomplete.js\":\"e60848e904b02fdb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/fieldRow.js\":\"c398bc5dd8e26c8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/index.js\":\"590690db1b94d845\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/referenceWarning.js\":\"8060bdf5537c8461\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueAutocomplete.js\":\"6895787003045914\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueSchema.js\":\"64d333f98e6f5088\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/HeaderItem.js\":\"341f604ade1110bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/QuickFind.js\":\"015372a7b1de9b47\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/index.js\":\"1f14d91fff3ae0c1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/recents.js\":\"763210dff9fd0614\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/resultItems.js\":\"98b9eab413fbd603\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/selection.js\":\"32f2df67eda06915\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/toggleStore.js\":\"50cfc70ea57e966a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/HeaderItem.js\":\"026880d435973aff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/RecentsPageBlockRenderer.js\":\"60c8e09030c09ce1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/grouping.js\":\"aa91477f5c593f0f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/index.js\":\"f469f0ea217d8188\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/target.js\":\"d55832f961a3d22f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/codeMirrorExtensions.js\":\"fdc27bc4e0fdf065\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/contentPrefill.js\":\"30fc21773bb33044\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/dataExtension.js\":\"2bf9f25c51323cd2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/index.js\":\"eca7fa95395be98c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4a73643a1e6ae5cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/invalidation.js\":\"f081c6cd5ad195c3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/localSchema.js\":\"669e0bb417e66cb3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/index.js\":\"f9ce9a519fa816a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"922f4eeb187d56be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/index.js\":\"312e744cfda4bc69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/referenceNode.js\":\"aa014b9501d464a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/remark-reference-occurrences.js\":\"dc586e5207fa35b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f1c25d480db25099\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/index.js\":\"6ad430a6f6d19dd7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"6355f8ac6bb12b7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ab3136e0386a6e11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/mergeRetargetProcessor.js\":\"1b6f186aa7fef742\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/parseFence.js\":\"4b622a09560592e4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceParser.js\":\"122f200afd97d39a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceProjection.js\":\"24d2e37ab999cf7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referencesProcessor.js\":\"5ece5fd3b4cf745c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/renameProcessor.js\":\"fc2ed1a7921bd7de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/spanReplacement.js\":\"bedae3b380382fca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/htmlToOutline.js\":\"925a5676c11f2560\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/index.js\":\"ec378c17e8414017\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6bda463b99faaf49\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/pasteDecision.js\":\"6ddd64739f2dd242\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/action.js\":\"b232edc7d22049f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/blockIds.js\":\"692cad5d35283772\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/content.js\":\"8e1ca6548e96c14a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/effect.js\":\"a5550a6589502499\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/ids.js\":\"df763d1315cb6505\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/import.js\":\"6a310ea39b9c7b40\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/index.js\":\"ccfb6438e592bca0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plan.js\":\"c7c38edce8057893\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plugin.js\":\"801361b6ca945289\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/promotion.js\":\"12bf0b2a16fbbf41\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/properties.js\":\"3de14f4614eec343\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/references.js\":\"8bda4507dd73b2fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/report.js\":\"03391d5d4b2ba6f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/roamMemo.js\":\"6d6460ec279b0c41\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/runtime.js\":\"d44b9fa1b48e658c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/schemaReconciliation.js\":\"b170b94ea89842e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/srsMarkers.js\":\"b429eebd7d96a357\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/todo.js\":\"6b2f435c4661af96\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/typeCandidates.js\":\"6ff86b8d3a9fa7f2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/types.js\":\"95aef41c4bb3b08c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/index.js\":\"606760697f19765e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/store.js\":\"064ac3a26676c064\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/HeaderItem.js\":\"de567e7257b3f6b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"309ba5c347a76a33\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/index.js\":\"89db01725d5b3bb5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/model.js\":\"36adfaae2aacdedf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/toggleStore.js\":\"ddbd8c877c89b22d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/useKeyInspector.js\":\"a189a8d4520031bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"64bf7c7a3d51d054\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/ShellDecorator.js\":\"ec2681d3e4f21fe2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/actions.js\":\"d7a673086198c590\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1bfaca0350ecfbcb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/index.js\":\"caac6bbb0971939a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/shell.js\":\"fa931b303b9976a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/surface.js\":\"32dea9b9e294c755\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/walker.js\":\"ffca6d5c623444c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5c9954025e0e820c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/dataExtension.js\":\"18d9bd37930d05a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/index.js\":\"fdb451747514cec1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/indicator.js\":\"3241a5e7bf21985b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/moveSrsState.js\":\"e54ae85f35d24b28\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"fb7d846c1eb4a8ad\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/scheduler.js\":\"355a63d3adf58982\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/schema.js\":\"549d8fcc66b8596f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c43acfe93a40272c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsClipboard.js\":\"dac74bcc350f8a43\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6e31cf27428568d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2b0d33fd4455f0c7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DeckPicker.js\":\"b294a7ba0b4840d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewControls.js\":\"9ee1a422ebad6944\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewDeckRenderer.js\":\"274992bc7fc9b954\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewSession.js\":\"d9b1bca6fd9fd5d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/actions.js\":\"0ce066c255156f5c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/archive.js\":\"bd0eadce447e5bb8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dataExtension.js\":\"5167e66198f7fa1c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/deck.js\":\"7adde126531b3849\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dueQuery.js\":\"83c18061606a4b2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/gradeDecision.js\":\"06651ec0f405a116\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/index.js\":\"ae7275b8190bae50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/keyHints.js\":\"59c976c4371c3987\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewCardLayout.js\":\"7304ed74758075ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewProgress.js\":\"935844984df0095a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/schema.js\":\"efcf3cdf5a2a4208\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/useDueCards.js\":\"6c326fbe17fe82b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/index.js\":\"ffd2bf0d554b5ffe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/record.js\":\"8c735f95f54876a4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/index.js\":\"915e4aa477233526\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/persistenceStatus.js\":\"9ef09b54ec003b89\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/requestAction.js\":\"7250c3485ef029bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/TypeChipsDecorator.js\":\"862d30f2ab65eaf4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/codeMirrorExtensions.js\":\"4d503bfe04a9a561\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/index.js\":\"0cc0095414a69730\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/typeAutocomplete.js\":\"23b6047839164451\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"01cb625d4270e0ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/actions.js\":\"7e80eec51e9bd0e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/anchor.js\":\"9a37e667a04e9578\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/events.js\":\"99ad24d3e9c409ab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/gestureActions.js\":\"7f5a11a670a50f90\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/index.js\":\"34adf160a90a5e03\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"483c84ef8b4ba5c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/collect.js\":\"18e0b2365f41f554\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/index.js\":\"dc9760dbad0f4bb8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/record.js\":\"adea54e5afe94bb9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/RejectionDialog.js\":\"fb3bc4bd545acc2a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2960f50e41f7ff7a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/index.js\":\"f5040c48aa65145f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/model.js\":\"89008056459245ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/queueCounts.js\":\"95988e563e213064\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rejectedHelpers.js\":\"299b948934722844\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rematerializeAction.js\":\"e2b770a0ded1fb72\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/useHysteresis.js\":\"2ee3e50e127a9d5e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/ColumnHeaders.js\":\"e78491ac81874746\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/QueryUi.js\":\"aae54c856da25cb8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/TableLayout.js\":\"6c211229320ae9e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/actions.js\":\"491a063ea8e68dee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/cellEdits.js\":\"1ae61cc839b2d18f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/columns.js\":\"d3b3f0fd58aff555\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/controller.js\":\"907774977fe03d8a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/convert.js\":\"44b690aa0fcc48fb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/dataExtension.js\":\"acb2d5d9edb3591c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/index.js\":\"c12c6152a8db6dfc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/keys.js\":\"ab7f162fb120a1f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/model.js\":\"e060a27f48265d96\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/navigation.js\":\"a1b8d49909976b65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/backfill.js\":\"e6868a07c092623a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/completion.js\":\"d62bd82f6d021e89\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/format.js\":\"6cbe598e42eebc78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/parse.js\":\"d8a0f6d512e751be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/queryValue.js\":\"43a1eee768949200\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/source.js\":\"472f9fc8a619271f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/registry.js\":\"acf70eed132b0e81\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowGutter.js\":\"5199508295fb13e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowVerbs.js\":\"f14a118721557c4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/schema.js\":\"c8cf8df9fbcf5fd2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/sort.js\":\"80c2b03f36fb9f93\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/effect.js\":\"0a7655512b8d6249\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/index.js\":\"c895ab0a67a1b67f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/theme.js\":\"b584d948f885a116\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/actions.js\":\"119728d56c890cc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/dataExtension.js\":\"05c1be15d8ba6042\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/index.js\":\"55fde835ffeedce0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/schema.js\":\"c7a0ce08117c66b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1dd7bf76ac1da872\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/actions.js\":\"28e7273081974405\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/defaultItems.js\":\"63efc61ff13f6632\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/facet.js\":\"a5dc95c688af1407\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/holdRecognizer.js\":\"7999a119ee7e7fb5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/index.js\":\"2824c83d228bc6c6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/UpdateIndicator.js\":\"0f23e719b489b08f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/index.js\":\"3db1b367dacfc19b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/loadTimes.js\":\"e12769a1ff3275f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoNotesRenderer.js\":\"575303771116e4d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoPlayerRenderer.js\":\"26c1da5ab34aa398\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoTimeStamp.js\":\"3dd29857af750418\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/actions.js\":\"ce691958a19d527e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/index.js\":\"12099b8d7071389a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/markdown.js\":\"6bc8ef534b62f37b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/notes.js\":\"188a0176f9772feb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/registry.js\":\"3cc6808cab85124d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/remark-timestamps.js\":\"aae709f0cd8b3240\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/view.js\":\"74cba7d7ef5c65a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/LinkHints.js\":\"b038c8960ee699c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/index.js\":\"0399bdd6259b19d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/model.js\":\"1f4216ad65f88f63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/settings.js\":\"41967d444dbcd693\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/actions.js\":\"a5bd39ad1619ee9d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/index.js\":\"8a3b6f0d8cb25d6b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/interactions.js\":\"71ac4d66f900f55b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/workspace-header/index.js\":\"6e228b61db204f97\",\"/knowledge-medium/pr-preview/pr-1494/src/registerServiceWorker.js\":\"8c6831be2ce4bd28\",\"/knowledge-medium/pr-preview/pr-1494/src/requestPersistentStorage.js\":\"beb6a41906b37e88\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authRequestDeadline.js\":\"fd90bd0e6750aa13\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authStorage.js\":\"70f40524a28c946c\",\"/knowledge-medium/pr-preview/pr-1494/src/services/powersync.js\":\"5deed77f3654997a\",\"/knowledge-medium/pr-preview/pr-1494/src/services/supabase.js\":\"19f575e141204cda\",\"/knowledge-medium/pr-preview/pr-1494/src/services/uploadErrorClassifier.js\":\"46ae3fb33c713f77\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/ActiveContexts.js\":\"8a3bb02c867fe0d8\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/HotkeyReconciler.js\":\"f26c036547719b95\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/WipeLocalDataDialog.js\":\"f598db650fd6b099\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionDispatch.js\":\"8a515b0b8dfed9a9\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionRefItems.js\":\"3d666ad931d82221\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/applyKeybindingOverrides.js\":\"fb06460c5996818d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockActions.js\":\"5f86f248bbb775d3\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockMergeGesture.js\":\"04aed743ca249d45\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/canonicalizeChord.js\":\"aecbcf7bf95102f6\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultContexts.js\":\"4a743d0949f41959\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultShortcuts.js\":\"a0b1e13fbca3076c\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/effectiveActions.js\":\"c1fdd7a8dc2faa94\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureAction.js\":\"5f5dac94f6d387dc\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureBinding.js\":\"e19fe9ddb06ae9b5\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/holdRegistry.js\":\"149cdf687835a01c\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingConflicts.js\":\"649f10524ad0f28e\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingOverrides.js\":\"4e4002760abd74f8\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/pointerAction.js\":\"fee1bdf3b42a6453\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/resolve.js\":\"49d929680df9dcb8\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/runAction.js\":\"436579fcc04abb72\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/sequenceMatcher.js\":\"257313cedd19228c\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/types.js\":\"a3a8e0096c46f442\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionContext.js\":\"95b1c3a1584f2b6f\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionDiscovery.js\":\"a8f67321704cee42\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/utils.js\":\"6f39126ac666acde\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/bootStore.js\":\"4715c0ef91bf9a9c\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/previewDatabases.js\":\"b6a87be7bae28c98\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/byteTransform.js\":\"dd19757a80c5ad63\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/attachmentCleaner.js\":\"6e0a51cc231d85ec\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/attachmentParts.js\":\"3b8334a0363884fd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleParts.js\":\"02b38700461934ac\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleRecord.js\":\"8b170d8a36bae622\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/manifest.js\":\"6ba11dbac1e6e96c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/takeBundle.js\":\"45aa6250c93e4ecd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/verifyBundle.js\":\"03c904c9443569f3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/cleaningStage.js\":\"28e277dff401ff97\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionKey.js\":\"29055cd082375461\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionServer.js\":\"c025fc2fc759e834\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flip.js\":\"e3900856e802ab18\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flipAttempts.js\":\"4e3507100b2cf1ee\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/pages.js\":\"c53712dbeeee68be\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/preflight.js\":\"e3bed3cffa5c8928\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/reseal.js\":\"7d17acb61088965d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runConversion.js\":\"bd551e53095b1999\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runLock.js\":\"f3cb5ff36d6a0a66\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealing.js\":\"b5a263fb83abde57\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealingStage.js\":\"816ded01af4dd6fc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/stage.js\":\"6001e06b10bd90f2\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/verifyReseal.js\":\"d72ba33ab2734724\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aad.js\":\"e0525731d354981e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aead.js\":\"cdf5917659628e5b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base32.js\":\"e83e080d9989e761\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base64url.js\":\"cd65f6e58acb16de\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/binaryEnvelope.js\":\"c2336821aba2b444\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/byteAead.js\":\"6db02c7308a078d8\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/canary.js\":\"51864b1adaf2ad42\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentHash.js\":\"873b6c3bb05e9a20\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentKey.js\":\"c48e028ea63422bf\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/derivedIdNamespace.js\":\"1103a01691e34cad\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/envelope.js\":\"56a585bd92d0e700\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/hex.js\":\"1fc3525b35e0333d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/sha256Hex.js\":\"88418bd930edf63a\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/workspaceKey.js\":\"de96b3dd2ad3b966\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/conversionState.js\":\"747dbcb8043ef6b7\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1a821a999ca01958\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/pastedKey.js\":\"6d709848fba09d0c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7503b83e9d590247\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1127470180263196\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/keyStore.js\":\"d127162cf4cc0abc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/mintWorkspaceKey.js\":\"1738eee71022b1ca\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/modePin.js\":\"e13f92a9bd92a4e4\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/openWorkspaceKeys.js\":\"a3ce11a8b07f882b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolveWorkspaceEntry.js\":\"21ce66b25b244b46\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolver.js\":\"dd99e46cae7dc2cd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/workspaceAccess.js\":\"4697732c3f0e13ef\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/transform.js\":\"4b778aacd8972183\",\"/knowledge-medium/pr-preview/pr-1494/src/themeBootDefaults.js\":\"5bf6b0e9fbad0833\",\"/knowledge-medium/pr-preview/pr-1494/src/types.js\":\"82ac0883b1663124\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/ClientLocalSettings.js\":\"fab8b813d53dfd65\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/abortableSleep.js\":\"9fbb15ae7c146515\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/array.js\":\"a1c835bf97a636e0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/backlinkAutocomplete.js\":\"73f33441dbf1d1d4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockCrumbs.js\":\"5145264be759c386\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockrefAutocomplete.js\":\"cc891c4cde057032\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/cadencedIdleJob.js\":\"13977e3ca805336a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/callbackSet.js\":\"7d5f840bad7e6b6e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/clientId.js\":\"c5d0632f62d784d5\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirror.js\":\"f7dd17057362f37a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirrorCompletion.js\":\"808def5075891827\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/copy.js\":\"1c9f35223f68ae2f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dailyPage.js\":\"329669f10b87b6e2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensics.js\":\"b9695eedd454dae4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensicsHooks.js\":\"939b9a399ee7774d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/deleteBlockThroughUi.js\":\"acea5edc9f622205\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dialogs.js\":\"3ed33d9ba27e729b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dom.js\":\"31bcc703460e756f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/downloadBlob.js\":\"b090a6bd0830a142\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/exportSqliteDb.js\":\"a4513182e10c92ac\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fileSystemAccess.js\":\"becbbbf067abbed1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/flipSlide.js\":\"062873bb91ab719f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fnv1a.js\":\"268051d3bd68f33e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/formatBytes.js\":\"aa80d2d8ba73620e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fuzzyRank.js\":\"51f36239fa6cf914\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idbKeyedStore.js\":\"9ec02089f8dfad4e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idleCallbackPolyfill.js\":\"032ad8de1f3eb7d0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardAwareScroll.js\":\"2aba17ec6ea60147\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardViewport.js\":\"2852cd1e191d2169\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/lastWorkspace.js\":\"753541171c2d7c6b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutColumns.js\":\"93689de5b0ed6999\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionDom.js\":\"2f3963be3e846cab\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionId.js\":\"c86c332ee314dffd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkClickGestures.js\":\"f2a3554f55a88877\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkTargetAutocomplete.js\":\"59bba5d09b0abfa1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbCorruption.js\":\"493bd03e826b49bc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbRecovery.js\":\"770f6c446621f147\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/markdownParser.js\":\"9c1e75a7175350d2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/memoize.js\":\"88e96c02738ac762\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameFieldCommit.js\":\"364efb2296f9b662\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameList.js\":\"5e7fad7abb828eb1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/navigation.js\":\"0721c0c72eb21e79\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/omnilinerNamespace.js\":\"b6f41f22ea745b0b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/opfsPageScan.js\":\"5e7be2bf759ad794\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelClearance.js\":\"77fdd7158d01dad6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelHistory.js\":\"45b340d7588b4954\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLanes.js\":\"cbd606a8db269b36\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLayoutProjection.js\":\"ec3da8845e1bacc0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelScrollAnchor.js\":\"ec1960477eea834f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelUrlFlags.js\":\"0c43f2c264f88048\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/platform.js\":\"a1df1614728a9323\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/pluralize.js\":\"dd0eae7c814b6b2b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyCreation.js\":\"0288f983a18bb955\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyNavigation.js\":\"272f7ff86595add8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyValueContext.js\":\"ffc47ac9a013640a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/react.js\":\"47727de15d161b71\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeDate.js\":\"f7573b3880047015\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeTime.js\":\"e82eb881689ca31d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/renderScope.js\":\"1b99b82e96ccb0e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/resolvedThenable.js\":\"ccaa07322c5c6b3a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/routing.js\":\"ef9f35e496d517b8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/safeMode.js\":\"dcf848d3d26ec909\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/scheduleIdle.js\":\"bc10d2a56df013fa\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/screenWakeLock.js\":\"73209899ffc34631\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/selection.js\":\"e6aaa374e09924cd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/softKeyboardGrab.js\":\"4e1caba543abbae6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/startupTimeline.js\":\"435fbcbdcb114612\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/state.js\":\"baf1bc7af70e41e1\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/string.js\":\"1d576efbb4b60558\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/surfaceZoom.js\":\"e82a7e7c8a2be594\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/time.js\":\"03a9f6b2459e03f4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toast.js\":\"69286c904fb7f7f9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toggleStore.js\":\"2ce1a2ea73b0448b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/untilStopped.js\":\"a81e727a0687fe38\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/userActivity.js\":\"f89492d3c3e67116\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewTransition.js\":\"ee54f188b88e9f75\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewport.js\":\"98f3f84340335968\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/webLock.js\":\"383c3e5ab7f8a502\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceRecovery.js\":\"041e597020901d0a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceSnapshotStore.js\":\"2e96c28d8f2dbcc0\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-compiler-runtime.js\":\"b751045c95fe3be2\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-client.js\":\"4605a64ef904e96d\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server-edge.js\":\"bdc14ce1c66d7a27\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server.js\":\"a89f0cd4f5e264d4\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static-edge.js\":\"5170469fd26883ee\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static.js\":\"3dfb49fa13078ad7\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-test-utils.js\":\"673e768adcd8f69f\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom.js\":\"dcb97a33597704f2\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-runtime.js\":\"10fde06e656425ee\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react.js\":\"7a8b3c76d3d1aef3\",\"/knowledge-medium/pr-preview/pr-1494/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
