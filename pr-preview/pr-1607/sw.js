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
		buildId: "7d30d8802899-c69965dc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1607/\":\"3263491394529b7c\",\"/knowledge-medium/pr-preview/pr-1607/index.html\":\"3263491394529b7c\",\"/knowledge-medium/pr-preview/pr-1607/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1607/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1607/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1607/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1607/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1607/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1607/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1607/assets/FacadeVFS-Bpi1RiYh.js\":\"699188a3525d4284\",\"/knowledge-medium/pr-preview/pr-1607/assets/OPFSCoopSyncVFS-Cit82Sp8.js\":\"6f9a98408224956e\",\"/knowledge-medium/pr-preview/pr-1607/assets/OPFSWriteAheadVFS-OZUH5uF4.js\":\"d707e96eaf8cccdd\",\"/knowledge-medium/pr-preview/pr-1607/assets/wa-sqlite-BcS6Bwdm.js\":\"59f46f82acb4dd48\",\"/knowledge-medium/pr-preview/pr-1607/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1607/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1607/assets/wa-sqlite-async-CT7r6eyT.js\":\"017927d060b1f7c1\",\"/knowledge-medium/pr-preview/pr-1607/assets/worker-DQ4G1r_l.js\":\"3138ca4a6e51727a\",\"/knowledge-medium/pr-preview/pr-1607/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1607/chunks/app-tRxVs4EP.js\":\"43b78f6e474e5265\",\"/knowledge-medium/pr-preview/pr-1607/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1607/index.js\":\"e31d784332aa9b0a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1607/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1607/assets/AccessHandlePoolVFS-C1cNZxP4.js\":\"9199a94f1e273e48\",\"/knowledge-medium/pr-preview/pr-1607/assets/IDBBatchAtomicVFS-C7KWWsQ-.js\":\"2519c1b11ae68c78\",\"/knowledge-medium/pr-preview/pr-1607/assets/MemoryVFS-aRMEU8ly.js\":\"2959351e51bbdbc8\",\"/knowledge-medium/pr-preview/pr-1607/assets/mc-wa-sqlite-0Zp7QWaM.js\":\"a9298bf57f550618\",\"/knowledge-medium/pr-preview/pr-1607/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1607/assets/mc-wa-sqlite-async-CJn2TtJR.js\":\"a4590a2e2f1aef6a\",\"/knowledge-medium/pr-preview/pr-1607/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1607/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1607/chunks/AccessHandlePoolVFS-WAD_8bAk.js\":\"1ef5559c91e4cf13\",\"/knowledge-medium/pr-preview/pr-1607/chunks/FacadeVFS-CoY3Ysa0.js\":\"2b66cf908735cae0\",\"/knowledge-medium/pr-preview/pr-1607/chunks/IDBBatchAtomicVFS-DglIocqD.js\":\"f89557dc9035ade8\",\"/knowledge-medium/pr-preview/pr-1607/chunks/MemoryVFS-DurAdzxr.js\":\"48291371a32bb6e6\",\"/knowledge-medium/pr-preview/pr-1607/chunks/OPFSCoopSyncVFS-B1RTAbVv.js\":\"2cc36770180ba027\",\"/knowledge-medium/pr-preview/pr-1607/chunks/OPFSWriteAheadVFS-DDCm1Lfd.js\":\"648e7c9b403ec819\",\"/knowledge-medium/pr-preview/pr-1607/chunks/Preview-TSi2DYVx.js\":\"ca09a9e2be09040e\",\"/knowledge-medium/pr-preview/pr-1607/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1607/chunks/card-1ka_od_t.js\":\"4062fa6f5444a291\",\"/knowledge-medium/pr-preview/pr-1607/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1607/chunks/dist-6zBILo0e.js\":\"8bd1e0f977096cfb\",\"/knowledge-medium/pr-preview/pr-1607/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1607/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1607/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1607/chunks/mc-wa-sqlite-DHzDcmJ8.js\":\"9055a1b95d9740c1\",\"/knowledge-medium/pr-preview/pr-1607/chunks/mc-wa-sqlite-async-kiNsnh8n.js\":\"78786e86bab99630\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-B21RKJQE.js\":\"17958a91b999a6d5\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-C3sRcqQ7.js\":\"bd247afa5132ddb1\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-CpWgWOCi.js\":\"0b133303c6f26a00\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-DPYJB9fU.js\":\"357cb3718f306a7f\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-DfjQ13fC.js\":\"6b6a99c1663e3b33\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-Dnfu9fwk.js\":\"55ab34edc1f0cc90\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-DsJNC4CP.js\":\"854e94df371e7b96\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-K8V3Hhu_.js\":\"ecbf2cd859d1bb61\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-dom-server-legacy.browser.production-BfqKdyKw.js\":\"c30a94c42158d7aa\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-dom-server.browser.production-BCULDg4u.js\":\"d10ae67cda0b89ec\",\"/knowledge-medium/pr-preview/pr-1607/chunks/react-dom-server.edge.production-R09z2Yxv.js\":\"cbf3effa7a785751\",\"/knowledge-medium/pr-preview/pr-1607/chunks/server.browser-4CxT2HsR.js\":\"1575271737eda774\",\"/knowledge-medium/pr-preview/pr-1607/chunks/textarea-DhyLUwAA.js\":\"e8fe4d422eb28886\",\"/knowledge-medium/pr-preview/pr-1607/chunks/ui-CskBUDGY.js\":\"3261ea473dcadb37\",\"/knowledge-medium/pr-preview/pr-1607/chunks/wa-sqlite-D8pf65Uo.js\":\"d4b1864b01d76371\",\"/knowledge-medium/pr-preview/pr-1607/chunks/wa-sqlite-async-GnDaQK9l.js\":\"3239e79799f86021\",\"/knowledge-medium/pr-preview/pr-1607/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1607/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1607/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1607/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1607/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1607/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1607/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1607/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1607/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1607/src/App.js\":\"0c9780261d1e2e0a\",\"/knowledge-medium/pr-preview/pr-1607/src/appUpdate.js\":\"12aa9408820062a6\",\"/knowledge-medium/pr-preview/pr-1607/src/appVersion.js\":\"2a6e1028c6a9c448\",\"/knowledge-medium/pr-preview/pr-1607/src/bootstrap/initialLayout.js\":\"bce576e4a0819378\",\"/knowledge-medium/pr-preview/pr-1607/src/bootstrap/openWorkspaceData.js\":\"efaf4d0d663cd537\",\"/knowledge-medium/pr-preview/pr-1607/src/bootstrap/resolveWorkspace.js\":\"b08311aa6d9634f8\",\"/knowledge-medium/pr-preview/pr-1607/src/bootstrap/workspaceBootstrap.js\":\"1f54deac793bf98e\",\"/knowledge-medium/pr-preview/pr-1607/src/components/BlockComponent.js\":\"bf7c239cee4cefe6\",\"/knowledge-medium/pr-preview/pr-1607/src/components/BlockCrumbs.js\":\"4492f872c71c8618\",\"/knowledge-medium/pr-preview/pr-1607/src/components/BlockEditor.js\":\"c09cf73920ee614b\",\"/knowledge-medium/pr-preview/pr-1607/src/components/BlockLoadingPlaceholder.js\":\"cfa0db606c66dd08\",\"/knowledge-medium/pr-preview/pr-1607/src/components/BlockProperties.js\":\"9cf61b74ee1300d6\",\"/knowledge-medium/pr-preview/pr-1607/src/components/BlockSearchPicker.js\":\"712201ebea522490\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ConfirmBulkDeleteDialog.js\":\"7f2c52653abc8a86\",\"/knowledge-medium/pr-preview/pr-1607/src/components/DividerHandle.js\":\"9130dddcca48c79c\",\"/knowledge-medium/pr-preview/pr-1607/src/components/DraftEditor.js\":\"f40a0e61baf0fc90\",\"/knowledge-medium/pr-preview/pr-1607/src/components/GutterPill.js\":\"7c1881ee2851c742\",\"/knowledge-medium/pr-preview/pr-1607/src/components/Header.js\":\"e4241f78417dc6b4\",\"/knowledge-medium/pr-preview/pr-1607/src/components/LazyBlockComponent.js\":\"4a18a964633fe9ff\",\"/knowledge-medium/pr-preview/pr-1607/src/components/Login.js\":\"d91f5d97f96035d4\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ZoomableSurface.js\":\"0ea0fa8d98ad5d5a\",\"/knowledge-medium/pr-preview/pr-1607/src/components/editModeKeepalive.js\":\"d73a92b1223c8fad\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0d0fbe3eae1487c3\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0d45c66ffa01b266\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/RefPropertyEditor.js\":\"b333662ea36744fc\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/RefTargetTypePicker.js\":\"b953008854390a98\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/SelectPropertyEditor.js\":\"6886b5d5879beacf\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/TypesPropertyEditor.js\":\"6d1a744f9fb81d9b\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/defaults.js\":\"b7c908015e56e336\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/kernelValuePresets.js\":\"a9d2308ef92139f7\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/selectablePresets.js\":\"2774ecff8e680322\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyEditors/typesPropertyUi.js\":\"f60e5e03fc2046f1\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/AddPropertyForm.js\":\"930c8685f8793125\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/PropertyPicker.js\":\"3173286194271ea0\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/PropertyRow.js\":\"1a36070a2ea740e2\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/Rows.js\":\"8ee6a9d74fe2d64c\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/actions.js\":\"1413db53b626d0af\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/declarationOnly.js\":\"58dc88c9435219b6\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/layout.js\":\"882d5932fd7ca607\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/model.js\":\"9d8f06215a29b26b\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/shapeUi.js\":\"49767c795152b9a7\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/shapes.js\":\"3981a17bb6e98d8b\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2d33c197b06197eb\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanel/visibility.js\":\"65f4d1dc11dae2da\",\"/knowledge-medium/pr-preview/pr-1607/src/components/propertyPanelSections.js\":\"5facaa50f631f5f2\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/BlockEmbed.js\":\"40bde4008ddb843e\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/BlockLink.js\":\"91cd74ddc2a7afae\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/BlockRef.js\":\"06b6bbbafb1222ea\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/ReferenceLink.js\":\"81fa1937b4f2d113\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/cycleGuard.js\":\"c2528a22b4757de3\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/cycleGuardContext.js\":\"07f6becd510b89af\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/linkInteraction.js\":\"3d2042b06fa471b4\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/referenceLayout.js\":\"8141525ce74d7bc9\",\"/knowledge-medium/pr-preview/pr-1607/src/components/references/useBlockRefAncestors.js\":\"8468d1b5c093b761\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/BlockGutter.js\":\"9e8ca02600ef068f\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/BlockInfoDialog.js\":\"04103ea6066f1821\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/BlockTypeBlockRenderer.js\":\"5398398cd6144657\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/BulletHoverCard.js\":\"8a368e676091e2b9\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/CodeMirrorContentRenderer.js\":\"7d237e7b63077195\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3710e605a64b5969\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/ColumnResizeHandles.js\":\"736b61efa2a28b9d\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"fbf9f168d4eb9cad\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/DefaultBlockRenderer.js\":\"13fbaac32f2c860d\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/LayoutRenderer.js\":\"2b0cc4808da47212\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/MarkdownContentRenderer.js\":\"b012a7805371062b\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/MissingDataRenderer.js\":\"6b5f311c2f70c54c\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/PanelRenderer.js\":\"9cc1699bfa28aaec\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/PropertySchemaBlockRenderer.js\":\"83124fcef90a6876\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/TopLevelRenderer.js\":\"92b17abf805ba02a\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/blockGutterMode.js\":\"b0e776a1c2bfc5c7\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/blockTitleText.js\":\"f20eb2d9509f1c15\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/fieldCreationKeydown.js\":\"58108d5e2e23ce84\",\"/knowledge-medium/pr-preview/pr-1607/src/components/renderer/layoutRootContext.js\":\"3d8c13a22d996b79\",\"/knowledge-medium/pr-preview/pr-1607/src/components/typeChip/TypeChip.js\":\"5a1c063f7c7abf37\",\"/knowledge-medium/pr-preview/pr-1607/src/components/typeChip/chipStyle.js\":\"714c1c2ebd7167de\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/anchored-floating.js\":\"89e546ca31b29063\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/button.js\":\"3bafc4fca727ea14\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/card.js\":\"0b064ab269b44336\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/checkbox.js\":\"7a4e56456b099ec5\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/collapsible.js\":\"2cb3b4806dcb6a70\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/command.js\":\"2b66cd5237f2bab9\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/context-menu.js\":\"6bbbea434650b6ce\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/dialog.js\":\"2835dfecd0f518d7\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/dropdown-menu.js\":\"a66fd0012fbbed33\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/floating-listbox.js\":\"781c54f7913237a3\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/index.js\":\"aa8f1309834f061e\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/input.js\":\"bf98186d13d2743a\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/kbd.js\":\"eb2aa5172dcb3798\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/label.js\":\"91497e02e354da5c\",\"/knowledge-medium/pr-preview/pr-1607/src/components/ui/textarea.js\":\"4f5c5f936db5e98c\",\"/knowledge-medium/pr-preview/pr-1607/src/components/useEditModeYieldKeepalive.js\":\"d7674dd924d10667\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/BootFallback.js\":\"9244c87ea74146c2\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/FocusedRowLazyMount.js\":\"229ed957d0a8d9fa\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/LazyViewportMount.js\":\"ce48af14fcef538a\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/LocalDbCorruptionFallback.js\":\"849f29cab94d4ee6\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/error.js\":\"b7abb18206541a32\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/lazyMountRegistry.js\":\"21399b5ad9dcea19\",\"/knowledge-medium/pr-preview/pr-1607/src/components/util/suspense.js\":\"607b2b0fc110de68\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/CreateWorkspaceDialog.js\":\"03bdceae0b6c07a3\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/PendingInvitations.js\":\"2aa9e5cd2a7e940f\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/SyncProgress.js\":\"c4b04726c876677f\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/UnlockProgress.js\":\"86c15b5333a90c16\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/WorkspaceKeyGate.js\":\"676fca28b8556141\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/WorkspaceSettingsDialog.js\":\"01f9fb65fef2ed39\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/WorkspaceSwitcher.js\":\"7d92a649994a7f44\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/WorkspaceSyncGate.js\":\"58a9428bed4d4fc2\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/ConversionFlow.js\":\"3c52af2e5621e906\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/ConversionFlowHost.js\":\"3b0b282eda4aaa6d\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/EncryptionSection.js\":\"175a4e770636aaec\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/attachmentPrompts.js\":\"bc3a3296f72892d9\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5cb93a8cd1d8009a\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/conversionFlowDeps.js\":\"d65e77a1d2d6e546\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/conversionFlowStore.js\":\"18eeeb221fa8b195\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/flowUi.js\":\"c7955753a62e9dd9\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/conversion/useConversionRun.js\":\"282cd68ae6f2c9ac\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/keyUi.js\":\"6def1e4e27614df6\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/useCloseOnKeyLoss.js\":\"88f7acaa65577672\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/useCloseOnServerE2ee.js\":\"4e79767069f745dd\",\"/knowledge-medium/pr-preview/pr-1607/src/components/workspace/workspaceUnlocked.js\":\"5ae92e27ecfd8b21\",\"/knowledge-medium/pr-preview/pr-1607/src/context/backgroundSubtree.js\":\"7626d55fda4b7f14\",\"/knowledge-medium/pr-preview/pr-1607/src/context/block.js\":\"e7327938c56cb3a3\",\"/knowledge-medium/pr-preview/pr-1607/src/context/layoutWsContext.js\":\"822324e78827f69e\",\"/knowledge-medium/pr-preview/pr-1607/src/context/propertyDisplay.js\":\"32a6f012ad18df18\",\"/knowledge-medium/pr-preview/pr-1607/src/context/repo.js\":\"c99e3dfca68ca2da\",\"/knowledge-medium/pr-preview/pr-1607/src/data/aliasClaim.js\":\"448a689751b57fe1\",\"/knowledge-medium/pr-preview/pr-1607/src/data/aliasSeatNamespace.js\":\"4115b1a0d2376c9e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/blockData.js\":\"6a383f6a67c52c2b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/blockType.js\":\"0612f40aaf25c3b1\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/changeScope.js\":\"1dd77a04fdcb499f\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/codecs.js\":\"0cf2b9f197e1749a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/derivedData.js\":\"bd6ed4ffa338f24a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/errors.js\":\"05203b47869ee740\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/events.js\":\"1544be860ac167cf\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/handle.js\":\"d24fc6b9ca72f5c3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/index.js\":\"6105250ac96ead84\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/mutator.js\":\"9ea21305a8f8e855\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/processor.js\":\"ba824e0fdb6071ed\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/propertySchema.js\":\"1e808e674d43ba7f\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/query.js\":\"d41098e1850c5344\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/sameTxProcessor.js\":\"707381f3c11fcf0b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/schema.js\":\"d24fc6b9ca72f5c3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/tx.js\":\"d24fc6b9ca72f5c3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/typedBlockQuery.js\":\"3c3b16ddf13cf748\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/user.js\":\"3dfc492610b970b7\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/valuePresetCore.js\":\"f397c006bd7c3ac4\",\"/knowledge-medium/pr-preview/pr-1607/src/data/api/valuePresets.js\":\"3c7fa82d154dda36\",\"/knowledge-medium/pr-preview/pr-1607/src/data/attachmentCleanerIOVerb.js\":\"4f4c8c5d0e161616\",\"/knowledge-medium/pr-preview/pr-1607/src/data/block.js\":\"5265ee0a1c67cd0f\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockCache.js\":\"c196f15da6100a2e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockId.js\":\"276c9cb76357ada0\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockLiveness.js\":\"ff9c192e7072a6b9\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockMerge.js\":\"2080e19ae5baf78c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockSchema.js\":\"1ce95d1a150e3f2c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockTypeLookup.js\":\"a3ba36747bb99c21\",\"/knowledge-medium/pr-preview/pr-1607/src/data/blockTypes.js\":\"387a2a53f9df3e86\",\"/knowledge-medium/pr-preview/pr-1607/src/data/childrenView.js\":\"018545a0e81a364f\",\"/knowledge-medium/pr-preview/pr-1607/src/data/clientContext.js\":\"76ab597379f793db\",\"/knowledge-medium/pr-preview/pr-1607/src/data/dbFileSiblings.js\":\"2d8c8f2412c89251\",\"/knowledge-medium/pr-preview/pr-1607/src/data/definitionSeeds.js\":\"b3cc90391f6d6658\",\"/knowledge-medium/pr-preview/pr-1607/src/data/derivedIds.js\":\"b6587dbb9f6ff8f5\",\"/knowledge-medium/pr-preview/pr-1607/src/data/drawnSubtree.js\":\"39a95c21ad52726e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/facetBridge.js\":\"6febca9623c8f95e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/facets.js\":\"69ab21ace5f31b5b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/globalState.js\":\"6c18a2b74a2c271f\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/aliasClaimRederiveProcessor.js\":\"c00a9f4ec0fb5fb1\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/ancestorBatch.js\":\"7f702037443cd27d\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/blockTypeTypeifyProcessor.js\":\"6ad609b4c2c1163d\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/clientSchema.js\":\"42d33edf52667a33\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/commitPipeline.js\":\"5742201b61751694\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/devAssertions.js\":\"88b8a3a5e1f21807\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/firstSync.js\":\"b75fda69019f1012\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/freshInitialLoad.js\":\"1f52c3d58d552041\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/graphBackfillClaim.js\":\"82b872d0c249f095\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/handleStore.js\":\"e8dee19ae6415c5b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/idleMarkerJobs.js\":\"2ffbbc878f25353e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/initialDownload.js\":\"8dd95d3bf8b7f719\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/initializeClientDatabase.js\":\"8a53ef17f98c05a5\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/jsonCanonical.js\":\"a088d24ad5b2e9f9\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/kernelInvalidation.js\":\"703672ea6001622c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/kernelProcessors.js\":\"1544b5367081f03a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/kernelQueries.js\":\"ff229bf82bd6ebe8\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/mergeTypeMembershipProcessor.js\":\"06637c0c753c64df\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/normalizeReferencesProcessor.js\":\"96acf10448fa79e4\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/poolInstrumentation.js\":\"d8b4ee92f41ba202\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/processorRunner.js\":\"01af99fb3b2498ed\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyCellBackfill.js\":\"1cf45bba91b9d7b5\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyChildMint.js\":\"29d07d240f00644a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyChildrenProcessor.js\":\"4aaa812e0b1f7acc\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyDefinitionChangeProcessor.js\":\"93d588cef7484d28\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyDefinitionSynthesis.js\":\"76521c40791d8b38\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyKeyScan.js\":\"be54aff31ba8f804\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertySchemaResolution.js\":\"0b20290f1f2c5245\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/propertyValueEdits.js\":\"93a36f4048641d6a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/raiseProtocol.js\":\"d08f8ce4c59c7a59\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/readBatch.js\":\"17c0364b061d6a9e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/refProjection.js\":\"79b637155ad99543\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/referenceTargetLookups.js\":\"c90cc403edfe0cdb\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/referenceTargetProcessor.js\":\"db5da14668ca8637\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/replayMerge.js\":\"c873a8b182c19a7b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/sqlBinds.js\":\"764fb5e6ac958f6e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3e17f4a4b342952d\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/syncObserver/arrivalProcessors.js\":\"a832284a579d60bb\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/syncObserver/invalidate.js\":\"29eb4c243914d6a3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/syncObserver/materialize.js\":\"16bd3adac070a05e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/syncObserver/observer.js\":\"583b8633079872b9\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/syncObserver/reconcile.js\":\"eda8a66692276d9f\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/timingMetrics.js\":\"2360b7c5be86a4fb\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/treeQueries.js\":\"52eb7ff43a9f90e2\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/txEngine.js\":\"9056f173c752413a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/txSnapshots.js\":\"b663a7c5cc3f5bca\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/typedBlockQuery.js\":\"b65206468dd6e2ec\",\"/knowledge-medium/pr-preview/pr-1607/src/data/internals/undoManager.js\":\"d5d7768080fd3dd9\",\"/knowledge-medium/pr-preview/pr-1607/src/data/invalidation.js\":\"32934fbd5a700166\",\"/knowledge-medium/pr-preview/pr-1607/src/data/kernelDataExtension.js\":\"a3b1de11c26ca351\",\"/knowledge-medium/pr-preview/pr-1607/src/data/kernelPage.js\":\"5e2c28927e1338ec\",\"/knowledge-medium/pr-preview/pr-1607/src/data/kernelValuePresetCores.js\":\"e3f1ce5da82b91c3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/localDbCorruptionSignal.js\":\"844eb9585c417d33\",\"/knowledge-medium/pr-preview/pr-1607/src/data/localDbStorage.js\":\"a33b4c8f310c7ded\",\"/knowledge-medium/pr-preview/pr-1607/src/data/localDbVfs.js\":\"fdeb70ecf11cab43\",\"/knowledge-medium/pr-preview/pr-1607/src/data/localSchema.js\":\"9cc4e113231861a6\",\"/knowledge-medium/pr-preview/pr-1607/src/data/maintenance.js\":\"1682e195c9e9a326\",\"/knowledge-medium/pr-preview/pr-1607/src/data/mergeProperties.js\":\"613a6bc533c0c4e9\",\"/knowledge-medium/pr-preview/pr-1607/src/data/metricsConsoleHook.js\":\"a31b16b9ad56c91b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/migrationsPage.js\":\"1d7c54022c571696\",\"/knowledge-medium/pr-preview/pr-1607/src/data/mutators.js\":\"6f3b8427775b13f1\",\"/knowledge-medium/pr-preview/pr-1607/src/data/orderKey.js\":\"89c2c9a2affdfe91\",\"/knowledge-medium/pr-preview/pr-1607/src/data/orderKeyPlacement.js\":\"020e7022bb455520\",\"/knowledge-medium/pr-preview/pr-1607/src/data/outlineSurface.js\":\"660b2bb520ad5440\",\"/knowledge-medium/pr-preview/pr-1607/src/data/pendingEditorContent.js\":\"259a04ca350b2edb\",\"/knowledge-medium/pr-preview/pr-1607/src/data/pendingUploadsSql.js\":\"82b28552f2a09458\",\"/knowledge-medium/pr-preview/pr-1607/src/data/pluginStateExtensions.js\":\"26f1c2eacdfef170\",\"/knowledge-medium/pr-preview/pr-1607/src/data/powerSyncLogger.js\":\"c673de0794e37f25\",\"/knowledge-medium/pr-preview/pr-1607/src/data/projectorRuntime.js\":\"a56b32e3e0da0b94\",\"/knowledge-medium/pr-preview/pr-1607/src/data/properties.js\":\"ac38a75e87835e2c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertiesPage.js\":\"52b6f8ce1f9dcdbf\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertyChildren.js\":\"3835355e5828faad\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertyDefinitionFanout.js\":\"2df024ef4218356a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertyDefinitionMetadata.js\":\"369e6c2e0e7a3814\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertyDefinitionRegistry.js\":\"366be05ee711a74c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertyDisplayMode.js\":\"2431c042f05494ae\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertyRowCreation.js\":\"1afb3ccb62af1868\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertySchemaCreation.js\":\"c75a18476131554c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/propertySeeds.js\":\"3e5f262eee896ad8\",\"/knowledge-medium/pr-preview/pr-1607/src/data/recentsPage.js\":\"5f122658ed31e0d2\",\"/knowledge-medium/pr-preview/pr-1607/src/data/referenceBlock.js\":\"7f074798f0f8842e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/rejectedUploads.js\":\"03335f817689c4b8\",\"/knowledge-medium/pr-preview/pr-1607/src/data/releasePowerSyncConnection.js\":\"0d1173d08ff42eb2\",\"/knowledge-medium/pr-preview/pr-1607/src/data/repo.js\":\"50bff738470c9c59\",\"/knowledge-medium/pr-preview/pr-1607/src/data/repoProvider.js\":\"f7fc58bdd65bc573\",\"/knowledge-medium/pr-preview/pr-1607/src/data/rowProperty.js\":\"9cf77e1c8929ee5c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/searchFilter.js\":\"b95eeba0956beb98\",\"/knowledge-medium/pr-preview/pr-1607/src/data/seedIdentityLedger.js\":\"f9ee8f829441df25\",\"/knowledge-medium/pr-preview/pr-1607/src/data/stateBlocks.js\":\"4d7c4e3402049188\",\"/knowledge-medium/pr-preview/pr-1607/src/data/structuralEditPolicy.js\":\"a82c3588ac9d9874\",\"/knowledge-medium/pr-preview/pr-1607/src/data/structuralInsert.js\":\"ffadf3cc2d91cbcf\",\"/knowledge-medium/pr-preview/pr-1607/src/data/subtreeDelete.js\":\"221717c101e7e19a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/syncStreamLock.js\":\"cd73cee45adf933b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/syncedTableSqlRecognizer.js\":\"ee83f18719c81e90\",\"/knowledge-medium/pr-preview/pr-1607/src/data/syncedTableWriteGuard.js\":\"aee589f8836181c5\",\"/knowledge-medium/pr-preview/pr-1607/src/data/targets.js\":\"62beb0524d2f38b0\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeColors.js\":\"f4176ed34deafc6a\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeDefinitionMetadata.js\":\"07fd979257ddfcf8\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeDefinitionRegistry.js\":\"8563bc12d7fc2481\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeExtraction.js\":\"c888f61a14688e7e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeInitialValues.js\":\"41c6f9a2b3e44b04\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typePropertyGroups.js\":\"3cbe47bd15d5db5b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeSeeds.js\":\"b39bc31f94c6b2b3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typeTagger.js\":\"d3dcb02f023d1f53\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typedRecords.js\":\"3752acf5feef1a26\",\"/knowledge-medium/pr-preview/pr-1607/src/data/typesPage.js\":\"34a76d022a4f28f3\",\"/knowledge-medium/pr-preview/pr-1607/src/data/userPrefs.js\":\"6ef2c8b12b9a8501\",\"/knowledge-medium/pr-preview/pr-1607/src/data/userSchemasService.js\":\"6558597dcfa204a6\",\"/knowledge-medium/pr-preview/pr-1607/src/data/userTypesService.js\":\"6e84bbc39f85bdf1\",\"/knowledge-medium/pr-preview/pr-1607/src/data/valuePresetRegistry.js\":\"31dc579b4b8443ee\",\"/knowledge-medium/pr-preview/pr-1607/src/data/visibleChildren.js\":\"744099ec3a2e5eff\",\"/knowledge-medium/pr-preview/pr-1607/src/data/workspaceConversion.js\":\"296189b060792d7b\",\"/knowledge-medium/pr-preview/pr-1607/src/data/workspaceFirstSync.js\":\"8985d63ff3db826c\",\"/knowledge-medium/pr-preview/pr-1607/src/data/workspaceIdNamespace.js\":\"742ce299e505f954\",\"/knowledge-medium/pr-preview/pr-1607/src/data/workspaceSchema.js\":\"74b23f19c5b3e7cb\",\"/knowledge-medium/pr-preview/pr-1607/src/data/workspaces.js\":\"19a863baa8154dec\",\"/knowledge-medium/pr-preview/pr-1607/src/data/writeAheadLog.js\":\"11b548d37150f23e\",\"/knowledge-medium/pr-preview/pr-1607/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/BlockPasteShellDecorator.js\":\"f848184ceb045330\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/atTrigger.js\":\"c90cd057f214bd16\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/autocomplete.js\":\"6c26f893b63b4d50\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/codeMirrorExtensions.js\":\"a53521b43c55730d\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/contentFlush.js\":\"5aee5a3d6c71710c\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/defaultInteractions.js\":\"8cfa0806b731da06\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/editSettleSignal.js\":\"75ea15bd627364a5\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/insertImage.js\":\"afc386c2ce1a8708\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/referenceCompletionRange.js\":\"8f6872c0468186b2\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/referenceTargetTypes.js\":\"cb30ebbb27ef2f17\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/syntaxContext.js\":\"d2aa4b9134a99b8d\",\"/knowledge-medium/pr-preview/pr-1607/src/editor/triggerMatch.js\":\"0b05c0c989a0b766\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/AppRuntimeProvider.js\":\"a7276f8d400f8c05\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/BlockFocusShellDecorator.js\":\"bb650bbcdfd0b29e\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/ExtensionRenderBoundary.js\":\"fb9eed5690c46a5a\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/PanelContentRecovery.js\":\"99db019199af6763\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/apiCatalog.js\":\"0169063d72352752\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/approveExtensionHere.js\":\"1167c077ebc625ac\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/armedCutAppMount.js\":\"9dc4a6db6b232ba9\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/batchableKeyedStore.js\":\"52507c6974bf11a4\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/blockInteraction.js\":\"99c365e3b2d9d776\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/blockSelectionAction.js\":\"21b5a5fb920a778c\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/compileExtensionModule.js\":\"f38172981443d7f6\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/compiledModuleCache.js\":\"2edd661fed411160\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/continuousGestures.js\":\"572fb0d677c06c01\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/core.js\":\"13b49121e457986b\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/defaultRenderers.js\":\"485f148c5867d4ac\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/definitionFanoutAppMount.js\":\"509082d529c20783\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/dialogAppMount.js\":\"11f8f4b17bd89298\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/dynamicExtensionSeeds.js\":\"2e1153a2960ed697\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/dynamicExtensions.js\":\"80a954874fd59c2d\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/exampleExtensions.js\":\"fa7b043f6ed89b03\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/extensionApprovalStatus.js\":\"b159e48ca7dedf00\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/extensionLoadErrorToast.js\":\"cbca605348170623\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/extensionLoadErrors.js\":\"420d81128bda9cef\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/extensionLookup.js\":\"c2898ec7dd07080e\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/extensionToggles.js\":\"0134702e3c370d0b\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/extensionUtilitiesCss.js\":\"b1d3d8835c9d8a99\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/kernelPageDeletionGuard.js\":\"230309e852a9cf62\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/liveRuntime.js\":\"de76b9b37ae1413b\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/openExtensionsSettings.js\":\"cb5087ea4513089c\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/overridesCache.js\":\"f7ee68c17b37b099\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/pluginIds.js\":\"d5afe7f110da4d7b\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/processorRejectionToast.js\":\"45580645a7c33afe\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/runtimeActions.js\":\"104bece8ca688ccf\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/runtimeContext.js\":\"9bcab81a0249d69a\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/staticAppExtensions.js\":\"3c794be03a5dcb06\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/staticDataExtensions.js\":\"86be882f1a793617\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/toastAppMount.js\":\"6c56b6a684b54f31\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/useOverrides.js\":\"4298d08181965f4b\",\"/knowledge-medium/pr-preview/pr-1607/src/extensions/useShortcutSurfaceActivations.js\":\"d60716f812e5455c\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/discoverToggleTree.js\":\"167f05a926ab4d6b\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/facet.js\":\"2abfae81fe819b6c\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/resolveAppRuntime.js\":\"fe9cbbccf63ceae9\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/runtimeEvents.js\":\"68b1e16b376b4314\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/togglable.js\":\"4f428fe08137c506\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/variantFacet.js\":\"1a31d9e0ae6cce68\",\"/knowledge-medium/pr-preview/pr-1607/src/facets/verbFacet.js\":\"b875d9305a22c65a\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/block.js\":\"260e90b125e50bda\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/focusedChild.js\":\"e9eba302237a344d\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/propertySchemas.js\":\"35b30fc25693f51f\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/typeRegistry.js\":\"df1b8534a2190ae9\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useAncestorCrumbs.js\":\"3b382fdbdddffc4d\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useAutocompleteListbox.js\":\"1f23d88463292a8a\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useDebouncedSearch.js\":\"28651b7acfa83419\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useDebouncedValue.js\":\"154da50462b9f749\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useIsFocalRender.js\":\"a78a31604993bd5a\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useIsReadOnly.js\":\"8dd2cfd264991113\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useMaterializeBacklog.js\":\"b9a183d65b781d49\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useMinuteClock.js\":\"e00de161c6b580e0\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/usePanelLayoutProjection.js\":\"ed4dab24e60476bc\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/usePendingInvitations.js\":\"256381bc363ac76d\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useRendererRegistry.js\":\"eec2deeaf179616c\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useRetainedFieldRows.js\":\"9da9c461b1fe9506\",\"/knowledge-medium/pr-preview/pr-1607/src/hooks/useWorkspaces.js\":\"760a663f8e56a3f6\",\"/knowledge-medium/pr-preview/pr-1607/src/lib/utils.js\":\"bf5f6222ec2ec4e0\",\"/knowledge-medium/pr-preview/pr-1607/src/main.js\":\"5ec1bee77488bd59\",\"/knowledge-medium/pr-preview/pr-1607/src/markdown/MarkdownImage.js\":\"4f28d5bcf0141577\",\"/knowledge-medium/pr-preview/pr-1607/src/markdown/blockSeparators.js\":\"a3e78574c440f7ff\",\"/knowledge-medium/pr-preview/pr-1607/src/markdown/context.js\":\"3cf356ef70ef5d01\",\"/knowledge-medium/pr-preview/pr-1607/src/markdown/defaultMarkdownExtension.js\":\"ca1f4f57e5474159\",\"/knowledge-medium/pr-preview/pr-1607/src/markdown/extensions.js\":\"364ec17b67aa5bdc\",\"/knowledge-medium/pr-preview/pr-1607/src/markdown/renderMarkdownHtml.js\":\"c8cb5d8972a8fdc4\",\"/knowledge-medium/pr-preview/pr-1607/src/minimal-editor.js\":\"ea73863df0f0e6c8\",\"/knowledge-medium/pr-preview/pr-1607/src/paste/armedCut.js\":\"0e7846f48af686bd\",\"/knowledge-medium/pr-preview/pr-1607/src/paste/captureMediaVerb.js\":\"e65e581af8fd7e40\",\"/knowledge-medium/pr-preview/pr-1607/src/paste/clipboard.js\":\"97c6d42a68ad40b7\",\"/knowledge-medium/pr-preview/pr-1607/src/paste/clipboardOutline.js\":\"c077083e8203ed66\",\"/knowledge-medium/pr-preview/pr-1607/src/paste/decision.js\":\"4c1b3805ee45a9f0\",\"/knowledge-medium/pr-preview/pr-1607/src/paste/operations.js\":\"20b224f2f0e4c91e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/account-header/AccountHeaderItem.js\":\"a66bfa9a84be6be9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/account-header/index.js\":\"4d4588f114def6e2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"626211e411f471e1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/askAgent.js\":\"fbe7be195524df26\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/askedStore.js\":\"89d63d42e9d805e3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"18d191be0dacf8eb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/chipState.js\":\"1d8daccb1de4826b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ded3cf257b564632\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/index.js\":\"c78f5c3580cb6534\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9c7f1c9e9ea1cddb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-dispatch-companion/schema.js\":\"42e6b7f248d63c2b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7127b66f0f7b950c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9772f3d539dbe281\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/addMedia.js\":\"069ac4342a4ee383\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4351db52aa7d102a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/block.js\":\"9dee580f41edb301\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/context.js\":\"7d484c9c39045bf4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e77138d7a3e21ca7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/index.js\":\"5ca48c6ba50b164e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/outline.js\":\"1a4a68d308abe352\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/properties.js\":\"3b06968705fd2bbe\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/refs.js\":\"4db305aef2a9c6b5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7eb4f85be4456f3d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/search.js\":\"0fe4a59e7e607876\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/shared.js\":\"45f1aed8677b326e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fab92ef9f8ffc56c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentViews/text.js\":\"51c665ff67ebe257\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/agentWrites.js\":\"f4b1d35abc12096c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/authoringCatalog.js\":\"79beae2f270d9217\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/blockRefTargets.js\":\"3ac6acc9b60096a7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/bridge.js\":\"b3ccd3b63d969a34\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/bridgeLoop.js\":\"c7614898c9c22c45\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/changeHistory.js\":\"b379f4f704e613e4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/commands.js\":\"05524a0468132aa5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/commentsCommands.js\":\"d0946b27d81540df\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/dataExtension.js\":\"1ae1e29071b33ff7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/dataModelGuide.js\":\"778c4e3a8278974f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/describeRuntime.js\":\"dcd38e2e7bf40f1d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/extensionLint.js\":\"ce95353a94942307\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/grainAudit.js\":\"a9dd6466e089afce\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/healthCommand.js\":\"8d4de937a030959f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/index.js\":\"d1ec44b2e8c02749\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/presetIdentity.js\":\"c06a5ca4d040cefd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2357c5415d49038f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/readMedia.js\":\"55ebfedb4f34cb04\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/schema.js\":\"611e65122e822914\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/serialization.js\":\"85282ada1ee66908\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/targets.js\":\"5d81322458d744ef\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/tokens.js\":\"eed879ef3c95ff95\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/watchEvents.js\":\"7b901ac968264a5f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/workspaceGuard.js\":\"1ec16e01d56691a9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/agent-runtime/writeCommands.js\":\"e38a4cef190af845\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/AliasCollisionToast.js\":\"ccf1650679becd97\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/DuplicateNameBanner.js\":\"86879d175712703b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/collisionMerge.js\":\"5ab704aabfbd3979\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/dataExtension.js\":\"ad3f8d5891e96cef\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/index.js\":\"85b2e73a5dde67c0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/mergeCollisionAction.js\":\"74d1943dcb04b776\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/pageStyling.js\":\"8b06df398fc53c34\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/rejectionToast.js\":\"b9a2436f37ae8402\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/alias/syncProcessor.js\":\"d7db78597c965e8c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/actions.js\":\"edca7b7987b1165a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/addComment.js\":\"6bf58db01459eef2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/anchor.js\":\"6932d83ef18a3e77\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/anchorState.js\":\"d5ea06c4ecfb9d8b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/commentLinks.js\":\"f42dbd1bbb46d380\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/confirmThreadDeletion.js\":\"dd8e8128d38ece1d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/container.js\":\"d9381fa0a5a4f8c9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/dataExtension.js\":\"e74b1a84b0ba32a3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/deleteComment.js\":\"6bf2930f4f24d419\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/highlights.js\":\"7ecef0665c0a51a5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/index.js\":\"728e8336e6bacd76\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/linkedCommentsPill.js\":\"14d41baa67689870\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/margin.js\":\"ee26d5ab4b379c68\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/marginSchema.js\":\"44bae8d3007fd226\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/newComment.js\":\"5b4cb1a53c691a91\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/ownThreadPicker.js\":\"7faa06ef5f167d92\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/placement.js\":\"531b56e4d2e19874\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/queries.js\":\"65cc10b50f2f2988\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/quotePosition.js\":\"c88f9654da90efb1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/quotedIn.js\":\"c4ba7385c0a77bdd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/quotedRange.js\":\"081231b3e08c09b9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/rangeRefs.js\":\"1500a396bed138fb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/readHighlights.js\":\"8643726233fa9426\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/readSelection.js\":\"b38483766e70488f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/readSelectionUi.js\":\"b3116891e82f68fb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/reanchor.js\":\"b658b02eab743c06\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/schema.js\":\"847917c0a030c1f3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/scope.js\":\"4e8ff13f48803fcd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/scopeThreads.js\":\"e9961c3048f931b6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/splitRetarget.js\":\"d12893c8c571927f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/suggestionCard.js\":\"9f6f402677d786a1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/suggestions.js\":\"55324a1d08050c64\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/summaries.js\":\"f15a24cc2c875d3f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/summaryBatch.js\":\"332910d5bfc28163\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/surface.js\":\"9433cc4b9b85a238\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/threadNavigation.js\":\"33b54e8b21a93831\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/threads.js\":\"b971238386dc640e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/ui.js\":\"9006f555af6875cb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/annotations/uiStore.js\":\"3cb0cb96b0584a5b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/app-intents/appIntents.js\":\"f2145b8f6e77145e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/app-intents/index.js\":\"157e3950017db350\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/app-update-prompt/index.js\":\"7488aa5902ae4444\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/app-update-prompt/status.js\":\"dff000a54d22bb55\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f456f43815142bb2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/MediaBlockRenderer.js\":\"1f64194cc08b7813\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9dd17ccd83f893db\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/MediaUploadReconciler.js\":\"2da164c0b140f2e2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/assetDownLane.js\":\"eb241f77f6f1ee94\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/assetResolver.js\":\"8663ba582d9b5757\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/assetUpload.js\":\"64b8db81f9a13194\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/attachmentCleanerIO.js\":\"9126c985936476d3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f7013b06942e7422\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/blobStore.js\":\"5dd1c182baaabe2f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/browserMedia.js\":\"df7dd2bdd805d262\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/byteStore.js\":\"30d52b5e77aa6648\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/cleanerIO.js\":\"615849c7c997c886\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/cleanupAttachments.js\":\"aee6cf8434efba70\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/dataExtension.js\":\"a69bd7cb4db6ee81\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/downLane.js\":\"cc6578147ece9858\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/index.js\":\"5128466f32425a61\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/insertImageContribution.js\":\"12c5cae7161e034b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/laneArming.js\":\"ed33cb141bd2d5d3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/laneLock.js\":\"516c153d478d3e71\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/mediaBlock.js\":\"d48f925726460ee3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/mediaCapture.js\":\"249470e24d1a6b81\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/mediaLanes.js\":\"3514092441c71520\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/mediaViewers.js\":\"0f64957fd4191b67\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/mediaViewersFacet.js\":\"45233aaaa50374b3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/pasteCapture.js\":\"c765d8bf1d377630\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/resolver.js\":\"e18c39d460497f10\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/retryUploadsAction.js\":\"7e56d7db1f07a980\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/storagePaths.js\":\"135d47d4f966a5c7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/uploadDrain.js\":\"fc7866b2de9aa166\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/uploadLaneStatus.js\":\"ca0ac34cb10cce52\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/uploadReconcile.js\":\"111784f546dce4f6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/uploadRecovery.js\":\"ea2ffc9e247601ae\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/uploadStore.js\":\"2a7dfd211e5be016\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/attachments/useAssetObjectUrl.js\":\"dfde45c89d6dcf6e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4e2b33801c0b227e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks-view/BacklinksViewSection.js\":\"231ded8fa4660efb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks-view/facet.js\":\"430ec945cc801dc3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks-view/index.js\":\"6629c7fbc391bced\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks-view/prop.js\":\"8033be8aa6247f57\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/BacklinkFilters.js\":\"ccaf1ea953dde711\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a130635d487ceb94\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/BlockEntry.js\":\"5fabc45e44ab1c7b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/LinkedReferences.js\":\"852de2e0c1d5e75a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"87dbdee418577c0f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/dailyNoteDefaults.js\":\"22e8747eba0c225d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/dataExtension.js\":\"45bcc1ab1a349d22\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/edgeExclusions.js\":\"12873efc3e508534\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/filterProperty.js\":\"5bd554147da65d44\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/index.js\":\"ebd1ef77de71565c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ccbbedf53a5b7dc3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/inline-counts/applies.js\":\"909bfbe2529b2296\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/inline-counts/countQuery.js\":\"9e1b949b686c650e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/inline-counts/expansionStore.js\":\"64d80de0a6d3d6b9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/inline-counts/index.js\":\"e8e123fe608d58ac\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d1808fe9f486b37e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/presentationInvalidation.js\":\"d3aaa4d46b38a018\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/propertyEditorOverride.js\":\"88e5c6f12c026274\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/propertyFilter.js\":\"ba33c29ad8e357d7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/query.js\":\"3af5480ce642ef14\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/resolveFilter.js\":\"e1ebbc22039e3913\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/sourceBatch.js\":\"40e50cc34f3c8060\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/sources.js\":\"b01d9b2055c0d3ea\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/useBacklinks.js\":\"13ee542f0d5fdd61\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bcf4460b4e23e993\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/birthday/BirthdayCelebration.js\":\"f44118427cd670b2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/birthday/BirthdayOverlay.js\":\"9fbce697bbce2cbd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/birthday/gate.js\":\"6f0e852d834cac9b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/birthday/index.js\":\"2f79d7c9f95831d3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/birthday/wolfTheme.js\":\"493a4e7ed83541ea\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-drag/BlockDragLayer.js\":\"ff81af45f987a58f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-drag/dragController.js\":\"46a850cfbe9fd4fd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-drag/dropTarget.js\":\"08d73f3b02b5cbcc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-drag/index.js\":\"237c3ff7c2357550\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-drag/projection.js\":\"b3a2a8b4dc4f3d87\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-info/BlockMetaCard.js\":\"5c95c746ab36e0b9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-info/index.js\":\"95b6ff794d6aa3ca\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/AddTagDialog.js\":\"cdb6f4f7ca0a1f10\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3156419fc815c8df\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/TagNameIssueHint.js\":\"744853e29fbdd1ba\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/addTagAction.js\":\"2a2afdde66d0bc9c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/appendTag.js\":\"4de8da599d995d52\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/config.js\":\"0e90cfee09f9f68a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/dataExtension.js\":\"3dc265d145678558\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/index.js\":\"2256d3e9b72880c9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/block-tagging/propertyEditorOverride.js\":\"a1b5c094015d7846\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ef532b3ee08f4481\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e90978b7570e3255\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/Breadcrumbs.js\":\"94cf61a802cc249c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0ed59bf1589f57ea\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"806e293d6fb1f647\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/index.js\":\"d7f7adead497ca4b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"178a2e03f0d5634c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/CharacterCountItem.js\":\"de338f38f44ed499\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/ProfilePropertyEditor.js\":\"55469c822c959ea4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/actions.js\":\"092a717fd443893f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/blockType.js\":\"23597f3bd43e9ab0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/charCount.js\":\"e94b6500864549f1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/dataExtension.js\":\"36f12bad3072efd4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/index.js\":\"4096f275385abe11\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/profiles.js\":\"a3775d1c9422792f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/properties.js\":\"8d8a621982f95117\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/character-counter/textCounts.js\":\"c2793ec81a5ac887\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/colemak-keybindings/index.js\":\"022ecc24c5e5f12d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/CommandPalette.js\":\"9ad366e7bc33b2e5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/HeaderItem.js\":\"8bd69a79b9ff3af1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/context.js\":\"8a0368c5a0ca3005\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/index.js\":\"9c045d49dfe9c5a9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/selection.js\":\"49ea62d39b48f7f5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/toggleStore.js\":\"52c455db16db6c66\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/command-palette/useCommandPaletteActions.js\":\"610ba5cae2ee214d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/ContributorBadges.js\":\"c1187d11978dea81\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/author.js\":\"ec7e7aabdf2a3487\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/codeMirrorExtensions.js\":\"e65dca304779302c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/dataExtension.js\":\"b0e7c8ed28057c81\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/index.js\":\"3e86dcce3bf229be\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/mentionAutocomplete.js\":\"6248a4375552ec9e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/processor.js\":\"b8ff27f4bc98b983\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/profiles.js\":\"88ff08b4b21b122f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/queries.js\":\"6bff6c8c4de59c17\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/contributors/schema.js\":\"fd906e7d8cb96b1b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"62a0685a15e6af5c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4dab83dea0a36b6f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/cursor-follows-scroll/index.js\":\"fbc6c8541e7d5330\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3d31a8311225e149\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2dd701011d27091e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/CalendarGrid.js\":\"b8235e5758111711\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/DailyNotePicker.js\":\"7355f06422576220\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2af31f1f18c61209\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/DateNavDecorator.js\":\"94c2392b25da4fa8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/DateScrubOverlay.js\":\"1eacd470cacb2c4f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/HeaderItem.js\":\"bbf9a039d9e8a4ff\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/ReschedulePicker.js\":\"a3830634f3420f2f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2a59d529b9ebdedd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/actions.js\":\"c0699b19a67456f5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/blockDateAdapter.js\":\"69dc3d363d08fc18\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/calendar.js\":\"9e6580caa1e9702e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dailyNotes.js\":\"89d04b9cde187ac2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dataExtension.js\":\"a42ed660831b217a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dateScrubActions.js\":\"fbbbf4bb3e95387a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dateScrubGesture.js\":\"ee96a3dd0f0d860d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e2f9ca343ec6735f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dateScrubRecognizer.js\":\"48db12abb7ae7750\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/deletionGuard.js\":\"44b3d3adea72549c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/dueQuery.js\":\"89a2ca59951850e0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/index.js\":\"9f6f715909fc0ed7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/landing.js\":\"aa4db93ce60c1dcb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/localSchema.js\":\"4ded121c2d503098\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/referenceDateAdapter.js\":\"037935e0ef487889\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/rescheduleAction.js\":\"7d9423b440ead244\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/schema.js\":\"b5e44f3ff4a79523\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/spreadBlockDates.js\":\"fed33fd351b1fad1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/spreadDatesAction.js\":\"642fbc035e21732d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/today.js\":\"77149f67dcc4419b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e9126b838ba82ea0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"41b90a0ea99dd1da\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/audit.js\":\"7a5befaeed913d51\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/auditAction.js\":\"fabd9811994abc38\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/auditRanges.js\":\"28e1f8e36b90abed\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/diagnosticsSource.js\":\"38954b317b76a3f1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/divergenceScan.js\":\"15e887e06673e939\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/index.js\":\"1df194a95c99285d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b1c2a3a8fbe9e92e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/referencesMirror.js\":\"73fdcda46f22851d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/rowJson.js\":\"0e129ecd923b2ab4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/schedule.js\":\"e54159b6f2479655\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/data-integrity/store.js\":\"40793608e7cc38c0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-maintenance/action.js\":\"abadbfe47577b910\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-maintenance/index.js\":\"28bb8d0d89040ac4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-maintenance/plugin.js\":\"77310552dc095fbe\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"54ce07222105abe9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/actions.js\":\"64fc9875f8103f5f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/changeMarker.js\":\"53d45e9dde212588\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/diagnostics.js\":\"f0e912caf7a5a024\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/fileSystemAccess.js\":\"59c42a1473e94364\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/filenames.js\":\"92940608df6f0720\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/index.js\":\"bf92cbb32423cc18\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/mirror.js\":\"0c359ea2f8110735\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/runLock.js\":\"433488aef837c91b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/runtimeHealth.js\":\"d7627e4dace09e2b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/schedule.js\":\"6020456680256467\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/db-mirror/store.js\":\"7631ecaced5504ed\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/default-themes/index.js\":\"5a167b4a6f7a80d2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/default-themes/themes.js\":\"b8b6dd1103357bab\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/diagnostics/facet.js\":\"fcc429363b9edd47\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/diagnostics/useDiagnostics.js\":\"4deade3e467c0c64\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extension-prompts/dismissals.js\":\"5d25c8abe300a78f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extension-prompts/index.js\":\"c131366f17665249\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extension-prompts/status.js\":\"8a8753a8427e9b5b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extension-prompts/store.js\":\"8c70f5051aed259a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"89731b072a2a749e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c4600eced925d56e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/actions.js\":\"0ac641010200efdd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/config.js\":\"2368bb82c194c938\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/dataExtension.js\":\"ad4e0b3bbae7e116\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/effect.js\":\"8133f92eeb9a8353\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/index.js\":\"82e3f21362c7bb1d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7391c72ed6eb3bcb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extensions-settings/useToggleTree.js\":\"c6c233bfcc87ba00\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extract-type/ExtractTypeDialog.js\":\"0c0c136e043ac259\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"eb1b21f0b428766b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extract-type/PropertyShapePicker.js\":\"798382d7455a3942\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extract-type/action.js\":\"a7d3d8c9558d0106\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/extract-type/index.js\":\"e6dd42fb86431481\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/FindReplaceDialog.js\":\"3935d473c7930315\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/HeaderItem.js\":\"c91fc7194c01d21e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/dataExtension.js\":\"452b2705740c173f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/index.js\":\"f89171df298745a6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/search.js\":\"0028765d7c40836e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/toggleStore.js\":\"77800127634a9090\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/LocationPropertyEditor.js\":\"b7fe7b74b09bf61f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/MapView.js\":\"8977b65e740f77bc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/blockTypes.js\":\"7cdebbf1b52b9e51\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/codeMirrorExtensions.js\":\"3d20f5cdf98fdebf\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/createOrFindPlace.js\":\"454bc5dfe647e9de\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/currentLocation.js\":\"55bb5ee5ac006f65\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/dataExtension.js\":\"65d5507921a23565\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/geoContentDecorator.js\":\"56257deba75a6e86\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/googlePlacesClient.js\":\"433119960bf358ec\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/index.js\":\"bf455cf330c4a09c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/locationsPage.js\":\"ae11f9a93edeef46\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/mapViewport.js\":\"219230647a46a1b5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/pickCurrentLocation.js\":\"1e0dbb87d6e33547\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/placeAutocomplete.js\":\"580d540804c3b030\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/placeNameCollision.js\":\"9fb09fd72a9a93a6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/properties.js\":\"55274ad0e9328a61\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/propertyEditorOverrides.js\":\"ab1d68d257dded5b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/query.js\":\"c1083db75f64a2b4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/geo/usePlaceSearch.js\":\"1ceeb51dcb6a80a6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"03f397183572734a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b90149be9590c279\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"174985d132914e14\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/config.js\":\"bdd2ab239e9c597d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/dataExtension.js\":\"ce828d7546cdbcbc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/facet.js\":\"3f9ace9f9b9a6bad\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/grouping.js\":\"7e44f554a18870d7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/index.js\":\"c5b27588f4ce1c1a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"31aa980dff69fbfb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/query.js\":\"6bfa7427de69d8ab\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/resolveConfig.js\":\"bfae81efc94f9764\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e32f19424286b5a0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d148b37574fcdde6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/HtmlDocumentContent.js\":\"9dc600c6a0f7f04a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/HtmlFrame.js\":\"a49020b6beabb8a3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/actions.js\":\"40b7e60ad405a925\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/blockType.js\":\"3e0701b861380242\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/confirmRunScripts.js\":\"b36257bbd022ac49\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/dataExtension.js\":\"68d2153080726edd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/frameAnnotations.js\":\"4c98c805e8b62a8c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/frameDocument.js\":\"7e7320d7a7c8fb9e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/frameTheme.js\":\"8155c9a5fbd1eca5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/index.js\":\"1b471f54aea21c7b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/scriptConsent.js\":\"0b7cb52356260dd4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/sourceMap.js\":\"ffa93b5d9811f3b1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/html-document/useDocumentScripts.js\":\"17f68c029e09a1e7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/interaction-metrics/index.js\":\"311e04be46f0dfca\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/interaction-metrics/record.js\":\"4fa206cbf5b27626\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/interaction-metrics/recordStore.js\":\"272d47e4fa1ecf1a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/interaction-metrics/responsiveness.js\":\"e124c510f03d995a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/interaction-metrics/schedule.js\":\"5885133071a4c125\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/interaction-metrics/sessionContext.js\":\"e6a7098a44ce19e0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1950130caf829e99\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ed96548ce95aa7fd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/actions.js\":\"3bbae61fdf5c6ed0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/config.js\":\"772e72c954b623f9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/dataExtension.js\":\"c6fec75d9eab1e2a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/effect.js\":\"536799783a44b060\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/index.js\":\"0bbccb694249e6c0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/keyCapture.js\":\"d993ee711c6c77f9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/overrideStore.js\":\"a446216283157b97\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3aec3ba9def45183\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/HeaderItem.js\":\"93942e18b2e419c2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/LeftSidebar.js\":\"e3e13ac1928ad315\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/actions.js\":\"1463f1770076e74a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/facet.js\":\"0c10c23f8c4bb57c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/index.js\":\"eac5d4ab125dc3db\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/shortcuts.js\":\"a976ddc1df241292\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/left-sidebar/toggleStore.js\":\"d09fa8331ae1d357\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/merge-blocks/MergePicker.js\":\"d9e3065baf3f4b8c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/merge-blocks/index.js\":\"c5de8e72a6d460e5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/merge-blocks/mergeAction.js\":\"b60b072d4cc99d18\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/merge-blocks/strategy.js\":\"0d47f085577aa36a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-bottom-nav/Button.js\":\"fbca997835290931\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8481fbea687867bd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3fa8c6217c5ad038\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-bottom-nav/facet.js\":\"bd3f6fae3b337fe5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-bottom-nav/index.js\":\"92ef48bca7740279\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fd66ac4bfe1a05bf\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-keyboard-toolbar/actions.js\":\"433922ba29e810d7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ac9717bc23386d63\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e1c6c137ddd5f29e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/mobile-keyboard-toolbar/index.js\":\"f8e88e2709b33437\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/MoveDestinationPicker.js\":\"43806ac1531900b9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1f5c8bde523aa9db\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/contextMenuItem.js\":\"ff9e367f19478b33\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/index.js\":\"2bab0f87b3d956f4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/moveAction.js\":\"75bc3033d16720a3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/moveBlocks.js\":\"a7d0987a5e454988\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/move-blocks/selectionAfterMove.js\":\"97b6e9b53ddde332\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/TutorialBanner.js\":\"85156d09160f077b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/action.js\":\"091999bf1cdad423\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/bannerDismissal.js\":\"e8540234d7054055\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/documents/cheatSheet.js\":\"d5cc3ebd9aebbcf0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/index.js\":\"e6b79a861ca29b2b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/keys.js\":\"f6d83a18d17ebd6d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/landing.js\":\"3a8a9e1bc8e20ba8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/outline.js\":\"2fd5915b80dc0f7a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/onboarding/seed.js\":\"6c1acddd55ae57b2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8fe843f6dbf07e46\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/analyze.js\":\"fd7cb6416bb74535\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/diagnosticsSource.js\":\"fe47ac79d68a1aa5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/index.js\":\"7098168719cbf87f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/load.js\":\"b4fab035777c75d4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/monitorRun.js\":\"66c356effaaae410\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/schedule.js\":\"81ef793d60c2d8f2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/series.js\":\"7c8451da9191608a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/store.js\":\"779e383a88c18884\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/trendAction.js\":\"13de80a724c51f0a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/perf-monitor/verdict.js\":\"577811962e384525\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/plain-outliner/clickToEditAction.js\":\"2d53ab57e216b372\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/plain-outliner/index.js\":\"644f30bf04441dc8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/plain-outliner/interactions.js\":\"e42e9ff820b9b2df\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1ef67f86b1ae57ad\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/MigrationGate.js\":\"dfa66c6d8c84ab53\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/MigrationGateDialog.js\":\"5387361a4c3c46d9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/action.js\":\"42cdc48c4acd6112\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/index.js\":\"7d321bf94ef016bb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/localRunMessage.js\":\"7d84e36faf79d5d2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/plugin.js\":\"409fc9b534e970b5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/progressReport.js\":\"fad9883366644de4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/properties-migration/sweepProgress.js\":\"f2cfd06364041d84\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/FieldRowRenderer.js\":\"d112915221d49fdb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/ValueRowRenderer.js\":\"93d2150bef58bef1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/actions.js\":\"4ebeaaf240d3baa9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/autocomplete.js\":\"b60064f8d0d715b1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/fieldRow.js\":\"d7e33b94aca210ca\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/index.js\":\"6fd2a629aede421d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/referenceWarning.js\":\"b6332b229bc1c933\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/valueAutocomplete.js\":\"abf34923a8ab0669\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/property-rows/valueSchema.js\":\"4216a1d2b9f9a15d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/HeaderItem.js\":\"7138ba86dcc8db88\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/QuickFind.js\":\"27663d49b47c37d8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/index.js\":\"0f746dcf5989a479\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/recents.js\":\"065bfd5e131a124c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/resultItems.js\":\"3cc562632e57d20b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/selection.js\":\"b897fb3f2a4a5ee7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/quick-find/toggleStore.js\":\"4b3d620910b7242f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/recents/HeaderItem.js\":\"8ef9c66133c0ca1b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1a4a87c0d3626034\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/recents/grouping.js\":\"4788142ff4e3ef48\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/recents/index.js\":\"150ddca90b95469c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/recents/target.js\":\"cf9cc84246131f0f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/codeMirrorExtensions.js\":\"e50843bc207b93e8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/contentPrefill.js\":\"f8f78c196774a383\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/dataExtension.js\":\"24c8f333d909e661\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/index.js\":\"916287f1a029fd0c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7caeb22dc3a2acbe\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/invalidation.js\":\"b8b72633b2a3d33a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/localSchema.js\":\"a88614a9182711dc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/blockrefs/index.js\":\"7748ac332a9a0d84\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2ccedb86bd2e0d9f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/index.js\":\"1bb4cb02ed20d2f1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/referenceNode.js\":\"6d9e5f62f7dbd94a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/remark-reference-occurrences.js\":\"07b055e827c0c9ed\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f898d2637a0d9de6\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/wikilinks/index.js\":\"f078af46e5c3f4e1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bea0e0a0b457d8fc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"40f6e2f79dcbad7e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/mergeRetargetProcessor.js\":\"672d1a4aa9a33c48\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/parseFence.js\":\"c0df28dc13ea812c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/referenceParser.js\":\"d3576187d0e3e6b9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/referenceProjection.js\":\"257d3cdbaaa07c0f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/referencesProcessor.js\":\"3c87686e3f59d100\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/renameProcessor.js\":\"f58ae482044740bf\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/references/spanReplacement.js\":\"16d0064c38366a41\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/rich-paste/htmlToOutline.js\":\"2137ee58128ce235\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/rich-paste/index.js\":\"511ac3b20259534e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1a71758458528bb7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/rich-paste/pasteDecision.js\":\"14e31913e01d8cf3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/action.js\":\"632d0617658659d2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/blockIds.js\":\"11cdae83ebe3d07c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/content.js\":\"70c8d917639aa6b3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/effect.js\":\"f9ddcfdf33480d2b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/ids.js\":\"e607ba435d4ca261\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/import.js\":\"64454cec2a27375e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/index.js\":\"e80abb0a1e796832\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/plan.js\":\"593772805f30adfa\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/plugin.js\":\"4d3790d6028272d1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/promotion.js\":\"4eb3cac517836c1a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/properties.js\":\"0660f56aa9927c6b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/references.js\":\"8af79d79828ed5d8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/report.js\":\"f7407147b1ed1ece\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/roamMemo.js\":\"ad854b6b00a50772\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/runtime.js\":\"ca13d901425f3b5b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/schemaReconciliation.js\":\"e1d55392465b3037\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/srsMarkers.js\":\"f60c7991adfea3c7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/todo.js\":\"ef303239af72773d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/typeCandidates.js\":\"0485b1ed2aa4d9a5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/roam-import/types.js\":\"2bc583f263fe82bf\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/search-health/index.js\":\"3b96a84527fc0984\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/search-health/store.js\":\"4dcc28c7060d0db0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/shortcut-help/HeaderItem.js\":\"a76878e4077d5480\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7b20eaf48cfed98d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/shortcut-help/index.js\":\"08b2952c08a9adab\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/shortcut-help/model.js\":\"b2eaf0153f61d66f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/shortcut-help/toggleStore.js\":\"1301386d555f4685\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/shortcut-help/useKeyInspector.js\":\"71b83599eb20fcbd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f167f40dbeb4ccc7\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/ShellDecorator.js\":\"21b5c507833ee360\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/actions.js\":\"635859681441e6ab\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/exclusionsFacet.js\":\"798a0ee8f47ea8f4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/index.js\":\"c3356d8b8e729519\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/shell.js\":\"b1ca22200269c650\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/surface.js\":\"694cafec5a050d2c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/spatial-navigation/walker.js\":\"f95112dcab686842\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8446842c0f987f9b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/dataExtension.js\":\"f77a4609748dbfaa\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/index.js\":\"7a6e38044f73668f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/indicator.js\":\"02dfa47885db897e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/moveSrsState.js\":\"c637c1d6b5b2e996\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"53bfc24b332115a2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/scheduler.js\":\"b2349705675f45e4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/schema.js\":\"8021e6176f4d338f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2b9da165c2ac7f3d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/srsClipboard.js\":\"355eb651805f5d72\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2790d2bbd817fd2d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6764bdaad4f039ae\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/DeckPicker.js\":\"abbffcb30453461a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/ReviewControls.js\":\"8fde2ed48817edd4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0c452c8251e4d234\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/ReviewSession.js\":\"be1af77ca9a49270\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/actions.js\":\"8953c24af76a52b5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/archive.js\":\"0a712e566829d52c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/dataExtension.js\":\"e9f96320b059d008\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/deck.js\":\"9713e8bc71b11c81\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/dueQuery.js\":\"cbdc83f9bdc18057\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/gradeDecision.js\":\"20d5af1ec9a31fc4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/index.js\":\"e118f60180ee9831\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/keyHints.js\":\"079ca80f452ed774\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/reviewCardLayout.js\":\"bddc3da3de46de8c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/reviewProgress.js\":\"6d8f7da38d99b508\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/schema.js\":\"ef551e50d755ca85\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/srs-review/useDueCards.js\":\"b68a85656f92cda8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/startup-metrics/index.js\":\"da5057fe0a2dd29d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/startup-metrics/record.js\":\"914207b88b4c67ec\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/storage-persistence/index.js\":\"eebf5f77c00b6fe4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/storage-persistence/persistenceStatus.js\":\"58a23cc031dfed06\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/storage-persistence/requestAction.js\":\"ada21e269113cab4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/supertags/TypeChipsDecorator.js\":\"5ecebd2de9846088\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/supertags/codeMirrorExtensions.js\":\"8fe63cca7844aea9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/supertags/index.js\":\"822ae712d3e5d3ee\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/supertags/typeAutocomplete.js\":\"253efa499ace9afc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f10b08af89b4c318\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/actions.js\":\"c0dd7dc02f5e950c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/anchor.js\":\"f48522f173263e91\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/events.js\":\"c176c4c995c84c66\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/gestureActions.js\":\"faad8e1d971b3863\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/index.js\":\"d606363e0be71e70\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f49593ef4c1428e4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/sync-metrics/collect.js\":\"bcf555195e5dc41d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/sync-metrics/index.js\":\"58e7f6c2211e165f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/sync-metrics/record.js\":\"2d785ebb7ca34333\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/RejectionDialog.js\":\"1d4459ace721155c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/SystemStatusHeaderItem.js\":\"bf5bb74ff50fff2b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/index.js\":\"db2ee1eee80dc823\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/model.js\":\"29c4c33b55e7dc6a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/queueCounts.js\":\"cdb89a03111d42ec\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/rejectedHelpers.js\":\"5066473e57d1ccb0\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/rematerializeAction.js\":\"10328683c69a5df4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/system-status/useHysteresis.js\":\"55a91c97c829cad5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/ColumnHeaders.js\":\"90810446eb253283\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/QueryUi.js\":\"d73860821cc6a9c4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/TableLayout.js\":\"4e27eee596ff00a2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/actions.js\":\"e7c9225956d6aa1c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/cellEdits.js\":\"e827fcab0ddfb834\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/childrenViews.js\":\"e83ef67b5e475724\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/columns.js\":\"bd5f3452635624e1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/controller.js\":\"c0348f04ee045850\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/convert.js\":\"273baba8df90a5c9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/dataExtension.js\":\"028de7c9a0bba4d2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/index.js\":\"e2d73a2f7a0c5825\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/keys.js\":\"9cbc073a8f9aa5fe\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/model.js\":\"9daa57612dcc4fb4\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/query/backfill.js\":\"a8cb8ef8b83861cd\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/query/completion.js\":\"f8f9bba0c6115a77\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/query/format.js\":\"a4d8cd60985234e3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/query/parse.js\":\"da478ee8a00a7c35\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/query/queryValue.js\":\"d7f7ec5174d850ab\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/query/source.js\":\"31bf4fd86c31a5da\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/registry.js\":\"02a7508d95c0e753\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/rowGutter.js\":\"20efbca640c7f918\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/rowVerbs.js\":\"c9c9eafeb9f1f576\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/schema.js\":\"50270966d52c5bbc\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/tables/sort.js\":\"9e9eecf04d97555b\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/theme-toggle/effect.js\":\"13108e544160e677\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/theme-toggle/index.js\":\"b089866c21871867\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/theme-toggle/theme.js\":\"f3e1c08c6cd91fed\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/todo/actions.js\":\"210db662c3c83c5c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/todo/dataExtension.js\":\"86f05815cf7a65d8\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/todo/index.js\":\"c794728b8ee254ce\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/todo/schema.js\":\"dbf4a57b5657cf4e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5610165b23b5fae2\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/touch-selection/actions.js\":\"ede372c1526997c9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/touch-selection/defaultItems.js\":\"5745d3605c181731\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/touch-selection/facet.js\":\"1e620f6c55cc3704\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/touch-selection/holdRecognizer.js\":\"dcd1f4f8a373ab8d\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/touch-selection/index.js\":\"84fadcc6936c18c1\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/update-indicator/UpdateIndicator.js\":\"fa9c86e42a677594\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/update-indicator/index.js\":\"bef4f081348cb40a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/update-indicator/loadTimes.js\":\"e5d595da30452c2c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/VideoNotesRenderer.js\":\"2787453541c2954f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/VideoPlayerRenderer.js\":\"b9e74ed31eb102fb\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/VideoTimeStamp.js\":\"eaf628427c560251\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/actions.js\":\"d5ddeb1ed0f78cd9\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/index.js\":\"6aa1d48f48494264\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/markdown.js\":\"6d74f1fc1452e588\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/notes.js\":\"9e0afa046a633d7a\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/registry.js\":\"abfe536c62084037\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/remark-timestamps.js\":\"da88d075b50ca9f3\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/video-player/view.js\":\"b169e34471e29c7e\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-link-hints/LinkHints.js\":\"c8d78412b4cd742c\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-link-hints/index.js\":\"a0625c207994ce55\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-link-hints/model.js\":\"34dc3b982ebee5f5\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-link-hints/settings.js\":\"28f55016bef53e07\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-normal-mode/actions.js\":\"f571d1b675f6dfde\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-normal-mode/index.js\":\"5b7ee1ef41a79201\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/vim-normal-mode/interactions.js\":\"b320fa32c002431f\",\"/knowledge-medium/pr-preview/pr-1607/src/plugins/workspace-header/index.js\":\"1d167db8ae03488f\",\"/knowledge-medium/pr-preview/pr-1607/src/registerServiceWorker.js\":\"63ac008f7b054aed\",\"/knowledge-medium/pr-preview/pr-1607/src/requestPersistentStorage.js\":\"735855fdb8035679\",\"/knowledge-medium/pr-preview/pr-1607/src/services/authRequestDeadline.js\":\"61f1f3f6ab5bc53f\",\"/knowledge-medium/pr-preview/pr-1607/src/services/authStorage.js\":\"6de3012bc3833860\",\"/knowledge-medium/pr-preview/pr-1607/src/services/powersync.js\":\"4c2db59c84b8524b\",\"/knowledge-medium/pr-preview/pr-1607/src/services/supabase.js\":\"516c94dc907eaa51\",\"/knowledge-medium/pr-preview/pr-1607/src/services/uploadErrorClassifier.js\":\"6f8376c94c89d854\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/ActiveContexts.js\":\"79c46da0b74e1c58\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/HotkeyReconciler.js\":\"2dfa7f0963f9131a\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/WipeLocalDataDialog.js\":\"d1c3f8462c062f92\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/actionDispatch.js\":\"56e9f9af73e4d813\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/actionRefItems.js\":\"df98c215dd643f92\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/applyKeybindingOverrides.js\":\"f205300fe9d6b3e4\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/blockActions.js\":\"2377b885a983aa6f\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/blockMergeGesture.js\":\"9657a64f8ba46fbe\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/canonicalizeChord.js\":\"509fbf222a59e51f\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/defaultContexts.js\":\"a3e1c944f7cc4ab0\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/defaultShortcuts.js\":\"b74473a0e02b7fc3\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/effectiveActions.js\":\"ba617a2771be4b4f\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/gestureAction.js\":\"de0e07b0a89cda09\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/gestureBinding.js\":\"ad86a3b403785d93\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/holdRegistry.js\":\"5226b1aeab2e8bfd\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/keybindingConflicts.js\":\"faa91ff9bc237a06\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/keybindingOverrides.js\":\"a1cb6f5f0c5f7251\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/pointerAction.js\":\"7bd89f067aee7a4a\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/resolve.js\":\"d93055d750316db3\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/runAction.js\":\"b108cc76ab837950\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/sequenceMatcher.js\":\"6279042aa24415c4\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/types.js\":\"9675546582da342b\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/useActionContext.js\":\"71e946a676d07d0d\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/useActionDiscovery.js\":\"782e63957895407f\",\"/knowledge-medium/pr-preview/pr-1607/src/shortcuts/utils.js\":\"2e010a0e998787d4\",\"/knowledge-medium/pr-preview/pr-1607/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1607/src/sw/bootStore.js\":\"f2493391a9513678\",\"/knowledge-medium/pr-preview/pr-1607/src/sw/previewDatabases.js\":\"f62c04df5a1a1f1f\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/byteTransform.js\":\"f1c33ef7bef65a1a\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/attachmentCleaner.js\":\"10b92ae34fe85698\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/bundle/attachmentParts.js\":\"930dcb079d7f87bc\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/bundle/bundleParts.js\":\"ab56372e46293c6d\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/bundle/bundleRecord.js\":\"996948e8669ff646\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/bundle/manifest.js\":\"39d75cf8b405214f\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/bundle/takeBundle.js\":\"144086cb8ef66eeb\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/bundle/verifyBundle.js\":\"af586705fcfe5942\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/cleaningStage.js\":\"191302b5646ad72d\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/conversionKey.js\":\"cf671b6de3007514\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/conversionServer.js\":\"01e63f32ee8eed22\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/flip.js\":\"6aad907d247d725f\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/flipAttempts.js\":\"136f4cb053de98aa\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/pages.js\":\"af51b3f59054639e\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/preflight.js\":\"251b7ef8387ab2fc\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/reseal.js\":\"1398831cf64203e0\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/runConversion.js\":\"d1bad1b632dde173\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/runLock.js\":\"5f35effb46d48d00\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/sealing.js\":\"de4c23f227ab727f\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/sealingStage.js\":\"942129f07b512a9c\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/stage.js\":\"0a7c5f8c91f8aa0a\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/conversion/verifyReseal.js\":\"0a50a1509799d447\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/aad.js\":\"3faea8000cb8b33a\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/aead.js\":\"1fdad0e12466b3f2\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/base32.js\":\"776150da2a8b8f89\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/base64url.js\":\"1479561f5712283c\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/binaryEnvelope.js\":\"bb28f0d6f2002d06\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/byteAead.js\":\"0a3b67b0c7aba8d0\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/canary.js\":\"4a1311ddd78677af\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/contentHash.js\":\"b7c170b0965b56da\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/contentKey.js\":\"fbd00c4e25fcb414\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/derivedIdNamespace.js\":\"c6fc8a47b1cd76fb\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/envelope.js\":\"a9c1b0ff60c21639\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/hex.js\":\"720bffbfb3e20886\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/sha256Hex.js\":\"33f2e3cf1c34c1d8\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/crypto/workspaceKey.js\":\"49f819f0c765415b\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/conversionState.js\":\"b78f0eb12d1387a0\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/flows/createEncryptedWorkspace.js\":\"884aa46015fae7ff\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/flows/pastedKey.js\":\"2eb3076b897fb92a\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"38c1b8dd8aabf265\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/flows/upgradeWorkspacePin.js\":\"05fe63444f8434db\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/keyStore.js\":\"ca52689b7a8ab96b\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/mintWorkspaceKey.js\":\"aad1e279911a0e97\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/modePin.js\":\"2266227b17670f5b\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/openWorkspaceKeys.js\":\"5e1e8106e41dd77e\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/resolveWorkspaceEntry.js\":\"62efa736b08585bd\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/resolver.js\":\"f3e0c613a5d425ca\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/keys/workspaceAccess.js\":\"cd4374594c693481\",\"/knowledge-medium/pr-preview/pr-1607/src/sync/transform.js\":\"4640158ace0765ae\",\"/knowledge-medium/pr-preview/pr-1607/src/themeBootDefaults.js\":\"7242d9891c4329cb\",\"/knowledge-medium/pr-preview/pr-1607/src/types.js\":\"4db86a262305c803\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/ClientLocalSettings.js\":\"84186ec201c8544f\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/abortableSleep.js\":\"1fb4e38e2c239f72\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/array.js\":\"498b2b93d37b6824\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/backlinkAutocomplete.js\":\"e0ab495eb8aa4c84\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/blockCrumbs.js\":\"22cbd4ddac15960a\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/blockrefAutocomplete.js\":\"2182e3a7c901367d\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/cadencedIdleJob.js\":\"33d2001b282c62ea\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/callbackSet.js\":\"22f606037a986e54\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/clientId.js\":\"c78d025829b3bd95\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/codemirror.js\":\"5b870851c1a90460\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/codemirrorCompletion.js\":\"5b7112287cebc185\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/copy.js\":\"966b14520ef676ae\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/dailyPage.js\":\"8a73259e98bb39bd\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/dbForensics.js\":\"bc2dfb01688d0ca6\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/dbForensicsHooks.js\":\"d87696543c95490f\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/deleteBlockThroughUi.js\":\"338d0f6ae2a9bba6\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/dialogs.js\":\"e2656e1c81cdb268\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/dom.js\":\"db38c006bc277f90\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/downloadBlob.js\":\"3804bc390d279285\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/drawnWalk.js\":\"f9badd05d9c64c16\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/exportSqliteDb.js\":\"f7d7540e872403db\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/fileSystemAccess.js\":\"51394f1bc4123343\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/flipSlide.js\":\"115d1957be01aa5f\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/fnv1a.js\":\"2536b8e5d7dbac75\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/formatBytes.js\":\"98ff4ff12d4687db\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/fuzzyRank.js\":\"0bb7db4dd18f8c07\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/idbKeyedStore.js\":\"cc138d22860eb5cb\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/idleCallbackPolyfill.js\":\"59d74fadd6627cea\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/keyboardAwareScroll.js\":\"89055593393da740\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/keyboardViewport.js\":\"811b84e5703c4ad5\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/lastWorkspace.js\":\"e7dd5b448e5b6ff0\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/layoutColumns.js\":\"0bf580e0acc95a21\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/layoutSessionDom.js\":\"ddc504550257f9a3\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/layoutSessionId.js\":\"957824a908910037\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/linkClickGestures.js\":\"6e6bd59adab24b80\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/linkTargetAutocomplete.js\":\"9d72e296f0b65dae\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/localDbCorruption.js\":\"b3a0eb7ce612b16e\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/localDbRecovery.js\":\"ae0467c8a543ec31\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/markdownParser.js\":\"5fbfa6482f95c91e\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/memoize.js\":\"0bf3a0ff354591db\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/nameFieldCommit.js\":\"14ffda9cb7e9e592\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/nameList.js\":\"9a1908e9c8f46c25\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/navigation.js\":\"02d88a2b4baee396\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/omnilinerNamespace.js\":\"b563419fd224e5e8\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/opfsPageScan.js\":\"85e834d89ffbd66b\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/panelClearance.js\":\"aaec8466546df7b0\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/panelHistory.js\":\"d82ffa73ac1ff072\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/panelLanes.js\":\"6447738ead509c52\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/panelLayoutProjection.js\":\"fa3f3017ebdeb49a\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/panelScrollAnchor.js\":\"1307328cadfe0075\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/panelUrlFlags.js\":\"b7576641348b4c02\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/platform.js\":\"4a89cb23742c66fc\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/pluralize.js\":\"a875107ada56aa8e\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/propertyCreation.js\":\"16ff099da40d761f\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/propertyNavigation.js\":\"0b39f4a0fd77216b\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/propertyValueContext.js\":\"f36d31fbd6b53960\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/react.js\":\"4ef98a0e20a9a885\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/relativeDate.js\":\"a7eafa76e82d63b2\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/relativeTime.js\":\"ec1735274328f807\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/renderScope.js\":\"a2a979036079f1ff\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/resolvedThenable.js\":\"a4c515226e6bdd73\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/routing.js\":\"5391e1bc448aac88\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/safeMode.js\":\"c9b9fc5f0a572c88\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/scheduleIdle.js\":\"04c28856a8b49458\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/screenWakeLock.js\":\"32c7a48a479f221c\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/selection.js\":\"183b1a4b14910b8e\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/softKeyboardGrab.js\":\"ada3be62e6690803\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/startupTimeline.js\":\"eb4b17578f1f7209\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/state.js\":\"8574b331d474fdc7\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/string.js\":\"f01fee990033bfe4\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/surfaceZoom.js\":\"27ee5366596e13a1\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/time.js\":\"c45af18becac077c\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/toast.js\":\"a0d0bd337a2c98be\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/toggleStore.js\":\"33c4f2fd720032a0\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/untilStopped.js\":\"93b26fcddac081af\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/userActivity.js\":\"1eefe11a6b58975d\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/viewTransition.js\":\"9bfc37687c763c21\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/viewport.js\":\"d8be36bbab29c89b\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/webLock.js\":\"6fbfd6aab74b2e82\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/workspaceRecovery.js\":\"b1562daee8ac88e6\",\"/knowledge-medium/pr-preview/pr-1607/src/utils/workspaceSnapshotStore.js\":\"7ac42a7703f63041\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-compiler-runtime.js\":\"c92927f8b3ede31f\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom-client.js\":\"d47440cbadacdc7f\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom-server-edge.js\":\"f44354cdf793658c\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom-server.js\":\"e9fe155b0f4f6fea\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom-static-edge.js\":\"ccbb669ad49df9af\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom-static.js\":\"cc4e899c8411d462\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom-test-utils.js\":\"ae173997271fdb58\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-dom.js\":\"4fcda690ed322064\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react-jsx-runtime.js\":\"76ff4073ef9fadb0\",\"/knowledge-medium/pr-preview/pr-1607/src/vendor/react.js\":\"5fb33f0633e16bbe\",\"/knowledge-medium/pr-preview/pr-1607/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1607/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1607/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
