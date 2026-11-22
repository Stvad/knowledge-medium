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
		buildId: "79b0638c4d0a-d768df7e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"45d9cbbbbad5dc19\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"45d9cbbbbad5dc19\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-Be2qh85V.js\":\"5ae4f400f7d9eeae\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"72340148165b9baa\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-D6I4H6_O.js\":\"9e6b1d80bee08962\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-856cTW5z.js\":\"9264ca9b9fce52f5\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-DH1ULPyh.js\":\"d3e7a8799f91111c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-Cny7y6_0.js\":\"587bc4607749ad81\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-D4RcCVZj.js\":\"451a13a327016a79\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-Cl2k0rAO.js\":\"24211bb85b07e869\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-CYKlXB5a.js\":\"8ed9efb072c38681\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-Dr8ZFe0P.js\":\"213afba45e32ddec\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-B6WBCKZ6.js\":\"9c37da81b04cb9a9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BZWpHsZz.js\":\"8afa4cc755058b8b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Bl00-YSX.js\":\"65d7e9b106838502\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CdIRYf0f.js\":\"367c1aeb9b311e05\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CtZZ3Jpz.js\":\"aca500cc425b6fc9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Cyj3quBk.js\":\"6be3aac7e3becec0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DMKoT2zI.js\":\"6bf53bb03025f412\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DfkRsngR.js\":\"a569408aefaa1ec0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-NYFsjKeN.js\":\"53ef8876269b8661\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-DMgO3waX.js\":\"31fd60444050ea4f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-BpVYOrjJ.js\":\"e669f04ec1b23992\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-DDsJfQgw.js\":\"33a28fbf5d4939e8\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-DEpYfMOL.js\":\"15a01599eab84dd7\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-nY4Czkvl.js\":\"44a2478027b2d05e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-BeJLy8Ym.js\":\"1badbbff5285ba1d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"25d0d22dc04d33af\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"6e1aed4e24c34f6b\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"d4e849037739fb6a\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"af2b46493715a61c\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"8889cfcdf7c23247\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"b3561a5bd0e4f19b\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"045ceb1ac762d465\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"5affd34e7dde72bb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"3d80e9f7f66213fb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"0349e45949d67719\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"8049fa151761e5c9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"8babed71f33bdf94\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"83f64e697a55dc6c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"01b465acb50c78bc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"c9c935bca7a1716a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"b52dc71c8fdcce20\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"d4b85348791da521\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"f693d83ec904945c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"52995e98b0cea624\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"7724a7b6b25b536b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"92723b90c19a8292\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"340ee686901ec537\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"78675e084e5195fe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"05633afe70e135cf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"1ec7cfef015b91c5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"38ad0c1eb82bff91\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"0c8f464fe468b911\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"75a35aae7b87c2a5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"b5729f9b433d99c3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"c57c9b25da995371\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"594e247f9788417c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"fdbf8550ec0915b2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"5a1f4fc2c6e9a914\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"39dc7f42e69656c8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"c581c0a1aab296fa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"2c33f397ffcaf4a3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"1e3f53bcac4d9730\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"d55c29045604ea0a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"b8c8ec73bc55caf6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"140febf3fcd82626\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"bd20df0e32af2084\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"9858b179df06070e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"50390eb52c873784\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"11780108239930dc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"1473d3b71335b5f8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"363b886ff1ccc3e5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"24ed0e9d82af8d68\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"2a1ba1ee7de0fac6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"0f2e7c57c13228fd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"74d0a2a3501f93d4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"e2a51c61e848c9d9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"03f597a0dd5cc092\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"cbbfa48d23b7f101\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"8be6fbec2be46923\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"09785a90419ba47c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"5a0d31f5b3952929\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"5269ebd01d01be9a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"6f065e4af0b4b2ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"a9ab683880a03c4f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"777edcdc3c8c9b5c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"d2a27c7c5107f12d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7167ed6895e43776\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"cb1ff5c402c84299\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"160cc5e70a9dea46\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"1e7ab3ad12db918d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"d6bef45a4805309b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"eb9293db9ca5a645\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a6d60c365961268f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"7e9d9d0df049233f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"0f3297599f4fa61c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"4220288d56f0c4e1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"96e6214ebfe0008b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"dbdbdabe4cea5341\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"d865829b5499e7a8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"8ef035389a455b34\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"030bc8b8bffe3610\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"a72d4de89d8a17c0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"4564e00f354edced\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"caa211a776a3ce2d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"6bf3c8d2bc609ef0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"0d8456d19f28de80\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"7cc60c854d732abb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"f309d771921ede16\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"763da9dab69c5272\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"d9aeb9a468a3b4a9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"8402a799add6d4e1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"294dc68a4ab253f8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"94fb7050e110bf84\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"fa1a36a489ab7ad8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"efca7532519964ed\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"2ff7be23c9e88020\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"d645d2b7849831fb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"61290e869d28a74a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"ed7c8167676f5027\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"9fd60a87c8212238\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"2a9b91167d9b8e76\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"d7f6c8dbefac5866\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"4845dc8b5ca8e660\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"0d614cdc1ce17704\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"28908365333b18ad\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"2d549b4f5be52f64\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"b72f968607d02c89\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"372f01fe2a1dbd30\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"fb2ce1cd15502d82\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"6e7ed518105925f5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"5a1f7e9a7585b77e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"57fa33de52061cef\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"8fd39baa525273c1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"e36da0e451b5e2c8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"56e39bc45b336bdc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a6abfec0df4eabda\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"8b86cb9a2022d920\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"d5f47124daf96722\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"0fe07f33541cda90\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"c8e305f57d8e7db6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"bfcc33e1abff5ecf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"3b3aaa62b9a317dc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"1d133be4a0d86d3f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"62cd4e75276d1b8f\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"8417909db5711293\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"8de2a4a3b80314a6\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"9f6289df1b7584d9\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"e1aa900a63a3e66e\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"5934207c839706db\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"065f89c35fb74156\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"967e6936ce06900f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"327eb7fd1a5ed344\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"45609b42b99faf63\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"68df98b285b0e22b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"e2be6e5d5f1a402a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"f9c280cffd836170\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"77398e725c263178\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"7ad04b6b4af84b8c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"e79474634458f25a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"47573253840dd765\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"0ff72d184121593d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"e6ee149cd7c17257\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"866bfe2516e2a6e9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"33eed6dc8d3a6e93\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"df6b78b827447875\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"e79474634458f25a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"e79474634458f25a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"3ccef5aedb03226b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"71744ed4489482b3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"a077a7f02b0ba3f3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"674759c6b0663bc9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"a59eba5448170fe8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"910efb1bc32af39b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"c80341d7c952c4d3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"a894af566803b93a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"bcd85b7ed9a9c498\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"1b5411843b944cd1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"d955e588f444acad\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"a889f3fac843e6e1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"d368ef4eafb9f90d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"5e31c4b73cdeedde\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"2fb2bef650cf5e1e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"56f8cca711713a75\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"a9785a0ad0c74459\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"7203fe6e8d14ad30\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"d256f87d644cc9a0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"f5e1511e141f4ba9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"b78ad45dc49a8af2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"06ac955dacd86662\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"6c537a4687cb6bc1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"327325bdc190aa71\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"a87f40ab180096f2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"1f63557d05c5736e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"b99f61452f05788f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"5543e12560c53b84\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"5686d91026d86b85\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"01bfe70d3ea24345\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"72eaf5d634817134\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"301217d3b403b686\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"1ee3e5530b2657d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"884c542f770197f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"158063acadf159ee\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"2f6f2b3486376dcb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"b3aa5910e3c07d7c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"e73b2d83838813cc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"0acc504ecdcaec7f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"57dfaf38413cc3c3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"867c1f814c640ff7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"18b5750c1278ab8a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"8423906f78fb10df\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"fa31d480f7cab13d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"88e939b3b35b2a34\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3c2e3f92320b5730\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"411c289178b8573a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"b11a99deac9926ad\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"2a61ec5845364108\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"3303fb574c3848da\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"780fd679ab63b232\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"bde3c6b21228c4b2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"f150d59653171899\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"5a573279badc5861\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"1bd7638f84035186\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"133b384616641a96\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"f5af827ad26582df\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f661a56e3ac8c6ed\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"975e8481b95dc83d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"0c94fddf5bcaa4e9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"6f405e726e1b4a1f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"a984de07e6bb55f4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"7bf692dee0500fa7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"51680ba3ff6c952f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"7d69ecb789be0553\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"4d0645fb926f0b3a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"150800eb5d741afa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"5f2c4e64c91972c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"bdf629c743bfff1f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"67dd1a533f550a57\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"bea2b8880c79b1eb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"e007e5b2e49718f9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"8ef3629fdee4729d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"0bdcea886a14fd58\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"aa46ef1fe93cfcaa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"cfc01b46e569bc27\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"e2678edd8b315539\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"87a449f8e128a48c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"61128b8817330afb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"ae799ba868c80ac2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"f951f9abc0a38c55\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"f569dbe6a7db8ec6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"d87ca5af8b2a2c9f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"777397ed8834c59e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"7917f6baa97891e3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"dc2d4fea333efbf5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"aa0a84f7d05be733\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"6ed89e216b328066\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"b32ad6f8eeddca6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"2c7a296107363796\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"108e86eebfd521f3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"0583c8f1a7718b76\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"d508aff5c0e3615d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"939e93a0df4b1a1c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"7418d38fee017944\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"5b2e26f76f614668\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"2b547bfeccc72c9e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"9aef93a42e302cc7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"4b255e24830c0840\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"3134aeeda2a758f4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"30ae7891b3ec4e9b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"0f99c716df9a9728\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"7d5fbafa0cf0ddb1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"928a05fbd820f7a8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"f2554f340487fba7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"4377527d19871a88\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"96c1682c9bb3e84c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"23262cc8760b5aa8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"2be8a7b1721d2c84\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"17ce810b739eaf1a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"430111ff63d0df60\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"5dbd6c4128d06345\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"fda3aa6b71e4ee90\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"a4cf537a67de2bd3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"645c21d148b5679c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"8c5648797e290e0c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"5299d39c7d4d158a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"02d7db8b915aca84\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"037a37874990f3bb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"9b02e9c9cea05d3f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"e35ca53e00ffe0d1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"420b35403f30d2ac\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"65dc148e24f82f81\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"7e9cf41ec583e7d0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"8bb3ce446bbf930b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"e8f85b505c4fc564\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"967ffd23713fdcbd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"e03f4f5b6df26b44\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"ba7e905e78a2d03b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"b11d6afdf80a5cb8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"438a71e41e19045e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"fa872b891fa40d29\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"52dbf1e2aefa6bff\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"55d7edc6fec57c23\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"2867f80b3b63571f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"9e0669707057da13\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"4702823854a7f689\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"8788c685481cf256\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"d61500203bee57e7\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"fe0dcf0570a5e332\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"958c51a88f4f559b\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"900eee052f10ad52\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"d27cfee2f569c3a9\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"2226d2c6054a2c7d\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"505e505531f36bbf\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"501282917b1b246e\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"12973a829e01f393\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"11f09fc07b25e733\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"3f1e66a1a9eba516\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"34179be14cda5592\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"31fc12e3fc5b5826\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"941d334d1a741819\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"926f5a1930256d48\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"403fdba59027bda9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"621e43fc3bea7415\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"ef56f73153156bb9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"318b541876c54e51\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"6fe3a7e0ee3ac5f1\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"d45a664192ec8587\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"e6bd60fe45d27f45\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"5c91c50e5a9e9bc4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"2161693eda42960d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"61c79ee96ea3d65c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"c7ec40724ed2bf88\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"ecd4e0796d6e4940\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"1665a9de8463a4b3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"60a07abbe024f2d7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"dc805a142fada91f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"09e395ef99789fce\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"dce5245e410736f4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"021d6c4c69995803\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"bb9abeb214e44534\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"d3180f859d663128\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"4170f0672b85e88b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"4d24fd4e811107c9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"f3e56dcff74dbe4a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"50071cda43526c23\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"4c3f16a5b1122583\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"d0132c544a71b9ac\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"e177d5f2481ce5c2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"f557e7a71152bea6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"ae3e6e1990420c34\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"97bb7eb4e979a414\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"7d86a9ff54e19263\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"207737f60f5d83b6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"ae6d4b3bf3b536cf\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"db8fb7cc401ca364\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"045e78e98989912c\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"a338a7d638814d4e\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"6eadb15f2f57a7c3\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"f865aa2fd98b439a\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"ec10cbae73ae049b\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"6a70c21a62f5ae47\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"6388c814aa981f3e\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"862940581387f01c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"ad1878eb015e8e3d\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"0921e968b76482b1\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"0151636abf12dde0\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"b91ede6738df4b13\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"5938508d2ab310b4\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"3817b0ecae351947\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"37fe2fca58ee8828\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"c0f6deaaf62575f6\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"48c74205aa6e44b4\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"1642a4c4c46fef1a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"c42578f0f2c8eab3\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"0d98b3b80e5a4648\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"18b4be32f52a062a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"15fcfe04a9979df4\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"3f7ce3a9cdbbaff4\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"1c2244fbb41a2f73\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"bc71aaeb5ba886c9\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"d49c90fdb91b6052\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"952fbd5b4421fc66\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"75b2f05e18a661fe\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"1aa472772dcdd0ff\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"aaa657b59ef243e2\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"fd3c768988cfe014\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"47b17519e15cf626\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"c0c0de975d851083\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"7a907cf7a0917aba\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"db06c5b1bf5d3099\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"cb45096e5273aaa6\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"051e02c140148e5d\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"55eb9c057e9600f8\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"164e5e338101b1d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"6d618e603cf10a26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"ab91c816aa52cb65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a2e51ff18aa5f5e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"c346b4458c23e6a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"5d1b16ab1f7c4acb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b0dd8b51e27ee8f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"a993483d0edc273c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fe0d7f67c790d72f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"0fce89b18df848b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"63c4dd5bd0db0798\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"1c9756e7177a8845\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"04f455d6ff345db2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3f767d943b3c1d90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"0ea9251adfe6f696\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7973bde1a759bbdc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"11639209bb5f9929\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"4a79bfcb23d9e6f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fc17db78de5f4c00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"104641901669babd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"ebf403fe134372b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"a10be183664f029c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"49510026259df949\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f9de38c9c2880fcf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"162fd3c7a03b1dfd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"5475919c733c2b7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8b5c7c9e9acf26fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"f8ee6bfd23ff3da0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"5182b06c310f36be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"58a55fd76a6d1198\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"403fe1beae352cac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"0b58a5a2718c3e42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"a3f78cadfbf59b90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"6aad0127bbe21a22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"eccbdba04332c116\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"0859f888d5145d5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"3683f4c7cd282d90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"04a02441bed047f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"8f49b661937adfc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"22b03a11734c5180\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"e7d9d14eee8a00e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"e7b936900ccf8eff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"4160986d9e22bc2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"e53af5ae14257cdb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0a365a36043be094\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"b56833e6b4b1a64b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"5bf4062fe898cbc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"7f0a821b6281f3c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"24f3f9130958ea48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"7954f1ae7cf08622\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"74c6c226ae306185\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"621fb20b7df3f619\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"951fb8199074b34d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"9b6051399635400b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"8d47ce443d263a2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"253b5bc14778b60e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"928ad25180193122\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"4939c0497c3c7ed4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"1a56536bc34af39a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"b710609bdd8a7eef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"67a9d7ebb3525549\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"3201850430080636\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"1a2513d970c1e695\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"28f02446a491361f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"e30d995415fcdf16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"1f00d0b34a110648\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"c2081818e88c0bdc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"4c16cb201cd2b7a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"4173ea9bc4209fbd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"3c9ab96dd093c93a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"ee2e1c9a71c4b7fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"f4562eaac6f942a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"343d0f5e5b1ffeb0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"5cfd21f6711c73c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"82752d9d10bcea5d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"04cce57484ff6ec3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"636966bea4b4de58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"24da3188adb7f2bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"04a48ed0f021f56c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"8ef6faaf1dfa1d4b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"2641a476a5e17719\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"94cc6b034801927f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"2f5be10464fd2033\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"61d7536a9f31c2e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"e295cd3b55d6419b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"aa1a09d4476287a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"1b7c6bc2c0c80c45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"687bfe0dbc421c16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"c41e1c1fc9a29d79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"c143a33200e3cdb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"0f81800203e398b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"2f6b102d4bbf3ffe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"6f74c215111f6f5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"c8c6aab2c0eb9978\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"b705251833d9fc15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"097df616575ce4e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"8065aa2f2847fab2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"ab665067070243f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"e44507db1777b51b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"a4b50197484e7ef4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"badbf56d8abe9e0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"0ecae1db4b41d591\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"e3ab20abbf31b673\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"a8797ce61c89ca63\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"87ab03ce13522062\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7ab4dbd50344fb5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"169f91e13a1f39fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"edee0edec53746c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"51527234221f6850\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"6875abf1b0abcf75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"98afd5cafcf0efe7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"3d30cdbaedfcb3fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"d811186e3b3dc016\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a16766c16211e8ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"e348891de7b68a86\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"caf2af3ed63abd6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"6153aad3b44357fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"32beedca1fab271d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"13713ceea168904d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"5a9320cbdceacd8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"440a52e4f9e0e228\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"c9cb3f66645ec7f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"eab99c42967fedca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"578c634eb5df7853\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"95dc41283fd78056\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"7ae8e7e917e027cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"34def3303ad92cb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"423da6f646ada0a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"31e98d33876f5418\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"2eb1379fad6404b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"dd5bb346742e6491\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"0108c9e40587d397\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"95044b2557dbb0e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"4e2bb8d39bbd3b18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"3e03a34f82e0681f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"515a1a9c72acc8df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"b8ae62f04b7c4470\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"43e2082331bea063\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"729c5f5837b7e5e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"9116ead231d8cc12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"e37117e72982bd4c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"cb8648ade45ed104\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"98e50368e6b285a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"ca6562948c5c94bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8c4652e6a5573e47\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"e7ccf0caab82f041\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"e3499d89c562ce62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d05ad5ee92a8dea7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"99855c3c42068f03\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"794a8635893825d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"727ab3de85bd0eb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"91c0c5a94697ed13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"468212fab10be57b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b6e80e6ce461125c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"969d707deba0691c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"78b80338dc07cafd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ac7ccec7be56273b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"2827ff425808a10e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"55cd16d5732dc452\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"b8ba26c94e8fa7e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"6c61aed1ccdad575\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"2d2138a2282a3ff5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"3df57b3f134c42ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"0a4810cb252c872b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"67f41eb1a95991c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"9a58d41b949e2aa0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"f724e999aa9570a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"327ae6972bef13ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"bd1805ecd47b5683\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"c0a3cccad5684708\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"f143ab0d70c5c278\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"3da5b177275162d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"6aea8978dfc62948\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"b4111fbc62b8367f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"517183ad30a07644\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"455186fafacbe2a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"ac97ea6500c0f902\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"1491322920e008c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"262a1ec9b74d4f88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"250a2cd4c2f9c175\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"0f9e7011afa8821e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"cc03e79942b4ccf0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"44fe558dddc90da7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"12f747c514272e76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"458a10d2e26979f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"bbf9f1d05d18e058\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"adf5a1e6c1aea0c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"cc650354c5016ec3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"45e2a6f55d4fddc7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"00f9b644495da6d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6bba1e3381d64a1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3e24b16976e2ae96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b0515be8993f5aa8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"68a0c606459a0ef0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"765e44379577fe54\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"92ae390494b7f8b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"b206691f99c51764\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c4ed7d9a5fb6f93a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"388bf770a268c5fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"0bbcc989b5d3c257\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"295082675ccfdbc9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"c7ce8f7b5073e1fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"43d6e34870a356b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"551209032acba96b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"bf91fb30b432b107\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"d497a718ebdf3f13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"b5cf87f4759e01d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"d9f0861b4802d17d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"c594ebb875188771\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"2918ebf373d1ff57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"84df3549d63e4754\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"e426007e534188c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"c7433965ed0fedb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"08a5913acc1fc704\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"525b510032f52529\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"973a8282ff9d2761\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"07e71cb75c5b6245\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"065ca77a8f7e48d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"a73cd6e7e92b54a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"a96d61ecfa101f15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"ad89c357a6362d75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"ddaea334153f1435\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"df2a1ff5cbacac70\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"b243beff15b817f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7c7ff85ee3db3371\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0410a35fbfe6ede1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"c72e4d7a9aeebf31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"db50623a6e2a294a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"381e13b683e32b1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"3b86e97b428279fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"9673ee8d3d0b2585\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"60ca2c33646e30f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"c8cf1733ea00a14a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"33e30ed8f2b8b8d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"1e5defcfd8d9c0e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"0602448a4c3b24fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8944801b0cdfe575\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"1a71665a5ba3e5b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"b6d3eaadf896b30a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"72a5155361352639\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"4035cb5b66e9f70d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"8f936b186679536d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"385fa8de4e1e0ea6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"44753132871b81e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6e1eeefa5799ecbe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9ac134ddaead5350\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"6a79192a49021ece\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"559a785788cdd935\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"8d3dba03643136d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"f6cbeb1108735457\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"92b8861579a02142\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"e5d1700d7fddb3df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"66819eec54d239c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"e8384d53b792c6e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"21365eaf6432af6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"298d621e26a20631\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"33eae2b37634251d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"135aa5b8ab4df4af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"2a309af555cec208\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"a3d16e304cdf9541\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"550a2a80f738f359\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"428e5515c7c14ae5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"353313d3b44e2c88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"5fb0ab91af65708c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"2ccb33b9298bded3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ecfb0dfd01a9e78f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"2ee7bb766c608b8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"90d6fba3bb25d3c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"0dd92687d3b2f62e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"cf9633b8d7b004b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"93e84032cc1315ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"6e38fcafdb47af05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"d6aada542d40c5f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2efe8d7b1c989395\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"bae9d94c113d47f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"d1a08919e7cef119\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"f0b20a7480973f0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"ecefeed8b985d5b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"c82c68a8f9709e49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"9660686d9b35c4c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"bde2447e21fc2807\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"d9112fae885df006\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"5bd412b1b0e56586\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"9aea82604e08a72b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"4363b2b80d5840c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"4f7a6f1f76beb311\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"8f5b1126b98055cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"1f1e512c97ea0c03\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"1f43e51db1a650d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"54103f7c4d461b49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"247ef01f11358af0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"1609d19ff7abd70d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"31ecf1b0299a1ba8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"cc2c5d666c8373b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4b8ee40dd94361b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"81e39785b496334e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"887dc9bf76936b62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"ed19bcb6a6116e6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"32f92efa1f171961\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"4a43b987c3dd87d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"132baaa9c503bcc5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"817b65cbba3c10d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"7914fc9dfba33050\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aa3fbfc74b78ee0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"7ff04c7c1c6d833a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"45ec9fc09ed930c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"e6b336231b12843b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"639298d2ac583228\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"009d70f4629b6b8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"9b7ad8eff20af89b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"c5664ea88364857e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"aec0e25a81623861\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"eeefb566cc1da040\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"210c55a9dc094e44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"155b192fe48bf73f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"e0ca47fc316fb556\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"f8161d498becc9c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"5908b44e656615b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"97fb8be4d79a55a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"797ea8d7bb229ded\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"e4d1b2236bcc8ae2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"d3043887a44f541b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"925ca75d62f90703\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"073b95778cd4d32b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"826be1b14540d3fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"ab59d35175c5514d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"3c93309a25da31a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"54461a15f3db59d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"628cc4da390dd11d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"fb08d0fee8c252c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"ff200ca11466af3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"2c650eb2f97f323c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d662afb0bda62232\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e5bf289d8ac03192\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a75385db7ba23c23\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"ba06d30ff184fb4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"a54b4a1e81d6d1c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"8018382e8628ed4d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"f225b58e83cf3c0c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"488a8426b1efeb1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f53aff5edb9e3263\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"a3e68f970c9907b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"a70e20461bfa8b2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bb32af68c8b7256d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3bf64ef704092042\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"019da17e068e64fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"5f6eafef5cf7140d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"4d2d17db1eae5460\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"8ea8a69ab42e37ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"d65d22ccd98edd32\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"cc5cefb967e60a78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"85edc2cf878f7030\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"59902240045f529c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"6acfcbc7dd56a77a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"5aa656d2d3db6ecb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"ca0131384f096ad0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"5a1f4cce9fca4756\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"700e289df8799983\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"fdb2571931f43e89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"0c042490afc5a571\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"06d1a53ded4fc05b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"bcaf7151856fb845\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"e470590c0f02611e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"ee0b411ccca16b5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"669784e67bbdac46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ab053e2a1a63d0db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"8e78b412a0bb8acb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"cf00b9cd5b802e85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"739f15899db930be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"5247725ec35e714f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"ced9204c299c6164\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"85e180abfa541a87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"92114cef63a09e3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c6569c08e9212b7c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"75ed596785e1cfa5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"b865f6b04f8f60a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"0c140340855ebdd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"c6c03c5c75c9f601\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"e8b0e92310f906d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"1a2ef05366526e73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"7ba9df7fd6b90551\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"8ffff0f1127a6df9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"128c55f10419a789\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"557f2ccdc8a720a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"7d093476442c23a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"bdcea03d9a97d72d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"4d74b4ffefd9e400\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c85f1d07a18ed54a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"747c1ffd9fa40116\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"8471829431980016\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6140d29a09bc0706\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3bfd797f33f179d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"339c26d46fa03516\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8e61836de2fcdfa3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"6c48dbffce158955\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3ce2195a1fcfd69b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b3b13b0025245f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"1af70265c3036b13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"fb8f241f8140839c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"1477e052f7a7cf6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"da148d63c831adec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"112a25f360e24326\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"b39d6ca9bd04d04e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"fa0e0afd082c3046\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"ac2096c82b41782a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"7aeac4d4da5b662f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"d7467d8ace699990\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"ed69beaf20ce9912\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"2df3890786ba5015\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"a841d9e4817e59b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"d5ec92eabcedcb63\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"317a13184abde683\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"0c22656fd9355d8a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"a3797cd0d24b81b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"640fe6ff5b921949\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"9f582f139110776c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"72dcc6a5ad5ee715\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"bd0b64ea76ab60d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"5aa7d2c0d67657cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"8ae43d2e918e1e53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"92f52b4e538e1add\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"03a5de9cdf322ae0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"afa2b8a486a0c404\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"4f9d476be32c48bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"f179d4c725ef4b90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"54b9ea4f45c63dda\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"46a2d604cba23b09\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"d797d1a8740bf895\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"a017c7e381bc7e13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"95cfb1200ac140b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"edc82dea0b4e9ace\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"b6f01f45ede7e6dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"f4ef153cde00c41a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"108bc006b841c96a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"e09d6f6d5d01a22d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"3ebf5ecf37f173f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"8fa9b3a4a54639c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"9e20990f96abcc07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"ae4c86a70cd0f249\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"3e149046ed3ac275\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"fe2277d0a2dd4777\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"77d9d50ec2bf9bc6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"7f626c3a339bef56\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"af75cc831a4698ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"8a34b655a94475e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"26c3ef2a9ab694b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"43400eff53c76dbf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"7a512bf5776680c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"002a0cba7e01f0e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"4df020d480297f2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"0f2358fcac18c036\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d260552c5f8d02cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"45cb8f757628c1b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"b1331cc7e38e1464\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"888dda6d48a96303\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"08060effc20f4b34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"a2f86df3b1f7ed90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"142ceeb6f0476dc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"573f997d9e25fb95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"935fc7faf64b7a94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"b04a3290a44d33c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"6ca2667647d01afa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"79b6c9c0579ae37b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"341d8901298b0fd8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"9548d1b99784a7e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"addb9fcc96597047\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8462ff566f866bf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b6e5af7f25c63285\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"a0be6cbf9defdaf7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c1a893d8029adb7b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"37f8725a5c55cb20\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"f4c8171495490008\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"dfe6222d6a725115\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"b9afb2bd270cf110\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"556c8af784a75ef0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"3ec8371752fc24bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"432f08cc1b2fe00f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"a35029fa4bdcb38c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"086a7e8c1c53bfd0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"3339ff334486bec3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6616ea326af5a450\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"9a78f48a19351968\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"5c2854e58aecaaf2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"4448f41eafd00f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"194120f015e3337a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"c5b3c44b122ec4bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"ff24f0e03be44050\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"04e937d9d3784b1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"4328ee38089c91e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"a67f68c925dbf3f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"1cedfd95072c50c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"297717b72ebe2eca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"a6dfeb6c8ad98888\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"d21d496f02a80a1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"31ff110f84ef14d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"55062a471db7af4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"7dc3652586c87e6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"60e46d5cdd0b3125\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"fdd6ff73df3cf5ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"e327fd934ca5269b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"277d55e70baf46a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"adcde2a0b7885631\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"fd223226d44de73e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"0bcbf79368bbdfa9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"c06a2498646763c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9bb9834aeff52fbe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"80226c00e8f5c921\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"b66a2c89b4fae6dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"b7d60ae3400146b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"b478a69c8385bff4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"902b63f993fc5b3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"4cf5d0581798aaa8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"44555e0d1ef3c9cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e2e419c6c02ed77a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"7518f390861654bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"d15ad8f18150ca9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"7bbdd22548591116\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"adf8e586ff35747f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f844019a752a613d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"2c765411c28c2c33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"3091eb04114259a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"7136048b3f64159c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"e86c479e23886757\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"da659890a1497ff2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"cbe8ff83beea960d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"c98c5a5d3e0868a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f6dc296de31bbaeb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"08a3dbac2cd57808\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6b63ea3e7842f415\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"84b4c65beddc3d78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"47f22391b15c4e49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"4179411d52cc8cf5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"374615bae334d961\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"b2e06d15013753dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"d886ca737382458d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"bbb0b3dfdaf4a339\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"395d7ef3cb9f9767\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"80dfea2eb90b6f30\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"19784e5a751147ae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"20ec9bedfdae81e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"ac7570d18c1b9a92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"739dc7b413b027a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"5d9ad6ac6cc0806e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"354f71a8359be786\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"bcc929c93cbc54a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"dfc551a5eb9c1a66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"5ab67ee221d659f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"66eee29370889286\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"f0bea24890ff7bb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"9096e6b4173ae931\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"6cdcc2ae8fd8822d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"e2ab0c2017500adc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"8e071e1134c92356\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"18057cc1943ad193\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"721ae67e8040ce79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1ced27f2833da15d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"94a928e261fe42f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"986dd939f33dede6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"2b461d09370b9a1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"d4beb41ea83c0421\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"de9a476dcf05f9d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e01428e218b610ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"b8991a81abd44b04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"4f3be364f5d11f4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"9d741ef168f84204\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"a0a6e9e2e0002e1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"aa477251f0f415b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"9cee7700ba877e9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"4b98ef234aa9b46f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"4812bbf34c5f1d7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"20286de76b3b46f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"ea0cbdc50c777004\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"750a078fb24c210c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"eb00bd54a78dc9da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"1e97f6566e6dcc71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"695c31e2191169d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"71530c28b23f1f23\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"c3122c4d2fb60bc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"55f1b1c4f8809042\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"98ed066aa96c1db5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"af06c1f5010146b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"a23bd67a9febd082\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"9286a27f3b82ac91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"21725ecf5a85ff1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"8259e33cdf70fa0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/navigation.js\":\"387a3e21b71dd803\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"2bced2f8d55f4df4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"52a84e2130731d8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"f02554c2711f2ae3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"212163da5ebe0b6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"9344a7a9b8c3d7b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"12aa6f9d83617a2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"f10c839493df4e6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"484592bfac88162b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"466079816619f181\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"d01f32365fb4fdfe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"e1370ec32bd054c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"c329e1718adfd27c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"6ad351832eb0b6c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"7646a9fc830116e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"d86492f5186f4c02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"5f8f77109375c724\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"99ce631172d2dd5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"ba9a0a859e1c95f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e4e960d2767ee93a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"75a31bbaed1ad8bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"71d96c4cbd3aa865\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"425e62d95f875151\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"97977104ec489706\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"a16968157da2332d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"6d520abab35fd5d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"762fa1b605cbe7fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"467476c56e75d872\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"6037a914fb373a0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"0def4137ca8a6a0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"86715b2e354b2deb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"07be61fa6011be99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"c9bf98e4e6e10e7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"ecbfc01aef803770\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"f946fd9953ea21f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"5858528714e8073c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"32bba37df969c594\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"d56122e6b2070a3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"961c6c40d4bbf519\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"46f72eedaf4b128e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"3892b5100ba561b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"c77ab7384fed363d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"7583a6c9606a5ffc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"eec8196311c54284\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"957056962428e70d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"d16a20680af74358\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"f02384aa0b14feab\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"3fc2287280fb46fe\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"853e91993a25e57b\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"7dc7d1fd1470925d\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"79ed7dcf00bdab31\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"fe0af4eeb13fceb9\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"0df8d51c2bda6f1b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"c907f606e165965a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"430a690176ed855a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"a26d03d4a3bec78f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"a90028dffdff512f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"c4dd1cdbe32e3618\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"5524316dbfa0ecdd\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"8c358e69deb32669\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"871936ef96ba4452\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"c3eed1360977752d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"dba6ce089108d689\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"720958c12d5b8b2e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"5b52871605cc00f0\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"20adb86ea5f9ac65\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"37736ecc8237666a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"98c34846950d1f24\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"8f687b2f68d3e39f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"8c3190cba53b6476\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"688b9e1d829bc131\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"555b3f169ddf565a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"9c463fb252583119\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"649bb72a04b7e01a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"4b9cf93f2d630fa9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"283c358788ada292\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"8d605da8aa847e45\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"fc47dd4bb3be47e3\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"7b80c18f23eb766e\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"c3e9585dcfce36b6\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"de017d5382db608c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"0faae8cbb6d36426\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"7f8ee2a673c8c7bb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"68d0ba25200de7d8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"4096c1708cf53bfa\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"66f1aa242c3ff05c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"04fe1988fe5734b9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"0acbc464fed35894\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"dbbdd7301e12de4f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"f84725bee91f46f9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"b726b03c7549c039\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"c048634cd5684f84\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"c5884a4acdbc9bac\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"6b0b0c646e1de347\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"5eb0d9930b575003\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"d132563c8f515053\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"8e8a1623d4fbfa49\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"fc9b67ff0d471370\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"3742e4d18e75e185\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"6f5308c7c94d77f5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"e7ded87d5bd8007a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"6152ff53a5b21143\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"eb9ac78101ad76f9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"3e96fb28488de096\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"fab34b9b7a540ba3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"30a25f04926a3d77\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"8d0716ade7bc7dca\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"f8b22ab5b5a70fab\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"a78915d71fb1f08a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"c7773a95fa134984\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"eadedfdbf8566396\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"79bc2e5938f7162f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"750ef6b771c18620\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"51cf3356ce903617\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"f1997d67da528091\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"18e01b67a85fb04d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"3e9b89250c6ab165\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ebeb2544fd49a77a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"350a36b0aca9bc1b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9e1062b259952610\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"12e38d6225edd70d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"7e54fd13e4ca4a3f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"cc190016fa512f18\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"224f5e846ea5742f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"b865f1c457c951e5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"2484b5d5cc4d0175\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"cc50b6ebd5271ec1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"94032ee32904251f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"e88c23d02afc3474\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"5e8d2b9fbe6bd1c7\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"d3bd392fc83261eb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"f52407fe6c32d414\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"d9df34ce8b218c06\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"2c011fa554d95515\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"d593c89e6028e902\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"a4a1370ef5a2bf54\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"f1497cf2385bdcc1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"22557f7368a2a9e0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"bad7c5bec484e254\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"56ac27c64d0efdaa\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"5f6d10d98c37ccea\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"28292c305110416d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"a747a59b7421eeed\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"cecf98c3aafc92be\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"6c727c50ebd4951c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"05d3f89b95c73174\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"83c0c673bf14ca79\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"71e24f45cca06e39\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"4ac1a1578c43b19d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"0b20ff745cdbaff2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"9e743e880ef9e75c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"4642d1e90e873a58\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"9df19aba1e9581c3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"02c72a8e2eb703b5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"b0ab039ad8d1aea3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"6bf85b82b5820f81\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"d2f6b57a85ca295f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"526b5a6786a980dd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"97122c1a24fdf63b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"e7f842f821932631\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"68b24b5728ee2813\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"cad19319bb4bb3b0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"0cd2bed08b2ac961\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"f4e97cfd438ebe84\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"d48804e7168ca3cb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"7409684a59914a95\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"cba2286e43d67d7c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"bfc5ee1e13f6064d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"2cc2722d1704ba35\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"a623d88f456f3aae\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"f858fa6b50f7f5d4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"8ad1e32c78cbbfec\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"798a781637a3a930\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"e85e6d4e506a6689\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"61c577584bfc48d3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"276e09df8e00b2a0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"a6acc8afac9f1da4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"770076a7d346b177\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"434ec4d21488305c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"0ee9e1a19eb5c8bd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"a03cf1f2da5de737\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"59c4f6b05af55304\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"562dbac70d99e420\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"d2f0dd6bb14d11a5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"bbac8ab7c3f04df2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"7cd4ed83dfcf7680\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"219b3e3f805c067e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"99baa354080b381d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"e72443bafaf95c88\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"1bf7ef8ab0574568\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"cef47f47a4c0f4d6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"8a484f7ecdc5bc2d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"465d1e44576b6e52\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"8d475711c16b2dfe\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"06f80e632c4b4b50\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"e69efa6bc6cca8ed\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"30212eff056851e0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"e61efd54064915a6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"57ab929339006d5e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"6eaadf78bc660340\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"64fc96f7d929abdb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"3c328eb063db5c76\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"bfa1997d8bee1914\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"effa29a61ef96ebc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"83fa5e99467a87ab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"27007954c8e1c034\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"091a135992d59221\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"6971b18e95facacd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"12fd552a127a7132\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"8a7681afb6ded655\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"65cef095eaa8f38c\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"d4b449ba0944f9ca\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"518f8a64809c7ee5\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"67c737b351315f28\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"9182fe977f9cd186\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"15c5ad46a5cf0321\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"57aa73c30182f2be\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"b44dfed4f3461396\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"7a50b807cb8fcca3\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"d7f39b03d31188ee\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"4ae45fb290994379\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
