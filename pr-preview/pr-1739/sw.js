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
		buildId: "c993d8a798ce-40e28210",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"ab0e441dd0c437ba\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"ab0e441dd0c437ba\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-B_hd0DV3.js\":\"eb1547e3caeb2684\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"bafec9290a1947f8\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-C2DnY_lp.js\":\"a72e20383561372f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-CXOgJk_v.js\":\"c052d954d7ab737f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-CcRDxG13.js\":\"0bcdfeb6cfa178a8\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-B-5IaNzy.js\":\"685f098197a9c656\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-DVr3ijhL.js\":\"c5dd2b0eb74bfc5c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-AtVeJYgT.js\":\"17666c548338c5d0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-BNl4O2dH.js\":\"53eedbb34be30905\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-C0hWEpbG.js\":\"10e7f3deefc4b806\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BFIlsne5.js\":\"f81b5b8790485e81\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-0rnIe8I6.js\":\"bff700ca5077c9a1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BIF3qBpa.js\":\"e35118a80c383f52\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Bg87LiiF.js\":\"847047a4037b9071\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CQAk7lzM.js\":\"fcb619e9e3edfd67\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Cg-_qy_P.js\":\"e5363d4bf83d3601\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CzHmhctj.js\":\"f181c6e12e10f442\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DDB_4TCk.js\":\"2e6c48671022dc06\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DPaHYb2k.js\":\"b437c85c824f779c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-iYpLVgKF.js\":\"ca4b730ce3497985\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-DXjcnI2Y.js\":\"81b6128d309c6044\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-D8x36r-X.js\":\"7466695577ad8a45\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-D0-2Hl8r.js\":\"e54e69aa6733311f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-Bo_7KX05.js\":\"22b21395bef48359\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-BfkodyRo.js\":\"8f4303ec63eb0ef1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"e888869034e19e05\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"a54d3540ee23bd13\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"99fb6dd29c8fdb83\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"12c9c1685f89dd7b\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"cbcd5428a5acac5b\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"97d78f6f55738417\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"2a4af059b36675f2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"bddbb9b71601c00d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"adcacad0ce764d44\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"cc0ef85eba42ec08\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"8f7f5d5417592e68\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"c2de711210e1baaa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"2c97ddbbd6a3d95c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"fe7776da053b6c80\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"526317038053dabc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"679491457fc0e127\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"20eaa95bea642808\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"703f30365df10c18\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"a6f8f5b9ccef2e7a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"2559a4f49cf35aa1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"d0c7c1fe8160f848\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"620901d6b92dd178\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b82e32a367e0d5f3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ff491f80bf757497\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"a64d9aba83f67e25\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"e07fe70e4175b983\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"deaeba313dbe6a74\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"27b4edeaf28ed0d6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"2c488a7f8b168222\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"8f7bb23c0ca553be\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"721e173ec3a1f52b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"3a0ca4d3861c787d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"1a3325048396d8c4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"a32bdf6800b76599\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"ca2896c94c34fd22\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"338ee397d62075b7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"73f700ee35d6225d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"637bc53b7520d4e6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"fee8619d885ac39f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"669279b8ee07dbbf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"9fc250c684bd04c9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"a237096a80ba9052\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"860435c8ed8e0770\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"099e229a63c63d77\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"9613976ff266496b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"1de9da7c3c71cdf5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"6581dd4979712780\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"484ca1eeee2a345e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/CompactReferenceLink.js\":\"3122c249727d5cb2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"d38249f8e5f958aa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"ef59d8ad671c84fc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"a6861f349eb37fd2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"35d5fcd131cd8839\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"18c0c8684d603f3d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"127d76eaecfa9e86\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"b05d715ff0ef503c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"c95fac4008cdafc3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockReadText.js\":\"74a74bb7be0b724f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"6ac4ede9a0df239d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"eecc73a7fa822745\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"e64cd62a4bf82615\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b7dbdf313ec87ecb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"74ecdcf1854c83b6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0024038c391b4b6a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"ce4403c5235b0030\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"ba09f4537080f1d3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"979ae7f0653aaa68\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"00bfff3a1cdf7bcd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"d9bee8b8a774ddc2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d7ffe2bb4d1fa8f0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"ffb252db7e922df8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"a4b1487a00f078ae\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"3e91a3828d5b58d7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"0467719a2eccb16a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"f6641a1f0b79498a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"c43017cd304be064\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"286d522374e6a633\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"ac51147b67b1d25b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"5b3e7969c67ea908\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"c503cd3851113b2e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"853e93739b06e84c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"98fca538ae344473\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"4589a83eff05b7ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"5f283ac23e902a5a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"e60ff31d124dbde2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"047453c15306b20e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"68891566709b6aef\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"e39c90b25094b2c4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"7d228d41cee96ffe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"23897569c9cd0f01\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"ee3299cf1026aabe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"8f157ec162cc3c49\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"efe189dc33d809a6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"6ee028cfd9104de3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"157e452749905d6b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"f0ee207b2d6eceb0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"3cda8c8f7991bf43\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"c7915d5095d6ea4a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"5bc6970985d6c3ef\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"32c0873da1389ec8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"654e28396c9e2851\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"ca3cc41705a42298\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"710e7666cec97f51\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"9d6632e717b4acc0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"6a1662057474fca5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"1fc4fee2d3f72a0f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"3cd6d4e992a9b091\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"f80b509c7e87c4a2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"dcf8c62983bf0a01\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"e2dca85e02fa6f43\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"90d7ae69dd139e37\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"e743ac852c3af2fe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1013abfabeadb984\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"11e9ab195c4fa2a4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"1ec26f9844e52d3b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"2bff1e849643ae87\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"bc45fb677b177477\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"73425864396d7fb5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"31160a388e427247\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"647507d7858a5c1f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"75509f2fca1c9001\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"d2156d10999ab6c3\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"eaec5fbe7e31e716\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"3a0ba60bb1e214a5\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"a4ae45e7764be2f3\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"b54e53940788f8f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"885ae4eaef88fc36\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"564255cdc4af7d10\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"f7ca32200f207b58\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"c1e940d70c6cefc5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"3f82d7bf8f440c47\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"c3df69087055d93b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"bb10b8fc7d9282da\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"32f95f8e7815df47\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"f83297e3ba58bd1f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"965a052ed389cd3b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"ab693d52b8df2473\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"c36f61fb51f82bda\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"331a74d0e8dea72f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"21c511eddec0850f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"09f91830bcf29ade\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"96486619db562ac3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"965a052ed389cd3b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"965a052ed389cd3b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"b0b66ed2e88d7664\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"a07f66ffc1d9a95e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"3b064748d35cf8bc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"2e19427dc00c9444\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"4048e2570f516ddd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"d96a95497d7bb36f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"505e5e30f501f582\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"fedfb93bdf702f1c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"d9dff7ff0aa82442\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"2403cbcbe4964ecb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"d9ad2106f5ba7cc2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"1ed699072080ae05\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"8c928aab903ae935\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"587b6076ad218ba5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"711d22490f074e35\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"41b5c3b119f2b6ae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"d5327475710bf8ea\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"a2960a8750a3ce43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"428c8f8f8768d8d1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"492595d7c6e90e97\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"4ae5af231981a667\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"cd7d5388935193bb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"cd7714d8ea7b8bb5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"2e9bb3f19fe5db9b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"f91861b5434ee584\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"857adbac736db065\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"90a341876a80a11f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"f6c5a5d943700ba2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"a233d66318979732\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"ae7856a494a60bc5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"3e8f9fee4c504227\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"e0c19cf5bba087fe\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"80a77873e0a89173\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"ec04e37a5a5e50a3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"ade4b470c2924c08\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"ef8bd0ae0b69eb60\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"d8bcdcd5dc65c3b7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"0032c540b60084e2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"5ad0696e4dd535e3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"25e61f0dbab1640a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"8d640d590767a492\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"f5262a531ca15863\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"d49391ff4b4f7f5d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"63b3cfc319121dd4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"f22ecd1d7e9558eb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"acd0a4887a958c2d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"578d7d1043926c28\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"805392d2efe7355b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"13f9f131602dec56\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"4194229ab9a670a4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"6d3c7923ce37bab1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"78363da0d57b72b7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"013e0b0f019efda8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"53fb2870b84b1cc4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"1b924077ddb6d100\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"f386d0aaba65b0ee\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"686e72c8d4bbad40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"1c1a4f3e4b21c311\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a7da540fae0712ff\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"23974ccaa5c4b325\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"1cad28dd1ecc927e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"629aee8fae611703\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"c0d1523ff603c333\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"55808fd1406759bc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"1e9665e9b1934cfc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"29fab17c967d3801\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"175266bc81d89a72\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"7f4dbd4e140d7c6a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"3ff6b34edfaafb8b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"bff66e0382030076\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"c6114dc7526bd540\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"9284f6affc2589f1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"e70dd5feea6ad5cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"b9a755b1db922976\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"2ade3ff1a0d03435\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"aa42b0d38e936fb5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"e0e500fe702b6c52\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"94e4c7c9b320b8f6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"c82dbab83c134cd2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"928aef2d1bdb9cd8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"1e6fe1d07535fce1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"9494d2c68da494d6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"336e523ec1046ca0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"58f4789e1d079bdb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"225ad1cd6b53950f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"326a72b2460792b7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"c38581a730c5f20a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"c527564d79bcaead\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"c9ffa25a8f683e2a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"b9c84c9bdbea82e3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"e94056ecd56597f2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"be7d0cd89c713c21\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"172a85a68c13e4a5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"913aeb1d47f667a4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"0450a57475996c29\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"a320ec51855d1494\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"02f2f607f2524d50\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"bd4000056e8fdfd6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"30c437aa16af19f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"7251997b89bd9496\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"42eb13415000468e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"004438152af449f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/refTargetComparableProperty.js\":\"b12580b167191b0c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"a012f8a5ebed9097\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"75e34c9a12b6dcba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"c0e482d5e48d0dd3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"d5dea70b1ec635db\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"6ac6ccf07fb74390\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"9a4be555b2581ff4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"363eef394c0632cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"9da87f68e6ac5d26\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"9398c1b260a2cea9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"d4e4236a6366f315\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"6c9ee9e5a3f9f3e8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"0d410b77dd2a1998\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"27ce63305c0246d3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"58df993ba3776ab2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"2d4071304196e359\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"42204da68f03df04\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"97504c7d6d594fb0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"234c2c14c0a8e4f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"42d6a11c17b2e54c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"bf35c74c56fa764c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"c978b1490324a0d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"ec8ce41314fa0c43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"29271683c7f79876\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"b27af60a1676b727\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"6347421d8f0627c2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"daf58a347b1c0309\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"c4a84dc40a0b9267\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"2a423a70043ec74a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"1f97a66fbacdf9b0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"1f94d2f210480911\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"3b6f5c5f467edef6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"2c5c532765b3fd98\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"6bb78ebc4bfc2829\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"578b79da6e32e498\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"ee3e6122c039c690\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"ac2fcdf7950f03bc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"d83d31bba1c7775a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"47c3b340c1a0420c\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"6bcaf6c6d610faab\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"f01462b457db46ab\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"f08a8acc3116e2b2\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"e75f3ef3c27e92b8\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"6b868a104b36a0a9\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"d1e99b1c322e3d0b\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"3e9f38f1056f223f\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"7b55a448ee2bb58a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"8d1a629b28cdc451\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"5dd8f35eb73a1532\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"0bc763926d3aed85\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"9786060ccc36cb23\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"1aad6d09e9e4b5eb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"2a21a1475a264618\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"06a28f8c18540630\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"38220e450ce19af6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"ab04ef6d8e6feb9e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"30a189349781e23a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"1f7a80239d712bba\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"5158fabc06a2bc6f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"5e476ce12d39576d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"57f8d7464b50817c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"852f8b1fdcb501b8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"d8617896243ad627\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"dd51b664b52e5905\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"0dc0fd6a826722de\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"8564ca7d2d83c3bf\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"2f138cbe9191986e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"97e3b3bb9b64adfa\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"6f3b928009a1ee34\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"4d4deeb5ac8d7496\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"a91f19489b7dafb9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"ea4affc41ddddc71\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"599b9d0690cb4c6e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"002adb30b225ae14\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"2a5ccbfc6dc0cfbc\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"b2f65e86dbcb62fa\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"b87873a692ea425e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"7846b46e3f151d1c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"90a1276416205f2e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"b98786fd27b96f52\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"a2a7069a393924c4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"b40408aeb549987b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"5c2473fcbf86e5b8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"427a08300544ebd5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"b24c98f1e63d9f09\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"f0c27f8e0b88c2fe\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"a584bf5f82ab2a84\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"692efd6fa1088069\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"dbdb85940162ed46\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"dfe76331b31b1030\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"16135f4ce063f329\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"eaa1a4fecf11df4f\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"97cdcfc039e174f6\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"94eaff0041cc1c9f\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"6d1834296f679b8f\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"172b137a19f9da0a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"8988db90433ea370\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"d88b593a20672a55\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"ed74f02ed4a57eb0\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"1396d842f609bd0d\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"b3b42e85c5af2dc8\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"a4ef685701ff8288\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"f04b31707769ff2d\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"7f657280abbc8152\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useFacetValue.js\":\"196958b4d6386e54\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"4ed1e029cdcfc661\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"fb04a2ef5eb36322\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"ec70ac3d2200e818\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"df31d3000af02868\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"00406e80edebdd65\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"6a2b45b3eeba8088\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"dfb834851e455aad\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"75f0d54c8a62d7fe\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"b379ba605879fe9a\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"e9cd7572cd779377\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"57c131b1737af488\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"83a95e3532ec52dc\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"5a6d977d8f1a293f\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"f9efe2cfa88df91f\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"5cafb8e0cc8b0d60\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"f5041a3e6a8aee51\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"16bd8dbcf2547520\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"5de7af12f7995505\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"dc054210d0fce77e\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"dfe3477acac6688e\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"60033687492bdf2c\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"a90715f1d8477c0d\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"68582b77d024b8ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"3a2f28cb472dd564\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"342b7499280a0cc6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"54c0ad31343ee0f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"e98e5f713d7c3ccb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"1b3bd0d68118461d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2493d35be8e6e224\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"74253edfc8a8a339\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"17d2516ae6113729\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"2cd3068fb0539b37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b8c037641066b272\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"7cbb393ee4dc2c9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"11b5201696c00860\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cae8baa2106b8edb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"c53f8aad4a0b5f5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"aa04c7788ae9e9eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"85849dd55f907a34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"0be756e99867e740\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"778e9d13f41566d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"729be25eda420a3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"57a06dd697524de5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"3edfb5565542376e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"5319aac087c0458b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1888c5b28a77d5b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"735d1b98a3aaa12c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"2f4508436b1eb55b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9db292df7144b0df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"60548f8501aa3bb0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"1fc61459f7b9daae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"b2821a1af7e9b53c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"5f26252ec88260cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"0e0785f05f482efc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"36459240145103de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"0d586fda8e774101\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"40ddc57d361f32b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"f52f5cee20e7160e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"e6dc66fa4b216bf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"f0d87f18b562f903\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dayPropertyInputs.js\":\"3345ca37cadf1a4e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"0566cabcaf7926a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"5076f9d8eab81fc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"c6484d45b5e9ca82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"ec8a38e9416fdb57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"e30eba249ae1f464\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"1c3942e8b39601c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2f0a4dda8376128f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"fab8418173428ad9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"9caccf530f1b8399\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"b0cbe4a52417cbd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"587910141f98abab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"57dc18c4e4540faa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"ddc69afeb392a8ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"a1def62540d9564f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"5bdfac4de1984fed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"14d62ad50746f9c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"16a2be41e8701f83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"fb1c657f39e9f009\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"45b400ee9c30b8d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"13d9eaef3a0f3cc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"15dd7242f0ee44a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"2fc4447ed26c7c74\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"ff02d0fca1e9d1ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"dd8b3f68a649380d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"f363edcc4375eb35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"8df231bc968964c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"3b82e830ad90ea1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"4f574969e28216e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"cdfdc0b76ab468e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"c4420fe800acd1ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"a652924c709a8f66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"839c56d80271e72d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"f8201c05e3367f85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"f7d7b767a9e4a649\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"25d085b6f19d8b60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"8035bbcce7b59dde\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"afc5c2297cd4d2ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginAnchorLinks.js\":\"3118c402884b7716\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"385e6727d42203f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"a9fa664f3c1cd271\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"b132765cae08055b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"5ee2c4d8247704a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"d0a31a230a596d37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"b79ce700ee471f5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"594f91c3e35d1a98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"7c058b5b60d50c43\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"1bdecf9c17d1122a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"7d0d992cb24a13e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"6c2447ba9358bcd0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"a4febcd3f0cf730f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"b59a7ccc88cd96c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"3bd4b7c453a42fbf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"715d8cb8ca0b081c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"466641e6c9b744a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"00c39aa1f6c7e2e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"ef44115da0bb0d10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"adbf228c361dbc65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"1ba391b66331dce1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"045e298749616a9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"7dd83e2234b7bd81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"7610b1320885382d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"477e2bd1b5597131\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"b497cbedc2546605\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"a1f696730d4380c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"c88b49b5eb2b2769\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"7572ee6625adb24c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"aeb9c234c7828823\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"0e7e7387a0540f9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9e6d8463cf24306b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"1f7a933ea7ab2b94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6806c466efa4554e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"ca12e3e2ee1be27c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"b55e10c042b0b4d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"a8d867a9a5a1e426\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"c7fe513b14a7d953\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"8a0d6c170533fbd7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8d608bc2c9cc63e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"a463fb4b9a97312a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"baa53180f8bc0f3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"e695de7d0f872d2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"c235e14afd0b680e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"ad9d2b778edc7551\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"19f5d24e5b1b6820\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"4e2f1d7db5a41204\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"139fc0e555df69e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"5a541a8f869ac7f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"291c0cde9b7b7df5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"db6aa66c6ef1ea17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"e88b50f681d68229\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"adea8d510a048be3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"33435b06c8e1faa1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"dfe637ceb61071a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"252c91296e5a13f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"fd11527fc48cb484\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"268eb916e40119a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"7c1f300be967d205\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"36adc189a1339056\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"ab2f86ce445ea753\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"edb4394c2ca7df59\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"3df456f4e6b5a472\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"c0187dfd1e283504\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"902cab5245fa0f24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"576eb4bf15dedcd9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f7b0ee2addd110f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a59e9ac0af8a7c71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"837b81bceecd51a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"af7b5cb34dac45a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"e72f1865cc33853f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"2d891af0bb11effd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fe5c8d779fedc1d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"e217b180a0009e81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"b46fcb8c412b7faf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bf26b55d572a8aa1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"f991750562c89a50\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"8255581d6830cc02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"bca0b71f589eb4c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"34d6f9e457275192\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"4efb9aa9554582c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"878314651b498e69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"76896eeed50c76c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"4ef806d3d3269f57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3ee584d00535fe52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"b17c89f9e3ace80e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8d3a36cd1eb9f32a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"ed5d3bfeb8da655f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"d7886aca0ad02265\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"f958030092a82373\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"ef0018cc3efbd8a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"436e516fe1c39992\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"45bf96b172e135e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"e305b8225e028676\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"9221e87d6f87f535\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a0ca869f04d4ab2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"9451890d49772c8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"f5ac268426e9971a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"672e2d6d8104036b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"c6d4636d9552e622\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"86ac7a3cddf15023\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"f866d37548232f92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"2d1c09d06111f6b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"2fe29480d75b5e48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"3f4c60ff6b737ab5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"69a25fab15e7fdd7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"138d79eb07097c69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"0f5cd4c1bdd7e7fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"8e8c4ef4ecae7301\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"78dcadbaca5bfcb9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"bdbc0ac292bd2a16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"5c9db104ae51e50e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"136d44e589d4d5b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"ddeb42e5cf39ddf0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"420d3d2c9db6637d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"87b8174991021ffa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"19c702c43be62d9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"54e6f4fdaa0c48a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a00a509276189494\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e0f87c2e4bc77705\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4f511b1ced0079a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ca9cdb5177fb51d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"fb55f202a1b1b661\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"385d6d62a536c688\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"cb697699a368d08e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"170e214f21032fbe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"a3eb17929aec3abc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"708895ce1f965f90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"2fe41d187c03a768\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"ba381a850b28ca8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"88c1d1a2d9928fb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"197fbbc1bb3f3fb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"eafcacfce8a42925\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/subtree.js\":\"db3c2a3ac860a8eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"506841e1cba180de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"a6fbfe30039ce2e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"beb7bd97248d1bec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"85f5b5e9c358d9dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"75e634b1ce016081\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"386f689b181e96da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"b78137d6b556de85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"7077e2cb2f87bc39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"49f9677592968095\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"05a396577a8f7227\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ProfilePicture.js\":\"cc33f91407ff63f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"0f290534b3e41cb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"6eed7f848235eb90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"bd35dfc7019232e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"d74209d33bd4bf6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"4878a14e95ce770c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"8eb1e94076d58fd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"d17d62cf6936b6c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"3ee5ec76dfd791dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"c5387940a3ced64c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/useCommentAuthor.js\":\"5bf85fa152574dc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b21096928ecf34ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e7e8253df1f6534c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"9d13369a45e38d60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"88ff70d51c6136da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4d58a44981e14245\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"d878eb09e3c712a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"48ca33aed17f9da9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"57fd6fb546899250\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"d020d1895f82eec8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"cc0d77a9575e1807\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayPropertyControl.js\":\"e9013a1a1809a025\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayValueReferenceControl.js\":\"4b1a85f0e1c1361c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"dc5c02cb07d569e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"3d79f6d93b3f93cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c89217a8c625636a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"f9f36460727766b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"e12b00aeff42e253\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"2ea12573156f3c88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"59e1341e9d21fd66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"a74650647293c364\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"8a6060fc4242cdfa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"68cf0d33dfac1199\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"62b99dca8ec1ef31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f836622d6dae5e64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayProperty.js\":\"f5ca1ba3c9ceb6f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"6ad3c85ebbd3741c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"83f704f50ef6e74c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"db327139b099f546\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"4d96f321a4718de2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"9326018704b6b00d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"c14c6f3410b358b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"68731de82b1ad741\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"6dbea7e7ec4e3d18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"fc1debce61d9caef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"a05c2618bf58f35c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"5b6d3b7827e18654\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"0f0c69a1607c253d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"274915fd7af01f95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"22821152f2c98dd0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"680a4140dd371481\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"12f586b199d433a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"b9862efbeec47ebd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"f31c7308505b7a66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"d8cb291829ed4648\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"a7fcf52abd875a14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1839d85b01c67ce7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"5891a174200229d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"b6df02ed007369dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"1aaaafa0f9942210\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"e9ae364afc6c498e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"7554e64d2050775a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"52d64563255b0484\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"6d31cab9adfa525b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8fc97fbd4de4fb8a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"29dc1825e7c9b45a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"8a3c66be9d726d8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"c67f5cd07f8d2cf4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"a864dd950e24f1e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"723e70387f9aec79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"6c462def9da02c0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"5c6913f5d14e0a33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"edc5a08a69bc2ac7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"8fb634dfaea585b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"84a6d80ed2c80e19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"94cc8a0f204586cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"8cb77028ca0b8a75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"c5f709d7ec636ca7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"c46ceb812b1f6daa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"6c49218149e210ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"1f3d73bf451e90a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"284145d512daae5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"d1cd205972f033c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"529af149dc364f01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"101dc48680991359\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0ac11220ce7e1d94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"2b3d7eec7f8f5441\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"2f5cd945f8fa233d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"151c716748f61c0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"1bf6489d1449946f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"011d14b6313a118f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7b947861a777fc44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"b43355572b53abe4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"ddb6115be1df3c3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9070197ce48ba606\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"6e784c752f30980e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"e8e720809652c487\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"6328b776094b93a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"82f1526c336fab7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"8f968413379f6ec4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"fc802bb49d4db723\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"814bb83754f67f2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"bd69f58aa69aa2eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"2d1605208c328f7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"fe1626458c45017a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"fd03e9488219a7dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"9b69711aef62b79b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"48080431dcd732de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"b68f9788c6f67d17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"56c2dc026331d200\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"ee5f174ef4ef6285\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"faef89e0360fdc8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"e985a63b75d814e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"7f4d6af0a3c0faaf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"41837025d102499e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"51fb990a8d5675b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"8cd337db266b0742\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"bad55514f174e352\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"75335f7291d2f1f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"21c2af551595ebeb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"ba6788486e16ae64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"5b59d7325b81822a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"6b26cf9bb2ce62a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a11b0f16b3d3c16f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c1526d40fbad243b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"79e1fd14e12722d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"62bc4b94e5e0954b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"9b0dbb9339a65d1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"afb524740786dba2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"eaf6e90484ef0d94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"ff54a63c855ef722\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5e222fbd5b9aa1b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"1a828c4d45962f64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"867fbf8402484829\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0b8a45667cc64100\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2bebed13220783e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"2afcd66b667b6891\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"02ef6adb1e07bfe4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"25872b9d2d6533fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"f0411c71249d4f93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"b6053e886d0d532a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"23bd1064ecb0c3da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"192e92c9d284e291\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"372aadaf061ac5c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"3a8f44f7510ba937\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"88f8f4737961b44d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"8f203814c0153439\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"3b778e62cc46d2a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"6e42ab646f17a380\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"5684dd2b417e0189\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"2b08c57795992f16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"3802f96aedad4835\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"39e924838dc5baca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"965f708fcf3bdab8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"5e5fee1be30631cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e1affb8948b61177\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"605b6295b7b13372\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"51fa68ec772c68eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"c5a34b9eeeaabe62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"e289fcc3f17ebd5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"185210fb34d34ba9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"cc82e94cdd0c8b47\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"76764ac1f7b968a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"00a8e3c3280db680\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"687eee1abd02ce64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"a964a8f6bbd3f3b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"f05988fd222f291d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"03889cd439080430\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"7307a3f242ad1448\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"059dea6be43f789d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"ce8f6e779faeabc3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"06dcf5244b3ede5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"5e94fe7562366834\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"51d71c24db0e06dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"1d1dee6f40fac361\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"d835502eaa92745d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"90040311fec7de6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9b09bc1578fd53b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6e9b96fb0b79a610\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"4bfac9e7d886b451\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"9d80f3fbeb31a276\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1e46b24fb11c3c28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e27c54adf6ef2b60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7f390191c772221e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0e275a8943700818\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"0996a6bbf21ea890\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"950d6ad2605503c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ef8107de65dc6b55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"6e3491277bdbf80f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"f4355127d165794c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"24d214858b470c57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"6db4ff935860284c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"e33db4a18c8ce33a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"5a71f67d0a7f2efe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"c9a3fbc9a5c1a5c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"5a1ddae1aa569d54\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"0f691e8653f57fc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"2feaabd1c5eae631\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"20513da8a6ce61ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"583959ce2d025392\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"f8ec855ae7692877\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"7262398715e76541\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"75ed4bda09fd4dfe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"c76eb24dd1e49677\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"fa9efbb2c587d9c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"e62ec6c38f696fb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"0d15112990c23ff5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"5156cb60cb59cd9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"71d1aabc51958326\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"6b0d5fbc813a090f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"198d26e8e7a81fcf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"88f21587bc743963\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"90d6d09c2108d6c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"96f90a18393a0d80\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"97c151264026c76e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"d41f651eb9db4dce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e8d8cc4e974e2c37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"8d0ec22266728aff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"e362c08a7dbcaad3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"c03f470daa89acf5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"1ae07a713ed3521e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"7b3e2ff950a3a640\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"d5a456fb6e90498e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"d58b5f43f7d39029\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"2b0870b533855542\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"ec17300688acffb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"a7d04d62735c9b36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"738646e6fb3b8163\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"145d574df0806e29\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"f14927e53c88b8c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"54db2156e24db842\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"4bedb5b641aa77f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"19a622d3d3f6554b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"ddcb19ebc93b1eba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"cd1d563e46d22912\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"7dc9f7eba58b0a84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"920981c7645b28f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"8bf9342c35bb8e97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"51a17ce072153c1d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"8d78b6b218aa1e8d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"e12770bb148a12f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"01f4651b43bc4dc6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"94ff66d4a2d5d38f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"22ff3d11849e7883\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"50f83a42500f933f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"905bc14d1c2a472d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"d7e210d230a726f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"a64da1e9769a385b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"f8868e7d4fcd3529\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"942b06d0321235fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3469a49ca3db77ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"e5726d1498cd24d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"7ca9b268363b38ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"ecdb1c54d0ebd326\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cd9c8598c4741904\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"78226853619aa778\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"eb9e31e4cc9a4fed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"45dc2dadd847c5cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f9412a3a41e98c35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"fb1665acf0a3d1c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e19908c1bf7187f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d98893d81f4ca3fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"6679e0c2db124681\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"e416112f2bd5a9e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"2f6f0e05c0d0759a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"5c8be2d1b929da55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"af08958902ff4d99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"f52a7577677bb27a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"acf1d014c5dfcf8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"d4065d8e09cde511\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"85c82412bb7738de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"923345d4aeee8ec8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"0f3d11ba334cdfd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"090943d38fb19465\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"99545f622b2be9b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"d3dcbf5f456c3e88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"f4ba01133813d191\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"74a19ade35183e48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"6b10d41cb3d5af9a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"a12e8bcf1ea943b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"2f8cefc92611daf7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"6efb4cdcb4bbfe08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"b60fc23a02340f7b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"36fc95beefbe3ea2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"e61bd2a72f9e580d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"8145fac6ac4c1005\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"2b350a219f7694a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"6784db9b4f48d096\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"a093f539b11c41d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"1bddacbd4b11cb8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"2ab5514e2112fafc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"90ca5cd435d8ca3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"c86a76c2261caea0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"24f1cd0cbd87a242\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"b60f42ea871fc45c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"d69c99197388f2fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a01be6fc6a37cdf8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"7188602f07cf581e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"6587b9f0cb93f7dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"66fcc1972ca4402b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"c9c2b05dcd56851a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4127786c20020220\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"016e7ec03ede2c91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"32fe41082622d9e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"adaa4ba8ef0a88a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"9b64c7ab92cdb23c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"c0d14139fecddd39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"d673d10d682228a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"58434ddce9ae2758\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b310a813708bf6ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"4c1e69ac688fe59c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"7a0aa822c3659f53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"9633070e822ea95c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"3c8fc6819a5354b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"471b83c712b65704\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"f14ee42ec633651c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"59b7792a43883119\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ce748d9c551e583d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"259b3e3015184483\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b8d74b8035804a95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d7ac8da9ef9b7829\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"15b477494dd4fe7c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"3e9c159c0ee6070b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0ea00e602704095b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"3e512944bc90f017\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"a285f706274b87e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"781b9a5b82a37121\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"516b3cea336cb51a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"8dbe9ad76a631997\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"8bd857d90ead1432\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"8cd80b76c184e6f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"2d69d760f810777c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"fbce53a483cbffed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"779e5563bb94cddf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"a909cc272747c8c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"a11d61da01e5bb89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"ff1d1838cf103dcd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"9b01990d435ea947\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"dbce41ea90740439\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"ec57c39e1838245d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"bf2df0d1cd23e295\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"b2488f0a229262d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"e2c44f225854ae7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"376a4023ecd07c7b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"842316f486e14920\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"6bf07b9b7053a9a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"53d232bd3634a371\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"b5ed15390f1518be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"2a30f3cc5d8bd921\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"279455243e3bd0b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"75d01beff3174a57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"f241215ae022552c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"52a296fa2b7faaf5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"20c4811822ac92b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"8e5902afc3b37e0e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"bf64fcd66a44b967\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"dd1319e83ad59ded\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b558100cb7d30708\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"ff6d782fd3d5f268\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"ceb9eb845ecb49b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"7cd4b596a0fe322d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"3de18eb362a79e4e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"6d642ec45b8ac710\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"b47d2859b9aba3e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"4277d2a68334c904\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"8cdef932c1806633\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"da8e722ebd12ff6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"919dda08c1fd3047\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"89a0216489b0e6e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"5a23461e1ac83ac8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"4d98c9ed2580c0f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"de70b19cba7be91d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"7969397bcf9e9d14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"0e91b6759dfef028\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"e43a911673725e21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"dbe5a833f7fc34c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"9626a808b9d6caf2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/QueryText.js\":\"aa062cb7bf78aaa7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"5aa10a3a2d3f2256\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"ad49586774e4fbfc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"504792c70162d6c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"4362a04b00d6c010\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"03c7122d275092d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/registrations.js\":\"c7859e4011f0febf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"e93adbf2b0dbb9e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"2c1b37a479853a04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"c2d2849d065520d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"4d8f57e243e0dc64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"e83811be17cdbda9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"70f557369f9512a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"e281d512fba7c235\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"a19fdf29b45ea02b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"a516ede92c4a7874\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"cff9b61aaaf831b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"ab45916d2a529777\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"0d9ab45cf7772b35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"bd35774c1daea79b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f50034fdc27ae606\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"ac98cb4716bad351\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"9dda47e08b800b71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"1b3ad3f33ba710c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"473a382db97572d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"3f1b93dd54556ed3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"2730d2baaff08952\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"4bcfb7cf25e3d6b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"f9125cddf63dc224\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"f3acb478f5406507\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"0c37f149d65431f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"901c69dbd4629e42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"8709ac8636c9e4a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"fb78baccaa10837a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"f2518843aeab8906\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"584b18253ce350d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"6b5d48c961cebc7d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"8310beb0797a5700\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"b960b6bd756df8bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"01325d5827099142\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"9176ee1330404617\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"ba9199355670496b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"6c8b4da83102251d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"8795e3380f6fdc6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"38350c7ece9b7ead\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"3b439a711f043157\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"0e94bb93c5e7f0a6\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"307ea2c5bb798761\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"0094e522e1d6190b\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"7f9a1faf81af02f2\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"3a5cf8d99f853a35\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"33a99c3b2b50be9d\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"672b56689d28adf8\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"b0e87ff91626be40\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"2e966821508977aa\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"264a057e37906967\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"02786fdfafa05b0e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"bc4f890b99b5391f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"a4f0d690f4d8e181\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"b36e0e0bebee4922\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"e862f595ac86d7c0\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"b24925cc80694e43\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"fb6ef887b52d8831\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"c496d0e61dd9bae9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"c9864c1ad6995945\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"e4bf367a5c22bc44\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"9b24782eaa9e2e39\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"fcadd8a8c18bb079\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"10d05a570b0dad5f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"e3373154a9101828\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"043d0c30d9249f98\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"15ea0741d855c704\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"52d03413430078c9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"1beb979b4e2d85f4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"ab4251d3cc9f5165\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"b8000c58820eb835\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"00c715ca3c6793b5\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"5679c3e8b93adaa8\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"ceceae1191f250d0\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"272d5dab56aa50df\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"39caa388a9d66d22\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"d8e8894357ce8f40\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"166dd09132b6cbfe\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"38a4d7fee88bc4b5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"891a4a9fc702fe4a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"43364e83a4dd79d9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"cd4ca9fea64c0f89\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"852fb2363627adc8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"bc0aca9184a0aca2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"54c667731312bbbb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"c3d0b619083bf279\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"fab5f93cdf9d9ae1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"ad296d4b7079cdc0\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"88e61ec4507fbea1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"65bd70b87aecbfd9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"24eaf7b38b1ab25a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"c4ac1f9f8a1eedb3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"cdeb63c13be888d6\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"6eb82e29f6a55da8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"0e6a054cf588bcf5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"0d6c3ba3da87de50\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"b906be43e579c6b7\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"f458f2b1a06714bf\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"98db0048b1866d47\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"1de6a2833571d73f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"d5b147f0d5d3de1e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"87b50325bfed0a3c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"24f0feb16a53b9b2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"2827209811f9c583\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"0898fdd02f2183e1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"e310eff3ddf19829\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"56879df8f16f26a2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"1931fea7613a0953\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"b3eaad1a711d155a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"32fd5d96a5d87ea8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"858dae1b52a78c88\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"0806ed97b365b67e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"0ae9d9f744b1a368\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d0b574b1674d528b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"f2df3f918a1ab527\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ce72e5fb68c7af6a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c6de63d033068963\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"1197dec77114d16a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"33a28cb587cd85f3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"899ce36e7322bb05\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"b5fd35ca9818e01a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"d4f085d52b09cb8a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"5592484577c7e76e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"d5ef7600363cae49\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"3f9b9967244c6495\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"d9b9ea1b3f3ada8e\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"12b8ebf1100045a6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"7ab1db39538c4dc4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"d8261f9ffb172a4e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"4c18fd5de0a91725\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"a4f7d8787e3b0d36\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"392d1e36ed9955a9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"69b973ab053a99ea\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"7d82af284643c144\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"9e5d68aa498d9bf0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"fbc2d9ddc5f99cc1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"e6d3b04bf8f71a6e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"093e3614054e9551\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"9a36e09e1bb70683\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"46df9915b274122c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"a1021ab23f0226d3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"bc7b76ea246f3d82\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"3e1355d7e24f1e1b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"622174af7db790f9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"ba6f9f37ecec8610\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"84e6b9be6da45eb8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"7802777586e0c487\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"4abc827396b294b3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"5e9fa7900766d56e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"5db4531a485db317\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"7f1abb9bae810b75\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"8a1d8632afccf1e2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"61aaf65e751b6af0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"c16a0171b2ac0d67\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"196931f50aead185\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"2231d6141585f4ab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"bb9f488940b1d8f6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"6154d49049f13f32\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"585d1080a3cce3c5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"99777e6d75ef998a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"e757790a2c8eed47\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"3e2f72058abef4b2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"f04d45483cef061e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"d0f94c559a0c375e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"eff264e55d99068a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"ce513aec90d36265\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"ecf15ce2f99d507e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"9ee5d192960d6c98\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"185c3d2bfa74c9eb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"1bcdf8885fdfe2b9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"9eda473681398f92\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"22e3055358f14ff4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"f3d6d31e9b53101d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"35546662d45a9263\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"46b6fe1fb55ef795\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"305b40e1037b7ce6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"b286b8dc15c32cf8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"02c88cd56722b7ae\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"0391931784692496\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"d9a0dd92e6bed1ec\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"6f0a22797bafc280\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"336f6d3da3e519ef\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"1a375dd7a7153b79\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"44f9e98e6ad8d725\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"862ef90c33bbde50\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"5a5cbad9cb9392ce\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"ee4206e918c0cdbb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"2e2eefa0f7d985b4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"da31bef5592445b6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"bec61a5a96dbfb1c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"f327611774a798b8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"3f2b571773383a9f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"a4708bd32b923085\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"8354f9faf7ea3653\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"b61821afac72aa55\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"6c7817dc3d77f563\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"699b1a504446b1de\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"80b04667c6b97f3c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"d81e20f3f68fcd8a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"0fcf98b68c43f547\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"01211e389956a5cc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"c11104f927229a35\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"71ff227633a5a591\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"26745765ca233588\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"ac7dcc2b87d91605\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"00ab7818b57de470\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"ccc2e4b14223557e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"fc1a80f3689b7da9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"edf40593218aa71f\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"94731c760b624add\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"2f61face571f95c2\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"41613a435ea857f7\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"fa4b523b0d264498\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"df4baefd1bd4bbe7\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"758caedf9cdea75d\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"0960a866996803e3\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"9b452cebcbfd269d\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"1428c65004bed91b\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
