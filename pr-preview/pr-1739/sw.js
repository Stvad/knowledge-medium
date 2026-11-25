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
		buildId: "344764d6f9cc-a32af4cd",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"6a582df1c4460841\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"6a582df1c4460841\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-I9wXKn0D.js\":\"a0c44cb3c5b1b42b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"d2c5eb2b722385ce\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-B7XHWIuo.js\":\"02b69303f4c4da46\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-eBDXjl3d.js\":\"a596247650e92465\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-CaMJZ-5o.js\":\"4a229791ac0cea8d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-Cwqtx_ox.js\":\"54efdbcbaa9ba8d0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-V3gfqPtm.js\":\"bb107ac0d25f0d9b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-Cw43-5F0.js\":\"5541dec19fd9a4b1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-FrJJppDm.js\":\"9146507f1309fc6f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-BzanyRTP.js\":\"5f525324801baeda\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-DlnG6oan.js\":\"446e04e2370e59fb\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BDr3T9XK.js\":\"f838b35892faa81e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BRTyVi1g.js\":\"5a91b84f1317c5a9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BeazR8e9.js\":\"c0cc5c410942ea1e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Bw8bFSbf.js\":\"1e055d70da51ba4f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CP9e96jV.js\":\"4b78b4ca29c3b6e4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CTbqu-Zf.js\":\"0f633a565b91a4f2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CpwrQQXz.js\":\"5e5ece12353b8617\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-D1oL24H4.js\":\"b15ca69d216a57df\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-Jt1Ze4lO.js\":\"5e7b4377836c819d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-D3hw1SwE.js\":\"b169474ef98e5407\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-DGCMqB7u.js\":\"7e083dea01b1162d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-cWXD6SDw.js\":\"e2f878efe64cf0c6\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-B58hMAmV.js\":\"60a94be631f64bdb\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-Dy055owt.js\":\"7f616772e0839e8a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"9df3017af6d0ce19\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"cb08a2e4c208ca23\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"fa37bf5d44146359\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"44003cc50bc018ff\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"e4d3ea9ceaadaeb2\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"20425a4275986fe3\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"f85a1ab944876335\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"4484cbfb8e706104\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"656479aa69bdd019\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"054c02046a5de7ba\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"6b9130cd144f728e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"282e95cc87df09b0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"d822defa2436e933\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"64096de07b3fdd71\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"5c7170d13f53fad3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"35d7cb98d9b8bcb5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"9274250cd6972c20\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"c8b6721877a7e6a6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"fee38fce22b5eed5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"338686c6a952bcaf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"73bdfedbfd9df4bf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"edc492e3908f8798\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"eedd3ae279c37274\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"11eea1c316ed3444\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"c7a9797b0d75c55a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"167e14c48b429059\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"1889d6fe0dba2ca3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"eefcc4ea3a6d5756\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"1c9c87d507d28cf8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"8d09b3573c217feb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"1014ced65bee485a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"64ef4b260380454f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"47d2423c2c91a871\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"2f2d78f058f9c6ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"0d4d46e6912ab2f1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"25d22190f66575e4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"bde3aa0bb20dd959\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"6131fd11c9922479\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"c8d3dd2896e9abea\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"2682c0a755f91b66\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"f5dbeb87d61c4e08\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"8735c446313267cd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"49f6979bd5a29d49\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"6d87a683725556db\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"418038f748c3ce90\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"fc4a9bd4988e153a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"d60176ca25cd6b59\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"0014216a1bde0074\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"b8c20cef7cff28e9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"bf4e7eabb3e675db\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"ec34c9af428f3a0b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"60a3e456d123329d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"d9b99cf6a97047ef\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"17f98f1c3bc5c644\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"c25ddc3699f86fb1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"2183fa928bd1ec6b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"a3af7bcbdae75556\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"2d9d6027c870e4b2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"1765dddeb6044e4f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9247b65a6aea04b1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"7b1440fd6977da73\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9eced2b9077ebf18\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"5508f34e0cf529a8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"5e4f3366e8a4b0c3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"81625408e82707a6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"a394569606e93057\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"bea906d868da1741\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"253ccf72df248732\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"55050c80016b2f9d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"53194bbb1ebf471d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"32420d43573e9c8c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"713264e2eea8faa0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"f554705937f7f7ba\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"ea49394f205e77e8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"50f968c2293a9a0f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"3dcb071dadc6ffc3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"58037b06bfc15eaa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"09d0ee3808664fa8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"2d82184ab0d118cd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"d11ee8017ee77fc7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"6e0f81a260d08f3d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"52113c59267c629c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"7e3951d56079817a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"61361aefeabc4da5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"79958f3b65ddb05c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"4f979c36ca7142d6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"8b81c6da0990af0d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"2891555035ebb098\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"64f6210a9298a27e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"dc4acf1f5036a5f1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"70b34fe7d52aff23\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"b86e791cbd1de7b7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"4d8a57ac01533c11\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"04bd27835d83fbb7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"7a7045d7cf3534e0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"17d007a971746750\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"ce567ef138e96eec\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"cfeceee6d5ebb47d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"9b3aca45310ecf18\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"611c0299bc6451d9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"59f82f35840c3fc3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"994ec8a0adf5b039\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"96f63210f56abe59\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"2c653df9587865c9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"efe5aac726987f50\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"015cb6baf5c27738\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"e2eee1733974c35f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"9f02d635234eead8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"444c18f51f5bc5fe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"4db7a8153bd46049\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"94e3136c908fbedf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"3a626613da0812e2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"fd7112f76b6a3f61\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"b11b05424140d5c9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"ca326c25e67d2715\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"e55819a4b2ca614c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"9fc6ed9058ba4bb1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"12d15c8a6f70b117\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"4f3fa38bc373b7c3\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"7f967b7548c45012\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"f3946707ec856b17\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"f3ec827a4838d105\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"0dff38b0a5260f06\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"332e0c3e058c310f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"0efd7af73866c569\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"d1f5fb3671d13a2a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"3743205404af4fb4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"82a240e494b9502f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"4733deb39059db7e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"3fc14ecf3ec106bc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"d8f2a33fa266d0d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"b238826e7dbffed1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"e3d187afe1d77683\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"9bd4af44c73919fa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"7a522ed61b0e14bb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"423d3371379b7ada\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"1383c51826a258b9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"b9b9e617c4916f55\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"db2ca1a5e3df9056\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"d62be3b6c4a37da3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"9bd4af44c73919fa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"9bd4af44c73919fa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"d2689eb15c2e8adf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"59a2bec1dcd0c99f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"1cfb26a009e7de23\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"82499725d59103db\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"e961ebe9ffb612f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"9d31ce50a66e343f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"64f2836706db600a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"521c4b0e712e2dfd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"173cb4625f324b09\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"3ac11a89a8c6b562\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"643eb2e68e3971c2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"c7923e5263bca221\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"75578ddd39a2f022\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"d86b9e27692c1fe9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"3f31da83731d0902\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"60261a2e66117d24\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"26a60b44c6b890a4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"21eb8fab5a15700c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"95cbdecf9121371f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"d9a7cb04e9a1f972\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"665d26924cb5c518\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"29f82e1095b85973\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"975a71421affec96\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"d1d2aef18488a708\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"e309c2f641aa133f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"f1be872c429e4663\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"f2a499c3bb3d17ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"e97e658225aca29d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"44608d574ecb3a5a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"b878807842d19683\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"e2b02cbac43f7329\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"05754716a9b36072\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"ccdd66307576e6de\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"190f60b0359c46ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"81a71f46d303f39d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"aa34814d26bc888e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"c3eb19d2504cc112\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"6600c274acee2d92\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"21b11bfb9f936149\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"1e777bb56106bf66\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"5afeeadd1b097349\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"4a9bd0da26bcd04b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"9cc3e9804c9dfb00\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"4a4f2fc63599477c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"a4831a23a2e2ac8a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"2d8a2a68e7aeda0c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2cca8dfd4f0e9d29\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"827de2b7cd94f17a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"598371593febe5b9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"1d1df74004d51448\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"60a9d455bebea48b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"fbdba73c42d4a65d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"066c0d873ba06900\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"72e26a159408297d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"adde75a98b40dbc1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"9f08af40426c9513\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"4d1f45ba6ca7bd99\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"cae5120ec80505d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"bb639678a1d730ea\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"ceeb9667a781d45f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"53530713e43d37ab\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"33b9e833b989ad97\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"1aeac0892e703abd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"578f42b149f33a62\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"c30aadba8050b54c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"6eaf5b7e66842526\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"7855f09873bb45b8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"2dca88db688a9054\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"6accbfdd0cb4c8c6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"55d0846732acfdf8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"89899321f8f5d359\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"27d13bee9dc19dc2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"5665f5ba1cff39c8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"dff81d3b295a05ed\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"52b63b1b11344e02\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"63ef0e96def20834\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"c00e702ae1ad1c89\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"75f3be9f228e6538\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"d0f63f864c3d7c63\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"21fda8a961cda5b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"2824fe360f3e1e18\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"6cc2f2f42d9e7d0d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"7b8c349a7c85915f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"94c823f7d9feba28\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"ee7cdfe384330444\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"21f2a222b6b986f6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"824d49b543039bba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"4d233142cadcff06\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"aec7160a40be9e39\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"c5a05afaae5c5b3b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"c584b15601eb09d9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"378cbd9f90238c89\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"60e51e40730761c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"a822442e8596d070\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"ccaf91f2f9c48549\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"a7d8a8b92554345d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"7094d5399631ac34\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"ae0ed45e5c932261\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"130d1174c73c742e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"fead8168705d022f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"7ce6f7631aadbe50\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"d3c1c6ecd70426d3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/refTargetComparableProperty.js\":\"8da10c8543bfa892\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"f2977b2a3ed99d13\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"3ca5bcce2cb27bab\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"0ea753e64f77ab07\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"b58e20c3a1084952\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"15bf1cc713644c6a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"038a385475943720\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"5846669ff1fb731b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"9a5136f925d7598c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"c897f30106f926fc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"0d174da70f1d133b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"d1743e9f4fa43636\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"bcd832dfa75e2f81\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"8458e4e9cb307350\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"49afc509d193da25\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"449b5f0b0200ce23\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"3ef984363c09f0cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"7685ff8d1ae82181\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"437b17ba8967837a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"e9c4d126c2911400\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"bada33ce9fa72fe0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"56da65ea0691d5a3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"05fd79e5c18c80f0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"a0fea40736189f0f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"64dd9f5f138790da\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"e54dbeadff0d7d70\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"0e1b3f1a0872299d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"b4cf317a09ff9071\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"017efe5233ffed2a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"b2e0567295ef70bb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"a592a2003fe99a6a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"e1d7c6b7d9c849e7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"45c9967b9db35915\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"8106ebebaf0ae0e9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"a8de240e0b902c85\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"50c1e2fc80249188\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"80cff1ceb402f156\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"3d75dfe281255e51\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"17832ab34796ac9a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"af3976c429ffe2fc\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"4530b6cc1d00e886\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"67ad2355213a6909\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"6daed1d0006efbfa\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"b7be745e7e49b089\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"d7748ab0c775473d\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"df6545dc3ac5a1ad\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"3c4d72e98574d10e\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"6a1effe2f264377b\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"6f03200c54ea6c0b\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"d213bb6d9ec19688\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"619a193b5a6933eb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"00376be000e5960a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"315e4711af266dac\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"32969fc31a11491d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"d86ebd49dbcca583\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"f594d784165ee4fb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"827eb5fa5a287bcf\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"0dbf884d45a9394a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"a74741009141bcf4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"0e65d61109837e39\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"d644f260d97db1af\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"70b6da332d653ea7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"47c43212ae88f0b2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"d60e62bac043dccb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"f816e279d2245640\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"d93b7864b514fb90\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"6db0b9c627e0a5b2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"d1c004743a8bdfb3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"c1397e96dc73439b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"10255ee39d210af5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"35387aeb25d3fc72\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"8f3cfdf9857f6f4a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"9a99b09cba6483e5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"c27c7e8d6501bdb4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"87e3e9b5df90ba88\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"9f3cb6769d185d4f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"9e371e8e49a8f78f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"1baf0aa33e1b303e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"1794c183a54b1972\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"4d00ec8d8a7e7737\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"878beac4c7230e5b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"575bfd5752ec0575\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"12ad38ef11ab8d3b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"1a55fac39b6346b9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"75247535723fbe76\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"08f4fbc73de5acac\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"16265cce336f8407\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"2b9d39a7e4a093d2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"56da83f3694ae04f\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"9de37b9940466e30\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"fcc4ac233067afb7\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"80a62cd6e54ff62a\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"de054f5b30436fd5\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"33b4c3f787a13571\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"4f36082d6185ebfb\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"02c00ad1230420b2\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"e1e714dfe36c88a7\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"7a024f84acb881ae\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"9b3e60b3c7013b5c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"ca9ebb7e53e24cf1\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"c713f8aeee84d826\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"3edbf612f71c472a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"ab9370a7e62e9f02\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"376711cc18107dd5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useFacetValue.js\":\"ab6bdad8ad195b96\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"832f7bd287922dbc\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"acb311dc9d4ab488\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"1f9e82fb5a53eebc\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"23c27312208e5bc7\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"f81b794b4d5c6aa7\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"e4d4908573e44d7b\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"b28ec369a05af74a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"040b782a7d4b8e16\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"7a528ab1645ae7b8\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"5503897e1b1cfa31\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"0b7917a07379c8a7\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"48d58dd5dbfe4f34\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"e624b699d4cde55d\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"f80b0403ae128ff7\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"d3fd57db274089c8\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"f4b67812be6ccfa5\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"233527ce65341680\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"ed269ecf9151867e\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"19481583b25fc3ad\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"80a15f3dba8b8ba2\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"6aa21cab1773225c\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"2e54c025c1b8d431\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"111753312fa2b4b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"1c0c570965e18ae7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"6c018bfcc961d427\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1cc64352ede0efb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"4037e11faa24d2a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"3ed1a77efcea95aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1caf4ef8555f9055\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"fbcc56c04028f330\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7ef2ba607a06c38b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"4280ef2dbf04919b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a3fb706b1e8d503b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"38c2aef14f5213d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"84fddc3795c60414\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c9d876e34e4f89ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"dd636e0d72e526a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"030acf67c413b95b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"456dbc2e74eaa753\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"827a6a05bb474efc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0a28ac3916da3ea6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"a9d2a4d3eada68d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"8e2fae1eb5ab8307\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"9c169e4f2f9d2720\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"18af12ae401033fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f42edda7e553da4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"29861d95aa2193b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"0011cd4b7f81bc64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cd758bc06b0dac95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"b928b06be138994c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"ce7c33e953eb4750\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"e02487dc2b80f69d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"06bde3f92c849811\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"c0ff7466de6d6628\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"cabc770149eae47a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"74f5f6202e740cda\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"c51839d378641e76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"cc5d1fe494a2fad8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"6d99749ab4b59781\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"e1885be3844ff1b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dayPropertyInputs.js\":\"dd1ce43d281ecba3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"8854d9b6b48ceaac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"51f9bd9aa81cee4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"aad4073a530564c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"3922a9ce09184e8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"e5e70e9f0202afa3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"8a730806561fac16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ac0e9e1cfe68b2dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"b6371e0e802618d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"e2ce2380d5b0d071\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"235f763f0977f1db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"b1044f15a0cb1bab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"2b461b5d67872ae1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"9073ddc85a9ddb67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"707329c9aa18a610\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"afbf18c6a6cecf9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"6dffb320f953a7b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"f44f3220ceb10e07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"44cb10dc40d37623\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"211b91b98baa20eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"72e90b35d52b7441\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"2811c10f19dce34b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"8a33dfecb5fdf2ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"14ad560e8661308c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"f2fd652dba1f7679\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"6fe2c9c8fa14e8b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"cef293a8ad4bb911\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"3904c8c9f3c25334\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"aef8896721a8f09c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"69774304cccff83c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"75201f5474ac8594\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"da490c4c188e749d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"ac9b66341d487ffc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"3d20339959c64fea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"9934cfee52dc3067\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"952ec45dec934a52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"42900fdb7004f491\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"090e8fb3587206a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginAnchorLinks.js\":\"b1cd23caedccb333\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"3e3787b958868cd3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"a72b8021ad3a484d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"c5b7efe0d4981716\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"fd8bb95834db7d11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"f92055c70e108624\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"0aaf18f5affcecc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"bc4df6c6106905f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"57eb583e8fcbc866\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"2ee2b8f682813ae0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"780e8ffc772ed10b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"5140c004e3ca8d1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"0ef755ccda68a848\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"8d5a5e0ca257d219\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"7832ede7a2b9c44a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"8e9b9fdc580e26bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"66ec75dd8d3788af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"9c842a466f252874\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"7d8cb9be8e1fd7ae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"b59050b2d18b5d9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"3439b88ba52212b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"1382a705c1d8c47e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"e60cd8f3c631d7b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"abe45d5541ba2e39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"56b88eadc3546726\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"0e2a8a75e38e25f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"6db02f802f03fcf8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"8d75a4d297cb5542\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"a23b22d4fbd8cdf6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"346b27c73fbd3f66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"54a06e05f5232f75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"75a8803ad13f4a65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"aa59937a4946a0dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"62c50e5898cb913b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"779ed5434ffe2a78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"17e99bbb9f046dc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"f73e798fd1732150\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"717adb2115582521\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"e6b8861fc43fee27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e8b2bc7b154ea28f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"c60228edcc25524e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"d7ae736bf77d84ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"317b5b89c47d76e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"ad26d92f8f2c11d7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"ca2500f188367bed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"e9b53db8839e4223\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"9c10e90ec4dbe467\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"286872e3bdde386a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"9cdcdb8bc83251a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"6bc30477c62c2c0c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"e30eac6530049d20\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"96c7b4af574e8e97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"e2cca07d593361a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"3efe4b370333bb7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"dc12b7fd227d6cad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"b0ca5479a206d20c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"d56d722e3bbfeea6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"0bd541b5b476a73f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"899e84bf74c55a94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"7dbdfcbeba6e6d9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"0b559b02ad1c0f79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"ebb87c7df69975a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"749cb59ef49ed740\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"fe4f4e352219a3a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"e88d04556d26a347\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"566def39148cebf6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"de8cf655827cc512\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"766824883c9a17e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"82195778c4fe7c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"346252b0ea362936\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"0bd0b79ac44c9b4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"c333103ed594a8ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c46d0ace2db0ee35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"75f1906c4abd24eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"44825b15d7388268\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bc46b9e89f5301f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"3ddb16f78438b4e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"0a5e8398836187f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"813f25e6e7dc541b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"5888a14629d61b3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"0e0c663e19caf6e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0f50acf8c89a329e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"5f2af4098ca9664c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"20c244ec1d24664a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2d10086c326037bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"b14ab2e375fbac3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"46425fd35e0c5394\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"2f3d849e4a11dac1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"b79eb7900d28c1ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"8b5332689ee04300\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"ebc4c5347570452f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"b91450b91f9cd9dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"7ff5b660da050405\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"36c5333cd90d4f43\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"991daa4cc2319f5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"70438949d471636a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"84f96da1629722df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"665630e0d5e36530\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"bb407b4099c4886e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"0570f2a99d58e4ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"7ca5d331237304ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"35b0d086f949f82a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"4181fcb6b422c4f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"52026cff5653e95a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"a4b765d2e1ca5361\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"9031834e4959d049\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"7da41b96bee9bf95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"314f89220d995e71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"bea4052f7ae1ea10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b918ca9daa3f21ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"529bc9cab871e9ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"056ff8d131e54496\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"ff8661f921e4e1f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"b2519495a625115d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"d9fce822e7a15fb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"bb5bdd89cba12668\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"cda2be87161488b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"52c2cf60347f1cef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b043bf61e9bb4b6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ccdcae215dc92ae3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ad83bbb90efc4476\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9aac84374eca5a97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"553a63f3cf4c2e02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"044c9fa56ba005a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"9eadb3eb48c3118a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"488e48d2a7191b7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"60984aa50b50fb10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"27118e17357efda9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"395c40966098450a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"b0dd9095dbdbded9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"85d92df93f62f8c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"9c38385718a30026\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"e1562a1c1dbfcd1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"0c87251ad9bbf8e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"8800782a16ee6976\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"44e0d53eb83a4c41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"89424a7c26a49bc6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"27f9a947cf8e3b95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"0c2650994c81a1ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"c1f9b941ad81bcc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"a4de6f38edce4ddf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"ce6a50d1637b4b98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"6df40ddae7166a08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"c62dbb17dbad42c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"73aab8cce2f58c3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"605e1671529b6017\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"57a0f124adf190e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"ac41864e3e44c59d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"dbe8e7ee2b00b5cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"4292102078ded0fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"ccf4b7e9a69a1c9c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"0a73256131fa9278\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d406083d5cdb2520\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4a932690416e8c85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"d2f047a315b1e8a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"12a90b90d32a965d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4b56a0aafd84aeab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"0a63092e3be7e2a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"2fd7a79ede928721\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8ebc6ccd5fce7b11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"e78b9e23fb7b9bc8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"2aadc99009390d78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayPropertyEditor.js\":\"f566dd320f531577\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"6c6160eb7dfde8c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"a277b5f8836422d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"09ff752cea269730\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"52951efb529fe9d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"8d5aae9e73f1f3f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"7c67673072cca2dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"5fa6902a545dee6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"62eef4d2bc52ed9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"92e55c43c5eda007\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"47ddf3c43f7b5cd1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b915d70f196fce1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4f0becec531ef9a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayProperty.js\":\"fb445ef1a6c4c7a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"c6c2b38818a32be8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"d61f558f28a628d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"c90bfb17b2f2b388\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"b306855284c43682\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"edfd6f9c6927f68f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"59159002f1b74007\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"f848cf66dc68bb95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"0709e4dae47f3bda\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"773ce031382a1574\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"dbfe96a9bb86be6c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"4c497f1a63d43a15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d3dc9b1066a8a57a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5132ca40834272be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"e3018a48bd7baaca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"a02feadab5f72dd6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"730ab23b7512a035\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"c2f7e258ad1d345a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"a0266a167140c7b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"a3e539339e2442ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5e3ececb380d709e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"9173176d041b4b8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"ac929655af078fed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"19db46ecc0f9edff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"f17884d30904aa56\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"5cc8fd21a5dd7bd1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"729eda0ca0e500cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"16b64eea8e0dd855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"43bb8584afa760f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"de22a2d9a5f577d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"c250d71976c8782d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"5f97abc7304f36ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"e8bee9f2be8b2e3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"d89099248527a5d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"81ae361c8d42bf5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"3fa8145952dc28ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"5d31a6f37a69a31c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"63319f39701d7d7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"610d6b6c4f5d884a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"1a185fdd21dd77b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"126a5c868ae81fee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"647e5a6cc32be702\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"73fb318e51103097\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"192cbeee0f704e13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"57d8af0688089948\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"7fdfae5c6fe1a1f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"eb0af88e8472b575\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"aa11f757481f74b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3bb09f02ee0be67f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d517fafab9b5c8dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"6b6011466b904b19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"1e43359b3795d18d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"2fafded5c2fd3526\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"a37c6461a4b7f8b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"ddd5f74924ecc74d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"fde9435cda974fa3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"615adf52acf4da34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"a7508b71b72912e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d4070d49348f19d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"35817fb0d888db2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"e20889e012900704\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"ca697e9d3199118f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"292fa40450a7497b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"aee11c6bd71c340d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"f358653dff4d0035\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"36bb9bbc1af1616b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"57fc4c24227e074e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"2fd79b10f7aa835b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"f599854dd5f88ca6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"217b66d2fbab6cd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"e28eaf85b6e0686d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"d8ff90ce51ca30af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"283e295f70e6829e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"fd77b8f57d4832a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"bc71bc3fe3305e35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"3d49286e1222c250\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"7f903e06b3dfad1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"27f859109ffbe102\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"8ad30414f0f0914d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"f85e6b6dbe33d212\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"5d5998775009845f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"876129ed101a4e68\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"26399c007a4cd7fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"04c707f5a2148839\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"64dc9f2a2d145a98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"b4747eb37d251141\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"deb4cc5635e8feda\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cdb486a109a26037\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"252b9ab62ed74c85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2750ac860c4b0b21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"5a98c0e23c5911f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"9bac88c2ff8e44ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"53c9acad846fd266\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"477d7f4a316811c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"8072809f65402df6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9ca5fce001d5bfca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"4838c393fd98d21b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"4667f30aff457094\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7c08c52d66f7021a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"db27ba0b6c0c22e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"77b46c9d6dcead15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"fe7a2ba5a04533ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"858c926fe8df5aaa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"c3e4f7e98ffbe4c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"90de4a738101c8a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"1af55a611e7de85f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"b681f0ae2369958a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"6267e27cfd5ae288\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"78983b786b3b5c33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"4e0dcf22cfaddc16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"23e598c90a221612\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"c56cf3771c26da98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"37d20b88bc78cc53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"4a352e5229a680bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"4ee21eb366a7d0fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"fba7a3dd039826ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"9b0742abe7f8bca1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"5358196aa9722617\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"80e0660f009ac5ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5e1f0cf03a3417f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0a7b6760fca91c37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"94faf01890e103db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"49931ffc66a1d902\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"fdf5bc0c733c937d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"fac8dd7586fe6be6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"9acce8291031eeaa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"e50e10a6941bfea9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"f039c00797376e0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0ee7af85adc6d1f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"bba81f9a307cedbc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"f081669dd7cf48b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"b9fb8d55d2ba0a98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"a5e36c88586ccd2c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"6432e57e7447f6b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"cbcc6fa972238a3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"84ca80617a539c34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"6f1607476a563f02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"e11d50c4dca65bf2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"cbb624b2696cdc6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"42b71addd0bb4829\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"998697feb7b4bc62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"30696869d83e2d77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"48581ecfe9623595\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"52fac330d7779a10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"06a5c8cb93545ad3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cb1fc81ae733a557\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e457dba9f6b9b27e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"dc2a98a5dd1018f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f2d4b887bed3c3cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"8053f88aab2a72aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"151f01c7470a8b0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a850b042b557ef17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"5b284775983eeda1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"be359661ae926c6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"25301bdb27758b83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"f6869b084d09b220\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"5c1bd6257b7fce49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"c3c1e8fb510b5970\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"fca856906f26276d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"4308c6f36fe0167f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"54c4572914970309\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"2fa311c3056fee65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"c11b5fc07c038b0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"1b227aa114613ae0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"3834ff83da2ca698\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"537bab6107ff53e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"70cb53bfdf28c6cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"38ef6641efe097b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"ebfbbce2ba0a04b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"8dd8f9a471971240\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"74402b413f9032e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"017a6ed7c71df677\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"f9db8cadb989c5ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"6f0ac0736f362998\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"70349670f5acc406\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"0d6a9c663c9fc577\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"327726b0cf96ccae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"ba23313c30b387bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"f0735f4c901bc13f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"ca42cbc0ee4c236a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"eee7cad9f78ca1e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"a8aee8c275a4a7d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"4a607d47aadac2a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"1db45cf238e7d78b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"1e15c74644f1f6f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"7fb86c4be9431200\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"6c1b2ab8f7a206ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"f1546aa66315ae2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"7d5bee7f89e0b9ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"931fb1e6e84d95f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"1dae3b23d303072f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"a3eedbf796c997de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"3b232992af2d63f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"aad05ae110d8ec33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"da2bf10357d878ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"27b1b7234f067b96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"6bc4a2eecea6efbd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"0ceacb58833b5c4d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"ab613d5497b8df7c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"00858121ee1f408d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"38df0734127b288b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"90af476ea649ae01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"6447ca38a171b210\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"61c15e5bd3322e09\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"8fad81654bb386da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"2d2b38cbe43c7ac2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"31bfceca36b86e5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"37b7a043e6e99921\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"77994d10393bda83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"120d41874be478cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"826b8de51e16e900\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"a88558784beaf41d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"b2021587fb044a92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"7e1f36ae8d2d00a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a68ff1857f60a7ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"0b4ca7eebf6703c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"280f72e9c59608ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"f3846ccdf7dcd814\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7b6bd0d992cd04bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"7a354e5c190dc256\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"a8ae125846a81edc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"11fb126f0d6932b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"58e2a424e95d6a5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"055e559d0e47c011\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"637a6c99754ec6a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6e916c5ffd52417a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"618fdaca35d0e4a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"eb46a810385c29f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"042ca2a19a2fbdb0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"4eaf9e91bbf6d310\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"44f86257a3b901c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"61e4d6837574bc21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"2ef3de4226fdc004\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"b173a2c02f820312\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"faaa546c73f04804\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9c65fa0d80f5b290\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"1028a6db975d7485\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"44006eb226974e05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"425b326cf4babac2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"7e21067819c7e2c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"fb70c3c6bc89a249\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"079329f748ba0989\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"3a32a4acb928d4d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"a6e06cacff6960eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"c389098d31c33e35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"78d20f2ed418ba0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"d1113ff3f2b716ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"fbb54fb93b8d11eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"d568196b892e8027\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"94bc624380b89a99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"fe4882d4e7d45bb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"0ede13c421a3d7fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"84a26cadb855e476\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"40f0c842906d9ac2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"1f9cb54ba0749737\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"61910c6a4960c4d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"e265e5e16ec64ff1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"683a6eeb8023650a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"cc03e1bbc74ef579\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"a6328d21704c2c29\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"df64d9e009433e81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"8d23a51b7d3b0620\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"5dcb46c201fe8e41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"6499cfe50ad592bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"7f4e412360a70478\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"76e19662c7efdbf8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"e4ac5ecc2d63b305\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"1347b2e99d1ae1a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"430340c215f81afa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"b6a5516d424795fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"a5e8272a72e73bd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"b8a94e8aa30d44e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"7e1d663b5490693e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"052f480df1473db6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"3924f855447dc3a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"f21582feebe7a47a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"9724c22aca2f4d4e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"b66662ce3d6c12eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c6eb5246913116ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"bccbac0ae07bb597\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"224e2d6ba1d1b26e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"aceedb92fd34cf1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"669adf6f06641340\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"384213a2ebff2793\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"734f0fecd57c41f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"fd25b1410d0ac545\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"53f804691a425356\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bbeaea45fabcb934\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"a197b9339b17b828\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"bbdeb0ce9a3866a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"d7b37509e0eb0b5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"a0ada29eec6976c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"bccb5eae1964e530\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"452c3f3a6d489d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"ca744e9a9893e2d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"e2268cf9abf838aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"b58bc588eb7a13e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"04c865b980e576cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"f52443f91072bff7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"7fa782fdd62ba168\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"1af705a5980d0280\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"2229fdb44fded051\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"8492796ff7c2ca21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"5ab73baa8e3969c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"a390829dfe3c3d4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"aac4682d50451ee6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"d7550ac54b3f16aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"5adfb478dbe33e6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"755f3ec43617896f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"e4096148a4934832\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"40459fce82832d72\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"4c6fc38fc75950cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"0688e4276520ee2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"4d12384b8abe6d3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"90f360ad5bf75899\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"c162219dea6a87aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d86755f50e016b1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"b574c811236a1017\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"155acf180d40f557\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"0011cf7f2ecad102\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"2ca1a6838a7e82b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9f02a3adb7793fcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"37dd6780b62cc037\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"975827530c14f109\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"e973771473c0bdca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"e45faadf4b25aecd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"a7372c466ebc8ad9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"fcaa1a5b8f8ad275\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"087cfa5ea5ed7e8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"8c7a09b26a5b7024\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"e69a934809a2eac8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"68c39d7d46876d55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"5aa61cf528dc18bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"d5f67d15be2f9015\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"d6e79c8faef6ac2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"38622946312a1510\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"d65247078a9eb20c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"f81b2fc01d83b024\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"0ba385b4f2b2a7ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"50ebe6de0c49e308\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"2e9840c3e1330587\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"659986d7da3fa454\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"422561c31e14c614\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"8096dc9e3db0de71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"9d069f6a51612db2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"bed2d61103160465\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/registrations.js\":\"f92ff4981827ad1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"28b997953e4f0065\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"15072212da8418d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"c75c76fabc44ed49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"d4876450b2d25e35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"dd7e0f734078e016\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"9405f9b47593e250\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"137605006048696e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"624a5e22f630f7b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"64d1a69dcbe0351c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"b7d801c55d3a4cc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"97b2a247cb43f308\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"11cf70b863f6c337\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"4ccb2acc4bbb4c69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"eb4dc13fd6071bf5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"5222602c28db71e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"af30132f52e04bd3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"940fdff331b4f325\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"a8b305c784162f5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"8a14beb75ac0af22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"80b98b92cc85e37b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"897b17a25cd6d040\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"e60ccb20b63e2eff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"91d8fa1a903b1628\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"39a366aff8df9f17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"b6730208e74f49ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"ef22c657827dd749\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"2576f7e60c4d3787\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"6337557d0cddc78a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"53c0a3132f88befb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"34107741d0672006\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"2c1aa25911397268\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"f162a01a799d7760\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"27fad20e668f5702\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"9cf00853651f4622\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"ff6d2fa5555be666\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"cc7dc489146c3d55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"5b9713fe1e3d07b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"30aa83c158ee58ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"401c83776b77e47e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"deaada55e8120cd4\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"0d9988b650890645\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"0add8e310bc089ba\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"ba8463f07084fd65\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"920e7d1a1fa55581\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"990480cebecdabba\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"97f6bf6d3a1a45ff\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"f54d00ed8e9011b7\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"8138359571f6724e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"3ee5357b58b5a3af\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"23c890c0714c2964\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"8c9890def9834ea1\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"a412004b38c7f71f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"9ace6dcd4039c6d1\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"d5ae0cf132dc7c60\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"d5f7c249305a50b2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"9f3e46a0aff753f4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"1ae90ae951bd5916\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"83994e2506cab65c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"b5cdcff7be5de264\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"cdaa9075690829a4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"f83c4aff068ca71a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"e797fff2a1308a8c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"3ba9833f7f25efb3\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"f7e52eae3edb8c0b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"b05f22295bb79ec4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"f523f8824cb3c278\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"88e58a541fd0b33a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"893b305699038dee\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"84cd9e79cc729576\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"224cea37be553493\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"07d1f2530aa890e8\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"5665f184160eb4a1\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"7ab6129691019d90\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"da2c735c9608b69b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"f5c70e57a07b2168\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"bbd461c8025ade2b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"daf5c646cc323934\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"50ae8c616f1712c4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"d4f258d4bc117294\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"7edec675b8c56a47\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"36b97a159c8f41df\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"2f807de0c3f3533c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"4b51f6d1d4a30a34\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"3c5a49133c7a679b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"b3c3e696bbade42f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"23b9df232eca8dae\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"ee5219d4aaf446ed\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"39e4d8f50b3852e0\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"c0e9ea9ebba2da81\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"52bd7ab28f67769c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"c4c28eac60570e09\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"2c2c00d6107d0687\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"12e51c3fd4ba10f7\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"d059e1d780d1763c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"a5ceea154fe4a89e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"067a2b2e96d7ae4c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"4b4f63fbe77eea76\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"98e11cd62b5461a8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"a93ed2dd3aa2768c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"68343aa17ff01cd4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"d8af3c5bf825278c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"3a11f4b7ff74334b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"c7ca71dd37bbe376\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"1a19e27b9bc2e111\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"2f4b71103ea6e69f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"87db797a0a828b0c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"dd5aceccdbef5bac\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"4e8b8225ebcdae0b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"ee63f1e1ab946b60\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"756b8032cc5906f9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"ade4602954e5aee0\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0921d63bd85b9dc0\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"a43db5a678448cc3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f2cc455fc65fbd14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"60fab37c144de7c8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"13f0f840cd79cf02\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"b39609140db590dd\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"714ea0553715fe35\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"e108fc956195d3aa\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"483e031434eabb65\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"e5c41a6d72dc3f8d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"c9e0665c52f3ad46\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"49c3d50263e13f53\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"c5459bf9d6067ca9\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"2339670f060d7da8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"48199a2ef394f91c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"c09664ff8bea0303\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"189fd1fdf0e10e55\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"8eae32e6b4f827e1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"03790c466333af90\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"a985f75d436b803a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"1e61e415a82f8521\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"6af43c7ad214a48b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"b24c6d25a25eeb20\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"dc4c4e6c3c017827\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"2adca902829cc9ab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"55c4eb726516223c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"d7c7e9640be12152\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"f920854b4efdb6b1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"683801c1a00a0a30\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"1746ecab0b8b095f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"8532e8b04edd6c86\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"c2c969af81fe78f0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"6c147b80e6e47475\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"4a0d8e6e0bca653d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"05408eab6cb11f85\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"305d7c218310b208\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"7457bc95cb8f7c86\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"fa4fba48ac8dcd42\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"c46d83a689023f9b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"3a14b31bcca34bb6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"99fe85fee7146b96\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"5a0a051e7c9ec94a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"7713ca3ac31a16f0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"973daf13b411bfc0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"62a935e61916f927\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"c023ccf8f19941bc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"33c864873297f4e2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"667e231799a0c197\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"4a9ea53bd978327b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"4e5442a0e8aba42f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"78c296a5c99dd72a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"abe0ec5c7e187660\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"1a2acbc9d0a679c7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"3e149f01864b876e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"79f7d22d6f0aee1a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"ee7f0e4b25a2c1ab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"2fa6df631001e53d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"5176df1e4e27df9a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"af3c2d7d029a599a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"8a15de2f11e7e96a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"2eba157586619bab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"8c57ea0ca1f8fd77\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"ae94fbdd6110b7f1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"3179706c6d7d97d7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"7116b1873696c147\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"a40d4789ddc05d6e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"e4d242eddc9c2d96\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"04f0b8071a31da98\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"3903b26dd5c9cc1f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"7d1ee3819d180166\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"7685697e9b1ef99e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"2860b7d21451046e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"62a2e41c7973f7ad\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"ba870b1b6429c481\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"3adae836d2994638\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"fa924ce7f635e9d4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"a45a525818327bf4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"6c45919962030017\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"57fb0ebe88b34ea9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"32782defdb9e1160\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"91a8411f21e63567\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"67ee9cf5c3874dba\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"8f6ecc5a83022142\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"971c880fd053b649\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"a425d18a63ae7250\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"d65d7a80a7828df3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"50d1951714258d26\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"fbed23489f33a6ff\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"823a347667561611\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"7c3a8e3de9e66d18\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"af76d796af58817a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"374de7b965164956\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"f436b737b18ec1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"ff3475b7b7c49925\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"32850aa09202e6cd\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"3ba5b1b10b754de6\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"ed2f169b4b6bb7b0\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"49f9b180d22d0e50\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"23a5741f65a32499\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"0c2b16e2354fbd52\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"75ed10a0c9b0a199\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"5e76ba2999462054\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"17d46b967bf0474c\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"99112d8ae9a82bf2\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"96b01b62e46c4d5f\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
