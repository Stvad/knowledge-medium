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
		buildId: "57bc685d0d46-c2c3cfac",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1685/\":\"58aad6ddffd9f55a\",\"/knowledge-medium/pr-preview/pr-1685/index.html\":\"58aad6ddffd9f55a\",\"/knowledge-medium/pr-preview/pr-1685/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1685/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1685/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1685/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1685/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1685/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1685/app.css\":\"184e4307b40d1516\",\"/knowledge-medium/pr-preview/pr-1685/assets/FacadeVFS-BeCrR0PI.js\":\"f4f2c8f3d92f6cdd\",\"/knowledge-medium/pr-preview/pr-1685/assets/OPFSCoopSyncVFS-B-BFY1AM.js\":\"114d229d0a8850b7\",\"/knowledge-medium/pr-preview/pr-1685/assets/OPFSWriteAheadVFS-CZTkFNEp.js\":\"c2a8f72f9f477871\",\"/knowledge-medium/pr-preview/pr-1685/assets/wa-sqlite-Be6EwZeZ.js\":\"5870017d41c0c3a8\",\"/knowledge-medium/pr-preview/pr-1685/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1685/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1685/assets/wa-sqlite-async-D0vUtdf6.js\":\"e41f3546283fffb4\",\"/knowledge-medium/pr-preview/pr-1685/assets/worker-BJrAZt9u.js\":\"d0cd86624fc4d5b6\",\"/knowledge-medium/pr-preview/pr-1685/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1685/chunks/app-BzmoMuYr.js\":\"912a8c3d5ec35f86\",\"/knowledge-medium/pr-preview/pr-1685/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1685/index.js\":\"6a51fc41a2122eab\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1685/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1685/assets/AccessHandlePoolVFS-8vnX-K3j.js\":\"a64397b7d46ace6c\",\"/knowledge-medium/pr-preview/pr-1685/assets/IDBBatchAtomicVFS-C1k854gc.js\":\"aee5c6eeda96bfe0\",\"/knowledge-medium/pr-preview/pr-1685/assets/MemoryVFS-BFxSEG9e.js\":\"e88f5d64f46718b8\",\"/knowledge-medium/pr-preview/pr-1685/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1685/assets/mc-wa-sqlite-DifxmyNM.js\":\"89b0d2bc3bf35677\",\"/knowledge-medium/pr-preview/pr-1685/assets/mc-wa-sqlite-async-DspCq-Va.js\":\"8179edd22bd61b61\",\"/knowledge-medium/pr-preview/pr-1685/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1685/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1685/chunks/AccessHandlePoolVFS-BBzwn5Qw.js\":\"94f3fc2d98ecc3d3\",\"/knowledge-medium/pr-preview/pr-1685/chunks/FacadeVFS-BFRHP9Ss.js\":\"02df273ed7b1d6aa\",\"/knowledge-medium/pr-preview/pr-1685/chunks/IDBBatchAtomicVFS-DNFSUYml.js\":\"167068f6d39a0613\",\"/knowledge-medium/pr-preview/pr-1685/chunks/MemoryVFS-B4pO6VR2.js\":\"d82f47f662f090ff\",\"/knowledge-medium/pr-preview/pr-1685/chunks/OPFSCoopSyncVFS-CEO09nPC.js\":\"5524eff010d94eb4\",\"/knowledge-medium/pr-preview/pr-1685/chunks/OPFSWriteAheadVFS-B6NLikgb.js\":\"9b49f653eb78084d\",\"/knowledge-medium/pr-preview/pr-1685/chunks/Preview-Cu6Feq7t.js\":\"5483b0a4c58975b0\",\"/knowledge-medium/pr-preview/pr-1685/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1685/chunks/card--L_JgcnX.js\":\"0f134d3f47f513fe\",\"/knowledge-medium/pr-preview/pr-1685/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1685/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1685/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1685/chunks/dist-CEAoEKX8.js\":\"3bf62fb5a035f762\",\"/knowledge-medium/pr-preview/pr-1685/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1685/chunks/mc-wa-sqlite-async-DLJ2USS7.js\":\"d124603577b907b8\",\"/knowledge-medium/pr-preview/pr-1685/chunks/mc-wa-sqlite-wskoY1Ku.js\":\"5fdc159e4cfdcb01\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-C1O7OOi8.js\":\"bcdd5869fa31ad30\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-Cs0s_B1A.js\":\"e46a3e5fb1bddbe3\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-D-wV1jv8.js\":\"85a0a27c984b343d\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-DHykKKx4.js\":\"0f8ab04a71c7ce91\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-DfXYQXlQ.js\":\"c949c734c93904a2\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-L0C4SCCf.js\":\"5d8919803889aaaa\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-NVlsNVJV.js\":\"8b525cdb7c4ce58d\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-dom-server-legacy.browser.production-Dn8MaxrT.js\":\"b62a39aeceeae8c0\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-dom-server.browser.production-DmFKAFDN.js\":\"e5a48c1e242cd1e6\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-dom-server.edge.production-BJSsImAe.js\":\"e9536bd2205eb570\",\"/knowledge-medium/pr-preview/pr-1685/chunks/react-sGMDahil.js\":\"1c66e6f2d748e709\",\"/knowledge-medium/pr-preview/pr-1685/chunks/server.browser-CRyeeAHB.js\":\"e3470fbb3a4ee793\",\"/knowledge-medium/pr-preview/pr-1685/chunks/textarea-CPIZuAmQ.js\":\"47365210686ac014\",\"/knowledge-medium/pr-preview/pr-1685/chunks/ui-Ckj7o2nG.js\":\"e814bf47909bb2bd\",\"/knowledge-medium/pr-preview/pr-1685/chunks/wa-sqlite-Dhu-tQAx.js\":\"f0c5ea2cc7fa9503\",\"/knowledge-medium/pr-preview/pr-1685/chunks/wa-sqlite-async-CFFlZ3Pr.js\":\"fb3a35628e19d6be\",\"/knowledge-medium/pr-preview/pr-1685/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1685/extension-utilities.css\":\"6d5dcb938d3dd8c5\",\"/knowledge-medium/pr-preview/pr-1685/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1685/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1685/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1685/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1685/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1685/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1685/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1685/src/App.js\":\"fa44381cb5414fba\",\"/knowledge-medium/pr-preview/pr-1685/src/appUpdate.js\":\"6e4e1fa6e1e6f817\",\"/knowledge-medium/pr-preview/pr-1685/src/appVersion.js\":\"347cc5113e19feeb\",\"/knowledge-medium/pr-preview/pr-1685/src/bootstrap/initialLayout.js\":\"4439cb2743189d2d\",\"/knowledge-medium/pr-preview/pr-1685/src/bootstrap/openWorkspaceData.js\":\"99c360b10f5e54d7\",\"/knowledge-medium/pr-preview/pr-1685/src/bootstrap/resolveWorkspace.js\":\"f658d6309501e8c8\",\"/knowledge-medium/pr-preview/pr-1685/src/bootstrap/workspaceBootstrap.js\":\"8c7f91baad7995c6\",\"/knowledge-medium/pr-preview/pr-1685/src/components/BlockComponent.js\":\"37c34cd5a3e8ce95\",\"/knowledge-medium/pr-preview/pr-1685/src/components/BlockCrumbs.js\":\"23d786fac1c4eab9\",\"/knowledge-medium/pr-preview/pr-1685/src/components/BlockEditor.js\":\"aa33efd2a4075857\",\"/knowledge-medium/pr-preview/pr-1685/src/components/BlockLoadingPlaceholder.js\":\"c13f27a22e4af278\",\"/knowledge-medium/pr-preview/pr-1685/src/components/BlockProperties.js\":\"d7f3b3514094bab7\",\"/knowledge-medium/pr-preview/pr-1685/src/components/BlockSearchPicker.js\":\"5465d8e234695330\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ConfirmBulkDeleteDialog.js\":\"40aef1b2d5a0dc6a\",\"/knowledge-medium/pr-preview/pr-1685/src/components/DividerHandle.js\":\"dd725112e9cc8ad7\",\"/knowledge-medium/pr-preview/pr-1685/src/components/DraftEditor.js\":\"9b308e0b6b109666\",\"/knowledge-medium/pr-preview/pr-1685/src/components/GutterPill.js\":\"747a3bbc4c01fc64\",\"/knowledge-medium/pr-preview/pr-1685/src/components/Header.js\":\"67020bb5de785ed8\",\"/knowledge-medium/pr-preview/pr-1685/src/components/LazyBlockComponent.js\":\"9fd90e60f72142d1\",\"/knowledge-medium/pr-preview/pr-1685/src/components/Login.js\":\"30e21924956402ad\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ZoomableSurface.js\":\"35a1d387b35c4ced\",\"/knowledge-medium/pr-preview/pr-1685/src/components/editModeKeepalive.js\":\"44ac4c36c5dca976\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a6f968a1d1ca8e63\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4e1cc0f25b51875b\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/RefPropertyEditor.js\":\"54a5d9ac40fae6b0\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/RefTargetTypePicker.js\":\"3db39e3a1994f65c\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/SelectPropertyEditor.js\":\"136adc2cf420c12c\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/TypesPropertyEditor.js\":\"a7d5bffc9b37657c\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/defaults.js\":\"ff11999a68715efe\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/kernelValuePresets.js\":\"be9bd569b807164c\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/selectablePresets.js\":\"3d263db1dfb0dc3b\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyEditors/typesPropertyUi.js\":\"e9e34bdcd845edb3\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/AddPropertyForm.js\":\"01a0561dc2131b0d\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/PropertyPicker.js\":\"db44eac72ec47fae\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/PropertyRow.js\":\"cd98eca55f7b028f\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/Rows.js\":\"bb05f7b80a0d7cc0\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/actions.js\":\"5c08346d54224985\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/declarationOnly.js\":\"d4a14cd71f5bb05b\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/layout.js\":\"fa54e2eb3d3311e2\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/model.js\":\"835de0d66e63c957\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/shapeUi.js\":\"7dcdd7629528aa6b\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/shapes.js\":\"d95dfe774c4c1ef9\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c66dae714f0ec803\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanel/visibility.js\":\"d49c4cff84723416\",\"/knowledge-medium/pr-preview/pr-1685/src/components/propertyPanelSections.js\":\"feb54abd8bb978da\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/BlockEmbed.js\":\"ae59736b86b9b9d6\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/BlockLink.js\":\"80b54d1993ba2b10\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/BlockRef.js\":\"73a8ebba558cfc58\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/ReferenceLink.js\":\"a8d29279d2592b17\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/cycleGuard.js\":\"5cb2ce789b5b10f4\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/cycleGuardContext.js\":\"e60dc34d9b8fb2a7\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/linkInteraction.js\":\"951af80613324fd8\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/referenceLayout.js\":\"d3364a9cf9b94c74\",\"/knowledge-medium/pr-preview/pr-1685/src/components/references/useBlockRefAncestors.js\":\"cdef32e82ce19eb2\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/BlockGutter.js\":\"9c3cfbc0bd7dc2ef\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/BlockInfoDialog.js\":\"4f06961560601ff5\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/BlockTypeBlockRenderer.js\":\"a6bb59b25df41e3d\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/BulletHoverCard.js\":\"46674ae0ed96bddb\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/CodeMirrorContentRenderer.js\":\"58f552bef45fc4bf\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"67eb5d2a62a76bd6\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/ColumnResizeHandles.js\":\"147763a6ca4a4856\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f60ff9bf99ba34e4\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/DefaultBlockRenderer.js\":\"24f9ca21789dcbf9\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/LayoutRenderer.js\":\"ce0b4bd3fa678b2c\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/MarkdownContentRenderer.js\":\"67f6d18ded9499db\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/MissingDataRenderer.js\":\"aa8c6dd70ea285de\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/PanelRenderer.js\":\"944be4e57182cdfd\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/PropertySchemaBlockRenderer.js\":\"487d70d5b9b48c59\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/TopLevelRenderer.js\":\"b789d94240ccec08\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/blockGutterMode.js\":\"d6ac253a44158520\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/blockTitleText.js\":\"4dc22717faac3d91\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/fieldCreationKeydown.js\":\"bc18528ba25b0dcb\",\"/knowledge-medium/pr-preview/pr-1685/src/components/renderer/layoutRootContext.js\":\"8178d88b6a61e83d\",\"/knowledge-medium/pr-preview/pr-1685/src/components/typeChip/TypeChip.js\":\"08cde5e9f4034596\",\"/knowledge-medium/pr-preview/pr-1685/src/components/typeChip/chipStyle.js\":\"dc27ac633987f354\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/anchored-floating.js\":\"6eef8c126c1c253d\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/button.js\":\"54fadaeda1092b8c\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/card.js\":\"b162cf7ea73c1fa5\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/checkbox.js\":\"9409dec0bb5d0249\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/collapsible.js\":\"ae7873f40e138880\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/command.js\":\"82e1d5496c15fbbf\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/context-menu.js\":\"ced4d243872ed191\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/dialog.js\":\"5a6d8b03e1c66cf1\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/dropdown-menu.js\":\"98a2b54c65b01d9b\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/floating-listbox.js\":\"fde68f91419b5325\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/hover-card.js\":\"ce8a41444cc054b3\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/index.js\":\"e6eeae6098c8f37a\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/input.js\":\"c05fe763aec4ee70\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/kbd.js\":\"604aeae17dc35edd\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/label.js\":\"8f8695511cdb8558\",\"/knowledge-medium/pr-preview/pr-1685/src/components/ui/textarea.js\":\"a0bf1392652ce291\",\"/knowledge-medium/pr-preview/pr-1685/src/components/useEditModeYieldKeepalive.js\":\"31b74d2608b4ac58\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/BootFallback.js\":\"4d2f8ab656f9f319\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/FocusedRowLazyMount.js\":\"fbb662f2e1776374\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/LazyViewportMount.js\":\"02c3494280a5b2e8\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/LocalDbCorruptionFallback.js\":\"25b3286e70ec5bea\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/error.js\":\"761159c78820d09d\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/lazyMountRegistry.js\":\"ab433c89bce715dd\",\"/knowledge-medium/pr-preview/pr-1685/src/components/util/suspense.js\":\"14d8991fa9bf867e\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/CreateWorkspaceDialog.js\":\"0f5adb6e713de89f\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/PendingInvitations.js\":\"b6e91906d166f658\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/SyncProgress.js\":\"78d3b877d6022971\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/UnlockProgress.js\":\"1c9c8c2bfaa0bea8\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/WorkspaceKeyGate.js\":\"907acd78c8f488de\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/WorkspaceSettingsDialog.js\":\"ce7778e9422a897e\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/WorkspaceSwitcher.js\":\"70b04445c016996f\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/WorkspaceSyncGate.js\":\"bce7278d83ac1c44\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/ConversionFlow.js\":\"f6436c0b2e9922e3\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/ConversionFlowHost.js\":\"07aedaaf94830e2b\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/EncryptionSection.js\":\"5a5b1959a74468b1\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/attachmentPrompts.js\":\"d59c34420f1d3cae\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4402fdbb057b99d8\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/conversionFlowDeps.js\":\"185154b37fb881aa\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/conversionFlowStore.js\":\"3f292ba997ffd331\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/flowUi.js\":\"71e1157161de6f9a\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/conversion/useConversionRun.js\":\"74770b15f6ac0cde\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/keyUi.js\":\"103f137a9fea00c1\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/useCloseOnKeyLoss.js\":\"25c1b7b2a71e5bcd\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/useCloseOnServerE2ee.js\":\"9ea8a4744c89aec4\",\"/knowledge-medium/pr-preview/pr-1685/src/components/workspace/workspaceUnlocked.js\":\"7caaeea7588b0400\",\"/knowledge-medium/pr-preview/pr-1685/src/context/backgroundSubtree.js\":\"eec9ffa97fec8f59\",\"/knowledge-medium/pr-preview/pr-1685/src/context/block.js\":\"6c3be331f12a370c\",\"/knowledge-medium/pr-preview/pr-1685/src/context/layoutWsContext.js\":\"b1a4096f97fc0693\",\"/knowledge-medium/pr-preview/pr-1685/src/context/propertyDisplay.js\":\"0885edf8b7854021\",\"/knowledge-medium/pr-preview/pr-1685/src/context/repo.js\":\"a6420fac079f7f2d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/aliasClaim.js\":\"50e388178fdc2029\",\"/knowledge-medium/pr-preview/pr-1685/src/data/aliasSeatNamespace.js\":\"b7c5b459b5fb067c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/blockData.js\":\"0eed5aa8739cac3a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/blockType.js\":\"25a30feec390352e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/changeScope.js\":\"e38f5d60f24e4bb0\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/codecs.js\":\"ad377e8a24bf562d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/derivedData.js\":\"e64992577797dc1e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/errors.js\":\"db56e5e2bb013776\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/events.js\":\"87fcb4c7cdf92895\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/handle.js\":\"2cc9eba90d9543c4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/index.js\":\"240b583d2ebdc2b0\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/mutator.js\":\"56687d33fb9f867c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/processor.js\":\"733fe9a78f2961fd\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/propertySchema.js\":\"f73d82e07fc3c76a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/query.js\":\"693b2f0c60f5527b\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/sameTxProcessor.js\":\"c3367fadd47be0fb\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/schema.js\":\"2cc9eba90d9543c4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/tx.js\":\"2cc9eba90d9543c4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/typedBlockQuery.js\":\"65c416fa00c7e52d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/user.js\":\"4e417a2163e607bf\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/valuePresetCore.js\":\"ac9d39bf5e668f7e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/api/valuePresets.js\":\"f9cc040590ae677c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/attachmentCleanerIOVerb.js\":\"6e4d655f450215c9\",\"/knowledge-medium/pr-preview/pr-1685/src/data/block.js\":\"1b73b6b4c27a6161\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockCache.js\":\"df0634d2b1306313\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockId.js\":\"e9d3b3d4ac0825d7\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockLiveness.js\":\"c70b153808e03509\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockMerge.js\":\"805b63c73a0303b9\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockSchema.js\":\"bcb49c757577a0a7\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockTypeLookup.js\":\"b911c6ad03fdf6ea\",\"/knowledge-medium/pr-preview/pr-1685/src/data/blockTypes.js\":\"c7ac41d0b1ef3b33\",\"/knowledge-medium/pr-preview/pr-1685/src/data/childrenView.js\":\"02e96e9b0fa81d42\",\"/knowledge-medium/pr-preview/pr-1685/src/data/clientContext.js\":\"79352cb131148a81\",\"/knowledge-medium/pr-preview/pr-1685/src/data/dbFileSiblings.js\":\"76f5579fb2b4ae28\",\"/knowledge-medium/pr-preview/pr-1685/src/data/definitionSeeds.js\":\"d650a312a4f7a4a3\",\"/knowledge-medium/pr-preview/pr-1685/src/data/derivedIds.js\":\"9324e28000422d39\",\"/knowledge-medium/pr-preview/pr-1685/src/data/drawnSubtree.js\":\"b3cb7ba1670233ed\",\"/knowledge-medium/pr-preview/pr-1685/src/data/facetBridge.js\":\"456f1c4364bf60b4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/facets.js\":\"8a8fee17d7858700\",\"/knowledge-medium/pr-preview/pr-1685/src/data/globalState.js\":\"183f4b37342c11b1\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/aliasClaimRederiveProcessor.js\":\"ba8f2a29f407e489\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/ancestorBatch.js\":\"8e974f488343e641\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/blockTypeTypeifyProcessor.js\":\"12dfaf8099f57f9a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/clientSchema.js\":\"f48cabba69fa01cf\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/commitPipeline.js\":\"359865b5ef25abbb\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/devAssertions.js\":\"4dd2340e2029f87f\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/firstSync.js\":\"89926e7463869b0f\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/freshInitialLoad.js\":\"18b3e2bc5b7ac9ab\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/graphBackfillClaim.js\":\"3403e34f234a8619\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/handleStore.js\":\"0502d51e90ef7e7f\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/idleMarkerJobs.js\":\"cdfea750557d1d54\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/initialDownload.js\":\"d5fbb7877e052b53\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/initializeClientDatabase.js\":\"2f102fe06f5b3512\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/jsonCanonical.js\":\"8f39a350fdb62a74\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/kernelInvalidation.js\":\"2de038555da35c51\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/kernelProcessors.js\":\"bc6f8f2623570097\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/kernelQueries.js\":\"c6ad61cbb3ffdf9d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/mergeTypeMembershipProcessor.js\":\"caf7fd21061c406a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/normalizeReferencesProcessor.js\":\"bbc5fdbbb5032214\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/poolInstrumentation.js\":\"11a2584239ed1665\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/processorRunner.js\":\"a2f8a61c6cb45845\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyCellBackfill.js\":\"f81b00af8248ea45\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyChildMint.js\":\"e332a841273b0dd9\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyChildrenProcessor.js\":\"5494acb465975df4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6b2a6339639eaf7e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyDefinitionSynthesis.js\":\"a7bc012f70398ca7\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyKeyScan.js\":\"eef15ad376b54699\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertySchemaResolution.js\":\"7fe3b20c6d5056f8\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/propertyValueEdits.js\":\"1ba709dd767bf163\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/raiseProtocol.js\":\"6cc6984a7ed876d0\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/readBatch.js\":\"b5b7657da94455f3\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/refProjection.js\":\"e67a6fd7a49d5c8e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/referenceTargetLookups.js\":\"4f1865d2d44e5d55\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/referenceTargetProcessor.js\":\"8992e9ad9930e979\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/replayMerge.js\":\"57cc2b057f5f4415\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/sqlBinds.js\":\"01f658451d4cb2d8\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0229ac648301d759\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/syncObserver/arrivalProcessors.js\":\"c761b6f5042f6249\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/syncObserver/invalidate.js\":\"72270f88eb8bc627\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/syncObserver/materialize.js\":\"7ad715fddb16eb5a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/syncObserver/observer.js\":\"c4179d7c5144b78a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/syncObserver/reconcile.js\":\"cca6cf3f7da9804e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/timingMetrics.js\":\"2a94dd91c56e848e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/treeQueries.js\":\"8ad6bfe754c2489d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/txEngine.js\":\"c73fa5fd766c5e2b\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/txSnapshots.js\":\"d8359257687e2837\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/typedBlockQuery.js\":\"512bf7447e454653\",\"/knowledge-medium/pr-preview/pr-1685/src/data/internals/undoManager.js\":\"ac6c8fa4e1e3ca3c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/invalidation.js\":\"a58c53520319adbb\",\"/knowledge-medium/pr-preview/pr-1685/src/data/kernelDataExtension.js\":\"ae956bdad202f307\",\"/knowledge-medium/pr-preview/pr-1685/src/data/kernelPage.js\":\"5063859a836e0f06\",\"/knowledge-medium/pr-preview/pr-1685/src/data/kernelValuePresetCores.js\":\"7a5595703287663d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/localDbCorruptionSignal.js\":\"268b8400f3ab9278\",\"/knowledge-medium/pr-preview/pr-1685/src/data/localDbStorage.js\":\"cd6b9b7055f2d004\",\"/knowledge-medium/pr-preview/pr-1685/src/data/localDbVfs.js\":\"cc9c9bbc1d7310b3\",\"/knowledge-medium/pr-preview/pr-1685/src/data/localSchema.js\":\"592bb2dfbce80275\",\"/knowledge-medium/pr-preview/pr-1685/src/data/maintenance.js\":\"6c7508390d14b2a9\",\"/knowledge-medium/pr-preview/pr-1685/src/data/mergeProperties.js\":\"b9dd63348306b68e\",\"/knowledge-medium/pr-preview/pr-1685/src/data/metricsConsoleHook.js\":\"0ebedc5d4404f2da\",\"/knowledge-medium/pr-preview/pr-1685/src/data/migrationsPage.js\":\"05c3adc98b87391a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/mutators.js\":\"26e0b471cb638448\",\"/knowledge-medium/pr-preview/pr-1685/src/data/orderKey.js\":\"6ed5600e89fbda0c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/orderKeyPlacement.js\":\"6aa3272511a7e57a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/outlineSurface.js\":\"8b846852f6c30ec5\",\"/knowledge-medium/pr-preview/pr-1685/src/data/pendingEditorContent.js\":\"71914a31a12ae76a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/pendingUploadsSql.js\":\"cf5fffe0eac92aa7\",\"/knowledge-medium/pr-preview/pr-1685/src/data/pluginStateExtensions.js\":\"cb7e28c88a97bb9b\",\"/knowledge-medium/pr-preview/pr-1685/src/data/powerSyncLogger.js\":\"640a182a4e6241bb\",\"/knowledge-medium/pr-preview/pr-1685/src/data/projectorRuntime.js\":\"08a50dd34ff79d25\",\"/knowledge-medium/pr-preview/pr-1685/src/data/properties.js\":\"99db0b497cedf512\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertiesPage.js\":\"eeae451b75532a37\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertyChildren.js\":\"de313dc64fe6e1a8\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertyDefinitionFanout.js\":\"7b69932e2c981856\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertyDefinitionMetadata.js\":\"67e41d6f3bb42184\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertyDefinitionRegistry.js\":\"f449584efdd453ba\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertyDisplayMode.js\":\"31f28c357e5ba221\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertyRowCreation.js\":\"e2f03daa5d622e3f\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertySchemaCreation.js\":\"5f720ac68f798a18\",\"/knowledge-medium/pr-preview/pr-1685/src/data/propertySeeds.js\":\"a5f6c9cf2795a9d9\",\"/knowledge-medium/pr-preview/pr-1685/src/data/recentsPage.js\":\"d593ec8af5e37eb0\",\"/knowledge-medium/pr-preview/pr-1685/src/data/referenceBlock.js\":\"fd6b8798f5517131\",\"/knowledge-medium/pr-preview/pr-1685/src/data/rejectedUploads.js\":\"0be72608ed2e0aac\",\"/knowledge-medium/pr-preview/pr-1685/src/data/releasePowerSyncConnection.js\":\"9fa9b783b5eb53a7\",\"/knowledge-medium/pr-preview/pr-1685/src/data/repo.js\":\"fae10c961bc96a48\",\"/knowledge-medium/pr-preview/pr-1685/src/data/repoProvider.js\":\"15bf815f54be9233\",\"/knowledge-medium/pr-preview/pr-1685/src/data/rowProperty.js\":\"79268dce55cf6da6\",\"/knowledge-medium/pr-preview/pr-1685/src/data/searchFilter.js\":\"5e5d07daa0a1f30d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/seedIdentityLedger.js\":\"e916cfda49f440d6\",\"/knowledge-medium/pr-preview/pr-1685/src/data/stateBlocks.js\":\"f57819f42090e4e5\",\"/knowledge-medium/pr-preview/pr-1685/src/data/structuralEditPolicy.js\":\"112c926d36d84681\",\"/knowledge-medium/pr-preview/pr-1685/src/data/structuralInsert.js\":\"c0557e948cd48695\",\"/knowledge-medium/pr-preview/pr-1685/src/data/subtreeDelete.js\":\"6664f0ffd62f5a70\",\"/knowledge-medium/pr-preview/pr-1685/src/data/syncStreamLock.js\":\"d8283ddedab8eb35\",\"/knowledge-medium/pr-preview/pr-1685/src/data/syncedTableSqlRecognizer.js\":\"1e633660f81ab38f\",\"/knowledge-medium/pr-preview/pr-1685/src/data/syncedTableWriteGuard.js\":\"3c557ea237a40d97\",\"/knowledge-medium/pr-preview/pr-1685/src/data/targets.js\":\"e96f34490d04df8c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeColors.js\":\"9d5265017f3584e7\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeDefinitionMetadata.js\":\"422ac3f3a2fba81a\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeDefinitionRegistry.js\":\"4ccd212241d2b4c4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeExtraction.js\":\"0dedadcabf5570bd\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeInitialValues.js\":\"6056bc6fe7e3e121\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typePropertyGroups.js\":\"c8579e872b81a92f\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeSeeds.js\":\"7978b6503b416caa\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typeTagger.js\":\"e5cb4771c2097b05\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typedRecords.js\":\"fd751027e2388970\",\"/knowledge-medium/pr-preview/pr-1685/src/data/typesPage.js\":\"91b9f96aee359273\",\"/knowledge-medium/pr-preview/pr-1685/src/data/userPrefs.js\":\"bc50597659a91907\",\"/knowledge-medium/pr-preview/pr-1685/src/data/userSchemasService.js\":\"2063537bd998de76\",\"/knowledge-medium/pr-preview/pr-1685/src/data/userTypesService.js\":\"2deb4a22c1262cf0\",\"/knowledge-medium/pr-preview/pr-1685/src/data/valuePresetRegistry.js\":\"4b5013a7a71bd7b4\",\"/knowledge-medium/pr-preview/pr-1685/src/data/visibleChildren.js\":\"b613fb884a495d39\",\"/knowledge-medium/pr-preview/pr-1685/src/data/workspaceConversion.js\":\"61b731b337d31e9d\",\"/knowledge-medium/pr-preview/pr-1685/src/data/workspaceFirstSync.js\":\"8f054c1ba04ebc5c\",\"/knowledge-medium/pr-preview/pr-1685/src/data/workspaceIdNamespace.js\":\"5d3cd46e38d1b690\",\"/knowledge-medium/pr-preview/pr-1685/src/data/workspaceSchema.js\":\"fef2ad68bb140b10\",\"/knowledge-medium/pr-preview/pr-1685/src/data/workspaces.js\":\"33c73fa215da46a6\",\"/knowledge-medium/pr-preview/pr-1685/src/data/writeAheadLog.js\":\"ade5c6ed87074218\",\"/knowledge-medium/pr-preview/pr-1685/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/BlockPasteShellDecorator.js\":\"c8b5430d8e545487\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/atTrigger.js\":\"eac4e4a5f4738037\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/autocomplete.js\":\"86f1c08ac02af7ff\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/codeMirrorExtensions.js\":\"f647b5b1ef7b71fe\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/contentFlush.js\":\"9308a22b32935b20\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/defaultInteractions.js\":\"09c119f843b749e1\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/editSettleSignal.js\":\"8b3678f7bffa20a8\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/insertImage.js\":\"2686087184bb614e\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/referenceCompletionRange.js\":\"b9cdf3b181080d71\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/referenceTargetTypes.js\":\"1e12d8b7ec5e5dc1\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/syntaxContext.js\":\"67da3726584e3123\",\"/knowledge-medium/pr-preview/pr-1685/src/editor/triggerMatch.js\":\"c9cb616a4010c1b7\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/AppRuntimeProvider.js\":\"f68e9bd6ecc66d2e\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/BlockFocusShellDecorator.js\":\"2c0c05af97300c0c\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/ExtensionRenderBoundary.js\":\"e60c06ea7c4f154c\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/PanelContentRecovery.js\":\"a22d6429e9ae615e\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/apiCatalog.js\":\"ab7d98c2d60e5cb3\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/approveExtensionHere.js\":\"47897b7a3e19aed7\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/armedCutAppMount.js\":\"62688773e63d58ca\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/batchableKeyedStore.js\":\"38a303ba1a1c735c\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/blockInteraction.js\":\"9283465f76ae5767\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/blockLinkDecorators.js\":\"b6b5129eb2ed0b62\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/blockSelectionAction.js\":\"888aba530da4014b\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/compileExtensionModule.js\":\"7a18296f777b729e\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/compiledModuleCache.js\":\"1b2bd8419918e8ab\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/continuousGestures.js\":\"d24ea11ad7d92449\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/core.js\":\"2e90b5b3a47c1b0d\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/defaultRenderers.js\":\"20299e93e64128bc\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/definitionFanoutAppMount.js\":\"8ade82a35d2a08e2\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/dialogAppMount.js\":\"f716eebb9616e919\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/dynamicExtensionSeeds.js\":\"b25b9cad1376d84d\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/dynamicExtensions.js\":\"28683bd4ebb3d13f\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/exampleExtensions.js\":\"4852dc53fde56ea3\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/extensionApprovalStatus.js\":\"48d5d7925425316b\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/extensionLoadErrorToast.js\":\"2e965d3104e184ff\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/extensionLoadErrors.js\":\"dc16ace222431106\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/extensionLookup.js\":\"37525b478601fcf3\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/extensionToggles.js\":\"a514776d81932b3e\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/extensionUtilitiesCss.js\":\"803041bb691125ec\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/kernelPageDeletionGuard.js\":\"c6df1760920367e7\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/liveRuntime.js\":\"23e8a13bf9558583\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/openExtensionsSettings.js\":\"8c7bc92ed29178c5\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/overridesCache.js\":\"4b4f13f81d466e36\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/pluginIds.js\":\"cb495ca25f458c14\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/processorRejectionToast.js\":\"afa1ba6d761b136a\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/runtimeActions.js\":\"23d98657f8d3ed5b\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/runtimeContext.js\":\"d95e807a55cae546\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/staticAppExtensions.js\":\"7e39aae81fee88c9\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/staticDataExtensions.js\":\"bc9ae77578c82d19\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/toastAppMount.js\":\"280531462e57184e\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/useOverrides.js\":\"7201484e894209fe\",\"/knowledge-medium/pr-preview/pr-1685/src/extensions/useShortcutSurfaceActivations.js\":\"79ca749cec82f725\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/discoverToggleTree.js\":\"c2e29ffe09ef5060\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/facet.js\":\"cd27adeb6cd885fe\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/resolveAppRuntime.js\":\"eb5d63ddc6766c95\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/runtimeEvents.js\":\"5b0b09dc66885655\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/togglable.js\":\"cf1e19ab909c6a12\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/variantFacet.js\":\"f447b531f796fd54\",\"/knowledge-medium/pr-preview/pr-1685/src/facets/verbFacet.js\":\"6b11f40bd62adc8c\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/block.js\":\"652ae0cf5f1ccdc8\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/focusedChild.js\":\"2f72bca3fa97196b\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/propertySchemas.js\":\"3a2a9512c8464af3\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/typeRegistry.js\":\"ba6db9f7707d2524\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useAncestorCrumbs.js\":\"5aac183acb60622c\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useAutocompleteListbox.js\":\"a7362cf2b510460b\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useDebouncedSearch.js\":\"2eaaac6dcaac522f\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useDebouncedValue.js\":\"cf3844e93eea487e\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useIsFocalRender.js\":\"79caea34f15fa285\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useIsReadOnly.js\":\"37703e6662d473ba\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useMaterializeBacklog.js\":\"ca8ed81bdc474f2a\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useMinuteClock.js\":\"458724528ff547ed\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/usePanelLayoutProjection.js\":\"746fe1966c090c84\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/usePendingInvitations.js\":\"9c6b947db19fd3a9\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useRendererRegistry.js\":\"4d073936affc765b\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useRetainedFieldRows.js\":\"f9bf8c3791114ae1\",\"/knowledge-medium/pr-preview/pr-1685/src/hooks/useWorkspaces.js\":\"6a11359473550fd8\",\"/knowledge-medium/pr-preview/pr-1685/src/lib/utils.js\":\"877c32d098bbb4c3\",\"/knowledge-medium/pr-preview/pr-1685/src/main.js\":\"45665c5ed1344fc9\",\"/knowledge-medium/pr-preview/pr-1685/src/markdown/MarkdownImage.js\":\"b845e2c01667d288\",\"/knowledge-medium/pr-preview/pr-1685/src/markdown/blockSeparators.js\":\"ea706dd978a55c34\",\"/knowledge-medium/pr-preview/pr-1685/src/markdown/context.js\":\"b40d9de8fff8386b\",\"/knowledge-medium/pr-preview/pr-1685/src/markdown/defaultMarkdownExtension.js\":\"2101fbd5ed4f3522\",\"/knowledge-medium/pr-preview/pr-1685/src/markdown/extensions.js\":\"f8e621ddfa7906b9\",\"/knowledge-medium/pr-preview/pr-1685/src/markdown/renderMarkdownHtml.js\":\"f07def73075bd38f\",\"/knowledge-medium/pr-preview/pr-1685/src/minimal-editor.js\":\"edfa539b246d9e1c\",\"/knowledge-medium/pr-preview/pr-1685/src/paste/armedCut.js\":\"ec38ace377f84251\",\"/knowledge-medium/pr-preview/pr-1685/src/paste/captureMediaVerb.js\":\"7edf230009d565b1\",\"/knowledge-medium/pr-preview/pr-1685/src/paste/clipboard.js\":\"1ba49a7aa3b2300e\",\"/knowledge-medium/pr-preview/pr-1685/src/paste/decision.js\":\"b79d37966090b6aa\",\"/knowledge-medium/pr-preview/pr-1685/src/paste/operations.js\":\"49f772dfd2e62168\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/account-header/AccountHeaderItem.js\":\"350d9ba73cf9636b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/account-header/index.js\":\"f0a2b89f783f26c5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"718d68b11efd1344\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/askAgent.js\":\"2a8eeaa308ed9e18\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/askedStore.js\":\"a7d16a845d51a196\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"71cef6865e3648a9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/chipState.js\":\"c4a73df46b6ccab5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d3413f51d67b066f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/index.js\":\"ff21f2ac06b7a49b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c2164438913c7e4d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-dispatch-companion/schema.js\":\"1dfbffc4e285dc79\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/AgentTokensDialog.js\":\"db000204fda93b7a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cb05b016ca7eaf6f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/addMedia.js\":\"523bd93234c27338\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1ff984f4a4f8d5d7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/block.js\":\"99ec5c3cc4e120ca\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/context.js\":\"4edf9ff3f975771e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5fc56d196930dfe1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/index.js\":\"a5cbd0c701cf8250\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/outline.js\":\"d4983fec2afce76e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/properties.js\":\"fe9fa20ae4d6376b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/refs.js\":\"33fe187c051a48ab\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"389172dbd4c04195\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/search.js\":\"d92e38d24ffcd304\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/shared.js\":\"093eec95479d3939\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9912096171b3c236\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentViews/text.js\":\"742d79af78c1ae23\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/agentWrites.js\":\"bddcb5d8ff23b317\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/authoringCatalog.js\":\"25b98b8ad01bcc7c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/blockRefTargets.js\":\"c07c6adc6ebe42ac\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/bridge.js\":\"2d8579f924f9444c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/bridgeLoop.js\":\"f01470d1a42a592e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/changeHistory.js\":\"dd3c580fa463e8dc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/commands.js\":\"730af423a32e5f1f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/commentsCommands.js\":\"f3dc28f2373a7fdb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/dataExtension.js\":\"673d852b71a2a490\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/dataModelGuide.js\":\"3ff7f921f8cfa4ef\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/describeRuntime.js\":\"39f06bdf24fe2f59\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/extensionLint.js\":\"385b09f22d53ab7a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/grainAudit.js\":\"6310f009e3eec600\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/healthCommand.js\":\"eb4d001b0b33ea4a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/index.js\":\"dd4028b6724b5392\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/presetIdentity.js\":\"8d0593d9ce71ab36\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9ab7c532b5674614\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/readMedia.js\":\"65f71c9c7bbacf6e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/schema.js\":\"42ef902558765b59\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/serialization.js\":\"e1fc2b42da76ae19\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/targets.js\":\"a0e4741d58e9c521\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/tokens.js\":\"ae20adb5ca1046be\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/watchEvents.js\":\"6ab987afbc8eaddc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/workspaceGuard.js\":\"192a5ad9af16e0b4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/agent-runtime/writeCommands.js\":\"bf0b47c6116a61c3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/AliasCollisionToast.js\":\"023b72960bb9f144\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/DuplicateNameBanner.js\":\"4e1433fa7f597ea8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/collisionMerge.js\":\"9c89abe4512148ba\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/dataExtension.js\":\"3dae7a0b773cbf3f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/index.js\":\"707ab1deae44e19e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/mergeCollisionAction.js\":\"c0203342ce9ee526\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/pageStyling.js\":\"e69d6babf1883619\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/rejectionToast.js\":\"65b2c6fa27531ccf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/alias/syncProcessor.js\":\"3901be6688bb93be\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/actions.js\":\"07c8d447fbc42af5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/addComment.js\":\"c05d45acde28fe65\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/anchor.js\":\"454be1037a84bbf3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/anchorState.js\":\"840ed948859f675f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/commentLinks.js\":\"de36618225927646\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/confirmThreadDeletion.js\":\"e8470f8c5b424373\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/container.js\":\"ebaa6379d3d34b1a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/dataExtension.js\":\"abc1e7d7279889e4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/deleteComment.js\":\"235bc1d768b1fbd9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/highlights.js\":\"4a2c950347944288\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/index.js\":\"dd31397cb9f7ddf5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/linkedCommentsPill.js\":\"ac72151ba8c45334\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/margin.js\":\"76496bc0d74e2cbb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/marginSchema.js\":\"37a98809b21f800c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/newComment.js\":\"d9e4a1c362f48000\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/ownThreadPicker.js\":\"48f93d8b594e047f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/placement.js\":\"9ee137cd7adaf8c8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/queries.js\":\"1d8fc28a21535216\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/quotePosition.js\":\"4fec4a99ef07a4e1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/quotedIn.js\":\"d7f69aa56ebe82b3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/quotedRange.js\":\"0d155c82a4d47b95\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/rangeRefs.js\":\"5121915c7706ea99\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/readHighlights.js\":\"e7937fbb457725e7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/readSelection.js\":\"3e21e726f33fca7e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/readSelectionUi.js\":\"b1e51f7167adb0f9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/reanchor.js\":\"f52b6a2548021e98\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/schema.js\":\"b307787aa2c275d7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/scope.js\":\"6f813d2fa4610370\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/scopeThreads.js\":\"b9242e525beee8d6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/splitRetarget.js\":\"0b07802a37417226\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/suggestionCard.js\":\"81006636458640ba\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/suggestions.js\":\"8a1d4c9645085c6f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/summaries.js\":\"45129c748e309f0c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/summaryBatch.js\":\"39840aca0b95ed77\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/surface.js\":\"bb69a2bb16ec732a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/threadNavigation.js\":\"f17bff1fd6eff61e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/threads.js\":\"a1710d8be5b1aaa4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/ui.js\":\"bfc5b38d3b0066fc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/annotations/uiStore.js\":\"d3eeabc57a7611b0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/app-intents/appIntents.js\":\"6f104b8e6f9356ee\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/app-intents/index.js\":\"bd1d9c3339d0084e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/app-update-prompt/index.js\":\"1a8c4a0f16194f46\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/app-update-prompt/status.js\":\"239be9bb4966a8bf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"eedcf2a3562dcbab\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/MediaBlockRenderer.js\":\"2d339e10cc92de2c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6b713de5f576be69\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/MediaUploadReconciler.js\":\"70955e80c3f62053\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/assetDownLane.js\":\"17424945c1854fa1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/assetResolver.js\":\"1144a4592ed59b82\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/assetUpload.js\":\"1788b0aa1795b355\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/attachmentCleanerIO.js\":\"1484b7d910616ea9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cfaca7813bc9d062\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/blobStore.js\":\"dbcd4b57123a73db\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/browserMedia.js\":\"389f6dbd9463db4f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/byteStore.js\":\"1f6facdd225fe906\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/cleanerIO.js\":\"835187c5158b56e4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/cleanupAttachments.js\":\"08829ba1ad5046dd\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/dataExtension.js\":\"3e1d1893f3b80320\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/downLane.js\":\"37ab661691b8f32c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/index.js\":\"332ac76b078f91fd\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/insertImageContribution.js\":\"ae80ecd41caaf2eb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/laneArming.js\":\"b52b05d024803389\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/laneLock.js\":\"b533afb43f30ef2a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/mediaBlock.js\":\"a86d8e96a4a82a73\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/mediaCapture.js\":\"a01745f4a20341e1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/mediaLanes.js\":\"5fdd6cba67bb1bbf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/mediaViewers.js\":\"f34ae60fdc1fb2fe\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/mediaViewersFacet.js\":\"242d701a680198eb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/pasteCapture.js\":\"1333543fa996a831\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/resolver.js\":\"094140266e9c8171\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/retryUploadsAction.js\":\"efdedb397183a024\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/storagePaths.js\":\"bc6eb61116f2dfd4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/uploadDrain.js\":\"748ce8a4e6179f0e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/uploadLaneStatus.js\":\"12a7c7265c96cace\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/uploadReconcile.js\":\"7a8876b287003622\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/uploadRecovery.js\":\"d5977bddb31f16f3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/uploadStore.js\":\"c0e38f8a0fe84336\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/attachments/useAssetObjectUrl.js\":\"fc4222531cc993e2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9713f9174a53b834\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks-view/BacklinksViewSection.js\":\"037226f0cd366fad\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks-view/facet.js\":\"cacbc3ea6885a446\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks-view/index.js\":\"bd2db7faea71b86a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks-view/prop.js\":\"e4e5b80d7a4d63a5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/BacklinkFilters.js\":\"e0857705166f8937\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ce25455ac867f98c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/BlockEntry.js\":\"4571ce34ba7aeaa1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/LinkedReferences.js\":\"e4efa3f3b2ed775a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c6ad6a405a35ca5f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/dailyNoteDefaults.js\":\"f60d152e642ece95\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/dataExtension.js\":\"3f68f83e5d9ee966\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/edgeExclusions.js\":\"17f5e1006848b80c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/filterProperty.js\":\"ddfc465eec9bf9a0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/index.js\":\"a527b73e7a5a245d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bbd808f03ece4490\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/inline-counts/applies.js\":\"0d6164aa0868744f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/inline-counts/countQuery.js\":\"ec0592977ab6b155\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/inline-counts/expansionStore.js\":\"29af979fd741f13e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/inline-counts/index.js\":\"87438227127f6740\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f83d08e450506430\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/presentationInvalidation.js\":\"6fa2b6199488ed3b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/propertyEditorOverride.js\":\"f870d34838c48e3b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/propertyFilter.js\":\"4f4dcf83ce600f4b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/query.js\":\"527ddc74f893da35\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/resolveFilter.js\":\"87d3110d97b4c95e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/sourceBatch.js\":\"14be5d33892e1f5f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/sources.js\":\"d2a280696763bde4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/useBacklinks.js\":\"0b51bd51483b2c2c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b75edc0dcdb6a28f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/birthday/BirthdayCelebration.js\":\"5c033e6d7cef13b3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/birthday/BirthdayOverlay.js\":\"661aa5aa6c372b0c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/birthday/gate.js\":\"e40896bdf7398d9c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/birthday/index.js\":\"30a318035049849b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/birthday/wolfTheme.js\":\"9920c266a6dd3c4e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-drag/BlockDragLayer.js\":\"a9f96f066d9087d6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-drag/dragController.js\":\"00a18e37d18c6cf3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-drag/dropTarget.js\":\"160784b7241c5930\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-drag/index.js\":\"5b2d3b0418e0b4a1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-drag/projection.js\":\"ff3d5a455db4df5b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-info/BlockMetaCard.js\":\"33ab9c17cac97eb5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-info/index.js\":\"0826745861f3eb37\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/AddTagDialog.js\":\"c129e9b891b16ea9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5b33f59f2c15f36e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/TagNameIssueHint.js\":\"a7c1db16d8eebf29\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/addTagAction.js\":\"aae9d11a114f5cf8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/appendTag.js\":\"b5c34c095fc580f1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/config.js\":\"4d4a64b1fec45eaa\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/dataExtension.js\":\"ac806b7b8181fcfb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/index.js\":\"450dd4981bbc1bd1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/block-tagging/propertyEditorOverride.js\":\"27c37d6ea06114de\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/BreadcrumbList.js\":\"52b09456d809132b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"793e2cbd109fa2fa\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c565f097b75f480b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"96d4807f4b5c1bb7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"705cec6df129ffae\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/index.js\":\"63fcb3e7386139f2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d65bdfc5dd2fb13d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/CharacterCountItem.js\":\"bfbf4c0d861faad7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bb7f63a8494205ac\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/actions.js\":\"99955b8eaca08f21\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/blockType.js\":\"ef198a405f20be32\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/charCount.js\":\"2eb9ecb5843447c4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/dataExtension.js\":\"61dfb5aa9680a6bf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/index.js\":\"310340d11986685b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/profiles.js\":\"342525beee799325\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/properties.js\":\"6f3c25afc21976a3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/character-counter/textCounts.js\":\"8f217bf4b92f332f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/colemak-keybindings/index.js\":\"f674da5dff451ab1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/CommandPalette.js\":\"ab39f64f3b6249dd\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/HeaderItem.js\":\"7730715db3f565fc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/context.js\":\"2f84f379b244d42d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/index.js\":\"eb462b7ddc251c65\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/selection.js\":\"e0c86ce84e87ae01\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/toggleStore.js\":\"4c7947b56f2c9be5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/command-palette/useCommandPaletteActions.js\":\"3e851971a63b3a8d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/ContributorBadges.js\":\"5d7f27a3c3640693\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/author.js\":\"e926db90b0fa79c7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/codeMirrorExtensions.js\":\"95148aef92891f61\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/dataExtension.js\":\"5dc66cc7269398b1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/index.js\":\"c26de4f1a89f9a5c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/mentionAutocomplete.js\":\"8ad21ee1cb40fae7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/processor.js\":\"d086fc2fa0cca616\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/profiles.js\":\"1a3498288f0500c9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/queries.js\":\"dee88ca89350e81b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/contributors/schema.js\":\"9b4392c9c8d55db3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8cfe0dd3efc9aa41\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/cursor-follows-scroll/followOrigin.js\":\"241220fe69c79361\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/cursor-follows-scroll/index.js\":\"8cc6c228ce831a36\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1e2bbb648119d7fb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"27b7160b92f6249c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/CalendarGrid.js\":\"16de12c6b7502fed\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/DailyNotePicker.js\":\"b5719e66db3f5b96\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"261f02dae6fdd49a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/DateNavDecorator.js\":\"0fb1be9dddaab757\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/DateScrubOverlay.js\":\"4ecafaeaf9a5abc9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/HeaderItem.js\":\"2cfc39ebda1b6920\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/ReschedulePicker.js\":\"9f1a5ee1a6635894\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9624cf31f3468c80\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/actions.js\":\"ca2013af07399c46\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/blockDateAdapter.js\":\"43fb13b3317d33f1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/calendar.js\":\"af51396a3003df7d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dailyNotes.js\":\"50943789ebfb02f4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dataExtension.js\":\"4bfaec32a5ceede1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dateScrubActions.js\":\"12bce31a6950fb74\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dateScrubGesture.js\":\"10d7f9d05ec89e32\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3e5f92eabbd91b9a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ff5d28cb3814451d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/deletionGuard.js\":\"8de0b54d7faa31a6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/dueQuery.js\":\"579fb13a53ab846e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/index.js\":\"0feb73e096d0734e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/landing.js\":\"d7f5a2c7da157c3d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/localSchema.js\":\"89bc258767ae7617\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/referenceDateAdapter.js\":\"a398748e8dd850c1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/rescheduleAction.js\":\"268bfc305cb47b99\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/schema.js\":\"0f97a3e220e72175\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/spreadBlockDates.js\":\"3e1796c92bf4db8f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/spreadDatesAction.js\":\"09cf310696bcf495\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/today.js\":\"f3901653f326af2a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e921a64b8e60b07a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f270c8e5bafe45e1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/audit.js\":\"fdc80dc29b8f9fff\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/auditAction.js\":\"9e09e5c6c829893d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/auditRanges.js\":\"080a124c2b9c93f7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/diagnosticsSource.js\":\"6ddf7bac047f1532\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/divergenceScan.js\":\"24d21de02041a160\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/index.js\":\"84144101e1a3fbd0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/propertyChildrenChecks.js\":\"894dcb8fcad2b929\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/referencesMirror.js\":\"e223742a4a76e1f1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/rowJson.js\":\"1c6585fd0fa5d1a4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/schedule.js\":\"2888287e35d9d390\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/data-integrity/store.js\":\"c1d0284e0c7c9ca0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-maintenance/action.js\":\"3747e522e1812cdb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-maintenance/index.js\":\"b148421bd392ca5f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-maintenance/plugin.js\":\"b90723a7e65bfc5c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d5b01ce365b1c613\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/actions.js\":\"4e3de38855ae94de\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/changeMarker.js\":\"833e2d090c23e97d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/diagnostics.js\":\"425c42490ef0f4eb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/fileSystemAccess.js\":\"d6a02c1d3e30770c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/filenames.js\":\"8b90fd2e92abd5a9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/index.js\":\"755a3206eeb300f4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/mirror.js\":\"7a2379b6d60dfc52\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/runLock.js\":\"256ee502a4ece9f0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/runtimeHealth.js\":\"516796c333b05fd7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/schedule.js\":\"e4bd2d980f352df7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/db-mirror/store.js\":\"51b40d7241f34b69\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/default-themes/index.js\":\"753f13d91db0d127\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/default-themes/themes.js\":\"69c0b707659c2df7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/diagnostics/facet.js\":\"96f1289d60a990e6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/diagnostics/useDiagnostics.js\":\"f5eeb6491fad0bb5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extension-prompts/dismissals.js\":\"a88e9f2294185f40\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extension-prompts/index.js\":\"8bd326205131be26\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extension-prompts/status.js\":\"99def7a303ec5ca0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extension-prompts/store.js\":\"83ceee8c6fd04f2b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9255d4197ce0342c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/ExtensionsSettings.js\":\"82737a03f4f50b71\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/actions.js\":\"11cb171e134a5c5a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/config.js\":\"683ac1ea37d466fc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/dataExtension.js\":\"f12aa43f71651035\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/effect.js\":\"6b214ec1e007e9c0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/index.js\":\"1d228b17951b46a9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d5733c1ce4c9f8cf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extensions-settings/useToggleTree.js\":\"52166f45c146c35d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extract-type/ExtractTypeDialog.js\":\"b22a9687a203a6a3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"56d1fab30cc9b2ac\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extract-type/PropertyShapePicker.js\":\"e7d0134bbd98273d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extract-type/action.js\":\"9b3a29ec2004a255\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/extract-type/index.js\":\"39bd8119280b4aa8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/FindReplaceDialog.js\":\"1c7df757df1c685a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/HeaderItem.js\":\"0bf5e7b37269280c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/dataExtension.js\":\"2bb39359a0fd86e9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/index.js\":\"ded2f5e6930efd4c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/search.js\":\"d7dafc51ccf78ef7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/toggleStore.js\":\"ba4b64e5bef8a135\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/LocationPropertyEditor.js\":\"e84a396589afa0ee\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/MapView.js\":\"bdeabe429233cf95\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/blockTypes.js\":\"f728b9a7963665f0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/codeMirrorExtensions.js\":\"8bc0481b1950d2cc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/createOrFindPlace.js\":\"dd34b06f26923783\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/currentLocation.js\":\"f5ba6f526704aa75\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/dataExtension.js\":\"d153e00ca0aa3b7d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/geoContentDecorator.js\":\"a88f870c701925d5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/googlePlacesClient.js\":\"e985c56158fa0c20\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/index.js\":\"f503c0939de952b2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/locationsPage.js\":\"2edd9c6309010415\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/mapViewport.js\":\"c38531fd90a41798\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/pickCurrentLocation.js\":\"b24c3387f3f8c0d1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/placeAutocomplete.js\":\"3dd527a837f96819\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/placeNameCollision.js\":\"6f90abd0e7b2a869\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/properties.js\":\"3d40ef7e67ccea25\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/propertyEditorOverrides.js\":\"89daa17a75371ef9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/query.js\":\"6f7f587ff973c1c6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/geo/usePlaceSearch.js\":\"b33bdc77f8ceb70b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6e3a686286c056cb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0f37b52f383deb86\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"082eebe4996de5c3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/config.js\":\"74acda77cb04c420\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/dataExtension.js\":\"eaea288d0e1c5d8a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/facet.js\":\"e9f6f9efd3bfe933\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/grouping.js\":\"16ff3a75a26a1c52\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/index.js\":\"d14b1f1ae8df58b1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"693a613f676d5ca1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/query.js\":\"029676e0db2a60e8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/resolveConfig.js\":\"45d2e04ba0597e9f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"13d7e60f5c1380c0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4d64b425fb3dadfb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/HtmlDocumentContent.js\":\"213efabab6ab3d97\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/HtmlFrame.js\":\"de5d047ee25b1177\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/actions.js\":\"002e3305bdb79412\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/blockType.js\":\"3062aac12494e5b5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/confirmRunScripts.js\":\"2ea857891d1ab5bc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/dataExtension.js\":\"d6fe75951bfb06c7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/frameAnnotations.js\":\"f29464957faf59b8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/frameDocument.js\":\"bc539cabfa671ef2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/frameTheme.js\":\"c4a95cf2d3185843\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/index.js\":\"b61b9e9871aab6ff\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/scriptConsent.js\":\"ac77e2fc3832b997\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/sourceMap.js\":\"5804e338ed838703\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/html-document/useDocumentScripts.js\":\"4c46d5d8c210d59e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/interaction-metrics/index.js\":\"71b0368ff3ecc017\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/interaction-metrics/record.js\":\"f11f4d13ead85a22\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/interaction-metrics/recordStore.js\":\"7b5380e350b7c888\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/interaction-metrics/responsiveness.js\":\"f593a5eb44bcaf1d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/interaction-metrics/schedule.js\":\"8f93abef42bc6301\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/interaction-metrics/sessionContext.js\":\"232240dd1619d75b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"004c324cc912b95f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a2337b1c0cfb4cd6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/actions.js\":\"c46fdd9eaec9bf35\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/config.js\":\"ff022769ce9de81e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/dataExtension.js\":\"993ba18c7ed6fcfa\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/effect.js\":\"ade069e49c4402bb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/index.js\":\"73de9cca74ccfcf0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/keyCapture.js\":\"5083d117fe9de7cc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/overrideStore.js\":\"c5e5bf773e6f1d1c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bed709a7fa450fd9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/HeaderItem.js\":\"5504d20846186430\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/LeftSidebar.js\":\"0c94c8c237e256e5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/actions.js\":\"29ca1dfbda4edd4f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/facet.js\":\"df93ab8ac6d93344\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/index.js\":\"084efff0e1d48007\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/shortcuts.js\":\"ebeaf779272ec222\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/left-sidebar/toggleStore.js\":\"929c7da8b47428a8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/link-preview/LinkPreview.js\":\"eb0a374a344bb07d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/link-preview/index.js\":\"142a2cb39cf7316d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/merge-blocks/MergePicker.js\":\"9009545af9775e3c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/merge-blocks/index.js\":\"c85387698bde5cec\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/merge-blocks/mergeAction.js\":\"725ee85740da39d9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/merge-blocks/strategy.js\":\"6d13815b2a9c6af3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-bottom-nav/Button.js\":\"65ea38969e978832\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"280f6387b1c7e89c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b2c5320795f78131\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-bottom-nav/facet.js\":\"928a332dde11d80c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-bottom-nav/index.js\":\"1b306c1e60bf0ead\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"59d9de7e22c3a85d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-keyboard-toolbar/actions.js\":\"db7ec20c1fd42aea\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1774397198d77a3e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7ab09c5151e10aaa\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/mobile-keyboard-toolbar/index.js\":\"c5e06e3858a52765\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/MoveDestinationPicker.js\":\"556a82df496c63b5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/blockSubtreeMembership.js\":\"88b933e6262b001e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/contextMenuItem.js\":\"67101e0d210879e3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/index.js\":\"312ac843571ecde1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/moveAction.js\":\"87bea23089521630\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/moveBlocks.js\":\"3ea5496a7eacf6c4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/move-blocks/selectionAfterMove.js\":\"19eb9d970720a8f0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/TutorialBanner.js\":\"ccc25f5fba40cfee\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/action.js\":\"8eb38186b7f3eb7d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/bannerDismissal.js\":\"42e566007fd81b43\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/documents/cheatSheet.js\":\"d7d8b4d7e37bb174\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/index.js\":\"bd006c5c1d859f43\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/keys.js\":\"b91fe1df76f0cc18\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/landing.js\":\"2ab77ffb44a14237\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/outline.js\":\"96625da493992b49\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/onboarding/seed.js\":\"cfd03b8c6b70cfe4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e53197b2eb3f94f9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/analyze.js\":\"1955230706ecf12e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/diagnosticsSource.js\":\"1506696c81f38288\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/index.js\":\"c3d1a18b4c816c7b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/load.js\":\"4636fc4da259a308\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/monitorRun.js\":\"74e36365da0f5c9f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/schedule.js\":\"15e0da9a7874edfd\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/series.js\":\"fef14a08140e0fbe\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/store.js\":\"a7fffc0be6f739c1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/trendAction.js\":\"2781d7fa18225029\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/perf-monitor/verdict.js\":\"9247af05be286c3e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/plain-outliner/clickToEditAction.js\":\"aa8fb16b1d1fabff\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/plain-outliner/index.js\":\"9811deb4c23d720a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/plain-outliner/interactions.js\":\"b2e8c2aef6130a69\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ed23a2377870184c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/MigrationGate.js\":\"7ef3c4a243c696a6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/MigrationGateDialog.js\":\"26525e9092066f11\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/action.js\":\"c11e8c418b74ca67\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/index.js\":\"aab7717119d185ec\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/localRunMessage.js\":\"be2ea41717ecea98\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/plugin.js\":\"f55dc7a63b63e797\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/progressReport.js\":\"27e733abde45076c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/properties-migration/sweepProgress.js\":\"cfe0ca5cc4195c0d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/FieldRowRenderer.js\":\"d77a1daa3c976f3d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/ValueRowRenderer.js\":\"ceee2014b04be5a1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/actions.js\":\"a2cfebedb26aaf37\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/autocomplete.js\":\"4dbac61baa416353\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/fieldRow.js\":\"0ef6a81507f809b3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/index.js\":\"2a4d25b7a15a6767\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/referenceWarning.js\":\"931a5e4517352bd2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/valueAutocomplete.js\":\"ca042722f9ae11f8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/property-rows/valueSchema.js\":\"c238086956bdb7f6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/HeaderItem.js\":\"5cbf11e16f03b3c9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/QuickFind.js\":\"9c9a73bbfb69e7d8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/index.js\":\"60670053006b7380\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/recents.js\":\"b2cdf88aed6d7c5e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/resultItems.js\":\"8ac568002cdf5b7b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/selection.js\":\"b28c52856bd6eece\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/quick-find/toggleStore.js\":\"321588a511818050\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/recents/HeaderItem.js\":\"8b8244812a5ff7d6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/recents/RecentsPageBlockRenderer.js\":\"07e98935c1391a2c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/recents/grouping.js\":\"f5875e48c54fe856\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/recents/index.js\":\"1adb9528e45535cb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/recents/target.js\":\"a446cf9909dda317\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/codeMirrorExtensions.js\":\"d4b635b60d0499fe\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/contentPrefill.js\":\"049ddd21c2dcc8d3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/dataExtension.js\":\"842b82147a3771e9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/index.js\":\"037a053491dfa892\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d41b76beca6fa152\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/invalidation.js\":\"310323138203bd06\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/localSchema.js\":\"3fb04d3fee7a5804\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/blockrefs/index.js\":\"c307aafb20aa62ec\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2a234679e4a08b5d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/index.js\":\"b707c7a6609bdaec\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/referenceNode.js\":\"7f1cea8910247175\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/remark-reference-occurrences.js\":\"04556075286a9793\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b4c17f52d998cfd4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/wikilinks/index.js\":\"115a917fb9d2568c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b9081a7c93d193ce\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8b02dffe04ce750b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/mergeRetargetProcessor.js\":\"b4a7eb25ad0ad6b3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/parseFence.js\":\"51c711983da29b4b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/referenceParser.js\":\"aaf656fb9581ab12\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/referenceProjection.js\":\"613f3346fb0f22af\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/referencesProcessor.js\":\"d92d25dba445e38f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/renameProcessor.js\":\"1dc9f8fbb3384a6f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/references/spanReplacement.js\":\"7957ab6c8187b5a8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/rich-paste/htmlToOutline.js\":\"74b2bd2aa79614dc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/rich-paste/index.js\":\"53367b8d780087cf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6402ad4fcde20808\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/rich-paste/pasteDecision.js\":\"630c62a730331963\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/action.js\":\"5a3a8367b1c53849\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/blockIds.js\":\"55c486872627d594\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/content.js\":\"b0f45c76175f7835\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/effect.js\":\"08e9607b16dc94c1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/ids.js\":\"91753f538a1fc0df\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/import.js\":\"7f000b12f928cf4e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/index.js\":\"3f1f2af9bc87c269\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/plan.js\":\"4779beb2c17e38b2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/plugin.js\":\"3fd78f8229eec0d4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/promotion.js\":\"71f067df5ac65e9a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/properties.js\":\"88872b4de031d83a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/references.js\":\"ffae642d2dfd6e8e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/report.js\":\"ea2417004336e08b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/roamMemo.js\":\"e272f5d273f337bf\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/runtime.js\":\"48b0357d533f00f4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/schemaReconciliation.js\":\"0d74d9314dd6de4b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/srsMarkers.js\":\"7de70e7e1753648b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/todo.js\":\"f7ad19ae7f5315ac\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/typeCandidates.js\":\"a30adf456d3c1fe6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/roam-import/types.js\":\"5d598e35da0b8936\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/search-health/index.js\":\"df493ee29c23adc6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/search-health/store.js\":\"f5920de19ababfd5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/shortcut-help/HeaderItem.js\":\"fbaf39ec9ea69d0e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a7dea579a07aaea9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/shortcut-help/index.js\":\"b47afd68b5c2c714\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/shortcut-help/model.js\":\"12359ef45fe230b2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/shortcut-help/toggleStore.js\":\"c4093d4c57029f83\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/shortcut-help/useKeyInspector.js\":\"baa6464b426939d7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1a5b40c544e7fde1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/ShellDecorator.js\":\"0fb7abbe79c2b3fb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/actions.js\":\"093e81ee859ec661\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8df647b31148fb03\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/index.js\":\"caf2e27575051180\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/shell.js\":\"6baaa78636c6571c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/surface.js\":\"05c4f376e55b3338\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/spatial-navigation/walker.js\":\"29ebe5681ecce8d8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4a7dc344caaac450\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/dataExtension.js\":\"5488d09f659a64d8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/index.js\":\"9d31bbdb1ad83fce\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/indicator.js\":\"42f1c91bfbbb9a8b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/moveSrsState.js\":\"3d95fb69b7fcc623\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"27fd8bd5d12d9037\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/scheduler.js\":\"0ad257f2675b836c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/schema.js\":\"bfae08610cb61c49\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"fc8d3095857b108e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/srsClipboard.js\":\"3c8140db459d53bd\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"11f8332298b0b316\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e1e667bc70026183\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/DeckPicker.js\":\"fb6f35c20b6581f9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/ReviewControls.js\":\"667c6a2bcbb2f944\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c0d4b1b999b1bd79\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/ReviewSession.js\":\"6c4386e3265a661a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/actions.js\":\"fd9aa798ba0c80c7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/archive.js\":\"5e1dcc788389bee7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/dataExtension.js\":\"f8b3d26e416d1853\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/deck.js\":\"16dd1449a15e4b14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/dueQuery.js\":\"3a6df96955bc4ddd\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/gradeDecision.js\":\"65e475a4461d847a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/index.js\":\"87b2a9a1fadca60f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/keyHints.js\":\"0fcf37469e36c1ec\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/reviewCardLayout.js\":\"6761efdf7bf23d43\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/reviewProgress.js\":\"1d5527639bdd8bec\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/schema.js\":\"a6823928d13b1ba6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/srs-review/useDueCards.js\":\"2b07339116877bc2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/startup-metrics/index.js\":\"100a7c7fbac55866\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/startup-metrics/record.js\":\"566f0c0e95411b9b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/storage-persistence/index.js\":\"708addaa2eaf8c14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/storage-persistence/persistenceStatus.js\":\"fe8644f311f68420\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/storage-persistence/requestAction.js\":\"26261e65f80251e2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/supertags/TypeChipsDecorator.js\":\"0ca2fcfb1f475e01\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/supertags/codeMirrorExtensions.js\":\"eed6199aa124d856\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/supertags/index.js\":\"ac1ef95332b827f2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/supertags/typeAutocomplete.js\":\"382f210664bc9644\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"350d2b09b4a43084\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/actions.js\":\"783006a47203d395\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/anchor.js\":\"39a7dd612f0e458f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/events.js\":\"061b187351ff8bc5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/gestureActions.js\":\"00958fa681742329\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/index.js\":\"20765acec439b2b5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"66137b4ab642b13b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/sync-metrics/collect.js\":\"86073aaccf8049f6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/sync-metrics/index.js\":\"5ca07307c79348f2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/sync-metrics/record.js\":\"9ab6232c00a45907\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/RejectionDialog.js\":\"e3a774774b036d87\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c2c3bacaabef55d0\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/index.js\":\"f87ed8930a257eab\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/model.js\":\"1204cc1c11e07c4d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/queueCounts.js\":\"c5e5f5bbb82a019e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/rejectedHelpers.js\":\"e4d6afa241eda5a7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/rematerializeAction.js\":\"487c3284fae588a1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/system-status/useHysteresis.js\":\"c714f98e6d4486da\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/ColumnHeaders.js\":\"1de49b3190ed5199\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/QueryUi.js\":\"e2301037f34d882f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/TableLayout.js\":\"dc9e76016895d8f2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/actions.js\":\"c2dcf1e98d6c7953\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/cellEdits.js\":\"3aac713b31ebcf46\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/childrenViews.js\":\"6d03f3e6544b81a4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/columns.js\":\"a5d5764fd70291cb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/controller.js\":\"c5a942dd3657b21d\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/convert.js\":\"330fa8a31d82ab8c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/dataExtension.js\":\"a98c5248bd80d667\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/index.js\":\"0f09af9bdff42de6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/keys.js\":\"9a8b1ef857ceaccb\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/model.js\":\"6e5ca31afc57c421\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/query/backfill.js\":\"2209bda1849d11c3\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/query/completion.js\":\"ab1e93ebcfcb1009\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/query/format.js\":\"47588ab3aa7a7a8e\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/query/parse.js\":\"e860efd6802f7026\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/query/queryValue.js\":\"70b48b4914b090f1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/query/source.js\":\"e0354185ee4e4edc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/registry.js\":\"a9d568c5f5e8bdf5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/rowGutter.js\":\"ad6d42cb4615638b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/rowVerbs.js\":\"3ce00f088921e799\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/schema.js\":\"fc5d640566438b5c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/tables/sort.js\":\"a4e3e7d4616f18b5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/theme-toggle/effect.js\":\"c1abe8c17c98fa74\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/theme-toggle/index.js\":\"daba85a088b87b25\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/theme-toggle/theme.js\":\"cee9442aa8c1301a\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/todo/actions.js\":\"94be9f87ef610243\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/todo/dataExtension.js\":\"bd778f54d8e865a5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/todo/index.js\":\"06b21e5ff2eb3da2\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/todo/schema.js\":\"1dbe538eee04f5c1\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/touch-selection/TouchSelectionLayer.js\":\"98b584125dceb124\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/touch-selection/actions.js\":\"1c9ea98c8cad3a68\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/touch-selection/defaultItems.js\":\"245cf0bd2ef85b14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/touch-selection/facet.js\":\"6052e95424989105\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/touch-selection/holdRecognizer.js\":\"b9db84417898e755\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/touch-selection/index.js\":\"cdd0c3ced8d923b9\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/update-indicator/UpdateIndicator.js\":\"fcb8893b208d2f6c\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/update-indicator/index.js\":\"d8a4467dcbe5b57b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/update-indicator/loadTimes.js\":\"bdb91c01a632f72b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/VideoNotesRenderer.js\":\"9a5b0ea9145522b5\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/VideoPlayerRenderer.js\":\"96631d7528582185\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/VideoTimeStamp.js\":\"becbeca91d6a45b4\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/actions.js\":\"71e1d50c5a3021e6\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/index.js\":\"119911639a6d9768\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/markdown.js\":\"c974dcca86fd77e7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/notes.js\":\"f0edca0d9628ae14\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/registry.js\":\"e6198dfac75b14b7\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/remark-timestamps.js\":\"1ef8add5251b13f8\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/video-player/view.js\":\"a2b9e46d67610e81\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-link-hints/LinkHints.js\":\"25259622404e7b92\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-link-hints/index.js\":\"396c3c30b7b3f5bc\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-link-hints/model.js\":\"23f8b15bb3d3fc46\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-link-hints/settings.js\":\"62896aeb09efc45b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-normal-mode/actions.js\":\"1b9b36c7d03f7c9f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-normal-mode/index.js\":\"2769c4ce25aa585f\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/vim-normal-mode/interactions.js\":\"1a6748bc4aaa092b\",\"/knowledge-medium/pr-preview/pr-1685/src/plugins/workspace-header/index.js\":\"ef5693dbc4433ed5\",\"/knowledge-medium/pr-preview/pr-1685/src/registerServiceWorker.js\":\"842b674ac10f6fb4\",\"/knowledge-medium/pr-preview/pr-1685/src/requestPersistentStorage.js\":\"1266871899ed832c\",\"/knowledge-medium/pr-preview/pr-1685/src/services/authRequestDeadline.js\":\"ea230f2c3866a526\",\"/knowledge-medium/pr-preview/pr-1685/src/services/authStorage.js\":\"aa6b368d220b70a0\",\"/knowledge-medium/pr-preview/pr-1685/src/services/powersync.js\":\"6daeab5ea5abfc4a\",\"/knowledge-medium/pr-preview/pr-1685/src/services/supabase.js\":\"9e5b77d382749e50\",\"/knowledge-medium/pr-preview/pr-1685/src/services/uploadErrorClassifier.js\":\"4af25e36e3a70664\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/ActiveContexts.js\":\"fbd1ed7c96299d61\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/HotkeyReconciler.js\":\"ff820c74453eb5f3\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/WipeLocalDataDialog.js\":\"94f5ad21b2bf8398\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/actionDispatch.js\":\"b9d7b73bf8a3d073\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/actionRefItems.js\":\"e05b40a6c24527a9\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/applyKeybindingOverrides.js\":\"3ea94c34c7981fa1\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/blockActions.js\":\"f03315fe87172489\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/blockMergeGesture.js\":\"648c2cb82de3e04e\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/canonicalizeChord.js\":\"1ba79f3654ca4ac5\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/defaultContexts.js\":\"0a86d09a69a3cc34\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/defaultShortcuts.js\":\"f1c50b0fc35cd7b6\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/effectiveActions.js\":\"44e4097545450ade\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/gestureAction.js\":\"a00bdb0fcb20c603\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/gestureBinding.js\":\"ee62643e2debb535\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/holdRegistry.js\":\"e3436d1b634c2954\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/keybindingConflicts.js\":\"9844c13fc333e3d4\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/keybindingOverrides.js\":\"b515ea1f28e962ea\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/pointerAction.js\":\"91a5620d2455a4d3\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/resolve.js\":\"f6ead7d3dce33328\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/runAction.js\":\"9da18fcc7466d454\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/sequenceMatcher.js\":\"aa9670f274ac37fc\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/types.js\":\"372642f7d932a8a3\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/useActionContext.js\":\"bdbbb43dc795104b\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/useActionDiscovery.js\":\"4967e1335681b4b4\",\"/knowledge-medium/pr-preview/pr-1685/src/shortcuts/utils.js\":\"839824a5539c8bc7\",\"/knowledge-medium/pr-preview/pr-1685/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1685/src/sw/bootStore.js\":\"d742876153432788\",\"/knowledge-medium/pr-preview/pr-1685/src/sw/previewDatabases.js\":\"bb0ae3ec668ade7c\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/byteTransform.js\":\"96c7a9b63d408543\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/attachmentCleaner.js\":\"ad37e1aca9049e1e\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/bundle/attachmentParts.js\":\"833f106882ba5b9a\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/bundle/bundleParts.js\":\"13e852a42effa792\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/bundle/bundleRecord.js\":\"d2ea752da9eda109\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/bundle/manifest.js\":\"a0ba3c3788116a44\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/bundle/takeBundle.js\":\"b87424124dd8a743\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/bundle/verifyBundle.js\":\"3668eb05d2978a15\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/cleaningStage.js\":\"1528c8407ca82209\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/conversionKey.js\":\"51a4a6dd36b44993\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/conversionServer.js\":\"efd010599b82914c\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/flip.js\":\"6c974e6d2856b871\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/flipAttempts.js\":\"f24e569adf6a8825\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/pages.js\":\"8ac8572a0851fb00\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/preflight.js\":\"1108abb5d00f5fc3\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/reseal.js\":\"5b93d81c95baecc9\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/runConversion.js\":\"6726ada3164c70ec\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/runLock.js\":\"8bfbcf62dd74f19c\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/sealing.js\":\"23fc12225038dcf5\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/sealingStage.js\":\"8439683f5eb7f3ce\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/stage.js\":\"f4580754d27cf62d\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/conversion/verifyReseal.js\":\"c6b9f377f65a1301\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/aad.js\":\"8d2737ae88e136b0\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/aead.js\":\"5073daf3e960775d\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/base32.js\":\"12c627e42b6a9863\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/base64url.js\":\"902538cf2a8508c1\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/binaryEnvelope.js\":\"5ac4c2c02bdc3c6e\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/byteAead.js\":\"7449ea531f33af9d\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/canary.js\":\"82da9daaf6762b3c\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/contentHash.js\":\"55c65b2028ff2231\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/contentKey.js\":\"97239202fb25268e\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/derivedIdNamespace.js\":\"ffc9cb5bda189371\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/envelope.js\":\"cf355ad59abd21ff\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/hex.js\":\"5b3d566d58f9d1da\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/sha256Hex.js\":\"508334442b000adc\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/crypto/workspaceKey.js\":\"9b11c7bef60b27ac\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/conversionState.js\":\"a3bfce864bfcdbef\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9b78c964a7018592\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/flows/pastedKey.js\":\"99048c4fbf61ac13\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"00faa3ee8ece2408\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ae3f1442daced9a0\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/keyStore.js\":\"dad476aecdfb71f4\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/mintWorkspaceKey.js\":\"bacea1f21cdfdfe8\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/modePin.js\":\"fe96161595a9eb18\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/openWorkspaceKeys.js\":\"9860dadedcb3dd30\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/resolveWorkspaceEntry.js\":\"1718d3ce102bcb03\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/resolver.js\":\"f7a8a5a06115786e\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/keys/workspaceAccess.js\":\"f453616b5ea3006d\",\"/knowledge-medium/pr-preview/pr-1685/src/sync/transform.js\":\"2c83a245441d3624\",\"/knowledge-medium/pr-preview/pr-1685/src/themeBootDefaults.js\":\"9ad47cf6e6a82414\",\"/knowledge-medium/pr-preview/pr-1685/src/types.js\":\"e48fa91fc88bd3ac\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/ClientLocalSettings.js\":\"0ec884093cd683bb\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/abortableSleep.js\":\"a0f2fa85c8294704\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/array.js\":\"597a3a68385f8b8b\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/backlinkAutocomplete.js\":\"9e1589b3461a92c2\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/blockCrumbs.js\":\"ad94c2922a35cf0c\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/blockrefAutocomplete.js\":\"2347882bc851d9e4\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/cadencedIdleJob.js\":\"938bb1ac3cf696d1\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/callbackSet.js\":\"33db699f60829d2f\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/clientId.js\":\"e7e598448cec47f5\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/codemirror.js\":\"86aad4eefad121ba\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/codemirrorCompletion.js\":\"56103e9b57b2db81\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/copy.js\":\"3ffa852e3f6780ff\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/dailyPage.js\":\"cfbcfed4b3b5624b\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/dbForensics.js\":\"15c7ae876d4fe8e9\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/dbForensicsHooks.js\":\"07d63a210330a0cc\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/deleteBlockThroughUi.js\":\"3f51edb63efedf91\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/dialogs.js\":\"41c23d23a3b455a8\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/dom.js\":\"37030015c6ee57cf\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/downloadBlob.js\":\"f6fba6135505895a\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/drawnWalk.js\":\"12849c9277246d53\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/exportSqliteDb.js\":\"116fc89e26bd0de7\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/fileSystemAccess.js\":\"d19f29cd0c463e1f\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/flipSlide.js\":\"cadbeb4ebb069714\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/fnv1a.js\":\"69436e0668084997\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/formatBytes.js\":\"e95f85266e175f4f\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/fuzzyRank.js\":\"84e496fdfaaf7a13\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/idbKeyedStore.js\":\"90cfd15da9e8b07c\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/idleCallbackPolyfill.js\":\"92891b22c88dd798\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/keyboardAwareScroll.js\":\"bbf59419390ab0ff\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/keyboardViewport.js\":\"0d33f4caf949d237\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/lastWorkspace.js\":\"c17653c36627ae5f\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/layoutColumns.js\":\"f5177f0a512643f8\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/layoutSessionDom.js\":\"ba5ed98909caa97e\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/layoutSessionId.js\":\"84e01c6d5fff5e0d\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/linkClickGestures.js\":\"7bfd1cf152bdaa06\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/linkTargetAutocomplete.js\":\"f96125578f6b656d\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/localDbCorruption.js\":\"aa31f07972368fcc\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/localDbRecovery.js\":\"5220d0322a3229b9\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/markdownParser.js\":\"9f9903c9f0c322de\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/memoize.js\":\"0a645108f8a79ea9\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/nameFieldCommit.js\":\"e4525ead140d7069\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/nameList.js\":\"5270cacdfe5667a1\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/navigation.js\":\"8befbd9502509ab2\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/omnilinerNamespace.js\":\"25604488cd53cae2\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/opfsPageScan.js\":\"aea7fa5691e84fb8\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/panelClearance.js\":\"8ce8662eb21366f9\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/panelHistory.js\":\"3c943a917f6936dc\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/panelLanes.js\":\"298cbb3895f162ab\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/panelLayoutProjection.js\":\"70bffe4a2aed150e\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/panelScrollAnchor.js\":\"d4237fed0581eaac\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/panelUrlFlags.js\":\"c86a10e446386688\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/platform.js\":\"8ec81b1ab3e82615\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/pluralize.js\":\"a9924604659fab86\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/propertyCreation.js\":\"c776e52d2b251511\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/propertyNavigation.js\":\"5866c6f6582f9ad8\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/propertyValueContext.js\":\"1f87932f557abb85\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/react.js\":\"36bd264d6c6368be\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/relativeDate.js\":\"5dba5938876aa930\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/relativeTime.js\":\"4ab26a8011eadd6f\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/renderScope.js\":\"76b4064510067f94\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/resolvedThenable.js\":\"97aacdec94204190\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/routing.js\":\"6c619edf8d55e465\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/safeMode.js\":\"0cd6a02748f25554\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/scheduleIdle.js\":\"ac58301ed1ce8397\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/screenWakeLock.js\":\"bcdace7130f4a887\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/selection.js\":\"98982c694ed7aac6\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/softKeyboardGrab.js\":\"cab0e36a69760624\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/startupTimeline.js\":\"312900e20eba4eac\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/state.js\":\"78aec149b4bfc68d\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/string.js\":\"44179701c65bf015\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/surfaceZoom.js\":\"c652cd86a6112156\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/time.js\":\"5917c3478cd52cb1\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/toast.js\":\"3da0197fd87474c3\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/toggleStore.js\":\"0858e5cc4edebc27\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/untilStopped.js\":\"56f51223198d2590\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/userActivity.js\":\"6ae893eab57e4cb6\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/viewTransition.js\":\"ab74bbdf3e2a62b3\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/viewport.js\":\"4d9fd0b407232ff5\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/webLock.js\":\"6d1ccd27d734f270\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/workspaceRecovery.js\":\"1e21ed31901ff85c\",\"/knowledge-medium/pr-preview/pr-1685/src/utils/workspaceSnapshotStore.js\":\"372e6e09857dc905\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-compiler-runtime.js\":\"c9c7e09e592c512a\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom-client.js\":\"f6b5e275bbb3e16c\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom-server-edge.js\":\"da4c43de29979caa\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom-server.js\":\"813a374378ba73bf\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom-static-edge.js\":\"920c0e4bbfd8ec06\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom-static.js\":\"f6033119bb0ba7ee\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom-test-utils.js\":\"4bc821d9f03bf06f\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-dom.js\":\"108ef1453b784a56\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react-jsx-runtime.js\":\"aa303f9c694e2b08\",\"/knowledge-medium/pr-preview/pr-1685/src/vendor/react.js\":\"6d9efbb45a5f3d72\",\"/knowledge-medium/pr-preview/pr-1685/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1685/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1685/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
