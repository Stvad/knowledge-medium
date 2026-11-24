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
		buildId: "250c07a0644e-3bc41629",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"e67117258872af25\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"e67117258872af25\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-Cl1IrUGP.js\":\"7f58b7c04d217e0f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"19781224f9586c28\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-C_ugFQ5o.js\":\"7b54dc29022d58e9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-DW0aVLJX.js\":\"b28db454bedcb93e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-B_bG-30Z.js\":\"5bc86d7f12ba0e96\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-CJvuR80S.js\":\"e6e7ed26e2a2d0e5\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-Cln34R0W.js\":\"8523791988d6cbec\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-BNsKQP2d.js\":\"48ac6f250b346e8c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-B0G-jigg.js\":\"f255f00cda900c97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-DZN7JY7b.js\":\"f1df91805812f1a4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-B3WloeiN.js\":\"62cba2f2125d4069\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-4c7pbTJD.js\":\"f8add9ea62448a87\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-B-Yp45kn.js\":\"fbc717f65bbd7eb2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BU5xI8Hp.js\":\"8538b5920e7d600e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CQ4CwenI.js\":\"a7582174f6ea5e5a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DIymXr5k.js\":\"1c2c019e66ac4872\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DiiyiSma.js\":\"38cfd325b2361645\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-UcLcIayF.js\":\"9902b39a04f9b226\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-CUpXb9ln.js\":\"88d5a6e759f52a35\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-D-czav-4.js\":\"df6a06664e62f20f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-BwT8ymVL.js\":\"3d084c22882b8c2d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-uEjhlXKM.js\":\"ef94734c70c21b4c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-Dnh0cT4R.js\":\"1c254cfc497aa49d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-CfDdvbEj.js\":\"ed188b9ed0b76a41\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-CG3ioVsP.js\":\"e2b65778dd11148e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"092544b5c4eeca8e\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"36b9ae7a11fad120\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"e889e3aac0c3f17e\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"805a7ae7c528a2b4\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"f8b664d72bdc852c\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"3d2bd82c682d8800\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"13aee33670631c5a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"c5b17c5a4794a59e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"b584c9a9d704682f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"873745f86229efb3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"c4a1487879869ae5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"266923cbb5a2de3e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"8e24d71a756956ed\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"a06e193eb979bb1e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"e6b12b7845638f05\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"742f571f5baa2745\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"a91d29231d00c404\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"8d0d4a7632195227\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"914bb1a14b132cb4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"23e45f668ec1edf9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"91ea30e757cc3f9c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"83cf5e53bc573c8b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0651089fb5ac27a5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"545887bbb11d2ed3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"e91c5a71d1aef35b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"465781263ba20170\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"0b1605d142caff20\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"6918bc09554df42e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"8b67b1941fe98d5f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"a974ebf70ddbb9f8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"475c6d596b86494d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"37798d11004b33bb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"915ae84cd66c0d14\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"739316e85dcbc897\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"471881bc748e56bb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"079274ae183784ef\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"7ed4e036bbc8651c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"2e316edb0c9b9002\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"8c7b0a4e606f589a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"5e9248043e6e7be6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"1196982cc34ae0cb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"2d153952d21c4fcb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"192c440042c877a3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"51d87f84c80caefa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"76a89c3be9b5e636\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"a72657a802d6ae94\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"50f76f1b2c8a8e28\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"942034ebaf181e41\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"44c10f0c0a61517f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"84aaeaecacab2954\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"bb7f99ef10971b03\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"8431588021cea565\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"498dbedfb18a3b0c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"e5031966d403f561\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"818108b2bda11c65\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"ef26276462e2c379\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"7aadb8f1e921ab45\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"48412e85ffc17386\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"bfea0899cc122dc4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c9e119928987b13a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"f7460ce6244212cd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"951a01f46a31ed4d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"7a7c820e6e515c03\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"1038be0386ab37e8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"d0ed5b19e9c6175f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"c87f42bb5a42f472\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"937317f6f60694ff\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0aeb0a2e6a2fb230\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"354f8d81637d4080\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"4266f357e55b4db4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"6799a9005290fa7c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"a8d6f632b4fabf83\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"8d845ab075660453\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"7986f7149eb8edc2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"73dc54002f8e21d1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"93bedbf243dae6f0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"c8ecac3772be8839\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"9c1d82b98ea8f443\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"71c45e02eac27716\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"fcedafa1622a7238\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"193e4b4ae359c887\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"b952264146676ff8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"bd3f4695b82d4322\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"4726e44a2836266b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"badc75a4fcb74ed5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"170a99a4b402db7b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"760159c873933e39\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"d2e6fa484c00af40\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"c525181604605e7a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"6934506fc4b39c59\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"7175367d5ea1637c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"6cd23d4f2f461752\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"148a919923927b65\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"e49428d6bd1c9aa6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"f88c8be666791c8f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"ab96d89a67131d4f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"105db03335239536\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"6e5773d7afce55fd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"c3e3e56e96d1f414\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"7dedca4df3f351be\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"c5d51b8eebc205c2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"f5f5a46ad19cc696\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"c08f273f8f936a32\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"a31804462266e3e5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"cc637ae68ef4ae1a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"0c4fdef891127d39\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"48f8a63d312f7d7e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"b2be5d34f55f5fb4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"ec80991ace06a3d1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"f50a640bc2c029ec\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b923693e0c039b6f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"2dd66b5271268fd5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"d5a0c1625bd024a8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"67d85267a3fa8048\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"42ea68666c25ada9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"c5b6aee10419cfcc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"fc8e3a8467df2df5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"d5fc4a5bac370e19\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"99ac1f2f68423361\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"5f75d370e6de5ac4\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"291b590f6db8817c\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"46762fbce71f701f\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"7d3116e23bde8927\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"588b9d8a6d5460a8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"66c643c36eb87217\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"b5d84982a71444e6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"3caba1e86fc59e89\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"35d5fbb51979ea48\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"fde6447abe0ad5a9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"1848a31131c44954\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"a3711d2f4032127b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"4ce317785188df73\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"8afa16ee44f7f940\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"a88fa581962e9f45\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"b40f8d09a235f365\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"50853a690cd62698\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"c5788f3793e2152e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"21f68cf169d78ffb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"3f685ab24e26c5f6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"cde9f73452d8de1a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"a88fa581962e9f45\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"a88fa581962e9f45\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"890bddc1303845fa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"64a06e6273060529\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"2900b99d9deadd3c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"7cba3e61102a6fda\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"0364630312105474\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"b0bf483e70f0c453\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"45b39eae31235475\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"a79ce1d503703ae9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"17bbdf3ad864f3ae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"c09107693eb4d023\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"af858ebf093647c5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"dd97183583d2f859\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"43b6d12f9dd2a225\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"58e5fde917328b35\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"76cd474690680a41\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"4ccd05ad1c805cbe\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"bb7da04768594a23\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"1aee08581df815b2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"761c1117f4df11e6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"0cba5288a839838a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"ee040302d3f7ca6f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"414e592a32eb6348\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"3b78a27db5573cd5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"e5327035ccbefaae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"9915af7f4f076d28\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"8cc10a9b23626411\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"05e4e19f00ae59b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"a56415e21b840a79\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"c22b591bd0dd2e40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"cdda9a0b71d444a4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"c937eed944f33097\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"ec3dd2993fff3b92\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"574e8904434fc12b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"0726d45efe1c4926\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"4281b3b8b194b1e8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"945a5d624cc115cc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"6c575c2c7d997d0a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"21ba590c1a1a33b2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"64977af924bb54ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"b7a8270fe08f7aba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"263d6c40bbb68f43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"6891f3a5c220e9d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"4c3e0fcf1906cb7a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"880b1066afaeb232\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"ab6864e32825bb52\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"0d65807b07e454ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1d64729fc9abd1df\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"476c6b1d523ecdae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"1a7aae9126ce7993\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"aa513849305199f1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"b89ca674e4e9fbde\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"9c4e133f434be8f2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"92168d62b3f7f2c5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"1f000a45255f6148\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"1b163e5e130e2e52\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"ce869d3bb61a9bca\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"d0ad52e8352e39f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"eba8bf3e64306e81\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a0c82f01d39337af\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"a51e862dcf954614\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"93aeb998ae722234\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"f81f4926237a8277\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"97b477ebebdf453c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"1416c6f213596080\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"2bc440f048923846\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"f5b1d50de64febdc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"f7ac55117d2953eb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"f6a58b50a4fb4748\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"88568818c1ca71da\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"e0d3ba2b91671c35\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"5881607bf99ec460\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"3d36da2b0e383041\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"6f58681383098d05\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"a0db302b29636ddb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"164f116643bddf3d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"007aec13b2308699\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"6724740ca8256bd1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"4d0416c2adddffc1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"29f57629a913abb4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"f6fb5b36bb2c2804\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"1f10461f3912344c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"092a8b73e3b8fd3e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"d1c6cf48b0099cd3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"d292bc20b18756d3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"8ebd1d6c8392394a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"45c3779777672027\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"eed97c8d0559cf82\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"a999f378ca250e13\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"cf60c54cf3b38fac\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"b5095182c8b5aad6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"eb828e3bc1e01958\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"a2e62775f87b5a78\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"b6164ed109f25be2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"92febcb7d16fc446\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"225909b10c78aa17\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"76bfcd0f586f8cde\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"8bb2c297bbc16e36\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"7445eeb39cd32762\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"584a08b1ae3f57f0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"8a36174e23cd127b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"5cb2dd908d9fc79f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"cd887e1118ef3b41\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"c192be73439da1db\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"ab0b6f7bd90b37b4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"5fd492b986020453\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"0cbe2688e9dc8e1e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"826cf62e7a1aecdf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"31b1acd593e6e8dd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"27418cd72b57447a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"d3a776e902c2c65b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"195183240611b141\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"97fc9fb17dc85994\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"6a7d1927e66329fb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"5eba7ea88c7ba38b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"08eefab70e677150\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"6821e3809bd4a256\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"813242d2b976c2a1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"137ee6f010a2e277\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"942b77ad3e53767a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"ddc60f4ab9224cd1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"838277d19511be8e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"8385e674202c23e5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"feebce9f935ef750\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"8779dd1956c9172d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"4648801a55d0d02c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"33994ab000983933\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"4aaa315d021eb945\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"1ff351f59d6a18cd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"65cf37861f03e5de\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"9eb2071b6224c759\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"b965731a6c73c782\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"4316125de5a6acd0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"8dbf5c2d97284aa1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"4ff26a71b6bf7c77\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"f49da69c8dbfcf0b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"b74a524c9b9f730a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"ca967bc823f2df43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"837dc9edb04f78c8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"d6d79b09b77c7fce\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"ca97cc8d72fa375a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"6f43981a283fac06\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"6bf0dc7192c0311a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"6b7eb8a52777ebdd\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"913a26e5e968a84e\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"52e0b8dc13c83df2\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"740c04d784d3abe5\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"74faa5c04fccfe32\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"742c3d85f75d90cf\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"0657f20129680b24\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"cc6cc4a7c9778b30\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"d2686965d0f20810\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"3e047a7fb644885b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"2ec5940fe24ebc85\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"860473850995ecd6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"142200ecd710778a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"29f99fda067138a8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"e0b5d9fe04217a82\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"9dbc47cc3632f0b8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"04d8d7097942b167\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"546b398e4cc88bbe\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"fe530eb333421edc\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"2fe2f2e06251a24a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"f7ee934950aa5088\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"085c02b6a802e827\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"87f5c407e31baa37\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"74f49031e2060864\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"534d9ea1c34c2060\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"461ba50be0c32c9c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"2d8198ddd29bc375\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"46fa9b7848ae28a9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"cf03b6d70ae19ce3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"05701ffcbe363a1e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"549f2ca9038e3428\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"4c1444c58962f500\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"86ca18775c9bbb83\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"e718fed8b60c00af\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"954efb2df103c636\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"88fbe9264b913171\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"05fab55c30001dfe\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"c839456d61b9fcd5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"0b9029e974d2667f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"ab0a24745eb91881\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"628b09e026df232e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"a344343fcef47e47\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"64277158dc1edd64\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"46debf1896bc7def\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"5d12026739172c64\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"de312abe1064a609\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"6fd671244ae6f8e7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"b0ebcfc105388e04\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"c6335d697e543b3f\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"75401606b1ec2657\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"bdb379807aa08f77\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"ff2e9bee23a73388\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"fa3f4bcc1f948e4d\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"5f401ded1eee6706\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"bc8fc9810880c7ce\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"370dc4991506e400\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"db1518e62db58335\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"3093083a770740b5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"3f3e26ad4f982a90\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"f84944d0f715545a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"612b1629cfa2db3b\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"e1ad9261709e2891\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"3cb375f67cb27c07\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"6c0e746352a579f3\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"88a6d849aabc517b\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"0a253e6cccf4eadb\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"fea3262b2c967835\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"984ac3b40aec10dc\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"ed03271e6fe79ea5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"ff64a7516774347f\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"17aa5a873313b71f\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"02ce7d2e50ae519c\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"ece6e01e401e6adf\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"97d84f05381e8402\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"465b2b23199a6121\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"67faa55b421710d0\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"ae0035e984b8ad4f\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"9f36b4c9052a7c8a\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"76e5238cf1b02940\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"547b0777d3c16b0f\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"47b1beaabb6b5002\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"3582956dbc6bf13c\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"968084b5e1db5016\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"94015b1cecdd1a88\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"db2ca6fff2e479ba\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"3369c4926ed3ac92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"37075804e1db92be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"45f9cfa757dabced\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7b1ce2314edc0b1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"f06f0e24d380f6ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"9c363805119f9c58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0b4d72c4dd500863\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"8ee6c2b6643090ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"864bcac77a690708\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"a7a91aaa13a3487e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6c7521e1ab73d96f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"07af2aa3692a6e41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"922c0000aa46e1dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"78f699f56c1c85a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"cdb958a6c9d43987\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"90c76c48697e1305\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"86e7165a8c9a9c0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"96e8ce390d967ffd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5c0a561501184758\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"eb06e47b47a825a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"80e003aa1fc10297\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"cdf14d7dbb9cb49b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"934e4cdd84a4c7f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d2705eca43f2b0a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"19dfd33b706392de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"502041d06d4e1d9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2d96a8f453a60979\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"8d6359b3f68bd94b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"d6adc0c30bb9c787\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"3ae0f9a3fe39f94c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"32ea9599d8eefd3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"67d9393f71452cd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"a4095d60b808b641\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"f549c5596e587674\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"affabc204a7ef1b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"667a9842556c680c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"9a6c961bc90e7564\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"c140456adb60e877\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"3f991d0dcc002b28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"f91f2057022e035c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"f4b9f1928ba17fd4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"7914e0fc6ba5cd74\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"6086614eb168a6c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"101032c93917fd64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d608aee3c39e0465\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"b27d5dc1b4931435\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"c53fd93d738c7341\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"5949199c3900f7e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"634e3d000ee647cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"d1669124b998c185\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"923d7a961cd8a89e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"4f4acc3d1863a43b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"5e527f06383b86af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"b26384517bea34d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"577c0b4a3217a167\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"fabade2617e24100\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"1c71d8803cc4474e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"44edb85a275680b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"a43d6c955be99109\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"7538a3d9dffe406b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"da5bcd5cbb5c66ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"71dbe0a5e1698b96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"bb9ee47244366193\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"c2a59c938cada823\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"b2697951c358597b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"b75f68850bc469e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"21868835e1f1d0cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"dd3e697b6c59782e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"d0f2db66b597a90a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"c60e6a3f1a71b0d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"e9783365d8cca356\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"fc4b1dc8c89d47f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"16672f53a9cc1822\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"dfefed820e3762f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"013398f354559250\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"5e47e79cbde6ca6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"a30f9b34a66ba200\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"0a1a712ca9f62ff8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"bd0158bc32830156\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"950ae11586f1c25f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"3a935f9eec81ac47\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"c360cb3b00e2594d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"55b96b2f34908a22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"aa0f908b9d2a4064\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"a0520044481977cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"c9f650d70339e29d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"31ca6afc71c840e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"9e8a901f25bb5085\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"54d25721acb03d8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"61960699683db815\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"ed0041faf0867ced\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"7e429de71181ddea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"62be242682a7fbcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"b3828f16c80eaaa8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"d4dc5eba75b32143\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"e8b10e3c64207751\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"6c15b977cce9a50f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"31744c31c7c31755\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"53b5acc6cc172c7d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"c5ea29a45bbb878d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"a87f0a189e370e78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"49ebed5a2216c65a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"7778a3bede258fc7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"0e07528ea7eb809f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"78b98e78f583b220\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2f12644de6ad8ba4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"2ba2260f91c13571\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"272e18127c1a7933\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"8ffeed132626607d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"dafab3797239684e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"f9c4babd28ecfd58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"3ac4583a839321a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"b8d5674c9c2a8a5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7055885a7ab46bbf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"d5dbf0668c5deade\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"52c083036a09ceae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"99174e0d63ac1606\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"ba787a50cbb5202d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"21f8570d25d22318\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"5404b596535f4116\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"69043acf90ac9998\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"7f063c120da4e80c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"e9328393ffeb52ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"3f3c3378b8581995\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"834a9a8ffe5393ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"8c85d49d4bfad4d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"ab5c80978b23368a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"2990dcdfc7cbb2e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"48b89e6fca3e371c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"9cf08dc9876cc278\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"6dbacd35c6886cfa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"f27b4ce12fb28b1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"8876c3faec7172b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"18cb00b4270c3915\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"6929b15048b67312\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"314f769eb7f545ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"1106397f35c82d3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"b3de8383f7402e17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"d51b0aa0e8d971b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"ded3a537e39253fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"09d7fce6ba40284d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ef18f437a58d6a1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"99aaa4ee99215a9a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"0dd11a1822c846d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"2709d2c58a0e61ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"01058617f8510396\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ada8a97095fd3b83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"4bd8d76991a7922b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"0ead20fa3af86fb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e6ab55a4951d0ca2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"45a7b505c1c9be8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"3706ed1a2924b24c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"995264df09a59084\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"d610f2dbf5ea8f3b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"6045a79b5f40cbb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"45ece5a134ba18cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"8a51d2ae25a08dd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"4b1327cf6ffc25f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7f7a8547455be794\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"aadcf6ab7b4a883d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"119cd59a24fa367d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"fc63512e5ad1cd49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"b978326ef6ae1bbc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"d88a15cb50434a44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"702110eed9026bec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"7a8286ddaa97e94b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"9978bb5e8bc749a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"0ee9fd658325d19d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"22c2653f6a997bc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7558a9821b14a620\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"dfbc6f5885f77db6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"41151528b2dff2e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"4e5e89152c761d10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"905f5b32ae6b7185\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"24fae85c76f0f658\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"1e15e9e3ec09bc56\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"f9060e5a804869e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"217ea00bbc952916\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"9a26b52ca0a8a521\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"5d964b5ba913bb1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"6c92e180b5507fbb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"ec9075051a207de1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"3c4dea98f3527ef5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7b69101ba0cd2a06\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"91e69275c4a53e6c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"67596569d2b4a482\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"357489be0a84b91e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"4bb547af083b3d16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"bfc1a7590df43613\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"b633bb9988926220\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"8fe2d5725f5d061b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8c19fde5db7119a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"25a662c57bcf039b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9ec22ccdf34f074e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"45f44df47b06e1a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"bf5e2f81819f103d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"d56d32896474c2ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"07339774abd4faf8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"7ac38d6122e10c1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e50ce375d47933a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"53e688646185a3bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"d6deace2d83a161c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"17792716094b359c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"f70bd62c39c2f913\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"0c242eef6e529fe8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"8f753e25b35dad69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"7e278c9e6e11975f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"eef432f40844d2b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"69002e255f2e4894\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"4a13be31cd11a8a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"8dc1dd3d9352017e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"9773b42a316cbb76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"2e5250b98284d151\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"69d74d54dfbefbee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"87554b4b5a8b80d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"38f6933a1b89a6d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"de335f09c6bac028\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"2797de99859b5185\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"4758db81a67ea7bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"1c50de870b93e114\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"a7577a9b63835aea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"c6a419798cda685f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"ebdf469465170fda\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"bc3bc4e27ff45695\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"aba03a6db52dc24b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"dd6e9146d3e7a232\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c6901eaa45aae10f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6d2b2882129ce60c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"ca607fb0befca503\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1c05e9617690fb6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"33c392b1151f340f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"9db7381291124c39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"43dc79e31700a220\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d255472441fcaf0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"694e48e5ea213a34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"588c07d291753906\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"f94d7d95ad228ac9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"f6dfd8988b55610e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"543582ef8aee0363\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"9904eb8b048bb98c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"1563b7c3e9316caa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"571b28650f91009e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"b8da616ff2086b89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"941f3ed72293ea72\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"4e2082897fb327d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"6a0c361e9bb6afe7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d57e67b56e5cf9a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"356b474456612851\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"7e68e69cd389cbff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"f8d4f4ef1e2b5420\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"f32b1662c45106b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"9dafd57646c2f782\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"804bab3e50ad9a0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"9a1696d79af879d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"34bd8c48f95d870b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"c99f27f86b41db2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"e39a0fa831c202f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"a0410af1c3c1e7ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"ea42ad759e296d9a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"af328baa0ffb521d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bdeb7d4e32ef7898\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"ed58be5357314fac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"5cc9d2f30604736b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"0ed1faae635e7ed6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"9f7b95e5d43e59ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"e6be1cad26271bb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"b93cdb33a26b3690\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"edc83f712328d00e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"12b85e51c76a8d22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"950ecc77239272d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"e58e8e557d51068b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"45eb0c55008a84fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"d3463b874423851b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"4a93366868964f0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"ee76b188361227c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"31c0d36dc3955886\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"431576fc29181490\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"545aa11809236a18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"e902c43056ba7483\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"718c336d71c41e2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"90db2f031bcdd95b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"195380cdd0d17582\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"a5b90f41f1597932\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"3e5289a102923498\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"d770affb1df23916\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"1e6ed5b948357bef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"130bf8db275e773c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"5ddc7fc606b7cfb0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"0f40ecd56a745d17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"c99ca7ec488a5b5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"431177bec97fa766\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"37267ccb31b44a1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"bdae4830a7b361c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"beedeb149fbe197c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"5a2c30577a51949e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"057b116140c4c270\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bd113988379866e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"a53c975df97ab1b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"26f62c6ce65c7657\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"03e8525de1590362\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"ebad55b70589d6cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"ed47eafcbc1e94ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8a404e7f70b2cc35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"1d23456abea8501f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"666adb40557f54e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"78ed80fa7744f112\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"afdeee3f38a36a1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"81ff2dd73c924ec9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"a656437f17b994af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"d5f8a4c5a79d4bc8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"e96683e640470550\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"737819e425425f19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"b4db747bfdcc9d9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"32eec145d334acd1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"baea6e0dc0763c91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"cc13c469f3ebdb36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"c7a0062427984fa5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"73cd6683b9085597\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"27258f9ed8a3b97a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"ad0fda0889984283\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"a3ff77998d98baa8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"aa9af5c3d6550d8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"ba3791db57320ba5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"e9150bd34f9f7c12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"e9f8081e1d88d08b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"14d788261967622b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"0e846e60da081caf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"93159cb88562df3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"77de48e1e77d7408\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"26c0ad51a0ab1a31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"1a7687587a448b5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"aeb690eec6c05089\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"f23181ef70f2f2a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"d7a142e419ba7014\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e627ad3f04abc02d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2266f8a6bdb3ca15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"86cc53ebbe444ed7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"ed073d62d2aefe75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"d6e918808b010c08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"6684d5f59a561b5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"94fd3f87c3361fef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"2bb2a0935c0df066\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4809b372f43f20b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"2b2b9cbb27d1a7c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"ee4a458690d2d9e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"da8c06491b21c3a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d5a559a179a662ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"322870b7c4ead49b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"8496e5427474cd25\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"7a4a023d1571b6b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"12ce12f07da51754\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"933b0fb2324e0b81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"130b318aa02f3731\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"1c2fdb72364eb572\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"23125b8672922989\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"695817e408b6eefd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"f10263e25e8f4968\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"6079a5b2833c1acd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"f635abd4bab5d924\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"fd546fb6cdd26c66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"ff7df06f915246f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"bbfe097fddfa031c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"22c1d9ab0db55485\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"3508749f349e19de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"9ff19e64dcabcc73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"ba34b9aa167f216d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"86aabeabf6b2c159\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4f72f5d9bb50f3e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"6fa48a772d24d4ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"0eb12279414e937f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"e562c5d80164d9d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"a34125c1aebf930a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"4f2025f095ba975a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"e0cad43ec7317edc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"d02cab8afeaf1842\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"826fc8908c69cdfe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"6763e933f64de007\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"0463f5d83a37084b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"7f2489a91c2820b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"a763515c12beceb9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"f1eb7666d2bf7c37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"db3a4f2b20435796\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"004f40d18a8900e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"320b98124b3bf3ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"153dae47f8c29440\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"4c844f2bf8f55aaf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"091b7eeb6a3ec68a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"75103797b75067b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"564ad3c4097b08c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"73966bd2fcc27e44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"ff27473dbf9c51ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"fe7f41555662e519\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d76289ca4a8f7674\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0f2ba0ae3d08443d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"626884ecc049fd66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2bfefa86a72c3367\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"86bf6b65016b6326\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"934cce6f50987118\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"cbd369713812e523\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"080804b5ced09767\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"1e3436f1051b7c5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"08889e8c99ca9740\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"138823f25c71b58a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"26a1626a688d7e04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"86a311a04e92e75c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"19cb927e136b7997\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"8180a680392e5edb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"d46e1e80b103224e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"fda049319ec16369\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"be5b13bd0c95818c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"064eea1a33652a44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"3fe6e41e6171bc02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"996f37417af84102\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ffb476d2293c77b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"294f6ec81426bc18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"f6bc94d7103c2c38\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"0a213e4cb80255d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"3011c28d66bdcb48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"90857f91b59ad10b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"a202f05ce872d3b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"e651f6ae908bfce2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"d313f459a4b27609\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"c1fff66753961e78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"337b4b80320e6ebf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"caa5c06cb4bc4be8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"0c26441126d7a5b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"49fa76869c5a917f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1b9a384221d3939a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"26076a5c267c318e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"a7706802312fcc71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"9743f51c81741dfe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"9179ab316988b2c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"a988b3e88f4e8a3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"7ea5ad126bcf02ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"b511c4c8213a6836\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"49314ead3bee6f88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"d74e38d4bd007c4b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"9d4596f1b2722443\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"3f9acfd3198a4fb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"4385d1dcc0e7f060\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"3f44537050e670e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"818f48cc0aa95cc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"a15b05348afd1157\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"df1109eee0b7279e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"46de115a3d9d6f1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"e212308a56de469e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"46e88c54a5481320\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"51fe503bfc65ba7d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"6a5d28ba28ad60ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"40d2e4cc0ede29cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"4063a4a0d9d2a41f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"098438e7efcbe134\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"1d4cdb85ad396a16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ea7f686c15c7a784\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"093b4fd26e52a975\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"1ceba7c6c6680566\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"a70f045e00ff1e4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"f9257a96c47bc77c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"d444b0375264fdf1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"49a3c1a03fe27a5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"6e0cf1751285e68f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b5d7e0adf36410f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"e39afc4b4ecb8474\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"dd93644abedbf5d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"2cdde7726143f5ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4cd1ce58a6085c1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"fa558f9934871efb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"91464a7b68ed422d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a3cc32da0fa7f652\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"913b32505049415f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"1c80362bea5dac01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"41762b57d7b502af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c95ee1d4961ba510\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"77a9de67aba13199\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"9d4b523c61ed4f41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"79028b919e790069\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"ff6a1589c68a7a65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"6f39259a15174740\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"ede6dc6fb42da6d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"a3a996a8b07bfea7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"0c568648f32d55b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"164fba39f0862b3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"dd334e7fc4a6c158\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"99947e5c88351ffe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"e3a5a51efe0ab1fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"be9478398c53cd01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"64f6a2120ff2623c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"b6acf88bf97e51ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"35c410cf4b50648c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"b34c119d08ced35a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"77a275a0ea34b8a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"af34df86c70c3448\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"e0ff0a9943032a04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"17f1b08075f80c4b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"94c3481757f2dd67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"38665e1a2f9a04e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"4f430f76ac00c398\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"46f98fe9a83edf0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"6ee4189d9949bba7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"98b41d86e28c54f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"cd3b7f8ed0b2b6b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"4dda44b0eaa1c596\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"05bf72670a1908ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"f261cfed38a240b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"bfb879607c69a113\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"8d600061867a309a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"cdc5303cf4d89df4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"496b8f6ea2a058fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"f7ade0a9e33158fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"d57e6eb4ba9ac5b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"42d22b107fa628a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"cc36d07af05947b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"70732ad0d8098e45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"b23743892dd84801\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"102254abc82d13cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8416757015779f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"2443b82a3964cd65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"12a1d074cc19a10e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"2bb13a26070fc109\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"69e1102f9996581f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a887e656ff1dc840\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"081566706282c10b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"d3963a22f1e38b86\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"212080c9bdcb5887\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"b6e0b3e9e4ad7344\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7fa1071a87e471c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"716175678a805c73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"1f3ddd0d61afa610\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2485f15f438613c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"04004062e87c06da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2712be590e4e0b27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5d07e42764193ea2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"255a65fb7ba014e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"09c59f2f91bff7b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d0d254030dea9827\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"58f456f6a2fa3e7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"b5d9493647c715ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"f2da798a7fdfb859\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"adc097d34872caac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"de2d79b84eea21d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"28b6d8067306a4b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"30978d40c537d9f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"9084d29ea7b07bd7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"f1cc6b9ac8bfdc8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"3e35ee060bd9120b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"b2c277753e777def\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"aaa6f78234c8b973\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"cece4566dc92bf58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"915fdf7c07c0c0f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"d5804bc6493bcb33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"e01d12b484015375\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"80509463f4257bee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"a3848ed0d557b4bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"aa33729917544a82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"bc397a92327bcfe1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"53b31765119bf418\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"b5fd64ef33bb0355\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"94ec3a946c0cb69e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"bd7b0b05141746f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"1af052fcc17da511\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"3bbb74073628c823\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"a67b6dd72b7f5f73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"f975f85ff531fbff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"32f2d4f8b2896910\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"21122d390479ea85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"2b36948727e6938e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"d521ec9ac1a8eacd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"54eeb6c381d208e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b40cf0c931cf15b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"c57e1f6c465b4e7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"42e582484945f780\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"65f7ff187f8d0f13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"61deeb3a7d685bb0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"b650dacf47c8faf2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"482b0c958d9472cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"3f3570b61e4a9347\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"85ff4d36d33d26f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"907faa1aa074bebf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"b908cf54b8cc4dca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"8139e665a1620ee4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"2c45b233cf2fbc34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"ebd31a75c4143c2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"fba24d7470cd80d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"48cfd2c92d46f7c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"9d36f0a82874a76c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"bdb291a621bf0ce7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"cd01fcaf3ae53cec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"33e779774a0eea1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"4240c58c0d3d16dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"acb164bf0d6994d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"2b32d75de64fd3db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"bb65cb63a75a11d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"b9146480cae1b868\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"044172931fa3ff98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"01a78f230ccc533e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"d667d6e82bdcc1ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"32f78541117edeef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"2855a0dcd184df69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"4949fad705a284fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"07a4e8db5051bafd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"43be0eab9d6b8257\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"3d67b816e21e130f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"0d34a3b3b5cfaed1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"78bd7faeef20dce5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"0930f524505a5289\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"0b5a5e14660ade51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e784091ad8b62a0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"c2f56e7000384779\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"5957088e4da467f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"cb4c987f991b7f5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"237e585d608926c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"6063c7fadcdefb0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"e38d155a96cc122f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"5a1ef9a23db49d6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"65f57f0620b373f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"db08febe7a7eee19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"5ed570e21f550fa2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"848890746801db7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"e062c0d8ab00d7b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"c5098bdf8b96d559\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"15b55ff629839f59\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"e80cca0ee91e5d40\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"24dea2656944ff7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"5055cdbf1450e104\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"e569b4ef07f4465b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"636df508486c6700\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"a6da75def5939b18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"047df7a2dbdfdf31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"8737c7e4545f09a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"54ff8389514e5ac0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"a35ba9889a6b9c85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"56bc39055f184bec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"74fadb2693ed8e7c\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"dfa3579955036232\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"53ed4d249fd2fedd\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"ff35c860bc80370f\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"8a659c65695ef8b6\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"91fd00df26625224\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"311f66bb57875a6b\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"69a7a3448cef7eaf\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"cf3f8d1c0f0b06fd\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"9df876be67a5f650\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"979603c8295b6b32\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"56979560db6378ae\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"ef3726cbac46393b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"09a777d758a74d55\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"137b707b45a4fd20\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"67738484ad3a9f37\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"bb6f70df84e6679a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"08d46c9e331bade9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"5c01941b6b757c1f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"ffcd46c7bed65c0d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"cd48e5f82f946123\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"fd6e43f2b57ed6a5\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"cb3af001457da721\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"9de33cc64ae2d7df\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"fc4c2c9d5d887c4c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"fea4d5d51741b565\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"f98416ec5abb3c16\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"18bed7b45ffa6f35\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"2ed3227119cac39c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"86b7c9f0372e12b1\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"18eb5071e29f755a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"0e78f04099560c83\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"3e4fe685c6fb9ef3\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"9a896a5b396dc371\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"29ff1ab6903b1cc1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"ee6a61429b26d607\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"ebd9ec966e8a21a9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"666855d9cf5565b2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"7be49231d88ef649\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"3f04352cbec48a31\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"c5c0770f58cb8103\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"62d79837f2f8114a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"9c667b2e3523a004\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"a1a80d1624021dfc\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"70e955b0f615aa9d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"4651d909bb5954cb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"3256f369432f4374\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"b2b1401471d7fab4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"560c110108cc125f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"b0a5ede2ca25af32\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"47eaa2293157da37\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"c937a9f1e8eafed4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"de13ff4bfba2b370\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"a9dc64ffa7eb7937\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"26489003931d6de5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"84133a8fba24abca\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"ceef2f5fd0bef6de\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"09f14258384672a8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"2e872105e0031f4f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"3979bb949408864e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"41ec358d220eb882\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"6b1a23ad8edc615b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"46ac764cdeb2f08c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"ebd0f6afcae9e642\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"3c31da5880d81f98\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"84f166bbd614b7cb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"1f7b5697cccbb270\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"f8da3d4c67a7659b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"5c462944ceda8236\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"bd130da95b1522a8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"95b66b3ce9ee4b2c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"34782c44e2ff3b17\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a66d6676a8f0637a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"3e6078f3195b9d63\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e63e106b867c1768\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a85129b7f048c28a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"21c38000df486ef5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"019a2392e3fea861\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"ae562b3dd1f9cd76\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"e41674c9c2cd3a0a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"d5cda91c07e24353\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"40526f91d7ae8a6a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"361d19309da17797\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"ca8b8a0b4edb95db\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"445d61174619bdae\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"4f56708fca28fc89\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"039523ebb057dd7d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"0570f7fa41bb6158\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"7f5a3d1db20cc86f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"33c307ca9803b8fd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"fa234168a4ef521e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"5f5d6a4d9ef1d24e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"c22759600b9d0cb2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"fff03e9414574e5b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"64caf64195392344\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"c399cc1518808002\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"b31ee64ef776b6b4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"2d90325c137736a6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"0c303402e86d22c3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"f54248e3a10fa1db\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"e4bcbb4e798a2ef4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"d7cc8acc36c9a476\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"b9fa2b00f16c01d0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"f916f7523ea67616\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"7fa27ca5d5e539c0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"3c583c3d9f8ecb16\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"7fe56447c8329e96\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"a5479050aae419d1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"cdbb513eefe997d5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"e2200266e920c547\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"b08afafc0c21b995\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"7ad9df25329da816\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"dddf9771f2dc981b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"ec97185326f4263d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"dd71dc4f5090a4c6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"b23e0a53406a5943\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"4c2be5c2ba170f75\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"afbd3aa4cf01d154\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"37987e3f0e145fb7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"85fe473736ef2e2f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"8eb6f147d2cd829e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"d55b94340964c62a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"fa1dbf861c0199d0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"4f0b96fcd4803697\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"66d3c6564cb17dbb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"7b4a1b73c58e7b2c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"7c2a43e1088d4ec8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"441a39c5c0bf8ca3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"ce2796ad1034e67b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"29ea610320432cf4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"17406be08db0f7ac\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"6a619cb67857fc1b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"6fd7ae578f67d129\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"8d8b3ef7d546a27a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"fbe7a851bcd0306a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"68fe7d0ee3fd6561\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"5f2e4d915dcb1149\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"a4e8c5193649a1c7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"bcdbfd9b1cd30c11\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"27b6f5138897162c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"81d26212d5200a67\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"8ee425e7c0fcf276\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"f83c41d03a29eb86\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"91a4dead1bfd0ed0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"31f068bb3be63761\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"92e179e82e5f4b99\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"18afd1e9ca30cb2f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"757783cf95dbec04\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"c1b4256ff9637c59\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"6d2987a0a5b16439\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"f1f5e558c892ce6b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"5875c73db4c673cf\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"50af6c33106d2f29\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"a85a5c0287e24432\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"abff8c215c28de0d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"3a4a2b09d819240a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"1ff8e448c88ed896\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"126c70b1e4afee0f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"c5e19072892e1aad\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"693d15727b479979\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"7e3ed3f7929884b6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"9ab427881a6d4ab6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"0b189374ffcd3486\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"327aef387bc3d575\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"45bffd47e256aa32\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"316e40fee652baa8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"d36ada3f008bd447\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"9788489a7d8e2982\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"3a0ce1f7002661bd\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"a5017b504c508505\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"3dacd1343ae4b881\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"3427e174e85b430c\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"886c1925908b7cd7\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"7a1256993a4275d6\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"c5cb0d94e32ef61e\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"a22f623ea4dbb04e\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"10a8bdbb767e1f9b\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
