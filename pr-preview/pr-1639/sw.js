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
		buildId: "a8c0430f9052-f81e1e74",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/\":\"df6a39a4ec7aa0ab\",\"/knowledge-medium/pr-preview/pr-1639/index.html\":\"df6a39a4ec7aa0ab\",\"/knowledge-medium/pr-preview/pr-1639/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1639/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1639/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1639/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1639/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1639/assets/FacadeVFS-BJWqMA60.js\":\"10eaa0eaf0f0fc52\",\"/knowledge-medium/pr-preview/pr-1639/assets/OPFSCoopSyncVFS-Cq9fChfU.js\":\"e1b0fe75a57dcf52\",\"/knowledge-medium/pr-preview/pr-1639/assets/OPFSWriteAheadVFS-DMKdtDhq.js\":\"7726150954b299d8\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-CMlrU44c.js\":\"1ff4fb22c92c5210\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-async-1yPaDbmh.js\":\"a54fccc757250bf9\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1639/assets/worker-DeeUBQC9.js\":\"c686265e477f2f29\",\"/knowledge-medium/pr-preview/pr-1639/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1639/chunks/app-Bt7LxnO-.js\":\"3184fed3b6866355\",\"/knowledge-medium/pr-preview/pr-1639/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1639/index.js\":\"6bbbd528cf2144b0\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1639/assets/AccessHandlePoolVFS-B5zDZ-_S.js\":\"da947d207f0d4b34\",\"/knowledge-medium/pr-preview/pr-1639/assets/IDBBatchAtomicVFS-B48GIJud.js\":\"2cbf210466faf9ce\",\"/knowledge-medium/pr-preview/pr-1639/assets/MemoryVFS-xnphci4M.js\":\"e3388f93fb68444b\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-async-B1UmirEJ.js\":\"b0d60f437abd88e0\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-dJYiCHJj.js\":\"5f16316386b36309\",\"/knowledge-medium/pr-preview/pr-1639/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1639/chunks/AccessHandlePoolVFS-CwNuyciZ.js\":\"fc6af2498108dad1\",\"/knowledge-medium/pr-preview/pr-1639/chunks/FacadeVFS-BJZ6ogW3.js\":\"d91d6fe4b7aa4423\",\"/knowledge-medium/pr-preview/pr-1639/chunks/IDBBatchAtomicVFS-BHBdK198.js\":\"9604154285bd8d89\",\"/knowledge-medium/pr-preview/pr-1639/chunks/MemoryVFS-BwuSD1zw.js\":\"e449c2d5dc21809c\",\"/knowledge-medium/pr-preview/pr-1639/chunks/OPFSCoopSyncVFS-CalCT0TO.js\":\"7ef6d3ca2572d09f\",\"/knowledge-medium/pr-preview/pr-1639/chunks/OPFSWriteAheadVFS-C0w7fE7l.js\":\"8e3395b14bc29129\",\"/knowledge-medium/pr-preview/pr-1639/chunks/Preview-De9Rh99K.js\":\"d57ab3af2e2d5f43\",\"/knowledge-medium/pr-preview/pr-1639/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1639/chunks/card-BZ1Syze2.js\":\"cc5e3fe0882df5ed\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-aOZ55PYW.js\":\"506b43a3e758b7ae\",\"/knowledge-medium/pr-preview/pr-1639/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1639/chunks/mc-wa-sqlite-Dv3JD0xo.js\":\"29e8b7eb14a801d7\",\"/knowledge-medium/pr-preview/pr-1639/chunks/mc-wa-sqlite-async-3bVklRvy.js\":\"6688fbae95616585\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-B6jVq3f1.js\":\"d669f9ee3f226b50\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-CibjAkN3.js\":\"5059e0874c505aa3\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-CoUBaCs1.js\":\"906731715ee37d20\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-DCYlRXc9.js\":\"e61076587068a10c\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-DD1oHwqk.js\":\"cd086c37ff86ca7d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-Dt3rPB5U.js\":\"0820b32dd3faf846\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-KLgjbUAd.js\":\"eb223837d34a0e18\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server-legacy.browser.production-BPcIg6jo.js\":\"41b8dd2cb1e06fac\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server.browser.production-CZPz7W6-.js\":\"d715f376fc9a4388\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server.edge.production-DbxyW4Id.js\":\"4931ffe4cf8754c2\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-liEc6kCr.js\":\"fd578e6586ee9057\",\"/knowledge-medium/pr-preview/pr-1639/chunks/server.browser-DHgMgxMV.js\":\"0a65e9f615d75403\",\"/knowledge-medium/pr-preview/pr-1639/chunks/textarea-C5v5EO2D.js\":\"f7403d51558b01b4\",\"/knowledge-medium/pr-preview/pr-1639/chunks/ui-CUHDHYan.js\":\"138fbe6c531deff4\",\"/knowledge-medium/pr-preview/pr-1639/chunks/wa-sqlite-DHM-V1W5.js\":\"84eb7ff566383ef1\",\"/knowledge-medium/pr-preview/pr-1639/chunks/wa-sqlite-async-D2lD5rsi.js\":\"88e9d58e7397a92d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1639/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1639/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1639/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1639/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1639/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1639/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1639/src/App.js\":\"7200a627d5b6c819\",\"/knowledge-medium/pr-preview/pr-1639/src/appUpdate.js\":\"33a685e1556c03a3\",\"/knowledge-medium/pr-preview/pr-1639/src/appVersion.js\":\"b4bb7ea3e008ea09\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/initialLayout.js\":\"70ee308924d65dbb\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/openWorkspaceData.js\":\"894a121679abe6ec\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/resolveWorkspace.js\":\"1a46c8d512d2d819\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/workspaceBootstrap.js\":\"f9157eaf53e789ab\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockComponent.js\":\"eb6b1719a7960457\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockCrumbs.js\":\"cdd5dd0401ce66ab\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockEditor.js\":\"1f602ca376aad85a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockLoadingPlaceholder.js\":\"8164eca8c16b40d5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockProperties.js\":\"6c4be4ab0ea0bd22\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockSearchPicker.js\":\"19019856a69b84f4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ConfirmBulkDeleteDialog.js\":\"645490f5207863f2\",\"/knowledge-medium/pr-preview/pr-1639/src/components/DividerHandle.js\":\"29d0136a1098b9ba\",\"/knowledge-medium/pr-preview/pr-1639/src/components/DraftEditor.js\":\"69e82732a7feca8c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/GutterPill.js\":\"41e45617d8e7f2b9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/Header.js\":\"9ae4b5f2c555c623\",\"/knowledge-medium/pr-preview/pr-1639/src/components/LazyBlockComponent.js\":\"c893e5d3b10f7e45\",\"/knowledge-medium/pr-preview/pr-1639/src/components/Login.js\":\"a6959c7f2cb65d6f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ZoomableSurface.js\":\"81c7c7bc06b2a0a6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/editModeKeepalive.js\":\"744e5ccfe320e112\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4828f53e17cb2b6e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"815328e2cf438d6c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/RefPropertyEditor.js\":\"df5bbfabdb21b47d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/RefTargetTypePicker.js\":\"68f810f136112e87\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/SelectPropertyEditor.js\":\"e22f2f6f35f26780\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/TypesPropertyEditor.js\":\"a4737e5f32381e5d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/defaults.js\":\"728bb7168c041a3a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/kernelValuePresets.js\":\"0adb4bea5b5a9866\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/selectablePresets.js\":\"659f32690168f57c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/typesPropertyUi.js\":\"7afae59b4f28026e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/AddPropertyForm.js\":\"cc367b2d8dd780f5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/PropertyPicker.js\":\"0beff782ef9a8ad3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/PropertyRow.js\":\"cefae9e30f761089\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/Rows.js\":\"0691a91a2925bbfc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/actions.js\":\"c601180291422597\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/declarationOnly.js\":\"f65a5eb7ed690f87\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/layout.js\":\"2fefee399187236f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/model.js\":\"246a9164a8d00340\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/shapeUi.js\":\"7d0b07ed37d2eeb6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/shapes.js\":\"33285e010845ebc4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/usePropertyEditingActivation.js\":\"85962f70ac6cd9cb\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/visibility.js\":\"d2a9041117d564b5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanelSections.js\":\"1f2251e077b30e31\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockEmbed.js\":\"a887c6a5bd969d26\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockLink.js\":\"ef2cfce2b8c36c96\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockRef.js\":\"616f8cca81de87b0\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/ReferenceLink.js\":\"279324aac706d228\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/cycleGuard.js\":\"64b12e32e14853d0\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/cycleGuardContext.js\":\"ae0e0ac1f5d0e3cb\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/linkInteraction.js\":\"43ad8ec21a2ad804\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/referenceLayout.js\":\"4d1124856951756c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/useBlockRefAncestors.js\":\"1856f7d0bfc60a7f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockGutter.js\":\"9365925251776d86\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockInfoDialog.js\":\"d29a0f0efcdbaf0f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockTypeBlockRenderer.js\":\"df5cf879fc9713b8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BulletHoverCard.js\":\"3f825e59b5ad00a5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/CodeMirrorContentRenderer.js\":\"dcad9a344edb8675\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3ed7035c68492433\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/ColumnResizeHandles.js\":\"d2b42d6a2ffa00a9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3a7a36f347b63f28\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/DefaultBlockRenderer.js\":\"1d8938eec12ec654\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/LayoutRenderer.js\":\"3a6cd65dad0f6807\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/MarkdownContentRenderer.js\":\"891db2c654d62921\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/MissingDataRenderer.js\":\"8118897dd3cfba8e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/PanelRenderer.js\":\"736b997ca3dc9981\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1f792e21f6f45bdc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/TopLevelRenderer.js\":\"03a7dd19a9499294\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/blockGutterMode.js\":\"7fe65cd0c35db0e5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/blockTitleText.js\":\"2fcd5337136bf555\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/fieldCreationKeydown.js\":\"b395c214e7c17f04\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/layoutRootContext.js\":\"c577d41ebcf23812\",\"/knowledge-medium/pr-preview/pr-1639/src/components/typeChip/TypeChip.js\":\"e86b987bda4461fc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/typeChip/chipStyle.js\":\"5c32db90612d37c6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/anchored-floating.js\":\"6f462cd18241d77d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/button.js\":\"5fe099c2fe88f522\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/card.js\":\"362de872c62b41c4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/checkbox.js\":\"aed317ed80161933\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/collapsible.js\":\"405c4e39da292e2f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/command.js\":\"7907668d6a0fb2db\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/context-menu.js\":\"b5746150a189e752\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/dialog.js\":\"e959996a97af1c78\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/dropdown-menu.js\":\"4ce5f57ebe64529f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/floating-listbox.js\":\"c506a3669b96bada\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/index.js\":\"077a20787c4175e5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/input.js\":\"79535442c2504118\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/kbd.js\":\"583f191ae712a442\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/label.js\":\"8d2bea99db971908\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/textarea.js\":\"628d1d8bef40ac09\",\"/knowledge-medium/pr-preview/pr-1639/src/components/useEditModeYieldKeepalive.js\":\"bf5fca14392fe29c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/BootFallback.js\":\"7f5e8f6c6bdf48c2\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/FocusedRowLazyMount.js\":\"0e0970b59d23a3f6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/LazyViewportMount.js\":\"4d9c4a82f56cebc9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/LocalDbCorruptionFallback.js\":\"6be20e5c7e7f718d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/error.js\":\"ebece1a2f8917490\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/lazyMountRegistry.js\":\"428daac9916b37b6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/suspense.js\":\"fc2a066690305581\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/CreateWorkspaceDialog.js\":\"e5c08ca83e7fc048\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/PendingInvitations.js\":\"e24a78fd06ca9044\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/SyncProgress.js\":\"9a02a44eb7b41d05\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/UnlockProgress.js\":\"6fbff553a3d3db4e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceKeyGate.js\":\"d4c10f1d04062265\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSettingsDialog.js\":\"b9bf2cf517c03532\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSwitcher.js\":\"920c7eb0a51f445b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSyncGate.js\":\"9e906d1eb1a04bc3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/ConversionFlow.js\":\"b6e26d27ae0348ef\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/ConversionFlowHost.js\":\"d2c7b1e2f01c6839\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/EncryptionSection.js\":\"8f281e7efe30d4c8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/attachmentPrompts.js\":\"5eeff4cbd36fc651\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1d056583fd6a9ed2\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/conversionFlowDeps.js\":\"36e4e3013a9fef76\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/conversionFlowStore.js\":\"d152426be3851e91\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/flowUi.js\":\"e76e67dc5791d842\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/useConversionRun.js\":\"f5bbd37df6037318\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/keyUi.js\":\"d75b41f315b4fbf7\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/useCloseOnKeyLoss.js\":\"ad61bccdc8855ba3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/useCloseOnServerE2ee.js\":\"900516edb897e1e8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/workspaceUnlocked.js\":\"afb075bb6c3869a8\",\"/knowledge-medium/pr-preview/pr-1639/src/context/backgroundSubtree.js\":\"de8eb15ce03bf421\",\"/knowledge-medium/pr-preview/pr-1639/src/context/block.js\":\"43652552942f1272\",\"/knowledge-medium/pr-preview/pr-1639/src/context/layoutWsContext.js\":\"88a48b00bfd897e8\",\"/knowledge-medium/pr-preview/pr-1639/src/context/propertyDisplay.js\":\"cb28d361b976076f\",\"/knowledge-medium/pr-preview/pr-1639/src/context/repo.js\":\"1d445087ebd10aa4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/aliasClaim.js\":\"91d696a99a44dcba\",\"/knowledge-medium/pr-preview/pr-1639/src/data/aliasSeatNamespace.js\":\"208f5f7e9f024dc3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/blockData.js\":\"623aeeeb4be240ec\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/blockType.js\":\"0f05e7affeb8e919\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/changeScope.js\":\"dfeeac4ba8ae3d49\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/codecs.js\":\"324c4aa2b7d5d2ed\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/derivedData.js\":\"ee09a9a07f85fe6a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/errors.js\":\"907e0cf93d8f35e0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/events.js\":\"13b23a25b7032779\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/handle.js\":\"52295880d215b309\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/index.js\":\"15658fca73a63232\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/mutator.js\":\"914d08370097baf6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/processor.js\":\"4d3d548d60e99764\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/propertySchema.js\":\"ee4cc8368f4eb04d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/query.js\":\"b8a71f5cb3d37cf3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/sameTxProcessor.js\":\"eae55d335333e540\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/schema.js\":\"52295880d215b309\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/tx.js\":\"52295880d215b309\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/typedBlockQuery.js\":\"cb5fd016e5ab65a8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/user.js\":\"daf88fdfc437fb4b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/valuePresetCore.js\":\"27fc34a869de5b42\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/valuePresets.js\":\"87f39163011ec8c7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/attachmentCleanerIOVerb.js\":\"edfb5493c14a5ad3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/block.js\":\"c98ccca8cc5ecf81\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockCache.js\":\"c90e3880f8fd6d1b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockId.js\":\"0b1137410ecf8518\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockLiveness.js\":\"61e9f150a13067b3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockMerge.js\":\"1def5c3716522eba\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockSchema.js\":\"e0922ed13f2e2ede\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockTypeLookup.js\":\"2ab5056b47fed278\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockTypes.js\":\"ffb6e856f6734613\",\"/knowledge-medium/pr-preview/pr-1639/src/data/childrenView.js\":\"6c99b654d56c331d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/clientContext.js\":\"dd2c993b9a43656b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/dbFileSiblings.js\":\"d5860d88097c5b5a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/definitionSeeds.js\":\"198cdddb7d0ff760\",\"/knowledge-medium/pr-preview/pr-1639/src/data/derivedIds.js\":\"810960f745cfccdd\",\"/knowledge-medium/pr-preview/pr-1639/src/data/drawnSubtree.js\":\"406402f43d62b420\",\"/knowledge-medium/pr-preview/pr-1639/src/data/facetBridge.js\":\"9981c3835915b7f1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/facets.js\":\"ea3503000b6dc56b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/globalState.js\":\"b2ba54a5ad639382\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/aliasClaimRederiveProcessor.js\":\"b61452bcd27f8158\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/ancestorBatch.js\":\"5a46848cc074f786\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/blockTypeTypeifyProcessor.js\":\"be05591eb45becdb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/clientSchema.js\":\"509dd99a78012c3d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/commitPipeline.js\":\"fe7f97d5f6b9cf06\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/devAssertions.js\":\"f0d996c6541fc80a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/firstSync.js\":\"98efd1d837b5c932\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/freshInitialLoad.js\":\"622fb0bc91934203\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/graphBackfillClaim.js\":\"f7235831184c7224\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/handleStore.js\":\"bd2ed0550d444760\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/idleMarkerJobs.js\":\"955481e097365fc0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/initialDownload.js\":\"d2fc3b4ddf3377ab\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/initializeClientDatabase.js\":\"cf0163a97d68becd\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/jsonCanonical.js\":\"f23c32d001f984b3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelInvalidation.js\":\"b83c0a1162d0932d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelProcessors.js\":\"5458720f9a6bcf62\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelQueries.js\":\"76c243c8ec616473\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/mergeTypeMembershipProcessor.js\":\"3c317a9b30dcbcc1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/normalizeReferencesProcessor.js\":\"00ddf61431283795\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/poolInstrumentation.js\":\"83ed607b3e0d24ee\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/processorRunner.js\":\"bcf9033dd7c751b3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyCellBackfill.js\":\"7391188f24839510\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyChildMint.js\":\"5edd2fd4c9d7f044\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyChildrenProcessor.js\":\"52309d41e832a8b9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyDefinitionChangeProcessor.js\":\"79f8bc1f441dcbcb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyDefinitionSynthesis.js\":\"360c638406138e40\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyKeyScan.js\":\"dbcba64690b73b49\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertySchemaResolution.js\":\"2cc909425f4acd17\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyValueEdits.js\":\"d3f51edbdbf72b31\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/raiseProtocol.js\":\"10eef05b36c83bc1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/readBatch.js\":\"5af01f4b67102f39\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/refProjection.js\":\"f5ddaf587dfb5272\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/referenceTargetLookups.js\":\"5e0bc774a4372860\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/referenceTargetProcessor.js\":\"6703f8b62a954990\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/replayMerge.js\":\"5791d86393a75cd4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/sqlBinds.js\":\"fa33e2de278c6d1e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4ca69cc2c56ee59a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/arrivalProcessors.js\":\"018becb17876833a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/invalidate.js\":\"c4491c5f68928c04\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/materialize.js\":\"5c64bbbf383f1792\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/observer.js\":\"cd9102f590055af4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/reconcile.js\":\"4fa01f87ae549a60\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/timingMetrics.js\":\"37aa2a4035cbccfe\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/treeQueries.js\":\"39302d6e90988653\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/txEngine.js\":\"93fc4b84b11cb96c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/txSnapshots.js\":\"14eeaa07970f7c4a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/typedBlockQuery.js\":\"9dff13f1f4715f54\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/undoManager.js\":\"77a5ad15a9906782\",\"/knowledge-medium/pr-preview/pr-1639/src/data/invalidation.js\":\"084e5207a426a863\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelDataExtension.js\":\"5a81b18f891d65a0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelPage.js\":\"5a6508a2b23344ab\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelValuePresetCores.js\":\"9d55a809d73a98d0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbCorruptionSignal.js\":\"e44a507af6bddde0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbStorage.js\":\"a7d2dbd7cc9e4dd1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbVfs.js\":\"dfaf9c41096c1d29\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localSchema.js\":\"d81fa202f2ca1557\",\"/knowledge-medium/pr-preview/pr-1639/src/data/maintenance.js\":\"dd7fea86c7862e15\",\"/knowledge-medium/pr-preview/pr-1639/src/data/mergeProperties.js\":\"ebef86c9f2737015\",\"/knowledge-medium/pr-preview/pr-1639/src/data/metricsConsoleHook.js\":\"52702a334d9ed958\",\"/knowledge-medium/pr-preview/pr-1639/src/data/migrationsPage.js\":\"fc4ee5719b3a09c7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/mutators.js\":\"92ed8c28ab8cc7fa\",\"/knowledge-medium/pr-preview/pr-1639/src/data/orderKey.js\":\"4f62134e59e7d4a5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/orderKeyPlacement.js\":\"a8ea301d21c3eb58\",\"/knowledge-medium/pr-preview/pr-1639/src/data/outlineSurface.js\":\"6e70b219a5989237\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pendingEditorContent.js\":\"508860c404218e76\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pendingUploadsSql.js\":\"e44e325fc0a8f72c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pluginStateExtensions.js\":\"5a07badd1b0cc9c6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/powerSyncLogger.js\":\"0a326d7fd9119b11\",\"/knowledge-medium/pr-preview/pr-1639/src/data/projectorRuntime.js\":\"062ba07819361f65\",\"/knowledge-medium/pr-preview/pr-1639/src/data/properties.js\":\"b1912273a86855b7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertiesPage.js\":\"d71f012e8d67ea63\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyChildren.js\":\"202343eb31ec0892\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionFanout.js\":\"52de4686c34d6721\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionMetadata.js\":\"ef5c10d3c9902065\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionRegistry.js\":\"0c8a5d1ebc66bf01\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDisplayMode.js\":\"d848118ef84c9758\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyRowCreation.js\":\"8736d560d53a6463\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertySchemaCreation.js\":\"ce553290c8d512a6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertySeeds.js\":\"f758822d5c4698a9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/recentsPage.js\":\"4f1c9f24a8818512\",\"/knowledge-medium/pr-preview/pr-1639/src/data/referenceBlock.js\":\"43eef7e13869a1b5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/rejectedUploads.js\":\"217d7e7b172088e6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/releasePowerSyncConnection.js\":\"8891342aea0ba999\",\"/knowledge-medium/pr-preview/pr-1639/src/data/repo.js\":\"dee88e3b62910314\",\"/knowledge-medium/pr-preview/pr-1639/src/data/repoProvider.js\":\"f4d443265b026413\",\"/knowledge-medium/pr-preview/pr-1639/src/data/rowProperty.js\":\"fac65286a977418d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/searchFilter.js\":\"c273b35f87113d73\",\"/knowledge-medium/pr-preview/pr-1639/src/data/seedIdentityLedger.js\":\"a98f95e4744e00ea\",\"/knowledge-medium/pr-preview/pr-1639/src/data/stateBlocks.js\":\"eacd98350ee09816\",\"/knowledge-medium/pr-preview/pr-1639/src/data/structuralEditPolicy.js\":\"b38d4d7a8449f19c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/subtreeDelete.js\":\"0740b42bf615b966\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncStreamLock.js\":\"fa70a69a3b7a1e7d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncedTableSqlRecognizer.js\":\"678f2a69cce0b1ea\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncedTableWriteGuard.js\":\"159f704e0cb4dfe0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/targets.js\":\"027fe45def71cf3d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeColors.js\":\"18071e3189735037\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeDefinitionMetadata.js\":\"c1cec1c4b85afb68\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeDefinitionRegistry.js\":\"9d867b8d12ce3727\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeExtraction.js\":\"9c3e5d779aa5de3b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeInitialValues.js\":\"cb10e99512b0a2c7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typePropertyGroups.js\":\"a7812105d65af49d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeSeeds.js\":\"6894961924e8b936\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeTagger.js\":\"45f520d7a28da4a9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typedRecords.js\":\"6a9dd394c23984f9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typesPage.js\":\"cf5146e271eb7317\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userPrefs.js\":\"0f1f357f9ef78458\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userSchemasService.js\":\"59f75f8836ff7f68\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userTypesService.js\":\"e0109132d17a1d50\",\"/knowledge-medium/pr-preview/pr-1639/src/data/valuePresetRegistry.js\":\"b3ad474febab1bff\",\"/knowledge-medium/pr-preview/pr-1639/src/data/visibleChildren.js\":\"8763a2353f238cf0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceConversion.js\":\"ce30881459fe70b5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceFirstSync.js\":\"1ccd611cc5070bf8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceIdNamespace.js\":\"85559cbf137243f4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceSchema.js\":\"2fcd08706f10b818\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaces.js\":\"a29eb55965890c42\",\"/knowledge-medium/pr-preview/pr-1639/src/data/writeAheadLog.js\":\"5adbc738029ade31\",\"/knowledge-medium/pr-preview/pr-1639/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/BlockPasteShellDecorator.js\":\"f593ac2ceb7202a3\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/atTrigger.js\":\"d42f04e5f809bedb\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/autocomplete.js\":\"920c11a02189006f\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/codeMirrorExtensions.js\":\"abbcb553a028e7a6\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/contentFlush.js\":\"646ad826e06d9a99\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/defaultInteractions.js\":\"23ef636db33af039\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/editSettleSignal.js\":\"f03cf14a4c4784c2\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/insertImage.js\":\"daa4a466ae7b12f3\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/referenceCompletionRange.js\":\"ff02030924ab7f07\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/referenceTargetTypes.js\":\"e5af19eb02f34760\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/syntaxContext.js\":\"46fccd86559b453d\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/triggerMatch.js\":\"952cdc1cc2c192ff\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/AppRuntimeProvider.js\":\"888f2ba4cbc88bcc\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/BlockFocusShellDecorator.js\":\"65abd2f81e25ff64\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/ExtensionRenderBoundary.js\":\"eb0a00850a5f4812\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/PanelContentRecovery.js\":\"be03e66b986d18cc\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/apiCatalog.js\":\"b624322cb353aefb\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/approveExtensionHere.js\":\"fe7f2a0818519fd2\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/armedCutAppMount.js\":\"4dfbe185af5c1316\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/batchableKeyedStore.js\":\"04438f1313b48ea5\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/blockInteraction.js\":\"1db270e46809a1d1\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/blockSelectionAction.js\":\"0dabee1edc854c28\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/compileExtensionModule.js\":\"f4f134160abb4252\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/compiledModuleCache.js\":\"602079a30b6b9d70\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/continuousGestures.js\":\"d4db347cd8472087\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/core.js\":\"d0ec1d8f41e28cec\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/defaultRenderers.js\":\"1862f63848c24589\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/definitionFanoutAppMount.js\":\"5d5dd1466ec94d98\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dialogAppMount.js\":\"65808443e74849fe\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dynamicExtensionSeeds.js\":\"0227b6b3ff798978\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dynamicExtensions.js\":\"d1a26ee81a410685\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/exampleExtensions.js\":\"5238adce9bdaabb2\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionApprovalStatus.js\":\"0e845a9d35ee7fb0\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLoadErrorToast.js\":\"37a84490572dc5e4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLoadErrors.js\":\"378d92d0695304b9\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLookup.js\":\"6fea85c47190e663\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionToggles.js\":\"e5247b22fa3f71b8\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionUtilitiesCss.js\":\"c8f885d490955162\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/kernelPageDeletionGuard.js\":\"8e156b6b70d7e5ab\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/liveRuntime.js\":\"782ed32e5f8841ee\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/openExtensionsSettings.js\":\"e23e53f1e0fbd598\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/overridesCache.js\":\"1f663081befa27e4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/pluginIds.js\":\"cc68674d14c626cf\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/processorRejectionToast.js\":\"ed6255a15b42c2a0\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/runtimeActions.js\":\"50d09913b35018ed\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/runtimeContext.js\":\"3d53d83b8206a952\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/staticAppExtensions.js\":\"5908775bcf518590\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/staticDataExtensions.js\":\"51ea1b8fc776584d\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/toastAppMount.js\":\"0d851bafe153ca4f\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/useOverrides.js\":\"14ce9710122b1336\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/useShortcutSurfaceActivations.js\":\"32a7572d7dadab67\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/discoverToggleTree.js\":\"9b4020b5c12501d9\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/facet.js\":\"35efd12bbb4cbd90\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/resolveAppRuntime.js\":\"9094736a9487e3a3\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/runtimeEvents.js\":\"1e70bfabf36a926f\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/togglable.js\":\"9a9b81cea2b4c4e3\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/variantFacet.js\":\"8312a6955c7d9d2d\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/verbFacet.js\":\"d5727c20ab8852fb\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/block.js\":\"b745ac92e500c15c\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/focusedChild.js\":\"b4bdcce270684a46\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/propertySchemas.js\":\"ff3fdcefcf6a0689\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/typeRegistry.js\":\"a965e7090619a82b\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useAncestorCrumbs.js\":\"750571757c3527fc\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useAutocompleteListbox.js\":\"497c88e3c490c9c9\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useDebouncedSearch.js\":\"b3888032ac2e1354\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useDebouncedValue.js\":\"08a732c318178919\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useIsFocalRender.js\":\"f995571c36804425\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useIsReadOnly.js\":\"ab1ea3729e4844f6\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useMaterializeBacklog.js\":\"fbb4313118f530ce\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useMinuteClock.js\":\"74f592206c9fb2f3\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/usePanelLayoutProjection.js\":\"83b5d877dab2b5fe\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/usePendingInvitations.js\":\"95fced1d0533bbc3\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useRendererRegistry.js\":\"518bcbc98b7caded\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useRetainedFieldRows.js\":\"181cf890049c8d11\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useWorkspaces.js\":\"782d0d11e7c6a5d4\",\"/knowledge-medium/pr-preview/pr-1639/src/lib/utils.js\":\"14c7b612ed8e3ac8\",\"/knowledge-medium/pr-preview/pr-1639/src/main.js\":\"11d47763b547b1fc\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/MarkdownImage.js\":\"2d2953d5009d468e\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/blockSeparators.js\":\"a806ad4bd6657f2f\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/context.js\":\"227aaa0d94de6f85\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/defaultMarkdownExtension.js\":\"3d8dc08ea683662d\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/extensions.js\":\"4e129ed174f392d3\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/renderMarkdownHtml.js\":\"aa0c7493ea65e24d\",\"/knowledge-medium/pr-preview/pr-1639/src/minimal-editor.js\":\"170c784a30599f6d\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/armedCut.js\":\"ceebb47e1fd5ea42\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/captureMediaVerb.js\":\"06d9ccae9a8bf0d4\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/clipboard.js\":\"e919b54e32936470\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/decision.js\":\"ffe0e12517c085f1\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/operations.js\":\"1221dc393e15512c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/account-header/AccountHeaderItem.js\":\"7101e981f146c565\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/account-header/index.js\":\"7fbb20c3cd736fb7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"28a4870fca0f9ffb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/askAgent.js\":\"f8083cc71f091b69\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/askedStore.js\":\"a3ae1db0614b803c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9c397bb29f8499d0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/chipState.js\":\"5eead4bdf49d48da\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b7591c9c1681ca84\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/index.js\":\"02921d87f60c88bf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"42733c7801f60091\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/schema.js\":\"efa5264fefb00364\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b849bb395a59b473\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6760fbd363f7c957\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/addMedia.js\":\"87590dace560c28c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f257b039a1f2bae3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/block.js\":\"94542ee5802c188d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/context.js\":\"400047b3255c5c25\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/displayIds.js\":\"89faa8f12862680b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/index.js\":\"69b933a520680d40\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/outline.js\":\"dd651b5bbe0041e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/properties.js\":\"12ac0482c27591a4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/refs.js\":\"5c0c7660b1709dbc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e56087c57e8e2eec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/search.js\":\"320eec86807bc8f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/shared.js\":\"29945c1942280757\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"43f2249cbadfd910\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/text.js\":\"7a15f773f887df99\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentWrites.js\":\"bc41c9764bbec28e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/authoringCatalog.js\":\"cbd58e28eb9a73a3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/blockRefTargets.js\":\"1328587d8275cbac\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/bridge.js\":\"45a31caefeec7297\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/bridgeLoop.js\":\"f36e32d9fc993dbd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/changeHistory.js\":\"a7ad3b87e76d24d8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/commands.js\":\"dc432324d46a6e04\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/commentsCommands.js\":\"257b1971abc7bedd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/dataExtension.js\":\"9b48eab6640e59fc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/dataModelGuide.js\":\"e00a282ba54f8af7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/describeRuntime.js\":\"0e691d2eaca8f16e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/extensionLint.js\":\"6ace270e47542b28\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/grainAudit.js\":\"e8c1ef980205f9b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/healthCommand.js\":\"91714ec65b25956e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/index.js\":\"46868baa2b166286\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/presetIdentity.js\":\"dc550482546cd2fa\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"fa5be30b4f699228\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/readMedia.js\":\"0e6cdaaea9780324\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/schema.js\":\"99420f93d0ad0199\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/serialization.js\":\"4cb8f81b55159b36\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/targets.js\":\"72b959f7b2a21675\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/tokens.js\":\"efee5e823e9a6a27\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/watchEvents.js\":\"66b55abab983d5ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/workspaceGuard.js\":\"c2501ead2acc3994\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/writeCommands.js\":\"12b10be19f1678f0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/AliasCollisionToast.js\":\"7aadb6223a9b4cf7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/DuplicateNameBanner.js\":\"72ede63b975e26b8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/collisionMerge.js\":\"ac7f0c63da9b0472\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/dataExtension.js\":\"20bac01f5bb3f740\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/index.js\":\"06f59d6a15fc522d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/mergeCollisionAction.js\":\"24c98ba6b58dffe5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/pageStyling.js\":\"4d425c9375c137bb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/rejectionToast.js\":\"39c0b55f13695a48\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/syncProcessor.js\":\"dddc398c30c426d5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/actions.js\":\"856c9f1e465ca4f4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/addComment.js\":\"e58f7f5c3a7ac409\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/anchor.js\":\"47eb894b63c0280d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/anchorState.js\":\"fff43b3b6af3db0e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/commentLinks.js\":\"8e4db9d337b267e0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/confirmThreadDeletion.js\":\"79a37a5cc6ae187c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/container.js\":\"11fdb75ec3d216e9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/dataExtension.js\":\"ef230d40faa40a04\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/deleteComment.js\":\"6201b29f0bb2d811\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/highlights.js\":\"b3adca7570b0c614\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/index.js\":\"3f52814be24b0ae8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/linkedCommentsPill.js\":\"64f01d8c115dfb8a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/margin.js\":\"1777d4ffa45f864e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/marginSchema.js\":\"ffcc69b0d0cd9b46\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/newComment.js\":\"a90e86f29328dea8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/ownThreadPicker.js\":\"72a7a40ba5b013d1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/placement.js\":\"68c2ed66eb5a9282\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/queries.js\":\"b44d314942487ff4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotePosition.js\":\"1ea5d1b7a3e14a88\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotedIn.js\":\"4845f85ca3cb46db\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotedRange.js\":\"e3332cb1ec9df4a1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/rangeRefs.js\":\"df60ea4e93376f1d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readHighlights.js\":\"85968a5a2cc4b520\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readSelection.js\":\"c4afc22524ec89c7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readSelectionUi.js\":\"55bd677a1d7ba9a7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/reanchor.js\":\"80a302457510ce6d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/schema.js\":\"41f5dd8c88a85371\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/scope.js\":\"dad2e95a032e82d2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/scopeThreads.js\":\"3496eb31eec9d2f4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/splitRetarget.js\":\"3907947e74a2f40c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/suggestionCard.js\":\"dbe7295542d0b16d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/suggestions.js\":\"456e73f872da6bff\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/summaries.js\":\"5d291ff0f70ecc25\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/summaryBatch.js\":\"db64fd1690bcdba1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/surface.js\":\"292837690ad515fc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/threadNavigation.js\":\"7b4bc1b55217da8c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/threads.js\":\"8b4644a134ef9dc3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/ui.js\":\"40c2d997a28b5568\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/uiStore.js\":\"5946e2d1d510a32f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-intents/appIntents.js\":\"7e75b73061d2cb03\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-intents/index.js\":\"8a9273a07b934f68\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-update-prompt/index.js\":\"fc9c8e64b96c73a2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-update-prompt/status.js\":\"d0dfcd499cff2a6a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"48fea281f2a85124\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaBlockRenderer.js\":\"2b550711adad9276\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6c6f41e68d064c7b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaUploadReconciler.js\":\"f96d48670b187e85\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetDownLane.js\":\"54ea8e7bcb51d739\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetResolver.js\":\"445dba2fcd68bee7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetUpload.js\":\"7ac4a12d2c34af3d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/attachmentCleanerIO.js\":\"10797a8d7e079a25\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2b3b2dc9274601f1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/blobStore.js\":\"571f95c6a83aec4a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/browserMedia.js\":\"fb0a6c8a597cad58\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/byteStore.js\":\"0cbe5b16ee7eb2e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/cleanerIO.js\":\"50abcfeadd4d90aa\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/cleanupAttachments.js\":\"12951d54830e7af5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/dataExtension.js\":\"65a85168240ff10f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/downLane.js\":\"90db97be385e1285\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/index.js\":\"62508ff4304a1518\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/insertImageContribution.js\":\"159b593cbcbc5992\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/laneArming.js\":\"0ff305ba71a1744f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/laneLock.js\":\"71422baeac1e7b6e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaBlock.js\":\"54c688b84d9bfb60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaCapture.js\":\"b9396ad4b0bf3bb4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaLanes.js\":\"8898dd491ea0a58b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaViewers.js\":\"050ac8a4f9d3e70f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaViewersFacet.js\":\"e3f78b83ff92955a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/pasteCapture.js\":\"b1529a6c3f609004\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/resolver.js\":\"392490f0138a1c2a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/retryUploadsAction.js\":\"5bd03539559c2452\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/storagePaths.js\":\"bcfd32ff373aabfd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadDrain.js\":\"120c63f6282a3e3a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadLaneStatus.js\":\"76c7ec5961c68d99\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadReconcile.js\":\"056d74f96163aa93\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadRecovery.js\":\"63fc002ea72d6605\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadStore.js\":\"9ebac39bbf3128d0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/useAssetObjectUrl.js\":\"55fc738401602720\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4b59031a11a9d241\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/BacklinksViewSection.js\":\"96f150b6f27188c5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/facet.js\":\"ad89a7db03eee26c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/index.js\":\"3f2f4d084ab4c1e2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/prop.js\":\"648cd48f6daf45a7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BacklinkFilters.js\":\"ec9d2aa1d67e2d0e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"658d54def014a41a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BlockEntry.js\":\"f0a62c40dc1b20bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/LinkedReferences.js\":\"70f51c481b4c7b3a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"41ace33a77c1847a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/dailyNoteDefaults.js\":\"eb892351902a234a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/dataExtension.js\":\"51e48618c9504d13\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/edgeExclusions.js\":\"c520909bbebf7a99\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/filterProperty.js\":\"cb142ea7c355350b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/index.js\":\"b278ff6682899644\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"af3163e0234141ff\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/applies.js\":\"a8eb0930ca19bae6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/countQuery.js\":\"7ad6c2244e677c29\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cd3d03096fcbaa0a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/index.js\":\"8fff78f8ec7cd434\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e357284ecaf54471\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/presentationInvalidation.js\":\"dd235938398964fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/propertyEditorOverride.js\":\"5d2184b1c2cd16d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/propertyFilter.js\":\"5dbb0e5e4aab8ff4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/query.js\":\"39c176d674d79fb8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/resolveFilter.js\":\"5a4c1da04fd0ffa1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/sourceBatch.js\":\"64f0d9491176160c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/sources.js\":\"07d696bef87c2f35\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/useBacklinks.js\":\"5cb3c3273e7e9512\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"618154e05d130a00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/BirthdayCelebration.js\":\"1acb587e391897a2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/BirthdayOverlay.js\":\"995f35fdb19f15cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/gate.js\":\"093c28af0cf5763a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/index.js\":\"37e28c1c97c37292\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/wolfTheme.js\":\"98b668167e4d18a3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/BlockDragLayer.js\":\"3cb74bf272c4b6a4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/dragController.js\":\"2da3fdbd9bc8850a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/dropTarget.js\":\"4623c01673acecca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/index.js\":\"ecc0acf95f75cbd6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/projection.js\":\"7695511134c50ab6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-info/BlockMetaCard.js\":\"75e003e2a5d65224\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-info/index.js\":\"85294cf2e59ceedd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/AddTagDialog.js\":\"a99e128a4fc15602\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"274561c6ed6ba72b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/TagNameIssueHint.js\":\"9319ee35a9689e5f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/addTagAction.js\":\"0e5f39fcfd58f009\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/appendTag.js\":\"a313a8155f18ad66\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/config.js\":\"73a091e8fd1f2d15\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/dataExtension.js\":\"3f864af00bf17b9a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/index.js\":\"73eae56708f86299\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/propertyEditorOverride.js\":\"840f7ac93f956d88\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9964bed4e8d4f33f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"79853b19d9f7d991\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/Breadcrumbs.js\":\"62399188848fd7a6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6f449bfedfd37dfc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"766ee769753d570b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/index.js\":\"ec992137161598d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"44294398bcf187f1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/CharacterCountItem.js\":\"2bcd4dd412dd0f46\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/ProfilePropertyEditor.js\":\"df31766445958769\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/actions.js\":\"eeea8a60fc78891d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/blockType.js\":\"d7d482e41409fe34\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/charCount.js\":\"8349513f971e0882\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/dataExtension.js\":\"76e960f510cf3c8d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/index.js\":\"e4365f935dbb4f99\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/profiles.js\":\"46a416edfc598eee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/properties.js\":\"cad83d2dc25b5cfe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/textCounts.js\":\"7ddac142fd2edf2a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/colemak-keybindings/index.js\":\"1a3a83ef385735c8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/CommandPalette.js\":\"d993a73d890173ca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/HeaderItem.js\":\"29886c971eec73f9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/context.js\":\"2c7d9e43a1a1e9d9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/index.js\":\"232c8bf2ec4d5435\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/selection.js\":\"e9fc136fbdb256e2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/toggleStore.js\":\"fd1e26954f32ae8d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/useCommandPaletteActions.js\":\"f220209c9cd18fd9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/ContributorBadges.js\":\"50314f93fc933c7b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/author.js\":\"bdbbccc2b9135109\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/codeMirrorExtensions.js\":\"5e33473ee59e8066\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/dataExtension.js\":\"3e55cf02aca88d6c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/index.js\":\"9ebba8136c71a9b8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/mentionAutocomplete.js\":\"7573eaa5b6190728\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/processor.js\":\"741a5476552df0b9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/profiles.js\":\"485e7e873b6ed80c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/queries.js\":\"d210db2e1f4adb43\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/schema.js\":\"a884715cc69d1791\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3c58975026a19451\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ca8767afd64eb60b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/index.js\":\"9e554611631927e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1cd518d8df3f2f83\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d8d29485b1a2b1a0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/CalendarGrid.js\":\"fa6a1aece3068ab6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DailyNotePicker.js\":\"689c146615697422\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b610464e82d10205\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateNavDecorator.js\":\"ef4b0df9e2140f1a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateScrubOverlay.js\":\"269eae3ae9a054c7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/HeaderItem.js\":\"94a13c8b35e09e1c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/ReschedulePicker.js\":\"cac92910d6b8b7f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2bac35b1f99df528\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/actions.js\":\"24c2057980f232d7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/blockDateAdapter.js\":\"84a00628f62fb62a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/calendar.js\":\"47e3b259f2866512\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dailyNotes.js\":\"3aa2039e51907a24\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dataExtension.js\":\"99108c52767e9370\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubActions.js\":\"4fbcb29f500269ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubGesture.js\":\"f97136681ea70668\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubGestureActions.js\":\"44b0a5bea352164d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ad28005ac36cb201\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/deletionGuard.js\":\"83a57c769464989d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dueQuery.js\":\"8e351060f625f74c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/index.js\":\"40b66f3da4afad57\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/landing.js\":\"d0ee9f70e904972c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/localSchema.js\":\"8f0a4772ef5aaae2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/referenceDateAdapter.js\":\"f61bd057d3248f7b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/rescheduleAction.js\":\"9b4c028f80fb496e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/schema.js\":\"73828f17d5eac442\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/spreadBlockDates.js\":\"3bcf5960e4cfb936\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/spreadDatesAction.js\":\"e4811320d321837b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/today.js\":\"f107d2c0abe5f041\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b3f7e4e317fd278d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3945d8f45f6350b7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/audit.js\":\"f30e17884d75ed5f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/auditAction.js\":\"c84cc3a64af8a486\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/auditRanges.js\":\"0762bd8d3a4d305c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/diagnosticsSource.js\":\"b6a494d43128a954\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/divergenceScan.js\":\"b13169cc0a8931b6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/index.js\":\"c7318e57d032f072\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f619b0ed4532a5d5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/referencesMirror.js\":\"de0014ecb586e51a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/rowJson.js\":\"329193a0e84670f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/schedule.js\":\"cf3b79f382de230c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/store.js\":\"860089841b8a3838\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/action.js\":\"1e0fd5b5b5a68d3f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/index.js\":\"2b0bc0d1b946b933\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/plugin.js\":\"d16654d4bc7c7ced\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c84b8294ff48b134\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/actions.js\":\"200954586b909775\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/changeMarker.js\":\"3f2fc98fc4ebedc8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/diagnostics.js\":\"5734daf4a7971bae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/fileSystemAccess.js\":\"066de94054b81957\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/filenames.js\":\"82dd03feac0695db\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/index.js\":\"e2610e31bb43c14e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/mirror.js\":\"c679441a68ce64c6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/runLock.js\":\"e39794e090d46b48\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/runtimeHealth.js\":\"3c4a0eb8725666bf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/schedule.js\":\"c58a1e83c0b5029d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/store.js\":\"de681fc8e2ba1e27\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/default-themes/index.js\":\"74bbc726f6028fbe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/default-themes/themes.js\":\"602fe7b54c9170a0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/diagnostics/facet.js\":\"176058f7529f607e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/diagnostics/useDiagnostics.js\":\"6846971c01fe25c3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/dismissals.js\":\"1a2d0c11e4d4ccf0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/index.js\":\"a2d12fa8a929e370\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/status.js\":\"958fd28f1702b8eb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/store.js\":\"f93dc5fe20268b07\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d72017be287c4bed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1f7a8d084c5968a4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/actions.js\":\"30a972f2a236316d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/config.js\":\"34c66d774f7af3e7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/dataExtension.js\":\"b827cffa78037453\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/effect.js\":\"f519ba0ba5d0d4c6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/index.js\":\"c78f80c5af6a88f0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1194dc05529c5d5c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/useToggleTree.js\":\"ea788d20a9447800\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/ExtractTypeDialog.js\":\"8f50e76e679068f1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"33e4a961bd682bbe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/PropertyShapePicker.js\":\"98f9b4cae99fe0a6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/action.js\":\"85037744777c1e73\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/index.js\":\"17cf928c95ebfca8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/FindReplaceDialog.js\":\"b7856a8ae9e61963\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/HeaderItem.js\":\"b15c5a6ef79cbbd5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/dataExtension.js\":\"b9971b76217d6db0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/index.js\":\"01d74b72e0563566\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/search.js\":\"33a242764e29f677\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/toggleStore.js\":\"7b5082e3341a4518\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/LocationPropertyEditor.js\":\"69d47bb6b1a6af21\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/MapView.js\":\"c7ad1b976738b546\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/blockTypes.js\":\"d1eecc825abaaa63\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/codeMirrorExtensions.js\":\"39fdd5a314272fe5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/createOrFindPlace.js\":\"70e54c1e16976097\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/currentLocation.js\":\"185d232f74082992\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/dataExtension.js\":\"8c229e21b001f424\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/geoContentDecorator.js\":\"6739741477f79d21\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/googlePlacesClient.js\":\"0e4035ae2215202f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/index.js\":\"30ffeffc500ec2e0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/locationsPage.js\":\"2f0dcb131f7e7e1a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/mapViewport.js\":\"2fbd5b48d143663f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/pickCurrentLocation.js\":\"f506f8bb17bc9e6f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/placeAutocomplete.js\":\"2f6e14441aac491d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/placeNameCollision.js\":\"703db3f1ba74d8c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/properties.js\":\"cc3034c9a97d49bd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/propertyEditorOverrides.js\":\"2a19d57cdd524e8b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/query.js\":\"2e7b0fb0a87cf83a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/usePlaceSearch.js\":\"6c68159b2c45783e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b196e8265ec96700\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cc632c072da57f00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"68473b7c539b2a45\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/config.js\":\"aed92429975b5731\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/dataExtension.js\":\"18ab886b955d54ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/facet.js\":\"789da267bc60640e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/grouping.js\":\"aefc048ffa4316cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/index.js\":\"e35832df12213d29\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"92dbbeba1cc0643b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/query.js\":\"2a1abdd58533aee7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/resolveConfig.js\":\"16129a414388fa4c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5f7daba2244c1410\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c2afd7077bc97048\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/HtmlDocumentContent.js\":\"893a4c15e8460c55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/HtmlFrame.js\":\"585dec0a1b504f05\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/actions.js\":\"c746dc8d63d550cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/blockType.js\":\"104d3baa2898e32e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/confirmRunScripts.js\":\"c2535f073e180c72\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/dataExtension.js\":\"8b707d48515c7dd0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameAnnotations.js\":\"7f427401598d89e4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameDocument.js\":\"ba5a17e7ce362a8a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameTheme.js\":\"0795a744500b889f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/index.js\":\"2f82ffb87b8c67c5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/scriptConsent.js\":\"4698c429f94468ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/sourceMap.js\":\"75457e1ad3aedb82\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/useDocumentScripts.js\":\"209ebd09e95d89cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/index.js\":\"19b88226c03c62a1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/record.js\":\"c113486a65769ed0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/recordStore.js\":\"524dc18e57ee79ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/responsiveness.js\":\"f91c779b26344578\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/schedule.js\":\"cfaa3e7d9cfcde63\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/sessionContext.js\":\"1421b8d1f0e17e3e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d5d189e038170ae4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"29a848ceffbefdd6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/actions.js\":\"2b8b78a3fbd8fcd4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/config.js\":\"b36d2823a6fc268b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/dataExtension.js\":\"94dabd694e6285f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/effect.js\":\"a6d331e7f1a5e5b2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/index.js\":\"98ee2a79d080640d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/keyCapture.js\":\"86c1e861aa8b10d4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/overrideStore.js\":\"418f9108d8a268df\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f2eb6e2f413a2d03\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/HeaderItem.js\":\"c282e11798337fe1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/LeftSidebar.js\":\"bf394fdaf4166585\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/actions.js\":\"1557543ac64f4ab5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/facet.js\":\"b33ec73bd2463983\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/index.js\":\"1883470d094d7b39\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/shortcuts.js\":\"b2cf6ffe55970ab9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/toggleStore.js\":\"7f4221ae1394e0e9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/MergePicker.js\":\"1d48b668791c3a33\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/index.js\":\"d85164bdcf4d3c1a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/mergeAction.js\":\"7dbe57d3b00dffac\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/strategy.js\":\"7f26673f60cbbfb4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/Button.js\":\"1607e467a07194ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"70bd5875cefafcf8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/defaultItems.js\":\"68d66fee73776a63\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/facet.js\":\"a9fad7d19ac3c7cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/index.js\":\"0065fe0b8c5f53ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"58d4e5178fb8d0c8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1f9f4a46c5491dee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4124c258072c19bb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/facet.js\":\"89d3eb117b0cc352\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/index.js\":\"452312416f53b5b7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9290078e1fb0e03d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2991b93a760dca61\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/contextMenuItem.js\":\"ad2307133bec1aa5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/index.js\":\"f09a2b249d043625\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/moveAction.js\":\"010f1ba1da40120a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/moveBlocks.js\":\"6344322eba4af99e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/selectionAfterMove.js\":\"fc87cc26f3be4d8e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/TutorialBanner.js\":\"ceac34593a187495\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/action.js\":\"ae4785f421eddb7c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/bannerDismissal.js\":\"15e2636d801e1b25\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/documents/cheatSheet.js\":\"b91b44c29ba178a6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/index.js\":\"7e7540876b731531\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/keys.js\":\"b8f1bcfd6d3d744a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/landing.js\":\"a0b43d1e9dc45d97\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/outline.js\":\"41e9fc09c33b2b6e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/seed.js\":\"29cca29b7512074d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f72b0ed3105e8109\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/analyze.js\":\"996571cf0c0990c3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/diagnosticsSource.js\":\"aa52459840ed8b4f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/index.js\":\"9c64a84bcbcf7ef7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/load.js\":\"46719b3d54e96001\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/monitorRun.js\":\"47e7c0f2642c443e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/schedule.js\":\"ea2293815815a488\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/series.js\":\"94ea952c55b7a913\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/store.js\":\"0602820c5aa03bac\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/trendAction.js\":\"68394b24e9401df8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/verdict.js\":\"a629650d28723e55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/clickToEditAction.js\":\"9feb30649cab6ed0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/index.js\":\"cf2608baa388805a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/interactions.js\":\"35f26bcff063d2fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a1b8a768e0e7c74d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/MigrationGate.js\":\"9ef93b0fc56159a8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/MigrationGateDialog.js\":\"eaea768c969395a7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/action.js\":\"efd7a54eec7a2ce3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/index.js\":\"70f484cb223e68b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/localRunMessage.js\":\"198bf80b37fe5c6d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/plugin.js\":\"25893597d1878cc4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/progressReport.js\":\"114f96ac4f281e67\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/sweepProgress.js\":\"08982ad77e5faa86\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/FieldRowRenderer.js\":\"aee96d60451a5329\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/ValueRowRenderer.js\":\"caa729a91545612b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/actions.js\":\"75cb85aba9379b75\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/autocomplete.js\":\"f0777839876e5ef6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/fieldRow.js\":\"3934238fd69b0045\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/index.js\":\"76c7545223e9ab4c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/referenceWarning.js\":\"c80f705311c8ae5c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/valueAutocomplete.js\":\"0aad7a9fc5e06df8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/valueSchema.js\":\"3c2a1427c84998a3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/HeaderItem.js\":\"13fb0ff42bae4994\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/QuickFind.js\":\"85c8a46e2e60ce28\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/index.js\":\"8555ac02ff9bd2ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/recents.js\":\"0a6b5086841a9cdc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/resultItems.js\":\"08d9ffe46f0a7504\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/selection.js\":\"dce89d01a27f6bec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/toggleStore.js\":\"e56bad4b38addf02\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/HeaderItem.js\":\"1930e58bf429390c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/RecentsPageBlockRenderer.js\":\"053d99865f51749f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/grouping.js\":\"667844146b3b5901\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/index.js\":\"3889bf3c5f0ae028\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/target.js\":\"393970fa418fac4c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/codeMirrorExtensions.js\":\"e1542c9c006005d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/contentPrefill.js\":\"893b5acec240f673\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/dataExtension.js\":\"b8c435d528413bdf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/index.js\":\"1b122f7f9e7bc7cf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e0308eeef237f997\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/invalidation.js\":\"28ca48f01138ed44\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/localSchema.js\":\"12460b2deaaad1da\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/blockrefs/index.js\":\"84c109ce8f8604bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e8029d60f62cc940\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/index.js\":\"e08374661f0e8f31\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/referenceNode.js\":\"bfe65082589b8883\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/remark-reference-occurrences.js\":\"48ced84bd7aba2b2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2124708c6457e7c7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/index.js\":\"613e15ff973126d8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d58ce1333b8f9249\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1560bcf2fc3694e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/mergeRetargetProcessor.js\":\"6d8a540120e96cae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/parseFence.js\":\"84a2808e3aba2b85\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referenceParser.js\":\"212849b0c7ffbe18\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referenceProjection.js\":\"57ac1b0b2b223a93\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referencesProcessor.js\":\"6af6e3f7f936112e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/renameProcessor.js\":\"e929207518c89342\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/spanReplacement.js\":\"0af2c02b04325a9d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/htmlToOutline.js\":\"aaf300f60c844fc2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/index.js\":\"af8ce547c5b83dae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/normalizeClipboardDom.js\":\"39901bdcd56d7daf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/pasteDecision.js\":\"08fcdaf66ab11709\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/action.js\":\"61ae11e7e35b0cca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/blockIds.js\":\"82f5d7a4ec435ca3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/content.js\":\"53a90e71a1b91594\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/effect.js\":\"c735e038fb2c4d01\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/ids.js\":\"32367027f87c2622\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/import.js\":\"0d251193e64918e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/index.js\":\"a883600bb0e6c7cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/plan.js\":\"812443d66f041457\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/plugin.js\":\"db4752698437dc65\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/promotion.js\":\"8be62fe1b9658619\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/properties.js\":\"08776f4253b19c8d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/references.js\":\"70f4eda094d08a8c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/report.js\":\"4920a07138f73d5c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/roamMemo.js\":\"eeac83ce6bc4bf2a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/runtime.js\":\"18d0afe3ebd0d8e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/schemaReconciliation.js\":\"b647253212cf7059\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/srsMarkers.js\":\"a5ff0ba6810fd416\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/todo.js\":\"81f7d63efbfc06c4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/typeCandidates.js\":\"7131c35d6dfb7c08\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/types.js\":\"c29817c3c9322de1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/search-health/index.js\":\"5e7f8a3bca114c92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/search-health/store.js\":\"cf10ae3b96b04351\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/HeaderItem.js\":\"409912b84fc5da4b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ec50b397965537e4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/index.js\":\"e7590f20aa8d94c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/model.js\":\"194b62385bf687de\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/toggleStore.js\":\"b8bcd0dfede4668d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/useKeyInspector.js\":\"15602157492856e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1da1a9d66300577b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/ShellDecorator.js\":\"72fb265c68ae3275\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/actions.js\":\"44a95d6de9a2cdf2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/exclusionsFacet.js\":\"871eff80e0d68e1d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/index.js\":\"bbb0c4efd3071025\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/shell.js\":\"33f58e6bd38442a1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/surface.js\":\"ec3ee4439e9db98f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/walker.js\":\"b6447e613bf3b3f3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/RescheduleToast.js\":\"343727428ba08787\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/dataExtension.js\":\"604a993ffd6fe423\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/index.js\":\"fd7a5a29d2354061\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/indicator.js\":\"33844730826f0f1a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/moveSrsState.js\":\"c8a297298218997e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f365daecf19fb7d0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/scheduler.js\":\"8750266cd3ca92ac\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/schema.js\":\"efc475407b660c89\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"40cc6e1d0119febe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/srsClipboard.js\":\"3a8bc270499295b3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7ca6f67bcfe4d291\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9b23b39809708ae9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/DeckPicker.js\":\"6b28851bf53bc25d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewControls.js\":\"7cf5fa31bcfb4981\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewDeckRenderer.js\":\"21e224b9bfe4f31a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewSession.js\":\"27a16ecc6459acbb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/actions.js\":\"ea1aeafc1e0b515d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/archive.js\":\"332705211ad16712\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/dataExtension.js\":\"54f48e8f868e1994\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/deck.js\":\"44b31410ce836e1d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/dueQuery.js\":\"5ce8056d791319aa\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/gradeDecision.js\":\"4b2efa40fee19e78\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/index.js\":\"6494b4e937390363\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/keyHints.js\":\"9d4422a3973e1522\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/reviewCardLayout.js\":\"36bd8982efc8f5f6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/reviewProgress.js\":\"81934850e725ef1f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/schema.js\":\"45ae8aa4d60d9abe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/useDueCards.js\":\"800f03d8d8f89d60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/startup-metrics/index.js\":\"5f4d64656528bcb1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/startup-metrics/record.js\":\"08f8961446f39cf5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/index.js\":\"65e28ff77dbe043b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/persistenceStatus.js\":\"499adadbbb487e48\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/requestAction.js\":\"5252e13c977f0375\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/TypeChipsDecorator.js\":\"deae6fe87bc22d74\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/codeMirrorExtensions.js\":\"abfd8d10fe2fd32f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/index.js\":\"bf8cf8bc81e0e1e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/typeAutocomplete.js\":\"87c33d9bfc41d725\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c44c4d67faa15e73\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/actions.js\":\"d42d23760b098995\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/anchor.js\":\"c1eafed1c0567d40\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/events.js\":\"cd62af814449c1ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/gestureActions.js\":\"8f69c077e869d3ab\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/index.js\":\"927e8488e7d9ea49\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7cb4e0816f93da60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/collect.js\":\"b4b0780c9b8a6ed3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/index.js\":\"6e17744cdc6d4e72\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/record.js\":\"f074d5f35d2d7f35\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/RejectionDialog.js\":\"1ac962dc23230a06\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9e15289896399dd5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/index.js\":\"d8679cc6ef634053\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/model.js\":\"1af80a2198ef2b5b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/queueCounts.js\":\"8e01cf45c2f24a55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/rejectedHelpers.js\":\"d3e4023c84f4e657\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/rematerializeAction.js\":\"dfa173b886d40320\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/useHysteresis.js\":\"96c2a69f85cc835e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/ColumnHeaders.js\":\"354ef4e7a668e8ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/QueryUi.js\":\"bea8cdf36ac68a4c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/TableLayout.js\":\"deea716b613027fd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/actions.js\":\"869eda2292e3e459\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/cellEdits.js\":\"199b92fa3d0561c5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/columns.js\":\"5a15594d0d03c05c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/controller.js\":\"0b3de4788b366a63\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/convert.js\":\"dd0d68f942a6f51b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/dataExtension.js\":\"23e77c8a905fb9cc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/index.js\":\"3fa16ebd0046633f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/keys.js\":\"68c8e4d844242017\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/model.js\":\"8192bf3f93bf0d34\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/navigation.js\":\"093b6129437553e0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/backfill.js\":\"3f0aa06787e5a050\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/completion.js\":\"9bc6d34bbb24b9e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/format.js\":\"feaf339f60851d0f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/parse.js\":\"f890062f82e4a9d9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/queryValue.js\":\"6a6334d04403db33\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/source.js\":\"15276374cd77a0bd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/registry.js\":\"f8e691757b1b8a0d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/rowGutter.js\":\"1f1eeff5e4b5a8eb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/rowVerbs.js\":\"3313706dd39fd956\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/schema.js\":\"83aa376f6101d414\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/sort.js\":\"baca799b64c54fc3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/effect.js\":\"fbcb87b2d1f964e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/index.js\":\"38ecb6825afb49b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/theme.js\":\"82f0c8d2cda65537\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/actions.js\":\"136f93196f716665\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/dataExtension.js\":\"eeed71d78d7e03d4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/index.js\":\"025de0abfaf25bf3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/schema.js\":\"9dcd15e8248dd2a9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/TouchSelectionLayer.js\":\"43a14411cff24972\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/actions.js\":\"8295d02c587a3b92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/defaultItems.js\":\"77d5974c8129f714\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/facet.js\":\"d11a6419e6aa58b1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/holdRecognizer.js\":\"fca41cba5719c6d9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/index.js\":\"3d9523ef0d919d5b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/UpdateIndicator.js\":\"e3f18d6b2adcf9f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/index.js\":\"1a2762a6b70b6d34\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/loadTimes.js\":\"1dd37597eb70de3a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoNotesRenderer.js\":\"393415ad50e24825\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoPlayerRenderer.js\":\"7bdaf184519eebe2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoTimeStamp.js\":\"74554aa88c6c4566\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/actions.js\":\"b7e7197c33dcae00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/index.js\":\"6f5785ea1f4edd08\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/markdown.js\":\"71ff13cd453f2107\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/notes.js\":\"4ff273ad8048bcbb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/registry.js\":\"3baf5cce07310e43\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/remark-timestamps.js\":\"cdf205e6599beb4b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/view.js\":\"63c667c91d318825\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/LinkHints.js\":\"00fb1263dcdf3b81\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/index.js\":\"e044501690451240\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/model.js\":\"7d4c9e0fa14c83e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/settings.js\":\"6da4f75e475b1639\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/actions.js\":\"15b72598383c4e14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/index.js\":\"766c982bdc6027c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/interactions.js\":\"fff926346f965148\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/workspace-header/index.js\":\"88867dd8f03bdc82\",\"/knowledge-medium/pr-preview/pr-1639/src/registerServiceWorker.js\":\"a0a64f2aebcf13c8\",\"/knowledge-medium/pr-preview/pr-1639/src/requestPersistentStorage.js\":\"6d4e466a5c7cd851\",\"/knowledge-medium/pr-preview/pr-1639/src/services/authRequestDeadline.js\":\"d0dfced83fbe3314\",\"/knowledge-medium/pr-preview/pr-1639/src/services/authStorage.js\":\"b8c40edc86270856\",\"/knowledge-medium/pr-preview/pr-1639/src/services/powersync.js\":\"d7f650f3eb995461\",\"/knowledge-medium/pr-preview/pr-1639/src/services/supabase.js\":\"2bfb3884a5a866e2\",\"/knowledge-medium/pr-preview/pr-1639/src/services/uploadErrorClassifier.js\":\"bbd2c6a15d3ce5e3\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/ActiveContexts.js\":\"e74d33bafc7d5b2c\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/HotkeyReconciler.js\":\"967837395850e1fd\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/WipeLocalDataDialog.js\":\"297a0128d1124253\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/actionDispatch.js\":\"286b05805b1ce120\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/actionRefItems.js\":\"e34ac24a781d2e16\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/applyKeybindingOverrides.js\":\"1ad7ec933966f379\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/blockActions.js\":\"a74be5742d211344\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/blockMergeGesture.js\":\"0b5698eb260b0cbf\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/canonicalizeChord.js\":\"27240a4108531877\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/defaultContexts.js\":\"ca16b53573101587\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/defaultShortcuts.js\":\"63274da4a44b26f1\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/effectiveActions.js\":\"093b48b35ea0fc9f\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/gestureAction.js\":\"4d6b0b887076a1d0\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/gestureBinding.js\":\"f6f89333e928b171\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/holdRegistry.js\":\"1d53a6048398fbdf\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/keybindingConflicts.js\":\"aa643ab34b4fc49e\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/keybindingOverrides.js\":\"e73b465fc834984d\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/pointerAction.js\":\"2a18be70bc5438dd\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/resolve.js\":\"b363a79b935015b3\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/runAction.js\":\"d91d6751b856f06f\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/sequenceMatcher.js\":\"7271a445fdb611ca\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/types.js\":\"98734f95196e45d9\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/useActionContext.js\":\"185b3891ece8d6ae\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/useActionDiscovery.js\":\"f89dd3217cc024a0\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/utils.js\":\"49db1a7301d18a0a\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/bootStore.js\":\"937f2cd67143fea9\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/previewDatabases.js\":\"68d5f4255f740ad1\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/byteTransform.js\":\"e7bdcd780cb78af2\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/attachmentCleaner.js\":\"5a252d45b24e30ce\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/attachmentParts.js\":\"d63451260e42f53d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/bundleParts.js\":\"e0d3029d1abbdf46\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/bundleRecord.js\":\"adddff6bee3c294b\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/manifest.js\":\"65cac8730f40eb87\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/takeBundle.js\":\"bde7f51f64e7fcf0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/verifyBundle.js\":\"3fdebc580c5876c5\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/cleaningStage.js\":\"962e93044ffe79b9\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionKey.js\":\"39ebdd30bb743811\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionServer.js\":\"fc6e6f4fbb45779d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/flip.js\":\"41ccc20d3238ada0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/flipAttempts.js\":\"98b4b600caa60ac5\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/pages.js\":\"fc2501e7299b5b4f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/preflight.js\":\"7b3fd3d321c480b8\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/reseal.js\":\"825c0407fc9cf6af\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/runConversion.js\":\"dbc6ecf9651e8dff\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/runLock.js\":\"17f86846d7c22a22\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/sealing.js\":\"52525374ddaea0c3\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/sealingStage.js\":\"55bb5a80741f7afb\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/stage.js\":\"e905f8c8f3082338\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/verifyReseal.js\":\"0714931ef8b09f2e\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/aad.js\":\"0221dbba105b5be4\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/aead.js\":\"c9556a247083e64f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/base32.js\":\"c101c378a05b0004\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/base64url.js\":\"506ee36ed2a5aeff\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/binaryEnvelope.js\":\"52059b05f2518793\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/byteAead.js\":\"8fbfd115034bcd19\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/canary.js\":\"3a1539e7ab2a74d9\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/contentHash.js\":\"b50ed4d8b739b1d4\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/contentKey.js\":\"2621f71ac9b15f45\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/derivedIdNamespace.js\":\"3ac126af4ba3630f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/envelope.js\":\"e68c82ce5fa74051\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/hex.js\":\"43d3be0a6dce2924\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/sha256Hex.js\":\"2db0bf34b607bad1\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/workspaceKey.js\":\"cfac5c14ceb5acbd\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/conversionState.js\":\"a1a72d05327775d1\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/createEncryptedWorkspace.js\":\"437b9e4b6a0f6f35\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/pastedKey.js\":\"2bc3fc6d1aaa1637\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6b1b193ea16fc9c7\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e4131c1c68a0876f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/keyStore.js\":\"70733e8ab6f1d621\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/mintWorkspaceKey.js\":\"979d40103647c462\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/modePin.js\":\"087d6e5acf2f9b01\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/openWorkspaceKeys.js\":\"60f0d82e302e8c0a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/resolveWorkspaceEntry.js\":\"b966f79ed835fe83\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/resolver.js\":\"7e294b953f608f3d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/workspaceAccess.js\":\"23074702c9d3c71a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/transform.js\":\"c75b0de171de76ed\",\"/knowledge-medium/pr-preview/pr-1639/src/themeBootDefaults.js\":\"5b997d290e0667a0\",\"/knowledge-medium/pr-preview/pr-1639/src/types.js\":\"3f9fc16b1b547761\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/ClientLocalSettings.js\":\"908ca4e19f4f3376\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/abortableSleep.js\":\"52911ffe0a589c94\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/array.js\":\"fa168ec44fadf103\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/backlinkAutocomplete.js\":\"a54c002560d9fdc9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/blockCrumbs.js\":\"e73641c057464bcd\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/blockrefAutocomplete.js\":\"2972cde46edfe463\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/cadencedIdleJob.js\":\"4a270d7f1f79a977\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/callbackSet.js\":\"64ead0148f85518d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/clientId.js\":\"a6f80fc40eafdc6a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/codemirror.js\":\"bcf24b9c7359aa38\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/codemirrorCompletion.js\":\"a36e8e9eedd8db5d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/copy.js\":\"d572fb2ad65996ba\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dailyPage.js\":\"2d27c4b84170bf96\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dbForensics.js\":\"6ce7cf26beaa0885\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dbForensicsHooks.js\":\"ae0236153da3e0ba\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/deleteBlockThroughUi.js\":\"b5b402a541f335d5\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dialogs.js\":\"a4ff4bfd2861fb21\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dom.js\":\"85c255a29756d369\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/downloadBlob.js\":\"d29a6ade9d9d739e\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/exportSqliteDb.js\":\"14baae85bbda6332\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fileSystemAccess.js\":\"7bcb9b2c367941b7\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/flipSlide.js\":\"c8e027cb398176c5\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fnv1a.js\":\"6ba67d0561cc82cc\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/formatBytes.js\":\"92815091b36cf00f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fuzzyRank.js\":\"7f2e9cde776746b7\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/idbKeyedStore.js\":\"22462b86aebcb620\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/idleCallbackPolyfill.js\":\"0447d4a104154fad\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/keyboardAwareScroll.js\":\"1c6b165d1ecd4871\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/keyboardViewport.js\":\"e83efe372d7f1aa2\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/lastWorkspace.js\":\"e2d1522428054b07\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutColumns.js\":\"0dcea3bc1cef79b4\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutSessionDom.js\":\"b707564eec5416cb\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutSessionId.js\":\"f51b6fe7e92dc4a9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/linkClickGestures.js\":\"d43ae99a0df891c8\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/linkTargetAutocomplete.js\":\"bcfa5c312841036b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/localDbCorruption.js\":\"bb255b36f0ac75ce\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/localDbRecovery.js\":\"62a2bb2115dc39b9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/markdownParser.js\":\"e387ee6d67fb8dfc\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/memoize.js\":\"09260c1881b27240\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/nameFieldCommit.js\":\"450e2d5209963919\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/nameList.js\":\"f39e9f769b9f67fc\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/navigation.js\":\"9cc964bedf69da37\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/omnilinerNamespace.js\":\"b2de1a82ad842e9a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/opfsPageScan.js\":\"c7dda8f8693f3c0b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelClearance.js\":\"de3e0d11f74d5163\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelHistory.js\":\"c9c40503ebcba801\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelLanes.js\":\"cc2103e6956d6956\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelLayoutProjection.js\":\"7c6d4d45afdecf66\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelScrollAnchor.js\":\"478738f0f4731520\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelUrlFlags.js\":\"edfb8cee050df072\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/platform.js\":\"1ca3ecfb172f30bc\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/pluralize.js\":\"74d56906f662c674\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyCreation.js\":\"d9b5088b05fb6afa\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyNavigation.js\":\"31e8a0892fb4ddf4\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyValueContext.js\":\"bf8ba102cec9d9ca\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/react.js\":\"b479c924f74fe0f6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/relativeDate.js\":\"dea165e63334844d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/relativeTime.js\":\"b493641611ccfe9d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/renderScope.js\":\"669097d0e21c5b81\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/resolvedThenable.js\":\"0453a74d10975485\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/routing.js\":\"750a9f17db15fee6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/safeMode.js\":\"691cde042afb4c7f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/scheduleIdle.js\":\"4d3d63dfbc82ea92\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/screenWakeLock.js\":\"6748da4d452765d0\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/selection.js\":\"c7e002fa1269005e\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/softKeyboardGrab.js\":\"4d5fe81076fca858\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/startupTimeline.js\":\"614a3bd23625f1da\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/state.js\":\"0aab580b28e094fc\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/string.js\":\"5e0b3e2b97f5089b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/surfaceZoom.js\":\"fd94aede32b21127\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/time.js\":\"6e353848c475f636\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/toast.js\":\"bcbcc202d9bfedc2\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/toggleStore.js\":\"df9fa9a31624f68a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/untilStopped.js\":\"763da65cec305eae\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/userActivity.js\":\"edc15224a9619bb1\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/viewTransition.js\":\"1396581c94e51b0a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/viewport.js\":\"b21b6f8ca8b51203\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/webLock.js\":\"d52da35841de607f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/workspaceRecovery.js\":\"44f814667eb635ff\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/workspaceSnapshotStore.js\":\"9e1a03bffb314c11\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-compiler-runtime.js\":\"497fa7cbe2ed87c3\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-client.js\":\"de5166cfe6970d91\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-server-edge.js\":\"6c977840df3bbaa9\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-server.js\":\"7274a3038f22f3e4\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-static-edge.js\":\"cb77f8884c2b1d31\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-static.js\":\"d3a3865c1f601604\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-test-utils.js\":\"0ecd16d5c1e222c4\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom.js\":\"660a65e4dcf793f3\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-jsx-runtime.js\":\"b74388a7411efae2\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react.js\":\"91b909248e5f22d2\",\"/knowledge-medium/pr-preview/pr-1639/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1639/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1639/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
