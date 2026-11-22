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
		buildId: "22f039718505-b629916c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1637/\":\"cf5cf03a9c45cee7\",\"/knowledge-medium/pr-preview/pr-1637/index.html\":\"cf5cf03a9c45cee7\",\"/knowledge-medium/pr-preview/pr-1637/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1637/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1637/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1637/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1637/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1637/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1637/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1637/assets/FacadeVFS-B_qnUcOE.js\":\"f1b6d9d1d6d7c1a7\",\"/knowledge-medium/pr-preview/pr-1637/assets/OPFSCoopSyncVFS-BT4ng4T5.js\":\"c964eeaad7cfdb77\",\"/knowledge-medium/pr-preview/pr-1637/assets/OPFSWriteAheadVFS-C2Q55B6G.js\":\"f3b1f4f323c03caa\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-CNa_p0X5.js\":\"24b3728cad48494f\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-async-DZj_AzVv.js\":\"37d412d275b59255\",\"/knowledge-medium/pr-preview/pr-1637/assets/worker-D1NrMkuh.js\":\"dba52d641201203b\",\"/knowledge-medium/pr-preview/pr-1637/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1637/chunks/app-S_SQ4JW-.js\":\"f88826935dbe88bf\",\"/knowledge-medium/pr-preview/pr-1637/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1637/index.js\":\"99cdb3074f3dadd8\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1637/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1637/assets/AccessHandlePoolVFS-DDnfe3Rv.js\":\"d2867ff74e200cc3\",\"/knowledge-medium/pr-preview/pr-1637/assets/IDBBatchAtomicVFS-rqrFMwYW.js\":\"5ca86ca5197ee3cb\",\"/knowledge-medium/pr-preview/pr-1637/assets/MemoryVFS-DMv1zBJj.js\":\"f06e88d41add5ce0\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-DOtNhxiJ.js\":\"8904d64f85c5992d\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-async-BGtRH3uI.js\":\"dfcb5222e086e271\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1637/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1637/chunks/AccessHandlePoolVFS-BhY4_G37.js\":\"2af87852c0b94f9b\",\"/knowledge-medium/pr-preview/pr-1637/chunks/FacadeVFS-Cs5VXnH-.js\":\"c05284258a6aa604\",\"/knowledge-medium/pr-preview/pr-1637/chunks/IDBBatchAtomicVFS-C2oc76Wk.js\":\"21a012b9fb7ac210\",\"/knowledge-medium/pr-preview/pr-1637/chunks/MemoryVFS-1JFlssFK.js\":\"612a4f519dc474e6\",\"/knowledge-medium/pr-preview/pr-1637/chunks/OPFSCoopSyncVFS-dzcCDSlv.js\":\"7a2f45ba705afe2d\",\"/knowledge-medium/pr-preview/pr-1637/chunks/OPFSWriteAheadVFS-BG6IGVge.js\":\"c16ced9bfda28b93\",\"/knowledge-medium/pr-preview/pr-1637/chunks/Preview-0j6J5TvH.js\":\"9ec2ac8b4f0d4b5a\",\"/knowledge-medium/pr-preview/pr-1637/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1637/chunks/card-CsJegG_D.js\":\"34a96c4f8ffc57dc\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dist-Da_f-e8A.js\":\"1167bcead205295a\",\"/knowledge-medium/pr-preview/pr-1637/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1637/chunks/mc-wa-sqlite-DbADxdCx.js\":\"92670b444431ce45\",\"/knowledge-medium/pr-preview/pr-1637/chunks/mc-wa-sqlite-async-DyuuUjfp.js\":\"733a1262543bdd8b\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-B18MIbfP.js\":\"2a189ea4ba31f17c\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-BAQPSQqs.js\":\"2eac08f15284fb83\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-BbaKF2bV.js\":\"1da89ead08f384fb\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-Bn3kq4Vg.js\":\"6eb56898c0721ffb\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-BnJCQhmH.js\":\"23214165e490440e\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-CU_D_qnP.js\":\"ce8548a1db3726c1\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-CeO-OKVe.js\":\"f8a5abc11f67b44b\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-CoJsZ7Wy.js\":\"32a9c498a6cd0077\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-dom-server-legacy.browser.production-CSwVFowf.js\":\"631f982a0e116fea\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-dom-server.browser.production-DpI94eCm.js\":\"dd81282ef9989cff\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-dom-server.edge.production-D73Nu3Hk.js\":\"d85b88d787daad3f\",\"/knowledge-medium/pr-preview/pr-1637/chunks/server.browser-CKL7mRjR.js\":\"8932c21f8b6e0f29\",\"/knowledge-medium/pr-preview/pr-1637/chunks/textarea-BI4qeJW0.js\":\"9b0887ace42a7a15\",\"/knowledge-medium/pr-preview/pr-1637/chunks/ui-lCSFY-sW.js\":\"6f180ba2670db2a4\",\"/knowledge-medium/pr-preview/pr-1637/chunks/wa-sqlite-CGO14fN3.js\":\"9f29d1c4857d7c94\",\"/knowledge-medium/pr-preview/pr-1637/chunks/wa-sqlite-async-BlZPKOfx.js\":\"54edca9ee3656b01\",\"/knowledge-medium/pr-preview/pr-1637/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1637/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1637/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1637/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1637/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1637/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1637/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1637/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1637/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1637/src/App.js\":\"66f0f1fff13daae1\",\"/knowledge-medium/pr-preview/pr-1637/src/appUpdate.js\":\"48d824f7228a263a\",\"/knowledge-medium/pr-preview/pr-1637/src/appVersion.js\":\"976606a748b2c6ab\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/initialLayout.js\":\"e3577d2b38f39e34\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/openWorkspaceData.js\":\"b65912bba67af723\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/resolveWorkspace.js\":\"d7bf7bb33992242c\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/workspaceBootstrap.js\":\"46568e399699f0cd\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockComponent.js\":\"cd5df4cc3dc5cfa4\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockCrumbs.js\":\"f6152af9eab65f77\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockEditor.js\":\"16088bef5cad6239\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockLoadingPlaceholder.js\":\"09bf6b4bd36aa396\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockProperties.js\":\"f088349ef53b9436\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockSearchPicker.js\":\"5182fe8b3bdac1b9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ConfirmBulkDeleteDialog.js\":\"a23f98c69389de52\",\"/knowledge-medium/pr-preview/pr-1637/src/components/DividerHandle.js\":\"46f0bfdbb701c95e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/DraftEditor.js\":\"4f7a47d15875c62c\",\"/knowledge-medium/pr-preview/pr-1637/src/components/GutterPill.js\":\"39eb8f5b8a704688\",\"/knowledge-medium/pr-preview/pr-1637/src/components/Header.js\":\"ea00ba45ce4c1f96\",\"/knowledge-medium/pr-preview/pr-1637/src/components/LazyBlockComponent.js\":\"8f08ea5c5dd6a7a1\",\"/knowledge-medium/pr-preview/pr-1637/src/components/Login.js\":\"8dab4570a5351bb8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ZoomableSurface.js\":\"6876ffe890b5ccc3\",\"/knowledge-medium/pr-preview/pr-1637/src/components/editModeKeepalive.js\":\"60ebd087831e65e8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyDisplay/PropertyDisplayScope.js\":\"1ef18917d3a5a782\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a5a3c8526c025b82\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/RefPropertyEditor.js\":\"0d66e55ff84cb3e1\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/RefTargetTypePicker.js\":\"909fe0760c5cbb06\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/SelectPropertyEditor.js\":\"ef44bedc015421dd\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/TypesPropertyEditor.js\":\"6461f932fa55c319\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/defaults.js\":\"2e4325c4d2fffc0b\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/kernelValuePresets.js\":\"6979d3e676fbb9d0\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/selectablePresets.js\":\"e19079e06ab537d4\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/typesPropertyUi.js\":\"dcc5a361139919c7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/AddPropertyForm.js\":\"25541531f03af2ff\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/PropertyPicker.js\":\"0d22d2f9f52e0117\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/PropertyRow.js\":\"abbf2946eb128947\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/Rows.js\":\"ee3f79d761d215f6\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/actions.js\":\"a9b43885ef1930e3\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/declarationOnly.js\":\"c35d20191aa28992\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/layout.js\":\"e21acc784fb11ce9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/model.js\":\"037ca4d882cdc569\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/shapeUi.js\":\"f8713029eb9d609a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/shapes.js\":\"7adde80b35fd846e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bc7a1991bea736e0\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/visibility.js\":\"cddc2d4c556578c7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanelSections.js\":\"863b84d69bab6749\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/BlockEmbed.js\":\"ac2f04c0496a9730\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/BlockLink.js\":\"7793313d61a5d4da\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/BlockRef.js\":\"3ce838bb56b1a3eb\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/ReferenceLink.js\":\"89c959be9c676661\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/cycleGuard.js\":\"e401125a947a35ee\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/cycleGuardContext.js\":\"91ce302ca543a1d5\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/linkInteraction.js\":\"5853079497a735d9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/referenceLayout.js\":\"13ef2de3bdbe0fc4\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/useBlockRefAncestors.js\":\"a7b36632598b4557\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BlockGutter.js\":\"7e78d51e555c6962\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BlockInfoDialog.js\":\"3a31a1597c618ecf\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BlockTypeBlockRenderer.js\":\"1bf7ea343e7c2aee\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BulletHoverCard.js\":\"f55aabc3ffbbc5ca\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/CodeMirrorContentRenderer.js\":\"a19585a9bc204f30\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2f11a7525f414f0c\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/ColumnResizeHandles.js\":\"7930929a36aab340\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"49b1f1b458b83362\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/DefaultBlockRenderer.js\":\"f08e8ddbe6485ab5\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/LayoutRenderer.js\":\"33c4f77b5b938830\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/MarkdownContentRenderer.js\":\"854b213070ed05e7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/MissingDataRenderer.js\":\"39d22a9853ec9313\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/PanelRenderer.js\":\"6e2d83d106121399\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/PropertySchemaBlockRenderer.js\":\"826a5a97f1fc271f\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/TopLevelRenderer.js\":\"3fe0be74b6a32a89\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/blockGutterMode.js\":\"a2b988d9b2b276ee\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/blockTitleText.js\":\"b50171a3f8e6ecf3\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/fieldCreationKeydown.js\":\"3fdce31e7d705865\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/layoutRootContext.js\":\"311ccbe80a43ef62\",\"/knowledge-medium/pr-preview/pr-1637/src/components/typeChip/TypeChip.js\":\"ec2ff4f0812b112c\",\"/knowledge-medium/pr-preview/pr-1637/src/components/typeChip/chipStyle.js\":\"b5798d84e4489390\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/anchored-floating.js\":\"c56fc62b3ff2ada2\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/button.js\":\"b65942c86c3f231a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/card.js\":\"7ec41b8acfc181b8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/checkbox.js\":\"c1b8c681abacbae7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/collapsible.js\":\"f8646bc9abf29b0e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/command.js\":\"13552ba98bc85d5d\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/context-menu.js\":\"d9086ac22bbdb5e6\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/dialog.js\":\"5c0a3ee9480c11e9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/dropdown-menu.js\":\"be84151472940710\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/floating-listbox.js\":\"3081e2e2a51322b9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/index.js\":\"1b99a4b640b3abb0\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/input.js\":\"a86a7ab89516abcf\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/kbd.js\":\"cf920b670e8ce5cc\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/label.js\":\"7e94af91b171d1e9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/textarea.js\":\"2d2a4ecf299ba384\",\"/knowledge-medium/pr-preview/pr-1637/src/components/useEditModeYieldKeepalive.js\":\"f81165709d0f942d\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/BootFallback.js\":\"9d61aaf561f8b24a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/FocusedRowLazyMount.js\":\"6409efdd4d767b40\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/LazyViewportMount.js\":\"9f5e493fe2436e10\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/LocalDbCorruptionFallback.js\":\"c7b1b36cc7a57aad\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/error.js\":\"f13fad4f00821601\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/lazyMountRegistry.js\":\"f23ad00e12e24925\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/suspense.js\":\"f93f28d96f0dd845\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/CreateWorkspaceDialog.js\":\"89caad3f7a1b2881\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/PendingInvitations.js\":\"515f95e4aea33b1d\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/SyncProgress.js\":\"fb022d5e3140ead7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/UnlockProgress.js\":\"6e967692aa06867f\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceKeyGate.js\":\"7954318ad25c7322\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceSettingsDialog.js\":\"0037d22e88c32b3a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceSwitcher.js\":\"bb3e5deb4973bf29\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceSyncGate.js\":\"99ddb3b3c94e05c1\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/ConversionFlow.js\":\"a8cd8323b2c68696\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/ConversionFlowHost.js\":\"50913e1ba1843a19\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/EncryptionSection.js\":\"c40e28d7358fc489\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/attachmentPrompts.js\":\"8c77b19c13994ddc\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/bundleFolderPrompts.js\":\"75081db3753356e5\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/conversionFlowDeps.js\":\"80b3c8295e40b3bb\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/conversionFlowStore.js\":\"9332fb6df17441ef\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/flowUi.js\":\"69b22cf01ce825b7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/useConversionRun.js\":\"02031c38698e84f8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/keyUi.js\":\"712b791b696a7492\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/useCloseOnKeyLoss.js\":\"6d6cc6ad7398fbba\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/useCloseOnServerE2ee.js\":\"fc534c9b2b6a8514\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/workspaceUnlocked.js\":\"9f7b7515c0d21236\",\"/knowledge-medium/pr-preview/pr-1637/src/context/backgroundSubtree.js\":\"22db38ec42a9ec3a\",\"/knowledge-medium/pr-preview/pr-1637/src/context/block.js\":\"accdaa92785de6f8\",\"/knowledge-medium/pr-preview/pr-1637/src/context/layoutWsContext.js\":\"def0f9a050393155\",\"/knowledge-medium/pr-preview/pr-1637/src/context/propertyDisplay.js\":\"8571063b43b79837\",\"/knowledge-medium/pr-preview/pr-1637/src/context/repo.js\":\"c799b0d311c08713\",\"/knowledge-medium/pr-preview/pr-1637/src/data/aliasClaim.js\":\"bd23c2759ade745c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/aliasSeatNamespace.js\":\"2f70968be640dc0b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/blockData.js\":\"2969792d5305fa0a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/blockType.js\":\"16bb098abc8e63ed\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/changeScope.js\":\"6d5d77c49a565773\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/codecs.js\":\"bd7a299a7a37bd0a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/derivedData.js\":\"10c6f111919242f8\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/errors.js\":\"161343118f0dc117\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/events.js\":\"4abdd5e921f81108\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/handle.js\":\"da440e95ab4a979a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/index.js\":\"78d9bb1103d4a6f6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/mutator.js\":\"c28f1beed2fa37fa\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/processor.js\":\"a7095ae2e5c90439\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/propertySchema.js\":\"0cd41a7c489a788d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/query.js\":\"bfd9317f5cd33d4b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/sameTxProcessor.js\":\"4d57b1b42f10e9b3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/schema.js\":\"da440e95ab4a979a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/tx.js\":\"da440e95ab4a979a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/typedBlockQuery.js\":\"c0edcdf0e8fc6af1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/user.js\":\"9e96b4f0e57dd51c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/valuePresetCore.js\":\"a05118804a49601e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/valuePresets.js\":\"f7a505cd0f3c51d4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/attachmentCleanerIOVerb.js\":\"2ea4e03799c21b0a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/block.js\":\"a26d4a29f1940075\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockCache.js\":\"d0193173c57e8834\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockId.js\":\"6d6deff95f5a087c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockLiveness.js\":\"7873f69e8c8fc072\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockMerge.js\":\"9bf0d272f34c4fa2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockSchema.js\":\"a6ced0472a35a0c0\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockTypeLookup.js\":\"ef8ad47be2cf7dc2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockTypes.js\":\"748f4c19ac72c787\",\"/knowledge-medium/pr-preview/pr-1637/src/data/clientContext.js\":\"02ff007dcc070262\",\"/knowledge-medium/pr-preview/pr-1637/src/data/dbFileSiblings.js\":\"efa7f09893798ed2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/definitionSeeds.js\":\"a8ba9b0b5d354353\",\"/knowledge-medium/pr-preview/pr-1637/src/data/derivedIds.js\":\"56077da273a73a67\",\"/knowledge-medium/pr-preview/pr-1637/src/data/drawnSubtree.js\":\"aacaf07bb76a6b1d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/facetBridge.js\":\"77d8e9fae58ce342\",\"/knowledge-medium/pr-preview/pr-1637/src/data/facets.js\":\"e237ccebe07b89c1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/globalState.js\":\"71656622c212e1f5\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/aliasClaimRederiveProcessor.js\":\"6fa4d366d64ea0bf\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/ancestorBatch.js\":\"c11cb9d028c7ccb4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/blockTypeTypeifyProcessor.js\":\"98606de3c173525b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/clientSchema.js\":\"29b517ae85a986fa\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/commitPipeline.js\":\"88ff78cfc8930fe7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/devAssertions.js\":\"7a307b239315cb01\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/firstSync.js\":\"b5cbd5122fa39f38\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/freshInitialLoad.js\":\"4b6a1a913592cfde\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/graphBackfillClaim.js\":\"5402fb5507a33e95\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/handleStore.js\":\"c4a880a897a25af5\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/idleMarkerJobs.js\":\"a0c6cd0751df940a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/initialDownload.js\":\"e8c52683675aa65e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/initializeClientDatabase.js\":\"21f9f80f07b600bc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/jsonCanonical.js\":\"bbb8e778dd2f08d8\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/kernelInvalidation.js\":\"e02cea2b2b2afd5f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/kernelProcessors.js\":\"5fd52a9bf02656ea\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/kernelQueries.js\":\"05acd0210cb72ec0\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/mergeTypeMembershipProcessor.js\":\"0aed6370b3d454fb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/normalizeReferencesProcessor.js\":\"e74a4679c3417d82\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/poolInstrumentation.js\":\"1889928849d3b76e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/processorRunner.js\":\"4149214045029ab4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyCellBackfill.js\":\"be2df0a38594ee3e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyChildMint.js\":\"f2e8db20386cf0d7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyChildrenProcessor.js\":\"ce51ae10bfbb0d71\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyDefinitionChangeProcessor.js\":\"352f251e904c2957\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyDefinitionSynthesis.js\":\"e30a89f96665f261\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyKeyScan.js\":\"2f7263625d60baf6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertySchemaResolution.js\":\"87b438a7952b804f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyValueEdits.js\":\"8e70c51884b02108\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/raiseProtocol.js\":\"eeface91d5edd7f7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/readBatch.js\":\"9bdc5b957345fc19\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/refProjection.js\":\"87204e0b0c3c8bb2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/referenceTargetLookups.js\":\"4204a6b2d8f226a4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/referenceTargetProcessor.js\":\"03470cb934fd5b0e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/replayMerge.js\":\"4eff6788e1eedf6d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/sqlBinds.js\":\"87e8ad2de40a91cb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"04765738b1638039\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/arrivalProcessors.js\":\"8679912dcc8f0956\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/invalidate.js\":\"3be5266bc36fc1ea\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/materialize.js\":\"ac32351d00c741c1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/observer.js\":\"f996d70e45422549\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/reconcile.js\":\"57c8cb0a05f89eaf\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/timingMetrics.js\":\"f9d7016a9e9e985b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/treeQueries.js\":\"4d8150b038aba04c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/txEngine.js\":\"10d97e32d56c0d9f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/txSnapshots.js\":\"59817adf87d2ad1f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/typedBlockQuery.js\":\"f6b9b1c0f96ea6d9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/undoManager.js\":\"4d407206aad3a030\",\"/knowledge-medium/pr-preview/pr-1637/src/data/invalidation.js\":\"81397f6c7ad4c6cc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/kernelDataExtension.js\":\"224723d359a8b3d2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/kernelPage.js\":\"b2eaf15afa34afe6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/kernelValuePresetCores.js\":\"196888d6efbe6a43\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localDbCorruptionSignal.js\":\"a8e176b2216d5949\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localDbStorage.js\":\"22ceb31395724297\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localDbVfs.js\":\"2c4cb4675fcf026f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localSchema.js\":\"43a7e9c877526436\",\"/knowledge-medium/pr-preview/pr-1637/src/data/maintenance.js\":\"7996acb4d8b929fa\",\"/knowledge-medium/pr-preview/pr-1637/src/data/mergeProperties.js\":\"0d5a6635c5b1a4b7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/metricsConsoleHook.js\":\"efdc70f59aaaf2ad\",\"/knowledge-medium/pr-preview/pr-1637/src/data/migrationsPage.js\":\"325e31dbde382bfa\",\"/knowledge-medium/pr-preview/pr-1637/src/data/mutators.js\":\"ed7bee2f92944882\",\"/knowledge-medium/pr-preview/pr-1637/src/data/orderKey.js\":\"fdf009ebc7376c0a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/orderKeyPlacement.js\":\"fa843451c06767ce\",\"/knowledge-medium/pr-preview/pr-1637/src/data/outlineSurface.js\":\"33849149b1a960a9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/pendingEditorContent.js\":\"6f91d43295352db9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/pendingUploadsSql.js\":\"fd9dab5b3c93d31e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/pluginStateExtensions.js\":\"18f36ccb34806200\",\"/knowledge-medium/pr-preview/pr-1637/src/data/powerSyncLogger.js\":\"06f16cac52cbeea3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/projectorRuntime.js\":\"7e4ec225fdf06ce4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/properties.js\":\"638c7e49ecb9ec29\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertiesPage.js\":\"0aabc4383ce698dc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyChildren.js\":\"d3ce951f84529167\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDefinitionFanout.js\":\"605089eda27eec57\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDefinitionMetadata.js\":\"dc20e9b4514f35d8\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDefinitionRegistry.js\":\"99ba09946e6e20dd\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDisplayMode.js\":\"c1e5ac478d9850ab\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyRowCreation.js\":\"e986fed3502159c4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertySchemaCreation.js\":\"98279e569e5f7e82\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertySeeds.js\":\"a95c3d623c3f0286\",\"/knowledge-medium/pr-preview/pr-1637/src/data/recentsPage.js\":\"f8d8a19ff1a1b4ba\",\"/knowledge-medium/pr-preview/pr-1637/src/data/referenceBlock.js\":\"55363560dbf8ed1f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/rejectedUploads.js\":\"60778f9cd6c444a2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/releasePowerSyncConnection.js\":\"8cae2892df83a9e9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/repo.js\":\"6f2ff02092815582\",\"/knowledge-medium/pr-preview/pr-1637/src/data/repoProvider.js\":\"73f3dde62f935e76\",\"/knowledge-medium/pr-preview/pr-1637/src/data/rowProperty.js\":\"82b1698b7b40cade\",\"/knowledge-medium/pr-preview/pr-1637/src/data/searchFilter.js\":\"63485cc748403de0\",\"/knowledge-medium/pr-preview/pr-1637/src/data/seedIdentityLedger.js\":\"c0eed283b4664207\",\"/knowledge-medium/pr-preview/pr-1637/src/data/stateBlocks.js\":\"907001ca5b4946d1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/structuralEditPolicy.js\":\"16a0b55eb5f992e2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/subtreeDelete.js\":\"f180916d824a3a8d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/syncStreamLock.js\":\"c36438b04c8567ce\",\"/knowledge-medium/pr-preview/pr-1637/src/data/syncedTableSqlRecognizer.js\":\"181445d4010bb382\",\"/knowledge-medium/pr-preview/pr-1637/src/data/syncedTableWriteGuard.js\":\"ad476a99409f5d28\",\"/knowledge-medium/pr-preview/pr-1637/src/data/targets.js\":\"1c2302ed0319b2c5\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeColors.js\":\"8bd1b8a452d53ca8\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeDefinitionMetadata.js\":\"2689b034be8b1913\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeDefinitionRegistry.js\":\"002262e2616b0f0c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeExtraction.js\":\"7ad65f7f750650c0\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeInitialValues.js\":\"d5ffbbb276c6fa1d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typePropertyGroups.js\":\"8273eb8b0b905248\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeSeeds.js\":\"88267d58161f9ab9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeTagger.js\":\"5288730e5bb47a88\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typedRecords.js\":\"2e2ca94f1a587004\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typesPage.js\":\"654acc59bb63211e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/userPrefs.js\":\"384c29096f4258f4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/userSchemasService.js\":\"c9de4cd74bafde2c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/userTypesService.js\":\"ff46661d431aa4bb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/valuePresetRegistry.js\":\"1ac3f90eb3b989ba\",\"/knowledge-medium/pr-preview/pr-1637/src/data/visibleChildren.js\":\"7f34f02115697d54\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceConversion.js\":\"a1db782455b73e0e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceFirstSync.js\":\"b0aacc19bae89482\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceIdNamespace.js\":\"14f6a25f5ebcb111\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceSchema.js\":\"cacfc67c556334f3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaces.js\":\"095a27367dfc6aa9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/writeAheadLog.js\":\"ce46d0458e67cf83\",\"/knowledge-medium/pr-preview/pr-1637/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/BlockPasteShellDecorator.js\":\"7aceb3fde67bbe45\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/atTrigger.js\":\"debc913c3d17ae80\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/autocomplete.js\":\"18f53264083a7b41\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/codeMirrorExtensions.js\":\"3eda4efc67f51dfe\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/contentFlush.js\":\"14b66fe7b2d06099\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/defaultInteractions.js\":\"0db84020926602e1\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/editSettleSignal.js\":\"e192f86a40d13df2\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/insertImage.js\":\"1e84ad458a318c09\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/referenceCompletionRange.js\":\"4711bc10cb368d0b\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/referenceTargetTypes.js\":\"fa5b90298334f74b\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/syntaxContext.js\":\"7d4423893caa43ed\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/triggerMatch.js\":\"9a6e1cbed509b183\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/AppRuntimeProvider.js\":\"9c84b2563a4e2027\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/BlockFocusShellDecorator.js\":\"104150b8e6c89dd6\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/ExtensionRenderBoundary.js\":\"865651ae4d553550\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/PanelContentRecovery.js\":\"b9c57e6a66174033\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/apiCatalog.js\":\"10bd5b1f3446651b\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/approveExtensionHere.js\":\"abfc3f1a82c0ffe9\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/armedCutAppMount.js\":\"d57b6f6ad42a6de4\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/batchableKeyedStore.js\":\"91568870154f9a91\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/blockInteraction.js\":\"b1bc958d57d44d88\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/blockSelectionAction.js\":\"742b8af1cd58165a\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/compileExtensionModule.js\":\"b60413257b6ad94a\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/compiledModuleCache.js\":\"937f230415a46f02\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/continuousGestures.js\":\"1d21ad3259239904\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/core.js\":\"2898d05fb869c3fd\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/defaultRenderers.js\":\"61616d66d8e21052\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/definitionFanoutAppMount.js\":\"214e9ec35ec8e7d0\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/dialogAppMount.js\":\"4e0f04ce42f1adef\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/dynamicExtensionSeeds.js\":\"75c08ad45f2f56df\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/dynamicExtensions.js\":\"46d57abf98d9011d\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/exampleExtensions.js\":\"9129d9df87d0e11b\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionApprovalStatus.js\":\"986e0ceddb55e576\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionLoadErrorToast.js\":\"c9ddd21b0675fd90\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionLoadErrors.js\":\"444f278ff69d76d3\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionLookup.js\":\"e9301c31916c8e51\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionToggles.js\":\"a2a1084e96d58d22\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionUtilitiesCss.js\":\"02f3a3c81c80375c\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/kernelPageDeletionGuard.js\":\"0cf0b5a13532104d\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/liveRuntime.js\":\"d48f0c53e950e0a9\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/openExtensionsSettings.js\":\"b6a3ba1a7c4ebb34\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/overridesCache.js\":\"0c0fd2a34a523901\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/pluginIds.js\":\"e960e2b0a2e21b21\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/processorRejectionToast.js\":\"3e077bf8bac92237\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/runtimeActions.js\":\"a56d39b04ff96219\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/runtimeContext.js\":\"ab07adf28d8adc19\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/staticAppExtensions.js\":\"c61c558a014be5c4\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/staticDataExtensions.js\":\"332811b2c140dfc5\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/toastAppMount.js\":\"72fcb9ed720c6b6b\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/useOverrides.js\":\"84378e1b5a9ac491\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/useShortcutSurfaceActivations.js\":\"ac904d91aa2fd797\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/discoverToggleTree.js\":\"53688b2cc1d0b4c2\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/facet.js\":\"84074d68be7f348c\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/resolveAppRuntime.js\":\"8e7379bf74bf721f\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/runtimeEvents.js\":\"ddc2d0c1cb028331\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/togglable.js\":\"729d0e47dead1b12\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/variantFacet.js\":\"1c6ca0e0a136ba81\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/verbFacet.js\":\"dfd5070e70ba81fa\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/block.js\":\"0c6c91376f386207\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/focusedChild.js\":\"bfe7b96ef4a00fb0\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/propertySchemas.js\":\"edc16443baa2f814\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/typeRegistry.js\":\"3cd14b59f05081fe\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useAncestorCrumbs.js\":\"5b308f74179c5581\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useAutocompleteListbox.js\":\"038bfc27eb48af04\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useDebouncedSearch.js\":\"ef6d43ad935d05de\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useDebouncedValue.js\":\"6c67f1e736bf522f\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useIsFocalRender.js\":\"fe8faa0890078072\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useIsReadOnly.js\":\"0ce5c11f2df40d24\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useMaterializeBacklog.js\":\"69c93887f329b67e\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useMinuteClock.js\":\"e75dc26ab440be51\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/usePanelLayoutProjection.js\":\"ed9a84465e1f6f37\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/usePendingInvitations.js\":\"5fc89bddfc08af27\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useRendererRegistry.js\":\"b611f0e159ce3f49\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useRetainedFieldRows.js\":\"af0c1ccc0b7f6c4d\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useWorkspaces.js\":\"b23ed4ee90ac62b3\",\"/knowledge-medium/pr-preview/pr-1637/src/lib/utils.js\":\"2705238cc33930b9\",\"/knowledge-medium/pr-preview/pr-1637/src/main.js\":\"331a1be9884ddee2\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/MarkdownImage.js\":\"c5a9ade7635de816\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/blockSeparators.js\":\"18f1296eceb3b3d2\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/context.js\":\"cc80c4c0ee6177ad\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/defaultMarkdownExtension.js\":\"fd783df185aa1d68\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/extensions.js\":\"d16e4f0b9ae05270\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/renderMarkdownHtml.js\":\"14e6a83d70353c49\",\"/knowledge-medium/pr-preview/pr-1637/src/minimal-editor.js\":\"c78058e2b4b29dbe\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/armedCut.js\":\"74214862944e6adb\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/captureMediaVerb.js\":\"1f03c9a9a3506c8b\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/clipboard.js\":\"fd9c06b2434b62a8\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/decision.js\":\"88277d957715d893\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/operations.js\":\"34b9a783c1e1179e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/account-header/AccountHeaderItem.js\":\"6aa992de3969b5a6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/account-header/index.js\":\"4877ebe8c7ca0dd7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"af72548f95f9a790\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/askAgent.js\":\"7c4c1b689318a50c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/askedStore.js\":\"aa6c3b2cc361dfce\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"39b9a0146ea246ce\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/chipState.js\":\"16a8d0c9305f6f5b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d1633c43e7d0c880\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/index.js\":\"33431d50c74cddd2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6b87099845091746\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/schema.js\":\"1189b19abe92c325\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d6d73c96e9bb891c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bb9565f60b6d6443\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/addMedia.js\":\"8c2d628dfe70dc5a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cb0c1ccb0b3af0de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/block.js\":\"622372b03911e7c3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/context.js\":\"5602d628ddd01891\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9467df0f60fddfde\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/index.js\":\"9e60a1c72cf253a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/outline.js\":\"dd93c48da85ebc7b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/properties.js\":\"6e798b57bce847eb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/refs.js\":\"40914cc6051f05be\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2800d147fee54547\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/search.js\":\"6ab7813e24527651\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/shared.js\":\"5d8975ba4b53575c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"436fb60f9639ed82\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/text.js\":\"a5837a55e89b2e25\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentWrites.js\":\"4faf84148e01994d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/authoringCatalog.js\":\"828c00afdd9f0e5b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/blockRefTargets.js\":\"d42285b046ebb118\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/bridge.js\":\"d826ee0fe79e50f9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/bridgeLoop.js\":\"d6f4cc4e5bd51141\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/changeHistory.js\":\"96f3031352abe375\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/commands.js\":\"3732290c6dad22b4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/commentsCommands.js\":\"abda3d886965dbb3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/dataExtension.js\":\"1b1bc732a622a78d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/dataModelGuide.js\":\"5266f36f8c712791\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/describeRuntime.js\":\"40aafc04dc6382e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/extensionLint.js\":\"9fa5b0b2feae7a8b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/grainAudit.js\":\"aa447bc8f3c741fc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/healthCommand.js\":\"7f28511449b5d616\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/index.js\":\"3e74b54e99b8b90d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/presetIdentity.js\":\"ab9ce53104bdd99b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"027bcb08e58b8e86\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/readMedia.js\":\"0afb0fa96ff6ec2d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/schema.js\":\"76e9795dc6d982b6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/serialization.js\":\"8ca2e745485d8018\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/targets.js\":\"95ee28e061de2370\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/tokens.js\":\"00e5021523545d51\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/watchEvents.js\":\"9e346b4f9e4d4179\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/workspaceGuard.js\":\"3517ded196dab089\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/writeCommands.js\":\"db51071fef88f352\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/AliasCollisionToast.js\":\"d048f6852f8769b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/DuplicateNameBanner.js\":\"b30827dbbf6c8011\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/collisionMerge.js\":\"77b6613a179bfefe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/dataExtension.js\":\"e18e6e7f91afb09e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/index.js\":\"1f87889f245be8b7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/mergeCollisionAction.js\":\"c17bf87a3094bd25\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/pageStyling.js\":\"679dcdf63ab9499c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/rejectionToast.js\":\"d4901819e6acff13\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/syncProcessor.js\":\"6fa74921737d5ee0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/actions.js\":\"d63d3abe7e49d972\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/addComment.js\":\"629ac18151df3fad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/anchor.js\":\"39e9b1e128332869\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/anchorState.js\":\"bd4876c107cc88d2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/commentLinks.js\":\"29657d2386f7140d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/confirmThreadDeletion.js\":\"555312fa61d6745a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/container.js\":\"78df446975fd0236\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/dataExtension.js\":\"8692ab27e80d0973\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/deleteComment.js\":\"1eb8b0b4044158cf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/highlights.js\":\"d7adf1e0df3ed780\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/index.js\":\"e7548b4ea52c79aa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/linkedCommentsPill.js\":\"4d3d9dcf9e1b8e02\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/margin.js\":\"e83bc795d1af7de4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/marginSchema.js\":\"74fdc6ddf438ace7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/newComment.js\":\"77815220e66a0fe7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/ownThreadPicker.js\":\"2aeccc390f244d32\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/placement.js\":\"edc22ebf2d78915a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/queries.js\":\"a6f5eea882f58b84\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/quotePosition.js\":\"3b6a06c748523205\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/quotedIn.js\":\"640ab81f4fb29e85\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/quotedRange.js\":\"d4a8d39c0807552f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/rangeRefs.js\":\"aced41d78efb22c5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/readHighlights.js\":\"eb71085c6d47373b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/readSelection.js\":\"6b25f9da14d2ae90\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/readSelectionUi.js\":\"31548f3ed5688eea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/reanchor.js\":\"f3c0c464dac58053\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/schema.js\":\"b3e4b3d85cc3491d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/scope.js\":\"b2f48f5d6a410b26\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/scopeThreads.js\":\"35bbfa8db66b6d9a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/splitRetarget.js\":\"4a09fc2bc52aa63e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/suggestionCard.js\":\"8abd8ed9fd320199\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/suggestions.js\":\"5bb14769971aa4bc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/summaries.js\":\"6923f7899638ad7b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/summaryBatch.js\":\"475d9bccab7f80eb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/surface.js\":\"096f0121e85d22e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/threadNavigation.js\":\"10fc123960cf6742\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/threads.js\":\"04e885b11a177d6e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/ui.js\":\"d6d493ddbf1a3666\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/uiStore.js\":\"c971fff112aaae4f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-intents/appIntents.js\":\"e3b5cce4b20ddc68\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-intents/index.js\":\"d3a730f58328547a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-update-prompt/index.js\":\"34b6f96790159d0b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-update-prompt/status.js\":\"02938c3b12fccd1c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3143e28d484dfd0c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/MediaBlockRenderer.js\":\"0ead457e965792b4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/MediaDownLaneReplicator.js\":\"028e6d31237cf22c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/MediaUploadReconciler.js\":\"0b734296b231446a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/assetDownLane.js\":\"0bd805b87095a053\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/assetResolver.js\":\"4941ec53c35308c4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/assetUpload.js\":\"bb74555852c101bd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/attachmentCleanerIO.js\":\"d74dcac652d3063e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1fb4c6f7cae78b89\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/blobStore.js\":\"9f1ac12cbe9c0fb6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/byteStore.js\":\"4687851814ba157f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/cleanerIO.js\":\"56d5bdd65acdc20e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/cleanupAttachments.js\":\"a743b61b0b854971\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/dataExtension.js\":\"4250890e6e17e0d0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/downLane.js\":\"eacb8c420ae756b3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/index.js\":\"24ceeaa9d0003624\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/insertImageContribution.js\":\"a672c63b50483b87\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/laneArming.js\":\"8b88171590fbcd48\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/laneLock.js\":\"833ce54024533cee\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaBlock.js\":\"11f787c903409bb2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaCapture.js\":\"618512d297d1d39d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaViewers.js\":\"35ad3e5abf75a3a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaViewersFacet.js\":\"07544c6df39509a9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/pasteCapture.js\":\"222a92a4754b58aa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/resolver.js\":\"59074e09cf7ac7da\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/retryUploadsAction.js\":\"d99e4b06ba4aae3c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/storagePaths.js\":\"30366716e20d771c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadDrain.js\":\"24bae9d6e5ea6a2c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadLaneStatus.js\":\"72515382c5e1f7bc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadReconcile.js\":\"2f167301a13da36a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadRecovery.js\":\"fcc70335429e7f9e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadStore.js\":\"c450f152a435233b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/useAssetObjectUrl.js\":\"6153f9932646db44\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c18a09afda01934f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7dcde3d361715eea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/facet.js\":\"3e4c7ae4eb89c102\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/index.js\":\"4a4e2600d693b025\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/prop.js\":\"bca757a242083cb6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/BacklinkFilters.js\":\"f9efcec9d3401fa4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6a5cee95d6e76908\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/BlockEntry.js\":\"876628ee93e634f9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/LinkedReferences.js\":\"cce162e76ff00f3c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8bc5caf77e5ce21e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/dailyNoteDefaults.js\":\"8a8168716ed92be7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/dataExtension.js\":\"9c65a68a15c98be6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/edgeExclusions.js\":\"7b251ec95bcbde35\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/filterProperty.js\":\"204c1d358928b047\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/index.js\":\"d9444dc53f213b47\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"909cb3c5a50fd4d1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/applies.js\":\"2b8787a5d263c57d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/countQuery.js\":\"1cf1a8a421bab985\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9b556b31e461e9ff\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/index.js\":\"b66417157383e1ef\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8026bf2b01da6c6c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/presentationInvalidation.js\":\"fb1de028a4bbef90\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/propertyEditorOverride.js\":\"da7ba94c6aac7d2e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/propertyFilter.js\":\"fe7149dbc4eb83e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/query.js\":\"a079a8f86c057be0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/resolveFilter.js\":\"1704d253f06114e1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/sourceBatch.js\":\"3e9774af72c38b16\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/sources.js\":\"127a950ad71cdb7c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/useBacklinks.js\":\"7db69d3b06144059\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7fe9ecf368982ed3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/BirthdayCelebration.js\":\"dd10cfd1ff2d477e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/BirthdayOverlay.js\":\"bee6062953ce8c24\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/gate.js\":\"926202b9ca278730\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/index.js\":\"9c31ee22458f128b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/wolfTheme.js\":\"ca33e3780c334268\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/BlockDragLayer.js\":\"3542700736dade4d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/dragController.js\":\"babc77f4ae1b87a8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/dropTarget.js\":\"153efc983318b6e5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/index.js\":\"0cf1500c41d8701e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/projection.js\":\"f8cb9cf88af184e1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-info/BlockMetaCard.js\":\"76931ebfb58eec0f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-info/index.js\":\"4d414a95c3e7868f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/AddTagDialog.js\":\"5996e307d9a54622\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6bd7487929e754e7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/TagNameIssueHint.js\":\"d4ef27a3e077fbf9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/addTagAction.js\":\"1cb8259bf2b40e4d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/appendTag.js\":\"36aaacae729d67e4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/config.js\":\"5f56df7b07dc3100\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/dataExtension.js\":\"c3d7497d17482cc7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/index.js\":\"ac0d95559630937b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/propertyEditorOverride.js\":\"9b8bfff45dacf4f6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8a65bf937b28bde4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4e6634e49ba7fac6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bdacc38aee495b21\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"111a936d6e891a44\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ad41fd09b40252fe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/index.js\":\"a8f624428da5b764\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"56bc2cbb72577953\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/CharacterCountItem.js\":\"038bf904d8651415\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/ProfilePropertyEditor.js\":\"727a8457ffec9703\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/actions.js\":\"476b30083be33204\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/blockType.js\":\"ac2f7e8d5127428e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/charCount.js\":\"b676b49503938e66\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/dataExtension.js\":\"bd72adc29bd7e0c5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/index.js\":\"a2e51b9916cd05f8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/profiles.js\":\"e401c3a81d8e3a82\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/properties.js\":\"ff9a9751fa6a4c39\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/textCounts.js\":\"f44ffaac2534e7f3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/colemak-keybindings/index.js\":\"ead29aefc7b82f52\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/CommandPalette.js\":\"1e5a08b558de6f0a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/HeaderItem.js\":\"03e2a92d8ddad5c0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/context.js\":\"5163a3d146065a5b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/index.js\":\"083d48fb2e7cccc0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/selection.js\":\"ceef20aaadb5ada1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/toggleStore.js\":\"3efdb14e4b7f3e52\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/useCommandPaletteActions.js\":\"745ad2a27311babb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/ContributorBadges.js\":\"bb16d1cf7eac9c66\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/author.js\":\"212e1099bb27cad0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/codeMirrorExtensions.js\":\"88887fcfed609e35\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/dataExtension.js\":\"f23e42904aeac28f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/index.js\":\"aae613c6e2b25a72\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/mentionAutocomplete.js\":\"ded59067155a4caa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/processor.js\":\"873409558d38899a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/profiles.js\":\"519314b3e7125b94\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/queries.js\":\"da69011e202195b5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/schema.js\":\"e0d2e010170d5946\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e87a2dee07aba55b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f35c2fd52473781c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/index.js\":\"afdb611d8be3ebd6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1f34d77a4ca0273c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d489dbc328d2ef79\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/CalendarGrid.js\":\"917afd8acbd3326c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DailyNotePicker.js\":\"6a82832fc628d4f8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0f577ea669b2b94b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DateNavDecorator.js\":\"d261a8c3a9a0c323\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DateScrubOverlay.js\":\"b8ee563556d9c10e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/HeaderItem.js\":\"f258f78cbd7df56a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/ReschedulePicker.js\":\"35927fccc2c9b439\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/SpreadDatesDialog.js\":\"819d6bf3817ec29a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/actions.js\":\"7917ac2873593897\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/blockDateAdapter.js\":\"14230a83271613f9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/calendar.js\":\"1becec72cc9dd31f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dailyNotes.js\":\"82bb57557adf73b7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dataExtension.js\":\"34a113469b13e63f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubActions.js\":\"3c5ccf9b4b37160f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubGesture.js\":\"66671423bff29d3f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3a4d128f9c19d9e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f2a49574292e4dba\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/deletionGuard.js\":\"8da581f7fb6deb06\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dueQuery.js\":\"e86a15fb2809afdc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/index.js\":\"70df38b1fcbe07ad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/landing.js\":\"bd00b87e6ae1cab5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/localSchema.js\":\"be4ded6076daadc8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/referenceDateAdapter.js\":\"88b5ff70efb268c7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/rescheduleAction.js\":\"109a8a4299dfbe78\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/schema.js\":\"bd6c75bedbd18286\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/spreadBlockDates.js\":\"5abfa109ca1f6f80\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/spreadDatesAction.js\":\"02957140e9b430e5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/today.js\":\"e957ee76295e99ad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"69ff00986b15406a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"da72090f34c26a3b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/audit.js\":\"a4faad102997689b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/auditAction.js\":\"1a75c6081cc96602\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/auditRanges.js\":\"20569a26f2d5e897\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/diagnosticsSource.js\":\"6d3f02828270c66e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/divergenceScan.js\":\"37a355c6c3de1b0e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/index.js\":\"4837ce5c3d4d90bf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e53b0c6406e7d287\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/referencesMirror.js\":\"1dc78219af49e297\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/rowJson.js\":\"de8491abf6f02b6d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/schedule.js\":\"7d010f23989e9de9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/store.js\":\"d646b06dc5c60870\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-maintenance/action.js\":\"9d1afde104a03946\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-maintenance/index.js\":\"441056f3b593cf76\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-maintenance/plugin.js\":\"e9233d14419b3404\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3059781983d1da49\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/actions.js\":\"fc6c9c6b4a9b3395\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/changeMarker.js\":\"a81fd4b88af3aef5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/diagnostics.js\":\"43de87ff9763d1b2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/fileSystemAccess.js\":\"ef59d7eae07c71b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/filenames.js\":\"a19045e11ef4b0f8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/index.js\":\"c16e954af7c7f0b9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/mirror.js\":\"2d46a9dac2474daf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/runLock.js\":\"f0c863522939ed09\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/runtimeHealth.js\":\"dece3b75d6377cf4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/schedule.js\":\"e847e565d26e3b05\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/store.js\":\"1d4bde39141d2236\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/default-themes/index.js\":\"8e4f1e0c9d439e6b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/default-themes/themes.js\":\"7fc7187fb5c164eb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/diagnostics/facet.js\":\"88c6857af707b482\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/diagnostics/useDiagnostics.js\":\"48a15c980ee27ea3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/dismissals.js\":\"b3515e7bcdf5e288\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/index.js\":\"0bcb359b8e2699e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/status.js\":\"411173aaa81e9bcc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/store.js\":\"4590fbcb228966a7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f48f42168c2738fa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/ExtensionsSettings.js\":\"26cc445d2c41901f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/actions.js\":\"f10820ab9044925e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/config.js\":\"fa1e948c7e89dcd9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/dataExtension.js\":\"d9bbc360bdaed5b5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/effect.js\":\"f66dc0c452414cf5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/index.js\":\"8d924005232eddca\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a2e4d3599cf8f799\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/useToggleTree.js\":\"0606c8ab092e8d16\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/ExtractTypeDialog.js\":\"e3c51cc3b7bd1e0f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"903ac23a8d0b16a8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/PropertyShapePicker.js\":\"3bc4b5a88b2c5087\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/action.js\":\"36c4fd66707db886\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/index.js\":\"a4f9c2752bb28ff9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/FindReplaceDialog.js\":\"6f8acb1f5ab071f0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/HeaderItem.js\":\"204e127d058923de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/dataExtension.js\":\"749c15624000fd37\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/index.js\":\"8aaf3e2470a9f7b2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/search.js\":\"e2c43ddb725d4b6e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/toggleStore.js\":\"8354b6568ea01f2f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/LocationPropertyEditor.js\":\"6d980a0c3350475e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/MapView.js\":\"5a80311d2fecee28\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/blockTypes.js\":\"fd069330f77e206c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/codeMirrorExtensions.js\":\"f3382ee5aee0baf4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/createOrFindPlace.js\":\"ef9b741c7e7f01c6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/currentLocation.js\":\"54203f163211635e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/dataExtension.js\":\"07b53e5dbe30766c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/geoContentDecorator.js\":\"79b91bd37c667cac\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/googlePlacesClient.js\":\"d01854ffd832c480\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/index.js\":\"71369cb85d78e4a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/locationsPage.js\":\"fa71e4ea7502031a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/mapViewport.js\":\"e15da8a597bed1ca\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/pickCurrentLocation.js\":\"82170d204c0a529c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/placeAutocomplete.js\":\"a97c55fa4725e2a5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/placeNameCollision.js\":\"f815496195471cc3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/properties.js\":\"f104fdef032bc02f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/propertyEditorOverrides.js\":\"f4c4a7c3283d768b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/query.js\":\"0305c94491ff1bb8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/usePlaceSearch.js\":\"6f64523c608408a6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4217827086d598ec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c115fbda056070db\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0d42c220324aa28b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/config.js\":\"aff2215970b28d7b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/dataExtension.js\":\"e590e07e2424e479\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/facet.js\":\"68ccd5f3ab3d7f91\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/grouping.js\":\"09093821a87fe78b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/index.js\":\"68eab5fcb3024f93\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3db6b071533c9dab\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/query.js\":\"05604a053cf42b86\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/resolveConfig.js\":\"3efae11ee14f0926\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"97fe55f3974bbbbc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"72d9bc1df2283589\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/HtmlDocumentContent.js\":\"417111939d306c3b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/HtmlFrame.js\":\"5330fd34267caeb4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/actions.js\":\"f3959029a2dd9a57\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/blockType.js\":\"5cdc97b4b6f7715b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/confirmRunScripts.js\":\"1bca9a06cc734681\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/dataExtension.js\":\"4269c5e4875c0a23\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/frameAnnotations.js\":\"43fc4c47c3419841\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/frameDocument.js\":\"bc4ab51b6d76850d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/frameTheme.js\":\"342a674993bbc1d9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/index.js\":\"d30553767e52d690\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/scriptConsent.js\":\"fad393352adb1df9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/sourceMap.js\":\"e375c0394d4e7f5c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/useDocumentScripts.js\":\"9730d7e450dc630e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/index.js\":\"abad1c1e224ebdb1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/record.js\":\"820e4885135ea420\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/recordStore.js\":\"6584c0bb22e64273\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/responsiveness.js\":\"4ea806ff35df1156\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/schedule.js\":\"e8f047bff11f7a36\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/sessionContext.js\":\"a101e0fd135c4c2f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"782ab755a3b5d2ce\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1d7784bb2ee2ed86\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/actions.js\":\"3ca69cd93fbf1483\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/config.js\":\"dd39ac5eb8005a47\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/dataExtension.js\":\"8488b2ea7c4b3822\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/effect.js\":\"f539a5c0dea12eff\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/index.js\":\"94ec906b644634af\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/keyCapture.js\":\"ecb1dfb6fbd23860\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/overrideStore.js\":\"6a362b654ea92a2d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"77d18ab14f052ccf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/HeaderItem.js\":\"20b7028ecd098b81\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/LeftSidebar.js\":\"bfd900978174934e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/actions.js\":\"458e8359e3851d76\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/facet.js\":\"e7b87b071e2f6955\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/index.js\":\"58d358f55f5afa26\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/shortcuts.js\":\"233e899accd335c1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/toggleStore.js\":\"774d728a0498c96c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/MergePicker.js\":\"75112acff9a3a974\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/index.js\":\"1dcf01866a23bacc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/mergeAction.js\":\"0771cc584c59664a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/strategy.js\":\"63d7fff02ac92e05\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/Button.js\":\"fdf64865b64c858f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7bf5deaf3983c1de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a642ca9845fd6eab\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/facet.js\":\"a5985bb18852edae\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/index.js\":\"3c24d6798f6a1ea5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"179722ca344d8c88\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/actions.js\":\"92a9a42e4e9f357a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"fb239b9e756fad9a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/facet.js\":\"537e7ffffc490993\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/index.js\":\"cf46651f1e3fdd7b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0bd063280744be3c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/blockSubtreeMembership.js\":\"087db20a1088ef81\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/contextMenuItem.js\":\"7b7f5283a82f63c2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/index.js\":\"5023f685cc02490f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/moveAction.js\":\"7386434516aed3bd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/moveBlocks.js\":\"d7c016aeeaa54db8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/selectionAfterMove.js\":\"0a4b8aa198d35447\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/TutorialBanner.js\":\"68d0258e18e3e70d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/action.js\":\"88ae2849b85fd247\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/bannerDismissal.js\":\"7df04ae91bd1b930\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/documents/cheatSheet.js\":\"c6a9a06d35de9405\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/index.js\":\"d5b23f2602805fb4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/keys.js\":\"b38e632c4418f4c7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/landing.js\":\"3bd81a9a36166743\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/outline.js\":\"803d034f772cc7a2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/seed.js\":\"3d95179292432cf0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/PerfTrendDialog.js\":\"65da3abe67c01500\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/analyze.js\":\"b30a6a44fdb7066a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/diagnosticsSource.js\":\"176c047f71e0a9b6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/index.js\":\"65310ba250c6fe9f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/load.js\":\"607b286f0e7f4df8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/monitorRun.js\":\"ce58a09ce408458c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/schedule.js\":\"a3d7c25d000dd5e6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/series.js\":\"b9199b0c5cba0738\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/store.js\":\"d9ed673881e261b9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/trendAction.js\":\"21018753c3dcefe1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/verdict.js\":\"1e024d770ffd6ee2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/plain-outliner/clickToEditAction.js\":\"1bac9bc827b9c908\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/plain-outliner/index.js\":\"9db1f8dc2d48b6ea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/plain-outliner/interactions.js\":\"a7d1faf19bfd1a69\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"75c177110a62c98c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/MigrationGate.js\":\"3c92639bad61e9a3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/MigrationGateDialog.js\":\"f713f6d0c7e12833\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/action.js\":\"9770e5ad1657017c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/index.js\":\"c4e298aa4932e27c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/localRunMessage.js\":\"639dc72c6834f42f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/plugin.js\":\"467dfd2308ff02e3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/progressReport.js\":\"f45193edc6e7f5f7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/sweepProgress.js\":\"a3c24bf36db745f5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/FieldRowRenderer.js\":\"9a99120eed85fb8f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/ValueRowRenderer.js\":\"f97e8055b8f46985\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/actions.js\":\"03dc326411cddf29\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/autocomplete.js\":\"507692a7c4c722af\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/fieldRow.js\":\"fdfc58d0d137eec6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/index.js\":\"de60e9971cc71f6c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/referenceWarning.js\":\"f01d55dac90755cd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/valueAutocomplete.js\":\"d2609e8164c4f19b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/valueSchema.js\":\"e90a137221da25bc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/HeaderItem.js\":\"3e7dc6f1eb9e72ee\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/QuickFind.js\":\"7774e6d0ffb0075b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/index.js\":\"299a67ba7ee13d77\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/recents.js\":\"c0cfc216513a780a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/resultItems.js\":\"b2074a0aad4cf11d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/selection.js\":\"e4a09af1a333e7ba\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/toggleStore.js\":\"591d0661642bb6eb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/HeaderItem.js\":\"4f472df548c4001a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0d3cab58ecea13e7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/grouping.js\":\"93570b6cece2a65c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/index.js\":\"b808345dcfb093b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/target.js\":\"c505dc945774bb9c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/codeMirrorExtensions.js\":\"03d68b2f2864b84d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/contentPrefill.js\":\"7acf07ccabf28267\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/dataExtension.js\":\"f24ea73bc6452be0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/index.js\":\"a7e7ee42dd77870d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c5cbcfa105618b69\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/invalidation.js\":\"109ff4705feb94f4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/localSchema.js\":\"a8a96762153e2861\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/blockrefs/index.js\":\"27e2e9a9e06d357a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bdc8b175ccbb461d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/index.js\":\"749278c68fad1fd4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/referenceNode.js\":\"b2faef14f6a45bf0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/remark-reference-occurrences.js\":\"96a0e1672c698bd2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"16bb185ea7ec80f4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/index.js\":\"a5ba7fbd66f068e6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fcc814c091f214c4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"4c66f3829abda0c4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/mergeRetargetProcessor.js\":\"0954e1f2b7bebbe1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/parseFence.js\":\"3fc5630a70f1908f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/referenceParser.js\":\"ed246d5f871dd27d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/referenceProjection.js\":\"05623b3ab9696dc3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/referencesProcessor.js\":\"5d047a546b48a634\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/renameProcessor.js\":\"194e2b10686b7982\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/spanReplacement.js\":\"c542a098385aea9a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/htmlToOutline.js\":\"b31010e653b52cae\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/index.js\":\"0d0e1e25f31fe262\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2d4cf34af7446e9b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/pasteDecision.js\":\"9fb4e74cf2531e91\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/action.js\":\"e8a87034b40cdd94\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/blockIds.js\":\"b2b3b101b77733e5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/content.js\":\"3aefd263b82d83a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/effect.js\":\"d3a23e10fab3ea57\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/ids.js\":\"9859b559ab60bf2d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/import.js\":\"608e38a30dc582d0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/index.js\":\"36fa199344bb5995\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/plan.js\":\"d20da21ec27e7e2a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/plugin.js\":\"b59ddd43affc55da\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/promotion.js\":\"f4254d2bebff6242\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/properties.js\":\"94e492bfb76380e2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/references.js\":\"0114891c75a98a8d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/report.js\":\"278046a7318798a2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/roamMemo.js\":\"553c17c3c8295b86\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/runtime.js\":\"12d34dd5d9a94bcf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/schemaReconciliation.js\":\"f8bd46dbe7fea929\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/srsMarkers.js\":\"93f4be7d6b545652\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/todo.js\":\"5197c93493208975\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/typeCandidates.js\":\"7d8e8a677e754fec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/types.js\":\"5bbd6e21297d3b53\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/search-health/index.js\":\"eb66781da7e4e0f0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/search-health/store.js\":\"fe31724b056af2a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/HeaderItem.js\":\"c55047e819c74620\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"480eb7bfcf361305\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/index.js\":\"fbe1b8a142365360\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/model.js\":\"9824a63b74148ee1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/toggleStore.js\":\"bf03877d13ed2955\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/useKeyInspector.js\":\"21e26d7311bcef73\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e57e481e556a0150\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/ShellDecorator.js\":\"7487ac1e68b8a441\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/actions.js\":\"f21a93b351850fb1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/exclusionsFacet.js\":\"45e629fcf0da2911\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/index.js\":\"40257376dab474f6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/shell.js\":\"e0749a85ced221ec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/surface.js\":\"60b28a3a20691c01\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/walker.js\":\"c90dc3766e66f4df\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e6e0b018c96e2700\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/dataExtension.js\":\"e64c8aecac3ae574\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/index.js\":\"9f8bf48923a0ae3a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/indicator.js\":\"6f89d81de9939d22\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/moveSrsState.js\":\"c53c9103cb601ace\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"25d274ba8f42ad86\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/scheduler.js\":\"e27c84a3c68667e6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/schema.js\":\"aafbb9b5b94609d1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ed63e06b1ce0059a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/srsClipboard.js\":\"265de6c1009ab94d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"66e38deb836931f2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9ff3dd9499df9f11\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/DeckPicker.js\":\"ee599cda912f0d2b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/ReviewControls.js\":\"3173d108959a7ed6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b9a7a1700b8b6fb5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/ReviewSession.js\":\"d18469d0281fbfcd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/actions.js\":\"b889b29de27e2983\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/archive.js\":\"7ec0e1bb2dde9e4a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/dataExtension.js\":\"28822f4cbdfdf854\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/deck.js\":\"477c3c17b21f8f15\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/dueQuery.js\":\"0f75a01b2c978224\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/gradeDecision.js\":\"f296f03762d40195\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/index.js\":\"ba125aca8b90fe3a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/keyHints.js\":\"75e04d23bc4d8993\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/reviewCardLayout.js\":\"21e8c26fa9866bbe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/reviewProgress.js\":\"c132c66a235c638d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/schema.js\":\"714477d1b3ee6f35\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/useDueCards.js\":\"35fae727cf376ec3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/startup-metrics/index.js\":\"4ff9f2e14f81131d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/startup-metrics/record.js\":\"0ca9d0901a98ee80\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/storage-persistence/index.js\":\"5a7bf09d579619c2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/storage-persistence/persistenceStatus.js\":\"6c6f65c231e9641d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/storage-persistence/requestAction.js\":\"d15c70246d7fc026\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/TypeChipsDecorator.js\":\"6684777db1b3fccd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/codeMirrorExtensions.js\":\"c3f1269a27aa1276\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/index.js\":\"91e79d20e10c55b1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/typeAutocomplete.js\":\"76d8ed850ed6f5d1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"dfd7954d6afbbd43\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/actions.js\":\"f8318040ca13d113\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/anchor.js\":\"a1249674416060ec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/events.js\":\"cf3043a30f431941\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/gestureActions.js\":\"5f6490ddc9ae8d99\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/index.js\":\"26b4979add90407f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2e5deb3a43f4e02e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/sync-metrics/collect.js\":\"56e2ace7ab0df951\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/sync-metrics/index.js\":\"2b6aaace7f4c3248\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/sync-metrics/record.js\":\"d0546629bb7d50ea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/RejectionDialog.js\":\"fba4216d1a1d59fc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d4bcd681abe2f0cd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/index.js\":\"02ddcffc8f0dfd51\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/model.js\":\"8dd354936a5f5571\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/queueCounts.js\":\"a8f31d02708ffb43\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/rejectedHelpers.js\":\"bc0f95bb9d4f54e3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/rematerializeAction.js\":\"dbdfea4463c6d170\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/useHysteresis.js\":\"823ab09991337aa8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/ColumnHeaders.js\":\"0498db0caa21932f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/QueryUi.js\":\"8cddd76396a35a6c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/TableLayout.js\":\"05d0d259b69c7514\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/actions.js\":\"072a7acdfa3e4462\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/cellEdits.js\":\"90fafe9184433551\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/columns.js\":\"99d0dc1ad91da2c9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/controller.js\":\"a58f7740dbfe8c89\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/convert.js\":\"8a476acd8e8db988\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/dataExtension.js\":\"9edeebf3cfeb4383\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/index.js\":\"85d37ec67d7c0947\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/keys.js\":\"fdb3b8575efc34f5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/model.js\":\"19d2bb99fc334da8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/navigation.js\":\"051cafcc4bf08e3b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/backfill.js\":\"b012feae62ed1490\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/completion.js\":\"7ce4a7fce25647d8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/format.js\":\"a9cb83f7d74d9ea8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/parse.js\":\"c15d63d76007ded9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/queryValue.js\":\"1fafe0ab36e1e2de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/source.js\":\"2c7fda46fcce5050\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/registry.js\":\"5b21fce1e5d11aab\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/rowGutter.js\":\"56d300eeeb2b074b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/rowVerbs.js\":\"68422de694fb2011\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/schema.js\":\"cb1407720f31d2e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/sort.js\":\"43e4e3ac598920c9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/theme-toggle/effect.js\":\"0bdd8414fd8d0167\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/theme-toggle/index.js\":\"91a8eded1f15d38e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/theme-toggle/theme.js\":\"ef8017cf62df8715\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/actions.js\":\"b019e0c8b84a8876\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/dataExtension.js\":\"52e536d541f4722f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/index.js\":\"c609419dace914ba\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/schema.js\":\"a48c241732f77743\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/TouchSelectionLayer.js\":\"87b3524143f9f802\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/actions.js\":\"bab1a86103f98190\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/defaultItems.js\":\"9006d381141d200b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/facet.js\":\"de53738e445a763c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/holdRecognizer.js\":\"cc441723c11f357d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/index.js\":\"5f7f121fe089bf5d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/update-indicator/UpdateIndicator.js\":\"e381a2c7ddbca2df\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/update-indicator/index.js\":\"cc806b7484b2e6e6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/update-indicator/loadTimes.js\":\"52cbe672c9e94bff\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/VideoNotesRenderer.js\":\"3a4ed9078f429b07\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/VideoPlayerRenderer.js\":\"bebdf558fcd3d95e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/VideoTimeStamp.js\":\"69fa14688c48d06f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/actions.js\":\"77aafc905a1d837f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/index.js\":\"4cd4df227349f685\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/markdown.js\":\"13541112bf45fc5d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/notes.js\":\"439af63722461afc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/registry.js\":\"9fbf8cedb32e9ce3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/remark-timestamps.js\":\"14db086f14b2b071\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/view.js\":\"ce222d7995f1d7fa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/LinkHints.js\":\"01a66e83b2bf4168\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/index.js\":\"c7fc681cb2cb46c8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/model.js\":\"4bd16faaaaa77db8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/settings.js\":\"29023000af324c1b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-normal-mode/actions.js\":\"098ffbe41846d9fb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-normal-mode/index.js\":\"7e55a05331375594\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-normal-mode/interactions.js\":\"8f5f0fb671761d5e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/workspace-header/index.js\":\"5f274a36ca45804e\",\"/knowledge-medium/pr-preview/pr-1637/src/registerServiceWorker.js\":\"377e8428bf26972d\",\"/knowledge-medium/pr-preview/pr-1637/src/requestPersistentStorage.js\":\"a045efaa116300ee\",\"/knowledge-medium/pr-preview/pr-1637/src/services/authRequestDeadline.js\":\"7e113411de11ff66\",\"/knowledge-medium/pr-preview/pr-1637/src/services/authStorage.js\":\"f7d0bab2538a2b89\",\"/knowledge-medium/pr-preview/pr-1637/src/services/powersync.js\":\"4fc8b12f5fdae7fe\",\"/knowledge-medium/pr-preview/pr-1637/src/services/supabase.js\":\"f7b059b55b0be1ca\",\"/knowledge-medium/pr-preview/pr-1637/src/services/uploadErrorClassifier.js\":\"ab850eff80539d3d\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/ActiveContexts.js\":\"1ee676e258c68e24\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/HotkeyReconciler.js\":\"6357614a83b8c2e0\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/WipeLocalDataDialog.js\":\"0aec32e62f5ab3f9\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/actionDispatch.js\":\"55f73cac22e2ed4d\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/actionRefItems.js\":\"13d391379f76db00\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/applyKeybindingOverrides.js\":\"0aaa562f86f9ba54\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/blockActions.js\":\"c94c1d10acbe9719\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/blockMergeGesture.js\":\"29c6ded167ef8015\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/canonicalizeChord.js\":\"355850cabd4845cb\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/defaultContexts.js\":\"d8a266595ac6b55f\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/defaultShortcuts.js\":\"6257519fa159db80\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/effectiveActions.js\":\"e0e43a1665563377\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/gestureAction.js\":\"dfee4f3f8b3be23b\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/gestureBinding.js\":\"5fdb0e0b62d65f37\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/holdRegistry.js\":\"dc489b0dd4f62a6b\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/keybindingConflicts.js\":\"439d8ed1cc932b14\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/keybindingOverrides.js\":\"8798e0bbb486f232\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/pointerAction.js\":\"2e127287dd769816\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/resolve.js\":\"55468fdccbbe14ee\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/runAction.js\":\"c5d01dcb1dcc8ed2\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/sequenceMatcher.js\":\"ce9e1ab11d4cbc78\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/types.js\":\"f7984c5fc1290b69\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/useActionContext.js\":\"c9e98d3372fb8c44\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/useActionDiscovery.js\":\"6a2027566beca78f\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/utils.js\":\"18362975b806b828\",\"/knowledge-medium/pr-preview/pr-1637/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1637/src/sw/bootStore.js\":\"50843b8dc310ce17\",\"/knowledge-medium/pr-preview/pr-1637/src/sw/previewDatabases.js\":\"2cbe9c01cf376770\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/byteTransform.js\":\"c6eebe8f4af5ddcc\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/attachmentCleaner.js\":\"ddfb36b36b4bf051\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/attachmentParts.js\":\"f39c3b9a34a53d1a\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/bundleParts.js\":\"8a86ddc6fb49582d\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/bundleRecord.js\":\"c421d68af8cad423\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/manifest.js\":\"54f26528fb06dbc0\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/takeBundle.js\":\"3d9821edec65f558\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/verifyBundle.js\":\"b98844ff6c536c0b\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/cleaningStage.js\":\"c7464d77f2ceb11d\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/conversionKey.js\":\"37b246f16a5f4099\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/conversionServer.js\":\"c3fbda1bc9dd839e\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/flip.js\":\"e0df5d97ce136ac1\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/flipAttempts.js\":\"bda7767a1da6b1a9\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/pages.js\":\"e4d775f3f97ffa9d\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/preflight.js\":\"32436c6fa50643fb\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/reseal.js\":\"4e4adc17f557ee70\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/runConversion.js\":\"18492d154cb4b0a1\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/runLock.js\":\"c85d2d86fda115da\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/sealing.js\":\"e65a0da52b81d5d0\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/sealingStage.js\":\"6ab2bd8dcb8308ae\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/stage.js\":\"68a2ba944f6e9117\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/verifyReseal.js\":\"2ab73d4e5378583c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/aad.js\":\"a236ab48991b25ad\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/aead.js\":\"559ab7805049dcf9\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/base32.js\":\"a096a2400aa233be\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/base64url.js\":\"444a4ff8e38bbcfd\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/binaryEnvelope.js\":\"d733efc09b1cf8ed\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/byteAead.js\":\"7102661a66a235b3\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/canary.js\":\"3e77199d30827e00\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/contentHash.js\":\"f610ec57aebeaa5d\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/contentKey.js\":\"c8aead77c808f56c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/derivedIdNamespace.js\":\"204a1d454475cf6a\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/envelope.js\":\"c35ec96212013b5c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/hex.js\":\"f1ec3a05fbfd05d9\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/sha256Hex.js\":\"52879ae097c75ffd\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/workspaceKey.js\":\"58eff840c6ea5633\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/conversionState.js\":\"8e41d5496fe6e0be\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dda741b34b335b34\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/pastedKey.js\":\"4a943a9f723f6ee7\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"cb2c3b2e9e17a4be\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/upgradeWorkspacePin.js\":\"76dd3eef24d56089\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/keyStore.js\":\"49d7ff9de9342ce9\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/mintWorkspaceKey.js\":\"015efe7ba3d874a8\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/modePin.js\":\"e74eec1ed28cdf4e\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/openWorkspaceKeys.js\":\"60b2fb47b4a642f0\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/resolveWorkspaceEntry.js\":\"7726f81d66b5cb10\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/resolver.js\":\"15d6a2f05cffd7d8\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/workspaceAccess.js\":\"1c329185d3f5142f\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/transform.js\":\"3e34517c5fd45915\",\"/knowledge-medium/pr-preview/pr-1637/src/themeBootDefaults.js\":\"829176658ed1c432\",\"/knowledge-medium/pr-preview/pr-1637/src/types.js\":\"12006bb6249344c6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/ClientLocalSettings.js\":\"559b2e221b8121ad\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/abortableSleep.js\":\"fa3ff224c14df55f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/array.js\":\"997feabfa82e3520\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/backlinkAutocomplete.js\":\"b556cee1e9e2ade3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/blockCrumbs.js\":\"bf9e2f9b95051096\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/blockrefAutocomplete.js\":\"ee0001ad8a124539\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/cadencedIdleJob.js\":\"6e5d88c7a50eecb3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/callbackSet.js\":\"340ae8363a05413e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/clientId.js\":\"ef108225f283f51e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/codemirror.js\":\"cbdc4dbb54a93830\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/codemirrorCompletion.js\":\"d2aabfdf7725ccbc\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/copy.js\":\"7502a177e5e370ae\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dailyPage.js\":\"4ad9399a9a32b915\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dbForensics.js\":\"ac93a91ee1428d32\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dbForensicsHooks.js\":\"cae18b9c22cf1013\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/deleteBlockThroughUi.js\":\"5238692c12d221a9\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dialogs.js\":\"b50fe13b6b41c9e6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dom.js\":\"a966f1426f264f4e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/downloadBlob.js\":\"8a3436e60f71dc34\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/exportSqliteDb.js\":\"57028444d3218add\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/fileSystemAccess.js\":\"6d92ac274566f5a2\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/flipSlide.js\":\"73cf1091d8f2e3a8\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/fnv1a.js\":\"6af2815ca37d19c4\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/formatBytes.js\":\"f4f3dd2298c249bb\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/fuzzyRank.js\":\"f2544d9af9c1351e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/idbKeyedStore.js\":\"6e86103b936d12a0\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/idleCallbackPolyfill.js\":\"d587a741a364d9c3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/keyboardAwareScroll.js\":\"4d40786c514bce04\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/keyboardViewport.js\":\"3589074a93fe6a12\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/lastWorkspace.js\":\"a0ebd50291246e18\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/layoutColumns.js\":\"40b1a3d0251c9504\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/layoutSessionDom.js\":\"d86d1172f0caf8e3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/layoutSessionId.js\":\"b2727d588329bac9\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/linkClickGestures.js\":\"0dd372d30b7c3f89\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/linkTargetAutocomplete.js\":\"6a3c2ea39b4eb3ff\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/localDbCorruption.js\":\"25dc1454e6bf2c2c\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/localDbRecovery.js\":\"f9a48bf87a619042\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/markdownParser.js\":\"92c46433405ae516\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/memoize.js\":\"6e5c7fbd5789acdb\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/nameFieldCommit.js\":\"f552320494eea64a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/nameList.js\":\"91b50c4b8a572e4d\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/navigation.js\":\"7a864c8ed6af931e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/omnilinerNamespace.js\":\"bc41d8f3749caaf8\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/opfsPageScan.js\":\"9cb5d6f1d8ae40fa\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelClearance.js\":\"b51c68ec6584853e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelHistory.js\":\"a0b937bafa7d640b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelLanes.js\":\"70b9c7e5a7bafc3a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelLayoutProjection.js\":\"2d8686f0b6fdb723\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelScrollAnchor.js\":\"9599b4483816aec6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelUrlFlags.js\":\"7d50ba85c59afe65\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/platform.js\":\"7f6b8ee515d3be85\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/pluralize.js\":\"f453c5a120224d20\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/propertyCreation.js\":\"d5c9d4dbf1071cbd\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/propertyNavigation.js\":\"76c71c6fed201b24\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/propertyValueContext.js\":\"f03ef395038d04a0\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/react.js\":\"f87ef47ace57c0ef\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/relativeDate.js\":\"2a66bc5830dfeaac\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/relativeTime.js\":\"7abfd0dd0da2de3a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/renderScope.js\":\"e8f48cc3faebdc18\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/resolvedThenable.js\":\"1747e22203bc026f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/routing.js\":\"cf0fa4efee5323c6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/safeMode.js\":\"bfdd41c8e1ad4d39\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/scheduleIdle.js\":\"a348638743346381\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/screenWakeLock.js\":\"5d5e85163a1a248f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/selection.js\":\"4640760be36e890e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/softKeyboardGrab.js\":\"9715b32a249abae7\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/startupTimeline.js\":\"07783b70ad5f0afe\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/state.js\":\"65240772b2c763ba\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/string.js\":\"b8549a3890598f42\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/surfaceZoom.js\":\"7a4d19898e99778c\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/time.js\":\"a3f0e57b5c66cc0a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/toast.js\":\"bc5cce7efb542b40\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/toggleStore.js\":\"f3b65d57238f8687\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/untilStopped.js\":\"a5671e75710621e8\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/userActivity.js\":\"ba78b57c82de8693\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/viewTransition.js\":\"8b271b163e2a92c5\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/viewport.js\":\"88d7ad3a4e186838\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/webLock.js\":\"b3edc13916930ecc\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/workspaceRecovery.js\":\"8121a5931c29c90b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/workspaceSnapshotStore.js\":\"0eeb0b56980675b8\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-compiler-runtime.js\":\"b487a06a4c489838\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-client.js\":\"7af98262da610b42\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-server-edge.js\":\"c78761456f45817b\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-server.js\":\"84eb6880c19e8c00\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-static-edge.js\":\"6e695664f03691f9\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-static.js\":\"1407b5f55641db55\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-test-utils.js\":\"c29724d3ca0c26ed\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom.js\":\"c22a144bf10cd233\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-jsx-runtime.js\":\"442e49abbb3ae083\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react.js\":\"09238ab92b88fa10\",\"/knowledge-medium/pr-preview/pr-1637/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1637/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1637/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
