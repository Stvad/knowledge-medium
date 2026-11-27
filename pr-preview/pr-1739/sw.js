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
		buildId: "958070437aac-d9b33898",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"716489e857c84e5b\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"716489e857c84e5b\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-t43GXSR8.js\":\"76077ae2d598cf7d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"c5aca41cb052f5f9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-kXxac_-5.js\":\"f2f4339ebac18751\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-Cpbje_HC.js\":\"731eea8cfbc20f36\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-BIs4mZMj.js\":\"de65a3d441f3d56b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-3KbKlOg6.js\":\"ac5e99150f304d6a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-yxQF1z2h.js\":\"d2d835c9b0e62ae0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-BA_qlwfR.js\":\"adbdca7708e49c49\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-DTkNTzdq.js\":\"2aec4076205a4a70\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-DRAkQpmk.js\":\"0b0b747c4f256608\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-B6bQp9sZ.js\":\"cd2e19b4abc04fa3\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-2C5CH3Rv.js\":\"ca9a591448edcb30\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-6o9_u14Y.js\":\"512004616f3fedec\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-7-1Hy31_.js\":\"5aeecb69cda64fc5\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-B3uMejgn.js\":\"fdd019c6fb90f9a5\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CqDs4Iv3.js\":\"152420c7e5955024\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Da7yBIwV.js\":\"c27dad6ee1d0d1c0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DmDGXpvU.js\":\"66cf7eebebda0e05\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-BTabbmU2.js\":\"f19c3a1687ebf140\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-B6IANP-s.js\":\"8880fb95733ea870\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-CFCVUMyI.js\":\"f311d48c46f5706a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-kJ8ssBaR.js\":\"71e5a5b8144736b6\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-Cmlsv_U0.js\":\"48c6c784b440b06b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-CwTwB4bh.js\":\"f0a74d6605d83ce7\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-ae-M9uwI.js\":\"3fc9ce8677c5aca9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"3e45d595a3c88463\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"c78cb50ee3bad79d\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"76bfd6e0ffbbff60\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"7e64217e1cf074ab\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"e40774dc6476b4c2\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"bc4e4b126e147f38\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"5d65b67206d05c53\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"840e72b2d8ccb51f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"18d3445f4e403015\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"5c9c0804b7a7c9ce\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"e2584dd0cdbda6f8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"f980d89da7e06e0f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"23d77695c5a3aec0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"b93dfc5e96c1f1d0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"113f9a984ea3cad2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"eacb1aa7991d9075\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"17f1fa320d983b3a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"03ce026f7a855ee6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"e4b0a77e40b75e3d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"f0a0245a8e023531\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"9be1bbcaac73ec49\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"a568dee02d7f1cc9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"49b0de0d9916989d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b15ecd4493ded54b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"9fdb48ddb5a76384\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"4e7de9d6e2b3844e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"eaa1d7c8e2b0bd72\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"ca01767debcdfd90\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"095f97a0b5e89319\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"d4631d6a74d19dc0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"e5467815bab38f8e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"32caa24fe869cb7b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"9080a5397573694c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"582202744e8fe7bb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"a8d87c1eb042db09\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"a25065fd2d898fd7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"d2dd67b497f55082\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"e4d1abe3c0dfe4c8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"f7bcdaaf7e55b67e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"5ce0feda34ed94b0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"ac58e4e335191be3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"1ec7e7ed37e88a14\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d35dbe381ae542e5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"ef7c7449c2741b9d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"0a3b22f72f82b5ab\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"21b0de01efb4a521\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"26ba6ee71cf81fe4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"b4b40274ab12d92e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/CompactReferenceLink.js\":\"6f8604213d275a8e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"c84ccebf47e0e073\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"810635192b3f3548\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"a725709f84b55ad3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"1079dee064ceb38e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"d56c6c6845b1f40a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"7599d3666c292f9a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"854ab507b18f0366\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"86522af9359a0653\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockReadText.js\":\"baf1754d8b7dadec\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"cf7c509e6ff07e4f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"75fa204e54381734\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"a95e08f7084a9e37\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"defd378e1f30345e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"fab59993ab7a9de2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"aff95b255e2835f1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"a4f42eecf2148393\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"de34ca938af82354\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"a2e2b7b9e23a371f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"2151590cfc3d48f4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"561a9c07a941defe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f1bdfb46efee624d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"e1ed5215f8eb1056\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"5d6a529a1fc1b7bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"a150712fa7d39fbe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"84e7fea98d99cf7a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"46ec662099ef8820\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"5bf04ad7a97c2cff\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"9100d4ccb81449a5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"199c44bd34e16b73\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"7683bd10e8806a61\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"c2b5b1fb36ae7624\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"fbf0587f96ed61ba\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"206970a4989fdbc8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"6ed153947f745316\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"51bf4aebdf97847f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"f4250eec473a85b7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"f0691f9f9005e61a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"076191088b04efd5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"ce9e3b07c460c057\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"dfaf1ca2e917a534\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"a6de15531ecea05a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"37c1a7fc71b381bf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"cb309cf1036800fb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"ed0a02323d3f5a66\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"0149c6e0c595000a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"437bf4f85e5354fb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"7576ad919ded1972\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"443dc16d7b773cb0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"f653fe4f52ec2b72\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"4a084960a8b56576\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"6c7fb445afbcebc1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"3a8a73ec37521bea\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"0b30f13127bc9649\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"f85d820d82c383ce\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"10936380f2874826\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"7003931ccbf92a53\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"e03db42eeb7f7716\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"0124a19115e7ad04\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"cd65ad0d6fbc9f2d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"083d43aebf484224\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"26407433558d6a6d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"f9d0d37b84596292\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"68c78fd045d7f4c0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8af30520d53bc340\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"09e9a66f64371091\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"3e44301c0006115e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"05d4d128e8a0e832\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"f2b3c24c1ab667ea\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"63cc9fccfcc11697\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"ab0cbf491de2da59\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"cc50ffec47737c88\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"2de00684ebe0b052\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"5e6058f33e5cd1e5\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"4a6d17aea7d4dee2\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"7ca5011f93ceb159\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"4e51f0ee152fc904\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"6ed86314694c375c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"b54a55d5a411dc96\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"953be8e5b58aff6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"0034f02db7a2730a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"2d03f933bce8cd9a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"bce3c0bf9dc5061a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"fc4e4ad15eb08af6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"3f508c5463b7bf0e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"229788c533e323db\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"b35fa93688cedb81\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"314961c992a79a40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"ac740a9292fad43f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"638f95962fe28c90\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"debf1d15a602c91e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"126bb8b1baa4772b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"f2848998c740c48a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"6568d7b92910b315\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"314961c992a79a40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"314961c992a79a40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"6b72308e4186dba7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"1820c351030bedd4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"568809859f0f23d1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"2937ef83e7516c80\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"731b2a5ce8a5d102\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"7c9ccf0fc77b9aba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"25b388ffed0695d7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"f8ca9c509e3bb971\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"0d29b8a923f77cf6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"a4b10b2ac1add35d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"f334fb46d78e0321\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"19b3aee4c308c2a9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"4648b97aeb0ec578\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"40d252b367dc39b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"690770ea2c92fa3b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"23efac930372fd1e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"4b40e323de3c777f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"3f8082f2f23586c3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"f1e9b30aad2fbaf9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"67d1b9c4bec8ba9f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"c0e899016c24d5d5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"d8330f6a20ecb863\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"0b9418e0ca4d40cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"86c2097f838c8784\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"91dad02fb2138ec0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"ea3d085d6681e030\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"16be1fe467474751\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"9d0660634a38c5d4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"b952b134c6cec34f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"f439f63ad7763847\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"0f2247c5b7643d1b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"137eee2c5408cfc9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"b30f45ef90d3f8a0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"5723a42e41748323\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"17c68a825c4e8983\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"5a8f007a05fa01b5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"369a103cd8421e28\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"62d54f3ac4f9635b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"199438423cf2d9e0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"91a35e6a8c565119\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"cc7524f11d6cb79c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"524cfbbad0cf5c67\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"d71bec593b251cb9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"a3deec6a5a9f3994\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"5da07943b3723839\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"71f0e58387fa5a6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bcfe5e792c414fcb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"a4c9528afdea6698\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"1653c84756f4d765\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"d2af801f734e7bf0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"e87ca8be371a3c00\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"d64f83d09e4d365d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"50cfc9c373ceebb8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"7fc4a71bbac761e3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"4e92e81601f15e7a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"36c52582271ee8cf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"c05a4e42fa6bc5dc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"97dee0f333ff39c6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"38afcf54da33b2d5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"e642d01ce231d872\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"622bf2d50c8cc43f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"4edf4febf9eba70a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"23607fde717c4797\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"1572ac506e4d2a67\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"40c21d63b15b8380\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"7c4f920401799a6a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"0e958d08bddc515d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"3b25df7308cf929a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"dd52d087e2fc26a4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"6fa72b1c4f1ff0b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"ef87c4bfd9da0972\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"522d82322a958717\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"11c36a56c8ba1786\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"0fbcfb3326d0c1ce\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"b90a246bbba2190f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"8547a5ee9f03cd06\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"998038bf58b5e429\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"8612d302302b2e50\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"ab84abd3ced110ed\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"158173c697a58c54\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"7e05ea771d67e26b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"ebccdae2efb16a74\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"e2308e6d48f4b290\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"283b6203e4098d12\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"e3f69b5847aeb9a3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"11b05a45c35c12fa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"9576a0c55fe4acdb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"a23221ef294f3ce4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"f6d1102d54f6084e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"d4b1acd722f5eec2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"54e64b8b7a8ddd73\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"63fb156c92a47fc0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"38be3d439f8ce97f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"e97f646304a1b262\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"d1d1087831facee4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"50e4087ce9e7a35e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"00c566bcfe72daf4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"03e7c68b50a79c6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"ce642e3aca14ad03\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"00cfd28415a3830d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"2c83aab238c7a17a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"a4a847164b9a2f29\",\"/knowledge-medium/pr-preview/pr-1739/src/data/refTargetComparableProperty.js\":\"b8cdc5be8bdcaad0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"c401c54db731e5b0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"a6d1f25600f4485f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"f5da210d0ba216fd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"32c3e13b61b20f18\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"0778237aebe05b6b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"5ea12a27f20b34e4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"64007702fd55e5f9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"9f10845fdf19140f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"4468ec82a7fbb8d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"e77dc32fd4e57959\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"8157c1422e63b5cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"77017b1b265008e9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"c4abf9d4744c24df\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"530dd38c2025360b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"602920159bbad87a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"f55d8c148c9e20e5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"6bcbc715dac38577\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"c121376873d40a30\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"9760735d397a48fb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"81ede5c812973c6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"4c2a46b71de301c3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"8c2e093e5a178e6b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"708458ea32e494d0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"a85008242488cc78\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"5bcfb3039c88b0c6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"68b037c8396733af\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"a5d9d2e96d916e78\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"743e4b85fe779452\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"7b51f9aeaa62fcaf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"5cabe6d05082af78\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"e0ef601d09058254\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"a9600578f05c070d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"d9dbb078645514cf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"70e06fad6eb89b37\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"edd7d4f56b841c10\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"a7ffdc20ef66d275\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"bb445546e4fea1de\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"182f8162b0a89602\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"29aa4b9eb560ea2e\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"47871f04cfa7ade5\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"0d92d53d74391c73\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"6c78c433947b5ffa\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"8ae5618893baf5cd\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"e7da518f98dc4abe\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"e7b210b145796946\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"74f3f31d99293232\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"512ddd26e1e289e8\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"ec3bf0e851bf1773\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"a17beeb6d8d5ffb3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"42f8b497cd691cd7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"8884de25a3ae1663\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"c1df34b805da0438\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"96a1690c0df43eaa\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"f3363efa96a6ff1b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"608a311af09573d6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"1d7ce4fcb88ab283\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"dc651c50ecf67c8e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"da7ef6d848005702\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"2c19b773c1608de5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"a73f9dcfd27d41fc\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"5ecb6d49f6700457\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"0d45610f04f1f571\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"7287a6e135d22281\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"bc201a2f61752749\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"fcd5f28d8b7d2574\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"60c695b984502097\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"26ff15ccb8b4d45a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"7e946a00458fbf6a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"a83d9ca32259d8b8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"5ffee6c87400235e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"543a9ff7721b6f46\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"4e53952483eea53c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"d97a6f687e076e25\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"3bd8127019b18cba\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"5b9db26b4eff6e3a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"82027a432246adcf\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"a9384d3d17a28ec5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"cb1ae7475f45d27b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"e8275e75b8a6148b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"0d09c7440c3dac73\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"9558f26a38885046\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"f916c7da87820d92\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"9ccac532766800a4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"1f457002ab982013\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"3433c127066abfdf\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"1a6a54077c0dbf94\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"19aa2ec976701452\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"7dea2b5f15f54bbd\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"40b50cd8e431aa49\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"9830d700091c7069\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"327d8b158feb0b7d\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"8fb73d9ba79aafa5\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"15641d62e597f38a\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"4d491ff6b13cad26\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"4eff31dc99ee40bf\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"80ab8e2321320c57\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"96e4bdb11a1b588e\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"f99709d794524da5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"5ac36889f0fbb783\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"46181a798d063636\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"e3c4bd98d930f497\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"06b00ac72631ca5c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"bcf3b846548f8b6a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useFacetValue.js\":\"b96c12cf36cba109\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"16433780ff8280c7\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"e678680c29e5fcb0\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"c6567f355694cf7f\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"e73906527adbbec6\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"6968f174f5c98061\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"2df110f0370f62e1\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"45e5fa08564de6c9\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"ec81c181478ff118\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"21d7e7828b1d05d7\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"bb8f4450258d8a74\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"5a6cf0afd289e58b\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"939a2d9d5d830792\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"a4ba4e4004f41a80\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"daa42c675a7ec7af\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"5c7dd4f69260ba57\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"de4d025a5eb3c9ae\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"f25a1bc02ef3c8f6\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"10b7784488e5c5f1\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"b382f551541e6157\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"895d0ca10fb03a8d\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"ae23ae2eb0fd80ec\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"fd718eb91dff73e4\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"b2a9b3c406a1e9be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"170ca0c25480abd6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"f2d1b99c0a81ed82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b53389504af24b5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"4d1236dafbf69f78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"7d1f853dede47dd0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2b14b6cffb5987c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"3488b12ae6b37480\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d15ac1443337333b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"e87ea2bbd7149d99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f1499d5074c8cdb6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"652374e39c04b077\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c74e27ef610b6bbc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"eb61b784498d82aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"15fb8fe9e1752783\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"abd351673eaeeb34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"83f9b14a1fb619c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"9a0f1ee7273b288c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c9c8a39761f4d0d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"36a3b96f7611e26f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"d65dd110be500b50\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"88ac59193329c915\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"f244faef98e4e901\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9a8579efa0d965bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"6c29a9376e2c7e0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"1dfce8df786ebd0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6aeefad892b61e05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"a23d34202447cf90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"aa7d7f651b553433\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"835a6d688f175ced\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"41783e4a4878b114\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"2db1fdf6dacb60f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"896ec8fda54050b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"9fe07ed52400d97c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"2764c9f1f443ea5d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"efd23a3f6c2be6d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"fc26aea18f9be6fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"e6487e48e3294d77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dayPropertyInputs.js\":\"c68cd32a22422d33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"99723f399bb005d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"6fe3f3efb3359282\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"0852d0310bac4f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"9bc905cec18d925b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"ddfcc0992b00c5d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"2c399e610b484684\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3845c1f1512b1acf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"b18fd537abd480dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"3a2e7d3c9e30e74c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"feedb92e236f32f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"3da4eccd91f017db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"0433e8d7cc75ae35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"46ba68b82090173a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"bee773be5b943ea7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"4375f91fdf71e271\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"56ee9dfb9fd22f06\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"9c56bbb22e79ba71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"a139b44ed1f5b242\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"0c573925806a1515\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"0d81d87df0afff3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"ea3745dd359ae0e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"349f1ac3f09f10d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"da6538b624ec5893\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"59d34765410fd151\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"1a8483662b1d2e8a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"0c9ed8ad304955da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"189927c365420268\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"2eef596514390cd3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"daf8aaee8105aa41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"047c4487982bfdb9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"8ead901ab49b080a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"b7ccb07c3fe2ee76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"bdc7e2dd1be9905b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"391f8c53cfb29c04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"0be66187b72f8d2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"82430fd9bdf6aa9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"dbab4724db9dd3dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginAnchorLinks.js\":\"b1042bd0752d11a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"9a8e07818d62ffbf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"4319f45c2d676a0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"c04878662e26472d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"3d7104db155ab121\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"253046d02d9b0a55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"0d765b12e7390eb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"c0ca6b20b550f6b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"54ab31b2111de60c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"f0fc20b71ca2e4a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"325813569756c404\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"7929e40c2938c70b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"dd898d5e1df92b3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"b162abb125b6a5a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"0a781d29ea50871a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"62eb7ded9fc4fd6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"bc243c184013dfaa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"d789b981806faa34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"c5c833c10e6fd047\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"16659c1e1f50da68\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"a32dc9a1f5e746e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"46f064615a700194\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"49608fb4b434e2fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"4a09aed8ea426053\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"bace8584f4013ab4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"7921e950274f4629\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"3e2702baf9250bd9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"89aba1f2c2176712\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"017597a2e82043a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"3f8714a3c66c6549\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"a02b31609ea249ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7ca39d9c2e396073\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"f0e784a863997216\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f5a946bd9f5ae349\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"1d5d7ff2c4e994f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"782568be51f829e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"352256abe8c6f353\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"5d8a5849055a8352\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"4b4e538e5383ff39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cbab6be493c73422\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"09ae3a6f5b977427\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"6c80be73c6885870\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"2d085c1ddaea27b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"4b2e8d6fc947d22f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"284d97ab6f9be12f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"ff5a3153d2ffa5ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"e69e2c11f904539d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"477a2543804213ae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"8d04afd3c2afaa0e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"e264afd2a49278fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"f7be4c97a4a95c2c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"931aac17d72bbf98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"6103cfacbe01be73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"fdf7d0065e4d9972\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"3bbc6956e1ccd433\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"7f3ab4a0abb4e6c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"ad08825482b53829\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"ff520c1f520d2baf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"a88142db89f042d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"c673bad43cd75f33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"514d72dbe8795e79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"2528c0a3794df46a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"05ced87c2253dc39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"6949360839f95b69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"016a5321015b97de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"6be4a3d8d311515a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a01236e649e2514f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a68f014cca6c89a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"beb7fd209d2bd43f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"3b1d168d34622628\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"b06dcd4b366baae8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"0f652a9e21625665\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c2cfa58ed5963424\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"171bf0b3b58fd318\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"fc8dd46179ac26e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"81c23a70d62756a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"56686337ca10fc8a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"1ee9aeb25628f165\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"da288a5dfb2f453b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"0656c8846427fa78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"fa797662f0b02566\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c9399ff11e717833\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"5249bf3853a994e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"25b00e4c89c3918e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5e2df1a0462e3dc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"662a70096f0d011f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"48b626ef41f9a1d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"5009e92145e6faaf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"c96df8d72ef36585\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"42fc56e898f6b554\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"fd75aff19bdae743\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"88e1d8f0ef06c882\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"b473ea06e6e1aa9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"9bb2cef2b8825d39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"e7880aa694786591\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"dfcd5d4d34b91050\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"50e57d5a2cf98a08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"f62c0c4ad06108db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"5f9b6c9878cc5917\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"66f841693c5a85ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"3f71d8a2d7cf0a80\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"49ff6f6cb42c5af7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"baaf85822daeebf6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"c742d52a4b4d8251\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"ee13d02df7b6e8b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"5cdebaf6f6928628\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"44b15db7b71cb8cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"9d01b28d6244bb18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"b83056e5c75ab5ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6c7d96e9011b0298\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"5afda5676937d298\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"6df9f94e2571c731\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"1bd451d5da15498c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"aa265af131eb30a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"d6ff136bb80b2cd3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"958b3137e03ff2cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"1d26b62afec626f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b10eb6044f823e27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ec662067a87e4232\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"43eb55bdc043e929\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1b42fc803a081d3b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"95be9e4333fa7035\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"9c49f173444b760f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0f6c1d1f719ef195\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"d4490bac9a4124a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0eaf3a785363cfea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"11ba11dc97967f64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"75004857d9d95b51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"f4dc1839faaf89f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"95e8077907fa3e35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"9fdb05164c73588d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"ade77b71312f5c2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"7f61609f202d46e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/subtree.js\":\"6db9f9863d051429\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"e2ce567d2d62bf26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"fcda20dde0cdfc1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"aac6f7833e1b2ced\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"15580a319c901a83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"8f14a04d29d837d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"2da76dba2c662223\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"225cbdc5a5db065c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"999014a650097197\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"e4f5eddd4aa50ff8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"b2112f552d45a8ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ProfilePicture.js\":\"f1474e83ba2d3d64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"1e87b243bcfa2315\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"09e679ac50a4f40a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"77806f136e7fe030\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"f50b081d411ebf69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"3c9bf035a1de8af7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"ce4e1a28d26feca9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"9b90256a932b5d12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"65dba87a8bb8bf89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"68260744a96ac7b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/useCommentAuthor.js\":\"029691d88e1bc277\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"48c0ef8bf7a71fdb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"bc5528dc4d1473ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"27c0fa4f8a7d3c24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"61a6300247fddcc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"942385b186a6cb3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"546023a53819346c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"6368eba57498ef24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fb8cecfc57067e2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"b4bb954a7147118e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"1187aa2e4221b95f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayPropertyControl.js\":\"e7b102c1f030af08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayValueReferenceControl.js\":\"fb55c333d06a838c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"dfe490c69e96c557\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"c07c084b5a7f97c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2ea50aef258047f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"c9834d8ae62b16b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"ce3a648de107eb0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"51ef5f5248ddbe06\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"4c1e7c2e303f29c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"64ac6da4f2da7fb4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"5fb06d31ddec4889\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"d1b90e7ff91b2c27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e4f645593d70b82d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8272cfcb9ea09772\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayProperty.js\":\"8a7be863e03d02ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"fdcd0e168fc7cfb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"9f79c0ff97328c1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"3aa01a671561ef12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"61811cf5959c0bdb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"1ceaf3ee0afaf74e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"6568dd1af898957d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"685a7717ce0c56a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"e842a3eb7f92db81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"14b4f24d74a0b218\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"742cbe6d718a28c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"84781220ee352a29\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"33a0f18822ce5936\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"75a0330914292302\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7bf3bd1bb0afc400\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"d9c4e5295d8e93f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"e630abac38f63a1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"9fed45ec64e79bf5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"dfbebec02e66c752\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"ac1bafebd70b93be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"008d7bcf77d93d2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"22ade3937d38727a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"2692556768485bc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"4c2d864eb43af699\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"c815f65280cc7c42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"2bcbde8d32b0d5f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"7317836e454a2871\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"8906f40e7b0241c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"d005d221b6d32049\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e7e928ec570adf51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"38b319548a1565a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"4596ebf45a2dcb01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"53d4b1c97cbe17ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"a16952dfed2a548d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"6cfca5af93ff7c84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"58376ef44a407827\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"015b5a85846f8ee4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"3b9bcaf206eb3132\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"ae9dd7ca7254b670\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"b83a163a080257ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"6d21d7e7ef173201\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"4f0e9d430857b56a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"3b982624e052d44a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"9a9ae220bafcd8a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"2baa75221d0f7b9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"aa9fd9992c0ddf58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"226c708fbc269bba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"f5f459b4ffee688c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"e3d0ca654860e24e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bd854c367fd9140f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ca024c98f0ad9728\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"fc96e6d3eb4360fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"5a55f371dc8b974a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"0abeafd4ccf9805f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"26139712c8cbe6cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"713d0df7f2cae3d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7eb8d81459966ffe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"f0d06afe1d7f1545\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"463d90144b6091eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5ea44b1310467bc7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"d1fb470660d314c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"445a6d2fd456815d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"e109ea7f0c89ac63\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"381c7776677c7cc3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"18a0ee37a9dfa6c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"cc6e479ce1dc0b5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"3be6cb14641325aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"ec7bc0fd52bcd114\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"e226f4e154877368\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"ea5cf606e4a80b69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"ba8b7ddb19c2c6ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"2aae566d16e52321\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"7b6a4e7a446bf64b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"81bc9c0bd282dd05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"b89785fcb5bd5586\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"c39025d62e9ecb31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"362b04264bf0876e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"992964509671a2b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"996940d98ed594d7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"c5fecb4bef72fb0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"aaeb0f9f43a45cfb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"cfa963e963eeb049\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"08e73d58d2da7efe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"68c57f712ce667d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"04bd2ffc4db87e24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"131494ae2eaf3eeb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"1738ba7429f70d2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"f56960538bf2d129\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"dac0ce27e4ce9b82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5dfd1ffd0c560a57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"202567c11a499a8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"50a618b39b3fb0dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"08046675798e7292\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"1ed3d6c866a62480\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"f93ffdc2ced1ed61\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"9bf26dde92bc3bb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c7a7db3d176e1400\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"7adf4fca31fbc597\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"650d717e2e494a26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1b217935c996c9c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ff600d55ebd53dc7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"84891af39c218a5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"2dde0f0503d50586\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"cbfbdfddf6e23a63\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"88452c60ed6a3b3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"55659ba43b9ea68a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"a1469b99c10ee58d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"da9ea30f710e0215\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"2d831b121ed024d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"5790a05f67a94483\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"8ad0beb00ae0ffc9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"b09f617229d433e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"2c3c7238c7b67922\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"00201e44c3b13087\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"7e92337abd6a3bee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"d749fbe0b8c85c8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"9511f91f5da77c6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"2e6e3d8d347c926d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"8b9b0f43dd7129c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"fe08f984de1ace96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f38cb0e96a236343\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8535653c827a90c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"bf6d49bd1db559d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"b865677006a9a55d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"644501cca0bb4153\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"9a0bdd2264f9bbb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"b116f1c996f7f1e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"f79e705e019325ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"c66f95ac2ad47fcf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"349cef6148e1ecb4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"3507e5452e304f83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"f440e6015a1d7a9c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"936814657464d474\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"f2970dcb7475f9a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"ce7a38b3db476e63\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"1f360ffd07d6d13c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"4d04bf97ebe3b027\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"b0051d7f655dad3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"d2158768c66516cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"843c4d0cbd23bb23\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"022d2154b351d309\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"a7acdf5d1d832bdf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"adeb7a599e46a2b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"07a2c6d6ddfb1581\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"edb1aa00ac132d33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"efe377e49207e5f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"044cdcde66185570\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f4850393ffc0ae94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"88cdee337c32c449\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"396d7440ff4148eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"c1e016484dadd8e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"138460e15fcf5f19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"50641cea070ce7e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"7b9a9fe6727cbdfb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"229661883a394228\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"5671ef0e10ed14d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"1c02b334da18abf7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"5490f3d62fa2e832\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"1f193964133a4106\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"571f8f3c7c2430d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"30e96180ea937c64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"f1bdbd7ef43ebf52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"7355fdec823e7372\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"c0214eb252edb89f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"b96fce50f0d9fe17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"c631ed01fe4f96c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"7f470002575143c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1f2729b0e18323dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"0c66d801d82857e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"fa3df90e66e0b146\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"b1ba4def9590c9d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"411d389c673dcc28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"7d3f714e32797dcd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"b5145b93393401ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"d45982eba6063627\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"3fc66315098157ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"4bb6d77305ac2689\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"a2ae4f10ba49e9a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"802ac18801a2bfd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"18b807a6bb72e3dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"724d52fbe740cced\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3db3eaa9e5ba2443\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"c8440dbe30c34088\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"54730d0153643946\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"4eae15d65f52a3cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"a07eed1c53497b6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"4ffadeb8bd9ce4f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"07d04570a7e3c38d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"0b3f728db4c981eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"a95fb8c94be5aba2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"b284462d6148ec73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"394da97d63bdd5e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"4c6da9daad014435\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"a08618899bfd8b52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"b43fafb334195045\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"1a2c87e21ed316f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"a3822ec93abc0412\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"7e2856e92fdaac9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"2475851c712dd42c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"33644a305e76de8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"c6e9391330d5260b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"4d356a50e816770c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"df9b0bb83d816550\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"f9f79424bd86aa83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"427b677ab5c8354b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"9d8274c3982422c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"9c87762530c1a1b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"42e68eb9eb98f8e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"efef9bdce24f08b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"dae26bb34d00bd9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"3c216eb1e57b3ab6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"d26376d0a22fd278\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"4e4fc116ec08f57c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"d659a96e3391f305\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"3e682523b9adf2ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a56f3b7360f8f6c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"fac61ca1da90ee49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"2c46ff6b9fa60184\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"b03d88b172ac3954\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"80c68c89a253946d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"3feb122432acc6d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"b2ed9f9af234147e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b578ffbe5f49e942\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"793b368a59ed77ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"14f48c4d7969bdb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f2a068daa310dbd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b7c659bfcbd81f50\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"253e9b771041a00c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"92f1b0c5af6022c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"12b3ff1757f70065\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"974443a1179cdf0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"eb90571d9cde0e5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"b391f8b108d76ba4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"a2386ef02e5f3d62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"12c82235570480f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"e34608b11166127d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fd9117f2d1658ae8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"b4ba9dec26760ec7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"f72c582eb1aefcc5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"f78e282db37d4204\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"7ef7005095cc4409\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"159ee5aa9676a5af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"e58f06da30c6631b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"8ce2eb70dd9a3de2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"36569a5cf0e73ed8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"4a8e30234d2c9f7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"0f177eab78b94450\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"ede0280ea6fda751\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"32614e9e156baf8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"b432aa84b9d3c0e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"5a6803c4589c2155\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"6cab1a241705ac0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"86949a760d4c6ed4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"8787f045e33893d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"71341ce24dc407c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"d9c0850b3b554dfa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"a173c207a7ca0091\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"2b6a68fa5de343ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"d9eeeb718a00bac8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"398f26a5be483313\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"db5166415ebb8401\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6e351d94223a1ee9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"cdf611fdf50ef830\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"dfb0c57360d25d67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"fc9672991dcb4d3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"8e5bb18f8dbc48ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"222d985bb520cba9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"a253f1ff8ba23d8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"a838ad27412c5e0e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2a705cfc896b442c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"6b1d153b5ee734ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"dbe02e7388a39f97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"b0d7c3d1b1995a20\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"fd31aef06f788954\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"75324a0e99208d7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"9359d0c899c07554\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"eeb58dc780e79619\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"ae7ffc68961ec255\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"a0b9bc8879f438ae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3976a7153ce4f437\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"4b1e6c72045ecf5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"d620a3ca7084a02b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"28ae8431adca14c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"491b877db7f940c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5a98e1bb18ebfe53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6e9ea5d28f6f8a40\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"82b9918297448389\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"a36caa15619501e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bb84423f9b1cf4d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"82ba774dc6053aa0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"60f11612ca7654fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"6b2fae85b6a5a64d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"c20cfbb18b76f55f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"11b9f4d9ac6143df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"20ff1e11ac13b8f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"e1c56b131293abf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"5f2ba616c3ceb112\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"fa87d91e865c0d60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"0cd29cf8b436a007\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"f0d286330a4e8b44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"65203213e5479736\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"36ba3a07f5aef054\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"ef04984023cae13d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"6f8d339fd4f269de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"f13592a4fe5e7260\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"0bef7704407b04ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"eb52daf558cf14ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"6bcccd7839acf74b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"27695ba2c659b7c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"05c79b7b83f09686\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"76b0fd6b4f0c408b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"df05e02fa21324c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"b0941ec6715617bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"13a0504fee24519a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"10af8540b765c0c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"95eec850d16fb8c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"69219ae0e7693c35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9c928ea5cf5da8ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"ec582dd856f40965\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"47a42a8d96d72108\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"754530f52656eb58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"2b16e29e491b70cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c41d3eb676258e55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"a99aeda9c4cd0a3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"e63581171c2192f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"32745e2af2ea6669\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"6a4e0740fc9d38e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"f323463cb19b228a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"3f6bd6de5ca848e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"34517629b94f4734\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"f35172e677653ed9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"e4c30c16a8ed8277\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"b11fe5fd45c5cc36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"e4346ec55cbf93e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"7b4c8e95572a5e72\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"dd8b32d55bfd160a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"935b0e9f09378d54\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"34e51fc207129f7b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"6ba1ba0a5ad1c621\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"839156c8fbe27dce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"caa6b6564d9481d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"262f002178dffb19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/QueryText.js\":\"9c6fe29856803239\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"60ac20c01e512372\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"f7eadb48aca5ee83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"67099b1a53ce2f12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"e5b3c42f9437669d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"0d05746136ca9e7b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/registrations.js\":\"b4e31832cb5e5b1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"baec6643efe895f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"0af6a71dd1cf2e09\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"8dbe0b9d220348a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"12c635ae04adadd9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"03f5b5aecbe895e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"629f056c70aec121\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"29080427aa0d2f19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"23dac5ae09819856\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"fdcb1036f2b3b607\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"dd1147d7b1c556cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"717ab091fcd31b5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"e49f50e141b2b898\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"1f82f38bfbf37bf4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c49d2666ac408619\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"61985057aa311e5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"17c07a740537a1ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"974d081ef61f0edd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"a55fea4fdb8391d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"5846a0e84b4f1d7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"02f142cabe27c108\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"ef43484543dd68f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"fe0480bcd3af3a46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"4aa453d29813f64d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"af6832c5a7184b56\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"1f5341066b885c82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"803c6483c6862814\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"934fe3bb2c89ea88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"9ad7b5333dfd649e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"30778a8403b20928\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"b5621328d85e5171\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"cfaecd1cf84c30c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"c189e448f360977e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"8f6d8fcc9ac93e40\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"132e2624109ef911\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"7a7d211eababa941\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"465fddca30112897\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"a2e49f0b10f6e381\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"b2201a2c8f6aa8ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"92dac71ec4238180\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"648fe9b7fb3d3e1a\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"5c9b4090acac0303\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"d07c5b86ccf16e8e\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"141aec9abca56062\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"3ee13caaf8161062\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"d3ae299f9fa88404\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"e0b21945b59a2018\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"f0b07b60332e7a8f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"9f6336d1e01aeef7\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"cab3837bc0429646\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"f41c26d8bb3099d7\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"7d758dafcdcb48e2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"aba7f36f810170d7\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"e9f14086ac66a825\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"8ca02b10e09ebc94\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"352b6d21d69aef84\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"c255e943d4cdc255\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"8190c9e5c358a986\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"d8ae20fa21f543a3\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"4b5ab4771611b5bb\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"f47811e25ae546a2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"416cd2d249253388\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"d75bac83610ed44c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"7eb79b08855d9839\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"0724384c3fd6926c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"5c1312224eb02b53\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"2f909900e76ba59e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"de01587d2a31c421\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"c716b2f56cca260d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"3f4edad790411301\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"8c955e7cc135e1bb\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"08635ade486c83d7\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"4d584607397f99cd\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"35dafd4e5360b110\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"559cdf089a88dc55\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"1f636ff4d4ed2e2f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"35dfc6d019c9b1d5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"851fcb50bea28699\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"6492674cd2e9bf78\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"0b8a0cf54a68669b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"eddb0bc2aceb6785\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"ba35f4d7427cf680\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"63cf0a5f93fea8fe\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"9140afbd0976b155\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"f8b2011b48335ce6\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"7746477eecf7aee4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"50e4e9df8b652c89\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"1766494ec5fb53f7\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"7f1c05855385ef88\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"5beab9c81998a631\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"ecfe0de1923b41fe\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"118688ba04ae4b74\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"1a52b2f9c3257ba6\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"d0385c5ab572410b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"b5d7b03df7430174\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"2b8a4f5df565558b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"0f575a9b0e712132\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"91431da810f6098d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"e6515694fcaa41b9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"4da5648767a71ab9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"b0dc3c0a2cf4a499\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"135fb9416cc16099\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"28a169301593245e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"a99ab62d41885b75\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"4781335254210429\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"6bf0067ebd09727a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"c0a9a4475708255c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"8314e30fa35c276b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"95eafe5a443f9d92\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"b75e2c2dbd5f02ae\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"d48a437c01e31a89\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"084c5defe244df29\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4573271006a2892d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"debbbea8e9ecb25a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e7f8261c45d4db83\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1361689b96a83fbf\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"4183e4adc7c34bb9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"2b6e9e8c9236272a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"3c5f41f554af2bbe\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"de04ace4eb323b4e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"137fc72c719b5680\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"02b5f1ce6d6f1933\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"7344291998252da9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"06128a7f26ad9b3a\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"d1d0f1af2139e135\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"b27b99bac81ebabc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"171f608d6f6cfd58\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"e3c0b6390d0ea3c5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"a1aadd651f1e3893\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"cb1b6707edab7b9d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"4e7c582970de39d2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"395b9d64cd2ba500\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"c9b87f347b43de4a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"f26e6ef2d389334b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"5367a5bdb793bb4e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"9a7184945869a2b6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"143d38a62306f696\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"71995506c824330c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"78f9585fb9d7be39\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"782179e1cd63912e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"d0880772d7707387\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"972c91ec4ff67fc3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"ffb0488f361a0a07\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"a47adcc792f2673a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"0276b36f72dec7bb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"4d72a0e2c88d24d7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"224d32fb430262f4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"ad3d972311f5ac57\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"53e2ecd3b9ad096e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"8a18fd0ba62a86c8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"704314b0aa1b388e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"7ea2dc41b9a50839\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"a7835c7a3b007bd1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"d053214d262c4aad\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"108e1b1e796ec237\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"a691031340a54371\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"93b7b67e879391f6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"f54b02485ef78bed\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"898c874719e8a53e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"6d53574fcb995d58\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"7560c84068b84950\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"61728d232cb8973f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"45529818f34eae89\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"f58a919b385c716a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"a7dec0b00b279896\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"1f7e50567eac3a5d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"2714d6dddf90efda\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"c15100278d9d56b2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"d25b3e98d07be13c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"c4100cd49c6557cc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"e2f3223e7b1c2172\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"7192297516da2740\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"a963d0aea47fa1df\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"6b17e02947a3109f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"d20f5ebb0763b0ea\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"264c38e633443993\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"bacd2d2dff93ac25\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"ae86334e08d8b611\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"c0be71c9d9ee947e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"9ca35d21bcb98037\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"fa1a70c4e4806c08\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"ff23974575cd7997\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"6157a097ce94110b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"cc1247fc569f4164\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"6f5f80eaab08356a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"2814eff3b4fe0762\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"d51d2c371344400e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"c5ef359a99239821\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"9082157c606ce0ac\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"26f0b0ce222385b7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"eea58a8864bbf371\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"f306f0b5b439e6b5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"b4bfe9da2cdb5983\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"29d8bd700179f285\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"9162196e0c1ce62b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"0a1f38dfed4bc693\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"c3f7c9ece2eb45db\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"0bedbe48d4189ab2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"8e32d9df94c6667b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"5c38428d4a320e3f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"810c4195edf2a2f2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"8e17065d3403705f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"593917d94f72bbdf\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"bd3c6cdd743ee808\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"4ee85dc3dd3d0b3e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"75ebc34a8787a2c2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"861628e7fb42d375\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"66c87e263aec20b7\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"b2627723091589f7\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"b425d2ca62077f25\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"6f20f6798220373f\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"e4731c5f0d67bf6e\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"60849259ccee8063\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"91a93c411e6234cf\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"b13060c231c2ded1\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"2b8c68b0c782686f\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"983522aa2a12c392\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
