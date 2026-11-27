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
		buildId: "a5c54511b95d-5900a705",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"e470c7a1450bc5a6\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"e470c7a1450bc5a6\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-D9rQ8jwq.js\":\"c525062aee0a42ed\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"e9ae10847c5865b3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-Dmn4wYd5.js\":\"f6e057de4522f25e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-B8I6hHZ-.js\":\"974e704d3e60c133\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-DJKv7IlS.js\":\"25a9b0576be301ac\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-_bETqr4O.js\":\"037ae26829fbf7bb\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-RxNGSb3H.js\":\"8d2fb0f463c4a458\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-TrSv74Av.js\":\"d1c32b85ebf8e875\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-Bv3B5n89.js\":\"bd079708c54811b9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-CRePQd4O.js\":\"42d10f26fcaf950b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-CoI1t6bY.js\":\"8f832d7ac83589e3\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-1U2y8ipm.js\":\"d7de35604be2f26c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-3eXVpgth.js\":\"18a494409f1dcb0b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BPl-EPPA.js\":\"8257617475b481db\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Bq6x6rP0.js\":\"7c6f646b96cf01de\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CmNNPE2p.js\":\"5d9c0f065f158307\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CuCfb8MX.js\":\"e053a267e31b7a2c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-IvQ8BRTb.js\":\"63d608b5c397b6d9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-JQIZ-INF.js\":\"8d7d3a307ab6e8fa\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-Dc6ax0tN.js\":\"e69e84c9a9dd25e7\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-C6X9miFi.js\":\"61b98edbbc8f93f0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-z6f0Z0Wk.js\":\"1191ee6e7aa5938a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-CnC6XaS7.js\":\"ef4b773b5a4914cc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-DvyX3TuL.js\":\"29db0198631d2be3\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-C3kV0vZy.js\":\"b15d29000fbd4ae9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"497b621fa76e4d7f\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"1e44ad6c9b70ca55\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"b8529b8065fe75c2\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"d7b5d0906bf06256\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"55d6b45d88d2a841\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"cfb618f6e958ad95\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"832b8342d8d9c046\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"2180f91da9af7cd1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"7363f55a5a6c3cf0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"f41a1c526afdc392\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"e1c7af283112a6d5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"c07a2ca5d69571ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"466f37f7296b7380\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"717a3b7a0c618079\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"d3450ef624d8e094\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"3ac6635926de76da\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"9893be9acd8ff1e1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"6a5449f12bbcc675\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"caec08f16d0d82bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"c2aff62d98e4a474\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"cc7ad1349f12f340\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"655d90d1b4911ffe\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4a6f7047f9356330\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a8bbf4a2efb14de9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"77a44e24757103e1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"03ae7969a9eb970a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"08e4635963a1901e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"1ab64c36c3c68ad7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"41eba29a08508167\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"1bceaff1c19e769d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"99790c7fb5266971\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"ab310e976d7120d8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"529b6f20858a747e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"38e12f98bcf0ea76\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"4e99da951f104ddc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"9c02bf87a9c54591\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"7c6fca968344e4a8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"d112b732e4ac9fde\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"02a2cb382584d8ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"69c27ab46312eaa7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"37b21b47a4db038c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"486404c8e13c3735\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"044d45a36cef3553\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"3e5cacfc7e85a37b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"32d5f98d11bf984e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"48be415dad9aa093\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"e2ad8de4bccb1cae\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"78488b26c53a1029\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/CompactReferenceLink.js\":\"c9ca79c73f8cdba9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"f81e1b0d77edb35f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"bca461934ef53a3d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"3527358fe88d6da2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"e6bdf919551b567f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"af4eb77e007eec4a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"317107a162bd0fc6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"fabdf630fabaa8e0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"ab94f42c46cb0254\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockReadText.js\":\"bd31330a5ac76c9c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"d9bd720a5a26b7d8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"ed4716bb085dc3ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"ecdec5a17ffe80e5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b972a0639719b5c0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"8dabff5fb94bbd1d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1048fbc221960686\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"127db2c0cf6f264b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"7803b73fc6f541b6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"9ed282eb19cabb99\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"710d5317a1b0dc39\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"504d3f92b949e451\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8bdc8e8e20680d1c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"1bc13dfe1a757300\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"18d7d2d4a1a889e2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"cb019275000badd4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"8abb9a4095e99db1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"c561194845d9ddd5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"7b59a557c7324a28\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"71d0a31149c4222e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"458395f89e4c7847\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"e244ea95a80b5865\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"eca4ac86e77c2271\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"c7c4278be104f97d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"7876f61788254457\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"33317e2600c6f199\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"db3e1f4867c56347\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"d812e3082fac9272\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"14fac3589df045e4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"9ae853bb3cd4b698\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"aa371e1c641bb77f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"5a9d7659e602062b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"47e4e4c765560a80\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"43e8f6bee1049277\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"7522883a3b5ceccb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"e0a9bee0b37b1f20\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"36d4701bcf320ba4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"183d6a0d837eb2da\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"4a8fa62ed93227c5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"6888f17c530ab060\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"caf1b3f42644fb15\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"23a97b130d26b47a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"d411bd2b27a86980\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"ec7172d7009a2666\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"11319bb3ad38c235\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"1b605c023b9395ef\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"d7b68ec9a1508d44\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"494a89cf4f39dc8a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"8c4aff26d9100ca8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"3b645df80224c286\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"e8483c03ba25bdaf\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"4e027de1a065529e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"f9babe5e47988796\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"0071a6799f2c66aa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"7a7182172f7f7d13\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"eb8bedb3e8a4d0bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"0a2ef73bcab92873\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"9869873a518024e4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"0a855067769ca3a1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"c44cc4262a4e788c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"66c9f1e85806f0ba\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"efa1a834f777b47a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"cb9551066c8adff7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"0ddbd3bf99b41dd6\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"93adec2a63d91eb9\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"a7652e04e08fd917\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"f5e5e3272c60f518\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"a1433614fa5b5949\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"16cde59677af054f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"ccf09a5c8c9e5668\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"c1c1379f7e5dd92c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"0f871bcdc76ef52d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"56cd8dbabb9b87c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"d59784f10b9e46e5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"01089fe6336965c8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"8e2ef9b23d1df9c7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"ba0543e75167b726\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"f965c79cde2f0a1f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"210432f873622972\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"0da7f30fcfd8db48\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"36616b8f7f3200d5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"7971875469471105\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"f54a88fedd0cc4a3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"d0637c066991ee8d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"e67f0cef14dd4965\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"210432f873622972\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"210432f873622972\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"bda0d6668c9d4aab\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"3f5a090618d58ecf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"b6cdd5b303efddf9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"7be731e022dae8b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"516bdb3be19f2865\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"a65a3aa3407c9be5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"7d118e4cc4308d69\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"db7352b76f587b6b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"63750fd3560e863b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"185e15d7065ca297\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"d43ab810dc332434\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"578af97de22d1505\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"074928371959e865\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"a0d30b6e31976120\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"4565cf9b51a921c6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"496307372b722b9f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"a314ed4d92d45415\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"66e83562779f44c1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"8fb0e4b8f11a8b91\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"078e23e624d3790b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"b54cc4e5e2166f1d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"cc8c035794b9292c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"d7e07d9102902169\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"63a184b046b59b55\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"211121cf207a9586\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"970b0aa0c3b5d13d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"be252628c42784ce\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"31595aa8d8525255\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"d3a41b28e60ab8b2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"7644b98cb6779337\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"bb574c42d8dceb95\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"6eceb37eb8ef845a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"d65611179928dd91\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"10c0845e93360d5a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"8eeda8c889841846\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"1b262c9779a8231c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"71ea7c041f4bf6f2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"92c61efa2a6512f6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"5cc98f484d09fd24\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"33852f9651ebc34b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"65064f7b664d8420\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"f37b50414958c8d7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"f81af4e0f70477b8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"f95bc0657e8e945d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"c1ab40469f1a30cd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"e745155b405c6f24\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"eb9599ff6be40a26\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"80283fc738e6a069\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"47df1ebd20612cdb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"a51c1ee6a9f0b4ae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"103dbaac1cade2ed\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"dfe78d2cccb53da7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"bae8b94016d9da09\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"0ecc0ec72da29be5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"ab2427188fdd2285\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"bc1dd665fab9b834\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"5f53d104901ffdd1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"9193f67c090e4de8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"16e13f8e58dc01b9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"0f8ab9b90f644eba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"395c2e3d11787dd7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"969df0da870a007c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"7938923a961ca470\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"c1a1c2b8cf29324e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"73ff7932ccc64e91\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"c0ce046084c68652\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"0f48d2b3a9ecde13\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"b5f08f64655557cb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"901c0e43cdb697f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"7ac1bc0607eb1cef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"bdfecb76f6edbfaf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"d61dc93c8abe065a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"a64736abc955a591\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"d26f27aefd700472\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"7b4a21a106df4285\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"4c2286d5a07bfb35\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"a49227acbc5b918d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"7ef1be39e552d721\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"899f4471d90e3795\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"cb8a7ef9f256d1ea\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"acb50f5b5eeb8814\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"3610719120368c99\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"8d66a3305536cda4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"622a6f85ad7e5500\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"e51cb895b31c34c5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"f9c2f5ec68311a6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"78f65b2217ba5d0a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"36ac15337bad7b92\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"b36b2dd56e8029f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"05fa277c061dfda2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"e677248c0878d990\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"bba11b5cba1d4d48\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"f52f79458ccaf238\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"cccbbe7ff16ba437\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"d60ca347b140a521\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"618952daab2a3b1c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"abd7478dcc7b074f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"069c6d2ce63d16df\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"e854dd3972a26627\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"7894b01e94046436\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"2dc738b8f02302c7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"ccaa74424d559198\",\"/knowledge-medium/pr-preview/pr-1739/src/data/refTargetComparableProperty.js\":\"3e26fb92fee1df15\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"398edde56082b2ae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"f2f0ada3f057b45c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"ea6529fd8846cb7c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"6d00c969b3063619\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"4bc9cd08f85b439e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"78a8cb1374cde625\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"280ccd0830d7d8a2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"f3f3889e224f40a3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"9c95e7130c25b1c8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"40b2a97b281443fc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"9f995d068169a145\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"f2328b3b22519b02\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"dfcad2cccddf89d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"3cdbab3ccd7bc7e5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"d39bb4664b59201b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"0363d16ad27552dc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"a842e6f784a82482\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"ce89cb089d167c45\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"8bc5039da19fc1f9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"8adc2e0ae2cb7d21\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"291087ba0244a901\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"712f8c632b878602\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"9e7c52571b8ae03d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"db0a4bfd78362291\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"8830f3953b83ee86\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"f643f507a459463c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"9c3ee4e1cdbbf375\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"2b9e1bbf1ccb5fd2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"aafb783d9fcdd3b7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"e077c4f9444c10eb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"c675463dad2168b0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"844827cae1d50a58\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"aa3378a66a601648\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"f3c83cfe00d737ad\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"23a66515920b58ea\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"58beaaccbedcad02\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"98d4c3c805a9b6e3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"87ac7dad7a57c781\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"f7b22f5c29d9c228\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"953b50a1b230f740\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"29fe5c51a5a0f289\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"b9a88e3db15528e9\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"0e41f91dce543dc5\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"0524eecd9213e47a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"46b0fb82f4082082\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"bcdc3eac43f3fd02\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"6c2e129c9380e91c\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"5e2730b87f1adaed\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"10a4eab8c58caa38\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"00a496f9d97ac1f2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"977a24e20a47ec44\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"546f8ec02770796a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"417155813acfe98e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"a3cbd28cc45b3873\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"b349d8c351daf019\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"ccf08e9841fc03bb\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"209d14bc31679392\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"0efaf32145a7f20f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"780f53546348f613\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"956ae1d5d99aca37\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"a7ed862ce61a2b91\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"fc40740f686a1790\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"cbfb94fa2303b15f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"2895f2031bf17f71\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"41672c10983b1e2d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"697c212db72d483a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"8103dce78ec8581d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"ed2ec670fae1b988\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"e1aa35416311e04f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"91589b4119e9d553\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"49af1ec0dc2a1f60\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"a4fb3a3b432bff66\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"bdc27b128a9ce20f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"e63b47a9824b670f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"5696ef6ab6ef0dd4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"9a3a8da1fe5bb9ca\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"16abc1bcb2dcfb5e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"0a68300c7f147b40\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"503a3e185f523625\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"29fd66aa07456f33\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"46765d3fcd8bd70e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"db82de3e44f5aa4e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"a3cb052ca5b4f9da\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"e674a9946bbe5f07\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"a2b1b31de1ac5833\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"1293c8efdbecf197\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"9dcd26239845c88c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"d216702d5bde40c7\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"c5a6149911a12b31\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"09a22894a5dd4b74\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"4721f577d92e8386\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"c7ede732346cf479\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"beb269362ef7aad9\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"787d5e1070ec4cfc\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"536a87520dabed2a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"6470f764397c9109\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"e5c2c943ffc78053\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"ef851c0d4111dbeb\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"010a2d15a755eb80\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"b398d9a458edcfb7\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"9574c3f0b45512c5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"948dc14f762ab298\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"98519ac2504d7b87\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useFacetValue.js\":\"eaf2c8d7ab7264fd\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"4248f508f41129c2\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"022b7bd765ace8ac\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"da3044582c35d99b\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"da38583944ab4f37\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"a8a81b898dd4a9ca\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"aed47b58364fd1c0\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"f18f551691dc4ee2\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"8c11a0c7cd2ef713\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"dd379cfc54e58c44\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"bd04a9064cf56db2\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"030382cfbda8476a\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"4f955b55ba769a1e\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"4d26c1d10aac5a3d\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"a9aaee3b944da8a5\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"98f547fdae9e1394\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"6f7a1b580ade6cc2\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"1fb6d7d01b1b7e86\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"f05ff1429197e297\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"dbbd064148bf1aad\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"dd80c338351a2bf1\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"632bb5184484af06\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"138877b4e57ea98d\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"eb5e1dfcbd13a0f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"eb08ab4ca9f2db3b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"747c8f1e085e919e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f1355c345be1369f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"d8d6326ed7c3986f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"21b6885dae223304\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"19c8a57d8018a69d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"ef83a0735c89b199\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"62f8394bf838fb3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"e503f1e01fee4cbb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3c3d8c497db0be7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"1756c460ba1dd0a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5a5fe433bc0569d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c3519abeb946582f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"14d59fa306342d60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6d764b85340bc440\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"8f223f5e6f4d0606\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"efcea1a6bab83eec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"42334a90d2db6155\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"b5851322e0b194c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"825011b601b7e607\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"dc5c990697a4da77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"084cf8dcad62495b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3c3ae5478ba10a82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"ab582a5c70eda792\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"92e082eed0ff0e1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0976dd99c5fb58ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"5a878f810c22efff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"a8dfb806dacd512d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"20360b0639e0efce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"c40b73f0cc71e6da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"2f40a41331a36071\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"0028564be20b0974\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"312e8ced1d288e24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"55dbd688dca2964d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"14477554157fab57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"b0994d36074320be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"84b607bd0ab4ad07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dayPropertyInputs.js\":\"b5495f154a18b755\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"91189aa919b631c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"528adce3081ebc8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"93948e4f95d6a762\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"e7f98b69d8ef89fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"d3f2ed98e904f732\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"ae49e6d295139de9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"650b2c7aa71e3e5d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"470d8e2dd250aa70\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"02399e372770723e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"222693d546b91862\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"f27c105007737791\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"4661f394b7fb8ef1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"bf073d54b105e8a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"fd579b5a37a73d2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"6f1ce996f63bb81f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"9a9f503d580b77e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"89d658a95e669a2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"583cabb2e8f95400\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"2bbf62566a5ed226\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"5d717d0bc973715b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"0b94410eb0347107\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"004857bc6a54920f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"14aa5ce796bd9f4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"b5bcef53f085ab11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"bb51e181bac95b28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"569de6e8911922d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"ba3bfbd10ba4b3eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"45a250007889000f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"97fae57e5746b12b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"1511b23ef0f77128\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"f8aab878be1cc224\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"a6b00f984c0818a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"519e8f2ce6a33c78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"7af53d6b6f7aa8bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"562dd0bda17bffa9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"d7c3e37e9c81afbd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"8cae52d333789997\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginAnchorLinks.js\":\"d543eedb0657984d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"76d1cd28ec8ee5d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"ebe17543c93821c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"57efd7cdae7498c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"f3bac6b210dc85ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"c8fd85393e79a2f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"244c847fee22fc84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"d14ffd3991c09afb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"9180bb7bb0971562\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"28722ae139b3e6ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"7b7a5134adb83437\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"8915df0ab02dc54b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"2a8f4c5107bff791\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"858261553dcb97e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"20ab89c39d1a7e1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"89dbce003a751990\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"ba9db1727ef2e608\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"cc2a44deb23f36d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"6bace4012f1655be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"5cc37c7be4662669\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"b7337556a78fba4e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"e3162b5589b0070d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"bc125897955cf90d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"73fcac70bbce6b5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"b445734ab7ca0d49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"ba2c467c4ad15080\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"0865b6754abc1234\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"be7b03ef6d761aae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"0c4e9eca2f99ec84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"7871d570b7dc4b6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"d053ec00942723da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"aad4de680c412069\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"29c6f2ac40c99c04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e87fc23f4f7fe1ca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"dc1d8e31e4862d6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"76414016d242b975\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"16b11d5f304abaf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"70ca09014aa55b93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"37269bd5e95f78b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b72ce3177989a0de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"07823aa2b91a7450\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"e0d82e9cb039cb1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"3982dc310083262c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"f1d2b5b54237f532\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"532ad8b0290d3a88\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"0469a6d0a9e02d51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"0e3c8a3a575e9054\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"814f65184e1f2a86\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"91cb3b062ba1a55f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"156f90b46c307d4b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"acaa6e4afe3e6877\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"f7619b4399aaeff9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"38e12c949e468056\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"0f20aa4fc4569466\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"84f6ec0a00a50bc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"ada1d0d4da0ceff8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"32adac2f7629a7d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"5902189cd4f8989c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"41c81c12ba68ac1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"dcd0a0e55b4bce4c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"84ca39e325d2522a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"449d0ba4e9bbeacc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"53b4967ef497e3ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"c12596fd2e8009f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"391d37136a46bee9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"b12b9d660f3714e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9ac41e8d28f6cf5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"4c62f742dade41b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"2efccb0947a271c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"139c9eeec3f975a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"182694336a7f95df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"a17331243f08ccf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"225c864c6fd431f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"66e6f5532ef3b405\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"71fc48edfb4dee0e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b274f5e10237891c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"eef6a3dc3afdc1d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"c39ab36a71324501\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"942b67aaa4f82e38\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"1c6192862194165c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"54803d9f88bf4d0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b3ba25d5572540c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"e4c64fba31eff37c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"e202bb0ae47126c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a7b4d8e05feb2c6c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"e910d29e8fd5d8f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2c306546fc1a5d44\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"25ead1c253d8f78b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"e359ffe47650b5b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"ae78ad325953c835\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"c96946073320a803\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"cead7c1f0923c68b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"75ec677c5aabfbb3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"73415b42793492e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"9c830c62038f024e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a0e899bf2de48803\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"bc1eaef116bb8945\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"ba9f75702269f60f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"122f504ff2815d34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"019fb3eb0914beb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"348a50fc74e5f4c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"e3d7611eea9eb829\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"2acf156842ce6562\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"81da9d0fb8acf5ba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"aaa01f8d8e903796\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"12f4b56b074569fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"c9fb25ddf366e5f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"38d64d076ef99b22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"50035a8bdb061faa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"de88381285eb4c6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"9e49b77e6d11c44a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"6c97329328fc53f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"1bbcfcbac6073428\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"c9418f604a68d31a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"298203f535f4ea1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"a784daac99db660d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"b9c7df667c6735cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8943db872f7731fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"565125b75d6ed1e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"147cb63b9e53c20e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0c2144304b55866c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"29a58933fdc81d07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"f209f7446b651f2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0c3d30b024dd4dd7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"1f163d3a0b3828b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"db973f767fed92d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"41f2e5722bdd1faf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"84d697e5ec8c1719\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"b19e75e87a15ec7c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"b19d6fb6f1c93506\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"50967abe1bc26bdc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"7646ac7b2e3b35bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"bd0daa3e29935e04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/subtree.js\":\"c3a216765abb8de1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"f26bf1b22c38a091\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"79b725f3fa0e1747\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"0259ff273cb2f10f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"c629f8ce49758146\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"3cca2b6ae4060743\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"8c955d7301b7283b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"4fe92f4e310fb418\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"b6d7a5d417c92770\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"b771c20b6773bddb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"87eb53364ab205ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ProfilePicture.js\":\"cd6e6f382df29c7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"321c3ebcd5c02a0b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"d95f0d2713cce886\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"89d5dad758958129\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"35ffbc7ed09aa142\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"427174f377fc4fe2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"3b558d63679623b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"63136fdf74615ea5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"5939feba0a5536a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"906d0f46614c1d11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/useCommentAuthor.js\":\"5381bad8a0b336a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"702b045359047411\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c3eada0c3785c9f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"4e1e27050017f694\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2337d8e30db3a87a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dea5a7501c1f9c83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"c0483a7940a08839\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"462eb17fafe6afdc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c97037ecc55dfa94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"46e74cf58b7ae9bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"0e5a84b8a8e9d1e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayPropertyControl.js\":\"17062422fc7fab17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayValueReferenceControl.js\":\"6c3fb575b11a1e8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"3b3b1cd1e71f6259\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"526454ca9b1f0ec6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8971ccdeaa3a4d83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"4201ff6f5d8a2e05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"dc5ed9b6bb223ae8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"cfb99fc5a2e0a531\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"d07e8a54e2336ef7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"4be83ac2268ad162\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"e09318ff9bea5fc9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"2217fbe3873dc245\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"725b141c3dcd4f04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5354b776b0af6ae8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayProperty.js\":\"409371b327ce32c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"faac3ffde73088cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"2223d1705b368ca0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"030b76273902c7de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"1796c7dc804613b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"460a820bab58f7b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"3812d03c192d4d31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"878c272607a0c2bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"ce6f674ffa78c603\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"8abffe7a407a3c6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"4cea54a3fddec750\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"56f8b83fba298301\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"b8737da850f339c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"301ddfd1e220a236\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"52d828627ae02e95\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"76c6e1065f9394fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"271eb7158ea5a955\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"222412daa7e911b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"d455201ce11381c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"38f63ab652c390c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"438f0d94f42c2edc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0a8d4f76be66288f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"19c5485b4447dabe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"6a48a00dcef7bbc5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"aeaefd913712365d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"417f3e670a4c4b8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"78ac7b87c76e061c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"557fff7620731f24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"e2e11497c988e47a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4463569c25bc53f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"7b3a4a650204a950\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"f4d622b6d1637380\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"c2df2b4154ab5775\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"3b8018bf166ed35f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"0973e0f4e7ef3b8a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"ca9081d5f48fbb9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"163e9275b215d26d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"995968764ab475cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"3365919f4362dede\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"1fcce5986a8c133f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"df9e65527f30d574\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"5f94d2a89a9d8e89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"a89063b87784f5c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"9e439a8971a76cae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"82b1a2868c16b581\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"73d8b3b408ee0e57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"77f5d55a1852adbc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"bc4ef431f9de7763\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"0b1fab2473bec2c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4398ace96d5fef80\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7cb613361d02ba24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"cc189b4fc71c9e2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"e44640151ca4d1a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"f659cab1ec8311c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"1ca4a12d39d83871\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"343903f65602b199\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f0619c3165c18ca5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"462cfa890fc13915\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"ba85c82b4194dfb6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0008b14d604b4c13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"8e41260a8c0af21a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"fb84653f75576729\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"845fbf45ef7e71a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"b8716d1bd0951f4d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"b8e23e483fc6372f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"012bd2562663ae21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"ab872d302238a390\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"c499da3b8213d514\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"11c95413f07a40e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"5f8e947a140298d7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"bf8a6fec1e2f0b99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"a28e073c3a737a4a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"7c86957ac3759391\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"6cb79721dfa241ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"34dff557f399359b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"48b748664689fa86\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"5c8357a57aa78ee0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"d281d88fa7103cbe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"e6a8770ce91d5957\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"68a9851dbcf4392a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"86c342ccaee6404b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"d66fcd3d82784464\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"3de3e44ed3255da1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"f47061dcc80fde8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"4c3bf98cc3b1b9b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"b39691f27f16e572\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"2475aac93c118db6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"de9503df0c14ee70\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ecf1f2778b0395f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9a5de2be631b6a3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cc73f9cb17740300\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"4b154bdbbcce834f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"47e81183ddc6a511\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"667cdcdd2d1caf58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"a1b08f7dfe2fce00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"0ded0a02b139d001\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"352a9b6b0a02e955\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"264eee6e71290ad9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"bcdf172587a1d991\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"61e65b4594ac382a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"289f4609fa619fde\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"382efed784c25431\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"4e42e880d8d3ce89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"87a849082cda500f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"265d4099b93a2f08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"2207c1e8720c02a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"a9662c39e8c6c978\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"06ddd6862a83d2b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"0e574f050462acd4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"7c52bcff1a7cac2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"c0dd2360a2bb5276\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"0796a07a4ceb8240\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"4fec107861505ee4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"711a8a835b50154a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"7ee92f5411442b81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"5541305ed2cfda30\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"d90b9cc4bcfcc949\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"8a5eba1278385baa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"3c990e2ab8e0a981\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"0ef11df2aeeadcd8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3b944c36d3a5169f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d539ddb8de5c083d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"0d79b33aa2903747\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"3e770991d1359721\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"83115820e82ca08a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"8705608c74d7e9da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"1ad911e4065a94fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"2d88b4d0dcc85b75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"7ddf7f873a714eee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3192d4954eb54de8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"5291b2d150114863\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"09dc24fba20331b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"2bb0dc9c1889fe65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"7f817a8206eb756f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"892b141e53ba31de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"55d9c27146adbe42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"48def669a43ea60e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"631a57ff79de9bbc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"70283cb456ea0a6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"f328684d8f1e8e4e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"8c3c3815355f09ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"8d23b04bdc524947\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2c0697b7a705a723\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9ef2411b984511e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"4bec028019c06975\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"51d28a98bdf129b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8a57ed16c35e6f62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5c3b2e5d8181549c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"45182ea7555bb838\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"90f494f07ec125d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"197db44480dda7f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1d6bbc55c22d855c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4e4c0989f814c996\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"15e8ff5cae0cf1b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"284c4df2e637c500\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"63b3eb788a050836\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"94dadd6620b878f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"af7c3dc81be275cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"ef950b98b031de90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"d4a3ead5ab7da265\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"46b655e1e97b7b8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"5064a2bd0a28d1be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"19054e6a8653e828\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"2221ed992e24d532\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"0f3ac535ed2162a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"4f8233c97ea1d1ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"95c0e18db0229725\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ea4c993386260b00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"1987978a0bd3ebfd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"e7914d7f95a76f67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"78f0d25537f943e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"fd620b36514a7306\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"a10ad0b601f4d1f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"2e30115677eba7b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"7f0d37b7debd2ab7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"d8146d4f0e636d4d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"c0bb955baffc4d91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"6e58bae93880e953\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"a1813fa41a2c3f18\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"7f374aa979951661\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"b1631619244f45c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"195de1794ecd0145\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"46c007c6c4d92b27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"dbcb531c624d64c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"ff5446f4964edb9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"ffb3073b863ab2d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"5da46b7cbf6e3b6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"0436fabf6fb2310a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"59caf267f5daac69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"0c8c17bdf8f50527\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"5bec9645c728b64a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"aed52b6fcb144361\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"6df0504a63d00bea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"02754e17c7633111\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"6b41ae38fce2203a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"4801ad1c446090eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"43fabd6932357480\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"e9518b777f170587\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"125d271d16d5057d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"17d0f804d7846247\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"1375b14b293d186c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"3954bb3aae254e84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"9101236d0689b00e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"2791a6e02570af8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"ca9a32ed370be948\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"b827c08b6bf7444a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"94fcfa91968ab46e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cb1c8cde7ece54d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"a8d96b9db086f969\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"8d700e2a0b507647\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"4642f38fa1fdea8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"26f4da6e99fd3217\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"2cafeb5c0df51e85\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"f5c49c33b619001b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"cbff8e4ea1742700\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"21c3ca17dd69ad37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"0ec6e501424ff033\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"d3dae4dbcb2902b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"298bfd558b3770a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f21706a1c1e2910b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"2ef4e0a20afa113a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"aca29364ee9bf8e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4241ef741d251893\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4f6213ce94c2a2af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"38fcb0d7d5a61048\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0502ab844889761b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"aa0687afea10f83c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"6b2c905b15c42366\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"1110d112c80f7a39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"5379ddd3e21a9752\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"0df570467d20f820\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"3ace7419a6d25935\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"d47a65e50d880426\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"15f0d5af4e6f1f07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"ec954f9f7b1b9ada\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"0c2bb7b157e6cc45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e577fed2168a77ac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"a30664b3b0f5e344\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"139820d77841126f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"09268ceed7490c48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"2cc4a2b46502f683\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"25f59f5cef86a5fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"037fc3d4a4fa841f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"c4cc3efa975502c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"bb2cbd5a7cd876be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"5a7ecffb41789282\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"cb35f3ed38609c8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"5b9a272fab8ffe01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"ad9ded11a6519dcc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"8683c02f6fc19f08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"b648db87a7e05bae\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"98c0cbcdf312c795\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"c400c47dd5cdf502\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"86b6ef4e6775adf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"3abdfdf69d115fdc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"4121b13b7c337da6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"c5447baad8477646\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"17902133bda130b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"38beb4ee430259b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"a741eb91cba0eb89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"4163408505c0c3fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c6fec09c33bc50d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"6fb1b901049bf8a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"563942b295ad9a21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"1738110f6ba0ece8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"a2f46022b0157b07\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b9f82ca47d45a1fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"ce0df020b217ed96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"ebb57af637d9c47c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f32fd4674e42e2bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"aea5ab8d1dba6836\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"1e62df7a3688d811\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"93b054b20ee93afb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"09323f2c1f9c03ed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ceb6435a3a2f816c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"7ad4c6c9ecca1b71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"497fa279e1b1780f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"58f6135af49d5a19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"c1c7b31e4a7c6725\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4f82ffd926167a23\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"67a030adab4297c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"592c6b09519bc4f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e1a32acaed342dad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"610cc869dbcd0e49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"aaef3992b55a5e75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7f225dcf01ed1a5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"415bdda5e6a70475\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"1dfb46e5dd09d5ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6a41e5a68bf9d156\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"11f8f45c554b9fa5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"d244e893826a5af5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"b78f7b817b2c522d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"3cee157306d902cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"de4bd1737636e5e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"08efad96d32586c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"9b13a1e1f305f5ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"a563c5b171db5997\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"72644060650e4e99\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"b1675134f6a68bcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"5ce222d229a911c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"bd43c912d7b36905\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"8d2df96cc50d8c7d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"f75c5a01829c9b80\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"d170b08427b00cc6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"8df00437aaac6c05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"bf3390928181ed02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"f50251e6d1989d0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"b3228b4798612784\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"69685afa0298139e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"175afb2c34f30e4e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"21c065834419652c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6bc562cf93673b81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"030de1ff391c4005\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"a5f1a541b5e8d788\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"527c44af28a0319d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"208cbe596c9c2b00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"f4e6120fb2cdeaf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0cff54f9de3041cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"d4c50f6765e7393e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"49bbde8424379615\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"3d14439de5be4000\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"14937d7068348b04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7abb8f23d2a2eb13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"413232527275ea21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"3a651afd5ea58657\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"fda7c6728662840c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"7f6fe76fcd0b1434\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"bf5417d27e5a0862\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"dc0f8d5318268078\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"1079859cd8bd11fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"7e0f346bc45331e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"a61cc20fc3adc7e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"2a5eb12b0d434d3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"6507426046b818d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"a0c267aa39677e02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"00b5ac34b913c813\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"f8b3160e8cef6d84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"c22f3075f9b6396f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"d2ef39d1abf91510\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"51fae7d75694ed1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"7de17a848245a650\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"56c10505383ed3f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/QueryText.js\":\"cf774ca3306e47dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"b9eecf2c56e1d54a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"4251abb6b0b269d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"ab3b760eea97b1d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"0abd64a091aaebef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"e4388b50afb9944f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/registrations.js\":\"81e78cab39035fa3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"b8b5a99a6e276c72\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"f833773f37e7589e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"4b2cfbb95a20f42f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"a0c0e05394a605f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"9487cd24ea94bb5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"61a93f038fd76e2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"6d71fbf228d36f55\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"9f8fae7d89ea0b90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"1292ac59f05127f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"8d8d98f250f31b6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"857a8b158f610cd0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"5d4eaee6b3907f14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"6ee308d447abcbe3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b019253c00b95897\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"7995bc14ca6f992d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"9ee54da48ec4ee9d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"3179681f8373e8e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"8f886b6548c61086\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"ff9cd919728074e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"726258c2bc5e3246\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"6d55b1982f48015e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"1b41367699bd43b0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"d6ee09e480f8db9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"eae059e5c9955571\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"02edd6a6596b71c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"646a403f648b19c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"fab3ebe343c73816\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"a0241597e7984dac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"26500798eba804fb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"8672a23cdc5450a2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"6222695c3dad6eb0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"b45afbb2c7171428\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"b59c441f51a2817b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"3fbbb155a6f051cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"c86927942dadb98c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"559f20a4ca54038f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"7e2816241c0a6925\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"4348cb1427d2abcc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"858da63f8bd90873\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"964ba9224c88e758\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"a887f003c9aabf51\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"9ed4d3cc5fe528cb\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"82d43e88df5e0c4e\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"a8ed131628642441\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"b98e2e30effe91b5\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"1459244f7500533a\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"4ea7c064d05b5b0e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"b4776262b61a2ad1\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"72624acd57cb083c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"35eef4e80383b7e2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"19f773dcdb82d6bf\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"9383332a29540cbb\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"2251a5e41baa568b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"98a9d569ae8b67b4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"9b96de6bd420f563\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"2c07e6c0c9fa4429\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"f0b5a1f3ed2da546\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"64ae8681cd900d98\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"76b4da74c33d896b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"3749d31979d07764\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"b6cff875a79a76f2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"0267fa880155e34d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"ca2ed0cdf8ecd55c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"a556936dec208f91\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"ac2e7470e2ed99f2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"974745752d0ac849\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"2dabd164888293c5\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"db009f8f47fa295a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"95511f12353f0f97\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"e873a67e6a01e452\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"36e3b24f1940da69\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"75090bb164f59003\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"6e402605842bf3c1\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"92b95d2288e9b52d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"0f3079b413c8d60f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"b1cb5f195624dabb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"43d015cc4eb499b5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"fa3e45a59bb5ad90\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"2b7101b09bfd3fdc\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"2fd875d8a41e1381\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"1181527aa6374924\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"2dcd48bb3607da9e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"254bd24ade56101e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"2ade2bdcd41b30ae\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"3f1ee764b5694ee5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"49b791fc018722e4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"e37cd6994a6697f3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"b036b20f4ccffb62\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"df78696e618835ca\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"e2ffea007a0e5ced\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"789fce9ab486328d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"01c5518f28ef8327\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"2c78058715f9a435\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"bdf9eb9aeeca3f1e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"a36bac9400d95ecf\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"26437733f763659c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"93e1e10a2e5eeaad\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"3b7de2c9a8789bda\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"dfdd9c3671e88831\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"dbb3e0ace5b4243b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"1562eac98d1e4074\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"26be2a899efd1319\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"e9418c16c41e459c\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"1968c97d9d27a960\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"b87e7dd0cb38bfac\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"28fa04c887956c51\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"f06467a42392af86\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"f514699706c17cba\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"6c5404d32b8e0750\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"5fd96cbedcbae354\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"de132241b66a66e3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8d7cdcd2d35e9076\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"ca9bbf9d8c29b738\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f31d596a309db7fd\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e19a3f1c1c1362e5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"0f86f959eba4dfeb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"c245ac8ac83a3612\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"8eba790eacd8f162\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"ea8a6149efe1b006\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"1bad2a5954847968\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"98b63f212393afec\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"e409aa2e0766a8b9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"9c54204183a8fcc4\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"6538d783bf5f6a1a\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"1be6387cc3d4f17c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"900d559c695bd8bc\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"20e4c95a9f25973b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"b02b5d0d59e3a87b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"e5ffb02607f1d43e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"709969d20d928b5d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"3f06206bf866b762\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"7b729e99723af1a1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"b17425ad5d1fdc24\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"f3ff0284e8a558a3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"b478de200c5a16d6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"d5d6a1956a191de3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"6403efba40f72dc4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"c956c2550f95ff1e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"8f1efc6cbd50361a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"9786eb8e8c16acf6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"4d24ee6528278918\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"05b007461ec23e3e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"ca3cdacfcb7f1b65\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"626ba45e8508a924\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"0a53319e573e39d3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"1b8408c202628f42\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"9bc53279b708f321\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"d41f04f170f4a9d3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"0d49ce8a0090823e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"f7d35105731abde3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"2f74bb17b1e86b02\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"8051e363d8926d4a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"85a7cedf7b5dc090\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"2bdb450344b810d1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"13bcc83b1686d329\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"950d0b26e85b12db\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"6a7ae74f0d31048c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"a112d480822ef91d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"0b5cf09f1bd89b6a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"1519fa9b02c15970\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"ee79b2c6903fd2af\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"b5baeeb34adfaf08\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"b8afc38816a86a28\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"dd3f2179431f7b31\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"94d61f05f7788c80\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"9bd7ec82bbbf1660\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"151498ee8b2fe240\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"2d7205f9cc2e465d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"51e2aecec19de04f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"5662f42d33f70072\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"bde2a0c98984a174\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"8c8f5f4180cc40f5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"e3b0c49b76355418\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"d37b0225da9797f1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"e418bbf339422deb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"a3161d3e33dc26c3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"0e7b8c41c9d9581e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"81e742316779eb72\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"469275c1c4f9f9f4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"3c80b7aa6ccf5b72\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"edabd1ba081ec271\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"0d250933fe9f6388\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"94572341bb8de077\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"3f5b21e417249f90\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"b677781b6ffd622d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"74cfdc39256ae56a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"b1a8cdbdb5199217\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"b381ab7366345bac\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"6be4b469c3670888\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"1e199dcc4ed41fa2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"61482bf861e1ec64\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"129b938160ea9c23\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"483da96f35231040\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"629fce802b9b3004\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"4c906c204cc7ec9d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"18bb5c0a4551ce58\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"3fe2d527d43294ab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"ff5a049f6af3717e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"901ae17ed1ed71f3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"3a768b0014be938e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"7ad00b04b8affd7f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"ecac27b485881111\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"3103693654195add\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"bcf0c9c99a70bfe8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"ef52670d9bfb881a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"935522e1f23154ca\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"e9a24b869c9c80ca\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"06466466d2c85b35\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"57862959c0dcbc50\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"1f532c883de45a4a\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"b7c1395ecf990ba6\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"2102951e624570a6\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"83163b205ee18590\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"df2e0d0c2c2dc5a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"8e2bd4406e783f86\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"6bd7abf0d53b9ab3\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
