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
		buildId: "4c145b493157-62fa9193",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1637/\":\"f8565cfabb08342c\",\"/knowledge-medium/pr-preview/pr-1637/index.html\":\"f8565cfabb08342c\",\"/knowledge-medium/pr-preview/pr-1637/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1637/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1637/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1637/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1637/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1637/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1637/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1637/assets/FacadeVFS-B_qnUcOE.js\":\"f1b6d9d1d6d7c1a7\",\"/knowledge-medium/pr-preview/pr-1637/assets/OPFSCoopSyncVFS-BT4ng4T5.js\":\"c964eeaad7cfdb77\",\"/knowledge-medium/pr-preview/pr-1637/assets/OPFSWriteAheadVFS-C2Q55B6G.js\":\"f3b1f4f323c03caa\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-CNa_p0X5.js\":\"24b3728cad48494f\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1637/assets/wa-sqlite-async-DZj_AzVv.js\":\"37d412d275b59255\",\"/knowledge-medium/pr-preview/pr-1637/assets/worker-D1NrMkuh.js\":\"dba52d641201203b\",\"/knowledge-medium/pr-preview/pr-1637/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1637/chunks/app-BEOC47df.js\":\"e0c0c05cd9639fa0\",\"/knowledge-medium/pr-preview/pr-1637/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1637/index.js\":\"ca334c59aa538bbc\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1637/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1637/assets/AccessHandlePoolVFS-DDnfe3Rv.js\":\"d2867ff74e200cc3\",\"/knowledge-medium/pr-preview/pr-1637/assets/IDBBatchAtomicVFS-rqrFMwYW.js\":\"5ca86ca5197ee3cb\",\"/knowledge-medium/pr-preview/pr-1637/assets/MemoryVFS-DMv1zBJj.js\":\"f06e88d41add5ce0\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-DOtNhxiJ.js\":\"8904d64f85c5992d\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-async-BGtRH3uI.js\":\"dfcb5222e086e271\",\"/knowledge-medium/pr-preview/pr-1637/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1637/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1637/chunks/AccessHandlePoolVFS-B-voHa-Z.js\":\"cd270f2772ed63ea\",\"/knowledge-medium/pr-preview/pr-1637/chunks/FacadeVFS-DgIC8cIr.js\":\"687500ba3a60817c\",\"/knowledge-medium/pr-preview/pr-1637/chunks/IDBBatchAtomicVFS-BkqBTeSj.js\":\"1b55eabb1b050714\",\"/knowledge-medium/pr-preview/pr-1637/chunks/MemoryVFS-BbyUtlJA.js\":\"a52a72e73482d51e\",\"/knowledge-medium/pr-preview/pr-1637/chunks/OPFSCoopSyncVFS-BjkSK9Zm.js\":\"15e163ea36bbfc42\",\"/knowledge-medium/pr-preview/pr-1637/chunks/OPFSWriteAheadVFS-CA6RUvbm.js\":\"8c55c31652cc4506\",\"/knowledge-medium/pr-preview/pr-1637/chunks/Preview-CNf_1LcM.js\":\"4149d60390471579\",\"/knowledge-medium/pr-preview/pr-1637/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1637/chunks/card-B2B_komE.js\":\"23ed411f480d2664\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1637/chunks/dist-Cob1E1zd.js\":\"f1db099e0ac37b77\",\"/knowledge-medium/pr-preview/pr-1637/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1637/chunks/mc-wa-sqlite-DbADxdCx.js\":\"92670b444431ce45\",\"/knowledge-medium/pr-preview/pr-1637/chunks/mc-wa-sqlite-async-DyuuUjfp.js\":\"733a1262543bdd8b\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-BhbJYyDq.js\":\"5062d6f8f2255765\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-CHkDvu8X.js\":\"9b9f263e86a9941f\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-CdeZHjoC.js\":\"91736bced24a15b0\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-CmvNVLKW.js\":\"b20e522d5c8edbd2\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-DJt8OKjg.js\":\"24b35933b8b645ee\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-Dqv2DgM7.js\":\"44fdb605612f485e\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-DriKUJFr.js\":\"e374e82d3fd32056\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-ZM6_iHVT.js\":\"bdba9f53106573ed\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-dom-server-legacy.browser.production-BNEQKXk_.js\":\"6dd697c87f18276e\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-dom-server.browser.production-CR2VAE1r.js\":\"7d47a1ec2dbfef08\",\"/knowledge-medium/pr-preview/pr-1637/chunks/react-dom-server.edge.production-CYwaYHCr.js\":\"134e4edae7902345\",\"/knowledge-medium/pr-preview/pr-1637/chunks/server.browser-CFX1sPLs.js\":\"e2b24730acdae8a1\",\"/knowledge-medium/pr-preview/pr-1637/chunks/textarea-DzzyFPla.js\":\"4adac7033ccb7876\",\"/knowledge-medium/pr-preview/pr-1637/chunks/ui-CvKN2lqb.js\":\"50c185241e67b3a5\",\"/knowledge-medium/pr-preview/pr-1637/chunks/wa-sqlite-CGO14fN3.js\":\"9f29d1c4857d7c94\",\"/knowledge-medium/pr-preview/pr-1637/chunks/wa-sqlite-async-BlZPKOfx.js\":\"54edca9ee3656b01\",\"/knowledge-medium/pr-preview/pr-1637/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1637/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1637/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1637/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1637/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1637/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1637/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1637/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1637/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1637/src/App.js\":\"69f05b61a463d8bd\",\"/knowledge-medium/pr-preview/pr-1637/src/appUpdate.js\":\"a473b776202d579e\",\"/knowledge-medium/pr-preview/pr-1637/src/appVersion.js\":\"647e91740915af53\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/initialLayout.js\":\"b53026d182e374fb\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/openWorkspaceData.js\":\"c1f5a324db07ed5f\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/resolveWorkspace.js\":\"2039bdfd3e1d31a6\",\"/knowledge-medium/pr-preview/pr-1637/src/bootstrap/workspaceBootstrap.js\":\"7964fcb96e3bf382\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockComponent.js\":\"67d4c53fe08afcd6\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockCrumbs.js\":\"dbbe2071d43cf85f\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockEditor.js\":\"68d0a7ac12aef808\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockLoadingPlaceholder.js\":\"aec09e759a4a19e8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockProperties.js\":\"076cc1b62d05d7fb\",\"/knowledge-medium/pr-preview/pr-1637/src/components/BlockSearchPicker.js\":\"60b73360f4cd0f2f\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ConfirmBulkDeleteDialog.js\":\"3a35224490a203b3\",\"/knowledge-medium/pr-preview/pr-1637/src/components/DividerHandle.js\":\"2b1cc7cec3255474\",\"/knowledge-medium/pr-preview/pr-1637/src/components/DraftEditor.js\":\"f0b5b3e74615cc74\",\"/knowledge-medium/pr-preview/pr-1637/src/components/GutterPill.js\":\"d1c750554727a9ce\",\"/knowledge-medium/pr-preview/pr-1637/src/components/Header.js\":\"81f217f6022db164\",\"/knowledge-medium/pr-preview/pr-1637/src/components/LazyBlockComponent.js\":\"75aa7373c38f306f\",\"/knowledge-medium/pr-preview/pr-1637/src/components/Login.js\":\"077c9a5d44e65a04\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ZoomableSurface.js\":\"694ff1da0c44b9aa\",\"/knowledge-medium/pr-preview/pr-1637/src/components/editModeKeepalive.js\":\"8e4aba5229d79e04\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyDisplay/PropertyDisplayScope.js\":\"294de7c5768fd129\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"114bed1290a7d4c8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/RefPropertyEditor.js\":\"1e1bc532e2b0b7de\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/RefTargetTypePicker.js\":\"e87686a667204850\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/SelectPropertyEditor.js\":\"3bccba6242042243\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/TypesPropertyEditor.js\":\"91ade33322a55f68\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/defaults.js\":\"f76de5f64c011a67\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/kernelValuePresets.js\":\"07c315f6445c0a8d\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/selectablePresets.js\":\"b9443502d211e84e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyEditors/typesPropertyUi.js\":\"c3ce404f30cf1210\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/AddPropertyForm.js\":\"c46cdf243297e2d5\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/PropertyPicker.js\":\"a1670bd24fd7ce18\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/PropertyRow.js\":\"2fa4c260e90e2ac4\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/Rows.js\":\"56730104f358f69b\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/actions.js\":\"e5484ce8536cdb68\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/declarationOnly.js\":\"1cc48033374cad8c\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/layout.js\":\"f2a62cf8d9dd1589\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/model.js\":\"facc1462b8521578\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/shapeUi.js\":\"ead961b824aba4f1\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/shapes.js\":\"3471aa249afb3ddc\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/usePropertyEditingActivation.js\":\"698fdc7fb71f7747\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanel/visibility.js\":\"4e9dee422461c5f8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/propertyPanelSections.js\":\"c4916bf7e6a7237a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/BlockEmbed.js\":\"c4d66a6d80fb05b2\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/BlockLink.js\":\"533403a225395d24\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/BlockRef.js\":\"200af6b9547703c0\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/ReferenceLink.js\":\"b13c87bf111e3208\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/cycleGuard.js\":\"6b6aa46075cb9c56\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/cycleGuardContext.js\":\"d0ce2cd13dc051fa\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/linkInteraction.js\":\"5ed28737e1256aa4\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/referenceLayout.js\":\"524f7926b3a8b652\",\"/knowledge-medium/pr-preview/pr-1637/src/components/references/useBlockRefAncestors.js\":\"042da15f229f3e58\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BlockGutter.js\":\"7d3ac62b52c22dc2\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BlockInfoDialog.js\":\"50f52466d522bdd7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BlockTypeBlockRenderer.js\":\"a9129a87d0da336f\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/BulletHoverCard.js\":\"4c4fab265968a8e6\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/CodeMirrorContentRenderer.js\":\"10687e13d162250e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b273d8359d1c0b7a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/ColumnResizeHandles.js\":\"0c780534dc690c02\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"554d6bb9eaae6fd2\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/DefaultBlockRenderer.js\":\"ee04e54b2aced24b\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/LayoutRenderer.js\":\"fe603818eed78ba4\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/MarkdownContentRenderer.js\":\"e5c9a2c6d390a103\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/MissingDataRenderer.js\":\"81f64426546c60dc\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/PanelRenderer.js\":\"494731d69da7efc8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a97237d71de78046\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/TopLevelRenderer.js\":\"0c4e51085abf49a8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/blockGutterMode.js\":\"143c2205816cd913\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/blockTitleText.js\":\"82f7849fe5d45b36\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/fieldCreationKeydown.js\":\"0feee4c5297117cc\",\"/knowledge-medium/pr-preview/pr-1637/src/components/renderer/layoutRootContext.js\":\"e0dcb724de1b004a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/typeChip/TypeChip.js\":\"62b72501589991c9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/typeChip/chipStyle.js\":\"98f35783a2a07e08\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/anchored-floating.js\":\"d087c656bde71c18\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/button.js\":\"aab737c8e1d46134\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/card.js\":\"1ecda5ced10a0212\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/checkbox.js\":\"09b64974d0903b57\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/collapsible.js\":\"9ad584dadfb732ff\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/command.js\":\"99043204d1ff0d18\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/context-menu.js\":\"7100e361698f927a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/dialog.js\":\"17a2533f9b673ab3\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/dropdown-menu.js\":\"f2227bd6a76ab359\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/floating-listbox.js\":\"e1528888dbbe90c9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/index.js\":\"42469bdaf819aa04\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/input.js\":\"e34e43a7fbd3369c\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/kbd.js\":\"2ae165e2c696a537\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/label.js\":\"566730da3c8d1c76\",\"/knowledge-medium/pr-preview/pr-1637/src/components/ui/textarea.js\":\"cda83898ea3c47cb\",\"/knowledge-medium/pr-preview/pr-1637/src/components/useEditModeYieldKeepalive.js\":\"301864a722cb1390\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/BootFallback.js\":\"a32068b048593f37\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/FocusedRowLazyMount.js\":\"c39940f20c294f28\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/LazyViewportMount.js\":\"e194404066e94516\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/LocalDbCorruptionFallback.js\":\"0c546a2e497ad42a\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/error.js\":\"df03493647036fa9\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/lazyMountRegistry.js\":\"a839df39fc29ad4b\",\"/knowledge-medium/pr-preview/pr-1637/src/components/util/suspense.js\":\"7fced56c3ee72222\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/CreateWorkspaceDialog.js\":\"334006f4c1b66d42\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/PendingInvitations.js\":\"9f83630943192734\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/SyncProgress.js\":\"55bbdf3c3a4b1774\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/UnlockProgress.js\":\"cd77b0d6f27d3c35\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceKeyGate.js\":\"65521e7c2b5f1858\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceSettingsDialog.js\":\"acef1f9efea7e8be\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceSwitcher.js\":\"134b232b543fceac\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/WorkspaceSyncGate.js\":\"e2e88960a1934b33\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/ConversionFlow.js\":\"af693a1c5505162e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/ConversionFlowHost.js\":\"901460f9943a8da6\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/EncryptionSection.js\":\"8791dfb4147ed707\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/attachmentPrompts.js\":\"ed52a09c269eed9e\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f9ac8d6e27328aa1\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/conversionFlowDeps.js\":\"79eda04507144a07\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/conversionFlowStore.js\":\"c5622c048c959252\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/flowUi.js\":\"0b9dcb35cfb9d8c3\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/conversion/useConversionRun.js\":\"3b5a7d17cffa36cc\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/keyUi.js\":\"22c7a2546b936ed7\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/useCloseOnKeyLoss.js\":\"0e2a6a92b29a87f8\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/useCloseOnServerE2ee.js\":\"00bc93e7e906b51b\",\"/knowledge-medium/pr-preview/pr-1637/src/components/workspace/workspaceUnlocked.js\":\"d4b8b9bdbcfb2d4a\",\"/knowledge-medium/pr-preview/pr-1637/src/context/backgroundSubtree.js\":\"1c90ddaa7687fa96\",\"/knowledge-medium/pr-preview/pr-1637/src/context/block.js\":\"b5c88df8a9d3e501\",\"/knowledge-medium/pr-preview/pr-1637/src/context/layoutWsContext.js\":\"f51fd7a4751f5ced\",\"/knowledge-medium/pr-preview/pr-1637/src/context/propertyDisplay.js\":\"7c4c02ae2b8dae8c\",\"/knowledge-medium/pr-preview/pr-1637/src/context/repo.js\":\"e7ffece507505478\",\"/knowledge-medium/pr-preview/pr-1637/src/data/aliasClaim.js\":\"494bc60d58b1a343\",\"/knowledge-medium/pr-preview/pr-1637/src/data/aliasSeatNamespace.js\":\"cc1be6cb3d1ec10a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/blockData.js\":\"b206d2eeda333f0f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/blockType.js\":\"48ff1fa261a7d7f3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/changeScope.js\":\"e4ef4a74dfcee6d4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/codecs.js\":\"c298b0055398f708\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/derivedData.js\":\"f16e0f64b1a2929d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/errors.js\":\"a4ceea99404dbed9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/events.js\":\"892953f78648da4b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/handle.js\":\"0b4798dfd3ee80ae\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/index.js\":\"3b3f27e9c4fa64c6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/mutator.js\":\"7a1a84e712688929\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/processor.js\":\"02a7747d79b4f2ed\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/propertySchema.js\":\"f30f5a0bdae37858\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/query.js\":\"c4b1fac1a661bea7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/sameTxProcessor.js\":\"ef0b9e7d315e263d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/schema.js\":\"0b4798dfd3ee80ae\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/tx.js\":\"0b4798dfd3ee80ae\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/typedBlockQuery.js\":\"61c00a10019063cc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/user.js\":\"5e47e3c2291b7bd2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/valuePresetCore.js\":\"f77849d777cacf0b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/api/valuePresets.js\":\"73eb4311f2968295\",\"/knowledge-medium/pr-preview/pr-1637/src/data/attachmentCleanerIOVerb.js\":\"25fed17fdec8276c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/block.js\":\"170704fc3ebe51f6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockCache.js\":\"d1a9512223658df3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockId.js\":\"f6008b562cb3d37f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockLiveness.js\":\"9fdd00f1ac48d7bc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockMerge.js\":\"34867bba46f90436\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockSchema.js\":\"8cc32527a8da68f1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockTypeLookup.js\":\"6ab67af92e1323c3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/blockTypes.js\":\"35e0c8b725f0fb51\",\"/knowledge-medium/pr-preview/pr-1637/src/data/childrenView.js\":\"036bcc7cde68faf5\",\"/knowledge-medium/pr-preview/pr-1637/src/data/clientContext.js\":\"65aaaacd75c09b71\",\"/knowledge-medium/pr-preview/pr-1637/src/data/dbFileSiblings.js\":\"5f17e3772d00522b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/definitionSeeds.js\":\"2e6a068ad66a74e8\",\"/knowledge-medium/pr-preview/pr-1637/src/data/derivedIds.js\":\"bfe19f88bfc86edd\",\"/knowledge-medium/pr-preview/pr-1637/src/data/drawnSubtree.js\":\"80bdde24dff820dc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/facetBridge.js\":\"dc5533f859756cbb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/facets.js\":\"6a338aed13878664\",\"/knowledge-medium/pr-preview/pr-1637/src/data/globalState.js\":\"0e8f5d58ebbc092a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/aliasClaimRederiveProcessor.js\":\"ea1a96f13bc3fa08\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/ancestorBatch.js\":\"c6a78e88745e4270\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/blockTypeTypeifyProcessor.js\":\"8343474644d9d8d5\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/clientSchema.js\":\"9573d8e3244a2588\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/commitPipeline.js\":\"a053f3fe8e64a1df\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/devAssertions.js\":\"4e24bf274e58ea71\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/firstSync.js\":\"816e50f0ee346536\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/freshInitialLoad.js\":\"2c9396b1b9f60026\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/graphBackfillClaim.js\":\"5743b7199064ef0d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/handleStore.js\":\"aa1dbf14faf77e8f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/idleMarkerJobs.js\":\"75a76f1d41b30aa7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/initialDownload.js\":\"a14c5abf00d4d515\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/initializeClientDatabase.js\":\"d0c21dc4260f944e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/jsonCanonical.js\":\"5c31312ef2886f84\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/kernelInvalidation.js\":\"40e9842d35001e4d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/kernelProcessors.js\":\"4112f518d5156938\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/kernelQueries.js\":\"ed0e77812b1135f9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/mergeTypeMembershipProcessor.js\":\"60d39cee27beefab\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/normalizeReferencesProcessor.js\":\"25ba8587ef23284e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/poolInstrumentation.js\":\"0a5f194d60f7d829\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/processorRunner.js\":\"a6178b1162f25797\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyCellBackfill.js\":\"801e4b54b6ffd6c3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyChildMint.js\":\"cd55c7ec0481ae7f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyChildrenProcessor.js\":\"8903678557421dc1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b2582c0f7e1eb5c1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyDefinitionSynthesis.js\":\"46915b28c28c2323\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyKeyScan.js\":\"8cf7cfd3a0c839c9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertySchemaResolution.js\":\"68ceb6692fdd443b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/propertyValueEdits.js\":\"7df5d8bf54fd0b77\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/raiseProtocol.js\":\"7975cbf4288ecadf\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/readBatch.js\":\"e83e0eea409c8238\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/refProjection.js\":\"ecd2aac07afabaf4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/referenceTargetLookups.js\":\"e69a1b25a49299cf\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/referenceTargetProcessor.js\":\"562d07831991b650\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/replayMerge.js\":\"f004177f36a5170d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/sqlBinds.js\":\"35f0ac4fc3008208\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fab949a01fc09141\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/arrivalProcessors.js\":\"ca793381aa63a205\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/invalidate.js\":\"ad57b8b8ab32f93d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/materialize.js\":\"0f9603bf37d9bfe7\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/observer.js\":\"13cb23e0a6a8ed83\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/syncObserver/reconcile.js\":\"63798428c01095e1\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/timingMetrics.js\":\"04625eb6c5997e25\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/treeQueries.js\":\"5cf596b263e329fa\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/txEngine.js\":\"54114f23ae7a1cd2\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/txSnapshots.js\":\"543b73ab35b3daff\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/typedBlockQuery.js\":\"f12943bee8c1186a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/internals/undoManager.js\":\"9058c7bcb9f93324\",\"/knowledge-medium/pr-preview/pr-1637/src/data/invalidation.js\":\"73b9d57a8874038f\",\"/knowledge-medium/pr-preview/pr-1637/src/data/kernelDataExtension.js\":\"9a244a361a6c5a61\",\"/knowledge-medium/pr-preview/pr-1637/src/data/kernelPage.js\":\"7273ba37cc09d4f6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/kernelValuePresetCores.js\":\"18884151b7b289ef\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localDbCorruptionSignal.js\":\"3186156039292dde\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localDbStorage.js\":\"e597b9c3e3455945\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localDbVfs.js\":\"0796177b52a4fc18\",\"/knowledge-medium/pr-preview/pr-1637/src/data/localSchema.js\":\"6c4d31787dfd1f2c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/maintenance.js\":\"63c4bac839143f9b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/mergeProperties.js\":\"6178ca659a73f95d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/metricsConsoleHook.js\":\"3887ecf84ae5b6cc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/migrationsPage.js\":\"40e8f3227e0b5463\",\"/knowledge-medium/pr-preview/pr-1637/src/data/mutators.js\":\"00b2a2698e690dd3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/orderKey.js\":\"9a6b7f134de74aef\",\"/knowledge-medium/pr-preview/pr-1637/src/data/orderKeyPlacement.js\":\"59594297431dedcc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/outlineSurface.js\":\"3729f7beff867e9b\",\"/knowledge-medium/pr-preview/pr-1637/src/data/pendingEditorContent.js\":\"ac7041e9d8dc0c78\",\"/knowledge-medium/pr-preview/pr-1637/src/data/pendingUploadsSql.js\":\"a70156e937523d31\",\"/knowledge-medium/pr-preview/pr-1637/src/data/pluginStateExtensions.js\":\"ae3356af3d444098\",\"/knowledge-medium/pr-preview/pr-1637/src/data/powerSyncLogger.js\":\"f6e6759695b687d9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/projectorRuntime.js\":\"f8c5058793d7235d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/properties.js\":\"862f5366fb3a65e9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertiesPage.js\":\"2d2f844c0ad26aa6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyChildren.js\":\"671f42a87cba6f0c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDefinitionFanout.js\":\"c62de6b5e6c14139\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDefinitionMetadata.js\":\"29043556b4796949\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDefinitionRegistry.js\":\"f7cac998f586bfee\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyDisplayMode.js\":\"325caefc3a543332\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertyRowCreation.js\":\"938031f44a8caf37\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertySchemaCreation.js\":\"e66ce272423c4151\",\"/knowledge-medium/pr-preview/pr-1637/src/data/propertySeeds.js\":\"23a4d2696741846c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/recentsPage.js\":\"6adfa05721324e97\",\"/knowledge-medium/pr-preview/pr-1637/src/data/referenceBlock.js\":\"f8573002c862beb9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/rejectedUploads.js\":\"a042e8d5591490d9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/releasePowerSyncConnection.js\":\"2c7d4d4953201435\",\"/knowledge-medium/pr-preview/pr-1637/src/data/repo.js\":\"5b3631ba23367bd0\",\"/knowledge-medium/pr-preview/pr-1637/src/data/repoProvider.js\":\"b907758b786ab7cc\",\"/knowledge-medium/pr-preview/pr-1637/src/data/rowProperty.js\":\"1e18af429168919d\",\"/knowledge-medium/pr-preview/pr-1637/src/data/searchFilter.js\":\"d89734fcf00aaf50\",\"/knowledge-medium/pr-preview/pr-1637/src/data/seedIdentityLedger.js\":\"3a4abd467492858e\",\"/knowledge-medium/pr-preview/pr-1637/src/data/stateBlocks.js\":\"f1c7afa2e0429efb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/structuralEditPolicy.js\":\"2566402cc837e517\",\"/knowledge-medium/pr-preview/pr-1637/src/data/subtreeDelete.js\":\"4e27681082eb041c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/syncStreamLock.js\":\"719757fabdf3ba63\",\"/knowledge-medium/pr-preview/pr-1637/src/data/syncedTableSqlRecognizer.js\":\"7fd1284fbc1e4606\",\"/knowledge-medium/pr-preview/pr-1637/src/data/syncedTableWriteGuard.js\":\"2db8a37a1f5fdcb6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/targets.js\":\"a19740db6ec5173a\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeColors.js\":\"41d75cc61be25b07\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeDefinitionMetadata.js\":\"605aabda7bfa25b4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeDefinitionRegistry.js\":\"ba5f5054c4d884f9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeExtraction.js\":\"65d554ea5c1d85e5\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeInitialValues.js\":\"006e4d2900f9d398\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typePropertyGroups.js\":\"a5b848d5c0830582\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeSeeds.js\":\"3f634e618dcdf9ed\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typeTagger.js\":\"e21cf65b47cbe6ac\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typedRecords.js\":\"e1b955cbd77adbf4\",\"/knowledge-medium/pr-preview/pr-1637/src/data/typesPage.js\":\"a19f6b23371ed533\",\"/knowledge-medium/pr-preview/pr-1637/src/data/userPrefs.js\":\"de66ab43b22df6eb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/userSchemasService.js\":\"bfa06bbaa7e7d804\",\"/knowledge-medium/pr-preview/pr-1637/src/data/userTypesService.js\":\"191c5380fa7e76c9\",\"/knowledge-medium/pr-preview/pr-1637/src/data/valuePresetRegistry.js\":\"9318221bea5a2bb3\",\"/knowledge-medium/pr-preview/pr-1637/src/data/visibleChildren.js\":\"ce23a40290f10efd\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceConversion.js\":\"06930af4ec68053c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceFirstSync.js\":\"52e03631e3a9623c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceIdNamespace.js\":\"b4311c153894faeb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaceSchema.js\":\"0768847ea69713fb\",\"/knowledge-medium/pr-preview/pr-1637/src/data/workspaces.js\":\"2989628f91463dd6\",\"/knowledge-medium/pr-preview/pr-1637/src/data/writeAheadLog.js\":\"90f1ac333608b69c\",\"/knowledge-medium/pr-preview/pr-1637/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/BlockPasteShellDecorator.js\":\"0154597f5cb0247c\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/atTrigger.js\":\"8524d33278452a27\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/autocomplete.js\":\"8cdbea4f8a92b151\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/codeMirrorExtensions.js\":\"f7735671dcc3d9b3\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/contentFlush.js\":\"68909576b21422e5\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/defaultInteractions.js\":\"7c656862b978eb79\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/editSettleSignal.js\":\"30c1deed355123e1\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/insertImage.js\":\"a6e75886bc6e8da7\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/referenceCompletionRange.js\":\"d9694af05c71bd9b\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/referenceTargetTypes.js\":\"c2ce9378c7f1a316\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/syntaxContext.js\":\"b3fe87ed59ab88bf\",\"/knowledge-medium/pr-preview/pr-1637/src/editor/triggerMatch.js\":\"6e62fbed5438c723\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/AppRuntimeProvider.js\":\"541d9e014dab3e4e\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/BlockFocusShellDecorator.js\":\"2305330d849e3c96\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/ExtensionRenderBoundary.js\":\"57a4ca1d9edd83a0\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/PanelContentRecovery.js\":\"95a2bcbe039a7cbe\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/apiCatalog.js\":\"f734b870885dc2dd\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/approveExtensionHere.js\":\"01070e4c53e8b69f\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/armedCutAppMount.js\":\"0e28cb3214bb1692\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/batchableKeyedStore.js\":\"1ad813e842551c08\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/blockInteraction.js\":\"c766afb36908a5db\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/blockSelectionAction.js\":\"e8382ac2af3cb34b\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/compileExtensionModule.js\":\"165b60d2bdf3d92a\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/compiledModuleCache.js\":\"05fd72ccb48d2379\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/continuousGestures.js\":\"5d2d8e5dafa4e5ed\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/core.js\":\"8e1464a9bbe07743\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/defaultRenderers.js\":\"6f5b46e76c992277\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/definitionFanoutAppMount.js\":\"e6f0d3445c01040c\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/dialogAppMount.js\":\"e90d8b760c0f4195\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/dynamicExtensionSeeds.js\":\"74b3e9bff32b5cef\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/dynamicExtensions.js\":\"59ef6369b1eb5af7\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/exampleExtensions.js\":\"538aea62ece825a3\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionApprovalStatus.js\":\"ea075e333c878b4d\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionLoadErrorToast.js\":\"698ac2e76b4586cf\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionLoadErrors.js\":\"b539a25694f5afad\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionLookup.js\":\"0b371891eeb8abe4\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionToggles.js\":\"c0d7cc1ea4f3c3c2\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/extensionUtilitiesCss.js\":\"8d248b2318acddfd\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/kernelPageDeletionGuard.js\":\"99869440fd836a6b\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/liveRuntime.js\":\"01a562667cb73acf\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/openExtensionsSettings.js\":\"5a4151e097b7a3cd\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/overridesCache.js\":\"05b081bea738a37a\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/pluginIds.js\":\"7fcda4c27af36169\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/processorRejectionToast.js\":\"93c96cb436fc5573\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/runtimeActions.js\":\"4cbb723dd99e3679\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/runtimeContext.js\":\"c947217b862728b9\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/staticAppExtensions.js\":\"0db5b1171340322f\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/staticDataExtensions.js\":\"11f3308d4b530402\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/toastAppMount.js\":\"2ae8b6678e029c72\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/useOverrides.js\":\"161ccd451f7d61d1\",\"/knowledge-medium/pr-preview/pr-1637/src/extensions/useShortcutSurfaceActivations.js\":\"c67657582ca05dc6\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/discoverToggleTree.js\":\"693caec8b92e8057\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/facet.js\":\"9c8987ea1fd70a4c\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/resolveAppRuntime.js\":\"921d381e4a2cedef\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/runtimeEvents.js\":\"307dad77d5525640\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/togglable.js\":\"a2572ec55561ef62\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/variantFacet.js\":\"1fa325c0ef8bebd6\",\"/knowledge-medium/pr-preview/pr-1637/src/facets/verbFacet.js\":\"50cc1f5cc73aeb00\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/block.js\":\"ad1c3dc7f8f7c2f3\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/focusedChild.js\":\"6114e9a3ac4c3c1d\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/propertySchemas.js\":\"4a16900031600e71\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/typeRegistry.js\":\"28c82a7a11cfe01a\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useAncestorCrumbs.js\":\"25ca7911c7f6e1cd\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useAutocompleteListbox.js\":\"c3da731ce5b34b76\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useDebouncedSearch.js\":\"075f140f073240d8\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useDebouncedValue.js\":\"e99662fb4ea8706c\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useIsFocalRender.js\":\"86d76e94c025d8dc\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useIsReadOnly.js\":\"08d0aac101b78cc2\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useMaterializeBacklog.js\":\"1c512d32af683a36\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useMinuteClock.js\":\"0e617e8bd273f358\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/usePanelLayoutProjection.js\":\"34acfeb51536bb2a\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/usePendingInvitations.js\":\"af88bfbf241113b1\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useRendererRegistry.js\":\"c418a0f1fe034d8c\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useRetainedFieldRows.js\":\"0491d0de348d3df3\",\"/knowledge-medium/pr-preview/pr-1637/src/hooks/useWorkspaces.js\":\"069204a617440768\",\"/knowledge-medium/pr-preview/pr-1637/src/lib/utils.js\":\"9a796efbf2436821\",\"/knowledge-medium/pr-preview/pr-1637/src/main.js\":\"55f6a7c82d5bae4f\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/MarkdownImage.js\":\"f351f122565fa1c3\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/blockSeparators.js\":\"8d62d943939db69d\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/context.js\":\"08b9bfbb3d67a0ea\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/defaultMarkdownExtension.js\":\"70768f5d90531987\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/extensions.js\":\"5079507674417c82\",\"/knowledge-medium/pr-preview/pr-1637/src/markdown/renderMarkdownHtml.js\":\"5652cae4a23c5abf\",\"/knowledge-medium/pr-preview/pr-1637/src/minimal-editor.js\":\"51567778ac9f4f95\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/armedCut.js\":\"e4db205b9a27cb37\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/captureMediaVerb.js\":\"3b202b07108200fe\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/clipboard.js\":\"ab545374b66fa29d\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/decision.js\":\"a59091fbb56befcc\",\"/knowledge-medium/pr-preview/pr-1637/src/paste/operations.js\":\"d7b44eb8a6144d6c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/account-header/AccountHeaderItem.js\":\"f385cb52464b7b88\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/account-header/index.js\":\"d0905d209bc9561b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9a038b7ee433dd49\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/askAgent.js\":\"8fb19007a1c3e51d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/askedStore.js\":\"26ede4212a4a47ea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7415b99f03e2a260\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/chipState.js\":\"e805352a5b12df78\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/dataExtension.js\":\"244a08f3fd7656e4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/index.js\":\"7b0735939cef60cb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a1d68a1e8fa4bcfe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-dispatch-companion/schema.js\":\"b456df60d9296ba5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e950603b426dde8a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8cdc69f4b6389b52\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/addMedia.js\":\"53a62606e73175b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6c144c1c408c99aa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/block.js\":\"5499b8e4e364ca07\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/context.js\":\"d4b97ad5b7dd7466\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/displayIds.js\":\"391ba0f4d19b2eb1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/index.js\":\"6b53423adac656fb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/outline.js\":\"036e196f6b3d8618\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/properties.js\":\"7350626a141c9ea8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/refs.js\":\"3513c516164c017e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e52b6ea6c97fac91\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/search.js\":\"6890af529d37aa74\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/shared.js\":\"83b4078d47a743c5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"30caefd9fdf49b6f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentViews/text.js\":\"ba1ace30a959602b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/agentWrites.js\":\"2cd786634280c3c3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/authoringCatalog.js\":\"2715188a75c7d7d0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/blockRefTargets.js\":\"03c48fe98ed8eb74\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/bridge.js\":\"bda9a6d79de0915b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/bridgeLoop.js\":\"e40e49398b151121\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/changeHistory.js\":\"6aa70a7544a620de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/commands.js\":\"043367709c971480\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/commentsCommands.js\":\"c7cbcf75285623a6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/dataExtension.js\":\"d0242d1604c5c492\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/dataModelGuide.js\":\"e60ba4a5ce98dc74\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/describeRuntime.js\":\"ad6f565d7277fbc5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/extensionLint.js\":\"f457a1ebde11d0a5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/grainAudit.js\":\"dc48bf387f0860c5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/healthCommand.js\":\"3427a893442f3a8c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/index.js\":\"73ee1045a40defc8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/presetIdentity.js\":\"790d6ce8ce44c54a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c47205a33773ded1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/readMedia.js\":\"b782b9155038e8c6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/schema.js\":\"65b7d1bb449ceb60\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/serialization.js\":\"08cc4d3108c24a70\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/targets.js\":\"ca9fbc25a5fe8250\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/tokens.js\":\"efc8068754afa3ad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/watchEvents.js\":\"b12e0e09e656c718\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/workspaceGuard.js\":\"8adfeb2432b05ad2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/agent-runtime/writeCommands.js\":\"58a0685ccbb11a06\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/AliasCollisionToast.js\":\"e46b224e99a24143\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/DuplicateNameBanner.js\":\"c03ce62855b11857\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/collisionMerge.js\":\"cb327da6e32e37d6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/dataExtension.js\":\"a0a471fe42043f9f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/index.js\":\"11e3eaa0517a5c06\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/mergeCollisionAction.js\":\"71c5429387feb7e5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/pageStyling.js\":\"e64f51848d37bce0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/rejectionToast.js\":\"bcb68bac8355b2f2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/alias/syncProcessor.js\":\"0ad8c28a27e98388\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/actions.js\":\"4834e0e1a351a6bf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/addComment.js\":\"067b277f3e98307f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/anchor.js\":\"6545ed3e2ee9a32a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/anchorState.js\":\"10e0f41abf3bbd2e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/commentLinks.js\":\"268bf9dfca85e412\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/confirmThreadDeletion.js\":\"afeb43dd2b573cc4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/container.js\":\"f0740d59e349ced1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/dataExtension.js\":\"ac11dfc4cb32b5d7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/deleteComment.js\":\"e2ac63c459d96777\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/highlights.js\":\"d5e3b1e4edf4f346\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/index.js\":\"738dbf487cb14098\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/linkedCommentsPill.js\":\"6bb90982fb0b2269\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/margin.js\":\"745e85b04986d6be\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/marginSchema.js\":\"1d91a6831413bf7c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/newComment.js\":\"1b5a78914607ae6b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/ownThreadPicker.js\":\"4c3c65fdd36076cd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/placement.js\":\"2654c42e474e89a2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/queries.js\":\"ae7d4cb0fef989d7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/quotePosition.js\":\"a83b9285e5bc8e5f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/quotedIn.js\":\"21a507ea8c43e369\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/quotedRange.js\":\"705a20e07029e6fe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/rangeRefs.js\":\"2224a53c825c0237\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/readHighlights.js\":\"56bf5b9e40dc5e8d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/readSelection.js\":\"68f9fc61faaa0c75\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/readSelectionUi.js\":\"9e25d5acc85d88e4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/reanchor.js\":\"4a8f25f165631fef\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/schema.js\":\"b9cdbc5ddf958e36\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/scope.js\":\"40a998a278dc7ed5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/scopeThreads.js\":\"525f80d5c95ca8a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/splitRetarget.js\":\"0537f11a6d400d6d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/suggestionCard.js\":\"5c4f0a263a996e8e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/suggestions.js\":\"b7955d83e88ed71b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/summaries.js\":\"db977cb6a9000c72\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/summaryBatch.js\":\"1507cea37961ad49\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/surface.js\":\"555e8477a02d3d25\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/threadNavigation.js\":\"17ef79d8e4810902\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/threads.js\":\"4e1c1d522c9cd2d8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/ui.js\":\"7d9aca2ba9b5032f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/annotations/uiStore.js\":\"b7c08dd9c886525c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-intents/appIntents.js\":\"23e202aefb7adcf3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-intents/index.js\":\"d02dde626a84f2a6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-update-prompt/index.js\":\"651ae41334ce95a3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/app-update-prompt/status.js\":\"48a0dec1a0486af5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"153a6db6e82f6f4c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/MediaBlockRenderer.js\":\"592bdb1bead32ef6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/MediaDownLaneReplicator.js\":\"06863b3af2c195b3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/MediaUploadReconciler.js\":\"02d14d9d4bdcae9e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/assetDownLane.js\":\"c4bce9b49469ec50\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/assetResolver.js\":\"6fcfbcb128a79b8e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/assetUpload.js\":\"f2a0c98d98d20403\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/attachmentCleanerIO.js\":\"160b0bd71e482239\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c89d7de746f52c75\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/blobStore.js\":\"06e306a69ccea461\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/browserMedia.js\":\"3376bc7fa5b264c7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/byteStore.js\":\"ecb48556e624b8d2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/cleanerIO.js\":\"554e0e90af4046af\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/cleanupAttachments.js\":\"a6c921181f7de64b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/dataExtension.js\":\"6815ae2400458457\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/downLane.js\":\"5eb3b77cac9e32e0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/index.js\":\"aadde43d63323942\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/insertImageContribution.js\":\"c28cd6f8612e58dc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/laneArming.js\":\"041bf5647aa554b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/laneLock.js\":\"d828eafee61b264e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaBlock.js\":\"732e9bd76758ac0a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaCapture.js\":\"efe619d7497d82f1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaLanes.js\":\"d62bbe5f296224cf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaViewers.js\":\"86fcb13004a88c6e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/mediaViewersFacet.js\":\"6d74f202abf96c51\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/pasteCapture.js\":\"890d44ec895997d1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/resolver.js\":\"9633b52dced7d0b4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/retryUploadsAction.js\":\"fd81320f6f797968\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/storagePaths.js\":\"25161c19bcc7070a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadDrain.js\":\"6c920d5682c98ded\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadLaneStatus.js\":\"cfa8b8e8a1d5ba94\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadReconcile.js\":\"850c02016daf193c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadRecovery.js\":\"0244992a195fdfd3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/uploadStore.js\":\"2c72ed7ddec58ae1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/attachments/useAssetObjectUrl.js\":\"530818d22565e96a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"67455374453b8d4c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3a25b0c8eaf90a75\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/facet.js\":\"476cdde44be82162\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/index.js\":\"944abf4fee0f0c54\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks-view/prop.js\":\"47c23b7057b2e0de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/BacklinkFilters.js\":\"6739388fbb107f14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"0ec0a762d303d397\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/BlockEntry.js\":\"7cd3656ac5c71fa5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/LinkedReferences.js\":\"8f1280d3c639c327\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fb7b24a4cf52d656\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/dailyNoteDefaults.js\":\"233d579275ef2a0e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/dataExtension.js\":\"8593b9a425ea501c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/edgeExclusions.js\":\"811134508fef6a2c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/filterProperty.js\":\"c933eb5a421d18f2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/index.js\":\"be1e1ccc889636c8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"619f188b157a68ba\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/applies.js\":\"889c023d8bd7fce2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/countQuery.js\":\"5abf3c64438809b9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/expansionStore.js\":\"eda2ababa2eea701\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/index.js\":\"5b624a4c322271d9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ea577b93dada0903\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/presentationInvalidation.js\":\"caa1325956bff880\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/propertyEditorOverride.js\":\"23aa9d3a6e8078db\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/propertyFilter.js\":\"0db22d0d40399be0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/query.js\":\"9e292ce6108f4845\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/resolveFilter.js\":\"c43dd8988ef50241\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/sourceBatch.js\":\"bced00612deb02c4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/sources.js\":\"f4c2b9f9ba10f6f0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/useBacklinks.js\":\"886be9e9a5b852f6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2440905b17ed2b1a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/BirthdayCelebration.js\":\"bd2b50ed706ca0db\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/BirthdayOverlay.js\":\"d17798350c5d359b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/gate.js\":\"95f55147aaa57574\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/index.js\":\"6342cadc61d954b9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/birthday/wolfTheme.js\":\"35cea18480e69e06\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/BlockDragLayer.js\":\"80f87fc250024836\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/dragController.js\":\"63e2285a93ca32b6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/dropTarget.js\":\"b754192f944506da\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/index.js\":\"a5bbf9ab418ad9a5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-drag/projection.js\":\"e53b617a03b5eba7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-info/BlockMetaCard.js\":\"497ae72302f1e36d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-info/index.js\":\"1ce3e1900b8dd75f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/AddTagDialog.js\":\"aa3cbf0442047710\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ea663245e186cfe4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/TagNameIssueHint.js\":\"8f6d2b9fc9b4764f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/addTagAction.js\":\"ce8e6f014a4a0ee9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/appendTag.js\":\"a6fa2f5f07a1c847\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/config.js\":\"1dd5800ba1ac615f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/dataExtension.js\":\"ef0e270566077ebb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/index.js\":\"076e96928f402ee6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/block-tagging/propertyEditorOverride.js\":\"fa5a45a70e7b5b5a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9ecd7d66419202e1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f2f2b644fac1cc73\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/Breadcrumbs.js\":\"98d1db881dfa15d2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8c527ef36da19aae\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5d02157b4fad30da\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/index.js\":\"74f139478249ec8a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6f96f7f18956ffa3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/CharacterCountItem.js\":\"e4067dccba349994\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e5b63dee6c85d8db\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/actions.js\":\"67db0987a0f75387\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/blockType.js\":\"d420cdedf213be8e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/charCount.js\":\"a3aa77848e0b7df9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/dataExtension.js\":\"5fd6b4dec8d6e98e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/index.js\":\"b4674dcda410701c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/profiles.js\":\"4de3ff57bafa4bad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/properties.js\":\"28bcdd5ccc5c42f8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/character-counter/textCounts.js\":\"420ff52f7afa94bb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/colemak-keybindings/index.js\":\"7e1c5d6ce644e51b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/CommandPalette.js\":\"2d22a4632dc1459f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/HeaderItem.js\":\"d59df78310da87cb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/context.js\":\"e354788ab94646da\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/index.js\":\"57815a1b7d8b6dde\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/selection.js\":\"62f522804f219648\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/toggleStore.js\":\"547b92b8f7350ba9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/command-palette/useCommandPaletteActions.js\":\"ef0afe29db293846\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/ContributorBadges.js\":\"27738ef8f0d46ecc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/author.js\":\"7cc2cf52b39e6bfe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/codeMirrorExtensions.js\":\"4afd7fc3eb09486d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/dataExtension.js\":\"7c067dcd01195cad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/index.js\":\"6f0943ba738640c5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/mentionAutocomplete.js\":\"dc1adfff010bd016\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/processor.js\":\"673b2202cb84586b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/profiles.js\":\"0a7c6df03e8b796b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/queries.js\":\"3ba92d5a93102771\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/contributors/schema.js\":\"5088024a6dcc1821\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"883ba591af709b5e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/followOrigin.js\":\"06346a0f7b978647\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/index.js\":\"de9a3940b07026ea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e792e2f75b9be9b3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e4a4edc5baa33ec3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/CalendarGrid.js\":\"3e56f1989040057c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DailyNotePicker.js\":\"8b98afe9dab26627\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b9e7e2493c1bb7ef\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DateNavDecorator.js\":\"4a3cf3e1616d7dfd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/DateScrubOverlay.js\":\"db508cb09a5f4c59\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/HeaderItem.js\":\"4ac60368e09c477f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/ReschedulePicker.js\":\"94226069e67f7537\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cd08fae53e4c9d66\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/actions.js\":\"5bcaf872598d34dd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/blockDateAdapter.js\":\"5f06c636a7c218e3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/calendar.js\":\"9acc2cb3daebb463\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dailyNotes.js\":\"21310d083227a76e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dataExtension.js\":\"35644fb503bbad4f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubActions.js\":\"38d7599b5ad80890\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubGesture.js\":\"de7fed2915e1f68e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8f53bd7c0614d051\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a678b767621a31ee\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/deletionGuard.js\":\"d07f651ea953a01c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/dueQuery.js\":\"6ef0f6c9071f1f34\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/index.js\":\"e600904cfe872272\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/landing.js\":\"133622d418b4fc26\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/localSchema.js\":\"54e207a82e136bc8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/referenceDateAdapter.js\":\"523cc70ae059bde8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/rescheduleAction.js\":\"3812032ceb93e194\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/schema.js\":\"757e1a392a3c8198\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/spreadBlockDates.js\":\"498928a76474e925\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/spreadDatesAction.js\":\"90edcd6741e7b4df\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/today.js\":\"98e337d68820df23\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8018d8c277c0b3d7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"63524ad48d6eb327\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/audit.js\":\"540970894e6b790c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/auditAction.js\":\"b0c84d75f4961be1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/auditRanges.js\":\"5ce89a7afb048189\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/diagnosticsSource.js\":\"6dc3f940d0a64d51\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/divergenceScan.js\":\"a4c4fc22ba97ea55\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/index.js\":\"c0413a9272cd3210\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/propertyChildrenChecks.js\":\"cf8f23ad69eddcdf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/referencesMirror.js\":\"1b49bb7d35bc9115\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/rowJson.js\":\"66268c69ce88bb12\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/schedule.js\":\"33bd21ffbc117538\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/data-integrity/store.js\":\"4f915414880fa662\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-maintenance/action.js\":\"8fca859072c7bf49\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-maintenance/index.js\":\"c0bd38bf6014d6be\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-maintenance/plugin.js\":\"e5d1bdae9d7e1625\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c1bfa3e0ada2793b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/actions.js\":\"891080b53f6f1ceb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/changeMarker.js\":\"5b8b66d02a589ae2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/diagnostics.js\":\"63a54305cb1c21ef\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/fileSystemAccess.js\":\"d5cb70466dbf167d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/filenames.js\":\"072d43f9f09f35cf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/index.js\":\"71a39fe3e67d0b24\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/mirror.js\":\"67f19f52adfc3dc4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/runLock.js\":\"501942477a95b900\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/runtimeHealth.js\":\"2c686d384211478d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/schedule.js\":\"45f3cee0f4487700\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/db-mirror/store.js\":\"ac481a02c355071f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/default-themes/index.js\":\"847f45103db7fd80\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/default-themes/themes.js\":\"aa25f78221579ef6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/diagnostics/facet.js\":\"8b734b7ded572eca\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/diagnostics/useDiagnostics.js\":\"37a0aeabfeb5c1ad\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/dismissals.js\":\"4c2ef108bc094b88\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/index.js\":\"47690b9dd89cebd2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/status.js\":\"5d64dabc9e167da5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extension-prompts/store.js\":\"c92bf533d22ebac2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bf6d4e40181557af\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/ExtensionsSettings.js\":\"dcbf96a4a63132a0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/actions.js\":\"eaaa1d4b02038a67\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/config.js\":\"e6355cf2e4bc88fc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/dataExtension.js\":\"5ea244d3c740e971\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/effect.js\":\"96bd95cbaaf8f26d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/index.js\":\"02f65957b13177d1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/propertyEditorOverride.js\":\"979e6c22bf50e36f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extensions-settings/useToggleTree.js\":\"1dea72a34aa83dc2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/ExtractTypeDialog.js\":\"27206bda01e0afd2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aab611d26cf0415f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/PropertyShapePicker.js\":\"a243686baece4e4d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/action.js\":\"5a127636542ba839\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/extract-type/index.js\":\"7dcab244b5c50ba9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/FindReplaceDialog.js\":\"af6ed996b06e949e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/HeaderItem.js\":\"92fd9199b6212dc8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/dataExtension.js\":\"01bc8b4c05b7941d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/index.js\":\"50a58790280e1c69\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/search.js\":\"153c004b1b52889a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/toggleStore.js\":\"b865e0797fb4f8d4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/LocationPropertyEditor.js\":\"6d0016b27d0dcba9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/MapView.js\":\"0e187161a3ba0dfa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/blockTypes.js\":\"98fb9461b2059eb9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/codeMirrorExtensions.js\":\"8ca5552b3e1be521\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/createOrFindPlace.js\":\"0a32fae0d3bda06b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/currentLocation.js\":\"7ff927262595ddd2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/dataExtension.js\":\"68da00555fc5785c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/geoContentDecorator.js\":\"ecd93b3b8feb9b57\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/googlePlacesClient.js\":\"b11ffd865340a801\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/index.js\":\"c488c21d554b21a4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/locationsPage.js\":\"dd4b9cc633bd16f4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/mapViewport.js\":\"6288a4cb0c7686e8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/pickCurrentLocation.js\":\"03f73d7c56f7b229\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/placeAutocomplete.js\":\"ae37005c766d7193\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/placeNameCollision.js\":\"2d53e870d69159a5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/properties.js\":\"450bd94de2fbf2ee\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/propertyEditorOverrides.js\":\"18b2de2c9a580960\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/query.js\":\"ffca4aaf933a53c1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/geo/usePlaceSearch.js\":\"47412c0a53051e14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c15bda9dee5cca77\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"bb4ebe5cd6f2e104\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4cc72d48221dafe1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/config.js\":\"53bea3be9c19018a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/dataExtension.js\":\"a973b5d300b92903\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/facet.js\":\"4d3b6ac1e05f655a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/grouping.js\":\"6dd13a3c1ebbbd3b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/index.js\":\"dbe00a254369e534\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7d7e39a319c8cfe8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/query.js\":\"ac7b857a8914d94f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/resolveConfig.js\":\"86eda1f3734269a1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2afc161b182d5239\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"664e06656081fa33\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/HtmlDocumentContent.js\":\"9a284694b9c8bd47\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/HtmlFrame.js\":\"47c36e4aa573da82\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/actions.js\":\"d10d2055e5001db1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/blockType.js\":\"dbab049a16ba2f60\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/confirmRunScripts.js\":\"f1e464735632909a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/dataExtension.js\":\"a31fbf7efeb7178e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/frameAnnotations.js\":\"bc809ae1bc04d87d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/frameDocument.js\":\"b72df2ebafd576f4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/frameTheme.js\":\"2a3f301e39058b2a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/index.js\":\"d4d2fb8c8e87f81c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/scriptConsent.js\":\"f2d90851e58ae7b6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/sourceMap.js\":\"871ca4d76633d52f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/html-document/useDocumentScripts.js\":\"f425c849571d85d1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/index.js\":\"73fe1a92e9c9f3e1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/record.js\":\"ee0ebc27a59501e9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/recordStore.js\":\"3a91fdc69f5ff1d9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/responsiveness.js\":\"ab668be2cbaabe98\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/schedule.js\":\"b94a1e2b3c7fe030\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/interaction-metrics/sessionContext.js\":\"8abdfba8992d0c50\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c9c27aeb7797e8af\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"16e3350a4368bd55\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/actions.js\":\"0c26419a55a3fe3a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/config.js\":\"3f0e8de3f454a5fc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/dataExtension.js\":\"b74931c3a59a99c0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/effect.js\":\"69449223369e1fc2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/index.js\":\"d5d5d9576ad371fe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/keyCapture.js\":\"2e57a32fa02c4567\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/overrideStore.js\":\"becd18e02af62ba9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"af7deceb9f4e0c4e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/HeaderItem.js\":\"3875a2244b212730\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/LeftSidebar.js\":\"bbfa70e2bff6fe05\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/actions.js\":\"60921f3f4130596c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/facet.js\":\"3d8a0f0debedb924\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/index.js\":\"18166d319a49850a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/shortcuts.js\":\"8f8e557400fe19b3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/left-sidebar/toggleStore.js\":\"192efa3bedbe08ef\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/MergePicker.js\":\"b3fe758713ae815f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/index.js\":\"5bd9c92aec7ee6b5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/mergeAction.js\":\"f495d550ca274af9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/merge-blocks/strategy.js\":\"ccdb617ed5a41108\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/Button.js\":\"4af40ca3fc106135\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"560ed705cd9376c5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e1d25158f3f33efb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/facet.js\":\"56c6cd0ed894594f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-bottom-nav/index.js\":\"e6356e346de6fa91\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8e91c137ea5b8926\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a8329f022e0035da\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"29c8d32c86f854f6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/facet.js\":\"06e8961ef3a1f2e3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/mobile-keyboard-toolbar/index.js\":\"449f3ac28558c401\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b8662ec3924a622e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/blockSubtreeMembership.js\":\"54b5df27b8f6328b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/contextMenuItem.js\":\"595e44503490164b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/index.js\":\"05bc9498c95d38a6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/moveAction.js\":\"e5b2067c0cde0913\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/moveBlocks.js\":\"5c277cb6913b1735\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/move-blocks/selectionAfterMove.js\":\"d46ea9f8d4821aeb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/TutorialBanner.js\":\"b0705a14938e35d2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/action.js\":\"5885d9c7c9198f07\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/bannerDismissal.js\":\"bc6c0fa8e9e3ef52\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/documents/cheatSheet.js\":\"3a59312d8d181b26\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/index.js\":\"927cd5bd6b3669d0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/keys.js\":\"12c14144e328e898\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/landing.js\":\"8d15e4909d7a49db\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/outline.js\":\"5b74d01a3a43ee54\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/onboarding/seed.js\":\"ab56611042527bd8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/PerfTrendDialog.js\":\"695379174652235f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/analyze.js\":\"097d3ca5f8c978e2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/diagnosticsSource.js\":\"53762437c2ee23fe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/index.js\":\"014c944637c4c360\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/load.js\":\"b3b65a40c0cbd8e0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/monitorRun.js\":\"e09aee902bc918c2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/schedule.js\":\"e891e81b1768494d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/series.js\":\"c28a67abf7fe9035\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/store.js\":\"85a69934e55c7635\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/trendAction.js\":\"d54debf3196df936\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/perf-monitor/verdict.js\":\"133621258a4b4aa2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/plain-outliner/clickToEditAction.js\":\"f132e145a533536c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/plain-outliner/index.js\":\"8a3a1fb1f90de8d7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/plain-outliner/interactions.js\":\"c369104a9000ab36\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a03804ad32ee208b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/MigrationGate.js\":\"9582a576b8d1e487\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/MigrationGateDialog.js\":\"a883a37c078e8074\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/action.js\":\"516595e932306d67\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/index.js\":\"5ef822bc925e0175\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/localRunMessage.js\":\"c0d4dceae4232df5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/plugin.js\":\"0a500d5dd2dd95f4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/progressReport.js\":\"8a5cd7e876ba40de\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/properties-migration/sweepProgress.js\":\"b95af3d97352554f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/FieldRowRenderer.js\":\"6d5743ca19692307\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/ValueRowRenderer.js\":\"952ed8adea7efd55\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/actions.js\":\"1533b81f4612b113\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/autocomplete.js\":\"f5f17099a006aef8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/fieldRow.js\":\"fcc9979f4d9cc6b5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/index.js\":\"2d723e936ed96008\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/referenceWarning.js\":\"5676606f8aa39cd5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/valueAutocomplete.js\":\"260c68b821244ed3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/property-rows/valueSchema.js\":\"2ae2f2675e91f6b2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/HeaderItem.js\":\"822f0a71f871dc1e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/QuickFind.js\":\"354904c6e8f84245\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/index.js\":\"a2d3b1158b5b8ec2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/recents.js\":\"ae3f0a54cd2660ae\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/resultItems.js\":\"8a3e28c2c07f7085\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/selection.js\":\"6bed52e3277aa4e5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/quick-find/toggleStore.js\":\"e76e73de838e10f3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/HeaderItem.js\":\"f64afad70fa91cc9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5a16d053a98a7c36\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/grouping.js\":\"58099cf3ba720dab\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/index.js\":\"d651fd9d97c613b0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/recents/target.js\":\"57b596c857ad4407\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/codeMirrorExtensions.js\":\"1361424a2206b6f3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/contentPrefill.js\":\"b5a72fa2eac4e621\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/dataExtension.js\":\"fc58da0d6d906b51\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/index.js\":\"c89a854a12a6943d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a2a6d3e9e1e066d7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/invalidation.js\":\"de2df87d022e3342\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/localSchema.js\":\"aec8c48070e80516\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/blockrefs/index.js\":\"23a6045509282d3f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d8fd800c83be1648\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/index.js\":\"5375748d6f41e72e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/referenceNode.js\":\"a91f54d9081ae62a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/remark-reference-occurrences.js\":\"bac51a8358073b8f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8d3b90190ed615f7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/index.js\":\"a919f0f48fd3961c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a6a8619172422626\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5d4e3d89d86d151c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/mergeRetargetProcessor.js\":\"443f3b82b70d672d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/parseFence.js\":\"7de8db4c250b4f8b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/referenceParser.js\":\"a5d6336158cec760\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/referenceProjection.js\":\"249826ba7a1f9557\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/referencesProcessor.js\":\"0ab0fa88e04f24a5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/renameProcessor.js\":\"622762d889abaff2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/references/spanReplacement.js\":\"9ef0d4f9ee25d3ef\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/htmlToOutline.js\":\"25036a1bcb2f0dfc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/index.js\":\"913431773f49e199\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/normalizeClipboardDom.js\":\"95567134f9203930\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/rich-paste/pasteDecision.js\":\"19d4e3ad89a5e296\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/action.js\":\"2b36ac378c6d6bc6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/blockIds.js\":\"5f57b8519b0ea449\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/content.js\":\"f748ac2ac7b441f4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/effect.js\":\"dc2755a3c649ac14\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/ids.js\":\"58b779dbc13efca4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/import.js\":\"0af628b67f117155\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/index.js\":\"2ec18d1fd73b4d41\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/plan.js\":\"7acb5496bf5a332b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/plugin.js\":\"1e0629e6d7ca7315\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/promotion.js\":\"10f321fcac44a906\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/properties.js\":\"e311e08e8f357faa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/references.js\":\"5f95afe8462957c3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/report.js\":\"06e61405f0c26ad0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/roamMemo.js\":\"d8b2c5eff18e38bb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/runtime.js\":\"2d177cf23e896684\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/schemaReconciliation.js\":\"d6feb61055043fb3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/srsMarkers.js\":\"db7ed63bd21546ab\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/todo.js\":\"31a9774c055928fa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/typeCandidates.js\":\"f74fce9586b26ff8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/roam-import/types.js\":\"c929a8e1bd00216e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/search-health/index.js\":\"08c33a2ad38c1562\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/search-health/store.js\":\"99d2581c12ac091d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/HeaderItem.js\":\"c3cf12fc93f040b5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ed6a555b769f3409\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/index.js\":\"0946125adacfb4cb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/model.js\":\"2ae0c9fc969cb0cb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/toggleStore.js\":\"3c819c44dd0e4ae3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/shortcut-help/useKeyInspector.js\":\"cfb94d199aa5ec5e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a73b485cc6595121\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/ShellDecorator.js\":\"349806a0b8617eb6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/actions.js\":\"2bfa319eed14f7af\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/exclusionsFacet.js\":\"babba0d5e5e82984\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/index.js\":\"c81b84d69287426b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/shell.js\":\"1a4d9e618981e8b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/surface.js\":\"5e192b0cc880686a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/spatial-navigation/walker.js\":\"b0f012f6d695f2f7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8dcd843088d814f6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/dataExtension.js\":\"64b351bae36ccce9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/index.js\":\"bec8a101593785aa\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/indicator.js\":\"4123efeb0052673c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/moveSrsState.js\":\"eef4b714c528bea0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ce559a6eddbd6c91\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/scheduler.js\":\"bb8db06947435e34\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/schema.js\":\"87b5e0cc66673c1f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"16dcdc6de0a1b78e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/srsClipboard.js\":\"4f4598a00194a6b6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"93fe2ad5dbfce3dc\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/DailyNoteReviewHint.js\":\"326e79aedd6a0ace\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/DeckPicker.js\":\"8a11a854f04ca22e\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/ReviewControls.js\":\"5a0d87762d7ec473\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8388d2196f0adb53\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/ReviewSession.js\":\"5a03fa67dd13cbdb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/actions.js\":\"31e5b20e98a6b339\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/archive.js\":\"599c0aaef11645fd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/dataExtension.js\":\"7e1faffc121a4403\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/deck.js\":\"f4cc6258b5ede3ec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/dueQuery.js\":\"334d72cc381a735f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/gradeDecision.js\":\"39b90806a182cfb7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/index.js\":\"6cb5f2e276c92335\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/keyHints.js\":\"a78fe1f1cdb602b5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/reviewCardLayout.js\":\"15b2506518451259\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/reviewProgress.js\":\"874aa060789ea815\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/schema.js\":\"23e257f8a356f2b8\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/srs-review/useDueCards.js\":\"6ddbc05d527a9a0b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/startup-metrics/index.js\":\"86efcb8ef3b60769\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/startup-metrics/record.js\":\"5948732c84f01976\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/storage-persistence/index.js\":\"78d3d9303cc70a06\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/storage-persistence/persistenceStatus.js\":\"89b7bff565d8e81c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/storage-persistence/requestAction.js\":\"1bce6e572fb2cf6b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/TypeChipsDecorator.js\":\"4f997a749446625d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/codeMirrorExtensions.js\":\"cf16835231d6902f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/index.js\":\"a39f1f65fd3f08ea\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/supertags/typeAutocomplete.js\":\"1fe21db467339327\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"057c0b0b1704a680\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/actions.js\":\"dbe063bfe0623636\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/anchor.js\":\"4b58e3cc13632c10\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/events.js\":\"c3df8a8c923e6875\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/gestureActions.js\":\"b3abf56c71901b23\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/index.js\":\"4d47a96e344ba5a3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"86ec1d48cd88949f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/sync-metrics/collect.js\":\"ea2ed757d81885e3\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/sync-metrics/index.js\":\"212050b9c6fbf0b0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/sync-metrics/record.js\":\"11cb05cab740c0f2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/RejectionDialog.js\":\"d8872b60da4b75ec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ea3275f75cbb84ba\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/index.js\":\"55c2499453660e8c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/model.js\":\"0586ddc2ebeb5ce2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/queueCounts.js\":\"cfacd737340be7b2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/rejectedHelpers.js\":\"2365577878f8a34f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/rematerializeAction.js\":\"772ab8cc9a5ca8eb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/system-status/useHysteresis.js\":\"3b1beb94bb687ef5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/ColumnHeaders.js\":\"17547baa8c76bf12\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/QueryUi.js\":\"ef4c10e8b36e60bb\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/TableLayout.js\":\"405efae46a02bc7f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/actions.js\":\"7076e6c0babfabb6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/cellEdits.js\":\"d5672c8bb3e594b6\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/columns.js\":\"52f18b6b64d8318c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/controller.js\":\"18f9e26bd335e9d9\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/convert.js\":\"9abf28291f056134\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/dataExtension.js\":\"7d3b4e51250e542c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/index.js\":\"1b9ae47c99cdd2cd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/keys.js\":\"bbb5a9217dcf9c4d\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/model.js\":\"4fe82ef1ee7c12a2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/navigation.js\":\"04059f9bdb0d3883\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/backfill.js\":\"fa581229937303ff\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/completion.js\":\"df79cc71a4416515\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/format.js\":\"060bf0cfa45d72f1\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/parse.js\":\"81d73dbadc566e77\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/queryValue.js\":\"bde42023922105e4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/query/source.js\":\"4be0cca90a50be1c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/registry.js\":\"4307b4b8fc23898c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/rowGutter.js\":\"7c63cf43397c3d84\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/rowVerbs.js\":\"3d3026eda5447ebe\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/schema.js\":\"1c946949d649aea4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/tables/sort.js\":\"2f6d56874536e28a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/theme-toggle/effect.js\":\"737409904633677c\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/theme-toggle/index.js\":\"a01c82bc6a733ee0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/theme-toggle/theme.js\":\"aa2c55015def4a66\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/actions.js\":\"774d4cd09c99cfd7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/dataExtension.js\":\"ea8fcdaefbfd5449\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/index.js\":\"ce13395544499536\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/todo/schema.js\":\"f089d3ea61338231\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b456999746f1e94b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/actions.js\":\"67aa167fa46dade2\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/defaultItems.js\":\"9e3681c9249fc5ba\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/facet.js\":\"a572480affab448b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/holdRecognizer.js\":\"e4629d8062318c21\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/touch-selection/index.js\":\"79f7e0db6965107a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/update-indicator/UpdateIndicator.js\":\"e121969b33c6b230\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/update-indicator/index.js\":\"66e2e710891cba62\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/update-indicator/loadTimes.js\":\"f7c4c994f90b670a\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/VideoNotesRenderer.js\":\"edb8ec53dbc9899f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/VideoPlayerRenderer.js\":\"0fb3730047b2ee12\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/VideoTimeStamp.js\":\"63dc28c5561d16c7\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/actions.js\":\"47fe90314e553c17\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/index.js\":\"a7d9415216d77e3b\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/markdown.js\":\"4f099d03b701c3cf\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/notes.js\":\"19bfc74e72a61722\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/registry.js\":\"1fdad4fafdb16640\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/remark-timestamps.js\":\"3d0a62a2e79c7c1f\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/video-player/view.js\":\"38c39784159584b4\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/LinkHints.js\":\"9f93ee9141f4aae5\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/index.js\":\"ac46aa3355a744c0\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/model.js\":\"2c175040c37dccec\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-link-hints/settings.js\":\"260012e806fdf094\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-normal-mode/actions.js\":\"d36d0bf0ad44ca15\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-normal-mode/index.js\":\"f1a70fdc6552b139\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/vim-normal-mode/interactions.js\":\"18c5794166091ecd\",\"/knowledge-medium/pr-preview/pr-1637/src/plugins/workspace-header/index.js\":\"72b53c2fc8f8658d\",\"/knowledge-medium/pr-preview/pr-1637/src/registerServiceWorker.js\":\"86c645145a451da8\",\"/knowledge-medium/pr-preview/pr-1637/src/requestPersistentStorage.js\":\"5f793731e76421b7\",\"/knowledge-medium/pr-preview/pr-1637/src/services/authRequestDeadline.js\":\"d34189e46ac04f28\",\"/knowledge-medium/pr-preview/pr-1637/src/services/authStorage.js\":\"3e5e6fc23c955b11\",\"/knowledge-medium/pr-preview/pr-1637/src/services/powersync.js\":\"8741eff1aee283ca\",\"/knowledge-medium/pr-preview/pr-1637/src/services/supabase.js\":\"9eeaff58181dc985\",\"/knowledge-medium/pr-preview/pr-1637/src/services/uploadErrorClassifier.js\":\"235dfd5515468455\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/ActiveContexts.js\":\"c9cb300b110f01c3\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/HotkeyReconciler.js\":\"1689e7adf019a07b\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/WipeLocalDataDialog.js\":\"439670809518c619\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/actionDispatch.js\":\"7b11a2c2b1ad69db\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/actionRefItems.js\":\"3d0fe49aabfda8e8\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/applyKeybindingOverrides.js\":\"35882ac0df824176\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/blockActions.js\":\"7205bbb541436f48\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/blockMergeGesture.js\":\"750577cd214d97aa\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/canonicalizeChord.js\":\"7a77cde833154206\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/defaultContexts.js\":\"ebfeee2543830912\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/defaultShortcuts.js\":\"5736189759800013\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/effectiveActions.js\":\"8a43b9939c5df4c8\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/gestureAction.js\":\"6e2453599cb07b6b\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/gestureBinding.js\":\"6cfe37e18380c32d\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/holdRegistry.js\":\"ba81a68de2259739\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/keybindingConflicts.js\":\"9a0d4b38457a26c7\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/keybindingOverrides.js\":\"b5af2fd26d9e555b\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/pointerAction.js\":\"ac23d6d85f5deb0f\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/resolve.js\":\"c330bb76e987b7f4\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/runAction.js\":\"388ed7728b3f7d14\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/sequenceMatcher.js\":\"62b0c774b8c82aa7\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/types.js\":\"4f45f1265abfad19\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/useActionContext.js\":\"a413fe5979f7f23c\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/useActionDiscovery.js\":\"832f8466df08b95a\",\"/knowledge-medium/pr-preview/pr-1637/src/shortcuts/utils.js\":\"cb250e676b7230d9\",\"/knowledge-medium/pr-preview/pr-1637/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1637/src/sw/bootStore.js\":\"6f1292ef216444b8\",\"/knowledge-medium/pr-preview/pr-1637/src/sw/previewDatabases.js\":\"679b2dfe238e6d45\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/byteTransform.js\":\"f2c044a7edd2cc8e\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/attachmentCleaner.js\":\"f999d346df8797e4\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/attachmentParts.js\":\"4094980c68e29aa6\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/bundleParts.js\":\"91cb5fcf3d5c8250\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/bundleRecord.js\":\"5ce7bb83b4507dbe\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/manifest.js\":\"24de3420f725f231\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/takeBundle.js\":\"69c1512d626aca55\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/bundle/verifyBundle.js\":\"0ec8cca203f28519\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/cleaningStage.js\":\"f79a4303c8b54fb6\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/conversionKey.js\":\"0b364ddb892be323\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/conversionServer.js\":\"48a5c54af7a09787\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/flip.js\":\"0dbe28d43093b2cd\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/flipAttempts.js\":\"ef9b3b917bb4fb6a\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/pages.js\":\"ad16a618c2ebfcba\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/preflight.js\":\"427ef50becc40bd3\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/reseal.js\":\"4c2bbb4263e898d2\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/runConversion.js\":\"cbb3414ef78269e2\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/runLock.js\":\"9abbb262c714ae75\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/sealing.js\":\"e6afc50d2d9a5e8e\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/sealingStage.js\":\"004294bf0beabaed\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/stage.js\":\"9b941fcd4731527c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/conversion/verifyReseal.js\":\"5ebaaac696f59012\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/aad.js\":\"c577b7191909ae45\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/aead.js\":\"0b292502a7ef75f0\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/base32.js\":\"73c8ec191053deac\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/base64url.js\":\"e91398fb403185c8\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/binaryEnvelope.js\":\"fa45d02a4d5959ab\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/byteAead.js\":\"64d15449c994c9fa\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/canary.js\":\"71d90fc04376be10\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/contentHash.js\":\"9d5c8e809d51f55c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/contentKey.js\":\"e96adb9f71aa8ecc\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/derivedIdNamespace.js\":\"9376f398dc64a22b\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/envelope.js\":\"0de43dcc01528b92\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/hex.js\":\"a7f41f32dbd9aa44\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/sha256Hex.js\":\"a50a335c2a061ac5\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/crypto/workspaceKey.js\":\"78c8063b20174fa6\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/conversionState.js\":\"396d4394ac13ae0c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c5af143f1d641bc3\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/pastedKey.js\":\"688dc4683cb7056f\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7d4f1882752009c2\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b17d2d3daba8a8bb\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/keyStore.js\":\"8b97cb4a5e3192f1\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/mintWorkspaceKey.js\":\"4d25bab642ba57f4\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/modePin.js\":\"9b7a8df04a2d020c\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/openWorkspaceKeys.js\":\"7678cfbbf89b0257\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/resolveWorkspaceEntry.js\":\"9dd1ab34491ff708\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/resolver.js\":\"21f782c0acf8ee53\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/keys/workspaceAccess.js\":\"cfd20587ba4fe0e3\",\"/knowledge-medium/pr-preview/pr-1637/src/sync/transform.js\":\"f91f4fe8a8762930\",\"/knowledge-medium/pr-preview/pr-1637/src/themeBootDefaults.js\":\"e928fa758ec44611\",\"/knowledge-medium/pr-preview/pr-1637/src/types.js\":\"a2f7e5124e13eef8\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/ClientLocalSettings.js\":\"33e215e930cee9b3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/abortableSleep.js\":\"39c127c90a97dd88\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/array.js\":\"eeb92253456b898e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/backlinkAutocomplete.js\":\"f1f456da8053b484\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/blockCrumbs.js\":\"4e7084745131bb3f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/blockrefAutocomplete.js\":\"e92e4b3ef6208bfc\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/cadencedIdleJob.js\":\"25d7c87eb3b3fedf\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/callbackSet.js\":\"93d635e0a3380daf\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/clientId.js\":\"15f25a6a1735ef12\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/codemirror.js\":\"234904b36860d5e2\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/codemirrorCompletion.js\":\"ee1a9e35edd5c858\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/copy.js\":\"c21aeb561c35a1a4\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dailyPage.js\":\"faa6b2b9ca717a35\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dbForensics.js\":\"e57d23d735e2d755\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dbForensicsHooks.js\":\"bd0332d2701c3681\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/deleteBlockThroughUi.js\":\"34dfa35b0ad08364\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dialogs.js\":\"73fa0addb82bd385\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/dom.js\":\"2b5ccab9be21930f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/downloadBlob.js\":\"08ab4c30bf217965\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/exportSqliteDb.js\":\"dc1ba0cffe0d5ac2\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/fileSystemAccess.js\":\"3e55fe5441add798\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/flipSlide.js\":\"7ecf55234a342255\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/fnv1a.js\":\"a4b30aa6ac16a13a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/formatBytes.js\":\"a5c2d66af1368f87\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/fuzzyRank.js\":\"30e63ae4fb2347a8\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/idbKeyedStore.js\":\"4943001da9408400\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/idleCallbackPolyfill.js\":\"a08108469f7c9829\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/keyboardAwareScroll.js\":\"65ceb506fbd7e626\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/keyboardViewport.js\":\"bb2d7cad865c4bcf\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/lastWorkspace.js\":\"bac1c13f8da2f242\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/layoutColumns.js\":\"87fdd4fbae08b163\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/layoutSessionDom.js\":\"5a2ac2cedc74e466\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/layoutSessionId.js\":\"32ce0ad4d062c4c3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/linkClickGestures.js\":\"0f7308392732ed8c\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/linkTargetAutocomplete.js\":\"ba6af4d89f631ee9\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/localDbCorruption.js\":\"4eefea692291ea21\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/localDbRecovery.js\":\"5104506dca7e9257\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/markdownParser.js\":\"8ba51b27c05f3f9b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/memoize.js\":\"27dd54113638bd1d\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/nameFieldCommit.js\":\"e016ef7d40e323fb\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/nameList.js\":\"dde65bcfe40c27e3\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/navigation.js\":\"bb740739d9e8a4e2\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/omnilinerNamespace.js\":\"c9676dc18d4507d6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/opfsPageScan.js\":\"0a68557cba319657\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelClearance.js\":\"85ef8872de15f3f8\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelHistory.js\":\"3b34a008895bd7fd\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelLanes.js\":\"d4477386522e1e6b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelLayoutProjection.js\":\"a2e70f48d7e30189\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelScrollAnchor.js\":\"957f665df8a05092\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/panelUrlFlags.js\":\"315ffc899d8b1ed9\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/platform.js\":\"91e4770a0af2bd42\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/pluralize.js\":\"0a7601b6c151d948\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/propertyCreation.js\":\"7de8ea66c0b7beb9\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/propertyNavigation.js\":\"72c5e0e17ff4d57d\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/propertyValueContext.js\":\"e753a1200fe7db54\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/react.js\":\"4ee42ae80a57a380\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/relativeDate.js\":\"372d18cd613f9a29\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/relativeTime.js\":\"75c65cc2690fd202\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/renderScope.js\":\"9b42355ad584f0e6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/resolvedThenable.js\":\"0adcf06486de67dd\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/routing.js\":\"98ec0a5d13740e8a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/safeMode.js\":\"3e46c61b9a62d5b4\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/scheduleIdle.js\":\"a5599d445c0f6e45\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/screenWakeLock.js\":\"86478312c430c1ea\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/selection.js\":\"d0481ed9062b1b69\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/softKeyboardGrab.js\":\"15c5af3e69db310b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/startupTimeline.js\":\"8b46c2b0dea10dcb\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/state.js\":\"3e560fd6843a5849\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/string.js\":\"e41bc42ff66a926e\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/surfaceZoom.js\":\"a5127c2964fc139f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/time.js\":\"aef19c3556e3833b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/toast.js\":\"4e4f07364227b47d\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/toggleStore.js\":\"74be6d0ba8fa32ad\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/untilStopped.js\":\"8de25f70001b6f45\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/userActivity.js\":\"2c399d73bd74df04\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/viewTransition.js\":\"46ce096bad85812a\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/viewport.js\":\"e86b3e0b727f0d4b\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/webLock.js\":\"9d2a6d1ac4ec16ab\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/workspaceRecovery.js\":\"787ec02ee7a0fc2f\",\"/knowledge-medium/pr-preview/pr-1637/src/utils/workspaceSnapshotStore.js\":\"43b4677a17c796ca\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-compiler-runtime.js\":\"6f26670188bb21cc\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-client.js\":\"03f7e64b23f82306\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-server-edge.js\":\"692eb5625a4977c2\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-server.js\":\"041dfa62aca33a27\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-static-edge.js\":\"c05453334cff9c86\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-static.js\":\"bfbeca84e7c99e25\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom-test-utils.js\":\"029aba6a5c3d085f\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-dom.js\":\"ec784a55ce36037e\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react-jsx-runtime.js\":\"f71724ad38f0c326\",\"/knowledge-medium/pr-preview/pr-1637/src/vendor/react.js\":\"6287b2059493e774\",\"/knowledge-medium/pr-preview/pr-1637/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1637/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1637/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
