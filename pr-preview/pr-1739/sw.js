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
		buildId: "c87bade31ec7-ef273791",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"121d5a40090bbf04\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"121d5a40090bbf04\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-BijdSol0.js\":\"70cfc45d9dc7b672\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"8cf933213c86e501\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-JMNWqDru.js\":\"ab82bcc078510824\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-BfjF-sIG.js\":\"fd57addcc51126a1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-CxX8DbPN.js\":\"b106cf1dd7a6b4b0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-Dn3HSprX.js\":\"555264317f2ab2a1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-DILnoa5l.js\":\"ed6f7119ab18e1fa\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-CGqDrxW3.js\":\"171ec6406de3d345\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-RnNwtCul.js\":\"15d838a3d29a8a9c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-CQTH143P.js\":\"cb562fd919a671b4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-DecLvYkI.js\":\"13dc76e7dea540c0\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CJfwPD0t.js\":\"d778bfce3a55dfb9\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CLfKyVmI.js\":\"d21f22fa67ed2b37\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-CzR6Bl9A.js\":\"b772122fb2ef9820\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DP4o7gS-.js\":\"c9faa4eb6a8fc170\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DhcsRVnf.js\":\"68876fbce8d7f569\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Dzd9Vd8g.js\":\"b8974fbc12e90c80\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-BhtrmASh.js\":\"07470cefb3c21295\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-CkbLGam_.js\":\"6d5086cb7046595c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-xDbbGdLB.js\":\"973d4ca3a14a61b2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-hhMue9tE.js\":\"107e4766ae436dc1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-lgW8wQ0R.js\":\"175b73f8ecf4c26f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-DdXL6Q_l.js\":\"772f5d0dcb3ac7fd\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-BCd17JIu.js\":\"66b3dc767b91de4b\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-B7D_FUwK.js\":\"122266adfb2803fc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"cb0257f00eee64df\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"cde11be87de2df1c\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"1df0c106843cfebf\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"f97f1124f46bbad2\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"fd998bd0c9f1d2f9\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"07b3b806e067dfa7\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"8bc31beb19dbeb8b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"056fc78c5f26f08f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"8a29f6edd9bcb35d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"6935a553a6e7a0b3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"742a9e62594c596c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"b03b7360775f5e73\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"4278444061160feb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"c0e5c5e6ecc5d127\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"1742d16fb024f259\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"ed643afc4e352b39\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"8ba58a2bc773c3e6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"84fc74bb361d142b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"f494553071bcf8f0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"3df2677a646199cd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"262c6ca87ab1ead6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"90fba74cd33f5660\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a3041c750117c817\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fa58c888e241a4b2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"dbc7452556922146\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"1704f77f3579f5dd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"42357110ebfe9b44\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"2252ae37bc41ef84\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"6d7dd19fc368be77\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"37052484e8fc3627\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"23fcd1babd68e953\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"413b4dc3bb40ff73\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"79161cc07cc82da9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"c0e00ee69b39b72f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"aba03f75c1dd01d2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"6246e6b5606c33db\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"4f689f39fc972d12\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"7c8a97a0eb9ee242\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"405aef39655212e9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"d6a20561e13c3a00\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"e6e2fe7d3661f502\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"cc2c1a963d77a1bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ced5a0d910a73e5f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"3c76712e23335882\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"9d128c191292516f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"6201daea383f60c0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"91bec64a2e0cb872\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"0beceac4dfd88065\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/CompactReferenceLink.js\":\"bdd2a56512d9417c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"7354d60805f49244\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"2ccc5bf022a935ab\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"ae669e50893abb3c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"a26c481c98e8cacb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"75fdce944d38986e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"5ea068d5d2b35e9e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"313fde42cdec6f35\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"f7f19493903aa5e6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockReadText.js\":\"59688fbbe0e25d76\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"851a6806e34a10dc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"478107db136e3f89\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"a007995e5d03de0c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e341974d7b54eeb4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"1cc8483ac3a5a5a5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9db27609e4dd5def\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"1bed4bfd22d3d48c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"a1709c03402df4e6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"e89864b7a16e87c9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"1859c903caeffe29\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"46e16651f8283b78\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"85db36728d56649d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"45efb173e79b146c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"46073b596e671a55\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"5996d7bee9605bed\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"7697c3debaca7702\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"014c98ccf41555c3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"6d7784f4fc940fe7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"cb420a78c2e7b0b8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"4ee317df0a330f9b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"074d361f6b55723a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"de1eba8dc3ba9967\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"9443eb3c757ddde0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"30db951d7ca9f7a6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"70b44b5da31880b1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"4fb21ca58ff6efb2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"13740a71bf484036\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"2ef857ebe958dbec\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"d8a3869c47d4e16b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"5d561397c85d75bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"08e8851126651613\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"65b63ec889b65c9f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"9dabbd5c269fcac6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"5f39c8af74f9343f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"ff3b631a6e0b5fcc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"33f9901564094314\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"a9eca81b6fb11eff\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"f815126b0981697b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"d6c3950c2c20b45b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"e77c62487addd61e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"1395850f2a5c13c5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"3655b1baf0918a15\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"d52fde17d0612ac4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"49cd0ffd6ff6eb04\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"60b9556339703646\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"3483e474296363d0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"2e230c4f0eece86e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"41cbb84eb81d306d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"c633832c24f27b0d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"c276dcec762e0e58\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"c8787447378a99a3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"60b379d8acebe6ee\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"0a10a18d8f0c47d7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"0c262ce1794ed77c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"730aa82f1f2bdc17\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"95f788ca882bc158\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"49a7771b37cd67df\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"39896449080b33d3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"f79ffe7c95c2a8f5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"f2b01fb8779d5ce8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"729a8f622286d64a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"2d0f20f16d248206\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"b82b1f50c989698e\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"8e009d2468f9ce3b\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"c1a004c1c9ae2de5\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"635c8809506b9f38\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"53f6c70f7366e6fc\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"9f40a362acc248e4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"9442272ed54c48de\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"e6238b10f307034d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"f969ccb4d11215d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"1c98609827690957\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"f4eb3bf1b1cbbc23\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"4421c3967dd4890a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"95c35dce100a87de\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"246b8b18a61acb31\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"99a36151bfafde22\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"ae8ef8d62c0df8ad\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"a7272eac64ce2daf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"805b94e72c5d285f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"03cadc1961e6a204\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"e2a8add7cc4a6f1a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"165ca31d0e298ca6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"d616d86090517b6d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"ae8ef8d62c0df8ad\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"ae8ef8d62c0df8ad\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"c8c76aea9298a546\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"be9b0c6e2225956f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"c0f19d53d9164777\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"c126bb8323f86f76\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"3f44ffd4ca80c90b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"fc7577216782f4e2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"5ca2ee78cfead79a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"a74362db119e5c60\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"54df3412e0453a61\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"f16768e502c0c504\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"5f4c3256bb6a8da9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"a0c3ea85e4cfc39b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"c3622b49cefcb11b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"6bb87f57b74d1ac0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"5f727d244940a443\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"7ba1426bcd788ca3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"06165ac88a5acbc0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"1d0b06d25b374855\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"31c95a0731ef5ade\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"87602152ba0b8118\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"a037d3cdeaed8ce7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"9e344643979bdc04\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"3746984d72f59293\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"fb89a6702c621b73\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"fa60802c87df8fd9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"d470daea4c7a2703\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"880703088440fd68\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"13843d13dba4b282\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"0f3c5c8f393a0687\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"e685f25e4961d2ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"144a2271394d38d1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"e682f4502ab4db67\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"d5f128c08d5d3233\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"ed0e034d0e3461d6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"b5a4aeec2d8d21bd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"85cab13b639a17a0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"54ca797e6d066ef9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"0f88f933cddacfd2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"a0c43c79288ab2d2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"6a6bb5c6613df6d6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"465bca53b145248e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"e206e4ecc856a02e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"71902fa77cb04a75\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"468c8fcef098ca73\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"6363d0197ab24ab1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"0d3419f4e05237ba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"039200f04f8e48e3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"71a7b4e95af72119\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"9301396d92ece031\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"f3e57af05405b913\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"ae2508c1f4ac0b96\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"3a20e3f53b224f10\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"db7776b905c3ee7c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"578fa741571fea1b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"826d0a9243d7ab71\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"726014862a28c2be\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"7a42496a59c099d4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"34bb984edceb3c00\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e6813bfa865a7e2c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"43be26c163478777\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"68824e5775c5eb54\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"46ddb1a875f01649\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"b686a1b961e04b17\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"f89a21273af4b943\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"a6b689ce77d1e024\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"6ab2071b4e9fe2da\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"3257b05bcf4b5775\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"5fcfc50bcc852346\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"f6c85b297180ce46\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"3c511a034489e250\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"6fc9a990699b7cf0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"ce74c55d477e03dc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"6bbb56eb1f8e6149\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"37e1c25d6afa4a4d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"8899608ea3fbf629\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"905e5f5a0dd51243\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"8f8d42748b1840b9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"20fb4a8be89fe0bb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"07d4844630bbdf51\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"ae9aec995b563248\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"159b2ff007986338\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"ddebd8f1a06b8b04\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"dd65110f2a04624a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"0cd5e086a5828003\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"18ee931d7a550b5f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"a0340db38ff780d5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"8050c410e51de91d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"acf63d2e40e1c7c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"425d39591258553a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"0b8b67e44b74dbf2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"b1169a29e0965c53\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"ecb03efc429e3ac3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"f64afe23a6ddcf9c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"8d6b1b5c10672cd8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"b6585542785eea06\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"a4658061751e3fd7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"b9ce8b98c61f4bcf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"2bb100f6f92416bd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"646014e08ad180ed\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"922a7809ebdd9d73\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"9e03a55e620f1315\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"032971d6e857375d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/refTargetComparableProperty.js\":\"ef530abe43874fd4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"01799fe6bfaa5350\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"c5f9dcd81223fb54\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"d3cde57f24b15613\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"283289d6a9ca5a7d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"cef4f0da55cf534b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"7b144ada943699a4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"55d385b0c7a28334\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"396a7bc19ba42acf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"611e9d1421555f2a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"0aad3b8f288c47f9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"e63a161a3031a036\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"94c402576db9e92e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"085e76b5b82bf9ee\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"3cb13639ded52cbb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"132807222fe8d054\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"45b29c154c5829bd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"3f7cb23040a6b4b4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"224ce553104f0b2b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"6c03d63125fed7ee\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"5aa7cf278c210801\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"1e8e57a5a576ffd6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"739645f09944d946\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"d3e2a5bc9b8f6382\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"90c54454b9426e32\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"8378a7e3b4d832c3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"eca9644aa14a4033\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"de698786aa04c1aa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"342fca998113ed27\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"16a6ae6ec88adf3c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"c45de6f206d8ae94\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"43547ee3bb2cd8e9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"1dd62a995971b2f0\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"2831042f6ffb77c5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"772f2fcb6658452b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"16548f5aa3a57bf1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"ce4339606cca9a9a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"eeaf1c39564a6705\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"8596086a80cde5b6\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"3a5a7300c1d8c589\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"689ff7eab92c3940\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"1fceefe1020620af\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"86b6e919dac7814a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"86eef5a7eb2c2e74\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"03ccc153945e51c8\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"becc1b12ff593403\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"c53c08049a2a3f6a\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"8d27d596ef718cfd\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"f4d83e387a37f9c9\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"6d69349ab9b1adbe\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"196de11a3e2c0ad2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"a73211a306d12c9d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"1d189d0d87709ae7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"42ebd17d9a51cb5e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"5e8c76444fadff69\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"63a9d38d3adf41c8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"3816c967ede70f07\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"bd36ae35e17028c9\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"1832f0630f1560a4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"9b12c2e0a7b1e9cd\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"bed4b6a6d6f071bc\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"f7e687be3465e8cd\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"e970ee6a8d324a87\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"6cf2f52acc99ef2d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"355f250e982f95d4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"9e6dadef09c725ff\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"0d0389f6d8311364\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"f86f32bbfe6a56a3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"82eda4b0f5ea2044\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"7649b4a5700cb839\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"d5cba35d376f91bf\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"3b001b7142c7876c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"c58f0ced3e76b07a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"7be1f41472244169\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"887db6596e17131e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"46a1a2a525150bc6\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"363d1f273299f830\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"eda7ebc5ff43e260\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"a2c3d00ebe2e6657\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"ce154423b18d5f92\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"77f4f15911758c77\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"172752807f841d4d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"d58f1723bb4ec3d2\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"58233cfd1a1a21e8\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"f4e898a1074f1f68\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"d8d911d5a89cd8dc\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"224a4573598f1259\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"bc842d0e70bfc066\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"2e960516de767551\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"e49aacccb4315831\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"5bd7b547e1c0ca1e\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"568a319d1029fda6\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"3638cac08ae1e022\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"179a5e1ee9dc34f2\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"0e465c5ebefcc8df\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"52c52274747b8c79\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"27bd85ac25d3f01c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"26741f15f5f2efeb\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"a4eb98dc1c823e64\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"6e1740cb182bd2f5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"97016bfc50b97b60\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"805c22c8cfe1cf00\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"b8fe6ef880bf5c1b\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"ec5c8d3ca880ca7c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useFacetValue.js\":\"fc3ecc261f3ae0eb\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"e5c3e4a39b6b333e\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"f7a763e58bd31229\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"2202c10129ee79a9\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"112bc4b85c45737a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"1d05e67db42bd08b\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"00210840864d7302\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"a123158ec8908e6f\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"5fe1013922b7c3e0\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"0895df5d811c2e33\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"a73bdbb0026715f4\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"f679dd1f9bc16369\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"2118bf619cbef64e\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"f263fa79b3418848\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"d815a3fe4c277865\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"dcbc12fa50c71460\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"af132506cbbffb2a\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"2e952e21355de6d3\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"95a7b160e14be481\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"41e6a90bbaa78622\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"b8cda6937e22ab96\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"573e79cddf68b137\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"fd5b9c6f85256575\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"0ce612f1bddccc28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"c5e81c9215d34e6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"11dc570806643a8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"cb6be5fefd1c2585\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"0fe2ea7173078e83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"478bb7458331c23b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5714f3140e52e7e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"cb36e3e1e3e3e651\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"098e8c506d9528a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"77d4612c3e44b597\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6d2aebc8e99f871c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"64d13a2c26bc876d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f51769a0631e87e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b0262116454cc554\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"290d66f0461148dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"60e1cc0707eeca98\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"783ed390c2baeaf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"96c7e2ebd545a196\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"146df7ba7a4f93c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"5e55c4d0258028fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"20f6432087461d2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"6ac8b1e8290152cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"52db2ed07f042d64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f3f41e1aea7b15c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"3790cd123cbfd427\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"f134bdefac69b9f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"638f6f246b950e14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"a94b15538728101d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"d5648ce0cfd5e502\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"0ec57ae71b57361c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"2d2cc85d49b8407b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"605c43f2bb062180\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"c912ba147c97afb6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"557f8f73e1ad8962\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"0587e81ce0abbdab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"35656b6009b541c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"52dfb99585f539aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"7edd076e15d8a930\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dayPropertyInputs.js\":\"752c3294909c045d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"d48e68c3e05b1063\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"2413e9e244f1e673\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"58371fca3e5ed39a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"2f88bcaab34dfad9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"152e109555cf8727\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"3092d9899dea0e26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9ab9a3743b7dc2ec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"24c98e93a2354518\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"d25866bcc85e0bab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"f2fda67474240cba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"98ecb4f62eab202d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"4e494d6bc93e60a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"e6e508d91fdc430d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"13d2abd18ba16b28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"63317e4449f7975e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"a579f790c8ddeedb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"8661e17bb4ab21a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"88cf3cd790cf3058\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"5091ca61ad7bf8fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"5217d0ad1cc1efd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"7205ee8b5e0c7fe1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"1bb0f5670af39e6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"b6454c0dbc7ec24d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"a0ba654c0e0f6a64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"814a056a66c8ebb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"7e293e4c6a519406\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"6e42ea4e8885d7fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"c9376f70b5f905eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"0f8a451e557c142c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"3cc572ec79b00b6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"357ba6b58afbd3db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"e27131e07359ea81\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"83a966ebe822a12d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"fae52216e7ebb283\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"d4541c8496f44f79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"02f976a8eb534865\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"715e92a88eacd542\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginAnchorLinks.js\":\"45eb55bbeeec98fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"fb22208311bb656c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"ccf3936039ad3b89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"3635a83a4beefa5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"8f300a9711f18d3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"22645bf694b7c463\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"b0cd042162d9c7ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"2f5dbd8daa0a2a49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"22ef8aa1640bafd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"5fd10844778b2487\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"2e58800db957030a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"526cf356b71a9a26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"6376417ba50ac426\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"c8aadeb577ac8610\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"021025d03016f781\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"a9198d4c9f058a03\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"cbf23ea2dedf3ee1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"281915fe4b0923a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"bc8f4a39d34bb1ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"684a6242b73f97d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"b58eec2618a86f1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"a8858ddad18fe910\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"528a7f862622dd41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"4b452d524679a285\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"b25b447432f8c3a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"aa81bf75d30bbd58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"3792d98acd7a6728\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"24c99f8c0c2c5153\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"b15bf8ec63350d89\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"acedeb2bd3ab8b8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"a76f3ecbb640f3c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a0f3ce79c1d46903\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"66f49f863447b8cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"13df9c374b00615e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"ef039d09f31b61db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"0a96c6e811ef845b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"b87b926a650ccfce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"cbd462a38d61e8db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"a979abd53f915bcf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"31c8726f4cdad1bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"fac434b96dbfa704\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"ce014840294a7f42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"e5b66df949f0a416\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"fda0b2b65d5b10b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"1deb1b3df3894ece\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"a07e4d1b06c282a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"fad3511da3c626db\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"204043ee8fd90067\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"751eb47f9fe99d68\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"852b87ad071779a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"cdab498cc3b0e322\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"5126c093bfe1caa6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"5ed940f43dd4f86e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"c16211172a29a529\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"5922f71e434e18e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"6ec4487f7cbe1348\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"43e58c6ea3bdea70\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"ce5f787bfb11e969\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"fdf22717c643aafa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"79b65a6cab24aef4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"754b5dede4fef66f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"871d53a35e0da8f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"6fdab94630b90c91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"177d86156809cfb6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"c8b1e75934f9f956\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"833f1008e31759c5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cc9a09324a376292\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bd68bccc4073d43c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"589d2a912d8cda7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"30afa095110d0ef9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"77211424f0453151\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"ff7252aef3da1fdc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"91e1cebc4e91beb8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"900a15552fe90ca3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"78fd45839e52cd82\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0fecd3b63b0b5f21\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"2de6abde635faa3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"24e94cda3abc89b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"435b0cf37d9ea154\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"628df07e4c9dbeb4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"7f5234143d1e0174\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e9e93de8a6858d2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"90ed6c4a2c160e61\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"6c65d8c1d6a97124\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f6f7ae8e940df50b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"2ad51c6ff6997fc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"909aa2d3556293b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"3a9d2606710a9ee7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"808934a6345b1e1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"4dc6b7ec806c9122\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"1672977f92b6322f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"aace69367330f8c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"e9a82a06a512ec87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"aa0ba879a9e7b990\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"d6f35f4349d02360\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5741dbeb3d41022d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"be71deb1c95b2221\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"7febbe19a69c27e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"f81abcfb6a8163c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"9987bcd1ad8aa302\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"a124227ccfdc20c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"2fbb8d5200b6282d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"917640bf134d523d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"ca630c7d84d0aebf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"3674011433158e11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"8f6aadad96182314\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"a3f4f90cc69ee2a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"07b52d89376aae3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"497770cd6a3ad7e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"10176b61d4269d8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"abf0b0c43cd9931e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"9a155dd0a4f49565\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"1de582afc0903b0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"3eafa26e36c54da8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"c395ac45760ca9d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"4e79478e2eab6dc1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"365259432d4c9a9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5a2bcccd33a101d5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"91c29f881af2164c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3894d932c325ae12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9af993fcba5b1c8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f6b673b34feebc4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"33ad4b07e8f8a09e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2e95691c24c61195\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"b49b4d989f86589f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cc61f1638ecc9587\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"5ce909e138c69a6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"3845c7d8e5279097\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"042f7d8d2e92ca5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"1ddd007e5c1610d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"345093e5162a1e33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"999491415f5bdc8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"07c0779591d5fc46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/subtree.js\":\"2c938d49d11ee2be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"02ab6dd699bb7bca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"bd25520df96e23e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"f2e269a647e4b461\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"294aa1d51e600475\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"56f412eba78d7642\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"87e7c457e9ff3a94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"3cc0db441c4cf8ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"2f16e7feee304c1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"e2062be0ea419cdb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"2cd84c198ded064d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ProfilePicture.js\":\"18ac027c3c4daf42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"a36c78a786abf00a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"dcead9adcccedbcf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"e2867caad71e2bf7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"57d6d477d8e961d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"f5267f8b8b19c644\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"e16db11ec1ff6b5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"89ccc1786e0b8611\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"4028ed38f420cf2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"f2b9f98de599d23b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/useCommentAuthor.js\":\"e4e96bf75ca78ac4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3531e2bf615e6337\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6ae168b22e08a40a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"2715a947de7d580f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3a798f3f87531645\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"85b6eddcc7fb0356\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"7ae9dec8125bbfcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"4c798b0dacae419b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7f5a4481a4a53716\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"4c13e5aa2c8404e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"ba3ef90d8af07fa7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayPropertyControl.js\":\"d2396d41f6600752\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayValueReferenceControl.js\":\"4a9c48baa772fabd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"0925f842d6e47b42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"386b7c3d9936156a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bbe904f9cf555c3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"dbbe61654931bcf2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"21ebfd2cd54a96be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"b58fbc146dde7f51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"20dc73d0a4a8c115\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"c904e8604fa1373c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"c32be959a1ea3a84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"ecac8bfe2ecb5c4c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a6dea456709ab4f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c6bda2a55801401f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayProperty.js\":\"f00c84b035000ac7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"7a3f4606bc70d660\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"5df8e20ee16a397e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"6babee210554b9f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"27a1823a9e9c35fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"74a710097d8a02a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"8b6f3fe6a6201401\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"b2de7238ccfac9ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"881bda4754674523\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"5ae7e24c60d7f701\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"f7283c7753a7e2a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"7fee672850db3dc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"0eb4f8e8259bd9b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7e1c28149ff7891d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"db72e867b84dd967\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"1e7e099531bc37eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"1ccd9b103bbf6738\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"1155c8f8ed3a0d9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"d10f261a5fdefef2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"f6cf2f42dcbecbfc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"66f0a3912f7f7bf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8209ac9fa67d9221\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"916d8f7bdf18aec5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"ff52af04a379fa52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"0a4348a756e779f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"ad87d8b6d107d952\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"4d43a579d2a33d7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"06a06218c90c19f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"94466ee6f09f4fb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5ca8f262c84ec723\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"3e8fcf91f37e323d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"8e8bcb21329f1bfd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"74148b63f6c4ad5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"ba15486208f7eff9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"72d06aad8a31b521\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"b81b8110781dcaa8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"4a80cc5649f419e0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"01966c34a05a5278\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"40098036372a0594\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"f0c5bfb2b8a8b115\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"117847d55e2bac6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"39e0f5fea8d0ad65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"7d063ea31ce018d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"0012d47a0c471da7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"279b9f9fbb7dcc46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"af28ed88e8516f67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"59d6099ad61213c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"dc880c17d506973c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"8412dbf8d4a9d484\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"58aace6d5bd92307\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bb6df2aa763fdc42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"b4257ee6dd80415e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"f861810a09c67aec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"247093a0ae4a9b2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"e6556ca9ff76d62d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"90d06460f5850af8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0119e4a075b994a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"e08a01a7b4d01c92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"8322b9275977115d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6b1ae4b2332413d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"d7b40661da2cbc22\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"74eec134fde7325c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"3528028300eb6145\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"dbf3e040319eaf60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"83edfae67fba2d30\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"095aa99854670d7b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"b0ca827f301c40b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"c70a5c84ca5cf5d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"1bc4a77599746c87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"1a1b97ae9cdb250f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"886913a9532adbf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"dcdb3b6efc9bb4d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"2d060cbe100aba45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"9a98cfdd8a086f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"a5112085f28b3a42\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"badc2b93d95eed51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"6cb0033e776c3ec6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"cfae009ef46a5c53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"568f0d6f158d3417\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"6fbbf96438cd96d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"10643f509bb56b9b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"a2dc173b1daa6f47\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"861ef13e581d7174\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"b360b2e207eb900d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"45b9a85dc59cad11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"1b40bcb7a83ac12f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"575d414f6ec3a346\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"d217b1a4b21571be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4cd3fa5cad7d4b2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"dcb3970fe73d57ff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b6f7545b714b0bea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"18ed44d46b0f7ed6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"98d42c490a258842\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"3c9d804d77093bf4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"5cdb71beda1548f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"5315bd5f2da11628\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4c643e264ce66e41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"cbcb9a6a886c4c03\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"fddd35b9a85dd174\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ae1a1a71e3a0bf79\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8a53e7c89498cf87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"f42d88f69d67ffeb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"f3b11bcb74224b20\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"3e30c872f112ce2e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"1607561fc6b5810d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"bb4f599f79933a6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"63c8d8774c55f60c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"7d8c06b15fcd8295\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"598bea07af57ffb2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"8a834ab907dbde45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"7712118c67eb35fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"cd3ea2f23796fd61\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"045c26264f9ae888\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"1e552e765c89483d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"b8bcc8bc1230fb65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"dc1a6c77c20ac1f0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"f14f0684344b2555\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"2c48f7c175553e46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"33fb9aa0b3b355bc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"2b8878d2b5d043ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e9781ff224750fd5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4a16a308dc02d9ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"92ee3588846cf469\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"36cb26c03585f483\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"78132c16e0252a1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"aa29e3465650a7f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"2eff75ae6ad641eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"bec85fc8f4ae7fe2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"a163472dad784f50\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c384f737abd72dbd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"c78e20539f9bd014\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"49f5e0ae15982158\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"8084c2f783e41fa5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"531706cf7163bc0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"9a2e8f08bc330b4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"e12a14dfb11739d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"d36565f03cb8819a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"3f635d09d4767699\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"d8ecf5e29f164d41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"eecc33fa815b7adf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"bbad868e11692a72\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"2ed546b64ee7f096\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3a353c9f569db520\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7205cfed729e4da1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"6086f1ab99d365fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"5e7828cbc43efb14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e7bc884bbe16b934\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f616146993845e8d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5d69e2f3c6bc71c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ec75461d3b9ff81d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"7507e986d44eee96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3f404ac144356746\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4274f38dd6d921fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"9756511ace097daa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"1abbda24b4a98eed\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"7767b75f56deb075\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"afdda5d831799c71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"bc30e8e93a968a15\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"d279047d2c46d50b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"3dfed0d0092dde91\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"fe62564a3b8eed4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"445122196f74d47b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"36dc19422a7ff744\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"4b1793e8f2e8df00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"6ac0ccde325d6377\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"0987f552b1654eaf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"683a818023695a10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"99f846d43b19e20b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"545e342d1b771577\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"5b50ee280d7ff950\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"06ac6497e38f7cbb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"bdaf9614e4d26706\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"ff5c8468f8e53ef9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"8a35de7934688b59\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"15f913d8e030ef0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"d8c58e262bda7dd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"cf5a39c4ff226000\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"4ad89d188ef021f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"eee9583c0c2f6c43\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"bec7b6dc803410f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"3ec60d9f197a2ebe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7fd1b54b01d488c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"a51033b107733f1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"f91ee05903822112\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"afc9c3f4fc70f111\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"5e7a97ee1ffd79d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"7886450cb80ff653\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"aa37afc4405e23c6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"68ff1dcb31fda144\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"8970d807109fbd97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"913c5d706f8d7f33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"bc7140d9b4c82b27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"c9669d88597bf1fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"29004f19b138e92e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"51238c1d84d9be6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"f798f446dd460166\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"12dd22c48f6a9ced\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"34dedaeff958960e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"23d7cf913d2d7ba6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"33d6f306e52430c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"27b8e99f0bee21b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"5e73fad699635dad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"128a32522fbae7a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"1118afb84e1659a1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"3f66dc5f4ab62253\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"48a3f468801c2552\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"017a56e421373b1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"755d8c24456ce4cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"8d3da90b3c4a9ec0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"03b2ace2f678ea5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"2058ae756c56b613\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"11ff82ad6f249a92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"43fbaaebabe60ba7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"2083acfc648ff284\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"3f5bfecf77010f36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a2be54755ca000e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"524485ca73e283dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"eb055e65b3c6e747\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"75e1da1ff0f1abd7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b14e2249c9c7ccca\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"5b52ff1344950744\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"b105d9578c0bee53\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"67526fd1cca675e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"86c7156e7867940e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"937680c2927a828a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bb9b3fa753845674\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"24ca7037645804e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"220bf39db9603364\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"14c8d686cec5d24c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"89388645bb1230c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"6502c31a4d07cf0c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"b8a9bbb15f159dad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"c33f0fb5f52d414f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"a7cd765d90a5a314\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"1672ec0bc3a06da2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"23d4ec927b46c7b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b8d01abb046af2aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"873ebc7038e89bcd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"0c78655fbd850942\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"f04954bbe0f27fc8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"cdc1b82be86eb4b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"89c8765f695bdaac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"142116efaad8e319\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"bd1e900a1d4b332a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"7f5b2e54ac9bfdd4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"f23303deaca5ec23\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"5b02e34b52486114\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"821f74ac4ae1ec8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"107ca79129276191\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"3da72753bbabed67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"ec3059f160f5bbf1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"b8566b17f8b1e5e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"4569d0c4b13faf3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"286000bb62fb3046\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"6f01a85555932c68\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"e7e17d3589b7ef7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"fec70b60cbd72357\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"02d9817f543ba258\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"175f5d23296c0155\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"7b5d5be7bbfb9004\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"45a052509c136878\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7b053862ba628905\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"a28430cb9a95bd13\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"dd890d6f67be19e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"7a7e18913096dbf0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"2b9cd2f672cd5663\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"89ee71eb9a356a6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"c84cb63b68105a9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"c060ba5d057ca1bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"10214dabce10ca5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"0aac4c2178f37b4b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"d02fd3ee09f42047\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"81bb40de093689af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"e043a58713c38037\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"80439e8b6a37eba6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"86d3cde67be599bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"95d82cc9d65121a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"889da46242593ed4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"8cf33cfc8c30fb73\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8f1413b257f426df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"19aa72fac983071a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"3be6f7d2ef1cd657\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9b6f5c414d38b79f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"5b724418c7565d2b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4f9a43d3dfcacba2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9fbedd4233d1e847\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"627af83b857344dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"29d95947f12b80f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"20357b3d4926f6d1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"136e2c2dd466389d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"3496b2c7db1f8c37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"7130703e5fd7c195\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"b198af7cfbb28c7d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"fde94d572ddbc107\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"2241fa567de516fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"71078d8d8f1a56d8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"a0c23c316b47f677\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"87012aa2156efcea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"92134fbe778707c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"c57f38087543361a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"8f6fee99ba4a0890\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"9c08a65c3b8acc9c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"8b945dfb22a94788\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"d8fe0c1898168324\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"2f4f690c16a62a19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"71f08bb7dc45a1af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"36808d34d1892bb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"24a8f47d45c6836a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"44dcd09a91d60aac\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"40777fbc49c4f860\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"2e93a8e58245b070\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"220858a3764027f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"027c2286204593d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"62548101b952aafc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"6cc6fa12c6e4cce3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"105862f7d34c98d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"d0f33674f06db88b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"47cb1ec467e8ed94\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"1f1a69021cad06ee\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"12a40dd920848843\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"5000cf089fc8049c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"f149696555dbd5f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c74628287fc42e33\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"49ae1f79c62b0a12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"d1729e85863ee6fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"0acbae3b0d73451b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"23370ce1f2b43574\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"263cbe77beae69dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"de1077e51ba6c0b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"0d78f68872bdbafd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"f34049e49dbb3aa7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"82ca0b52a08a8307\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"41e4a80c0e8044a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"f1baa533bb9f8dc0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"1b47b5bbb1123a9a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"3ecefce831857744\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"4068181c4ea8de8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"733da0ad23ec0ab2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"25a6c2362350866a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"2f06a14c2e2606aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"120cb4994fc6df96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"533ea607b1dd5a2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/QueryText.js\":\"5311e4a29826ffec\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"2d85ab5d337462fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"28adf8a384df7dfb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"9b9be4456553657d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"0f128f1e6668e6c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"4aa12b2b88c255e8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/registrations.js\":\"998f6fcc5c9198c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"b31b5a1987ccc635\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"a5db3b7fce665a74\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"e8db1e2dda5c3a49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"8e770a16174abeaa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"a0155f706ca4b20e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"32ef1210d8f266c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"b19e598ce03abbbf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"61726631fc11f18b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"b0eb3f383aa8a489\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"e2eefffb3db8005f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"e365ecbbbd1990e6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"c72b2c80effcc76e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"b0645e50ebed4895\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"67493330d48c1067\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"0a19a33d0b7133f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"2d032eb0e626eec5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"2e7c01d8db215796\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"7a3e08657f03e4dc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"dea319b3349192c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"81ce27941284d282\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"33b2a92d46ab9f35\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"a74202b62c661539\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"03d85d08ac209edc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"0c1f0324fc4e896f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"880b7d31d7c4bf7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"33dc5b5cbcdf4b48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"1a09263912283e8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"a9c7c6fad3ed8a4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"4fdcd81e2db107bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"b8d2b1edc9f48bb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"dc6db428edda883a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"dfc449029abf41a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"149c971702bda2eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"56152947f894a67d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"21aad51bd8ce817d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"90e783ddf9ae5447\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"3499bbbef75bf00c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"d5e3e59d7a341e67\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"7da6393ca1da24a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"fbf8e65dbc09ef75\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"b12dad8433583a6e\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"6f4064cc4652e5ca\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"29c84b4b324e6ce4\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"e23b4d802150e653\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"ae51f1f9cd1a162e\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"d3e2bfce3b42c69f\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"0de8e06666f8892a\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"7736ab02f5acfa1d\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"c99efe7e353ccf81\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"3907d44e5d0c52f9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"12979b6c243354b5\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"6cc5915827482b9c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"0eb14f8f02dd2d9c\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"1fc12e131d41e7fc\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"df131bd848738e4b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"e0d300f3a6271f04\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"5d409da1b86660e1\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"cd20c7edf7e91aa3\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"b60bbd88721b785e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"0c6a42c40de71d1b\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"9f698d56ac9b29e6\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"547c1362d1c89ba2\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"91263485d76fa315\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"acdcbe7ddcfe9db0\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"3ea58a5b6b54b631\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"379f48465d784470\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"6b0ce20eacb638f9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"d04b2a0086b7c15f\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"da223e4aa7085b09\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"ac0b759c82f98bfd\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"a0e6f0df0b1b1880\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"8eb929b16bbe0868\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"c15368f7651530ff\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"d2f8f140f3e8dc76\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"f55ca956911c5cf1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"f2307cad79427a20\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"91e33e9f31202ac9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"b4d52e14f611d404\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"c3b35d0c855cf50a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"ed749e5941618e2d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"70a08f33c9472852\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"1912c02ec238385d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"6363d133ff192504\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"ba9512de8f4edf2d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"436709380d22fd0b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"789973bb399f4a22\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"efe7aea4b59036a1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"7a083503b47dafc2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"fdd6abbe812a660f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"1a103fb3c1ff4666\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"9b7aa6f8fbf49e71\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"2e97f4c40f54fe88\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"f06bf4ca840e951a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"6283c6d18c147221\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"61ed2e0c0f502eec\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"01cad2d66adccda4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"231a77b3dc8b9715\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"0dd0693c02694413\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"637c1ca48a65f3de\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"0c9263855091af59\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"734a52c1aa3f9070\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"fc58ba8ee6b75674\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"a5a0bfd408f94ed2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"b6affe9955068cc9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"4d107a4b343f08fd\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"468b85bb539f45a1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"0aad3c6046cdedaa\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"f4ed8b1d2b3b6e14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"ce546eac4670db34\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"311d99f0453e461b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"73a800789f636f21\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"055f354ed0defe89\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"27b318f995fe3f8a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2d85f90e8cb1609e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"dfe652854d5295d4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"f70fbfe934796054\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"13e96d9ad19cfa5d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"8fbe5f1fbd0935b8\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"12d8fb317c485aff\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"f041f25eeec20dc0\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"d92991da95050bb7\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"1f326e3dfef90049\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"092c1be533e35337\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"9b5f767300e133a1\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"c48c6bfa4a47ffb1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"16ff48e07260ec2d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"2d52751d87a9f47d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"4f3d731ebe6fcede\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"6b18fa893fad5e56\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"a2d469bb17a871cf\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"01788e0040208cea\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"66a3b5108afd1196\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"0c0c6ca8642aea42\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"545a8126fdb119ee\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"df984851d657dae8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"a4bfc50d3cbfd202\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"201a2e87a0c4a17a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"2c66a541fffc4b9d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"8d60be3e6035e2fe\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"40bb8e2605d53626\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"174cdb7f4cbe97d5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"159dd46a38551929\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"54bc2bf210677820\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"e8775c75083f0324\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"1144af2240792976\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"0871eb3702f1548d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"a881fa1812c904da\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"41e4fe21d3b7f2a0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"5cb3492294d9cdb3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"d072b4f00243cd74\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"e6eeab441b280764\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"3c596c23b4b99db4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"f252d080d5889e33\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"857a0fb7c6bae9c0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"7ff152259d776fa2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"eae8d8c0526e9d3e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"c9adf7c3281dbc98\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"5d2941df17efbbec\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"dafe5aeb8beef600\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"8a4227a5d071918c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"3adc6cf3e9a4f22f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"2e870a72c8c45c48\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"2e9f9281fe150fe9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"d378cb039b3ee9dd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"f849f6d0bf7b8cc7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"e4214ae84e7a99b3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"4d0d68f61d3b843a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"e414f158babfeec3\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"6fd70c93fdfd356b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"fd582fa7233f4fe8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"2ccbd608da4de833\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"b71c85a4f6025502\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"5a19acd1423ea9c9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"d575f649e5ef9219\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"ec6085f4bce2e35a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"7df5029057c2fd71\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"f83a389907e6d4ae\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"d1fe29a7dd800d18\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"f2112d4d5a82d83c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"97e2525cc62704f6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"919a574684636962\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"6e27306ed3869063\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"e886ee811d7249b9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"5d2f0fa6d32cf9da\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"8d90ef0fedf214c7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"469e12469ef8236d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"cabf4169dd59e2a4\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"828e081c8ee656d7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"41d2725d5dff1ee9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"fbd71c2d5f335cf0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"5707952ccd9e1ecd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"2e092242779aa7fd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"0b717d6fc67ec2fa\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"8d7c31ee32964403\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"40fc26fcc156f0a1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"777b65ed1c2d7e81\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"a6148b6cd4ff198b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"0f302db6491507b9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"baf7e58503937779\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"623832f01a24f184\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"92c0b28f57f694be\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"4193d454fc12c589\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"940a8ff5180c6dd2\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"31aba88c8b97ce8d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"6e0cd4a32c0b9e2d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"54f5c9370633448a\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"9be66cb4a5583bca\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"6ad106f0e4676030\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"5d1274a4ab42977a\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"6f1941866e62598b\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"63eedffb99d5498c\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"c1b941ccc76b94fc\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"a50d3c70ff45f411\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"3f8c24b2965f3a31\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"a7cd0344173cd4a5\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"e5b9fca08976d573\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
