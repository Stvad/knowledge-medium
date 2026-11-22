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
		buildId: "63a3d32a9c81-417ded8b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"5c2dc06c266c6d42\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"5c2dc06c266c6d42\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-DVsAz0At.js\":\"c036a475e5d2309d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"a4e35f2028b863e9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-BGFGZ7XR.js\":\"e25aadd85a636474\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-BmIwodGR.js\":\"57b1584bb69480fe\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-BL_25Tzc.js\":\"5b66a97ef3f0191b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-DrzXVdpN.js\":\"4e89838588851dc4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-CWuQEk5i.js\":\"5dbcf4fdfece0e23\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-iCOarOTZ.js\":\"ab7da9e6e96ef051\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-BDPw4Dxa.js\":\"09c8fc97748c4cdb\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-Dm8gJFih.js\":\"0c42348f39b8718d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-T9URQZH1.js\":\"389f76b5f564975a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BGzKaqWL.js\":\"d7a8ecf749cd3e64\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BIsbZOmb.js\":\"e9d1573f613fb5e8\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BUuEHpuF.js\":\"09fbd8518d041290\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BWS3oc2Z.js\":\"b317ff24830550ec\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BfHvVeZt.js\":\"eaf136add8a28ee6\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-COfZqFD4.js\":\"a10dc3ca3e8fc6af\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DPgI9sGW.js\":\"a433221b490ccf85\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DyjNGJW6.js\":\"dba752bbb9b4b4e4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-CRPUV9tj.js\":\"6120633e07d329f4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-CU6JkiPU.js\":\"ac5f59086021433f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-DJBfVNDP.js\":\"aadcc1da3b5eb294\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-BvaChQBy.js\":\"55411ce71afcf5bc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-X7g-UAfJ.js\":\"c8a127f0c6747867\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-hCdhZiJz.js\":\"3837cca34e9f4702\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"f8293dd7fcc5c5ee\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"96d2ee148deeefa8\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"8c1348b22fce7738\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"acfd470f2818d49d\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"860cc803b54d5e66\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"9523755cc083da6f\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"2ee6e75250b8b5dd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"4100971249143d09\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"7924b07cd596e9ad\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"10d641a9bd873bb4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"c1b946788fcaeddd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"4af50281471814b0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"26ada63cb8464321\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"67c3df130e2b7e12\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"72778683c858249e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"fb3cdad525bbc422\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"c99ba2fd7b9fa0cb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"80c063ee27b53685\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"714628f6782c3051\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"8b0b99cddad48cbf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"a65f035a94a36e39\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"b941499f2909f111\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"43ac39916f14d6d9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3efcb7a2a5a81c61\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"1870cf673e4db6bf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"e2770d0ecb45ebb3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"960cd586de1adfc1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"bf94707934867d7f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"aefee6fccdf63b82\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"9ebb1870c9fe151b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"a4540e9784cb4057\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"121fb7f6ea25e4fc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"4841bcc1312f10be\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"bcf127eb344ec070\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"413718394408bde6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"c519af2e2d24e748\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"b58c67a0641102b9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"58ff021338dbf820\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"b23cb3681a6be4b5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"9274f6ec9036b56e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"593da6375963231e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"ec2cd0c2a8102109\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4342b171f41293b4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"85aaf81b9b4d48c0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"f581a981fde77a7d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"22c8bf2b2c175c55\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"324009f6db410501\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"83705d8b389c1e39\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"e7c9df3376c0b68f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"e9f0c86f9d57d84d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"1e8d2d3f01367324\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"9fdc5ca508825c72\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"6c79a277a9e5849d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"5ef01ddbb02adb26\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"eef3013b5528eb03\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"72bf37a50fea63e2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"ffca1416e65e0d94\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"1d1c1365db07bf68\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"2eddd598e2cb2d84\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5669457cdefde4f3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"309e935d4c5ed955\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"579736e3cf56d921\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"9a99ae76f0ed1645\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"31bff5a7bb2cc3e1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"8905157cedb34bee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"30e1a964803b5c03\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"10b95cf6069ea74d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"468e8db5cd83e7d9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"4bb2f1d6c55a7460\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"c51cedd513f2267e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"044c802d22b66995\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"ee3071cc04390b74\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"5a63ead10a1421b1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"087eae066d6feb75\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"eff0d14ac2a8edc9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"ecaeb28676264647\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"83ac108e61a3ac78\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"91e92583aa2edc47\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"e8f40cea95ae1da0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"f5025d2a5ada66ea\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"b2e7f505da4c596c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"cdeefa2b5d09f4e0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"f64d3c65885c04b6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"711074b1da457512\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"2c163ba7da0590be\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"73f9ff870ccde0a6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"c860f19fc8be199b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"a6b1b80081d8111c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"bb25cad6656d61ab\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"70789b3dd7f709e7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"f2fa52d885cba008\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"774515f7af5b4359\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"0da6b00dbd481e9d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"a78142c27ede9c03\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"012ef6ea51e3582e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"b8597578f6fadc67\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"68d39e149ae4695c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"9ad226b32a936fab\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"18115f35c31ce0d1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"dd925f516062ce83\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"1eb81b73a4fa458e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"dbfa825da6bb3a27\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"7e3cdc073fe3e4fb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"78b1b55c6ca18765\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"a4089ff4a8ad0de0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"8bf7541eec7cbc19\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"e52ac39ae98510be\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"61e7b0299d4d7c22\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"ea81b6a79a7e6ebc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"915cac97a553ca60\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5a0c6b25b30258a8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"ed2cbd94298eb6bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"666fe6b2de8027d5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"d78a793658a4b758\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"778baee6c07cb06a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"4db2d57f626fa382\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"dde54f8cf4591170\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"05085f27bc570c5e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"0f906b85913b3d2f\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"17bb404c718a27ae\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"a1db2e577907b87e\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"3d8da82ededdb78e\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"bf8ae7992f53760a\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"4a4e3ed0ab495a84\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"a948a8df42eb05b0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"b1eb1835b4805900\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"a5580033b797ed57\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"16ea6ee4a15f084e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"cf00cada36bfc07c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"914418e8b719cbe7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"c4a0c5493a3433f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"dc1784034ea3401e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"86d2d6b4cd18cad0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"651380f722f8db33\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"d64e40df9a95f5ff\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"77479436dbf333eb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"0a60020951a9c87d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"8de4401b9d3aa416\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"d5f7d9e240d3be5c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"b6f1b58c987c26e1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"651380f722f8db33\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"651380f722f8db33\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"01602361dab786f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"6e704122437022bd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"6ebdc8e911fbc083\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"5bed138120e6e8cd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"f39ff13c8e5a52bd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"31c94b652c00572f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"ad4c6119d8bc2a85\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"92eba995c9941b66\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"997eba4da5c2d7df\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"e6858c6a6d45be17\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"0bf185c36b92453d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"fc58f08d37f2c7f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"06db224f9d29a033\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"0f94feedd3c09bcc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"1fcf93553a6e9fdf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"494c14be0426bc5f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"a5314f90b32018ec\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"3bd84a2ca98a3b70\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"e291a904dc8b3ae0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"923802f53b0bdf7b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"ca90d3263cc8f32b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"022356d0de0abdbb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"47e76a3a58b8f5d1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"8a4fc7ac99b57eb1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"a6e453f8dcb49a96\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"8604a17593706822\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"b34fdf76a795bc83\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"218e4f6e4ae3604c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"95832fa2c742140f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"4f275d7025ece8a9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"113449a4cab61465\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"96428304790df19c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"05e2582d06dcbafd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"f2c800910cc8aaff\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"a7336a2c5e2e4a67\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"f4f5f30882903cc7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"7c851513bab9fd1c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"5f5f7087e0ef7f50\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"96b6b19ab8df8fea\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"467bc5025b4c6cfd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"6f7a4565de86113e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"42e91bbd5d5e868d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"249ccd06b0503b53\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"0eff9d342e826feb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"8253b81dde5e7d43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2b136fad7714cd44\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"2c4bf0ace1470c97\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"6e6e95b29b24ba61\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"a9f78eb62c06725b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"873173ee4c8a6d9b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"bf81407dfb8ab855\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"42546ea0b2fb2231\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"883ae67b887d7d91\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"8f426082dd298e66\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"1a6a7ea2d65b446e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"f6a17e8dee0a7bb1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"b4a6aed873d66460\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d5be1de8f2f714c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"209e69667318b9cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"de67a3afde4f81d4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"24ea61507d2c7d5e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"187fcc4493351d97\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"2093937235f3667f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"d9f43d26b8534a46\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"3d93723b19b6170e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"1bd367fb97241e27\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"66e57333f7fed07d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"3fd2087bc7e54da0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"6bad4672cf318d20\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"150155914c8be115\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"e803e4e4c595f1d6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"a65c1a5344b8cd43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"aae487dcc9c1088a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"785a58152478d341\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"e0935404ce8b0d03\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"a7116382f2a77dc8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"5e512d7846e04a66\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"9b92d256fb12fe98\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"abfa7e72abdcab88\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"a26bbb3422090c40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"b57bab9f8cd88030\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"eaee4417d269007e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"527cea2034860c0e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"17d136ce373452d4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"561e67dbdfaa5158\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"edcd4f1bf0de7fea\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"66004b12ba074809\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"b2b23a5da80fb262\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"c98f3953a78e6ee6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"0607e50560463ae7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"edd8b13bf20820c4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"114b7ab107f495fd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"1f1ed247e49705f7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"af027cd22b744738\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"38e03c9c0c4e68e8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"f0d361479b6a4954\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"c211be6c822b3ac8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"3f5bc4d155617e1a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"b071d206a1c16150\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"da8136f540a074f3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"9862f0919ca4c922\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"d2ce4c6fdae8e02e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"6749bef0b4d9355f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"bf6c26f020dff1a8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"84e1af4407caa8f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"7130692b70a50930\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"f83f78b464a1acb5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"596ea2ffd7c648dc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"7f8289c8c927004a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"5ae87be859b16512\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"4079b309146dcec5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"c11ce28ed1ab180c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"5b30a8b3deda2238\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"651f837bda6300bf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"53d9893c979d1bd0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"8a34831bc13757f5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"069643a0cb7f414e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"e0060b35f68b312c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"15b273ea676cd16d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"eaf5e8a82d4534c3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"17e8b3ae4b8dca4c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"578133b333d76bce\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"fde13dc8cae66fc0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"ecf0a85634d7b31b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"f2c62adacf36825f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"995e5393f339899b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"74ba7f62c5dcfe94\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"e3d03f1e03946a3c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"d1cf32c67c67f50f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"60838e946d990c25\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"598f4867a0ef3a87\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"aee78a972dae2c39\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"014f10d679592848\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"17e97d22d1e69773\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"f95324f64039b4e2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"fd3ef6eababca45a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"62592969a91d3725\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"c527062500fb3d80\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"bc56f6d463489e18\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"db17bfeca8e8a48a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"ba9969836637c9b1\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"6c75d8afc5d1f548\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"6565c9520ea8006f\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"0cf804ef8c6bf7e3\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"c2bddc8a557b894e\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"d8ccd933a7f426fc\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"32f6e98b1ca12e42\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"8faba2ebd9e76fbe\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"ef640ee5ca4a8de6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"98f22b12ac6c9d18\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"762d276e253add92\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"93fa92fc869ee70b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"e2d3923023995a54\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"16a2917542b30839\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"eb0e3909980b68a4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"18f1930a119eb8cb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"8d10b6ddd0460f25\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"3e035caf0bcf9d97\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"aef523de2c84d522\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"37efdbf1f89028e8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"ac5f74c6909dec03\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"16262be920d443f2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"6277b426de4fb0bb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"e93391ca71026c3f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"96f0bb729aa8069b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"605ff140e574e0c5\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"9e4b012bcf04a78c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"d2ae28caae95a9c0\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"fe1c5d1f30a2da6a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"7a2d58c49c0b2831\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"670eadf7259fc915\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"64f83e50640cdc39\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"9049d55947c2d514\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"d749e96fc3805ec8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"15ae852f2ee65d9f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"c309a49b8a36a968\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"86837d93113b5778\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"c50fd5a347e358d7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"d4a332df53baad29\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"2dbab7e72aefd63f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"f1ae05bbe9bec69f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"683657a47e21b5f7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"d81d750ddf0a8678\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"8a02fbf0b6bcaf27\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"3f9febe3763a8030\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"6e61dd7048512412\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"a65ce7309d722fcc\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"9dcdf6eea89e4967\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"6bb77d9a230bbc8d\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"bea31f855d4ac68d\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"c1550f21e8d28db5\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"59525137a9fe264a\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"ed8451ef54cc33b6\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"547a7ef2b89a8d66\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"1988d22cd4a3ce52\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"9f87d09693590d3c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"8b36a4a4dac4f3f1\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"f4ead2fdd860cd8c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"2281043976fa0489\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"7e2b43935bb4056d\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"eb67cdab4c570eae\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"6c4ff61282a67b18\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"b65b5177d5d7feb6\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"02d0d41485caba46\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"b1a71c7e29e21137\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"51399674d4ef8d29\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"c925fa0cca0c968e\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"b8c26c4be10cada6\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"e729c14ae4da2a42\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"a53bbacb2f5f7b33\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"2c80a458b1e229fc\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"eb4c215f8e063c16\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"266f5601cb6f6960\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"b912fe3b209fc067\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"276064d7634aa020\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"213fad70200959e6\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"d1146d9184a94377\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"4dee4533c5baaf66\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"79f8e61f437b33ad\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"d3bd4a7e22bc0200\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"334f7cc17aa94dbf\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"468778d94dba07dc\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"f2c3fac47a9e6d8a\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"7fd8024f85caf2ac\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"82495fc6b0fa6f07\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"7e5c1fa372d26d5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"e6e4e0a2274b5d5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"b0cd42b8f87f5151\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"17dc1cbe16163126\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"1c965314fef37c26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"6f0e9d3f3ca54a55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"230dd42811459c1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"bb461333da46a225\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6dea1fa2049f8235\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"b7bcab71a6e9d85d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"79dabfd193e9171c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"513b2fb2fdbe1452\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2f74c50e4c9fa3d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4a1481e2b59f7963\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"af38dd1d7a2dcc15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0c6e36bbf8ce3616\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"e79dd3f3737feb21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"46aa2d892cbf0f15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a67e252be52119cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"3e266b658c5502d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"9ce805eb1b284a5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"fdfa0a87c3aab4ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"113cf1c92b77f69a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"eba5ada83b6d167d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"5d9a096329c3d24f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"54402c72acae789c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3057ded33e6b2012\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"190b11373bfa4589\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"6f790a23b69ca239\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"e79e964697870d6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"43105d43f5a5074a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"f3e695cb519b203d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"b1a3574d5ee9e4c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"1f2378212351bfc8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"13c11c942a812983\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"bb551c01472ab5c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"364b6cca7913b145\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"9599663a03cbdc10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"cd443b540d75e981\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"4ec124e2f80b7168\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"de82fc54663c4f77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"09237d55341e0acb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"2acd2f12f368f2bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"96006d47e770cbc6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6d20374ccf03e336\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"b6ae8a7be751a016\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"82146a5c8e623e7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"944170f7174cc283\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"f45c70207ca116bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"d7cfe27ea25592d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"44be0a9ec31f78ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"9dde1a6743e3aa0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"e99f64b4917098f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"d3fc6e5ef8f3ae42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"f407ae6c85252909\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"d1bc80c1ee16ff7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"8f5ef2f46dc87703\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"0eabb91cbae23562\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"c2a518fe9299d4ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"c4aa0b1a91678392\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"2fae0f5d234e8161\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"bec3dd8a6d547609\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"d5da626464946807\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"35049c0627707e9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"f57bc1969fa05baa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"6f0675d189a9ce7c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"a2cdeeab30770ad5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"679baf2738edb646\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"f01524685122f543\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"d8feb5d989381269\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"338875dcf5fad24f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"1aa9a3b6c405fc51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"e826317a1a4a0356\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"0845b6beacb8cc36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"4c2ee4aca99f0365\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"9038d111b9e86e38\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"8992f23ce5671fb4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"fab18567278f6253\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"00d22d53e168e3d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"77ddff13a7574d33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"9b8978f730a1c2dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"1fe6246646b72b1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"e000b0e87dff0c19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"8009bb3560caf2bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"a04fa0545055ea03\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"8ad75ed90393c5ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"13131b219c015720\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"09fea6639db1801f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"7038f8dbdb5a436f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"09ffc706e4dc5f1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"414ae9bd957aa759\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"5795067f349b2b0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"9f7ddabd172c5753\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"58ab9881069c1c2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"e04607d81505dec4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"1d6f264f9a9d41be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"1b3febca97a9557f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"5bc62ee238788e4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"7ecc751121741c95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"1a843a9d8323ee93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"040afba078e9345a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"afb51af1d73e149d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"5ac4f277629aa046\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"cf56bfabcdd09505\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"687e2707633dfeb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a70a474e3fd190da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"deb886f8e6b15582\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"623a1edddad56106\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"e51d2759db359e87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"dbabfe97187aff8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"d358ec9dc6fa1987\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"622bc638cc70376e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"47d3affd0bbc0bcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3496b4a1dd68dc88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"5a564d177fb7d502\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"fa4f1ffc81460fcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"27f1ad514b05adc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"d19d7578d3d3831f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"0dd9e2da85e6f9db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"63970feadb316b16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"d709550bee247080\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"755f5c11cf2a48ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"fdbb9d635c291e76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"d4750ea0973a84cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"5e2ea10bc340f26b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"18489de1911a72f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"27443f3c9c8ced15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"32f6e6c6075c122c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"d4c86156774a8e97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"dc69109c0ce0475f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"21f7c23d7314deab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"032e49b12cc1d100\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"5b88d53cdcc520fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"68ac231827be5b2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"00a7dde30d72d359\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"1e0471ca21e07b84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"13e599b5f607c977\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"e7b680c29e83d78a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d58ab272991bf291\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"43f7d487ffd4c421\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"c6ccfe5a75c19f1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"c53efadedad9c9d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"c97a8b073d7e1994\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"2d36d72ad561b462\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e39cd018fa840e61\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"04312eccbb541fb5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"a16969a9cd9c1397\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0809d7773aeac5e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"3fcd6b97edb693c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"b086b16dcbf50f7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"cecef7f1bbc19fc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"c34125cd9b8ad3c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"cc02a2741ed7a04e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a6678beeaf58d343\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"6dff15cace3acffb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"2be19626cf035108\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"95bf3b092cdfa6ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"da0dc04abc8726c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8e81c73090cf9ed3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"4f125ca5c07f4337\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"54c499a16854f085\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"c247af8ea2371d21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"dc6779240be690c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"38e7688925b07484\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"97a5a1086d2b14c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"beb5bbe9db9bfe37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"ab58d6171616e45a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0c95a99a2dcfe6bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"5166fa511d770389\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"1db5363aa9efec73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"a6ac87aed647d7dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"a23c97588fe54b08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"19498741a4861ef6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"be406305bd02c004\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"564f8ce971529f87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"07d16a3bdfdcb028\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"1f440ba0fec61e5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"c0be6eae86e29a62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"7ee2d86953b435dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"45e0e8cadfa5fe70\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"65911550623f694c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"564bd4c10d27322b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"4e1a8e882ccade98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"bf81b853967eeec8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"885e6b0dd6f5680f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"3d12ce53307120a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"20de7a51d641f44a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"125fef5bfd10c830\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"87229c9a768879d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e08f2ef8e53f363c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cb0a3c5c9355d83c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7bea7d201ebe00f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"051680ec9973545e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a4b4aa3b4c4c1e50\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"3b6d7dccf000f503\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9a7cc1f5f87ee8d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"f8eacc805d9f9cc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"953cc076d47bc091\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"2d3428349e343050\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"c37e8106a8cffd0d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"7b3d24c5fadf0e72\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"04536af04881e413\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"80697a7ff4aba419\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"acd3807c2eebc258\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"638988a6dc4724c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"7218a832ddb4fc8d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"7bee505f957e2319\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"a474b4b974ccd01f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"34097214b8a83b76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"d74b7a2571510372\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"224f2a5e69d8b4fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"2c5f9f7fc809ce6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"f7b77684397b98df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"e5b4252b4b5aabdf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"b3b65b39afdfbc78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"550c81a0169c3d8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"0f2413930a5855c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"9db5dc61aa2e2e31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"7d1ab81ac1e580f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"a57f5d9ec0ae4498\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"b4bfb0059c6f1051\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"a710c8c07bb964af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"698de6088ad63b02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"139b179937a9c601\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b2f4a38100469832\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c9e1ef4394706ce4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"202a57aab039a321\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9b7dba0ed3dba7c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"61f7901e95828066\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"f64ccfd1be1ca862\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"fc1293facc5b5379\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8db572b326563c38\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"40d63fd9c0780da5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"9bcec4134c8d8593\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"cfab19511b54685c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"1250e3c06aa95356\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"937ee2258205106f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"eed76692f6f1956a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"9fd674fcbc9e596f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"abf3ec50da2407ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"8bdc84d68b53bc1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"3e862fceb05a0041\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"1c546d1a6939225b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"e531a506a81a6422\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e62e9e88baffb23c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1ee5e41d62bfe6a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"bf4bdc6135ff3984\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"a01c69f468ebc3a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"9ece10f113151578\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"7cea9a86f33a08d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"5c5f298d46090aae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"d6f83dac61eee3c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"8b4e02edb7c5867a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"26354c51aa2104d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"109ce7b17feaceeb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"5d075915fa71cfdf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"551b2316e29d8b5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0411f9818917a334\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"948e69a4088d68fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"062da9a7f52aa8be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"be2474cecefed306\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"e8429327382ff91c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"4176807963861b53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"bfd3df03e483ce6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"8cdb79847941cb18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"58dded0c05adfdac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"e7f79082a1d7e125\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"72d775263c61614c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"09e59c3419a500f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"bd8bd9131b55aa60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"039148a1ae384e27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"b55566eb5c487ef1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"9ad8e45d89e43856\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"56f56e2d7377a6a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"8d2fc98cb45ea54b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"068b8d05f9e070f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"56f21a5f8599ab06\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"09bfe64b03c75f3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"1e658b329a30c16a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"0ad367c1a27096cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"726af65670fcbb16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"3eb657c744572da2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"178f84a414e9db5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"f22f4a146f9699d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"b04e967b9564425a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"b2d3ab4c2505e35b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"db54e3b420a8dde3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"018585529777f172\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"f74cda09d0552e98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"4f4b1a2b2a1458b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"6fb428a1b572579a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"9c61f6caa69642bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"139ae7bcfbb11e07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7abfee08a4d4708e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4c687df05882193b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"59922122251cabba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"4d1d7210d1c3c061\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"fa9cd14b61284ae4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"424f4df8979be7b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"fb7807c8a40c41b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0e1bd0ce4b49281d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"5c79f7f2129b592d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"4ab47469a798e6bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0158eb6385397e07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"506a603fa85d95ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"a5fb83d7bc83fec3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"22253450a3060200\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"7d36acf330540553\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"2b357f74a49a9c53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"38c97f0af39ca34d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"13756bcebc0f494a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"912cc6d2cb86d16b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"4f85ac2a7fd2194c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"8dff7ead9bd7ca84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"126b86431d546431\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"a7c57896532d7c57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"98537a7c8f50f701\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"4567e70b536215e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"25c68dc1ef1ae083\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"ffe2e9fbf6a4f8f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"9e2c14233605d35b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"6299e43547fbf1c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"5fd60f908615c019\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"de06d13a4527d98b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"5b1a6723f98fefe6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"e3d09725641f46ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"91bd5e5e726deae3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"cac59643841d5d7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"1bcb8fb60b108247\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"06c84f77b8dc0e47\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"8b9e0de7aa446c2c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"50c246e10239dd75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"423d114d38461170\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9353456943490106\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5c7b174557d6d637\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"0ef67fda53387378\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"f8f050baa662c696\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"9276b646fd52d4c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"9461f02586316c08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"7c28930616bbe13d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"41658434f597fd19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"7213d5189065b696\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"76650419ba5e808d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"83353454d6959b4d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cb3c6b196cb0366b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"9a9d2bbbb6e9cae6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"5a8dc42d98c11889\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"55dad15ec5bf793a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"c882f1e2d276a620\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"f4a05ca7c578f275\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"b3fa10891cc0258f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"d0844ca8fb677fc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"031839dfe771d87c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"93763726d3608d92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"fcb17900d7f2521c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"869395570595d1b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"bae34e0dfb91acf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"2e9dbdc97125170c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"ec788ddf302fee1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"a712daa69f2827a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"abf61710c0958d1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"858fe7a2f60fe623\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"009663a315ca9d95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"738db8f6ecf1d914\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1e590f4d6039eb4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6da698de12823559\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"a76c04daa5ead8b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"124c44728bebb8b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"9e3fe6c42ff36b17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"326fa84886f7aa85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"6c0bb0d5d1c3bbef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"68cb9e1854999fb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"7a10ef8c5da93e14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8e50987be2b145bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"5d4577536709f4b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"b616004b9a0cfcac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"fdbc7463a723c677\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"51d0c6dc0c684e6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"d9ecd0339fe12123\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"88516d86ce4f1991\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"7bc88f052f35f617\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"b4b666ddaee326a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"b59cd400bff3ef8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"d9028fc019e549c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"0006d600c1fa834b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"8b824f58b37d6bfb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"67ad9605625f83ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"fac1372d20a8ba89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"efd6a194ca58306e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"bc7b22849f042eba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4c10189e027c2e46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e97be54e0930c5e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f9ccbe2c26fb6f99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b05f1d44ced24dc2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"bdca491f85aa2514\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4b5d7a11ff8a4a92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"20d5d21145dd1e56\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"685db1f458581103\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"3c54eb63ac59607f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"a8d77d6a7c77f7b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"bfb7fdff24bba95d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"6f3140c75beef55b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"ab8e469a1eb050c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"ec44f7ae369d50cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"8a88c023f3c9d83b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"d28a4998d0b60bb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"74b2fd77c4d33b0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"8c58ccbbd055ede7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"eedf839ddbfc399c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"9ec49c761cfa210c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"c2f609fe32269569\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"449234af64437715\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"66bc454ee533435e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"be32e2428f0ea55c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"ad00ef825867e484\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"c288cdec3a8a90cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"39f888af92257367\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"03c79cfd7bd740f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"f28a9245a580987a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"40d98fb0f45742e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"0c6e6615017148c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"a97efc84315eb51f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"ff90f5fdeed89745\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"42e56b4fe01567ea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"2c7583fd8f2c5d2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4c3eea49a157c62d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"42c512fb3dfd04b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"65ac836ca21df8e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"6ad4807c3ac4f25e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"1597f1aa6181f0aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"9fd0edd1f6d098e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"195d13438599da77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"44e0ff9cc1edee35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"89a2811b67998f9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"b13e85551b499c42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"d3a34e52882fb6c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"13b415400c081f15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"9086b33f1e20f48a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"a91916656fcb8be4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"5db068a95e152fc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"530beeced46b2874\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"141a8b9db62f8ee6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"d2326e767f1a252c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"b8e5a320f8ffc807\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"093e0744de45ad9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"ad9a3abe77fd8923\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"55accc53a62a86eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"01372d57eed93a8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"54687222ab1b15da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"da6e2534447db2b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"1d66d34ed6b3aceb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c39b79096806f588\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"654dd01a76617e71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"a4cadb299303d728\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"a4ad04ce35559459\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"a89efd4c959c765b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"ea390cbda0bf3668\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"823fca9cb3718184\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"33ade1adc8c4e366\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6573baa42a77d543\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"ee588466f6037f9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"75c513f18891c21f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"5f9a5d705c76bc78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b379770fe44f62c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"55c65853cacbaf8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"24d88e3deca00013\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8584c390b4df51f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3068c1d42d2c3acd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"324fe42ccd01c338\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3ed9cef0d61776e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"130e55335739410f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"401324d3c38d1686\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"4ac23dc216049e1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"9ad21a1cceec28fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"989a68c19e98677b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"ab261c32d83534f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"56c0a1332b376d91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"83e9597e1daef441\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"728a2e61095bcc8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"f9ce2dfcbcd804af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"00a555705fe74a6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"11fc0e9ef0e4ab78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"732a0006703ec5b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"f41ae0c80c743bab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"9dde505e2f846702\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"0111d4f8788f8dac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"2ca6f62169cb0f1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"c4c602dbd04f719e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"7448c310071c8aea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"e082b8a79503959e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"681449fc54dae3b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"9b6c583ae37ba217\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"20866c942d935971\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"beca05d42ae9194c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"e26c526445ae3950\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"4c39a2acbdb7c913\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"a1992dcb5e966154\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"add29358d5ed476a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"7517d492de866bfe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"cbf2dc540427e2ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"147f8f01fc8c03cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"606c6e94e1dad6e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"13376c14b0effa7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"a9dded10cc8f358c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"cf7edbb3c1f77a6c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9c50b8ec5b6d761c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"45001aad28ef6a42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"a727fdd3eec69a97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"a76ffc0fa55b0712\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"84b3bef1aa8fdce3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"59b9ececfc6f1000\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"3c2774eff9335aed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"93a0ae17a39a58d7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3e049cd3aafb6347\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"1ac9ca984d2930e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"d5f9245d263a9ffb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"2527574b33c3818f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"e56d760bbeecd44c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"fbf8fec5e81b71eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"a1d45b4efeeaecd8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"0151933d02a06f93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"7fac04e063321ef9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"a0ae45e33a957bc9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"728faf91026b30fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"a2f44fcb954849b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"8008b894e5efa53d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cfb3e5d38c25b615\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"40467e8b9daf04c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1bfade16eaf9646a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"57b5885a03c79328\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"eba029c321b2356e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"a5a3ffbc7b51610e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6a32a96e8a025ab0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"6472d52b32abe2b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"a91ec0c9cdb4315f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"adda34fc69149155\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"62aa771955c92363\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"374b53fc10039bad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"cf5b15350a0544d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"4893b85bdc6ce1a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"7e955e182325f9e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"aab51cfe75d85339\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"8e36295545ea9abc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"04e795034eca6f2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"16e003cc303133ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"5d9f6ec4f8541b43\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"9e031184cbc3b4d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"02da27f32f3b8095\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"b172abd1ecee441e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"0f636ca82ba980e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"cfe81df0a5122cfa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"f5867a5e5bff32b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"ce0a574cb1a4f376\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"e78c31701a715157\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"9046fcaf58c1da6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"73602314a46ab8b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"91d15fbb12c13696\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"5b9654307703b139\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"12ff5f9b50b77a22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"106075c9cd45b0e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"da7f62136c2f2041\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"31988429a83cff9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"e9e1c05abaf130d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"35ec6a4890d4596f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"6ed1b278a84af005\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"08131c1add0a34f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1e076e83e68fbfd9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"14cd1e4b2b17efbe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"4c5650f510d0ac21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"24e3b7e316ec1496\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"9e9b3024323b5829\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"2e427bedd1b57900\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"7acf72344d9bc6d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"b983d2231a85457d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"4fc0a1635e598b0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"7c99f57abfad4897\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"3fe73cb3b269b5c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"1f05e8605dd8b96d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"431daba1876b5265\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"b5414ec99afbd2de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"897701319bfdb9c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"372142198b634c89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"64be45555c2a8085\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"04aaf21bd6320f77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"a93a191f00c16489\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"b6ae6aa33a7b3dae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"505d5035edaf706a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"3aa41866860119d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"323dc6c1162cde35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"634f072ed3544d52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"79cb90dbf3f0ee0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"8b4059cbd9eb345b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"34b19ef85993dfd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"17599825978ddad4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"138f834ecbb71438\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"a8ca62ab2fbeb6df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"3216184fa813d2df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"096fabdb6166cf54\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"33e2966430c2585a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"8661d7fd872a5ee6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"dba1316e6df235fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"2bb571441c1e5b3b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"5683b3534722aae5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"0637372df788b800\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"d86d407727347926\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"d64df9aa9e54eee6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"6cc47f4a17b28304\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"32d6c1aba6f2c9a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"0d58dadd6265b4f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"2c5e2b2268be4eed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"1949447e562a2fc5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"6bcb1815da825f7e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"12ff038886e7f130\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"6733ed814e63390f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"f898d7fe6548bc4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"9e5269d994e2aaa9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"af6be66694a75ae2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"e5e49f5b578e28e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"997f27899a45de6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"54b7d5ed48a6037a\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"41bbb03a66497511\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"d84dd7fed9091192\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"b5871e194be22fd9\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"dea5562b977e2713\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"eac7d4fa8c1512b9\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"0c4916a8d226df38\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"750186b8ecccdb22\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"dbc9d5165fc7eda2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"1dcae957ba86fb50\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"1ea025166d5b75b9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"b84d08e0924b1063\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"694e7180b9923b8b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"4e00cf554b5482aa\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"abfe7225c3881563\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"aaeeb30e4c246e5f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"e2cd6fe069a7044f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"a43afcd441d7d240\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"9b6b0a46d4cf2f10\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"7d5596a86bdcb663\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"7a8fe6ce77cb17ca\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"e0a477efe59621ff\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"ac7fb2be3821966f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"7f8c6f2ca26849be\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"2b18191fab08977a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"e379ba7f93c6517d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"6038eff50538621d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"fec62dfbfedcf301\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"627529095ac34679\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"e9aa3fb32cb47a0f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"98c64088682fa960\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"58e4c6417ac1244b\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"7b3bff200bfbf0a3\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"6216b8fa3f3a4428\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"34c2265251cdea07\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"380f8a55512ebfb3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"70a1a47507a35d6d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"71226fedd9b0f9ee\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"382ef5b947a075bf\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"8812c202423e6b58\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"394f9746442e92fb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"9a6910e52d8f2c58\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"c5240e92c408960b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"0a551de8526a5dac\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"88614f1c883a4dac\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"7a5f1e673e509765\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"842057c31ef556fd\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"f5083bffe93c2237\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"9bc18206f5ac5285\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"646589c1b1e5d48e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"5d7ed84c790001ea\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"d5bb034847d88007\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"4f7e859076a2cc64\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"dd294b06a70b9d6d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"383c61cb3cfc0a56\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"8869f5a5f10dae2f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"a8952d3bcceb142d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"34d619e486b4083d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"967895b7f63df7b4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"be73cc1b3d26eb39\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"dddd4ad6a3400223\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"82107008524ab50b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"2199b13f3609855c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"5b3c198b007630db\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"c897be86606f7cb9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"a24ef0aaedbdffda\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"935892e179d1a3bb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"ae9880c355714793\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"9aea1e76f8e52c15\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"b8f4259a7948415a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"375e2d4ad19fc6c8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bad48e2202c4121b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"6b08a6afa2986a1c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9792863a0e8b107e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3e8b83dd476edabb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"607cfefe9326a3ef\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"9c3f4876606b39d2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"c99fe403e2e8195c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"bfe3c0c04d07718d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"c4e9c6ddbe7fd7dd\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"5d603c3f18c08609\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"398c9052e0913124\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"d811bbb1d82b12b1\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"d5d3f4ccb5e4b1ca\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"b7a297e1044dc325\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"6c312e43b62faddf\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"7bbd1f98a0e06c21\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"7b60960b8ade40d9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"f0cfef0dac577381\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"7a4e5a4e40907d73\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"190d880fb32580a0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"167b06612c4fde6b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"aa9c414f5e78adf1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"25ae820fcac7c1de\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"d0a4aebb8374cf24\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"bdbf482746214899\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"e747bf4559e573e5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"6997fff1078652fd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"00c967f76279980d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"e1ee7816a8b180db\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"712d3163f0c06e6e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"3d9e4acfbc0e4c21\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"934fd5530797956c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"9fed54013366a6c1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"127bda03cd68c24f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"73de5174b041610b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"d55c4f84cc42e115\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"e302d4ea313416cd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"63ecfeb24e30c549\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"2c717bec9ada7d2f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"ea5df4fe69e2dc57\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"9808135b57f65263\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"27d0801baad33425\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"ca7ef292de146c85\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"6c7757f932c11bcf\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"8ede93bee28ab910\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"9d97b45e998b1a39\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"8341d6747c2cb836\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"a1dbd6e26d7e5c68\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"204e666edcb9b4fe\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"5edbce07c25c441f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"c2aa8e01c8c02360\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"391d760db156c19f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"5a4d39a4ea66aae0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"f8fb232afe415897\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"fac5fdd191f16c7d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"7d4569c54ab39181\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"219b85a1a7dc3348\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"9631a2ca0dfa8d0a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"a7949ea64b7ad2a0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"d502ea2ffa7c00a4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"f379a18c0b15ad65\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"ac28a15b80b643a4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"e096d2680f70d01b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"fa10f68ed3361b05\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"bdc2b9a2d515e08b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"2b6936554e32fa10\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"94f3c2b1df6fe672\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"af6783694638253e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"aa5053b8b932e27e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"3496de4087895a61\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"2f8c653233654681\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"cf34112126ad5338\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"8fdb170c02dda702\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"198e417e2f2a910b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"54758e4330d16442\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"cc25501389df3547\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"0069843db1eb566d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"afe3d4568fc7d24e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"6488da7347b634be\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"adee3d2fd113c0dc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"9181d29c641be4a5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"e027fea9f20809bc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"f26a3bfec7a155ce\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"95a9c3354cbe5995\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"d2956178304df018\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"726fe39fff04ac11\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"9d5461b6a520a5ec\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"bccf09e91cae0607\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"8bfe01a8736a5936\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"d0aeab6a7de63dac\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"68075b18f4c36377\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"e1684176376580ea\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"6ab6baa5afb96502\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"512e555112249978\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"8f0309e5f67a158f\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"91f6052d60cfe581\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"d21c7e49fb0e764a\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"ae6b71bcd02d8590\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"0262ec073c7f639a\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"8d226a5f459fa6db\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"d505f01f6b291ed3\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"0e9f6716cb406e21\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"5454a70b41b92eb7\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"ad565eae4441f377\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
