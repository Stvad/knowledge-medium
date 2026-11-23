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
		buildId: "8a962862b44b-9cb592e7",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/\":\"5949bb193a17a14c\",\"/knowledge-medium/pr-preview/pr-1639/index.html\":\"5949bb193a17a14c\",\"/knowledge-medium/pr-preview/pr-1639/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1639/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1639/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1639/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1639/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1639/assets/FacadeVFS-BJWqMA60.js\":\"10eaa0eaf0f0fc52\",\"/knowledge-medium/pr-preview/pr-1639/assets/OPFSCoopSyncVFS-Cq9fChfU.js\":\"e1b0fe75a57dcf52\",\"/knowledge-medium/pr-preview/pr-1639/assets/OPFSWriteAheadVFS-DMKdtDhq.js\":\"7726150954b299d8\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-CMlrU44c.js\":\"1ff4fb22c92c5210\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-async-1yPaDbmh.js\":\"a54fccc757250bf9\",\"/knowledge-medium/pr-preview/pr-1639/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1639/assets/worker-DeeUBQC9.js\":\"c686265e477f2f29\",\"/knowledge-medium/pr-preview/pr-1639/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1639/chunks/app-Dag6smUP.js\":\"fdc8450deaa9c0f4\",\"/knowledge-medium/pr-preview/pr-1639/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1639/index.js\":\"f78ec79537bd4955\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1639/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1639/assets/AccessHandlePoolVFS-B5zDZ-_S.js\":\"da947d207f0d4b34\",\"/knowledge-medium/pr-preview/pr-1639/assets/IDBBatchAtomicVFS-B48GIJud.js\":\"2cbf210466faf9ce\",\"/knowledge-medium/pr-preview/pr-1639/assets/MemoryVFS-xnphci4M.js\":\"e3388f93fb68444b\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-async-B1UmirEJ.js\":\"b0d60f437abd88e0\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1639/assets/mc-wa-sqlite-dJYiCHJj.js\":\"5f16316386b36309\",\"/knowledge-medium/pr-preview/pr-1639/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1639/chunks/AccessHandlePoolVFS-DVI1BgFl.js\":\"61103d9532e3f2cd\",\"/knowledge-medium/pr-preview/pr-1639/chunks/FacadeVFS-B48V_ja2.js\":\"33b6f06b451db6ad\",\"/knowledge-medium/pr-preview/pr-1639/chunks/IDBBatchAtomicVFS-gFcydj4h.js\":\"0ed11958120e2af5\",\"/knowledge-medium/pr-preview/pr-1639/chunks/MemoryVFS-B6nO_yAh.js\":\"6826e01ee04424de\",\"/knowledge-medium/pr-preview/pr-1639/chunks/OPFSCoopSyncVFS-BbYrQ2kR.js\":\"94e66329cf6067f5\",\"/knowledge-medium/pr-preview/pr-1639/chunks/OPFSWriteAheadVFS-BgAuJTJ8.js\":\"7a1a8b0276ad280f\",\"/knowledge-medium/pr-preview/pr-1639/chunks/Preview-ztbXy1a6.js\":\"dee9472bcf52eb5d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1639/chunks/card-CKI8KpaL.js\":\"7143b7f027cf5d19\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1639/chunks/dist-DvZ8lVyc.js\":\"5acf0a770ed00d34\",\"/knowledge-medium/pr-preview/pr-1639/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1639/chunks/mc-wa-sqlite-Dv3JD0xo.js\":\"29e8b7eb14a801d7\",\"/knowledge-medium/pr-preview/pr-1639/chunks/mc-wa-sqlite-async-3bVklRvy.js\":\"6688fbae95616585\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-0RZPM1qV.js\":\"96df62d958336240\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-BCy2mi2r.js\":\"9058c2e7e3057af8\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-CxMifXim.js\":\"53dde553687704e1\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-DAb0cweb.js\":\"46605068fda591e0\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-DEIUoqDg.js\":\"0d8019423739c324\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-DitPx1Vu.js\":\"483a4090a9451e33\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-bAZWxLZg.js\":\"8f2bd0d21a7b7477\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server-legacy.browser.production-_xvIDHF3.js\":\"b2a2115755cb7342\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server.browser.production-GoKUKWhR.js\":\"2af906604a1b14e9\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-dom-server.edge.production-BFJO1LJc.js\":\"51bfcaffce2a4527\",\"/knowledge-medium/pr-preview/pr-1639/chunks/react-pKcWSKIP.js\":\"fc133fff26607eda\",\"/knowledge-medium/pr-preview/pr-1639/chunks/server.browser-oe7yNNxW.js\":\"0e3ee7e357c0e084\",\"/knowledge-medium/pr-preview/pr-1639/chunks/textarea-DexUIRJY.js\":\"80e9061848e15ca1\",\"/knowledge-medium/pr-preview/pr-1639/chunks/ui-tDkZrBRR.js\":\"17efdd51d3e34503\",\"/knowledge-medium/pr-preview/pr-1639/chunks/wa-sqlite-DHM-V1W5.js\":\"84eb7ff566383ef1\",\"/knowledge-medium/pr-preview/pr-1639/chunks/wa-sqlite-async-D2lD5rsi.js\":\"88e9d58e7397a92d\",\"/knowledge-medium/pr-preview/pr-1639/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1639/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1639/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1639/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1639/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1639/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1639/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1639/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1639/src/App.js\":\"ea26e2fd782d5cca\",\"/knowledge-medium/pr-preview/pr-1639/src/appUpdate.js\":\"d06063f4993cd1c2\",\"/knowledge-medium/pr-preview/pr-1639/src/appVersion.js\":\"b08cbd9fd7261724\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/initialLayout.js\":\"7847a36dbac3f35b\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/openWorkspaceData.js\":\"2109ab57f51f2a8b\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/resolveWorkspace.js\":\"5d5b5df9da654715\",\"/knowledge-medium/pr-preview/pr-1639/src/bootstrap/workspaceBootstrap.js\":\"d2dc0e5d70fcc271\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockComponent.js\":\"b7d49e19e17a9061\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockCrumbs.js\":\"2ff5b58544ba6a70\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockEditor.js\":\"8245ea49cad17241\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockLoadingPlaceholder.js\":\"343ba95881e792ca\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockProperties.js\":\"64f14a6f8a912152\",\"/knowledge-medium/pr-preview/pr-1639/src/components/BlockSearchPicker.js\":\"33c346cb4e0c4db8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ConfirmBulkDeleteDialog.js\":\"8e87895aabd75488\",\"/knowledge-medium/pr-preview/pr-1639/src/components/DividerHandle.js\":\"5d21e2552b03d2b8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/DraftEditor.js\":\"d3b0a3b2c4dec165\",\"/knowledge-medium/pr-preview/pr-1639/src/components/GutterPill.js\":\"717aa6cd57dfe922\",\"/knowledge-medium/pr-preview/pr-1639/src/components/Header.js\":\"499766ff29b85bb4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/LazyBlockComponent.js\":\"f717e2dc44e93111\",\"/knowledge-medium/pr-preview/pr-1639/src/components/Login.js\":\"c89b5c75ae197d6d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ZoomableSurface.js\":\"1a66ebd8c0a17cb3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/editModeKeepalive.js\":\"4c82eaef7d9f043e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5864ede9a0070d72\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8586a4a18ec4d26e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/RefPropertyEditor.js\":\"c97b255ad6a35262\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/RefTargetTypePicker.js\":\"6ff44fee0c3222c6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/SelectPropertyEditor.js\":\"b0adf2127f81bf65\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/TypesPropertyEditor.js\":\"548485ee0cad53ae\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/defaults.js\":\"3c469a9db17247b8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/kernelValuePresets.js\":\"ea2f54dd6900d642\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/selectablePresets.js\":\"37bd9ad6dffc77fe\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyEditors/typesPropertyUi.js\":\"89e4d4b08cdac9ab\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/AddPropertyForm.js\":\"dd79d3d0c7925d99\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/PropertyPicker.js\":\"51c5721e6d764db6\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/PropertyRow.js\":\"4c19102323fdd702\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/Rows.js\":\"23b1b2adf0c27b47\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/actions.js\":\"0363e6a536de3d74\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/declarationOnly.js\":\"46d88353c5ab3601\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/layout.js\":\"cef7d7f40932795a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/model.js\":\"06e2df9bb1f878bc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/shapeUi.js\":\"09b1220339c7c6bc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/shapes.js\":\"b27508544610bf3d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0ed25c414a8e19ea\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanel/visibility.js\":\"4f4cde0ab4233e89\",\"/knowledge-medium/pr-preview/pr-1639/src/components/propertyPanelSections.js\":\"32dcf050a4141186\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockEmbed.js\":\"19c0ac039dfbf11a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockLink.js\":\"f59c453b93297eb4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/BlockRef.js\":\"d50358f6b551a467\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/ReferenceLink.js\":\"99b4adadedab8b5e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/cycleGuard.js\":\"8e4f29307de8f87b\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/cycleGuardContext.js\":\"966a826846b25524\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/linkInteraction.js\":\"0af5be189999f602\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/referenceLayout.js\":\"8db73c87d17ece81\",\"/knowledge-medium/pr-preview/pr-1639/src/components/references/useBlockRefAncestors.js\":\"4d7a40b83dbc30f8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockGutter.js\":\"f1e9cddcc059012a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockInfoDialog.js\":\"1ff537c7b8f61669\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BlockTypeBlockRenderer.js\":\"9ff0b825361bec55\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/BulletHoverCard.js\":\"e4243c4a31803c22\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/CodeMirrorContentRenderer.js\":\"c609786b940634eb\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"907302ee039e6d3d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/ColumnResizeHandles.js\":\"9e6cbea339ae8678\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"58141a1458eb301a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/DefaultBlockRenderer.js\":\"3ea122e29ec3da29\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/LayoutRenderer.js\":\"de8195935632d3bf\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/MarkdownContentRenderer.js\":\"c2b30b0eb78594b4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/MissingDataRenderer.js\":\"40830837139b66d8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/PanelRenderer.js\":\"d2768287c7b63eb5\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/PropertySchemaBlockRenderer.js\":\"79149374a0342f32\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/TopLevelRenderer.js\":\"3581291c6c8c9830\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/blockGutterMode.js\":\"4b8a7fbd36f23f96\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/blockTitleText.js\":\"b4fabe519ccea7e3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/fieldCreationKeydown.js\":\"c36e1a9cdb9b03b8\",\"/knowledge-medium/pr-preview/pr-1639/src/components/renderer/layoutRootContext.js\":\"29a8cea5a9b83e9c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/typeChip/TypeChip.js\":\"61561f921173b529\",\"/knowledge-medium/pr-preview/pr-1639/src/components/typeChip/chipStyle.js\":\"3502a59794768a9f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/anchored-floating.js\":\"cecd95c55951d54e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/button.js\":\"fb783b33f3d55cfb\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/card.js\":\"bbba8ec7db57cea4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/checkbox.js\":\"73e26abdafeb2e53\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/collapsible.js\":\"c975a938b978db60\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/command.js\":\"4897beb1f2584a4e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/context-menu.js\":\"609bd9096d3526fc\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/dialog.js\":\"837c933d9cfe9e7d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/dropdown-menu.js\":\"f02beb259e009963\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/floating-listbox.js\":\"943113f16a925d61\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/index.js\":\"b110b680e4a63788\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/input.js\":\"ac81e5dd9e7aa049\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/kbd.js\":\"13d282b214852b7a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/label.js\":\"3b18bd961f039f8d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/ui/textarea.js\":\"bf97bd15b68cbf3d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/useEditModeYieldKeepalive.js\":\"f87a0dd3365c14c3\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/BootFallback.js\":\"cb6603a9ccaf6f2a\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/FocusedRowLazyMount.js\":\"30d1cd1e4afa9614\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/LazyViewportMount.js\":\"2eec8417350662aa\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/LocalDbCorruptionFallback.js\":\"fe93d0348038b680\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/error.js\":\"f7ec1465fb4bb2c9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/lazyMountRegistry.js\":\"e5211ff266f6ae80\",\"/knowledge-medium/pr-preview/pr-1639/src/components/util/suspense.js\":\"8bb61e30458d320d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/CreateWorkspaceDialog.js\":\"d113bfc346b4a079\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/PendingInvitations.js\":\"f660be44e471b72c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/SyncProgress.js\":\"0b3e360808cbe134\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/UnlockProgress.js\":\"1b28a551926c698c\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceKeyGate.js\":\"8e37ae5ba2692b01\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSettingsDialog.js\":\"4b59a1043f5e0607\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSwitcher.js\":\"7cc1f00fde70c050\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/WorkspaceSyncGate.js\":\"39dd69e50fb2c81e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/ConversionFlow.js\":\"8ce6fa9d4d36ea8e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/ConversionFlowHost.js\":\"38309aafbbbd4400\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/EncryptionSection.js\":\"ffcf5766bae62889\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/attachmentPrompts.js\":\"7e612fdb9992930e\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/bundleFolderPrompts.js\":\"146c925a88f8654f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/conversionFlowDeps.js\":\"c035e2246519aa38\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/conversionFlowStore.js\":\"666d9d1325aa4da4\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/flowUi.js\":\"a23d000e15fb9d1d\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/conversion/useConversionRun.js\":\"3726d91e9782b8a9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/keyUi.js\":\"d8a2cfa1498c68c9\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/useCloseOnKeyLoss.js\":\"34ae10fbe0e74170\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/useCloseOnServerE2ee.js\":\"d1cbbb1d87a6766f\",\"/knowledge-medium/pr-preview/pr-1639/src/components/workspace/workspaceUnlocked.js\":\"a945a7736143829f\",\"/knowledge-medium/pr-preview/pr-1639/src/context/backgroundSubtree.js\":\"79738cceac4370e4\",\"/knowledge-medium/pr-preview/pr-1639/src/context/block.js\":\"449b68c878cb865a\",\"/knowledge-medium/pr-preview/pr-1639/src/context/layoutWsContext.js\":\"2d3dafc32591b9ab\",\"/knowledge-medium/pr-preview/pr-1639/src/context/propertyDisplay.js\":\"baef63ec7bc5c15e\",\"/knowledge-medium/pr-preview/pr-1639/src/context/repo.js\":\"e4efcb64bb537d40\",\"/knowledge-medium/pr-preview/pr-1639/src/data/aliasClaim.js\":\"36cac1277adccec6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/aliasSeatNamespace.js\":\"7c06da6bfea9e5bb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/blockData.js\":\"b4dd4ae985b1549d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/blockType.js\":\"a66389d3f677fd29\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/changeScope.js\":\"cbb6504eea6c5af8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/codecs.js\":\"0185bdeae021679f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/derivedData.js\":\"ac4fd8ede321d6b1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/errors.js\":\"4e0ca12f212b711a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/events.js\":\"71abb0ed599fb6d4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/handle.js\":\"114360a5dd8ddcb4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/index.js\":\"a71f7f97d5dd675b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/mutator.js\":\"076697441bcf447c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/processor.js\":\"d87bcd367512882a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/propertySchema.js\":\"7fc3339e6021e270\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/query.js\":\"6c70a66c37995782\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/sameTxProcessor.js\":\"2370d25f84c7ffa1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/schema.js\":\"114360a5dd8ddcb4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/tx.js\":\"114360a5dd8ddcb4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/typedBlockQuery.js\":\"182f6843c87c660a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/user.js\":\"d58f04ce1f4d3c6a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/valuePresetCore.js\":\"30e6af34527fea44\",\"/knowledge-medium/pr-preview/pr-1639/src/data/api/valuePresets.js\":\"6a8815f6ad16598b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/attachmentCleanerIOVerb.js\":\"6fc06247e8cb3fd3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/block.js\":\"a49ae298d9864b73\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockCache.js\":\"5f14b3787fb19746\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockId.js\":\"914f3137e87b9b46\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockLiveness.js\":\"1cf2620cba9f34b3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockMerge.js\":\"708de06f7dfe4125\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockSchema.js\":\"00b021f17fefff1c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockTypeLookup.js\":\"259cb1e0480b97a2\",\"/knowledge-medium/pr-preview/pr-1639/src/data/blockTypes.js\":\"7efdb60465d496b6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/childrenView.js\":\"acd31f7495d14c45\",\"/knowledge-medium/pr-preview/pr-1639/src/data/clientContext.js\":\"6170361ff2b91561\",\"/knowledge-medium/pr-preview/pr-1639/src/data/dbFileSiblings.js\":\"ae37ab1631305dae\",\"/knowledge-medium/pr-preview/pr-1639/src/data/definitionSeeds.js\":\"8671b697a7b471c7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/derivedIds.js\":\"c464d127b81f6db9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/drawnSubtree.js\":\"80948f864156028c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/facetBridge.js\":\"b6f522b75c23bb38\",\"/knowledge-medium/pr-preview/pr-1639/src/data/facets.js\":\"c441c1bd3e4c2711\",\"/knowledge-medium/pr-preview/pr-1639/src/data/globalState.js\":\"1add1a949e814427\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/aliasClaimRederiveProcessor.js\":\"2b89a8b994bfbe02\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/ancestorBatch.js\":\"d85b98ecad996a85\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/blockTypeTypeifyProcessor.js\":\"b451f4e7646eae20\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/clientSchema.js\":\"f1a76f975b00701d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/commitPipeline.js\":\"0d03b410979b80b1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/devAssertions.js\":\"e75be328b7193e3e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/firstSync.js\":\"c722bc1e1fe46607\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/freshInitialLoad.js\":\"4a75216af6e15430\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/graphBackfillClaim.js\":\"0d1aa65ea6b80731\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/handleStore.js\":\"1b2e4df804395a25\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/idleMarkerJobs.js\":\"eb4100668676e481\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/initialDownload.js\":\"7634bb23c2be74eb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/initializeClientDatabase.js\":\"7ab281c3fd47eeff\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/jsonCanonical.js\":\"99cae7f06ffd1cfe\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelInvalidation.js\":\"9d6081c658793333\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelProcessors.js\":\"ddd5496938a7e8cf\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/kernelQueries.js\":\"2dea4485ca8548ae\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/mergeTypeMembershipProcessor.js\":\"4840a940d0ad3867\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/normalizeReferencesProcessor.js\":\"5d13efc016eeeab5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/poolInstrumentation.js\":\"10b01a5a3ddf22f9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/processorRunner.js\":\"6294d6bf8dd0d689\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyCellBackfill.js\":\"f708f964574869c9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyChildMint.js\":\"c5d92aa96cc80a82\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyChildrenProcessor.js\":\"76176a19a838ffef\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyDefinitionChangeProcessor.js\":\"094567083a76b7f0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyDefinitionSynthesis.js\":\"d12c3a754634a195\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyKeyScan.js\":\"86bb78c5118769d0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertySchemaResolution.js\":\"e3034fa78cf2312b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/propertyValueEdits.js\":\"d8dccbbf33a616fc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/raiseProtocol.js\":\"c9f7128201c484f1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/readBatch.js\":\"e7cbec570bff7fbe\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/refProjection.js\":\"2a19d1e9b60b608c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/referenceTargetLookups.js\":\"a143db737b579b5a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/referenceTargetProcessor.js\":\"93401147d3e1ed99\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/replayMerge.js\":\"dedd89b66bdc46f1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/sqlBinds.js\":\"e29414dca526be4c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"53cf0670b6c0c7b0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/arrivalProcessors.js\":\"b52cc4fd6a41f3b8\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/invalidate.js\":\"40d88fce47335ecc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/materialize.js\":\"88f9e72a47e49e20\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/observer.js\":\"408a0bf3ff0a4c59\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/syncObserver/reconcile.js\":\"d7a7bf381c262981\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/timingMetrics.js\":\"09278f4cac3f23f6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/treeQueries.js\":\"76f14ca2fc094e57\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/txEngine.js\":\"d0c690e4939d04f6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/txSnapshots.js\":\"0dba3966616dd444\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/typedBlockQuery.js\":\"f1f556471600ec8a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/internals/undoManager.js\":\"2911eee2aa1803e1\",\"/knowledge-medium/pr-preview/pr-1639/src/data/invalidation.js\":\"358b676bd80b5b13\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelDataExtension.js\":\"cf027fb1d941ce8f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelPage.js\":\"03923f7c7f4eae75\",\"/knowledge-medium/pr-preview/pr-1639/src/data/kernelValuePresetCores.js\":\"87952bc1b4577e4f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbCorruptionSignal.js\":\"0277afcd7d16e649\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbStorage.js\":\"f48a870128d3a68a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localDbVfs.js\":\"e5c955d56f46075b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/localSchema.js\":\"162445258bd8d516\",\"/knowledge-medium/pr-preview/pr-1639/src/data/maintenance.js\":\"1fb66557b9f5a513\",\"/knowledge-medium/pr-preview/pr-1639/src/data/mergeProperties.js\":\"63c8dba195e618ea\",\"/knowledge-medium/pr-preview/pr-1639/src/data/metricsConsoleHook.js\":\"a4ffa4e278c509dd\",\"/knowledge-medium/pr-preview/pr-1639/src/data/migrationsPage.js\":\"fb96078c4c6b06b7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/mutators.js\":\"4acaeac7aa637095\",\"/knowledge-medium/pr-preview/pr-1639/src/data/orderKey.js\":\"676fd56313356b8f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/orderKeyPlacement.js\":\"e5bb981bbcbf70f3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/outlineSurface.js\":\"a900e91ddc5549eb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pendingEditorContent.js\":\"ce82b0c699824bea\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pendingUploadsSql.js\":\"5982ddd9d864527c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/pluginStateExtensions.js\":\"83361efa03163093\",\"/knowledge-medium/pr-preview/pr-1639/src/data/powerSyncLogger.js\":\"d66b38101798a5fc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/projectorRuntime.js\":\"87218300d32a4d22\",\"/knowledge-medium/pr-preview/pr-1639/src/data/properties.js\":\"2d7dfbe5677c91d2\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertiesPage.js\":\"e854290a0b83ae2e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyChildren.js\":\"803f0ead80a02aaa\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionFanout.js\":\"5032f7199fcb93e9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionMetadata.js\":\"ad467a2c4018f30e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDefinitionRegistry.js\":\"64059eb44b4b407f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyDisplayMode.js\":\"33278a15656dea3d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertyRowCreation.js\":\"c728f7c1cec20c8a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertySchemaCreation.js\":\"511415ab734853b3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/propertySeeds.js\":\"f309d92b735c22a9\",\"/knowledge-medium/pr-preview/pr-1639/src/data/recentsPage.js\":\"8e552e737e2c2c7b\",\"/knowledge-medium/pr-preview/pr-1639/src/data/referenceBlock.js\":\"4ad47109771b4bde\",\"/knowledge-medium/pr-preview/pr-1639/src/data/rejectedUploads.js\":\"bc0d03c7e43260bb\",\"/knowledge-medium/pr-preview/pr-1639/src/data/releasePowerSyncConnection.js\":\"15acdc3b92f042ef\",\"/knowledge-medium/pr-preview/pr-1639/src/data/repo.js\":\"12746df1a262a7cc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/repoProvider.js\":\"ba8a7dfcc6b64576\",\"/knowledge-medium/pr-preview/pr-1639/src/data/rowProperty.js\":\"df209b31d3044a97\",\"/knowledge-medium/pr-preview/pr-1639/src/data/searchFilter.js\":\"af1e28dc962947d3\",\"/knowledge-medium/pr-preview/pr-1639/src/data/seedIdentityLedger.js\":\"8779ac97bf661516\",\"/knowledge-medium/pr-preview/pr-1639/src/data/stateBlocks.js\":\"9779516f2c4f1b57\",\"/knowledge-medium/pr-preview/pr-1639/src/data/structuralEditPolicy.js\":\"aa7c1326d5de8be6\",\"/knowledge-medium/pr-preview/pr-1639/src/data/subtreeDelete.js\":\"590ae8735e69bebd\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncStreamLock.js\":\"c375c20f2a682f62\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncedTableSqlRecognizer.js\":\"90b1fccf9ff6dd19\",\"/knowledge-medium/pr-preview/pr-1639/src/data/syncedTableWriteGuard.js\":\"123b254059e971fc\",\"/knowledge-medium/pr-preview/pr-1639/src/data/targets.js\":\"7180fe151dd506d0\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeColors.js\":\"90360eab8f1f481e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeDefinitionMetadata.js\":\"0a32b85491d4e7df\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeDefinitionRegistry.js\":\"c8bc993dae553987\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeExtraction.js\":\"f70e44b20b1c33f4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeInitialValues.js\":\"17cec20bad0a6434\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typePropertyGroups.js\":\"d54ba5ef812f4230\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeSeeds.js\":\"a302ace06649b4e7\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typeTagger.js\":\"7a1069ce60761ed5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typedRecords.js\":\"f0885929b400985c\",\"/knowledge-medium/pr-preview/pr-1639/src/data/typesPage.js\":\"70c59a34ddf63e30\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userPrefs.js\":\"c638622055bf2c8d\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userSchemasService.js\":\"a6a08a91cf4672a4\",\"/knowledge-medium/pr-preview/pr-1639/src/data/userTypesService.js\":\"510bbe3d4f121d2f\",\"/knowledge-medium/pr-preview/pr-1639/src/data/valuePresetRegistry.js\":\"5168da870c625698\",\"/knowledge-medium/pr-preview/pr-1639/src/data/visibleChildren.js\":\"c543922574bc8b8a\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceConversion.js\":\"839b8abd42028a76\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceFirstSync.js\":\"d8ba5a97e2e432f5\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceIdNamespace.js\":\"f675a56e1b669d92\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaceSchema.js\":\"374a2ff2a5b87f2e\",\"/knowledge-medium/pr-preview/pr-1639/src/data/workspaces.js\":\"035382b7a6185435\",\"/knowledge-medium/pr-preview/pr-1639/src/data/writeAheadLog.js\":\"c34a72f1ea1c6072\",\"/knowledge-medium/pr-preview/pr-1639/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/BlockPasteShellDecorator.js\":\"443a5b4169822911\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/atTrigger.js\":\"1ebf03f656ade7a8\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/autocomplete.js\":\"186f7dd98847ff5f\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/codeMirrorExtensions.js\":\"d59c612c1673381f\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/contentFlush.js\":\"fc8c8a55f0be7c9c\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/defaultInteractions.js\":\"e54a114545bbb6e6\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/editSettleSignal.js\":\"7a91b1aede1c69b6\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/insertImage.js\":\"bc752a29aad611a6\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/referenceCompletionRange.js\":\"cf92327debe80fae\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/referenceTargetTypes.js\":\"fd7597b4e9e12e18\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/syntaxContext.js\":\"a223db80aebb8dd4\",\"/knowledge-medium/pr-preview/pr-1639/src/editor/triggerMatch.js\":\"666277b63db23226\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/AppRuntimeProvider.js\":\"1265f47237353495\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/BlockFocusShellDecorator.js\":\"16d4f3cea76200b3\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/ExtensionRenderBoundary.js\":\"7b799cf53790bc0f\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/PanelContentRecovery.js\":\"e0f85678205ae872\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/apiCatalog.js\":\"471012166c2757e5\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/approveExtensionHere.js\":\"fe9987746801c752\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/armedCutAppMount.js\":\"e2b5fda28a3298bc\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/batchableKeyedStore.js\":\"1a70bbcc6d6006a5\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/blockInteraction.js\":\"5211bc790c083f9d\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/blockSelectionAction.js\":\"98af8a76d403ff17\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/compileExtensionModule.js\":\"9bae2a94ffad5af1\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/compiledModuleCache.js\":\"3379f3f0bd2cf715\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/continuousGestures.js\":\"23995a8234d5b163\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/core.js\":\"63fee023b68be450\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/defaultRenderers.js\":\"f7bc79a33215800c\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/definitionFanoutAppMount.js\":\"1002ca41a7c9fec1\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dialogAppMount.js\":\"463bb82e611b4098\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dynamicExtensionSeeds.js\":\"81f4eb2281092227\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/dynamicExtensions.js\":\"2b3fbd71ebdf5d1f\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/exampleExtensions.js\":\"d6f4b53ebdf97c48\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionApprovalStatus.js\":\"439ba5533df1ea26\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLoadErrorToast.js\":\"fc4e1b0e8f987b4e\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLoadErrors.js\":\"40e0c9af07ad9135\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionLookup.js\":\"f3e2f46edba058c3\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionToggles.js\":\"524539c71eb2df7d\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/extensionUtilitiesCss.js\":\"1bffb3e892a166a4\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/kernelPageDeletionGuard.js\":\"fdc6290f21d7bc5f\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/liveRuntime.js\":\"acb5fc4ca9600dd0\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/openExtensionsSettings.js\":\"e76cc844de5234dd\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/overridesCache.js\":\"001becac01c8f265\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/pluginIds.js\":\"dc476f2aad9a5290\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/processorRejectionToast.js\":\"b8d8232db09d9d02\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/runtimeActions.js\":\"359b808c806d3938\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/runtimeContext.js\":\"fd7b4b1fc7fff64d\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/staticAppExtensions.js\":\"eb44200e6a485c7a\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/staticDataExtensions.js\":\"d2237b197c5c8549\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/toastAppMount.js\":\"2c3681231c34ccd9\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/useOverrides.js\":\"68e5deedc8387aff\",\"/knowledge-medium/pr-preview/pr-1639/src/extensions/useShortcutSurfaceActivations.js\":\"45abc744ebde1a96\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/discoverToggleTree.js\":\"4150810eda330927\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/facet.js\":\"f15df95e4f2d6c24\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/resolveAppRuntime.js\":\"693266c53290776a\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/runtimeEvents.js\":\"c764aac50adb60fc\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/togglable.js\":\"8d1299373da3b98f\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/variantFacet.js\":\"640a450c09d43b83\",\"/knowledge-medium/pr-preview/pr-1639/src/facets/verbFacet.js\":\"48eb9e9b8114303d\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/block.js\":\"b27949a7b760f79c\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/focusedChild.js\":\"c77325c44666e93b\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/propertySchemas.js\":\"d75ab53dafa106ea\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/typeRegistry.js\":\"5fa26ea57961252b\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useAncestorCrumbs.js\":\"d5f4ce57c1fb8070\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useAutocompleteListbox.js\":\"835a72b20c26ab54\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useDebouncedSearch.js\":\"27c0560afcfced82\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useDebouncedValue.js\":\"05c4a8e9beaf34af\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useIsFocalRender.js\":\"f7ec99c44109dbc0\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useIsReadOnly.js\":\"e64b47a11a2808df\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useMaterializeBacklog.js\":\"77d0bab884bb9933\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useMinuteClock.js\":\"995492511d19c2a5\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/usePanelLayoutProjection.js\":\"dc886311bfe95550\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/usePendingInvitations.js\":\"6e8a21c38b2aafbe\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useRendererRegistry.js\":\"5c97988d36e6f4b7\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useRetainedFieldRows.js\":\"13beefbf1fd444f1\",\"/knowledge-medium/pr-preview/pr-1639/src/hooks/useWorkspaces.js\":\"2de57a7ca1aef79c\",\"/knowledge-medium/pr-preview/pr-1639/src/lib/utils.js\":\"10e5e0de96a85726\",\"/knowledge-medium/pr-preview/pr-1639/src/main.js\":\"6b8bebe1faa8ce78\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/MarkdownImage.js\":\"63aa3b867980543f\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/blockSeparators.js\":\"da678f2af2395357\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/context.js\":\"e088a372eec2d8f0\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/defaultMarkdownExtension.js\":\"0361928e421df1fa\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/extensions.js\":\"c9cdb56f993c63d5\",\"/knowledge-medium/pr-preview/pr-1639/src/markdown/renderMarkdownHtml.js\":\"19920576285702b4\",\"/knowledge-medium/pr-preview/pr-1639/src/minimal-editor.js\":\"17c20484a56e7d20\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/armedCut.js\":\"02e2814678bad39d\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/captureMediaVerb.js\":\"5d5f2fd10c2d8559\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/clipboard.js\":\"f77a0d9585c4a967\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/decision.js\":\"08b612a04e84e93c\",\"/knowledge-medium/pr-preview/pr-1639/src/paste/operations.js\":\"63427125037bb3b2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/account-header/AccountHeaderItem.js\":\"086144901ad7b2b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/account-header/index.js\":\"2ae1beb51ff33ca5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bfee4e89e358c9ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/askAgent.js\":\"5ef35da6bc8c46a1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/askedStore.js\":\"1e854bb3885a8046\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ca86d6f33d7ff525\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/chipState.js\":\"69d49e32f4c20d7b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1c4683521011359d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/index.js\":\"879f66174b5ad8c9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"775144c105d3cc74\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-dispatch-companion/schema.js\":\"78991dd87328c82f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c976a94cf91f84cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c1150ef5d972dfdb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/addMedia.js\":\"330df1ecd2d1ce32\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cbf7a10b12257b68\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/block.js\":\"124f574ead4bc551\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/context.js\":\"667deeaca3faaf4a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ecf9f753635a6663\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/index.js\":\"d787872429f3cd8f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/outline.js\":\"ae25bf13d9af430b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/properties.js\":\"552b63b9fc2f1d31\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/refs.js\":\"592e81c7637c061c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ed8a5e914bfa15b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/search.js\":\"c5af4499d72596c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/shared.js\":\"c8422c30123f8e9d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"630a3d3b299466c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentViews/text.js\":\"7b5549c8734eeb4d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/agentWrites.js\":\"16162c198ad45bcf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/authoringCatalog.js\":\"86b08bffe825891b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/blockRefTargets.js\":\"0219e1cdc7b4e1fd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/bridge.js\":\"f96eed5b1f090f08\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/bridgeLoop.js\":\"28583e5a398e51ee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/changeHistory.js\":\"dae3ebaf2c4a5661\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/commands.js\":\"12b35c68afb9e16b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/commentsCommands.js\":\"5fe4fd11a36aaf6e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/dataExtension.js\":\"0c2fcb7c52193048\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/dataModelGuide.js\":\"edbd2e8ee72cfb2f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/describeRuntime.js\":\"f9348cb4a7fcc14d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/extensionLint.js\":\"6884c0b4cca9b3b1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/grainAudit.js\":\"68b058b90558d5cb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/healthCommand.js\":\"6e49eb2a5b4958b2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/index.js\":\"abb7bc9ea4b86e94\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/presetIdentity.js\":\"26846e0c0786d017\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ccb26594aad25136\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/readMedia.js\":\"b1f14e780e0a605c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/schema.js\":\"dff8321eb4e1cdbc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/serialization.js\":\"ce2a615caa80ccc9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/targets.js\":\"2e8388dc27cecb60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/tokens.js\":\"3e33f82142a349f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/watchEvents.js\":\"80ff96ffdc1ad2f6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/workspaceGuard.js\":\"53013f4b99a0d71a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/agent-runtime/writeCommands.js\":\"30f412bc31e1747d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/AliasCollisionToast.js\":\"27c07d7d09f4f10c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/DuplicateNameBanner.js\":\"6b57143e3e638aa0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/collisionMerge.js\":\"31f27d64029053da\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/dataExtension.js\":\"78abf51085fcf5c2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/index.js\":\"68228a65e66bf8d3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/mergeCollisionAction.js\":\"f17b8ef9c20331ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/pageStyling.js\":\"657361c94f99702d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/rejectionToast.js\":\"0913630c096ad74f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/alias/syncProcessor.js\":\"8da490fe998ee766\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/actions.js\":\"fde65a5ef2459870\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/addComment.js\":\"7b78bdfcc3afce27\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/anchor.js\":\"9ef3a93096ee19b5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/anchorState.js\":\"7c610074c0dea1fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/commentLinks.js\":\"eb7929c649c026fd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/confirmThreadDeletion.js\":\"ae7dc53f78ac3e3a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/container.js\":\"3699c5873ca2de08\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/dataExtension.js\":\"e2872a22a63329c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/deleteComment.js\":\"27b9e32c4809ad65\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/highlights.js\":\"9936f2a2ad5ad8e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/index.js\":\"b93676ffa57b907c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/linkedCommentsPill.js\":\"53701a145a9a9417\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/margin.js\":\"2ace22dfa6d5f6e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/marginSchema.js\":\"8e0d9dc7d4e3d845\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/newComment.js\":\"84ca5609204b9c7d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/ownThreadPicker.js\":\"92f539e0e5ea60f6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/placement.js\":\"1df5055cddec6e0c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/queries.js\":\"92c9c31e53322764\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotePosition.js\":\"ab06644068eb72e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotedIn.js\":\"f0b1332c1e5cd410\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/quotedRange.js\":\"02953d6537e2e407\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/rangeRefs.js\":\"c0c890fa115e0680\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readHighlights.js\":\"66229ee7bf72d2f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readSelection.js\":\"8f9efa0f133319f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/readSelectionUi.js\":\"2a17b86ea5f5e036\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/reanchor.js\":\"2de1ce6b5878b5f1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/schema.js\":\"c05eda557fac59cf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/scope.js\":\"c40812f5f95d5fe4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/scopeThreads.js\":\"ae0bcfa88f65da84\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/splitRetarget.js\":\"bbb8bf71fae67c16\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/suggestionCard.js\":\"8f7c9ec2f574160d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/suggestions.js\":\"115c1904b48afd2b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/summaries.js\":\"370ea61efe2eb75f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/summaryBatch.js\":\"b4a098a0b774bd39\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/surface.js\":\"97b66bf534549023\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/threadNavigation.js\":\"2c0e062af2f8b484\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/threads.js\":\"e7685ac8d4ca0266\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/ui.js\":\"ab2993ad530ff697\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/annotations/uiStore.js\":\"b18f7bd3401272aa\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-intents/appIntents.js\":\"34b060e75881adbb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-intents/index.js\":\"738a4e6e770dd1b9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-update-prompt/index.js\":\"5cfdbb879bcde998\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/app-update-prompt/status.js\":\"39fa9417316c6806\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"414fa6c8f53fde3a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaBlockRenderer.js\":\"2d0cbc94c21c6278\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f881329051db3558\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/MediaUploadReconciler.js\":\"4f2d3ee8230428e5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetDownLane.js\":\"bb91b022e1f01155\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetResolver.js\":\"3fff7784a763fd9e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/assetUpload.js\":\"4ab1a94c3f9d7fee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/attachmentCleanerIO.js\":\"07ed11d11f064507\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/supabaseAuditIO.js\":\"93854867a839a17a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/blobStore.js\":\"1dc22410867dd1ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/browserMedia.js\":\"434ead26892042fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/byteStore.js\":\"a70950dc4c78e01d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/cleanerIO.js\":\"b1394aeb57cfcaba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/cleanupAttachments.js\":\"565b54f48ec9bf38\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/dataExtension.js\":\"977623b40031ef26\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/downLane.js\":\"d69ebcc6eba2a2fd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/index.js\":\"2fada62a3166902a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/insertImageContribution.js\":\"18ec1df2bb9bfb0e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/laneArming.js\":\"9c2827e8dad1a089\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/laneLock.js\":\"ffc271d97c0d3bb1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaBlock.js\":\"3b8fd5a4f0b0120b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaCapture.js\":\"e3ce7e99b0ab417d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaLanes.js\":\"f825bc11fcc23fe0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaViewers.js\":\"e04252256813d49b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/mediaViewersFacet.js\":\"20dc9210b7ff381f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/pasteCapture.js\":\"379614d42851a413\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/resolver.js\":\"fa2f2711d9b17775\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/retryUploadsAction.js\":\"f54cdc5603d548c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/storagePaths.js\":\"333cf570cc6a3f1c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadDrain.js\":\"bdcce658318026c2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadLaneStatus.js\":\"e3ee5d155425cadc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadReconcile.js\":\"fc3a38fe640c06e6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadRecovery.js\":\"49d5ca6f63a97712\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/uploadStore.js\":\"f5b5a27de35f2899\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/attachments/useAssetObjectUrl.js\":\"c0e647442fbc59e2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2684006fb21fc7af\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/BacklinksViewSection.js\":\"483d6e47d84d4371\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/facet.js\":\"0cd4ec8f8b4205cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/index.js\":\"52b4fe38ab16c979\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks-view/prop.js\":\"6c739d65a08a401d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BacklinkFilters.js\":\"fa47529f60105d41\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2926d4c10405c071\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/BlockEntry.js\":\"a449444a5135711d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/LinkedReferences.js\":\"ac22d286396ffe40\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cb28bcad8abb53f9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/dailyNoteDefaults.js\":\"611123357ee2a91f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/dataExtension.js\":\"f23dcc9a1cd9b0b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/edgeExclusions.js\":\"b2d54b97d257fd1b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/filterProperty.js\":\"53ee3a1054e90d4f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/index.js\":\"7350ecb689fc6885\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9ecf4e94876630d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/applies.js\":\"2f2809a0b2823b2f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/countQuery.js\":\"f44a2ac3ef86d7ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c91adecf06485408\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/index.js\":\"ac1983493d7cb85d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0925ffa871f5df7e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/presentationInvalidation.js\":\"72b42177c9790b9a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/propertyEditorOverride.js\":\"c0a731b323f2ae67\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/propertyFilter.js\":\"bad52c2fc4b64134\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/query.js\":\"28e3c4d1e30dbfca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/resolveFilter.js\":\"a77fd0f1c608f6f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/sourceBatch.js\":\"b90ebfb31272175e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/sources.js\":\"82ece1f7263bf23e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/useBacklinks.js\":\"b70e63db63888741\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f8d44410bae2c392\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/BirthdayCelebration.js\":\"b09407a151c8a889\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/BirthdayOverlay.js\":\"3e014c022ae2dd9e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/gate.js\":\"e63719450900172e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/index.js\":\"7f1cfc014af4ce53\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/birthday/wolfTheme.js\":\"0d530d9db1322f1d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/BlockDragLayer.js\":\"6fd3dc6d58807b00\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/dragController.js\":\"f0489b8367a2daaf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/dropTarget.js\":\"590aaef9b9cb71a0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/index.js\":\"b77648c4d39ae2a1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-drag/projection.js\":\"69401b7415e8e58b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-info/BlockMetaCard.js\":\"de1ad9e65c995978\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-info/index.js\":\"e62785efcab886ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/AddTagDialog.js\":\"59913e3df25d0ee9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4ef53f18c317a513\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/TagNameIssueHint.js\":\"24fd683173104c5d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/addTagAction.js\":\"6269f969ff604f41\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/appendTag.js\":\"68d5c75009c921e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/config.js\":\"acdfb441ac1292ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/dataExtension.js\":\"4dee09b2474326e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/index.js\":\"f318f3f81dfd4a01\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/block-tagging/propertyEditorOverride.js\":\"a2ac595219279c23\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c37a914d4e9b18cf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1735911ca52dd203\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1441d05561b297ee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c116ee82c42d2a5c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b0244b366b9e81dd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/index.js\":\"ae2045b5cc8dc813\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"42e17fe4b73fff95\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/CharacterCountItem.js\":\"de1f3d6a0decaf92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/ProfilePropertyEditor.js\":\"babf6b1b7e6638be\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/actions.js\":\"ae0f4756f63988b7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/blockType.js\":\"6ebe1fc7fdffcc94\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/charCount.js\":\"fcacd69bcd03e632\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/dataExtension.js\":\"ef86a390bbd63a7e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/index.js\":\"64a17f4ecd820bca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/profiles.js\":\"106eb66cfa2fce61\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/properties.js\":\"c1381f19167042ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/character-counter/textCounts.js\":\"9585b623c7d8bcba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/colemak-keybindings/index.js\":\"01cf64c8b526f725\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/CommandPalette.js\":\"847b544922f51708\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/HeaderItem.js\":\"7efadd1c801a5e12\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/context.js\":\"5adb629d04732154\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/index.js\":\"e25580d8f7c49929\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/selection.js\":\"2bdf3c403e8b3bf4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/toggleStore.js\":\"af176f7f3bd232f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/command-palette/useCommandPaletteActions.js\":\"b44eed5ffd6b0117\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/ContributorBadges.js\":\"f24b84977b53198d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/author.js\":\"98534d98c89976f0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/codeMirrorExtensions.js\":\"c37456dd6f0931f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/dataExtension.js\":\"91ce5d59f717d75b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/index.js\":\"5b240dbd0f4b00f3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/mentionAutocomplete.js\":\"cb4e346a0d1ac17d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/processor.js\":\"d677ebcae414ab01\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/profiles.js\":\"88c9eb320bfa8dca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/queries.js\":\"dd66127ba9da963f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/contributors/schema.js\":\"bb28ae1adb6a6d94\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2c757f8eaffc21bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/followOrigin.js\":\"66ed357c10347268\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/index.js\":\"036d900fcfb90cb2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"742c4585f073c8ad\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"84ec25fa28187e9b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/CalendarGrid.js\":\"37089ab02db51ac0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DailyNotePicker.js\":\"742b975cd5b14c1f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3eb46e9c4b941ba8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateNavDecorator.js\":\"01fe605e5c4a04bb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/DateScrubOverlay.js\":\"514fed45fe110ed8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/HeaderItem.js\":\"aa68224c55a66f67\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/ReschedulePicker.js\":\"224fc212778123c3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f3ec62b036e2b63e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/actions.js\":\"9256dd240e30289d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/blockDateAdapter.js\":\"890b8635faee146a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/calendar.js\":\"bc6dd709f72058bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dailyNotes.js\":\"bd9956f2c222e9c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dataExtension.js\":\"a8076dede3c6db75\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubActions.js\":\"07ab0fb00425526f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubGesture.js\":\"1b600de21afb768d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubGestureActions.js\":\"87e676abe78b91da\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f98832e04794c899\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/deletionGuard.js\":\"656fc1e44e973d1d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/dueQuery.js\":\"f27a109967793af3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/index.js\":\"f6531e22019481ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/landing.js\":\"da8ce8b843e217fd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/localSchema.js\":\"217992dac205f730\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/referenceDateAdapter.js\":\"b4fe08167a0999f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/rescheduleAction.js\":\"65fe25950e574321\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/schema.js\":\"83648c92a6b8f3b4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/spreadBlockDates.js\":\"ff0a4797fea86ecc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/spreadDatesAction.js\":\"3c57972ba09b03ca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/today.js\":\"56e184906e77c393\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"576aaf961dba7d04\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1900218cf2ee08c8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/audit.js\":\"ef5c08ff5102bf07\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/auditAction.js\":\"bfd38a31be14a6ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/auditRanges.js\":\"98c278d15fc9b32c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/diagnosticsSource.js\":\"8030815367fc53eb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/divergenceScan.js\":\"09c4103ac25fbe63\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/index.js\":\"f6a40695c7d5c018\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3549224a602a0fa1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/referencesMirror.js\":\"2554ae0acf269410\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/rowJson.js\":\"7cc793fbed0daeca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/schedule.js\":\"6b41236636b95df9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/data-integrity/store.js\":\"55a282358ddf924d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/action.js\":\"f8debbacf3816c69\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/index.js\":\"15838ea3fe82322f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-maintenance/plugin.js\":\"eb4353d606615cb7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dfe94bf55fc45d61\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/actions.js\":\"106da5c47a62ce37\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/changeMarker.js\":\"4222db37a9b3cba6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/diagnostics.js\":\"69e2fde7356da2bf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/fileSystemAccess.js\":\"c652f86017a0f8b3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/filenames.js\":\"ffce80dfc35150ed\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/index.js\":\"96f3f1b9314ecd4f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/mirror.js\":\"928482cad4cc3799\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/runLock.js\":\"7028b8ceda5cf8f5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/runtimeHealth.js\":\"4917b3b5ba20ae94\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/schedule.js\":\"aa570c21406d82fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/db-mirror/store.js\":\"b4cc5b55db5625e1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/default-themes/index.js\":\"08c3e801dee63c8c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/default-themes/themes.js\":\"273e71539042df96\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/diagnostics/facet.js\":\"be4df0b9dc6c52d8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/diagnostics/useDiagnostics.js\":\"cb6f583869763dac\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/dismissals.js\":\"8b9257e906d2d64d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/index.js\":\"82e18dbbe0c042ba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/status.js\":\"4063bff39d2ee0f3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extension-prompts/store.js\":\"5c636406320b836d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2d9ecd880d232408\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/ExtensionsSettings.js\":\"286de34a7eada4ad\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/actions.js\":\"05f686c9c347b464\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/config.js\":\"07c73a0747e45809\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/dataExtension.js\":\"832c75ff6b6d7516\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/effect.js\":\"b37b29c7efddd85f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/index.js\":\"297e75aa03b58162\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6646873d245f2a5e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extensions-settings/useToggleTree.js\":\"62ba1d737e2b41db\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/ExtractTypeDialog.js\":\"21c5e103468d4fc1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e8720f6f46aa4ada\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/PropertyShapePicker.js\":\"3958e16393879b89\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/action.js\":\"26b7c8dc758357bd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/extract-type/index.js\":\"d0cbcb3257320226\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/FindReplaceDialog.js\":\"83b8ae26e6fcfe83\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/HeaderItem.js\":\"1832376f1c515f8f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/dataExtension.js\":\"728263ce75f59a96\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/index.js\":\"b7fc25d64c37f911\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/search.js\":\"8f60ca487a69af65\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/toggleStore.js\":\"2b697f98a22bded6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/LocationPropertyEditor.js\":\"87286ccbe25d74b9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/MapView.js\":\"f817c1c62101198d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/blockTypes.js\":\"308ba755b84d351f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/codeMirrorExtensions.js\":\"9337e630d89b73db\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/createOrFindPlace.js\":\"6d2502d7ab781333\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/currentLocation.js\":\"dfe10137a132a3f3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/dataExtension.js\":\"be49dd84cf1f804f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/geoContentDecorator.js\":\"3e76178384613d21\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/googlePlacesClient.js\":\"90b1c3145503fec8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/index.js\":\"3a3bbd1591a0c01a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/locationsPage.js\":\"772e1c69f9610888\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/mapViewport.js\":\"854653fa8cc01af4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/pickCurrentLocation.js\":\"f196b5c57b0ffb78\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/placeAutocomplete.js\":\"aef15e15e4d5ab80\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/placeNameCollision.js\":\"a692a2511259b22f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/properties.js\":\"e7812dba2c33c481\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/propertyEditorOverrides.js\":\"daf9e997ea82454f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/query.js\":\"60b7d8e9d423d61b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/geo/usePlaceSearch.js\":\"5e0136d1e425796c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8cad03893210b7bb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e74da823d88bc228\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"427696aae20fafb2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/config.js\":\"ce05e3bd324ba833\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/dataExtension.js\":\"901a7d70141a883c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/facet.js\":\"1f931ede9395cd67\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/grouping.js\":\"e5005eb9de5a7b78\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/index.js\":\"fdcdb06f46f2dd0e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"dabcfa1072cc19bc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/query.js\":\"f260be8e54b3f520\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/resolveConfig.js\":\"984cf036afb7f1f2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"960e68cbf9b0b324\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"19278e6ec9e7d78f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/HtmlDocumentContent.js\":\"aaf5abd96a056602\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/HtmlFrame.js\":\"3a93b4018ffb16c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/actions.js\":\"2f9e2d59831d0427\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/blockType.js\":\"b56abcfbca568a58\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/confirmRunScripts.js\":\"cd0c52e3726e70d8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/dataExtension.js\":\"5feeb35418636c34\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameAnnotations.js\":\"13305235f921289f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameDocument.js\":\"f0bf1319de72a6f0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/frameTheme.js\":\"938f90f36ac54f92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/index.js\":\"aed05c7866acef72\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/scriptConsent.js\":\"0b3fd08221ef43ca\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/sourceMap.js\":\"d8f3aa90a1cc96a0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/html-document/useDocumentScripts.js\":\"46843a2b8a3547a8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/index.js\":\"faead2a1fefe5f94\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/record.js\":\"905d7720e00b4bf5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/recordStore.js\":\"b058a87bb9305f27\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/responsiveness.js\":\"68482ce9b8c83eb1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/schedule.js\":\"8d83ac80b1b9e3c2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/interaction-metrics/sessionContext.js\":\"2118e422b96c98bf\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c21fb7609fbadb52\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a7884bc2d896409e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/actions.js\":\"6083220319cc04a0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/config.js\":\"1ea61db577feee53\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/dataExtension.js\":\"04051f83093fe54e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/effect.js\":\"f7913dfd05f0593a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/index.js\":\"8e93f777bb735f31\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/keyCapture.js\":\"fc43ec43e9cc9744\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/overrideStore.js\":\"b2e7d49080546902\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b51d3922f22dc0c6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/HeaderItem.js\":\"b11a345bd1f32bd7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/LeftSidebar.js\":\"7e6ee37116b35f56\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/actions.js\":\"b120ea0dde799a55\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/facet.js\":\"3e7cd279aee85f6f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/index.js\":\"2a882314307de87e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/shortcuts.js\":\"afa5ba639d7ecb96\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/left-sidebar/toggleStore.js\":\"6d2af2a062061a4d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/MergePicker.js\":\"59461b736dafe610\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/index.js\":\"822ed56c42986a83\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/mergeAction.js\":\"74286216b411121e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/merge-blocks/strategy.js\":\"feda60bfd93d7c76\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/Button.js\":\"33aeab9e5173c337\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c3e88ff19d7ef6c6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a514e9b7629b42d8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/facet.js\":\"f6b50bff07075119\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-bottom-nav/index.js\":\"524645d19b211d6e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"86d3339d78ca8737\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7ef687174411fa3a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0cae0624ef10d5db\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/facet.js\":\"5f4f0eefe7ab4b51\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/mobile-keyboard-toolbar/index.js\":\"6b2fd4be5ed844c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/MoveDestinationPicker.js\":\"50e5335f0b29bf92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2540da9d99a3ce77\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/contextMenuItem.js\":\"3e83d69762aba131\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/index.js\":\"f4a4969fe645606f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/moveAction.js\":\"3ceea8e42a40b145\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/moveBlocks.js\":\"5e7a55dc0ee72ce3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/move-blocks/selectionAfterMove.js\":\"407ef0afd0b04a8e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/TutorialBanner.js\":\"8986a9126839c94e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/action.js\":\"838e0c3e1fc54ebc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/bannerDismissal.js\":\"5e114ca710200515\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/documents/cheatSheet.js\":\"6939b1a5b4fbd02d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/index.js\":\"4d73993656e79e8d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/keys.js\":\"fbcb1d03851921c7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/landing.js\":\"983305b829fd9640\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/outline.js\":\"9923038eea9fd7fe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/onboarding/seed.js\":\"91386eff0c322cbd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/PerfTrendDialog.js\":\"9ebcdea016328ea5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/analyze.js\":\"6e9fd0ad7e0e801e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/diagnosticsSource.js\":\"2f8029f345634d93\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/index.js\":\"973aac1c63bf128b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/load.js\":\"79fe9d12e9985fc6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/monitorRun.js\":\"332544b30df610ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/schedule.js\":\"1b822b41e5bbf639\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/series.js\":\"1613a1ae07278967\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/store.js\":\"528c826f04918b80\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/trendAction.js\":\"a2e0fd4f7ed2bd9c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/perf-monitor/verdict.js\":\"40ddb9ee7c3a489c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/clickToEditAction.js\":\"9edbb9fe992e5b20\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/index.js\":\"2cd32127d60c62d4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/plain-outliner/interactions.js\":\"fc741d2f99aaca7e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a1e6341aab30f830\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/MigrationGate.js\":\"1c31e66cc9f97cf2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/MigrationGateDialog.js\":\"cb8fe682e2f7aa59\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/action.js\":\"0025f8fb3dbf4447\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/index.js\":\"7f4db538c76701cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/localRunMessage.js\":\"269a0550e9c5e950\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/plugin.js\":\"230f94c32752dd38\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/progressReport.js\":\"2a823b424027ecec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/properties-migration/sweepProgress.js\":\"cd045a207d279f0f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/FieldRowRenderer.js\":\"ddbc502c993051cd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/ValueRowRenderer.js\":\"c16bf99e10f6e691\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/actions.js\":\"eff3eeca0becf92a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/autocomplete.js\":\"3adc1d49877c35d6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/fieldRow.js\":\"ad783e5905b3af7f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/index.js\":\"f500812e97114226\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/referenceWarning.js\":\"4690dffaeefa96a0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/valueAutocomplete.js\":\"8459a9e8e262a452\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/property-rows/valueSchema.js\":\"b4733a619d6e0966\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/HeaderItem.js\":\"e79c3326f135015a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/QuickFind.js\":\"dea4c72662782245\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/index.js\":\"8962dee74aaf5577\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/recents.js\":\"bcefebdd482b3fa6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/resultItems.js\":\"f15671e45aa2109a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/selection.js\":\"8ca3be606ee9587d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/quick-find/toggleStore.js\":\"e58c4c3aeb633f2f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/HeaderItem.js\":\"ad8b5628643fe0d3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a1e7509f888d8ffb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/grouping.js\":\"358a1ce8c44e150e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/index.js\":\"259a070bd1e28c48\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/recents/target.js\":\"5cd3080b29f75c3b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/codeMirrorExtensions.js\":\"9c163dcdd9841d67\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/contentPrefill.js\":\"6654212a530994ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/dataExtension.js\":\"94db6c36af23a58c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/index.js\":\"f814f7f964cff0b3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"39d65fafa60d5246\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/invalidation.js\":\"0454fdc03c2620df\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/localSchema.js\":\"fbf335a1622697a6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/blockrefs/index.js\":\"f42f08503ab7f11e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4ad5599be8769b22\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/index.js\":\"92329c13a8111ff0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/referenceNode.js\":\"b17847df0b0b47b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/remark-reference-occurrences.js\":\"505b7d570cb0603e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"be13d42e5173954d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/index.js\":\"392ec297d5635c44\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5f5c0439f1ecf5c9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b1756fb24a6a57ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/mergeRetargetProcessor.js\":\"5ab9d4c3b73ee460\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/parseFence.js\":\"78292f1c97e568c9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referenceParser.js\":\"43e2d5a4d10e8ca0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referenceProjection.js\":\"00e08d7da836691b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/referencesProcessor.js\":\"fcd42bba6f6d2474\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/renameProcessor.js\":\"9d67adff57df4a92\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/references/spanReplacement.js\":\"c1b0fd0953c1c433\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/htmlToOutline.js\":\"4c5de8a433d7e9f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/index.js\":\"e7a8aa41a41bd9e9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0dd173fe15f00ea9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/rich-paste/pasteDecision.js\":\"223979f178855189\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/action.js\":\"dde5b878722b1bba\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/blockIds.js\":\"d4cb7189b33d1648\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/content.js\":\"2493563dc1acbe57\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/effect.js\":\"6d18d9ec8d7e39c0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/ids.js\":\"76fa1e750a541465\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/import.js\":\"0a93bd53975240d7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/index.js\":\"80db1b858aaf8090\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/plan.js\":\"ff16ba213934170c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/plugin.js\":\"fec6d5ed4e7dde44\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/promotion.js\":\"f3f04f9c94d39bfe\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/properties.js\":\"825e3f1ed6dc405f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/references.js\":\"fe098680e1bc2d38\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/report.js\":\"2d3c791b3f6abe9a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/roamMemo.js\":\"5108d926ae22d3df\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/runtime.js\":\"38f894de60d16d47\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/schemaReconciliation.js\":\"a94a75489676e771\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/srsMarkers.js\":\"efc0edc2c5663d0e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/todo.js\":\"69ff2b0a0152ffe1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/typeCandidates.js\":\"9eb9adb1ae01d068\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/roam-import/types.js\":\"88e7ef9737dbd073\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/search-health/index.js\":\"eb8f7539e9122004\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/search-health/store.js\":\"f98af1d6f8854314\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/HeaderItem.js\":\"a6d654e6da29c4b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c1585614df589a0b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/index.js\":\"1adc9c1ebad5efbd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/model.js\":\"54392a0b07ec4599\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/toggleStore.js\":\"e9de1bb584d47225\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/shortcut-help/useKeyInspector.js\":\"6e6ea8a0a9611261\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"eed62d27a16657ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/ShellDecorator.js\":\"74313afe72fb9344\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/actions.js\":\"52d4b1f0db48762f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f8ef34599c7a16c1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/index.js\":\"30f229ead99af071\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/shell.js\":\"f84e228dcaf21cee\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/surface.js\":\"9bd6a281f043289c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/spatial-navigation/walker.js\":\"e49e151656735d6a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/RescheduleToast.js\":\"69c2a3bde9c0b63d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/dataExtension.js\":\"9d7608762db5901c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/index.js\":\"e8bb32ae8957e8dd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/indicator.js\":\"f7712cf48e98106f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/moveSrsState.js\":\"14d2f37e4ac49e0a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"add2cf8377f1eb83\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/scheduler.js\":\"340ee22c306f042c\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/schema.js\":\"72b260ef966bd485\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7a20ac44e0f01487\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/srsClipboard.js\":\"0805b075b797bd51\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3b654ecebeda8a11\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cd20f8502a9346a5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/DeckPicker.js\":\"42dc69dbfa667dc8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewControls.js\":\"e859427e630d0c5b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7aa312336bdceceb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/ReviewSession.js\":\"df186f71c1be149e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/actions.js\":\"3cbbd21f7921cc7b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/archive.js\":\"7bd1c03b541fe3bb\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/dataExtension.js\":\"9399d3addb829685\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/deck.js\":\"57b0300f5d8bc760\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/dueQuery.js\":\"3fa041f921bf8be4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/gradeDecision.js\":\"1f8568a6a3f1f0b8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/index.js\":\"47a63d04e25b57d3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/keyHints.js\":\"52294972f653d470\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/reviewCardLayout.js\":\"0fca10b7a78959ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/reviewProgress.js\":\"b9b25181664f374d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/schema.js\":\"5072e80643bd831a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/srs-review/useDueCards.js\":\"e4b4c35988b150ef\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/startup-metrics/index.js\":\"80bdc5ce2ac8157a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/startup-metrics/record.js\":\"dbb13b3aab84c376\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/index.js\":\"961e3e2766947957\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/persistenceStatus.js\":\"23205c4422b1e14a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/storage-persistence/requestAction.js\":\"07b3232bd520a7dc\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/TypeChipsDecorator.js\":\"b89972ea79dac2a9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/codeMirrorExtensions.js\":\"f39f7ca6833df9a6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/index.js\":\"85455e23ed3225db\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/supertags/typeAutocomplete.js\":\"94d020ed20f364e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3acc74a4379fe503\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/actions.js\":\"00ee48a7b4a5c9ae\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/anchor.js\":\"c3db66fb2a0587f8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/events.js\":\"c20944a72d5608d5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/gestureActions.js\":\"606c42a14fda7287\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/index.js\":\"da8de2a2191aa6b0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3ace814b4b54c80b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/collect.js\":\"4b06b6ae5662b65a\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/index.js\":\"515eed86991f73e3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/sync-metrics/record.js\":\"50ca29163ee23a43\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/RejectionDialog.js\":\"e6804ecf2e6a5717\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/SystemStatusHeaderItem.js\":\"83eccf51b06d83c3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/index.js\":\"dbe7e4d66c57b95d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/model.js\":\"8eef231f3cb28290\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/queueCounts.js\":\"158e26690b3f33e5\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/rejectedHelpers.js\":\"5fe80b88c2d47079\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/rematerializeAction.js\":\"797a223fbbe058f7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/system-status/useHysteresis.js\":\"b4d7872e2f6e1c67\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/ColumnHeaders.js\":\"496f07e5501329a9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/QueryUi.js\":\"751543ca7b191d66\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/TableLayout.js\":\"436c9da7bfcd5707\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/actions.js\":\"d1204c81aacf870b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/cellEdits.js\":\"ef366f8b142371d4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/columns.js\":\"0b4ad8784ca12f02\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/controller.js\":\"2969e3ec427bf6bd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/convert.js\":\"3bd61009f577159e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/dataExtension.js\":\"35618ba3120ff131\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/index.js\":\"d92db61765632853\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/keys.js\":\"14bfa09cb8711f43\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/model.js\":\"ad4a87f63f81b5d4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/navigation.js\":\"59f71ce75306a65f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/backfill.js\":\"d3db2df6bfa623f9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/completion.js\":\"58f42ea7a4a9ba10\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/format.js\":\"1a583eed7dbe3da7\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/parse.js\":\"799cd0c2c53e38ea\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/queryValue.js\":\"6dd9fcbcff2f2527\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/query/source.js\":\"821e76d695c47cdd\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/registry.js\":\"6f6fe89c2925dcd0\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/rowGutter.js\":\"730c0daf9129a80e\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/rowVerbs.js\":\"609f55a3ea087b8b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/schema.js\":\"00acaa87445bd692\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/tables/sort.js\":\"8c82f64f75ef31a9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/effect.js\":\"ef2d8893debcf08b\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/index.js\":\"a2d04e5a8d0d949d\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/theme-toggle/theme.js\":\"93c80b7b67857b23\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/actions.js\":\"c04999c7b5407b01\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/dataExtension.js\":\"31998d95d5aeed60\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/index.js\":\"6cba94b7076f4ad8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/todo/schema.js\":\"c4fece630770fa48\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/TouchSelectionLayer.js\":\"473b56899ee256ec\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/actions.js\":\"5845212db17be646\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/defaultItems.js\":\"ed3786424e5cbc38\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/facet.js\":\"f2f16e4994cc0338\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/holdRecognizer.js\":\"d6f70281102f9292\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/touch-selection/index.js\":\"30acb07b7b9381f1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/UpdateIndicator.js\":\"146538cf579611d1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/index.js\":\"8ecec9f12a0ab554\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/update-indicator/loadTimes.js\":\"086fd5416b9cbbda\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoNotesRenderer.js\":\"6cb142259d173ff9\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoPlayerRenderer.js\":\"82540efa29cc71b1\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/VideoTimeStamp.js\":\"56867028a0e458e8\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/actions.js\":\"db813cabe5c4dcd3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/index.js\":\"69acf50cb3256775\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/markdown.js\":\"ba57c93b710c8881\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/notes.js\":\"a405e4887a5b3365\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/registry.js\":\"5f48e6ac73a36ee2\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/remark-timestamps.js\":\"4e62ddbad26b4401\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/video-player/view.js\":\"1081c53fc61742d3\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/LinkHints.js\":\"cfdfaf6fd44df43f\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/index.js\":\"6c836883e92d5bb4\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/model.js\":\"e953bceb2545f653\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-link-hints/settings.js\":\"d3d8e26030c8c678\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/actions.js\":\"1ade2973ec8f5ec6\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/index.js\":\"0947a339632f0a59\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/vim-normal-mode/interactions.js\":\"36086e042decdd79\",\"/knowledge-medium/pr-preview/pr-1639/src/plugins/workspace-header/index.js\":\"88f294049999ae75\",\"/knowledge-medium/pr-preview/pr-1639/src/registerServiceWorker.js\":\"eb687e4e0af8d7ac\",\"/knowledge-medium/pr-preview/pr-1639/src/requestPersistentStorage.js\":\"d51fc714382ee23a\",\"/knowledge-medium/pr-preview/pr-1639/src/services/authRequestDeadline.js\":\"7b0a57f2e9f51dcd\",\"/knowledge-medium/pr-preview/pr-1639/src/services/authStorage.js\":\"8b6b19e7f5aa98c2\",\"/knowledge-medium/pr-preview/pr-1639/src/services/powersync.js\":\"4628479ed8fd64da\",\"/knowledge-medium/pr-preview/pr-1639/src/services/supabase.js\":\"0169a5ef6023f400\",\"/knowledge-medium/pr-preview/pr-1639/src/services/uploadErrorClassifier.js\":\"71d64b2ac673fafa\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/ActiveContexts.js\":\"6635dcbe0c24746a\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/HotkeyReconciler.js\":\"32678899591e9230\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/WipeLocalDataDialog.js\":\"8eb031dc728075c9\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/actionDispatch.js\":\"6f7a78ad1e03879d\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/actionRefItems.js\":\"aab1e3c5472518d7\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/applyKeybindingOverrides.js\":\"58236dbe9f415947\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/blockActions.js\":\"5c9a257ec8f742fb\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/blockMergeGesture.js\":\"5494ffc243f82a6e\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/canonicalizeChord.js\":\"cf8f1ad4ef46007a\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/defaultContexts.js\":\"9f6fee76e4b00157\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/defaultShortcuts.js\":\"4b3dbcca85a24c4d\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/effectiveActions.js\":\"f5b3beb8b7c70473\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/gestureAction.js\":\"fba9e9398e9ef5dc\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/gestureBinding.js\":\"d6de5d8ab1edf4a7\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/holdRegistry.js\":\"179ea59673765d0b\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/keybindingConflicts.js\":\"6f4cb5a78788359e\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/keybindingOverrides.js\":\"9a0d1c59a752ac04\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/pointerAction.js\":\"3cda3c1f63931058\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/resolve.js\":\"b164e1f3912acb57\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/runAction.js\":\"cea0b9bb0d36b7f3\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/sequenceMatcher.js\":\"3f87bda42683779d\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/types.js\":\"e20f02b41c738449\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/useActionContext.js\":\"079fed1f1ca0e202\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/useActionDiscovery.js\":\"31d1da044ea08fdb\",\"/knowledge-medium/pr-preview/pr-1639/src/shortcuts/utils.js\":\"c20e6c1430640806\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/bootStore.js\":\"21fc89e7d4433964\",\"/knowledge-medium/pr-preview/pr-1639/src/sw/previewDatabases.js\":\"409496a5ee53ce7a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/byteTransform.js\":\"a36b2be2858552ea\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/attachmentCleaner.js\":\"d4cf809b2f6f57bc\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/attachmentParts.js\":\"a7dc1195fc40bbae\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/bundleParts.js\":\"3ee75bbbac38fffb\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/bundleRecord.js\":\"2a0280fcb21e914a\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/manifest.js\":\"25e1ca4660b7f2ba\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/takeBundle.js\":\"9140bd06ac2f8d5c\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/bundle/verifyBundle.js\":\"918c47fdead87edd\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/cleaningStage.js\":\"7fefaac7b6503640\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionKey.js\":\"08aa3a7d2e90a40f\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/conversionServer.js\":\"5d4a9ffb29d0a3a0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/flip.js\":\"85e4288f92f25ac7\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/flipAttempts.js\":\"ad28b5ec10498353\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/pages.js\":\"6aa776b4055a5131\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/preflight.js\":\"2d837f2fcd591366\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/reseal.js\":\"5b20f482efd5783b\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/runConversion.js\":\"d2761b9faa48572e\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/runLock.js\":\"06d2719ef32f0577\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/sealing.js\":\"17d373ed900c4ca4\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/sealingStage.js\":\"cc3d8098fad32aa9\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/stage.js\":\"e5399f542c158308\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/conversion/verifyReseal.js\":\"b876d80655d90819\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/aad.js\":\"bfb1f32b73029cd1\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/aead.js\":\"e152ff141cddf328\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/base32.js\":\"b5f94db7d2b8ca92\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/base64url.js\":\"94d6d8691e55fb1d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/binaryEnvelope.js\":\"124eaa75f07bc258\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/byteAead.js\":\"7bbe5e9866023662\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/canary.js\":\"d66e17602ce46591\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/contentHash.js\":\"c9f52b473edd1360\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/contentKey.js\":\"0bb0d12f5f640be3\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/derivedIdNamespace.js\":\"c407b0351b620e75\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/envelope.js\":\"002f0cd1191bce05\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/hex.js\":\"ff90eb2e4be1a584\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/sha256Hex.js\":\"d509be7c120e6b27\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/crypto/workspaceKey.js\":\"f012598465a791c0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/conversionState.js\":\"13e9145c5e741f7d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7ef2fe57de57ec3b\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/pastedKey.js\":\"0b2ec69c572dfab2\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a95fae43b0c1f373\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/flows/upgradeWorkspacePin.js\":\"63004abb3488c142\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/keyStore.js\":\"6961c218bf53900d\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/mintWorkspaceKey.js\":\"179eb5c2abd413cf\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/modePin.js\":\"0eccc7d17c0cf876\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/openWorkspaceKeys.js\":\"5a504e9ed9ad1b38\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/resolveWorkspaceEntry.js\":\"78875cbb11f7a903\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/resolver.js\":\"8a3c3d99c95af1ab\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/keys/workspaceAccess.js\":\"7083ff1d53df16e0\",\"/knowledge-medium/pr-preview/pr-1639/src/sync/transform.js\":\"6c0f364dbe8a429d\",\"/knowledge-medium/pr-preview/pr-1639/src/themeBootDefaults.js\":\"c914343f168cb221\",\"/knowledge-medium/pr-preview/pr-1639/src/types.js\":\"d2f53cde76b81ef5\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/ClientLocalSettings.js\":\"bbc1aa1f14de4842\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/abortableSleep.js\":\"e37c2a6973adce3d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/array.js\":\"0da228828ec7cb13\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/backlinkAutocomplete.js\":\"6727c960d06e2c9b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/blockCrumbs.js\":\"6c26456e56bd573b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/blockrefAutocomplete.js\":\"cd29ac5876fb6198\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/cadencedIdleJob.js\":\"d522568d58072c04\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/callbackSet.js\":\"af93791dbea5e6ce\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/clientId.js\":\"75d4b44c3d4582c9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/codemirror.js\":\"409c14560ec4b9a3\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/codemirrorCompletion.js\":\"2a057354f3a5646d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/copy.js\":\"3d519191e4d94220\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dailyPage.js\":\"925f31fb9e07bdc3\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dbForensics.js\":\"debf425f56d27a95\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dbForensicsHooks.js\":\"a5790ac46d81e959\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/deleteBlockThroughUi.js\":\"da5708260d1e0410\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dialogs.js\":\"d8280af016b526e4\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/dom.js\":\"7c5616a20f6ca9d2\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/downloadBlob.js\":\"aab367061e556b2a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/exportSqliteDb.js\":\"d12082bbe0006bdb\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fileSystemAccess.js\":\"8e56b02a95fd0b8d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/flipSlide.js\":\"18e0b0cd82f7707f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fnv1a.js\":\"98bf8a1c3ba14d97\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/formatBytes.js\":\"067a1cfa4c929ba6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/fuzzyRank.js\":\"f0389a0ccf47d02f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/idbKeyedStore.js\":\"7b503ffeb58c390b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/idleCallbackPolyfill.js\":\"b9a6794358096f18\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/keyboardAwareScroll.js\":\"48bf1e6c622fb35b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/keyboardViewport.js\":\"8dcd6453a15e8bde\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/lastWorkspace.js\":\"4f83bf7f8028cf97\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutColumns.js\":\"d9842b7b960f9db1\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutSessionDom.js\":\"52630101e0e8818f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/layoutSessionId.js\":\"8a185e4bdebf8934\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/linkClickGestures.js\":\"46f2ce249bb93fb1\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/linkTargetAutocomplete.js\":\"1d963be90c13e076\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/localDbCorruption.js\":\"d0ce114dd8b32e4f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/localDbRecovery.js\":\"c2cd0b71a6793239\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/markdownParser.js\":\"26303edcc2720b4c\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/memoize.js\":\"a77324cb27b7e97b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/nameFieldCommit.js\":\"669852ac8161586d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/nameList.js\":\"57ea79fc0b4e1dd0\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/navigation.js\":\"2ab97488359e1267\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/omnilinerNamespace.js\":\"1b81917fc3c87391\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/opfsPageScan.js\":\"d454711d5b54ff21\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelClearance.js\":\"2e5935318c35231d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelHistory.js\":\"054f344f74dd3260\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelLanes.js\":\"b57a48e797acec5b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelLayoutProjection.js\":\"efcf2a48f235525e\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelScrollAnchor.js\":\"53ede4365c6be2dd\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/panelUrlFlags.js\":\"1a2418c1b8cb3937\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/platform.js\":\"042cb835acc2534a\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/pluralize.js\":\"c2bfa21ba1d7cbca\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyCreation.js\":\"e05b1e707a6959ab\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyNavigation.js\":\"b9e433f15f36dc44\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/propertyValueContext.js\":\"9a4f7a508c76ae4e\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/react.js\":\"21ba5f827c6a748c\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/relativeDate.js\":\"064ba7784486b320\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/relativeTime.js\":\"b01852a425da6e16\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/renderScope.js\":\"27ebcf435a94ed10\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/resolvedThenable.js\":\"53af228cca064d51\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/routing.js\":\"e5b158b035a1aac6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/safeMode.js\":\"9f6ab0957502f015\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/scheduleIdle.js\":\"566b193286f37c5d\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/screenWakeLock.js\":\"e8aea469fe0f7647\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/selection.js\":\"7f96f51c265180be\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/softKeyboardGrab.js\":\"533bbf0270019fb0\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/startupTimeline.js\":\"51efa034b6b49d33\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/state.js\":\"6218c4586eb5f65b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/string.js\":\"0964f84f223d29d1\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/surfaceZoom.js\":\"b24dacadb1e99b17\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/time.js\":\"ecc6085e9f530645\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/toast.js\":\"ea432b799c7d0e65\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/toggleStore.js\":\"55f9e3f71f49558b\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/untilStopped.js\":\"2bba9a649e6c31e0\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/userActivity.js\":\"470afa89ba9ceea3\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/viewTransition.js\":\"71fce19ed219cbb3\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/viewport.js\":\"b364c69ccee1f0d9\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/webLock.js\":\"2d400f15384c276f\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/workspaceRecovery.js\":\"d56b3b50a1fe12da\",\"/knowledge-medium/pr-preview/pr-1639/src/utils/workspaceSnapshotStore.js\":\"c2f3e1aca9b5d41d\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-compiler-runtime.js\":\"29c88b11cb09f0ce\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-client.js\":\"8a0cd89eae4992c0\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-server-edge.js\":\"33d573a8b4a71c2a\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-server.js\":\"357da275f8ad5981\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-static-edge.js\":\"3ef67d235ea5cc27\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-static.js\":\"c6ee98f6b783293f\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom-test-utils.js\":\"194364437568c353\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-dom.js\":\"9e1cd732a5a6b748\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react-jsx-runtime.js\":\"ee1560449806368e\",\"/knowledge-medium/pr-preview/pr-1639/src/vendor/react.js\":\"e657d69c97a77a46\",\"/knowledge-medium/pr-preview/pr-1639/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1639/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1639/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
