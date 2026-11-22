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
		buildId: "4885e6b97e40-0396f5b5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/\":\"39a85a997a7f3946\",\"/knowledge-medium/pr-preview/pr-1639/index.html\":\"39a85a997a7f3946\",\"/knowledge-medium/pr-preview/pr-1639/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1639/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1639/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1639/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1639/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1639/assets/FacadeVFS-BJWqMA60.js\":\"10eaa0eaf0f0fc52\",\"/knowledge-medium/pr-preview/pr-1639/assets/OPFSCoopSyncVFS-Cq9fChfU.js\":\"e1b0fe75a57dcf52\",\"/knowledge-medium/pr-preview/pr-1639/assets/OPFSWriteAheadVFS-DMKdtDhq.js\":\"7726150954b299d8\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-CMlrU44c.js\":\"1ff4fb22c92c5210\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-async-1yPaDbmh.js\":\"a54fccc757250bf9\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1639/assets/worker-DeeUBQC9.js\":\"c686265e477f2f29\",\"/knowledge-medium/pr-preview/pr-1639/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1639/chunks/app-DQYmysvq.js\":\"6c8d7d054ac39561\",\"/knowledge-medium/pr-preview/pr-1639/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1639/index.js\":\"d9672faf0ac0f50c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1639/assets/AccessHandlePoolVFS-B5zDZ-_S.js\":\"da947d207f0d4b34\",\"/knowledge-medium/pr-preview/pr-1639/assets/IDBBatchAtomicVFS-B48GIJud.js\":\"2cbf210466faf9ce\",\"/knowledge-medium/pr-preview/pr-1639/assets/MemoryVFS-xnphci4M.js\":\"e3388f93fb68444b\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-async-B1UmirEJ.js\":\"b0d60f437abd88e0\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-dJYiCHJj.js\":\"5f16316386b36309\",\"/knowledge-medium/pr-preview/pr-1639/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1639/chunks/AccessHandlePoolVFS-DpCLLuov.js\":\"cd78178af613f314\",\"/knowledge-medium/pr-preview/pr-1639/chunks/FacadeVFS-BzW2SJjx.js\":\"f452fe7d10e9a084\",\"/knowledge-medium/pr-preview/pr-1639/chunks/IDBBatchAtomicVFS-Ductk4gD.js\":\"f69f2351bacf065a\",\"/knowledge-medium/pr-preview/pr-1639/chunks/MemoryVFS-BGZIzvLH.js\":\"5b737785a72afbb8\",\"/knowledge-medium/pr-preview/pr-1639/chunks/OPFSCoopSyncVFS-BViI6u13.js\":\"8f65110249f06348\",\"/knowledge-medium/pr-preview/pr-1639/chunks/OPFSWriteAheadVFS-BTANStSV.js\":\"c3e217aa359a9b18\",\"/knowledge-medium/pr-preview/pr-1639/chunks/Preview-DiWz2hZ-.js\":\"ea7e0422849e0a8d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1639/chunks/card-BQ-QJy15.js\":\"0cc26e2da071fe26\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-DAt1CJ23.js\":\"5fe78679d7545233\",\"/knowledge-medium/pr-preview/pr-1639/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1639/chunks/mc-wa-sqlite-Dv3JD0xo.js\":\"29e8b7eb14a801d7\",\"/knowledge-medium/pr-preview/pr-1639/chunks/mc-wa-sqlite-async-3bVklRvy.js\":\"6688fbae95616585\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-3-cVOy33.js\":\"e864da73dd1c518b\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-B-jQERqP.js\":\"d97f7c94e59786ec\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-B0TQjH8D.js\":\"2492650d73c7e633\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-BLjaK56h.js\":\"63dcd099da3e7977\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-BXtr7gC_.js\":\"ccc4fa4ac6d2f55c\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-BvygxcN7.js\":\"9ec2a81724130fa8\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-CN1kCFxf.js\":\"91bcf29b68b99e08\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-CRpJZEDf.js\":\"24511ebe74408f75\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server-legacy.browser.production-CoQgToTi.js\":\"3a7eb14362ef66bd\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server.browser.production-dSE3PHDM.js\":\"bbe03a5fc1283eed\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server.edge.production-Dan5p5TZ.js\":\"3eba7a18e764c77d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/server.browser-B2KmlFdI.js\":\"310a937fb352883e\",\"/knowledge-medium/pr-preview/pr-1639/chunks/textarea-Bl3ongu2.js\":\"107bf606e6eed824\",\"/knowledge-medium/pr-preview/pr-1639/chunks/ui-D2NjPKk2.js\":\"8e9a4b60afde6e09\",\"/knowledge-medium/pr-preview/pr-1639/chunks/wa-sqlite-DHM-V1W5.js\":\"84eb7ff566383ef1\",\"/knowledge-medium/pr-preview/pr-1639/chunks/wa-sqlite-async-D2lD5rsi.js\":\"88e9d58e7397a92d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1639/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1639/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1639/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1639/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1639/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1639/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1639/src/App.js\":\"d4206921d0106f65\",\"/knowledge-medium/pr-preview/pr-1639/src/appUpdate.js\":\"4829dd1b744075ff\",\"/knowledge-medium/pr-preview/pr-1639/src/appVersion.js\":\"446042e5968d41ed\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/initialLayout.js\":\"d723d3cbc4df41ef\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/openWorkspaceData.js\":\"70b9d2734264c30a\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/resolveWorkspace.js\":\"21d5809230292f58\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/workspaceBootstrap.js\":\"c6a57ea2cf61a8da\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockComponent.js\":\"a3333bfc04d5a3c4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockCrumbs.js\":\"346ff7d9b3e32a2f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockEditor.js\":\"e583a4bf454cc488\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockLoadingPlaceholder.js\":\"189da9f910155d23\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockProperties.js\":\"76702c0560872c28\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockSearchPicker.js\":\"1601448e3418139e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ConfirmBulkDeleteDialog.js\":\"4106723bc6efe26a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/DividerHandle.js\":\"d9fba6a2bea74f48\",\"/knowledge-medium/pr-preview/pr-1639/src/components/DraftEditor.js\":\"8cb00223b4e23020\",\"/knowledge-medium/pr-preview/pr-1639/src/components/GutterPill.js\":\"25befa3fa0136617\",\"/knowledge-medium/pr-preview/pr-1639/src/components/Header.js\":\"eb05ddc89351c17e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/LazyBlockComponent.js\":\"7ce2568d5f0fbd72\",\"/knowledge-medium/pr-preview/pr-1639/src/components/Login.js\":\"0affefa801a73c51\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ZoomableSurface.js\":\"485aced10968260e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/editModeKeepalive.js\":\"c906067e83c3823f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyDisplay/PropertyDisplayScope.js\":\"99f0c24d116542d6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d4f7ecb33d288078\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/RefPropertyEditor.js\":\"8940844f15172a89\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/RefTargetTypePicker.js\":\"5a81646bf4ba79fd\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/SelectPropertyEditor.js\":\"31797dc8ea2a2afe\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/TypesPropertyEditor.js\":\"d261ca2907da6be3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/defaults.js\":\"2d7da640a7a0fedf\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/kernelValuePresets.js\":\"4410ab768a78d4d1\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/selectablePresets.js\":\"8c97423f46bbe2ed\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/typesPropertyUi.js\":\"eb5a8822cd7b8e1c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/AddPropertyForm.js\":\"1d82e3ae37ab2e66\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/PropertyPicker.js\":\"e9f7a7876cb392b1\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/PropertyRow.js\":\"d5bff75c62ad2ff6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/Rows.js\":\"f3eb219f51503397\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/actions.js\":\"c64831eca160dfc3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/declarationOnly.js\":\"e7868e8ef02772d7\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/layout.js\":\"9590b6a93fb41f2b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/model.js\":\"e0a8b4b1b035219a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/shapeUi.js\":\"9704fa9971623455\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/shapes.js\":\"4ca6a6298941fcbc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1fca0be0df1408ab\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/visibility.js\":\"5057ed945e5e208b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanelSections.js\":\"9247698ae439b498\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockEmbed.js\":\"ace4018419c618d0\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockLink.js\":\"f29924b89ae5a596\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockRef.js\":\"5c9421d3514e8834\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/ReferenceLink.js\":\"6d2daeefb2acb396\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/cycleGuard.js\":\"c1f17825fc5f0188\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/cycleGuardContext.js\":\"870ef85d18c287d7\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/linkInteraction.js\":\"fb2fb386d6dd578d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/referenceLayout.js\":\"68395b0c981b740a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/useBlockRefAncestors.js\":\"2522dd35116351bc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockGutter.js\":\"6f8439b23783fcc2\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockInfoDialog.js\":\"6f11d5552ee9becf\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockTypeBlockRenderer.js\":\"ccd9b6ec10886616\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BulletHoverCard.js\":\"ebdfdb88c35f8b1a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/CodeMirrorContentRenderer.js\":\"51051d3ae40f461b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"548f845e704921d6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/ColumnResizeHandles.js\":\"7ca0faabdeae4f6d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7c07067d805824fe\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/DefaultBlockRenderer.js\":\"029f92539617c11e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/LayoutRenderer.js\":\"f1d156c02af31194\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/MarkdownContentRenderer.js\":\"954ad2f9c0883e3d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/MissingDataRenderer.js\":\"6c905162aef72fc5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/PanelRenderer.js\":\"65766b502750b75b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a07156bd7bd82481\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/TopLevelRenderer.js\":\"57c0941d0a3b7cb5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/blockGutterMode.js\":\"be5b5fb8b98758ec\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/blockTitleText.js\":\"bca8b471a3cf0c31\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/fieldCreationKeydown.js\":\"356ec4610467aff0\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/layoutRootContext.js\":\"74f4b819c22d6e2e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/typeChip/TypeChip.js\":\"ecbb107f007ed039\",\"/knowledge-medium/pr-preview/pr-1639/src/components/typeChip/chipStyle.js\":\"01869c4b9d83a325\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/anchored-floating.js\":\"512c4d7669259734\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/button.js\":\"38bcd0eaba2a5d2c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/card.js\":\"e45ed12f3fb80824\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/checkbox.js\":\"492da9ad250ae10c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/collapsible.js\":\"910a47ca02733022\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/command.js\":\"73c7618c32679e1e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/context-menu.js\":\"785af0bdf25be6d5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/dialog.js\":\"0b1cc44ba0dc622a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/dropdown-menu.js\":\"32a65ce0e21213f8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/floating-listbox.js\":\"39cd77b5d587681e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/index.js\":\"60d067d5fb8672d2\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/input.js\":\"99a32c90e81a3c53\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/kbd.js\":\"5e9c29e810973816\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/label.js\":\"89b59831ef7c0dc7\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/textarea.js\":\"ed4e4ebe54400519\",\"/knowledge-medium/pr-preview/pr-1639/src/components/useEditModeYieldKeepalive.js\":\"412de974f82628be\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/BootFallback.js\":\"c31b6ca02f28e1cc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/FocusedRowLazyMount.js\":\"2ed70e8ba093322a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/LazyViewportMount.js\":\"927b1ce866c6bf23\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/LocalDbCorruptionFallback.js\":\"e8cacd5e1f8bd91b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/error.js\":\"608e93412cd02c8b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/lazyMountRegistry.js\":\"585bd2d02d2752b1\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/suspense.js\":\"b09e624fd1d5295f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/CreateWorkspaceDialog.js\":\"bbfe2c7285d7c29b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/PendingInvitations.js\":\"ba92876c14ec3d7e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/SyncProgress.js\":\"29446110b23dd92d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/UnlockProgress.js\":\"4953039c7f907fb9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceKeyGate.js\":\"6b53aeaf64dff9bb\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSettingsDialog.js\":\"741f08749375dfd4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSwitcher.js\":\"115c44fc02a5fa14\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSyncGate.js\":\"4e2b95752fb8186e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/ConversionFlow.js\":\"6df5518ebdd7b0ed\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/ConversionFlowHost.js\":\"81a46ebd9d0056e2\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/EncryptionSection.js\":\"03389694cb33c752\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/attachmentPrompts.js\":\"47ab5251a80357ab\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5da10e4b5a745dd0\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/conversionFlowDeps.js\":\"971887fb81fe9843\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/conversionFlowStore.js\":\"2c9a66b660cf5870\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/flowUi.js\":\"2cd6064f295c96ea\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/useConversionRun.js\":\"0da875f59ccc3039\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/keyUi.js\":\"44cbe5fbafb7e134\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/useCloseOnKeyLoss.js\":\"39933fbf66972fae\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/useCloseOnServerE2ee.js\":\"8509a08b6e524712\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/workspaceUnlocked.js\":\"89f5857af333cbf1\",\"/knowledge-medium/pr-preview/pr-1639/src/context/backgroundSubtree.js\":\"82a6dfa3390c35a5\",\"/knowledge-medium/pr-preview/pr-1639/src/context/block.js\":\"ab52dedbe42b2586\",\"/knowledge-medium/pr-preview/pr-1639/src/context/layoutWsContext.js\":\"159df1ca19b0228d\",\"/knowledge-medium/pr-preview/pr-1639/src/context/propertyDisplay.js\":\"2d324cd7a2dcf6e2\",\"/knowledge-medium/pr-preview/pr-1639/src/context/repo.js\":\"0b6d51145975ca00\",\"/knowledge-medium/pr-preview/pr-1639/src/data/aliasClaim.js\":\"b01c69d025eac115\",\"/knowledge-medium/pr-preview/pr-1639/src/data/aliasSeatNamespace.js\":\"ebc5c466ff15ce00\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/blockData.js\":\"040c6428fea6f60d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/blockType.js\":\"bbb6a4b947d31502\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/changeScope.js\":\"610352921cc1098a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/codecs.js\":\"97bdfc691f377f52\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/derivedData.js\":\"fff819346a103af8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/errors.js\":\"527dd07d0e6fc503\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/events.js\":\"bbc5e48236d2734c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/handle.js\":\"b012bd2f62916e6c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/index.js\":\"33a0ce9090c91948\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/mutator.js\":\"5849c16fc7fc4f6a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/processor.js\":\"9c7e351f0e515a20\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/propertySchema.js\":\"dec146255e75eeb9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/query.js\":\"b6054fbc315a6bd4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/sameTxProcessor.js\":\"a03968e2996e4421\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/schema.js\":\"b012bd2f62916e6c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/tx.js\":\"b012bd2f62916e6c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/typedBlockQuery.js\":\"1085d311692f5f2b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/user.js\":\"7875b74da40c6147\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/valuePresetCore.js\":\"09a308a93e89ac9b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/valuePresets.js\":\"d2cfd5cb3b42e5af\",\"/knowledge-medium/pr-preview/pr-1639/src/data/attachmentCleanerIOVerb.js\":\"1fc878fe29f601d5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/block.js\":\"f69a84b171eda497\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockCache.js\":\"3529e602ef676d3e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockId.js\":\"53ce6a70add2b5e8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockLiveness.js\":\"8c799bf53acff5ca\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockMerge.js\":\"c986cc0370e7a188\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockSchema.js\":\"dd9890c60918528e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockTypeLookup.js\":\"b43bc9fd7eeadf21\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockTypes.js\":\"137166caba94e8a5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/clientContext.js\":\"6efb809a969d4afd\",\"/knowledge-medium/pr-preview/pr-1639/src/data/dbFileSiblings.js\":\"517ce92b45d28f6e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/definitionSeeds.js\":\"d314947961594947\",\"/knowledge-medium/pr-preview/pr-1639/src/data/derivedIds.js\":\"c9a1d0462f4fb6b2\",\"/knowledge-medium/pr-preview/pr-1639/src/data/drawnSubtree.js\":\"6956e71531934281\",\"/knowledge-medium/pr-preview/pr-1639/src/data/facetBridge.js\":\"c948e8517d5c82dc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/facets.js\":\"4bee746ca542d61d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/globalState.js\":\"9c7c1d7fc4d52080\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/aliasClaimRederiveProcessor.js\":\"2eee747303bffffd\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/ancestorBatch.js\":\"cccbf483dfe02589\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/blockTypeTypeifyProcessor.js\":\"5e15e9ded4b6e015\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/clientSchema.js\":\"172b4f93d17db3de\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/commitPipeline.js\":\"838a75a11c4d2b36\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/devAssertions.js\":\"535ceaaf0a1066c4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/firstSync.js\":\"306288cc64a97933\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/freshInitialLoad.js\":\"4c95093167550c9c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/graphBackfillClaim.js\":\"0bae7065fd2e4da3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/handleStore.js\":\"5b1408a1e9be0d88\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/idleMarkerJobs.js\":\"75d57933b98f4696\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/initialDownload.js\":\"75887c18fc7940ed\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/initializeClientDatabase.js\":\"823dd15e67978178\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/jsonCanonical.js\":\"48d0cc82e3c5df42\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelInvalidation.js\":\"0048b85a2de72c58\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelProcessors.js\":\"36cbb702dcc0495e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelQueries.js\":\"d5f0dcc4e5771517\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/mergeTypeMembershipProcessor.js\":\"fc686bef993d1a83\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/normalizeReferencesProcessor.js\":\"47576e33f4d92602\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/poolInstrumentation.js\":\"7c307f6fb5a966dc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/processorRunner.js\":\"1849ad00a877047d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyCellBackfill.js\":\"4c5a88ca026721fc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyChildMint.js\":\"0e6e03e95669f598\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyChildrenProcessor.js\":\"9457c242bc39ff33\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a60ab7727d19960a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyDefinitionSynthesis.js\":\"6bf470efb98283f2\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyKeyScan.js\":\"562783e95d8ff0ea\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertySchemaResolution.js\":\"654d0da66cb519cb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyValueEdits.js\":\"91095f397a0f59f5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/raiseProtocol.js\":\"fe08a104b7edf426\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/readBatch.js\":\"d475627faa073e0a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/refProjection.js\":\"2ca067938c4258ab\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/referenceTargetLookups.js\":\"7f95ef4416383a7e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/referenceTargetProcessor.js\":\"143da3817543bc9e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/replayMerge.js\":\"4728ba21e4e46d4f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/sqlBinds.js\":\"58ad663cf75c9312\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"de5bf9d36cead8b8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/arrivalProcessors.js\":\"23fb00bb2a847e66\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/invalidate.js\":\"bb77e4f7c5572edf\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/materialize.js\":\"ee7d3411fd453305\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/observer.js\":\"71b5717dc535fcce\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/reconcile.js\":\"c559e1b5a6c756a0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/timingMetrics.js\":\"95684f97925e4ce7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/treeQueries.js\":\"6a343c0bcdc55519\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/txEngine.js\":\"25f68af991e8da2f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/txSnapshots.js\":\"8aaa1c458a0f46d1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/typedBlockQuery.js\":\"7ba9f87de2300596\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/undoManager.js\":\"9f0c9c3b5de24c73\",\"/knowledge-medium/pr-preview/pr-1639/src/data/invalidation.js\":\"02e2e0eb50cb8b39\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelDataExtension.js\":\"ed02dba46b2a4eab\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelPage.js\":\"b65c97dfa0d9ff60\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelValuePresetCores.js\":\"17b161c1e8571f0d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbCorruptionSignal.js\":\"efb07aecdfa977b4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbStorage.js\":\"a03e1e978243741b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbVfs.js\":\"17ff15db9070ce05\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localSchema.js\":\"8e1057196be91c41\",\"/knowledge-medium/pr-preview/pr-1639/src/data/maintenance.js\":\"4817f6257666397e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/mergeProperties.js\":\"5f742e0224b44f53\",\"/knowledge-medium/pr-preview/pr-1639/src/data/metricsConsoleHook.js\":\"031df093af94d54c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/migrationsPage.js\":\"f383d13acef0ee38\",\"/knowledge-medium/pr-preview/pr-1639/src/data/mutators.js\":\"3e2bae349e82738f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/orderKey.js\":\"5f4b10f2b09fe009\",\"/knowledge-medium/pr-preview/pr-1639/src/data/orderKeyPlacement.js\":\"051b8943db92bbc6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/outlineSurface.js\":\"ecdf37dad0862310\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pendingEditorContent.js\":\"d44dadda39b97db8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pendingUploadsSql.js\":\"0b94d4d5b3603dd5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pluginStateExtensions.js\":\"5d43fbb75ed261ab\",\"/knowledge-medium/pr-preview/pr-1639/src/data/powerSyncLogger.js\":\"af8d111700a650d8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/projectorRuntime.js\":\"bc8f96c74d6c7af6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/properties.js\":\"e290d892228cabac\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertiesPage.js\":\"77f1454759b3baf4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyChildren.js\":\"479452ead8914b26\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionFanout.js\":\"1491c3fe9ada55c4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionMetadata.js\":\"a3622d0d4f9eb26f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionRegistry.js\":\"2b985a5abfcc6300\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDisplayMode.js\":\"4138d1d76babc8c6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyRowCreation.js\":\"7b4a6b8ff9c7661f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertySchemaCreation.js\":\"f558e990fe93c84d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertySeeds.js\":\"ceb36574a5e8a750\",\"/knowledge-medium/pr-preview/pr-1639/src/data/recentsPage.js\":\"d1f15bfd73961311\",\"/knowledge-medium/pr-preview/pr-1639/src/data/referenceBlock.js\":\"959161eefc962f94\",\"/knowledge-medium/pr-preview/pr-1639/src/data/rejectedUploads.js\":\"5e8fda9bc6595cb1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/releasePowerSyncConnection.js\":\"19eb172473467e52\",\"/knowledge-medium/pr-preview/pr-1639/src/data/repo.js\":\"faf64354594a362c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/repoProvider.js\":\"458a80aea82a00b4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/rowProperty.js\":\"374ed1835ccf6545\",\"/knowledge-medium/pr-preview/pr-1639/src/data/searchFilter.js\":\"552b8f1a056b771f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/seedIdentityLedger.js\":\"5d67072cc469dc39\",\"/knowledge-medium/pr-preview/pr-1639/src/data/stateBlocks.js\":\"6a60f70e9f743a2a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/structuralEditPolicy.js\":\"496d5a3874f37f9f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/subtreeDelete.js\":\"81ec6f182a34a15a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncStreamLock.js\":\"b2f43af79fd550e7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncedTableSqlRecognizer.js\":\"5d60a6715cd2a87d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncedTableWriteGuard.js\":\"f8248e6509739ab3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/targets.js\":\"e021ba9016b545b7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeColors.js\":\"14035fe73a06c301\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeDefinitionMetadata.js\":\"7de8041634ca7f1d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeDefinitionRegistry.js\":\"084c8e809fdc44ac\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeExtraction.js\":\"290a0fe3705f3357\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeInitialValues.js\":\"ebfbfc6bcd73d3ed\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typePropertyGroups.js\":\"f99b9b633983fb33\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeSeeds.js\":\"4ac6df15a11fca48\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeTagger.js\":\"50478e7b361cc9e8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typedRecords.js\":\"1026bd9aaf91c96f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typesPage.js\":\"ca7195eaf72f708f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userPrefs.js\":\"3e1d668c6b397bef\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userSchemasService.js\":\"059b5bcf6fd8566e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userTypesService.js\":\"9503586acb7d55ab\",\"/knowledge-medium/pr-preview/pr-1639/src/data/valuePresetRegistry.js\":\"62b1acc4411cbb16\",\"/knowledge-medium/pr-preview/pr-1639/src/data/visibleChildren.js\":\"8c0a037765f38635\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceConversion.js\":\"47be5d1001b70163\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceFirstSync.js\":\"ef631f301beb1dce\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceIdNamespace.js\":\"26d53222340a8a9a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceSchema.js\":\"9ec7a3e71ecea203\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaces.js\":\"d65483c25f7eba04\",\"/knowledge-medium/pr-preview/pr-1639/src/data/writeAheadLog.js\":\"3c4281d62fc3ce35\",\"/knowledge-medium/pr-preview/pr-1639/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/BlockPasteShellDecorator.js\":\"fd74e194820fde4b\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/atTrigger.js\":\"6d3ad2a5e6a46cb0\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/autocomplete.js\":\"006d0344b80e9c77\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/codeMirrorExtensions.js\":\"81cabe0d383a62e2\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/contentFlush.js\":\"ef2dea6300f0482a\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/defaultInteractions.js\":\"ad330f69f5c81bd0\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/editSettleSignal.js\":\"fca57ad418f6c8d0\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/insertImage.js\":\"9164482c91de5ff4\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/referenceCompletionRange.js\":\"8bbef55bab478e03\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/referenceTargetTypes.js\":\"735dc852e4a64a43\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/syntaxContext.js\":\"878ff3e3b02ef040\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/triggerMatch.js\":\"048e8dbe174499a9\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/AppRuntimeProvider.js\":\"010daa2bf12cf7a4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/BlockFocusShellDecorator.js\":\"6cb896d2bfd76a5f\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/ExtensionRenderBoundary.js\":\"3852836cbe4fe4b0\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/PanelContentRecovery.js\":\"05e09e0810f0c993\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/apiCatalog.js\":\"6cf22301f9d095a4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/approveExtensionHere.js\":\"4576beec35179fe6\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/armedCutAppMount.js\":\"a300590c8a4b7984\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/batchableKeyedStore.js\":\"95b24e6b148056a4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/blockInteraction.js\":\"00418d2cda0de146\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/blockSelectionAction.js\":\"e8ddc83742323c66\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/compileExtensionModule.js\":\"3ce700b3d1c61497\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/compiledModuleCache.js\":\"dcd6edcb1bec0feb\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/continuousGestures.js\":\"0923762b67614f50\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/core.js\":\"e5b87a557b5dd655\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/defaultRenderers.js\":\"717f018b4ecf2ff1\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/definitionFanoutAppMount.js\":\"c743c5d7eea8f01d\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dialogAppMount.js\":\"443d75573a4a8f94\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dynamicExtensionSeeds.js\":\"4861cf9d5a23bea6\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dynamicExtensions.js\":\"94e1ed25753798f4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/exampleExtensions.js\":\"4499cf5bd5ca901f\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionApprovalStatus.js\":\"d6d499556e9cd4c4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLoadErrorToast.js\":\"e124c0423411c8ee\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLoadErrors.js\":\"747b80a559b6230c\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLookup.js\":\"36c698faa49313a4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionToggles.js\":\"33ce0ca59fb70db2\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionUtilitiesCss.js\":\"375d055eb4c2edc7\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/kernelPageDeletionGuard.js\":\"aba63eadc0f3fefa\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/liveRuntime.js\":\"0e302a9d14eca4bc\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/openExtensionsSettings.js\":\"122c1be5b78208bd\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/overridesCache.js\":\"7e4462efa5e2c8ed\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/pluginIds.js\":\"b72b91df98de3754\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/processorRejectionToast.js\":\"225eb16916d7a4af\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/runtimeActions.js\":\"98e5c2be60741a57\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/runtimeContext.js\":\"91fc179843c6a985\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/staticAppExtensions.js\":\"9a73c41db36fc3c8\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/staticDataExtensions.js\":\"55d386ee1c1038a6\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/toastAppMount.js\":\"f8d38bfcc5d86f5d\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/useOverrides.js\":\"7d0a1d2c25bdb9be\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/useShortcutSurfaceActivations.js\":\"64ca3fb60e897aee\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/discoverToggleTree.js\":\"4d6555b059f13e5d\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/facet.js\":\"f2ff6986ceabd80f\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/resolveAppRuntime.js\":\"a8733bfdd405b224\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/runtimeEvents.js\":\"d93dd9f437f53d24\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/togglable.js\":\"0c3ad97a21364674\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/variantFacet.js\":\"54893f087a903e9e\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/verbFacet.js\":\"b14de5ea1f8986ca\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/block.js\":\"f7b7cf00aa5f6e9d\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/focusedChild.js\":\"2480396f97b344d4\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/propertySchemas.js\":\"ede12359f2c96ca4\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/typeRegistry.js\":\"3e5f31aa54185a2a\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useAncestorCrumbs.js\":\"eb7f7045447def5b\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useAutocompleteListbox.js\":\"3f38fecdde5a1ed0\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useDebouncedSearch.js\":\"b2212c5225ac4e8e\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useDebouncedValue.js\":\"a0987c7636d52116\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useIsFocalRender.js\":\"b8349cdbf22c14d7\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useIsReadOnly.js\":\"bc85664f4820b310\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useMaterializeBacklog.js\":\"017f16e579d16b24\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useMinuteClock.js\":\"b43ed86a9bc3af54\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/usePanelLayoutProjection.js\":\"f31e7fa0e1dd9415\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/usePendingInvitations.js\":\"7c9f97e84bdb8fed\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useRendererRegistry.js\":\"ef895ac2002ed992\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useRetainedFieldRows.js\":\"d9e4e0e91cd3203e\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useWorkspaces.js\":\"dd59e5260db890e4\",\"/knowledge-medium/pr-preview/pr-1639/src/lib/utils.js\":\"a19efc9b60d5b590\",\"/knowledge-medium/pr-preview/pr-1639/src/main.js\":\"beeea69781e7f659\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/MarkdownImage.js\":\"90a6607b110607be\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/blockSeparators.js\":\"1217c5ab609ae392\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/context.js\":\"939d53b4a9b4890a\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/defaultMarkdownExtension.js\":\"eef48902895bc727\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/extensions.js\":\"df07265dbfc57c18\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/renderMarkdownHtml.js\":\"740a32570265d3ac\",\"/knowledge-medium/pr-preview/pr-1639/src/minimal-editor.js\":\"0cb6762aebb56cce\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/armedCut.js\":\"082e4481439f2aa3\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/captureMediaVerb.js\":\"2ff31e07d9ce9b08\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/clipboard.js\":\"aa8375e092ed76ee\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/decision.js\":\"7026cbc82f2bbef9\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/operations.js\":\"06a092dfc3f7213b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/account-header/AccountHeaderItem.js\":\"68beb9acc7f3b0b6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/account-header/index.js\":\"a25657328e4ad848\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"199daa8b71f43bca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/askAgent.js\":\"4732f9cece202003\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/askedStore.js\":\"33581db180706f16\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a9d333b77af3966b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/chipState.js\":\"4e26900469bd6ff2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ff4f8c27ca18c737\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/index.js\":\"226d6299aca2821e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b7b8c6a991c91e58\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/schema.js\":\"8dcb7ae16570fd95\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/AgentTokensDialog.js\":\"31970a7b4b87cafd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6bcc4a196f95008a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/addMedia.js\":\"8261e077c427aaeb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b596810f0e04964a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/block.js\":\"b74b22140db0e70e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/context.js\":\"6312903363d16675\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/displayIds.js\":\"bb2dd766e6508625\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/index.js\":\"b412ec980c6d69dc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/outline.js\":\"6eb529b9643f7edc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/properties.js\":\"62c6298a00d397e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/refs.js\":\"9fabd9f8a6613bee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"26d3b11180a4c4e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/search.js\":\"7c03520bbe62ce94\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/shared.js\":\"168b4ca39dba158f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"82af09899243c631\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/text.js\":\"2c698252cba15874\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentWrites.js\":\"f619ec8da33e23ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/authoringCatalog.js\":\"73b8aeb352e53b29\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/blockRefTargets.js\":\"a486375cb86f57cf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/bridge.js\":\"81ceaec90b2f4aef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/bridgeLoop.js\":\"6a0a7f98aecf4eb9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/changeHistory.js\":\"8869fea76b787358\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/commands.js\":\"f41cc6962ee5d0e7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/commentsCommands.js\":\"47792f0165dd6e5e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/dataExtension.js\":\"8a5a10ff950a0491\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/dataModelGuide.js\":\"b1e0a5bbe5cfdc1a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/describeRuntime.js\":\"550fb39c45a4ee53\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/extensionLint.js\":\"88450af1416ab1a4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/grainAudit.js\":\"4fab7aee9393fea9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/healthCommand.js\":\"45f8ed10937e2f02\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/index.js\":\"1bde7a42532f1691\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/presetIdentity.js\":\"8438b69cb8c8dc61\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f097363aa80ef53e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/readMedia.js\":\"db12889defa3a44e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/schema.js\":\"1f4c21b30d12d23e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/serialization.js\":\"379aad041c025d7b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/targets.js\":\"fda8c59997f023cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/tokens.js\":\"c7f81e1384e363b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/watchEvents.js\":\"8b7b36f41618e3cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/workspaceGuard.js\":\"39fc286a72f13773\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/writeCommands.js\":\"da89bd1029e69fe2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/AliasCollisionToast.js\":\"396a7340eada0d21\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/DuplicateNameBanner.js\":\"0847e315ebae3332\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/collisionMerge.js\":\"0d65648340b117a5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/dataExtension.js\":\"5edf640f2a433f5b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/index.js\":\"1dbfc4d99dd804e7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/mergeCollisionAction.js\":\"0fa1165a4eb8be83\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/pageStyling.js\":\"b177dfb765f08ed3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/rejectionToast.js\":\"6939cd739210c08d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/syncProcessor.js\":\"34ddc45045ae1ec8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/actions.js\":\"00990bd855a80a1c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/addComment.js\":\"cfb53f9354c4c283\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/anchor.js\":\"c8fac268f0e37ee7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/anchorState.js\":\"bf1c0ccb5262c349\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/commentLinks.js\":\"8826cf20f4a6a235\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/confirmThreadDeletion.js\":\"c1cda9c11145197e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/container.js\":\"d3271001f3cf39e9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/dataExtension.js\":\"81a53794f9b729ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/deleteComment.js\":\"b1de75ec97c57d2a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/highlights.js\":\"1490c44f72a15506\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/index.js\":\"2ea6316df03c9485\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/linkedCommentsPill.js\":\"c9ead90ccebdfb57\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/margin.js\":\"b63b0da22e29a124\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/marginSchema.js\":\"91df9ee972810581\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/newComment.js\":\"c0c175e5946fd24e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/ownThreadPicker.js\":\"b1fd25bb6f424a3e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/placement.js\":\"ed911fc174917b8e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/queries.js\":\"e3f848a1d64daa53\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotePosition.js\":\"e68922d12c5702f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotedIn.js\":\"64ee34a37df7c8e7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotedRange.js\":\"68112d3ef2e9aed4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/rangeRefs.js\":\"2274745db11c1bec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readHighlights.js\":\"5f5935179de8ed92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readSelection.js\":\"2da536fd87e1e1b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readSelectionUi.js\":\"61f4f0618a3c2f19\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/reanchor.js\":\"5176d9518a391397\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/schema.js\":\"696dbe037aa33250\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/scope.js\":\"06243d70b89ef54c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/scopeThreads.js\":\"1af400156f526341\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/splitRetarget.js\":\"fd82404bbff90a5c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/suggestionCard.js\":\"3d4443bdb66feeaf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/suggestions.js\":\"e7d436a0ffb5cb4b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/summaries.js\":\"bce925e16ec095fa\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/summaryBatch.js\":\"fb293d75e39f6a3d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/surface.js\":\"f984c80538b80383\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/threadNavigation.js\":\"678c6453cc78d41e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/threads.js\":\"6f8644d856636fe9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/ui.js\":\"ae85222da12c173e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/uiStore.js\":\"c6ed5a1396e6104c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-intents/appIntents.js\":\"99c37c1e3fa6f009\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-intents/index.js\":\"ba9de0faab116c48\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-update-prompt/index.js\":\"b99b69738370dcb4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-update-prompt/status.js\":\"56e07a80c9dd5f6b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9e051221e22a3ba0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaBlockRenderer.js\":\"3e682ffd50a2a522\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6197efec183cef4f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaUploadReconciler.js\":\"b8320b698ed54017\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetDownLane.js\":\"05878d82a9403e03\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetResolver.js\":\"348a71e33805e446\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetUpload.js\":\"0c92ab7585c07863\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/attachmentCleanerIO.js\":\"392a370e862eaca6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4f8e11271ee837de\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/blobStore.js\":\"7e55591a3dbd72d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/byteStore.js\":\"f56691bb5a346c2a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/cleanerIO.js\":\"6a09f0a956b6c795\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/cleanupAttachments.js\":\"f3cb137cdbfb4b35\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/dataExtension.js\":\"e04cd521efd484b8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/downLane.js\":\"6e236e5f71ba783b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/index.js\":\"2d7a1649433d3520\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/insertImageContribution.js\":\"1d86605da4988ec9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/laneArming.js\":\"b86654bfaa5b8e23\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/laneLock.js\":\"e3c783cda0a22d55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaBlock.js\":\"b791778b93f6e808\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaCapture.js\":\"a3f39b6da19b5f44\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaViewers.js\":\"9f7ab45006de9e3e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaViewersFacet.js\":\"70363e85975e5045\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/pasteCapture.js\":\"173aec32b874c6e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/resolver.js\":\"9a5bc627956746d2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/retryUploadsAction.js\":\"d82e41368ba8c439\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/storagePaths.js\":\"da0ebf70708b4c02\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadDrain.js\":\"5687f91306bf2be6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadLaneStatus.js\":\"21f4a53310d6fdda\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadReconcile.js\":\"7423bf2bfb4715cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadRecovery.js\":\"93edb004779ad9cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadStore.js\":\"abdbe397ec84d478\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/useAssetObjectUrl.js\":\"1578433774119755\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a139eb173d5dc96b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f2f70771d0f8b032\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/facet.js\":\"3cad145300d68bbf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/index.js\":\"1b71a60ef3ff7e55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/prop.js\":\"b7c1f7f1c1b069f6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BacklinkFilters.js\":\"c740915e6a36ff6b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"21cfa0789ce3de6f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BlockEntry.js\":\"2b232a2ca1a85c71\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/LinkedReferences.js\":\"d4c857e7a85b1e2a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"df615535ba1eaa57\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/dailyNoteDefaults.js\":\"9d234da77aaf5ca6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/dataExtension.js\":\"31045b678f1740ce\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/edgeExclusions.js\":\"35dcf89b261466fb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/filterProperty.js\":\"7a7cdedd3ef6c32a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/index.js\":\"39b7d0bbae437b1c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"22d32bd4f8b71463\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/applies.js\":\"bbdc82f7c511801a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/countQuery.js\":\"46acc66f81f65c49\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/expansionStore.js\":\"25f06594c74c95ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/index.js\":\"a08b8d23bc11604d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"58533c1a07188e55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/presentationInvalidation.js\":\"720a1f728513e125\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/propertyEditorOverride.js\":\"dc5a6d39ffef6497\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/propertyFilter.js\":\"aae69438b0448d16\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/query.js\":\"0e2c3852c5492377\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/resolveFilter.js\":\"e049b2efcd0e043a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/sourceBatch.js\":\"886716b7ab807ee1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/sources.js\":\"75037c98ef3419f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/useBacklinks.js\":\"e3866ecc8047369e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"28820efd29d4946a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/BirthdayCelebration.js\":\"6497a2a9bb1fdf08\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/BirthdayOverlay.js\":\"c886bc840b099792\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/gate.js\":\"2abed9a637b3cb0d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/index.js\":\"b7d0dc6e2fbe7b30\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/wolfTheme.js\":\"1b39baaa0d2d05bb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/BlockDragLayer.js\":\"8a6d919a25f55ff3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/dragController.js\":\"58c641a6cf4eea38\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/dropTarget.js\":\"59e7ca57ae45ce19\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/index.js\":\"8391c4477bcf743f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/projection.js\":\"db548f85e000c5ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-info/BlockMetaCard.js\":\"ecddd161bfd59f00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-info/index.js\":\"17f9f15e9b2d1518\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/AddTagDialog.js\":\"157b727bd5a918df\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"960c455cf8a75f96\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/TagNameIssueHint.js\":\"d4d6635c36f33aa0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/addTagAction.js\":\"d68e214f825bbfb6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/appendTag.js\":\"e45520cdb3b38c33\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/config.js\":\"8534d12775bfc7c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/dataExtension.js\":\"1813a06a21cf2aee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/index.js\":\"e2f5d6aec2d82e1d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/propertyEditorOverride.js\":\"1bdca4c78c1f4bc2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/BreadcrumbList.js\":\"03796518778dc51f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a190135f3605d957\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b2acffe68bf6ca60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1791d9f549e9420b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fbc0513a74aa0192\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/index.js\":\"7df7fa79e6e6d0b8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"80a76be60fbc5e7f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/CharacterCountItem.js\":\"21f17b05d0be169e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/ProfilePropertyEditor.js\":\"43077ed9b81c6e63\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/actions.js\":\"084f849c48863ecf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/blockType.js\":\"2155c456b0a64ecb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/charCount.js\":\"1d31730df6bb6b78\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/dataExtension.js\":\"81ac575aa8d0d14f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/index.js\":\"25f6376045f04348\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/profiles.js\":\"c8386ba6225a2022\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/properties.js\":\"86873d38b258ca1c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/textCounts.js\":\"eeb085378620f698\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/colemak-keybindings/index.js\":\"b10c26c77e267e9a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/CommandPalette.js\":\"bf7a7bf60fc44b8e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/HeaderItem.js\":\"cd73bcbc327dfc59\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/context.js\":\"81c11b8471b3cd04\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/index.js\":\"eaf723b18c1b7013\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/selection.js\":\"aed811926b7db354\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/toggleStore.js\":\"74d6d7176d42cfea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/useCommandPaletteActions.js\":\"b958af0e2079587a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/ContributorBadges.js\":\"c5429fb6d6e96c09\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/author.js\":\"8884c37a15087a40\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/codeMirrorExtensions.js\":\"cbbeaf3787e2960a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/dataExtension.js\":\"8bb14fea44b2d3e0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/index.js\":\"4002ccd305f20a02\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/mentionAutocomplete.js\":\"bba1e96c46161846\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/processor.js\":\"7b2a9d0e59d30307\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/profiles.js\":\"c3bcf99deffee0e9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/queries.js\":\"d047d7228f032172\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/schema.js\":\"8bf2e8ac77a31c79\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"340de8f122681ab4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b805810e3b1f50fa\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/index.js\":\"020f1130feed81ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"398cdc6dbd7a4097\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f199fcd89dd896c4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/CalendarGrid.js\":\"751aed3146299586\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DailyNotePicker.js\":\"d8107a5f7d3a0222\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"34d8c2d4fee6c870\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateNavDecorator.js\":\"0b809a81304620fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateScrubOverlay.js\":\"dfca9877b8bcea0f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/HeaderItem.js\":\"8a82dc6e31b322f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/ReschedulePicker.js\":\"f5bac7aa29f6e834\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a1c7b8aaf99db94f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/actions.js\":\"bc4cad0438a45100\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/blockDateAdapter.js\":\"0144087b9d632c43\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/calendar.js\":\"1295328e44c1c40a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dailyNotes.js\":\"4669d7ca0b4f0801\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dataExtension.js\":\"f65ad973f736dc95\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubActions.js\":\"4144ee1fd6cb37a7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubGesture.js\":\"13d8a07f27abc844\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubGestureActions.js\":\"23cec576551bbc8c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e024d7938e3a8d4c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/deletionGuard.js\":\"4b381fa788f048b3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dueQuery.js\":\"4e9d64fbb20009be\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/index.js\":\"dbc301b61e78c00b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/landing.js\":\"9dca744a6ae65d01\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/localSchema.js\":\"3e863382e58d169d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/referenceDateAdapter.js\":\"c90a964edf704e03\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/rescheduleAction.js\":\"05a22dd7ebf52560\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/schema.js\":\"cd37a9fd7752b8fb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/spreadBlockDates.js\":\"ba797f7a46aaffa8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/spreadDatesAction.js\":\"17ecb4598c0ac73f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/today.js\":\"fa316656bb342a80\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d70728ec3ddb25eb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4cc4f7e2fa2b0249\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/audit.js\":\"ad236fbb85128900\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/auditAction.js\":\"2f68a696cef3bd0a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/auditRanges.js\":\"101fcea314af34a2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/diagnosticsSource.js\":\"9c0ddb9c3bcee26c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/divergenceScan.js\":\"b2a1581c7b1afa39\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/index.js\":\"89df93e97e6afb71\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a38c1ee85f08e119\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/referencesMirror.js\":\"b434aeb939b1e544\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/rowJson.js\":\"3e6bcb6f0182877d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/schedule.js\":\"4073828e3e1a4716\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/store.js\":\"fd913fcd68f489a8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/action.js\":\"c004010048b70e3f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/index.js\":\"d6eade903787459d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/plugin.js\":\"5b5112672eec7174\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"84fecf8ad3a61474\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/actions.js\":\"ca1ecd6a1c1743c5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/changeMarker.js\":\"8cf10ff41753fce9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/diagnostics.js\":\"c0027297a48c3491\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/fileSystemAccess.js\":\"5693e913e9ca6397\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/filenames.js\":\"9e830f52f77ecb13\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/index.js\":\"0e440466b479b0ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/mirror.js\":\"9aa74223d56410b2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/runLock.js\":\"b01d5738c7adf307\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/runtimeHealth.js\":\"37b68dcc5536e80b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/schedule.js\":\"d6d1520ee23df4da\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/store.js\":\"283f7230afaa4603\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/default-themes/index.js\":\"8dfe07a5f3c83868\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/default-themes/themes.js\":\"9f8694cd989fa6cc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/diagnostics/facet.js\":\"89069eeb6aa3bcec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/diagnostics/useDiagnostics.js\":\"1d29182806c1a50e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/dismissals.js\":\"6bc2bdcf2b809db3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/index.js\":\"2d7312baa76007d7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/status.js\":\"3cd452070e8aa695\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/store.js\":\"629be1c74b05d69a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"53721edddf82b905\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/ExtensionsSettings.js\":\"431a6825453f9b99\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/actions.js\":\"57e232a63aaa89e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/config.js\":\"943c49cbaea5d18a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/dataExtension.js\":\"0d9646ad7e4012f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/effect.js\":\"4b32b10691cdadc6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/index.js\":\"0eb6aca13ca514d5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3a849330ba81d4bd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/useToggleTree.js\":\"b3f25f32d00e679a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/ExtractTypeDialog.js\":\"c4864d0381f3b66a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f7f05301c69a16a2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/PropertyShapePicker.js\":\"08edef13c4cf4743\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/action.js\":\"79f68b8c4447ab06\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/index.js\":\"e004e8537662943a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/FindReplaceDialog.js\":\"18860daed6fa54ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/HeaderItem.js\":\"04706133ca096ca4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/dataExtension.js\":\"1419f30a8bc905b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/index.js\":\"fd7de5c2a580e8d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/search.js\":\"3684ddacc0e9e552\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/toggleStore.js\":\"c6dc26d339b3fcbe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/LocationPropertyEditor.js\":\"9aab4f2afbf335ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/MapView.js\":\"e564cfe2e465fbbb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/blockTypes.js\":\"99503c25a8eb54e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/codeMirrorExtensions.js\":\"15dea0047f06f3b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/createOrFindPlace.js\":\"73a96452b2189497\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/currentLocation.js\":\"fe2725a148f1aecd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/dataExtension.js\":\"471245772703e9bf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/geoContentDecorator.js\":\"7dd76c45da488235\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/googlePlacesClient.js\":\"8d3d73861863a8de\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/index.js\":\"8f10e4a241206233\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/locationsPage.js\":\"c8bc7b4486a195f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/mapViewport.js\":\"ba42ed1dfb9f2b73\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/pickCurrentLocation.js\":\"c9357d01b1af1a42\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/placeAutocomplete.js\":\"a4151e69dff30520\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/placeNameCollision.js\":\"9e2d6dae216653f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/properties.js\":\"12300ed8e8c33c5a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/propertyEditorOverrides.js\":\"67c7939c3263c063\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/query.js\":\"b03da269c616ebc9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/usePlaceSearch.js\":\"c8d127cd4c9c4720\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3e2729c9f834ebb3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cc2370c8cafc4bf2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"273bdb3eeeff6048\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/config.js\":\"ae4fae4d80bb9f79\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/dataExtension.js\":\"2ce56522fb031a81\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/facet.js\":\"ff027d6c7509b2de\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/grouping.js\":\"6e7885f51bdd4286\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/index.js\":\"e0027d79f7998b14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c870e9ce23efe308\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/query.js\":\"78af07b2d79de72a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/resolveConfig.js\":\"d0d7d7253b4a7a45\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bfd7b90fdbc99c7c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6613660ccd3c09e9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/HtmlDocumentContent.js\":\"805d5926ccb40068\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/HtmlFrame.js\":\"88f2f5909a33e6a3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/actions.js\":\"341cee7fb257a6e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/blockType.js\":\"ec8cf75e5004b9a7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/confirmRunScripts.js\":\"4f27560cc7ad8378\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/dataExtension.js\":\"bc71ad92c548cd73\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameAnnotations.js\":\"7daa01d6e195cef8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameDocument.js\":\"5da19b4b12deb5f1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameTheme.js\":\"c9df589bd37dcda5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/index.js\":\"c3f90c5c05cdadb5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/scriptConsent.js\":\"6cee5aeb1008f0a1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/sourceMap.js\":\"b22f256eb4d02e84\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/useDocumentScripts.js\":\"a1a3d216bfe10f96\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/index.js\":\"604a28956a0a07c6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/record.js\":\"d72d39d5c5c1bb0b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/recordStore.js\":\"1048b40ac0c02240\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/responsiveness.js\":\"9e27aa0d6a978b2d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/schedule.js\":\"346292661ed711a5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/sessionContext.js\":\"1b203675e371e0a3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b010c993733db939\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0ff12e90e4c1c14f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/actions.js\":\"6bff88de81bf02e5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/config.js\":\"6683506b9ef4ab3e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/dataExtension.js\":\"a2600dd455669d52\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/effect.js\":\"4637b516de509287\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/index.js\":\"554842e9750be0a9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/keyCapture.js\":\"bd2141f184e005e5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/overrideStore.js\":\"c05d3f22956376b6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"40926003db1108c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/HeaderItem.js\":\"f8ae53e2e2bfb624\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/LeftSidebar.js\":\"842b7a2254188c96\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/actions.js\":\"98e1570742dd0dba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/facet.js\":\"ce16df2bd049aa45\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/index.js\":\"6f14f1873f820d6c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/shortcuts.js\":\"cae7cc8bdad96ee5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/toggleStore.js\":\"b5fcc89392207762\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/MergePicker.js\":\"9913fa3fd1c20768\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/index.js\":\"f8a799564ac64b12\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/mergeAction.js\":\"68c020bca12986f6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/strategy.js\":\"36a3b8a59371b4cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/Button.js\":\"4c500d73e26b19ee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ab4128990267ffc1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f6219369a82c3854\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/facet.js\":\"722c7da897a55467\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/index.js\":\"40a74df61c66f35d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"83abc13c7f8597ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9422f83714fd7974\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cbe788bd8ac20653\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/facet.js\":\"05a715dc2de43907\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/index.js\":\"75125b5f6f07e2e7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/MoveDestinationPicker.js\":\"736054096778c153\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/blockSubtreeMembership.js\":\"879bc932b5f5e27e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/contextMenuItem.js\":\"be2151adf7fe4807\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/index.js\":\"1c88d14fd730fa16\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/moveAction.js\":\"86db074263229658\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/moveBlocks.js\":\"b46b9cde8c5a6e6a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/selectionAfterMove.js\":\"5c44e5e84b7727ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/TutorialBanner.js\":\"554fa0a3aa78db88\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/action.js\":\"214e19274888e83e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/bannerDismissal.js\":\"d27b70de268fe7b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/documents/cheatSheet.js\":\"386e636923668571\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/index.js\":\"cc6ce580ff4f5fdd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/keys.js\":\"f73c620254930770\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/landing.js\":\"d7830ce6aab50324\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/outline.js\":\"14aa9b5e9e27ece5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/seed.js\":\"d3c493b3e54be2bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4f616396dbd00031\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/analyze.js\":\"72e3392819f69194\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/diagnosticsSource.js\":\"dec1081f7b18f68b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/index.js\":\"3eabd690a0135aef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/load.js\":\"ef025daca8ede489\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/monitorRun.js\":\"97cf30d7ebcd1e00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/schedule.js\":\"c625a82e47c961ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/series.js\":\"470e20d5fb5c1bc0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/store.js\":\"513c362071190644\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/trendAction.js\":\"8fe3efd50b3c2299\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/verdict.js\":\"429dac872352a2c5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/clickToEditAction.js\":\"ad7b9c5dd8ccfad4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/index.js\":\"980a9206f5e8564a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/interactions.js\":\"3e297fc8cff19951\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9bbb2beb5b6d19d2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/MigrationGate.js\":\"34e69425a6435dd8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/MigrationGateDialog.js\":\"2c936b482ef91829\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/action.js\":\"47614930f892de71\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/index.js\":\"02b1565f7fc5d49d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/localRunMessage.js\":\"787523bd93cee7e7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/plugin.js\":\"72f86602a84a8f31\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/progressReport.js\":\"82d07f7bdfe23f81\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/sweepProgress.js\":\"4d48baa2024644f8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/FieldRowRenderer.js\":\"d8ee8505067e5e78\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/ValueRowRenderer.js\":\"646e62feb4784ea7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/actions.js\":\"59da94fbf817eb4f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/autocomplete.js\":\"bd76dd6b71d87f2c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/fieldRow.js\":\"7b2bce4420d28030\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/index.js\":\"24df530406bdc86f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/referenceWarning.js\":\"f863748e75dddb6c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/valueAutocomplete.js\":\"66a3af8c2c9de62f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/valueSchema.js\":\"fa12ffbfa8edc38e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/HeaderItem.js\":\"e48907b2a98439e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/QuickFind.js\":\"d5216a3563908424\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/index.js\":\"46ef3f13d3394e3b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/recents.js\":\"a286ad169c1766cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/resultItems.js\":\"108e7d1e25e96e37\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/selection.js\":\"c87a313292219388\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/toggleStore.js\":\"cc83b2a8ff16a22e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/HeaderItem.js\":\"9f9bbbf9073cf9b1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/RecentsPageBlockRenderer.js\":\"05347d742a3d6bc5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/grouping.js\":\"c1bd913e482ac14a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/index.js\":\"9f58999b33284622\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/target.js\":\"3b3c56c0bb067e54\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/codeMirrorExtensions.js\":\"085ab15bc7ce957a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/contentPrefill.js\":\"f386640fd7f6014d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/dataExtension.js\":\"0733d7c04349bf35\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/index.js\":\"387613ade4daf371\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"002d286bdfb80cde\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/invalidation.js\":\"a65e50797818c622\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/localSchema.js\":\"61f9d88d70b07391\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/blockrefs/index.js\":\"183cf2a9e36fdd3e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0577d80d19ef3c0f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/index.js\":\"db04d486a1152c08\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/referenceNode.js\":\"18a381388b8f2287\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f8a66a67ca10c261\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5da27c0b13c640cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/index.js\":\"27f1359b39d96dd4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"91e8e475e04c8fa5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5bdc7b72ec9eaa57\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/mergeRetargetProcessor.js\":\"656b144f781fbd49\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/parseFence.js\":\"1e5a88d6182863df\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referenceParser.js\":\"76aa7c1107dfbbf2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referenceProjection.js\":\"56982120ad483bda\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referencesProcessor.js\":\"aae3576310f49eb3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/renameProcessor.js\":\"9cc5476af0565b6e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/spanReplacement.js\":\"000d9e960ef69a05\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/htmlToOutline.js\":\"2c4b01926bea262e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/index.js\":\"2fa595646776bc85\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3f65063abf6e6cdb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/pasteDecision.js\":\"8153e90fba02e015\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/action.js\":\"e93ba5a41e87fc89\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/blockIds.js\":\"fa6d5bec486dec16\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/content.js\":\"955bf1fc910c8cc7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/effect.js\":\"d0c129c64c61e661\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/ids.js\":\"83be78a839d04ece\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/import.js\":\"c50bf6d799231e7f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/index.js\":\"9adaa643712fbeb1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/plan.js\":\"7e2c609d45fa7fdc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/plugin.js\":\"884bbdd9ab3b8195\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/promotion.js\":\"e88ea270fbe2498d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/properties.js\":\"fceb2d103d6c8b92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/references.js\":\"1a78ae0a1239000f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/report.js\":\"38017014b422fb53\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/roamMemo.js\":\"9ddceda74d3b468a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/runtime.js\":\"f636e8c792e5d0b7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/schemaReconciliation.js\":\"ff798613aa191754\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/srsMarkers.js\":\"eeccaf14cd975c66\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/todo.js\":\"2ddbe2df54f447ba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/typeCandidates.js\":\"ff46b50d7f32c783\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/types.js\":\"92dfa1cadec7aab7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/search-health/index.js\":\"a67c0fd22ec1b57b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/search-health/store.js\":\"213f50e7b31ab54c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/HeaderItem.js\":\"ce31a932aa53a481\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"be33ab24112491ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/index.js\":\"8d52619444cbfd9e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/model.js\":\"e1854d6904589d17\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/toggleStore.js\":\"0306d52f11bcbc3d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/useKeyInspector.js\":\"20e15e0880629253\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ecdd0391557535ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/ShellDecorator.js\":\"ab5dda92c0ee93bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/actions.js\":\"e380c7fe4fcce0c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/exclusionsFacet.js\":\"021ac96f64a176f4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/index.js\":\"bca5183925013ab7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/shell.js\":\"4e7e140a49b399a6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/surface.js\":\"c55e400c2e56a454\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/walker.js\":\"4869b760a9670ad6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f9076867670154bd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/dataExtension.js\":\"1c5a3431b818e4e5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/index.js\":\"73732a85c03cc589\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/indicator.js\":\"7cd9a764b4726cfe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/moveSrsState.js\":\"bbc5b34d8c779955\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"35322f21f3594f03\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/scheduler.js\":\"4bd8a1bfc44312e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/schema.js\":\"8992f6dab8c5ba76\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8229344a53df9cf2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/srsClipboard.js\":\"bb1c972e1ffcb291\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c33c1775c684fd31\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/DailyNoteReviewHint.js\":\"16faac13461377f8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/DeckPicker.js\":\"a0578c54bebdb9fc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewControls.js\":\"07f1bd5267a16e21\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewDeckRenderer.js\":\"44e47c5a9bce500e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewSession.js\":\"162b8895c496e00c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/actions.js\":\"1d44537b3799b57d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/archive.js\":\"2950e7edb4c0b043\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/dataExtension.js\":\"f83beaff7ae67d00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/deck.js\":\"9bc6cfae2482cd72\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/dueQuery.js\":\"ad3eb2f86571b9e2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/gradeDecision.js\":\"c2c226baa3807974\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/index.js\":\"a8c9bcc318ff2fe2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/keyHints.js\":\"54cd6de3e33f4396\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/reviewCardLayout.js\":\"7e5d1c4eb39b1756\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/reviewProgress.js\":\"eff0bb93fbe2a3b3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/schema.js\":\"4ee0df5424f7ea0c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/useDueCards.js\":\"558bb4060d7b2b5e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/startup-metrics/index.js\":\"b3efd7f2bdca86b9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/startup-metrics/record.js\":\"a36718a3d4ada186\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/index.js\":\"9e4516959e144a21\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/persistenceStatus.js\":\"3a3c32ef1ee823fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/requestAction.js\":\"3b2e688047fbeb0a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/TypeChipsDecorator.js\":\"eadc64c08da643be\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/codeMirrorExtensions.js\":\"529ad5fc8fb4aa3e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/index.js\":\"4e46bb1fa8370820\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/typeAutocomplete.js\":\"33af1fda5bab3451\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9ae8a9556aee65be\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/actions.js\":\"175c97b111b1e397\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/anchor.js\":\"6fa052879b0c17f6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/events.js\":\"3d19af146a56013a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/gestureActions.js\":\"db67b99f7325643f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/index.js\":\"4c665c674bdfbbce\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"07651cff22dbc232\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/collect.js\":\"30bd66aa18a56cfe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/index.js\":\"d1270efcf046014c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/record.js\":\"64f2bd2c403dd755\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/RejectionDialog.js\":\"41e52e7111a7ab4a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/SystemStatusHeaderItem.js\":\"73ad6678dfd9ab01\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/index.js\":\"c191410ba0a14546\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/model.js\":\"b59e9fe08bf68dec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/queueCounts.js\":\"9824202e0998ee53\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/rejectedHelpers.js\":\"0e7619d556915ab0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/rematerializeAction.js\":\"f1205ce7077cfb74\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/useHysteresis.js\":\"2d865884bc8510d1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/ColumnHeaders.js\":\"e618a2466a925813\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/QueryUi.js\":\"f5ca8e6b841659f9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/TableLayout.js\":\"1368e9416a187f60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/actions.js\":\"44ccf5900d075153\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/cellEdits.js\":\"2570f860f87f87d5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/columns.js\":\"459c0f707e8272c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/controller.js\":\"3f332fe8695a9893\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/convert.js\":\"f508c2faf6981f74\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/dataExtension.js\":\"a43bc3fb3e70357b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/index.js\":\"eef140c15b1a54f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/keys.js\":\"ba367f85376c497f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/model.js\":\"ff8a078a72b22bd3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/navigation.js\":\"c6fb7d62bf51b69a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/backfill.js\":\"61038e37ee99f6c5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/format.js\":\"0b2c43614d29c79a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/parse.js\":\"2d99631fde0e3845\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/queryValue.js\":\"e9d25e423e394f22\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/source.js\":\"005356c2967908cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/registry.js\":\"73d303c1dee7645c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/rowGutter.js\":\"ef66f3381986f175\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/rowVerbs.js\":\"85aff094bdd9cac6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/schema.js\":\"f78ce8591c53e84d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/sort.js\":\"81c738fd7500f042\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/effect.js\":\"aa1a710065042808\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/index.js\":\"04dd2b56642193df\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/theme.js\":\"84899f4005fd0498\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/actions.js\":\"77c483cdd6088dd7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/dataExtension.js\":\"e040743e23323b1b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/index.js\":\"14f132d19a18a2b9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/schema.js\":\"156add94bf212eab\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ccbe18b8d56e864c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/actions.js\":\"8eec1f90065a082d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/defaultItems.js\":\"fa038c2b0f313c54\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/facet.js\":\"270ce073e431e5ba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/holdRecognizer.js\":\"cfad945134291883\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/index.js\":\"2665499016040578\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/UpdateIndicator.js\":\"d6ef6e181924676a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/index.js\":\"584465ee585a6ca6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/loadTimes.js\":\"b9fa94ecfa7c95b3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoNotesRenderer.js\":\"ad5489d8d177567d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoPlayerRenderer.js\":\"d132ccf42a816891\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoTimeStamp.js\":\"c47623f2454f5088\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/actions.js\":\"d27f203d741da873\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/index.js\":\"9078dfd75d4005dd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/markdown.js\":\"c725f740a4fe6c0a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/notes.js\":\"265e8234b259086a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/registry.js\":\"ad1a364d998dab34\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/remark-timestamps.js\":\"a3d8dbce01f09db2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/view.js\":\"31ad51725a943f2d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/LinkHints.js\":\"2f85527d65e0c63d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/index.js\":\"375e3edd285e0a4b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/model.js\":\"70ea0c3aae526d66\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/settings.js\":\"00c96ee6c75a86f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/actions.js\":\"15a7ec11db0fde6c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/index.js\":\"ec7308f92e60ac58\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/interactions.js\":\"ff828caf18ab6a4a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/workspace-header/index.js\":\"0dc694169c4d2439\",\"/knowledge-medium/pr-preview/pr-1639/src/registerServiceWorker.js\":\"f8a63a852eba1241\",\"/knowledge-medium/pr-preview/pr-1639/src/requestPersistentStorage.js\":\"6065e31c7dd570dd\",\"/knowledge-medium/pr-preview/pr-1639/src/services/authRequestDeadline.js\":\"6d30fc91aa51eb11\",\"/knowledge-medium/pr-preview/pr-1639/src/services/authStorage.js\":\"12ace9384a56e532\",\"/knowledge-medium/pr-preview/pr-1639/src/services/powersync.js\":\"d606f82fd188b8f7\",\"/knowledge-medium/pr-preview/pr-1639/src/services/supabase.js\":\"f35fc11ec5796703\",\"/knowledge-medium/pr-preview/pr-1639/src/services/uploadErrorClassifier.js\":\"98b776e53f2610fa\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/ActiveContexts.js\":\"c7e7c8403caef9f2\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/HotkeyReconciler.js\":\"8cf25ed786406ad6\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/WipeLocalDataDialog.js\":\"61a218718c926097\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/actionDispatch.js\":\"d34c5fd4b8cc944e\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/actionRefItems.js\":\"83526e4eca760f9f\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/applyKeybindingOverrides.js\":\"fdbacf1aa913b120\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/blockActions.js\":\"1b48a6a4f7cc3097\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/blockMergeGesture.js\":\"64d4c7cfc7aa19ad\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/canonicalizeChord.js\":\"2a615598e6608a81\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/defaultContexts.js\":\"ff850a0ff33533ab\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/defaultShortcuts.js\":\"baf1db44b8f524d0\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/effectiveActions.js\":\"9def76269cabf7ea\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/gestureAction.js\":\"ccf543039166b31a\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/gestureBinding.js\":\"5a2aa99c65db091d\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/holdRegistry.js\":\"2b610c237f85599d\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/keybindingConflicts.js\":\"ef6fb93a65daf8c4\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/keybindingOverrides.js\":\"a3336425ee399256\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/pointerAction.js\":\"d82371a0fd6f14d0\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/resolve.js\":\"3cd2e8b73e6232e8\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/runAction.js\":\"1c99246ff29c9d13\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/sequenceMatcher.js\":\"d7375286e58d68e8\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/types.js\":\"fb1b22ef7a13e802\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/useActionContext.js\":\"039317ee6a1482e9\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/useActionDiscovery.js\":\"2b34455f257eb0ea\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/utils.js\":\"7f958032df29f646\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/bootStore.js\":\"2a3fed896dedee46\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/previewDatabases.js\":\"8ecbd089bf2b0430\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/byteTransform.js\":\"5d1e8e318c56e8cb\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/attachmentCleaner.js\":\"f172c2f5a630a410\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/attachmentParts.js\":\"468906f8ef6e266a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/bundleParts.js\":\"e52e9171f95da710\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/bundleRecord.js\":\"84ca9b8e2aaf6aac\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/manifest.js\":\"84daf1c747269b83\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/takeBundle.js\":\"dffeb47f03f9aa24\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/verifyBundle.js\":\"1c9d967c69da2dbc\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/cleaningStage.js\":\"d30fe851c759019a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionKey.js\":\"64ccefba452b03d5\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionServer.js\":\"c062d4a3eb7b26a0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/flip.js\":\"bb6f1b5694a57867\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/flipAttempts.js\":\"1063b77255ef58a9\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/pages.js\":\"2ad7c531d3bffb7a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/preflight.js\":\"8b24d1f5b8f4160a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/reseal.js\":\"49f45f0c890cca4b\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/runConversion.js\":\"3d1980ab5b4325af\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/runLock.js\":\"cc7fc9b8356d37d7\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/sealing.js\":\"829a95e22a380aff\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/sealingStage.js\":\"6257ffdc2653bd06\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/stage.js\":\"7951210ff588778e\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/verifyReseal.js\":\"e45c9fac8d11e17d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/aad.js\":\"e4bdfe07cd871f59\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/aead.js\":\"0e301904f8138126\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/base32.js\":\"9cf03380b271f020\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/base64url.js\":\"ef00636cb8f0e4bb\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/binaryEnvelope.js\":\"a82274f2ac02a3b6\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/byteAead.js\":\"352e0fbee79555a1\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/canary.js\":\"159052b47791ac9f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/contentHash.js\":\"17d5f7181c2e2abf\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/contentKey.js\":\"17852a40854d63b7\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/derivedIdNamespace.js\":\"bd58eb507b5d3d7a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/envelope.js\":\"d51ae73293597049\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/hex.js\":\"0fb01c5b92d01dca\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/sha256Hex.js\":\"c5259f8c5d242d6f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/workspaceKey.js\":\"1cafcbf0d85c0061\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/conversionState.js\":\"fd0080da74c470a3\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cd57bb59cdb50645\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/pastedKey.js\":\"6ee887b10e95a403\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"24ecda8384cfa9cc\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9318e2b5cdd9b1d0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/keyStore.js\":\"506cf07f0e67175a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/mintWorkspaceKey.js\":\"be709efb256eb6a8\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/modePin.js\":\"5a7566e9c1930e8c\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/openWorkspaceKeys.js\":\"fb495753af450045\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/resolveWorkspaceEntry.js\":\"952ead3162fa433b\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/resolver.js\":\"31720bc6eb4df24c\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/workspaceAccess.js\":\"b47d4f44dceb707f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/transform.js\":\"3d7dabadf376eb5f\",\"/knowledge-medium/pr-preview/pr-1639/src/themeBootDefaults.js\":\"c1e8cd5b9510555c\",\"/knowledge-medium/pr-preview/pr-1639/src/types.js\":\"740d003c0fadcf13\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/ClientLocalSettings.js\":\"35d44caeb3e24a00\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/abortableSleep.js\":\"d239bb20aa1e6c43\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/array.js\":\"54465cb1fc5151b9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/backlinkAutocomplete.js\":\"70a4cda5f48e1870\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/blockCrumbs.js\":\"c9e7c224de665a71\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/blockrefAutocomplete.js\":\"1208b048ea6e9e69\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/cadencedIdleJob.js\":\"24e2474d5613697a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/callbackSet.js\":\"4729aaf83d826181\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/clientId.js\":\"e4ce5452359ec2fd\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/codemirror.js\":\"7308fb5bab09e6ae\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/codemirrorCompletion.js\":\"9de99917b6af312b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/copy.js\":\"3642ac01ac0ea9b6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dailyPage.js\":\"959e6f469a7943a7\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dbForensics.js\":\"aacd18f01b8a455a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dbForensicsHooks.js\":\"5b455ea3cab12954\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/deleteBlockThroughUi.js\":\"d72b15e7c4ab7ab9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dialogs.js\":\"c007df77e14d3c47\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dom.js\":\"66f91d7e7c0413da\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/downloadBlob.js\":\"ad74d39f0ef75eb7\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/exportSqliteDb.js\":\"de0945c6133fccad\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fileSystemAccess.js\":\"b792c00ae0b1728e\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/flipSlide.js\":\"b71ab2ea38177d52\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fnv1a.js\":\"4408b4850f07e2b9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/formatBytes.js\":\"05db6e9d10bced21\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fuzzyRank.js\":\"0e5a30e49c0471d1\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/idbKeyedStore.js\":\"3bb87d728d9fcd85\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/idleCallbackPolyfill.js\":\"b60a75ee76dfb78e\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/keyboardAwareScroll.js\":\"ae7106ce86380c9c\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/keyboardViewport.js\":\"ac8b62ca8defb992\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/lastWorkspace.js\":\"739ccd4f0a235869\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutColumns.js\":\"e7bc514cc04acf7b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutSessionDom.js\":\"0097efad62307c29\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutSessionId.js\":\"fc959836050e9532\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/linkClickGestures.js\":\"1baf1e71c1ca90e6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/linkTargetAutocomplete.js\":\"6fdb990f5aa0621d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/localDbCorruption.js\":\"5510ac2f6bb1984b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/localDbRecovery.js\":\"fda91d978f196fdf\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/markdownParser.js\":\"e413283d3d9b9c9b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/memoize.js\":\"2d4b060fd2233adc\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/nameFieldCommit.js\":\"f280a56f83853411\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/nameList.js\":\"f03cd4877e879960\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/navigation.js\":\"4e02aeef7ed79a3c\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/omnilinerNamespace.js\":\"7e3ece9ad7a6d722\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/opfsPageScan.js\":\"f4f6ca311b855c81\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelClearance.js\":\"84dc46a4d81d316f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelHistory.js\":\"471cfc1a0726def5\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelLanes.js\":\"243308fce4e0aa23\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelLayoutProjection.js\":\"640a7e2bdfec4bef\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelScrollAnchor.js\":\"588bdaf66fa1c619\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelUrlFlags.js\":\"ba84b3d41bfc1878\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/platform.js\":\"ac964bf93bf16ec8\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/pluralize.js\":\"4196735dde35391c\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyCreation.js\":\"30826515b95f9c14\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyNavigation.js\":\"f600e1130b0c2372\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyValueContext.js\":\"24c9109d54583c43\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/react.js\":\"7629ce85842f2447\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/relativeDate.js\":\"136b339c7647ed8b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/relativeTime.js\":\"1073a65e0fa22169\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/renderScope.js\":\"d580a31487c22ff6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/resolvedThenable.js\":\"d22d79f4dbc9ef24\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/routing.js\":\"e46e394af2833e5d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/safeMode.js\":\"c9738b67d1f0b2e6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/scheduleIdle.js\":\"005e1bfe4b5eded7\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/screenWakeLock.js\":\"feed7cbadaebff44\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/selection.js\":\"d7476eb4b2ab64e5\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/softKeyboardGrab.js\":\"623e7691b785673d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/startupTimeline.js\":\"595eb2d2d92b9ac2\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/state.js\":\"376351c929039d2b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/string.js\":\"a3bbf5850e312758\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/surfaceZoom.js\":\"566d2b9684766544\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/time.js\":\"4cf9b884ccb4be91\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/toast.js\":\"b69de849e97314fb\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/toggleStore.js\":\"6facec6de4e68504\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/untilStopped.js\":\"16bfc2063de7e9de\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/userActivity.js\":\"501340e6ed1f479f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/viewTransition.js\":\"f4d1dff5558a67f6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/viewport.js\":\"ad689d61ae115fb0\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/webLock.js\":\"511b637c04a5d128\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/workspaceRecovery.js\":\"7bc8579481041882\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/workspaceSnapshotStore.js\":\"fb62380ba89672c6\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-compiler-runtime.js\":\"e151022f1a562c9b\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-client.js\":\"abbfa0df3279b1e9\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-server-edge.js\":\"a3620f9c282a179f\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-server.js\":\"e5d3bb8f15aa36d8\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-static-edge.js\":\"17a219a06bcf5a24\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-static.js\":\"f7672b711455d0b7\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-test-utils.js\":\"0f3b71f087d18173\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom.js\":\"925e8fe6cb48122f\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-jsx-runtime.js\":\"31c931efd46e3c39\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react.js\":\"88710f964f7383e0\",\"/knowledge-medium/pr-preview/pr-1639/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1639/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1639/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
