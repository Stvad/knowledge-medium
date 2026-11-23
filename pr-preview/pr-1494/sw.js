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
		buildId: "ecfd9fb0edc3-507f740e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/\":\"897b36982827200b\",\"/knowledge-medium/pr-preview/pr-1494/index.html\":\"897b36982827200b\",\"/knowledge-medium/pr-preview/pr-1494/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1494/assets/FacadeVFS-DDzDoXQb.js\":\"88fb3b82c8f4be76\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSCoopSyncVFS-D6fh1LJ-.js\":\"15272f3165e9553d\",\"/knowledge-medium/pr-preview/pr-1494/assets/OPFSWriteAheadVFS-BdXFnIdy.js\":\"12d7759f9ba21da5\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-BuYG0Vu4.js\":\"9aef91e3b228c1fa\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/assets/wa-sqlite-async-DMahT6nB.js\":\"5a8713cc2d77d753\",\"/knowledge-medium/pr-preview/pr-1494/assets/worker-DruwuQVf.js\":\"558d3c84ce58be64\",\"/knowledge-medium/pr-preview/pr-1494/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1494/chunks/app-D_RF6T6W.js\":\"388d835091e58290\",\"/knowledge-medium/pr-preview/pr-1494/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1494/index.js\":\"2b69342872198f76\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1494/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1494/assets/AccessHandlePoolVFS-czjKvoK8.js\":\"4c6f78150b31ddf5\",\"/knowledge-medium/pr-preview/pr-1494/assets/IDBBatchAtomicVFS-BPlA0-Jt.js\":\"e37f03300ccae2ec\",\"/knowledge-medium/pr-preview/pr-1494/assets/MemoryVFS-BvB6_Ih_.js\":\"f8579640e18927a0\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-BCzro9hp.js\":\"e7cd9ce1b0552bad\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-DM7tM7bE.js\":\"6d3f0f51f90af024\",\"/knowledge-medium/pr-preview/pr-1494/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1494/chunks/AccessHandlePoolVFS-BZ5MNMsf.js\":\"cfc9c0723ebf2dbe\",\"/knowledge-medium/pr-preview/pr-1494/chunks/FacadeVFS-u5ERF8Ze.js\":\"8523adbca9a303b6\",\"/knowledge-medium/pr-preview/pr-1494/chunks/IDBBatchAtomicVFS-CgvanPKw.js\":\"c4a0354a46fbe7fd\",\"/knowledge-medium/pr-preview/pr-1494/chunks/MemoryVFS-Bi-N4NrL.js\":\"f84a62c56f1658c4\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSCoopSyncVFS-BX8vI7Kl.js\":\"fc593a581309a83f\",\"/knowledge-medium/pr-preview/pr-1494/chunks/OPFSWriteAheadVFS-D1LzQo40.js\":\"7d1c75caaae4f62d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/Preview-C_80CpJQ.js\":\"8a26e295f2151019\",\"/knowledge-medium/pr-preview/pr-1494/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1494/chunks/card-D0K9JKYO.js\":\"e3627e0f9094d573\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1494/chunks/dist-oQGA1cLf.js\":\"6512af00e81ae5cd\",\"/knowledge-medium/pr-preview/pr-1494/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-CceK_Fdb.js\":\"ed404cb6b108b360\",\"/knowledge-medium/pr-preview/pr-1494/chunks/mc-wa-sqlite-async-CwkRYy2M.js\":\"a131ede70603fa7b\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-B6qf-YiQ.js\":\"66b560ebb00833f6\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-Ba-GijjB.js\":\"5f6107f4a8cfcaa5\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-CiTSN5PZ.js\":\"e70f71dda2e244da\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-D7LG3o7U.js\":\"5cfb0f8a9d910ea4\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DNgeYZsT.js\":\"b9b543531674cacf\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-DooIn3-N.js\":\"a64d8176bfeb191e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server-legacy.browser.production-DJXv_AAc.js\":\"64822555b12114ae\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.browser.production-DY4_YssT.js\":\"c45c9658f6ad22b6\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-dom-server.edge.production-4nCrV3ya.js\":\"72876cc779d35a06\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-hUhKM-qM.js\":\"434561b178e0ed90\",\"/knowledge-medium/pr-preview/pr-1494/chunks/react-pyhsoZMV.js\":\"e4620998252f8ebf\",\"/knowledge-medium/pr-preview/pr-1494/chunks/server.browser-CtKx1rjR.js\":\"a743a056284a689e\",\"/knowledge-medium/pr-preview/pr-1494/chunks/textarea-BhaLNXpV.js\":\"34a0dd9a11ae7f3d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/ui-CguXV_c5.js\":\"2b326b8eb90e4632\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-I6WDVGPA.js\":\"7c32fc4ed5607a2d\",\"/knowledge-medium/pr-preview/pr-1494/chunks/wa-sqlite-async-YGB7qMsX.js\":\"6ee122600e960138\",\"/knowledge-medium/pr-preview/pr-1494/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1494/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1494/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1494/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1494/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1494/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1494/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1494/src/App.js\":\"66dfbc216f07fa73\",\"/knowledge-medium/pr-preview/pr-1494/src/appUpdate.js\":\"255cc9d5a1fb8e1f\",\"/knowledge-medium/pr-preview/pr-1494/src/appVersion.js\":\"21af5c41a26ddffc\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/initialLayout.js\":\"7545cbdd22f3d0c5\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/openWorkspaceData.js\":\"97347afd0ab03a0f\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/resolveWorkspace.js\":\"0040e13c0de20a12\",\"/knowledge-medium/pr-preview/pr-1494/src/bootstrap/workspaceBootstrap.js\":\"cc2b9885209710e0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockComponent.js\":\"51ba39bf6d833524\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockCrumbs.js\":\"f40be1eb2634555c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockEditor.js\":\"85e17be52f645957\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockLoadingPlaceholder.js\":\"cc1417a59a1f6fbe\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockProperties.js\":\"02392c707a13aa36\",\"/knowledge-medium/pr-preview/pr-1494/src/components/BlockSearchPicker.js\":\"e6737f19f4277c40\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ConfirmBulkDeleteDialog.js\":\"f477e69cc4918e34\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DividerHandle.js\":\"94bf3afe65c3f06c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/DraftEditor.js\":\"3157d4d5eefcd009\",\"/knowledge-medium/pr-preview/pr-1494/src/components/GutterPill.js\":\"d1fe350909d4dd43\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Header.js\":\"295f5506b9e69793\",\"/knowledge-medium/pr-preview/pr-1494/src/components/LazyBlockComponent.js\":\"f21d2750b73353eb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/Login.js\":\"b41ebdf342e1e5a4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ZoomableSurface.js\":\"893d53ff27d347f7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/editModeKeepalive.js\":\"e7f65724a48558a2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d657f6666d092c9b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d2b835e08e580541\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefPropertyEditor.js\":\"1dc0a55f745ab865\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/RefTargetTypePicker.js\":\"c16dac0f3c89c361\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/SelectPropertyEditor.js\":\"9a8a05caeb58b5d3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/TypesPropertyEditor.js\":\"c4cfc2b686cd5901\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/defaults.js\":\"1afcb93e41c177d4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/kernelValuePresets.js\":\"983e5e2b6ed9108d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/selectablePresets.js\":\"ef9842d903d5da18\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyEditors/typesPropertyUi.js\":\"f2774232981e882d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/AddPropertyForm.js\":\"c46f9946b0072b0f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyPicker.js\":\"c014905ae3a9c4a7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/PropertyRow.js\":\"dd3a8724d39c44ab\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/Rows.js\":\"cbdd54318b90c74b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/actions.js\":\"dfc28c24a69e280b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/declarationOnly.js\":\"3711ff7606de37f5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/layout.js\":\"12c1f9442b7579f0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/model.js\":\"75af8a7a181f61ac\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapeUi.js\":\"add314c7d0f6a0a4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/shapes.js\":\"ae8b2139bba74ed5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5041e84a4618f466\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanel/visibility.js\":\"892a064c3d9f5a0e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/propertyPanelSections.js\":\"10ac078b31ec29b5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockEmbed.js\":\"85f5e6e09ecdba7c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockLink.js\":\"83e77d54ba5187cd\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/BlockRef.js\":\"ca14173cececd6f2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/ReferenceLink.js\":\"24568ce639e64fd9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuard.js\":\"4279807119b0deef\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/cycleGuardContext.js\":\"1ac24c997cadac08\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/linkInteraction.js\":\"beb15376489defa0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/referenceLayout.js\":\"99b5b58135ef5141\",\"/knowledge-medium/pr-preview/pr-1494/src/components/references/useBlockRefAncestors.js\":\"1c132429699145b0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockGutter.js\":\"cced63d6bdd318f8\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockInfoDialog.js\":\"b2e11a79eda1979a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BlockTypeBlockRenderer.js\":\"d05e5301d9fff3ae\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/BulletHoverCard.js\":\"4e9803b1ed79ac65\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorContentRenderer.js\":\"4624fd39f40b9e6d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5dd9230d009ae1ba\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ColumnResizeHandles.js\":\"b1cd71dfffb55e42\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7c17bfa0a604cc1d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/DefaultBlockRenderer.js\":\"14c352f632da741d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/LayoutRenderer.js\":\"25c2b12aff8ad91a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MarkdownContentRenderer.js\":\"8cdedf6b7e1ccf11\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/MissingDataRenderer.js\":\"f5e94ed6ef0c6581\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PanelRenderer.js\":\"688e27ee2cc0d67b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c4eed933a095e603\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/TopLevelRenderer.js\":\"bfc58ca2561e05ee\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockGutterMode.js\":\"272bc630786353b7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/blockTitleText.js\":\"d8520a5b91571e9b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/fieldCreationKeydown.js\":\"eea8243cbca2e0e3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/renderer/layoutRootContext.js\":\"a59704acc19190df\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/TypeChip.js\":\"807d9f2296ab0199\",\"/knowledge-medium/pr-preview/pr-1494/src/components/typeChip/chipStyle.js\":\"1c202e0736a668de\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/anchored-floating.js\":\"4a1e4597c6bea27d\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/button.js\":\"68ba225174b9f8ac\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/card.js\":\"28ba39bd576e2433\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/checkbox.js\":\"74062b3c6406c153\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/collapsible.js\":\"8e464229356a3bd5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/command.js\":\"974c15154aa94a4a\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/context-menu.js\":\"a465f4a838cb4ed4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dialog.js\":\"5888ddaf66b40be4\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/dropdown-menu.js\":\"e371b95426935ada\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/floating-listbox.js\":\"fca45628dcd471a9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/index.js\":\"a9403242c4e8ceac\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/input.js\":\"de04665f48fd86cb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/kbd.js\":\"b1d8434afe27bfb2\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/label.js\":\"3f28e12e10471135\",\"/knowledge-medium/pr-preview/pr-1494/src/components/ui/textarea.js\":\"c684ee34c180bc10\",\"/knowledge-medium/pr-preview/pr-1494/src/components/useEditModeYieldKeepalive.js\":\"74bd9e6f9103748e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/BootFallback.js\":\"0b73c8466acba335\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/FocusedRowLazyMount.js\":\"9acb6e9b2c2594b5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LazyViewportMount.js\":\"e921a0166213e0e3\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/LocalDbCorruptionFallback.js\":\"274dbafa8c01b6d1\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/error.js\":\"1269791edfc7b097\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/lazyMountRegistry.js\":\"8b603f834ef071cb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/util/suspense.js\":\"10e2a7436f126f22\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/CreateWorkspaceDialog.js\":\"91e50d57568a7f6b\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/PendingInvitations.js\":\"e1644321a483271e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/SyncProgress.js\":\"0ccfe74b3277c1cb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/UnlockProgress.js\":\"c1c43eac8cf926f9\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceKeyGate.js\":\"ca70cb62280bc7ac\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSettingsDialog.js\":\"a1a4fdd9a8c80ee7\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSwitcher.js\":\"c686e62e42c319ec\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/WorkspaceSyncGate.js\":\"80ae301b51417db0\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlow.js\":\"c3fcf0701500d70c\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/ConversionFlowHost.js\":\"54c7349466bfcbf5\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/EncryptionSection.js\":\"483846c2e9535c67\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/attachmentPrompts.js\":\"3870b8a3957ffe08\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e171c3d14647b2be\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowDeps.js\":\"02410661e1c5a1be\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/conversionFlowStore.js\":\"4f1fd837d001948e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/flowUi.js\":\"8373d5cec93409ce\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/conversion/useConversionRun.js\":\"dc9417478b965e47\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/keyUi.js\":\"6b515cd97f690feb\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnKeyLoss.js\":\"ad8b855da615a22e\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/useCloseOnServerE2ee.js\":\"7e6da83b833f843f\",\"/knowledge-medium/pr-preview/pr-1494/src/components/workspace/workspaceUnlocked.js\":\"c3c55ccda148433b\",\"/knowledge-medium/pr-preview/pr-1494/src/context/backgroundSubtree.js\":\"ea14d4c626bacf4a\",\"/knowledge-medium/pr-preview/pr-1494/src/context/block.js\":\"3f8f99aaf71d4773\",\"/knowledge-medium/pr-preview/pr-1494/src/context/layoutWsContext.js\":\"fa36fb1fe2422906\",\"/knowledge-medium/pr-preview/pr-1494/src/context/propertyDisplay.js\":\"87ae14b06fd03e22\",\"/knowledge-medium/pr-preview/pr-1494/src/context/repo.js\":\"b8255f591f290e6d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasClaim.js\":\"5a4ea5f279eeefb2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/aliasSeatNamespace.js\":\"eeafcaa4e30da6a9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockData.js\":\"be0068a5b81957d1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/blockType.js\":\"10fc4ce6338705f6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/changeScope.js\":\"994efd9fc95c79bf\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/codecs.js\":\"a3b7c8cbd56e4911\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/derivedData.js\":\"e47f8b3f03c49578\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/errors.js\":\"0844fc4bacedc954\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/events.js\":\"c10d18043d76c5d8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/handle.js\":\"d9d51f2994753396\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/index.js\":\"14e4a53f4e524def\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/mutator.js\":\"12af8c4eb0c7bcb8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/processor.js\":\"21dfa7e3ac2857c8\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/propertySchema.js\":\"570fb550e3ad3cc4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/query.js\":\"b0ad65aedd292db4\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/sameTxProcessor.js\":\"ee6a0d762b3dcd4c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/schema.js\":\"d9d51f2994753396\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/tx.js\":\"d9d51f2994753396\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/typedBlockQuery.js\":\"9116fc7a12739a16\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/user.js\":\"1d1e4b5c184f78fa\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresetCore.js\":\"d1d3e2a273ffbdaf\",\"/knowledge-medium/pr-preview/pr-1494/src/data/api/valuePresets.js\":\"f5366e12fc2fc031\",\"/knowledge-medium/pr-preview/pr-1494/src/data/attachmentCleanerIOVerb.js\":\"771734517ba29994\",\"/knowledge-medium/pr-preview/pr-1494/src/data/block.js\":\"104a485e33f19aad\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockCache.js\":\"90e20f80957e799b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockId.js\":\"a42cf1eabcf0db18\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockLiveness.js\":\"1b8c49d3cc8a0e6a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockMerge.js\":\"47a37bee0b10aea1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockSchema.js\":\"02cde731f262a169\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypeLookup.js\":\"3aa331a733db8994\",\"/knowledge-medium/pr-preview/pr-1494/src/data/blockTypes.js\":\"afe868ec2cb8fa65\",\"/knowledge-medium/pr-preview/pr-1494/src/data/childrenView.js\":\"7ba833d4b93752d0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/clientContext.js\":\"98d68687a23d9c2d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/dbFileSiblings.js\":\"6d5ecbc0ed1a1906\",\"/knowledge-medium/pr-preview/pr-1494/src/data/definitionSeeds.js\":\"6f33eb352c8bebca\",\"/knowledge-medium/pr-preview/pr-1494/src/data/derivedIds.js\":\"e02354aeadb4799e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/drawnSubtree.js\":\"09312dde5442d9a5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facetBridge.js\":\"60f89d3d66a01390\",\"/knowledge-medium/pr-preview/pr-1494/src/data/facets.js\":\"ba0b808d98092bfe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/globalState.js\":\"3d1fb38d0278d71e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/aliasClaimRederiveProcessor.js\":\"2799607a2a3f0b17\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/ancestorBatch.js\":\"6f6b5501ae149e09\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/blockTypeTypeifyProcessor.js\":\"c67cd0f5672a6b8b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/clientSchema.js\":\"2b39010ec7616266\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/commitPipeline.js\":\"16738d829976d6f3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/devAssertions.js\":\"ef0de902e776274e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/firstSync.js\":\"13e25671182a52e1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/freshInitialLoad.js\":\"ce3c295174d3e76d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/graphBackfillClaim.js\":\"763f5e8f75e56e6c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/handleStore.js\":\"8e765d8313c57e47\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/idleMarkerJobs.js\":\"c7ee07f76866395a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initialDownload.js\":\"735f5d0602f0dc10\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/initializeClientDatabase.js\":\"d71b93e4827b215e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/jsonCanonical.js\":\"cda802583f0cde53\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelInvalidation.js\":\"8ad00583f76829df\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelProcessors.js\":\"d796d76e479ac351\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/kernelQueries.js\":\"8fadd053a6e0bf9a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/mergeTypeMembershipProcessor.js\":\"efba760cb5ebc3f9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/normalizeReferencesProcessor.js\":\"671a31f4fd5a4cb9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/poolInstrumentation.js\":\"4bbfcfc46eb71996\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/processorRunner.js\":\"e06f71953bafd9e1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyCellBackfill.js\":\"f3acc5e721620f84\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildMint.js\":\"2a6f5ee65c2983af\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyChildrenProcessor.js\":\"c390cb81bfa6af38\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b6e144bab15cf988\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyDefinitionSynthesis.js\":\"7f30ba3e4c538280\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyKeyScan.js\":\"758da76218c5a7e2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertySchemaResolution.js\":\"e9f9dd9b4d860215\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/propertyValueEdits.js\":\"33090d15cc4542c5\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/raiseProtocol.js\":\"e075520bf2383699\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/readBatch.js\":\"95ec52a09840943e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/refProjection.js\":\"a79fa74abca26032\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetLookups.js\":\"43b729fb0468f61e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/referenceTargetProcessor.js\":\"e21a031a9bdbbf6b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/replayMerge.js\":\"2c4f61bc87beb2f1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/sqlBinds.js\":\"b9e329a30d0b34ec\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0cf1e3aae7bed5be\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/arrivalProcessors.js\":\"ee324c8b58f5fc6d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/invalidate.js\":\"058510ca65616162\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/materialize.js\":\"9acd553353d5981f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/observer.js\":\"ec17f4e09556cf45\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/syncObserver/reconcile.js\":\"9203c330df663886\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/timingMetrics.js\":\"2bc162e3a58c9040\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/treeQueries.js\":\"6b7f7dd4e1b02b94\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txEngine.js\":\"c43c624875ace5e2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/txSnapshots.js\":\"7581768ce8559881\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/typedBlockQuery.js\":\"42a1c23bdd8fef8b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/internals/undoManager.js\":\"8f261f54a07ea36e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/invalidation.js\":\"1958721dfe1ff971\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelDataExtension.js\":\"526fb4e22dd31756\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelPage.js\":\"2e8ab165510c631e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/kernelValuePresetCores.js\":\"bfe69dbd5efffffb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbCorruptionSignal.js\":\"b37910b98a550a8c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbStorage.js\":\"30db47e2f44daf90\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localDbVfs.js\":\"e0123ea597387828\",\"/knowledge-medium/pr-preview/pr-1494/src/data/localSchema.js\":\"6e134d15709bf4b2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/maintenance.js\":\"3b9e9d4c71324c84\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mergeProperties.js\":\"c0d2753b819287ea\",\"/knowledge-medium/pr-preview/pr-1494/src/data/metricsConsoleHook.js\":\"86bf5daafb58beee\",\"/knowledge-medium/pr-preview/pr-1494/src/data/migrationsPage.js\":\"bb7579c14c5ac34e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/mutators.js\":\"e5853d0a0de516f2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKey.js\":\"82482e7a0153e846\",\"/knowledge-medium/pr-preview/pr-1494/src/data/orderKeyPlacement.js\":\"c0e43e8c822fe819\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineGroupGestures.js\":\"79a421d6bab1b368\",\"/knowledge-medium/pr-preview/pr-1494/src/data/outlineSurface.js\":\"d29c8cbb75549a02\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingEditorContent.js\":\"7bad11fd7f3f19b6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pendingUploadsSql.js\":\"f577551fad1038eb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/pluginStateExtensions.js\":\"75a627c6c3a80f94\",\"/knowledge-medium/pr-preview/pr-1494/src/data/powerSyncLogger.js\":\"336b42e4060d9c1e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/projectorRuntime.js\":\"031ee3772c142788\",\"/knowledge-medium/pr-preview/pr-1494/src/data/properties.js\":\"a3d080731fb49917\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertiesPage.js\":\"0c0f6b90ec95c7c6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyChildren.js\":\"efd7138052f27b2e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionFanout.js\":\"67cdfc08e5493943\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionMetadata.js\":\"f50d0a5090d9db77\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDefinitionRegistry.js\":\"57f6cfafcdb89b57\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyDisplayMode.js\":\"af41290704bd997f\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertyRowCreation.js\":\"9816cdcd77fdbdb3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySchemaCreation.js\":\"8742ed5ec87122b1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/propertySeeds.js\":\"e390feed23e82c55\",\"/knowledge-medium/pr-preview/pr-1494/src/data/recentsPage.js\":\"59c40c39aef0da89\",\"/knowledge-medium/pr-preview/pr-1494/src/data/referenceBlock.js\":\"f8e4a15d614abf27\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rejectedUploads.js\":\"d245c5b6547417e0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/releasePowerSyncConnection.js\":\"5d490faa3dc1a85b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repo.js\":\"d40dbd112bbe2092\",\"/knowledge-medium/pr-preview/pr-1494/src/data/repoProvider.js\":\"88ef940f192d9ffb\",\"/knowledge-medium/pr-preview/pr-1494/src/data/rowProperty.js\":\"00472acfd2f5f55e\",\"/knowledge-medium/pr-preview/pr-1494/src/data/searchFilter.js\":\"74ec96d48bd4b886\",\"/knowledge-medium/pr-preview/pr-1494/src/data/seedIdentityLedger.js\":\"7b939b36da246aee\",\"/knowledge-medium/pr-preview/pr-1494/src/data/stateBlocks.js\":\"2470d43e5fc800c0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/structuralEditPolicy.js\":\"5829cba4f48b777a\",\"/knowledge-medium/pr-preview/pr-1494/src/data/subtreeDelete.js\":\"2bc9245130e4c5d1\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncStreamLock.js\":\"e9aba50b65ee74df\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableSqlRecognizer.js\":\"6ba92981471f5027\",\"/knowledge-medium/pr-preview/pr-1494/src/data/syncedTableWriteGuard.js\":\"e9e9f42f4a71cbc0\",\"/knowledge-medium/pr-preview/pr-1494/src/data/targets.js\":\"a2949501bd7fff66\",\"/knowledge-medium/pr-preview/pr-1494/src/data/treeOrder.js\":\"6229a934d88afde2\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeColors.js\":\"99d8185deed4eec3\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionMetadata.js\":\"368b5c803045350b\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeDefinitionRegistry.js\":\"9785200ecf699cf6\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeExtraction.js\":\"decfd5f69663f1a7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeInitialValues.js\":\"c8c4870570185a69\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typePropertyGroups.js\":\"51d32c75934bb201\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeSeeds.js\":\"fba47f64210fa373\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typeTagger.js\":\"b0552a01706b1dc9\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typedRecords.js\":\"e58fcd281ce71e7d\",\"/knowledge-medium/pr-preview/pr-1494/src/data/typesPage.js\":\"bde8cf28ea5175fe\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userPrefs.js\":\"5bda2b39a1adf9cc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userSchemasService.js\":\"d465da41eb8c9c8c\",\"/knowledge-medium/pr-preview/pr-1494/src/data/userTypesService.js\":\"2896024f8f877275\",\"/knowledge-medium/pr-preview/pr-1494/src/data/valuePresetRegistry.js\":\"28784e54283f4735\",\"/knowledge-medium/pr-preview/pr-1494/src/data/visibleChildren.js\":\"b010179abf8fc802\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceConversion.js\":\"b25a881e3c023e54\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceFirstSync.js\":\"150c360a477f31de\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceIdNamespace.js\":\"6bbb12982713e659\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaceSchema.js\":\"9a31b6160df00bbc\",\"/knowledge-medium/pr-preview/pr-1494/src/data/workspaces.js\":\"100de4f43f0f9a54\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadLog.js\":\"c000f22e0615a6a7\",\"/knowledge-medium/pr-preview/pr-1494/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/BlockPasteShellDecorator.js\":\"ccc78c8a8e67b294\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/atTrigger.js\":\"0a865e65dadccf63\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/autocomplete.js\":\"386533f817aa8722\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/codeMirrorExtensions.js\":\"b9c5fdd747eaccef\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/contentFlush.js\":\"21850ce5d95bed1a\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/defaultInteractions.js\":\"c0824b6aee7902de\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/editSettleSignal.js\":\"d2905a4308507f1e\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/insertImage.js\":\"0a779fa46a4f78bf\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceCompletionRange.js\":\"264faa1a04867b0c\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/referenceTargetTypes.js\":\"71a668ba73ea949c\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/syntaxContext.js\":\"19bf9c2fcae1e8bb\",\"/knowledge-medium/pr-preview/pr-1494/src/editor/triggerMatch.js\":\"2abac03d67323619\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/AppRuntimeProvider.js\":\"f34897c74cb85ca8\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/BlockFocusShellDecorator.js\":\"b177532d7a8fbd8f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/ExtensionRenderBoundary.js\":\"c7f316026b0e2194\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/PanelContentRecovery.js\":\"08b2d2e19225ae42\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/apiCatalog.js\":\"34eee995d2e0d6aa\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/approveExtensionHere.js\":\"e5b58cb90616e412\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/armedCutAppMount.js\":\"9b26e5f08c47d4d6\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/batchableKeyedStore.js\":\"65e34a126e90da09\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockInteraction.js\":\"c7d4c8d501076553\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/blockSelectionAction.js\":\"6c178862f05b1e7a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compileExtensionModule.js\":\"85e0ed2106179421\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/compiledModuleCache.js\":\"69d35ddc1609136a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/continuousGestures.js\":\"370f5143a9ae0398\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/core.js\":\"99d2cc45b3f53b14\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/defaultRenderers.js\":\"b379808284742618\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/definitionFanoutAppMount.js\":\"be46340b09e25564\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dialogAppMount.js\":\"137a6b3104c00f32\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensionSeeds.js\":\"963313324d5a416e\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/dynamicExtensions.js\":\"c2d208f850c443a2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/exampleExtensions.js\":\"bc57d84ae3942c17\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionApprovalStatus.js\":\"bbdf3b721027ead4\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrorToast.js\":\"6b56f083f4190edf\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLoadErrors.js\":\"d936e62d3c600c1a\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionLookup.js\":\"91d14f0d63cb8637\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionToggles.js\":\"f617b5b869af99ce\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/extensionUtilitiesCss.js\":\"26a1bab358b0ddd7\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/kernelPageDeletionGuard.js\":\"d274f4f336bc9c4b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/liveRuntime.js\":\"853e2eee86602825\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/openExtensionsSettings.js\":\"a2d4b42948a7a29f\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/overridesCache.js\":\"b7e32c5e6992bfc2\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/pluginIds.js\":\"bb4780c41e24006e\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/processorRejectionToast.js\":\"920f3e84d3ecfde0\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeActions.js\":\"8df8aad95f16a42b\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/runtimeContext.js\":\"e83e24f14846a7d8\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticAppExtensions.js\":\"2581b1c7ab0fc20d\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/staticDataExtensions.js\":\"d7855c6ed154627c\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/toastAppMount.js\":\"aacc301c8c73e2dd\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useOverrides.js\":\"b0f4c951215b8c58\",\"/knowledge-medium/pr-preview/pr-1494/src/extensions/useShortcutSurfaceActivations.js\":\"814b4247ca0e85bc\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/discoverToggleTree.js\":\"b8df1abfa33de21d\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/facet.js\":\"9c7eb09ee2dfb7e3\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/resolveAppRuntime.js\":\"16e6b5d95d4f6429\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/runtimeEvents.js\":\"d00f08a8bdd9a70e\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/togglable.js\":\"b97b143210a7b2d8\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/variantFacet.js\":\"db6edc6f7ed8ff29\",\"/knowledge-medium/pr-preview/pr-1494/src/facets/verbFacet.js\":\"63d51ba40c4ffe13\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/block.js\":\"a2cc2f2c8e4eceb0\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/focusedChild.js\":\"abc82d27400ba86a\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/propertySchemas.js\":\"37640063deb98d56\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/typeRegistry.js\":\"7465dbd9f3874116\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAncestorCrumbs.js\":\"34e826d6d7e6d182\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useAutocompleteListbox.js\":\"568e3ae5f676b785\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedSearch.js\":\"6710a8198254eeea\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useDebouncedValue.js\":\"5f34e8c88bd2e79c\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsFocalRender.js\":\"f03ef46e9ed975c7\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useIsReadOnly.js\":\"e87bdbd3f7f5a25e\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMaterializeBacklog.js\":\"3143cacbea33f0da\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useMinuteClock.js\":\"a928b8bbdb263b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePanelLayoutProjection.js\":\"a91bc8e65c5b54fe\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/usePendingInvitations.js\":\"ea0eba1acc25881b\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRendererRegistry.js\":\"4ceac66aaa61c3d8\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useRetainedFieldRows.js\":\"40a54f2496c33da9\",\"/knowledge-medium/pr-preview/pr-1494/src/hooks/useWorkspaces.js\":\"0d7661607fc819d1\",\"/knowledge-medium/pr-preview/pr-1494/src/lib/utils.js\":\"88480d086eb7cc3f\",\"/knowledge-medium/pr-preview/pr-1494/src/main.js\":\"8aa60034309b1d7c\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/MarkdownImage.js\":\"b3a354e79deb6f7b\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/blockSeparators.js\":\"426c071b41e199a3\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/context.js\":\"2b32cf2137553d29\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/defaultMarkdownExtension.js\":\"aaf6cd15a5375a73\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/extensions.js\":\"7b0d898e31a6396b\",\"/knowledge-medium/pr-preview/pr-1494/src/markdown/renderMarkdownHtml.js\":\"73074382b8f41467\",\"/knowledge-medium/pr-preview/pr-1494/src/minimal-editor.js\":\"a14563bcb33b96c0\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/armedCut.js\":\"6d20649e2fc7eef0\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/captureMediaVerb.js\":\"3eee62ee98d8fe13\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/clipboard.js\":\"7683be867370e531\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/decision.js\":\"c5093a172b6d7913\",\"/knowledge-medium/pr-preview/pr-1494/src/paste/operations.js\":\"060014f6ec371229\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/AccountHeaderItem.js\":\"0a166ea3cb79e415\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/account-header/index.js\":\"fb8f11a9c7e68405\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e82c2c1726f6ec2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askAgent.js\":\"b262750106c5141c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/askedStore.js\":\"b865603e8709a854\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"78fa8a0f064c2cca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/chipState.js\":\"2610f29b2e877a30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2b50006e8899442b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/index.js\":\"9b7586ed4b07c705\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"013d59626e82f852\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-dispatch-companion/schema.js\":\"03a0c0e8c374d66d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/AgentTokensDialog.js\":\"30bef18b072d65db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/BridgePairingDialog.js\":\"99f6d63680b9a35a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/addMedia.js\":\"14d0deca5621f0b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/backlinks.js\":\"fef6eeb2348f2f4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/block.js\":\"ce11b572e005df7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/context.js\":\"b26dba79e7e774ea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d32595702c7a4f54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/index.js\":\"0513a870cf52c779\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/outline.js\":\"52e2d43da068744c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/properties.js\":\"72b50eb176e6b8ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/refs.js\":\"7c439159211fcd48\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"de357e6f96e42782\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/search.js\":\"a2a54fa615a633d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/shared.js\":\"a5e2ce835bc1c200\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f18957cdc05f30b1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentViews/text.js\":\"f58e06820020ddcf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/agentWrites.js\":\"da388a5f008f8c46\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/authoringCatalog.js\":\"1bcd29078a2f8dbe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/blockRefTargets.js\":\"805c625717ae4cbd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridge.js\":\"be8042f69fe8e1ea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/bridgeLoop.js\":\"9e119ae6246e191e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/changeHistory.js\":\"e07b9ef4fab0fc23\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commands.js\":\"d18dc0b9256ea6fd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/commentsCommands.js\":\"a7c5617421ee05f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataExtension.js\":\"61c5a1fb2fbc94ab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/dataModelGuide.js\":\"17139a8943be8b78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/describeRuntime.js\":\"2741d1588f930f11\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/extensionLint.js\":\"22a2a1ced12dc7e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/grainAudit.js\":\"fd1cb22f324bf68c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/healthCommand.js\":\"8032dd287802a322\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/index.js\":\"28f2a9bcb2e7de15\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/presetIdentity.js\":\"4413222a4b0d1bb8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b5e04ba7546ff25c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/readMedia.js\":\"6aa11cc73808d067\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/schema.js\":\"000e507c7c590476\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/serialization.js\":\"bc472fd4ef7388b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/targets.js\":\"64e8bd65dbbc4ba6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/tokens.js\":\"84168887292965a5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/watchEvents.js\":\"75b1662664d5d8a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/workspaceGuard.js\":\"2b70322d1cba5a63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/agent-runtime/writeCommands.js\":\"420c2610821c0757\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/AliasCollisionToast.js\":\"58bcb1c89593c7ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/DuplicateNameBanner.js\":\"86f5b24dea96c112\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/collisionMerge.js\":\"e4dc2c51289d9f80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/dataExtension.js\":\"323b7e20f447e104\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/index.js\":\"c04eac7b74e35037\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/mergeCollisionAction.js\":\"f1af5bd69e399ec0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/pageStyling.js\":\"192a96ad8c78fc56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/rejectionToast.js\":\"eaadfd55a422c8a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/alias/syncProcessor.js\":\"922fa59424a879bd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/actions.js\":\"baf1298281265096\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/addComment.js\":\"919fc5d20953b178\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchor.js\":\"0fdcc695e6650044\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/anchorState.js\":\"c055a5f224b1f6dd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/commentLinks.js\":\"bdc20bdf3ce7e953\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/confirmThreadDeletion.js\":\"66524e2abf839826\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/container.js\":\"59d05a3e2fd9546f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/dataExtension.js\":\"ecd7b0dfcd157c02\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/deleteComment.js\":\"b5417a91bcb89d3a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/highlights.js\":\"7ddc2f5be70269c2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/index.js\":\"fec45e886f781d5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/linkedCommentsPill.js\":\"053b2663a6bbbe0a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/margin.js\":\"531c1257d6b868d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/marginSchema.js\":\"e3f5ea649bfbe246\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/newComment.js\":\"6379d36e17c1aca8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ownThreadPicker.js\":\"d2fb4eb86e0289d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/placement.js\":\"98168880cda6e471\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/queries.js\":\"3dfde6609d212444\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotePosition.js\":\"d21222257e01b975\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedIn.js\":\"536fbb9b80bf739b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/quotedRange.js\":\"133cae6e95db9d0a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/rangeRefs.js\":\"3a956306df6a651f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readHighlights.js\":\"12245eb78eef21a7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelection.js\":\"a5b54df0ca353d35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/readSelectionUi.js\":\"226445be90b7fffb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/reanchor.js\":\"787dd2dcf6124fb1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/schema.js\":\"5de41f8d4e017a73\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scope.js\":\"0162148258475e7c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/scopeThreads.js\":\"ef8e098b04cd37b9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/splitRetarget.js\":\"2f3159727dd44ce9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestionCard.js\":\"cca18ff52d57a70c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/suggestions.js\":\"bac04cdcfe66bdf5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaries.js\":\"7e0689604fa1bbd3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/summaryBatch.js\":\"a2c57c83cf9b82fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/surface.js\":\"1a7bf38e7d59b20d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threadNavigation.js\":\"f7563747875f5553\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/threads.js\":\"b18544576ead9b8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/ui.js\":\"5063d130fff482b7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/annotations/uiStore.js\":\"a21ce96ecef3afe3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/appIntents.js\":\"a1322e44f4d7138f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-intents/index.js\":\"720242aac3ad84e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/index.js\":\"0dcfbb8cf59d6f22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/app-update-prompt/status.js\":\"38c97452cc081f0b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"24b28de4c4c5722d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaBlockRenderer.js\":\"32a8e1ede2216cb2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bf0c3da1f8284a74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/MediaUploadReconciler.js\":\"bd769d6a0b21c4d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetDownLane.js\":\"c1550ee12cfc6568\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetResolver.js\":\"8f67c2c4e15efc8b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/assetUpload.js\":\"14b94e1146573239\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/attachmentCleanerIO.js\":\"d15c289cc371abbf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6a607e65304eb6ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/blobStore.js\":\"2a156bccc66d4b60\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/browserMedia.js\":\"2efdff0b24acbd26\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/byteStore.js\":\"db96b0e18e78678e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanerIO.js\":\"7f55a5f97b559127\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/cleanupAttachments.js\":\"c88c31bf8e5482b1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/dataExtension.js\":\"1379dac9f3575b28\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/downLane.js\":\"02f1f35f3edab86b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/index.js\":\"e70c86e4cb115fd6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/insertImageContribution.js\":\"bbd8d90607379143\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneArming.js\":\"091f6f19ff02ee43\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/laneLock.js\":\"6035375c3d37a288\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaBlock.js\":\"e91035c332608d2d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaCapture.js\":\"48537501d2b6dba4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaLanes.js\":\"a61f49fcf7d11f79\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewers.js\":\"0bdbb0d3039b334d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/mediaViewersFacet.js\":\"29728b5917dd9fdf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/pasteCapture.js\":\"8a05397c0040bc6c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/resolver.js\":\"3dbb750f54dfcc54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/retryUploadsAction.js\":\"ac440845dc02c4cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/storagePaths.js\":\"2a411e87422e671b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadDrain.js\":\"e1a6849b0b15daae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadLaneStatus.js\":\"949244019d44040f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadReconcile.js\":\"417b57d21cd82d22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadRecovery.js\":\"4e7d5854a4a80865\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/uploadStore.js\":\"de1294cbf57ad4f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/attachments/useAssetObjectUrl.js\":\"752ca896185efa4f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0eacc3380db6fe68\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2ff3e31f63e305c7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/facet.js\":\"c85501bc67fc3ba9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/index.js\":\"fc97bac0bf901de0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks-view/prop.js\":\"29f3bb0938ded3d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinkFilters.js\":\"011b3f60045a57ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"af7db69d32f2c27b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/BlockEntry.js\":\"dbc12e253898ee2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/LinkedReferences.js\":\"6e669e357819c339\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"83d80f73ff6a65dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dailyNoteDefaults.js\":\"9eea5c940a9ac9d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/dataExtension.js\":\"4c6ce6f96f0a9f99\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/edgeExclusions.js\":\"14da625221f862be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/filterProperty.js\":\"bdca237654f15eb0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/index.js\":\"afd1564b8b239168\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0808476a9756cdf6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/applies.js\":\"8f61615605074b56\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/countQuery.js\":\"ebca0d61f5d2e028\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/expansionStore.js\":\"412fd5a22a166325\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/index.js\":\"9a5e2078fa6138aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f78f4be8489e2fc1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/presentationInvalidation.js\":\"d80654a026915e92\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyEditorOverride.js\":\"f994bcb669c5765d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/propertyFilter.js\":\"a874d8bff034f2be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/query.js\":\"5f58108efb4eb4ac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/resolveFilter.js\":\"e2c2bd54445605a0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sourceBatch.js\":\"9085ad16517305e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/sources.js\":\"186644c6c39fcc8e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useBacklinks.js\":\"abb4d900d308c0c0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"852faa5ef99972b1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayCelebration.js\":\"64bac1db4e398319\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/BirthdayOverlay.js\":\"faf0151fdf7dbe70\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/gate.js\":\"2014d682d1f765cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/index.js\":\"1f7a7d6ea6d5f4f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/birthday/wolfTheme.js\":\"0f84a68bc464e6d3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/BlockDragLayer.js\":\"24ec4462d351426f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dragController.js\":\"5829e5886ef48b63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/dropTarget.js\":\"56539b9127d263ae\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/index.js\":\"bc772c22fb041486\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-drag/projection.js\":\"033e1cbe392fd42e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/BlockMetaCard.js\":\"00bdd54f257d2296\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-info/index.js\":\"727fa4000c8282e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/AddTagDialog.js\":\"e620f1a956c8a742\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f816d9946f0d26e9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/TagNameIssueHint.js\":\"9441c2ff5ada4911\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/addTagAction.js\":\"b1897dbedf81209a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/appendTag.js\":\"7c16e755293f511d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/config.js\":\"19d5e9217d9bc9db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/dataExtension.js\":\"2384b5eaa5e96e05\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/index.js\":\"6756a1fd5dadf063\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/block-tagging/propertyEditorOverride.js\":\"becc9c7182656086\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b85c7e46c0da362a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"545baadf318e07d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f654d83cb571fd54\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4ee12d47ea3f9e87\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d3d9ebb02cb3c802\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/index.js\":\"e35c7417c93201cc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"42638ecb4de4fbcb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/CharacterCountItem.js\":\"0e07007f3d6aff61\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d7612a4450c166dd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/actions.js\":\"e09f9be8819f13f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/blockType.js\":\"151a10acbf49a5c9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/charCount.js\":\"a9cb37989a17d72a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/dataExtension.js\":\"b872c89e31c76d99\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/index.js\":\"d4bcaaefcb6fb7f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/profiles.js\":\"a8074aeb398c7cf2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/properties.js\":\"0ea3cbfbff8b650e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/character-counter/textCounts.js\":\"49398e3d920777a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/colemak-keybindings/index.js\":\"8b85b312e068775b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/CommandPalette.js\":\"170d83d867f2ed63\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/HeaderItem.js\":\"2721a6d317ebf69e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/context.js\":\"1dee6fed7fafad0c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/index.js\":\"5082435cd10802aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/selection.js\":\"f3679ce570c6bad5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/toggleStore.js\":\"897881b4f8c09e03\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/command-palette/useCommandPaletteActions.js\":\"ac3cd31e6fe5c82e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/ContributorBadges.js\":\"37ce7545b41c96fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/author.js\":\"dbfc2ccd38169401\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/codeMirrorExtensions.js\":\"18bdb577046e0e5e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/dataExtension.js\":\"99126eb8f37d1742\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/index.js\":\"1dfa5a63f1654f9c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/mentionAutocomplete.js\":\"9684b3acc6e8045b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/processor.js\":\"593fae47e20c1971\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/profiles.js\":\"7669962a6b2c74d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/queries.js\":\"38607d8ffa00015a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/contributors/schema.js\":\"5c3134b462ff24b5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9e953dd13f6c5eea\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/followOrigin.js\":\"bab17ddb57c5d511\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/index.js\":\"1a29eb0537036421\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b8e56918294f72b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"fe73f44d67b27997\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/CalendarGrid.js\":\"b52b3f8785fd35fc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DailyNotePicker.js\":\"2e90343090f019c2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"428b00b0204f0f96\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateNavDecorator.js\":\"3e2b9b157a7b01ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/DateScrubOverlay.js\":\"0d7f6168d8350d3b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/HeaderItem.js\":\"e93d853c07a7e5a1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/ReschedulePicker.js\":\"7f45348695a68180\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/SpreadDatesDialog.js\":\"449bfa3c6ee83bb6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/actions.js\":\"6d3b4f9da11ba1e1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/blockDateAdapter.js\":\"a2ae4bcebf44ac6c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/calendar.js\":\"be1f20d292ee20a3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dailyNotes.js\":\"7fd823e721f221bc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dataExtension.js\":\"10df15c53889beec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubActions.js\":\"cf8e4491f620c8e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGesture.js\":\"e5f9d07507b7c61f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubGestureActions.js\":\"026da116e27f1d58\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2ad3d66fcc3efd2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/deletionGuard.js\":\"30211ff45daa6f06\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/dueQuery.js\":\"1581c2baf2834f5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/index.js\":\"c6a2b9fd45a371bb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/landing.js\":\"7ef5b53dfcbff2b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/localSchema.js\":\"23d3021b553cc1ee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/referenceDateAdapter.js\":\"52ad29b2bdfc84a6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/rescheduleAction.js\":\"cc3186004bc87ecf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/schema.js\":\"5becde4093f302e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadBlockDates.js\":\"02a8d73bb0144d75\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/spreadDatesAction.js\":\"037868c5384db6bf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/today.js\":\"02fb196bc990f732\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"daeec45c191fd279\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"892fe9a5a208b51a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/audit.js\":\"613e06d0198cfd8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditAction.js\":\"b0e3b0c17607599e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/auditRanges.js\":\"1e1d43b9dbf6955f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/diagnosticsSource.js\":\"ac229ef1a1ee2507\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/divergenceScan.js\":\"28acefa7367cb856\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/index.js\":\"0471efb33b7e58e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b34d3fe17013e294\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/referencesMirror.js\":\"e04b334381d57086\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/rowJson.js\":\"a0f786b3640a8690\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/schedule.js\":\"8084e863cf776f2e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/data-integrity/store.js\":\"15f06e9d8329db74\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/action.js\":\"2648306f2e8d3804\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/index.js\":\"f3d205ac3016c764\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-maintenance/plugin.js\":\"9e749f219fd16955\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"65372f2ec643ed15\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/actions.js\":\"20ffd61008ac4cc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/changeMarker.js\":\"3ea4e0823d9544a9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/diagnostics.js\":\"d3b3fc7020d77486\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/fileSystemAccess.js\":\"1bca1e612d709b82\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/filenames.js\":\"2958df78e4b6af1e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/index.js\":\"d3f7b0aeb7949c50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/mirror.js\":\"1f8f24e515a5018a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runLock.js\":\"cde011377fb93366\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/runtimeHealth.js\":\"2c2d3b1ff826da5f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/schedule.js\":\"126de211cbd828b8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/db-mirror/store.js\":\"c4f1761bfe85d51a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/index.js\":\"8a533a0373e6b053\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/default-themes/themes.js\":\"a4ca7f7ad1528e4a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/facet.js\":\"4cf495f9660424cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/diagnostics/useDiagnostics.js\":\"1a98d0371a933b22\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/dismissals.js\":\"7ce90c7e026dd46c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/index.js\":\"cc4ebb916f2f5e71\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/status.js\":\"ada4b16866808389\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extension-prompts/store.js\":\"9c0df637673d0559\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3a0c938e52867526\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/ExtensionsSettings.js\":\"68a5b9fb2c6a1473\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/actions.js\":\"98b9e5139ac4f31f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/config.js\":\"e529404c21aa3f65\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/dataExtension.js\":\"1b15b16f32db77fe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/effect.js\":\"773bc90ffe749a83\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/index.js\":\"713a300262c688b6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/propertyEditorOverride.js\":\"fb6ea12cfccd74be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extensions-settings/useToggleTree.js\":\"b562922c9e9742c7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/ExtractTypeDialog.js\":\"fb9e0ce2258b46c3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4dfc36ea877232e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/PropertyShapePicker.js\":\"ce944a6c9c2d220a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/action.js\":\"519cb606ca99fb13\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/extract-type/index.js\":\"86bec470497e1b78\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/FindReplaceDialog.js\":\"7f775453c3d0ddab\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/HeaderItem.js\":\"0000b9e36f58b473\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/dataExtension.js\":\"898630634a57022f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/index.js\":\"066d975815795cb1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/search.js\":\"d4cfd98a9a09984d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/toggleStore.js\":\"111810627776fa53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/LocationPropertyEditor.js\":\"50979cbe212fa6f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/MapView.js\":\"3beb2ec9b9fd078e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/blockTypes.js\":\"44e7160132c3cb9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/codeMirrorExtensions.js\":\"b9fc8efe4a2cb646\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/createOrFindPlace.js\":\"6941fcfe8c19763e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/currentLocation.js\":\"f887657cbefe31df\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/dataExtension.js\":\"d934554b61e9ee8d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/geoContentDecorator.js\":\"c9851ab5110838fe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/googlePlacesClient.js\":\"e0599e25ac3fc6ee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/index.js\":\"519e2f00e5b0f293\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/locationsPage.js\":\"83168243e579aa7d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/mapViewport.js\":\"e0f3e5545e6841d9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/pickCurrentLocation.js\":\"59751ec1c402d9d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeAutocomplete.js\":\"c9fc4bb5d548be2a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/placeNameCollision.js\":\"31e0a90d0f1e8376\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/properties.js\":\"157ec5ce39a3a87e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/propertyEditorOverrides.js\":\"5ab72a995a6acc69\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/query.js\":\"d19f9e739a46947c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/geo/usePlaceSearch.js\":\"e781c339a6cc0e5d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d87f0c67d402bc53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9048c4b3bcbf4079\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1f0709513fa01482\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/config.js\":\"250c13fa99c7acfc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/dataExtension.js\":\"3c208ba35e28edc1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/facet.js\":\"d9ef920987a3581d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/grouping.js\":\"e70b5823e93ed4b0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/index.js\":\"5428d2e9fccb96cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7f8885a5335a4963\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/query.js\":\"0a6ad792a04c0b4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/resolveConfig.js\":\"1d25048448bd29b4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"22ab67c5aa0bbfce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5c21e6dea4a269ec\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlDocumentContent.js\":\"86bcb9a526c4604e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/HtmlFrame.js\":\"875ff1e7384c658f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/actions.js\":\"b99d37e9fdebac29\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/blockType.js\":\"d31b632cb7ace04c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/confirmRunScripts.js\":\"792b7dae29cb810d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/dataExtension.js\":\"b2a72931b9c87be3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameAnnotations.js\":\"db6a339d9bc427cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameDocument.js\":\"1235d6564c1225fe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/frameTheme.js\":\"abc61de9edeba57c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/index.js\":\"2b23d7836aa7b3ca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/scriptConsent.js\":\"374edbbdd85b1067\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/sourceMap.js\":\"bb1f3ccdde85d544\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/html-document/useDocumentScripts.js\":\"bbcb65ed154ef9f3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/index.js\":\"25de05de828f8579\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/record.js\":\"54c755af2272a5f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/recordStore.js\":\"66b915baa2dacf98\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/responsiveness.js\":\"909947c6d469702d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/schedule.js\":\"e14c6d4213c3483f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/interaction-metrics/sessionContext.js\":\"9b35e5837976409d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e271d5ecd53316f2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"27584f92a86fd597\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/actions.js\":\"e173d1c578f808b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/config.js\":\"2660c9b05debafd0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/dataExtension.js\":\"10b2b9e0a2844ded\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/effect.js\":\"19ac9aae2c50fd90\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/index.js\":\"2a5f537bc3f12ef3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/keyCapture.js\":\"81a93ac74412f928\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/overrideStore.js\":\"09654bfe573c8b2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"804295e23d5d8c19\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/HeaderItem.js\":\"e8c99f09aa995649\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/LeftSidebar.js\":\"3a3b29821af8ac80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/actions.js\":\"7697dc6273701ff1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/facet.js\":\"f9c2bf5893484eda\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/index.js\":\"e769db5fa489bf30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/shortcuts.js\":\"6adf2b3b6a79e8e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/left-sidebar/toggleStore.js\":\"7fffedbc4da2a26c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/MergePicker.js\":\"ba92567b55fec0db\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/index.js\":\"6db28d9fcfc88514\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/mergeAction.js\":\"f70ee0d7774b7519\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/merge-blocks/strategy.js\":\"952d1a55d07cdac5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/Button.js\":\"87bc870a9743dc9a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7e9e66afc042b66c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2554b22ab2859318\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/facet.js\":\"378dc83359afa901\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-bottom-nav/index.js\":\"fd26539ab524cf90\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"581788ec6038e0e7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/actions.js\":\"50abf7fcde4b5a4d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f0db2a75e297914b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d6590e10e747f998\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/mobile-keyboard-toolbar/index.js\":\"2d77d3c3ad2ed040\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/MoveDestinationPicker.js\":\"381fae74061893da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/blockSubtreeMembership.js\":\"169d7474b9072a60\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/contextMenuItem.js\":\"1a6b493b33f9d0d7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/index.js\":\"0667b731a9a18694\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveAction.js\":\"6b1b14f2e947d9e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/moveBlocks.js\":\"61fbdcc77d242ea7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/move-blocks/selectionAfterMove.js\":\"9813505c31410844\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/TutorialBanner.js\":\"1c469e57768430b3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/action.js\":\"9b0ae1a36020659e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/bannerDismissal.js\":\"7ee5a2847d220fc5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/documents/cheatSheet.js\":\"f6f76fe4eb16932e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/index.js\":\"f0a0dc223691eb98\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/keys.js\":\"139d65ed6add9adc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/landing.js\":\"37ca85e99e6af2da\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/outline.js\":\"3de7c77b7be9fbf5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/onboarding/seed.js\":\"1398ab29da92f2d4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c4ce633a0edcc424\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/analyze.js\":\"bad22f575438c057\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/diagnosticsSource.js\":\"01797b9ebdfcf724\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/index.js\":\"b007ed90e1846753\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/load.js\":\"19c48e55c59fbd79\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/monitorRun.js\":\"e0d9769697c1abf9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/schedule.js\":\"abc197ece138dd97\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/series.js\":\"0afb0788015dd16f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/store.js\":\"653d883ae0cc7dc6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/trendAction.js\":\"3eadb3dd2f9d3051\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/perf-monitor/verdict.js\":\"5a2f050743c13caa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/clickToEditAction.js\":\"45feff5fc010f82d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/index.js\":\"73c7b69c83d9f2e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/plain-outliner/interactions.js\":\"383e92ef6f2fe9ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8a61cf28dc25fa66\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGate.js\":\"e1716d1354dffda6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/MigrationGateDialog.js\":\"9d48d041dee04f52\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/action.js\":\"25520e6aaef50295\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/index.js\":\"5051e958c522010d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/localRunMessage.js\":\"9f03e0e381baffc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/plugin.js\":\"2a77a0c2825c0072\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/progressReport.js\":\"9ee0d5d039ae1caa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/properties-migration/sweepProgress.js\":\"a81be204a3b672aa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/FieldRowRenderer.js\":\"acec58a3ab5d015a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/ValueRowRenderer.js\":\"4c0502bfd070c997\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/actions.js\":\"9838046ef881dd72\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/autocomplete.js\":\"bc5aae3166bb9c2b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/fieldRow.js\":\"486847c953ff4389\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/index.js\":\"6dfcdb436db21874\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/referenceWarning.js\":\"f4fbe20cdf41fb52\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueAutocomplete.js\":\"2e9d9bc56e54acd6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/property-rows/valueSchema.js\":\"4d2ce2c613a3f2e8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/HeaderItem.js\":\"b8fdee08725f62f4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/QuickFind.js\":\"c4a47bfbc68e4915\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/index.js\":\"bb0a1a582534faac\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/recents.js\":\"ed7d2caad76406d0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/resultItems.js\":\"c6db222dd323e3fa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/selection.js\":\"d5f84fe9cfba807f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/quick-find/toggleStore.js\":\"c00e59e30bd521de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/HeaderItem.js\":\"6c823b77bdf4973e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/RecentsPageBlockRenderer.js\":\"df25951c2892cd3b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/grouping.js\":\"947306ed4113aa50\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/index.js\":\"e54df7cbfff989d6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/recents/target.js\":\"3694c54b9a8bd07b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/codeMirrorExtensions.js\":\"135717fdd3e95cb9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/contentPrefill.js\":\"4aa1cd3cfcdf3347\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/dataExtension.js\":\"0768ba87d905ef85\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/index.js\":\"64b5f12b14ef6cf7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ebe84040f7bfc2e0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/invalidation.js\":\"a0ef4c22b67a2851\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/localSchema.js\":\"dd6c98973f8d2313\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/index.js\":\"ae09cdabb7c99238\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d5a24b4f3fbfb47a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/index.js\":\"a6358a027fd1dbc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/referenceNode.js\":\"1e8c6feac165ea10\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/remark-reference-occurrences.js\":\"08b2907354185e86\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d47261caa137fdc2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/index.js\":\"49f0ac7350b2d824\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"deb22d72a54d3e3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"07ae6e710679a257\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/mergeRetargetProcessor.js\":\"68f85ccf7d6a9a30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/parseFence.js\":\"f519304008997a7c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceParser.js\":\"c49b9f1482a73bbb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referenceProjection.js\":\"20167ae4d98eecaa\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/referencesProcessor.js\":\"6e45958885dd2ac3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/renameProcessor.js\":\"b35e4c730e2493e3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/references/spanReplacement.js\":\"fdb8bd2c81a4b418\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/htmlToOutline.js\":\"9e093c92b217eef8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/index.js\":\"adf26cd235bfdf39\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b06265d2d63503ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/rich-paste/pasteDecision.js\":\"9793eb8fe00facf0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/action.js\":\"ac12745d204d0b02\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/blockIds.js\":\"e682e85b7c3c2819\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/content.js\":\"944992a5af88e1be\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/effect.js\":\"8942d166cb53c463\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/ids.js\":\"fcda58cd473375e9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/import.js\":\"69ec3a5c00e20599\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/index.js\":\"7d738eee60ee9b53\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plan.js\":\"635e3a5a92090b30\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/plugin.js\":\"d40ac39faff13c7e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/promotion.js\":\"0fecd5b87bd652f6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/properties.js\":\"6564e7fefdb65818\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/references.js\":\"ae4d8b70a60db277\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/report.js\":\"e87ebc4b4eb3f2ee\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/roamMemo.js\":\"3c45d0f9b44893ef\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/runtime.js\":\"12910186f9176067\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/schemaReconciliation.js\":\"dfa80463ff29fce0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/srsMarkers.js\":\"a786707428117bca\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/todo.js\":\"5c27ab4dd7549e94\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/typeCandidates.js\":\"ad775c14a0c0824e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/roam-import/types.js\":\"817dcd3d93c1a366\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/index.js\":\"429cb18d530fc330\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/search-health/store.js\":\"f9c4b43f210de696\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/HeaderItem.js\":\"99c2fefeb163ec71\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"417bba8360c82bdf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/index.js\":\"8a4672b7e3e95fcb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/model.js\":\"056396aef5e88608\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/toggleStore.js\":\"ddbc78ce74b4ff9f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/shortcut-help/useKeyInspector.js\":\"132790148595e8ff\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"24d6c0f530b08479\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/ShellDecorator.js\":\"3051d3dce108a846\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/actions.js\":\"7a78d8f881cf0d92\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f13ec439402b8b42\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/index.js\":\"3720f8ff872d6acd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/shell.js\":\"6f4a59a635684596\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/surface.js\":\"14a82d2982678e1c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/spatial-navigation/walker.js\":\"b471b179212f8ed2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/RescheduleToast.js\":\"155171297ae11fa2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/dataExtension.js\":\"b18d3a372661fdc7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/index.js\":\"ce826f6c392828bb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/indicator.js\":\"7d6cdd9cebe2a850\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/moveSrsState.js\":\"10a774d453cc2385\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f82cde2fdcac2089\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/scheduler.js\":\"c74c00b37a31821b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/schema.js\":\"f4c596a4479c4d9a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"32c6cd9a0670ed84\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/srsClipboard.js\":\"0b44b2cd93ffd745\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3ed4b7f7cd152862\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4582ad359b67016a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/DeckPicker.js\":\"b885921681eabefe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewControls.js\":\"84c7f4ae757f6bb6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a1bc28bfa0b84860\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/ReviewSession.js\":\"f8b9febba82e67dc\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/actions.js\":\"c7036a4b844ead64\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/archive.js\":\"9ef0546d8c0930f0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dataExtension.js\":\"57dfcfefea842b76\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/deck.js\":\"5190d2efd40b398c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/dueQuery.js\":\"0b296b6f5f11bf3e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/gradeDecision.js\":\"982bc4723c810a35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/index.js\":\"88eb96ff54e30008\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/keyHints.js\":\"802ac4a9a3801c4f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewCardLayout.js\":\"ecae497bac90da80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/reviewProgress.js\":\"50d0754e0bef1bd3\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/schema.js\":\"eece17165d89eb0e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/srs-review/useDueCards.js\":\"3a5c0e2c2f3b0a80\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/index.js\":\"e0b7796bdf61e10c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/startup-metrics/record.js\":\"69c55bd008d10aa5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/index.js\":\"9b2e56430eb14359\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/persistenceStatus.js\":\"8efd0b99deefde02\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/storage-persistence/requestAction.js\":\"e7ec5874d71b2117\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/TypeChipsDecorator.js\":\"b182a9a37d93e11e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/codeMirrorExtensions.js\":\"d177cf24fb961466\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/index.js\":\"599762ba103caaa6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/supertags/typeAutocomplete.js\":\"bdd163589e7250cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"66c385a8188640c0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/actions.js\":\"26733763ada9a041\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/anchor.js\":\"0f1ac724ed238386\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/events.js\":\"7a7f0a49c18b62e6\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/gestureActions.js\":\"be34e6d2325d755d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/index.js\":\"f556ca188f108b04\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"53f7366a6764e4b5\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/collect.js\":\"4ded21b6b14c96f9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/index.js\":\"105b7d6bc76958b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/sync-metrics/record.js\":\"b450706425e9d2de\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/RejectionDialog.js\":\"854fbce83721473f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/SystemStatusHeaderItem.js\":\"09843c5e77560bc0\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/index.js\":\"805ed7dcd6a06d52\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/model.js\":\"302e23cd18a61c0b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/queueCounts.js\":\"c96f38b0827621cd\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rejectedHelpers.js\":\"fb155e7973f6a16d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/rematerializeAction.js\":\"1921156fdd8452f2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/system-status/useHysteresis.js\":\"7af44f0de167dc6b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/ColumnHeaders.js\":\"a0af08a87e83290e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/QueryUi.js\":\"9070996b0e850793\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/TableLayout.js\":\"7f101eb7fa75d2fe\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/actions.js\":\"6ef90d372064c9d1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/cellEdits.js\":\"54e7b21ea7fb94c1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/columns.js\":\"5e655150a936ed8c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/controller.js\":\"85b225449e704028\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/convert.js\":\"22b4de2d0384a3f7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/dataExtension.js\":\"517cbf22dbbff5cf\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/index.js\":\"84eb820d464812c1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/keys.js\":\"aa5fca14d4f4bf3f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/model.js\":\"d20af1ec47af8e1d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/navigation.js\":\"234777478d6c18c4\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/backfill.js\":\"2bb052353adb35b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/completion.js\":\"56107ef9a79d1023\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/format.js\":\"60871ea15e6cec76\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/parse.js\":\"bc9f8fbb7824ce59\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/queryValue.js\":\"d81570a3170725f2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/query/source.js\":\"c2b4188ad0366607\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/registry.js\":\"eea4640fba4a105f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowGutter.js\":\"5fd49c809d078815\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/rowVerbs.js\":\"cbeb160161716498\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/schema.js\":\"75ba0d218c3135a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/tables/sort.js\":\"dfe5e633b1ac73cb\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/effect.js\":\"2a400c9ac939dd92\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/index.js\":\"f1d0abb39732df35\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/theme-toggle/theme.js\":\"7b430c4d47bd6de9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/actions.js\":\"74ee29a6db45ff59\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/dataExtension.js\":\"f6842aa06d4bb7ce\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/index.js\":\"defd56ff6db8e662\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/todo/schema.js\":\"2d0e4d98c4aa0de1\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9a99daf54b4ef78a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/actions.js\":\"8c0001bd4b831e23\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/defaultItems.js\":\"5d9afddcb6513ff9\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/facet.js\":\"8b47c542f38dcb5a\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/holdRecognizer.js\":\"02186888a29a9f4e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/touch-selection/index.js\":\"65ce39e39b919ade\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/UpdateIndicator.js\":\"4b147f8ade0dff7c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/index.js\":\"63c1e2e2eada8f3e\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/update-indicator/loadTimes.js\":\"1ee139e523cb0937\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoNotesRenderer.js\":\"33379d2af0057df8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoPlayerRenderer.js\":\"150667e95e11e13c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/VideoTimeStamp.js\":\"dd461768680f523d\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/actions.js\":\"4a85fd3226aab820\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/index.js\":\"e069159eaef9076f\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/markdown.js\":\"5bb6302b3859b48c\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/notes.js\":\"a9905c06fc0a162b\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/registry.js\":\"fa31d0f87c289b18\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/remark-timestamps.js\":\"237df85dfbfe1fd8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/video-player/view.js\":\"d9fa280d8fe4bece\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/LinkHints.js\":\"dd1ca43a483957ba\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/index.js\":\"18e168b4f1b671b2\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/model.js\":\"8aebc613b6377c21\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-link-hints/settings.js\":\"50f71b4f1eefbbf7\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/actions.js\":\"0f3f54202dd1b242\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/index.js\":\"aca72ebdf614f808\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/vim-normal-mode/interactions.js\":\"f67b23d28d3963a8\",\"/knowledge-medium/pr-preview/pr-1494/src/plugins/workspace-header/index.js\":\"ed23020562bf5474\",\"/knowledge-medium/pr-preview/pr-1494/src/registerServiceWorker.js\":\"811f9bc60941e6c1\",\"/knowledge-medium/pr-preview/pr-1494/src/requestPersistentStorage.js\":\"f9f21b5da7dc7778\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authRequestDeadline.js\":\"a4aae8351ed8737b\",\"/knowledge-medium/pr-preview/pr-1494/src/services/authStorage.js\":\"ec9f6edb30ba0826\",\"/knowledge-medium/pr-preview/pr-1494/src/services/powersync.js\":\"19da48732e849c0c\",\"/knowledge-medium/pr-preview/pr-1494/src/services/supabase.js\":\"4db29b889b89f175\",\"/knowledge-medium/pr-preview/pr-1494/src/services/uploadErrorClassifier.js\":\"ddc23f12b6a729d3\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/ActiveContexts.js\":\"34f905e0a06ab777\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/HotkeyReconciler.js\":\"1adfa5534f6312c6\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/WipeLocalDataDialog.js\":\"55d0f56d8279a245\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionDispatch.js\":\"9f464e4fbf0162a2\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/actionRefItems.js\":\"7dc7a565ff47d004\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/applyKeybindingOverrides.js\":\"71d580683f03bad8\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockActions.js\":\"126477d1582388e4\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/blockMergeGesture.js\":\"599faf9479240ff3\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/canonicalizeChord.js\":\"b57435f2fd822259\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultContexts.js\":\"309dd347be8b921d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/defaultShortcuts.js\":\"094e7b6e810bfc13\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/effectiveActions.js\":\"d5c88eca3854cda4\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureAction.js\":\"1cdabeebf53360bc\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/gestureBinding.js\":\"b5af2b62903f403d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/holdRegistry.js\":\"1a665e0779c94879\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingConflicts.js\":\"35c0c9df2bf4e730\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/keybindingOverrides.js\":\"7dc98df3adb7575d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/pointerAction.js\":\"0e61a1ef1959ef70\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/resolve.js\":\"f8188cc719a6b932\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/runAction.js\":\"f2d114d36a4f00dc\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/sequenceMatcher.js\":\"e4b83690d3ac38f7\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/types.js\":\"f16094c798e70e30\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionContext.js\":\"054274232f9a8a5d\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/useActionDiscovery.js\":\"b0b67de319b2d4b6\",\"/knowledge-medium/pr-preview/pr-1494/src/shortcuts/utils.js\":\"c98f1edb07c5dcd7\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/bootStore.js\":\"e3883d4522f2809a\",\"/knowledge-medium/pr-preview/pr-1494/src/sw/previewDatabases.js\":\"86dd0a3034640a2d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/byteTransform.js\":\"62b67c76fb7bf88d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/attachmentCleaner.js\":\"e6119067f833f711\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/attachmentParts.js\":\"0fbab5459565b664\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleParts.js\":\"e96ff3bf8a07a67f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/bundleRecord.js\":\"9b71078f0e4d2b66\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/manifest.js\":\"7db99d77915419ec\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/takeBundle.js\":\"826abd759311b267\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/bundle/verifyBundle.js\":\"74aa67336c73090a\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/cleaningStage.js\":\"4cdf81fee703ebf8\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionKey.js\":\"efe377f16e4f0517\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/conversionServer.js\":\"661e547455da943a\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flip.js\":\"1dda04bdf74acb22\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/flipAttempts.js\":\"7c25c9f0fc33df0d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/pages.js\":\"e83c3e2a7faffd41\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/preflight.js\":\"19dc5eae134ec42e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/reseal.js\":\"4fb33d89c885416c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runConversion.js\":\"dcc2d0ceb19daaf0\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/runLock.js\":\"03371bda04ce45c9\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealing.js\":\"e9ed94d85b21f9eb\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/sealingStage.js\":\"f76de63ea854832f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/stage.js\":\"e2247fe7a9c46b3e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/conversion/verifyReseal.js\":\"767939b8f328ef05\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aad.js\":\"98813ca78183ac73\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/aead.js\":\"bd278c37121da2b7\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base32.js\":\"df58c2856bba1908\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/base64url.js\":\"b8adbc1a03b8d004\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/binaryEnvelope.js\":\"e8ec81043b9b654c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/byteAead.js\":\"64b45233a263fd3d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/canary.js\":\"734614f9095210b6\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentHash.js\":\"cbf6bac50219d631\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/contentKey.js\":\"ef98d73703d2a4ac\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/derivedIdNamespace.js\":\"256aa2f6d77c363e\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/envelope.js\":\"84e7d45c07672395\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/hex.js\":\"1ec31dfc516afc72\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/sha256Hex.js\":\"d7111d52a2ef8a32\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/crypto/workspaceKey.js\":\"9f20635c5525b87c\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/conversionState.js\":\"4eaf505b639b8d4d\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/createEncryptedWorkspace.js\":\"00292418a07ad837\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/pastedKey.js\":\"de91f84a7c0c4537\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2243c2cfaf026a02\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8f2ce9a7da6ea275\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/keyStore.js\":\"518a3042feccf1c3\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/mintWorkspaceKey.js\":\"76310d43f7f325bd\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/modePin.js\":\"c1b51a145b2dc49f\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/openWorkspaceKeys.js\":\"2876337905f4acc5\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolveWorkspaceEntry.js\":\"f5bc592043623a41\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/resolver.js\":\"64d9727b456aa02b\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/keys/workspaceAccess.js\":\"563e0840dd6953bc\",\"/knowledge-medium/pr-preview/pr-1494/src/sync/transform.js\":\"b53c17a2f7527fa6\",\"/knowledge-medium/pr-preview/pr-1494/src/themeBootDefaults.js\":\"bf83e3b8b7012508\",\"/knowledge-medium/pr-preview/pr-1494/src/types.js\":\"3cbae101f7a07885\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/ClientLocalSettings.js\":\"c6446089da1c2fe3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/abortableSleep.js\":\"b8012e2dda3cf0fc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/array.js\":\"326b872702872f62\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/backlinkAutocomplete.js\":\"22c33b43e038c07e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockCrumbs.js\":\"49379530b7753c26\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/blockrefAutocomplete.js\":\"3000954a7e714229\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/cadencedIdleJob.js\":\"6ae419ef1892f97c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/callbackSet.js\":\"ba6e31f9f149292f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/clientId.js\":\"da312447c68c0149\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirror.js\":\"dba7bf64d2cece76\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/codemirrorCompletion.js\":\"b0336068b27fb964\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/copy.js\":\"94463648e0b8db93\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dailyPage.js\":\"415a9ed41a3ee975\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensics.js\":\"23a6b10be0fe1ba3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dbForensicsHooks.js\":\"66cc765c7795ba91\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/deleteBlockThroughUi.js\":\"bb76c9ac1a8589cb\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dialogs.js\":\"e470bd4933f4e40a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/dom.js\":\"33049d424ae1b0a2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/downloadBlob.js\":\"92d4699421926d8c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/exportSqliteDb.js\":\"403d4bc7b3863509\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fileSystemAccess.js\":\"9bfb1750e276f03d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/flipSlide.js\":\"8713c63a0391574e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fnv1a.js\":\"3f01733a80dc46bd\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/formatBytes.js\":\"76b6ce176fa9ee62\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/fuzzyRank.js\":\"9afb821aabc349fe\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idbKeyedStore.js\":\"69d66b8e0780bae6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/idleCallbackPolyfill.js\":\"13a0401ac27ab079\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardAwareScroll.js\":\"a865663e04683d1b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/keyboardViewport.js\":\"15cba115989dd8ac\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/lastWorkspace.js\":\"51d09b0b5ce41c2a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutColumns.js\":\"da137a8ff7065f02\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionDom.js\":\"d133e28ea6e322bc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/layoutSessionId.js\":\"8f9ce1031565eada\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkClickGestures.js\":\"efa47077a0e0b018\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/linkTargetAutocomplete.js\":\"479cb286785c4ae9\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbCorruption.js\":\"4de25601c31105a7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/localDbRecovery.js\":\"c433ec168c95bdc3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/markdownParser.js\":\"b9b40e30683e53af\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/memoize.js\":\"7591c5248cc510f6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameFieldCommit.js\":\"3b55954369b9cb3f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/nameList.js\":\"261d92b6147ab5ca\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/navigation.js\":\"ae8317df94e733c7\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/omnilinerNamespace.js\":\"4af816e1bf53d899\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/opfsPageScan.js\":\"387ef7556075ef37\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelClearance.js\":\"7e85def75d77f808\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelHistory.js\":\"13e95ebbf27459df\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLanes.js\":\"83de3006447b0db6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelLayoutProjection.js\":\"8fc68479daf68d03\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelScrollAnchor.js\":\"047f9e4cb7d588fa\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/panelUrlFlags.js\":\"ce3d629b7e218e6c\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/platform.js\":\"d603465674a4f35e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/pluralize.js\":\"34958406a877af2b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyCreation.js\":\"3cd37105b6aa5130\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyNavigation.js\":\"bd9eaa27c61b21dc\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/propertyValueContext.js\":\"3500ad26c97dd276\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/react.js\":\"d1e7431cba6d3e55\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeDate.js\":\"e499f3685237451b\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/relativeTime.js\":\"b5b73eae47cbcc3e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/renderScope.js\":\"a7e826ad1ce1683a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/resolvedThenable.js\":\"c8f466d9281811e0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/routing.js\":\"0e84162c6f54aede\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/safeMode.js\":\"d920f216436e2086\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/scheduleIdle.js\":\"65f3f36cc2e4670d\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/screenWakeLock.js\":\"5461b68a9c004630\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/selection.js\":\"8bd9d2cada65da09\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/softKeyboardGrab.js\":\"ba93b6a1aec82658\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/startupTimeline.js\":\"98c68ed2db95d41f\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/state.js\":\"17c04879654768b2\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/string.js\":\"ec06d0ab5b60ac54\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/surfaceZoom.js\":\"186f8d6c9b971ced\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/time.js\":\"718572a4ae1ff24e\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toast.js\":\"bbee8b7908608ee0\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/toggleStore.js\":\"b97973ac38fb464a\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/untilStopped.js\":\"c4b6219312713ea4\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/userActivity.js\":\"c7fd6c4a574a44d8\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewTransition.js\":\"dd588cdfaa0ed452\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/viewport.js\":\"8a37a796f4632577\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/webLock.js\":\"82f6b758cbecf945\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceRecovery.js\":\"9380c5397d5dd9d3\",\"/knowledge-medium/pr-preview/pr-1494/src/utils/workspaceSnapshotStore.js\":\"d1d66e9afe6b48d1\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-compiler-runtime.js\":\"74d6b31bccfc4b7d\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-client.js\":\"6a2b6426b69050e5\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server-edge.js\":\"dd5d78fc0dba8381\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-server.js\":\"70638039d7e8a42e\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static-edge.js\":\"a52dd85b9678c774\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-static.js\":\"357c3cf3207d3e62\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom-test-utils.js\":\"efaae764bd00854b\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-dom.js\":\"0d9268327647e553\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react-jsx-runtime.js\":\"ed13dbba31515b45\",\"/knowledge-medium/pr-preview/pr-1494/src/vendor/react.js\":\"a16de5e1423af1d2\",\"/knowledge-medium/pr-preview/pr-1494/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1494/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
