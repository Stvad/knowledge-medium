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
		buildId: "b362da59871c-55553127",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/\":\"e7797d3306969348\",\"/knowledge-medium/pr-preview/pr-1739/index.html\":\"e7797d3306969348\",\"/knowledge-medium/pr-preview/pr-1739/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1739/assets/FacadeVFS-m9IN1G2j.js\":\"f2afc31156368429\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSCoopSyncVFS-D4RorTcA.js\":\"f025eb67a227c0b8\",\"/knowledge-medium/pr-preview/pr-1739/assets/OPFSWriteAheadVFS-BhRn29AP.js\":\"c3f02d8a86905b62\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CTHOibKO.js\":\"2f0ba35e1fbfac08\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/assets/wa-sqlite-async-D_kVJ2vD.js\":\"2646101bc1109a04\",\"/knowledge-medium/pr-preview/pr-1739/assets/worker-DGu4wY41.js\":\"d899227adf6bd16e\",\"/knowledge-medium/pr-preview/pr-1739/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1739/chunks/app-Dra5rodG.js\":\"b631f74e9f8d8be4\",\"/knowledge-medium/pr-preview/pr-1739/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1739/index.js\":\"674cc5210044c446\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1739/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1739/assets/AccessHandlePoolVFS-DovfVnBg.js\":\"e043ef976694bc33\",\"/knowledge-medium/pr-preview/pr-1739/assets/IDBBatchAtomicVFS-BynK0YvZ.js\":\"282025cfc5207582\",\"/knowledge-medium/pr-preview/pr-1739/assets/MemoryVFS-CejO7-Xy.js\":\"a165d469a6c8c4a0\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-BKMwYLCt.js\":\"9efb589244fb1eee\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-DKQKm7F3.js\":\"74b3558fb84cbd89\",\"/knowledge-medium/pr-preview/pr-1739/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1739/chunks/AccessHandlePoolVFS-ZugWq1Uf.js\":\"30ff546aa6dc7cf2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/FacadeVFS-Bs3o4m4m.js\":\"96b319556c8b709f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/IDBBatchAtomicVFS-BLFRAY39.js\":\"de80f0770e3d015a\",\"/knowledge-medium/pr-preview/pr-1739/chunks/MemoryVFS-BK5aRurd.js\":\"65fdb03be902cd70\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSCoopSyncVFS-aiRUQQV3.js\":\"0cf9e2af02929246\",\"/knowledge-medium/pr-preview/pr-1739/chunks/OPFSWriteAheadVFS-7zJMv-UL.js\":\"17da679e87f856b1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/Preview-3E89Rv7x.js\":\"be2cae23fec004f6\",\"/knowledge-medium/pr-preview/pr-1739/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1739/chunks/card-BCPit9Km.js\":\"83065a2ab82bb948\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1739/chunks/dist-D1eBEQgY.js\":\"07b3d0b898da1750\",\"/knowledge-medium/pr-preview/pr-1739/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-ClRpfZQG.js\":\"5be62355c54832d2\",\"/knowledge-medium/pr-preview/pr-1739/chunks/mc-wa-sqlite-async-1-fsEdPf.js\":\"34e4b7f450bbec6e\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-4AO-tCE0.js\":\"13b52f3395ad7993\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-8KrDSmdu.js\":\"c28529a70f5f0284\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-BOs0oETi.js\":\"4412a4f33be88961\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Bnc8L1jO.js\":\"05bd751a1937a4e1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-Caj1xh2e.js\":\"84a56bb06b302ab1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-DAzeJxbL.js\":\"6a53a6f7894953a8\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server-legacy.browser.production-YyS5kSmY.js\":\"1e3d65937d67e7c1\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.browser.production-3xzCK_V1.js\":\"aaa1f08536abf70d\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-dom-server.edge.production-BodFQjPd.js\":\"ee9c061ed66dead6\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-kPleXLNB.js\":\"932a57671d889487\",\"/knowledge-medium/pr-preview/pr-1739/chunks/react-sorTN9-N.js\":\"6194ed6df3ebfbdb\",\"/knowledge-medium/pr-preview/pr-1739/chunks/server.browser-BW_eXMnH.js\":\"a3dc9368a80ad98f\",\"/knowledge-medium/pr-preview/pr-1739/chunks/textarea-D7a-ZPl2.js\":\"a5188ad82ffd5778\",\"/knowledge-medium/pr-preview/pr-1739/chunks/ui-BaSJCzJi.js\":\"418935781ce84371\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-CGhPqGA5.js\":\"719392a2f26f1207\",\"/knowledge-medium/pr-preview/pr-1739/chunks/wa-sqlite-async-DNhRooKg.js\":\"ae697708462eecee\",\"/knowledge-medium/pr-preview/pr-1739/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1739/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1739/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1739/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1739/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1739/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1739/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1739/src/App.js\":\"964b487058f0e9ac\",\"/knowledge-medium/pr-preview/pr-1739/src/appUpdate.js\":\"6a45cd4d4980be11\",\"/knowledge-medium/pr-preview/pr-1739/src/appVersion.js\":\"4c64a12e9ce82634\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/initialLayout.js\":\"80b451f7422ad261\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/openWorkspaceData.js\":\"0ab31f9c3e967212\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/resolveWorkspace.js\":\"72210ce367689774\",\"/knowledge-medium/pr-preview/pr-1739/src/bootstrap/workspaceBootstrap.js\":\"0cbf820491ab39bd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockComponent.js\":\"f96c81d591829ae9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockCrumbs.js\":\"cb9e790d823605d6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockEditor.js\":\"aa5db04893389553\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockLoadingPlaceholder.js\":\"87b56e5a6a60af90\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockProperties.js\":\"160fa1c4a299ae30\",\"/knowledge-medium/pr-preview/pr-1739/src/components/BlockSearchPicker.js\":\"4effe39e169ecd6d\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ConfirmBulkDeleteDialog.js\":\"658bc293f63719f6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DividerHandle.js\":\"956aa0ca88285b3b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/DraftEditor.js\":\"766c83b9aeda9076\",\"/knowledge-medium/pr-preview/pr-1739/src/components/GutterPill.js\":\"d5e1235bd865d5d5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Header.js\":\"fcb05579203dfe41\",\"/knowledge-medium/pr-preview/pr-1739/src/components/LazyBlockComponent.js\":\"f15361623ae4025c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/Login.js\":\"942db75ba3e33071\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ZoomableSurface.js\":\"51b04bd2df9398b6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/editModeKeepalive.js\":\"276d2fcab8e662c0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d89bbcfd3dfd7f7c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2d9832712d1a3a34\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefPropertyEditor.js\":\"ff920c86780fcc1b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/RefTargetTypePicker.js\":\"cc11c75a612a477c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/SelectPropertyEditor.js\":\"8a698a9a0be77e49\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/TypesPropertyEditor.js\":\"919063e1038d61e2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/defaults.js\":\"71750ccc9eab1357\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/kernelValuePresets.js\":\"6e94ecdc1a5b6916\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/selectablePresets.js\":\"3aa737348b28a780\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyEditors/typesPropertyUi.js\":\"c21429826a0e6c88\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/AddPropertyForm.js\":\"dad0ad1a09dd76f2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyPicker.js\":\"e1d6234d7d3e8db8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/PropertyRow.js\":\"c3a8d79a0959fc24\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/Rows.js\":\"0c31d1f20c685aa0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/actions.js\":\"afad3a8b1df513b6\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/declarationOnly.js\":\"96bdf64a23e3bd31\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/layout.js\":\"111e734f7887e71b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/model.js\":\"ced59c616bb8c523\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapeUi.js\":\"f799868cea5d62fd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/shapes.js\":\"efc525f79c2ebb55\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1c47354840fc9d62\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanel/visibility.js\":\"10935c979aefe5d2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/propertyPanelSections.js\":\"ff322699201196d2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockEmbed.js\":\"957e7536997ad00a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockLink.js\":\"5bbb52a232c683f3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/BlockRef.js\":\"e17cd315a8c53bf3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/CompactReferenceLink.js\":\"9fbd5d7919514465\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/ReferenceLink.js\":\"a541e716039e65ff\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuard.js\":\"66fb7260664bb4d8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/cycleGuardContext.js\":\"07939438bc4218b0\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/linkInteraction.js\":\"b011899a3c4a1e06\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/referenceLayout.js\":\"6d5254bd779b0981\",\"/knowledge-medium/pr-preview/pr-1739/src/components/references/useBlockRefAncestors.js\":\"791a71200fe2d2e2\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockGutter.js\":\"58ea48979adc4498\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockInfoDialog.js\":\"4efa58935fde81bb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockReadText.js\":\"bf044202905f1b48\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BlockTypeBlockRenderer.js\":\"b7ca2fe508a93b42\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/BulletHoverCard.js\":\"4be8f28b9d0a9ce5\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorContentRenderer.js\":\"8e4f814c4a3d695a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a8f0c25b2c9ebd3f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ColumnResizeHandles.js\":\"3c2fd0c2d800382e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5dd0c9e7664b2874\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/DefaultBlockRenderer.js\":\"0ddcf71d8348a9f4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/LayoutRenderer.js\":\"bfcecf2f0f2a3b4a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MarkdownContentRenderer.js\":\"20a7d33bee7ebdeb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/MissingDataRenderer.js\":\"dfacf49b5d7a9533\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PanelRenderer.js\":\"a7535b46bbc89048\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/PropertySchemaBlockRenderer.js\":\"75dfc5e66ab63404\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/TopLevelRenderer.js\":\"866e43f8a70f3205\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockGutterMode.js\":\"d55dfd5ca43bca15\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/blockTitleText.js\":\"8f6945b41efdb923\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/fieldCreationKeydown.js\":\"9baf9380ed921cb4\",\"/knowledge-medium/pr-preview/pr-1739/src/components/renderer/layoutRootContext.js\":\"5c785df5826619d8\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/TypeChip.js\":\"7a1b945294edf22e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/typeChip/chipStyle.js\":\"af9649bc2b223c17\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/anchored-floating.js\":\"735dbf321cb8035c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/button.js\":\"d556f07f250228c1\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/card.js\":\"8f78bd669d011074\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/checkbox.js\":\"847cf88f6b071328\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/collapsible.js\":\"3f3f17baf20add5b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/command.js\":\"b3374a521eba812b\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/context-menu.js\":\"2b17d4d7e1ba9675\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dialog.js\":\"eb720fcf8708f729\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/dropdown-menu.js\":\"c46d0f79fe49f700\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/floating-listbox.js\":\"9a1f052899d03106\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/index.js\":\"ce56905212dc1d26\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/input.js\":\"3cc3b8df6fce254a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/kbd.js\":\"1065bd371ce213ea\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/label.js\":\"4e265ca27e3ef2aa\",\"/knowledge-medium/pr-preview/pr-1739/src/components/ui/textarea.js\":\"63a20f2f23111a55\",\"/knowledge-medium/pr-preview/pr-1739/src/components/useEditModeYieldKeepalive.js\":\"245a127fa39e9015\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/BootFallback.js\":\"6205277f0452e1f7\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/FocusedRowLazyMount.js\":\"f1a4cb9e77825ddb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LazyViewportMount.js\":\"7711aed4011a982f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/LocalDbCorruptionFallback.js\":\"11e4cd4a2625f88e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/error.js\":\"b0ab53e1d165e53e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/lazyMountRegistry.js\":\"e4482e0b37b24eac\",\"/knowledge-medium/pr-preview/pr-1739/src/components/util/suspense.js\":\"be2e4684c1c282d9\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/CreateWorkspaceDialog.js\":\"edf2fd52fd5adc90\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/PendingInvitations.js\":\"559e0b4617546a9c\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/SyncProgress.js\":\"24ee86f7781ae1fd\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/UnlockProgress.js\":\"33baeaf4ba08ae1a\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceKeyGate.js\":\"ee6c3ecc0c57f781\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSettingsDialog.js\":\"c98980f9ed23c1ca\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSwitcher.js\":\"52941cd3d5d7f43e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/WorkspaceSyncGate.js\":\"e4d6588875bf7071\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlow.js\":\"72f96ad86c5f3cfc\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/ConversionFlowHost.js\":\"296200785eeefbcb\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/EncryptionSection.js\":\"c5f94df963694e44\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/attachmentPrompts.js\":\"6cfacb9e49abc11f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d3054893a1aae61e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowDeps.js\":\"a550158f04713d74\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/conversionFlowStore.js\":\"0db7342bbd82f359\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/flowUi.js\":\"8e20740a5b264a29\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/conversion/useConversionRun.js\":\"33137e65cc2b749e\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/keyUi.js\":\"c5b0225e14ef509f\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnKeyLoss.js\":\"12f197257dd2dba3\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/useCloseOnServerE2ee.js\":\"7acaf3e1b9452237\",\"/knowledge-medium/pr-preview/pr-1739/src/components/workspace/workspaceUnlocked.js\":\"4dd7c8161f0bb964\",\"/knowledge-medium/pr-preview/pr-1739/src/context/backgroundSubtree.js\":\"c4cc1e237524ff34\",\"/knowledge-medium/pr-preview/pr-1739/src/context/block.js\":\"582ceb6394991477\",\"/knowledge-medium/pr-preview/pr-1739/src/context/layoutWsContext.js\":\"506e269d113c9c54\",\"/knowledge-medium/pr-preview/pr-1739/src/context/propertyDisplay.js\":\"6fe9dfeea922d7c7\",\"/knowledge-medium/pr-preview/pr-1739/src/context/repo.js\":\"3a6885554eb290c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasClaim.js\":\"869eda8774eacfe8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/aliasSeatNamespace.js\":\"42c0438af156fffa\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockData.js\":\"27735f993b9bc435\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/blockType.js\":\"a59e10fa465df45a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/changeScope.js\":\"45a8fdef10e75889\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/codecs.js\":\"a0297ce6b39add71\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/derivedData.js\":\"05af82c48f45be1a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/errors.js\":\"467215a430fcf18d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/events.js\":\"64a2b6eb97ac6d8c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/handle.js\":\"358f2a15095572ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/index.js\":\"b9f06e36d9f4ae29\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/mutator.js\":\"d1b0caf633cfc8b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/processor.js\":\"5ad719e168236a81\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/propertySchema.js\":\"a228efbae0ba5298\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/query.js\":\"ac86be83a1becef2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/sameTxProcessor.js\":\"840bac9fb409aa04\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/schema.js\":\"358f2a15095572ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/tx.js\":\"358f2a15095572ef\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/typedBlockQuery.js\":\"73f333a3610a209f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/user.js\":\"4b1dc94bd4ce002f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresetCore.js\":\"ca4a4bd80a3f8519\",\"/knowledge-medium/pr-preview/pr-1739/src/data/api/valuePresets.js\":\"11ff46a3815be818\",\"/knowledge-medium/pr-preview/pr-1739/src/data/attachmentCleanerIOVerb.js\":\"55488ba3c8d4f0d3\",\"/knowledge-medium/pr-preview/pr-1739/src/data/block.js\":\"c6e91d4b050a5a12\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockCache.js\":\"415f076405da6f27\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockId.js\":\"869917aae41a2059\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockLiveness.js\":\"664d6234a2d669a2\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockMerge.js\":\"ea93e35c21d86200\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockSchema.js\":\"191448c61c358903\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypeLookup.js\":\"2e78640ecfbe4af1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/blockTypes.js\":\"c07fef2c5f4e67b9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/childrenView.js\":\"ad3b522c658ed46b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/clientContext.js\":\"2fdfd6dfc92d074f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/dbFileSiblings.js\":\"2266f2c0fd8ca426\",\"/knowledge-medium/pr-preview/pr-1739/src/data/definitionSeeds.js\":\"aab94bb600dbd8b6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/derivedIds.js\":\"1cbbdaaac44f5c62\",\"/knowledge-medium/pr-preview/pr-1739/src/data/drawnSubtree.js\":\"2ebfbc4e945eef1d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facetBridge.js\":\"0239d85b33adee1c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/facets.js\":\"27b54ba9db9c8fe8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/globalState.js\":\"f26355219e427874\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/aliasClaimRederiveProcessor.js\":\"e2217a4e8887fa73\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/ancestorBatch.js\":\"623f813ea733dd99\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/blockTypeTypeifyProcessor.js\":\"0e3a0dd0a613ac47\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/clientSchema.js\":\"6105d597d5197492\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/commitPipeline.js\":\"f033826f57abf953\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/devAssertions.js\":\"4f97ebee9cc04634\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/firstSync.js\":\"3667208a35b4e690\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/freshInitialLoad.js\":\"608320677f8df847\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/graphBackfillClaim.js\":\"0ef00394546cd542\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/handleStore.js\":\"75dd4f9c0da51fb6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/idleMarkerJobs.js\":\"cb8379b9743cbfba\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initialDownload.js\":\"fc510969f1692031\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/initializeClientDatabase.js\":\"520d416de44fba7f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/jsonCanonical.js\":\"6501d9d7d66a1db7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelInvalidation.js\":\"880aada45654c45f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelProcessors.js\":\"9d0c5d005f3660ae\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/kernelQueries.js\":\"e7fc4028cb8147da\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/mergeTypeMembershipProcessor.js\":\"10e3c8d89c84efb7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/normalizeReferencesProcessor.js\":\"ed094446860ad248\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/poolInstrumentation.js\":\"1b10a1a1f70d2b0a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/processorRunner.js\":\"1792c212d45f1bbf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyCellBackfill.js\":\"a921246ea0659a17\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildMint.js\":\"5f53a58e1450998f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyChildrenProcessor.js\":\"7f71507bf7809a37\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1803b68c5231d326\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyDefinitionSynthesis.js\":\"cc00750586e4123a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyKeyScan.js\":\"defa75687e86ea60\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertySchemaResolution.js\":\"fadc3744af0f2f08\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/propertyValueEdits.js\":\"9b10643f15b8d61d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/raiseProtocol.js\":\"8a18ea8ffcaf7e38\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/readBatch.js\":\"61d208f9c641346b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/refProjection.js\":\"17af2c926ff89e02\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetLookups.js\":\"51e7eb69ea8e114f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/referenceTargetProcessor.js\":\"3f3b448d60496a2d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/replayMerge.js\":\"8168d6036cf64ece\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/sqlBinds.js\":\"7fafbe082e3f5557\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"400ddc3c0ef3e2ce\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/arrivalProcessors.js\":\"230356a8e5af4db9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/invalidate.js\":\"6a9c9a9c9ddc8130\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/materialize.js\":\"ae7831df54bda40b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/observer.js\":\"652c7be6b9893945\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/syncObserver/reconcile.js\":\"41ee89bbc5be9d66\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/timingMetrics.js\":\"b191794d539a4bd5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/treeQueries.js\":\"b1d14092bed3fa2d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txEngine.js\":\"251cbf65541334af\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/txSnapshots.js\":\"c321eeb60377603a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/typedBlockQuery.js\":\"59189c4986c19fb9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/internals/undoManager.js\":\"9fbc56bc4402a0cd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/invalidation.js\":\"ef57c1835855a14e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelDataExtension.js\":\"199266e2654b4c97\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelPage.js\":\"3f97ee5b2c90b263\",\"/knowledge-medium/pr-preview/pr-1739/src/data/kernelValuePresetCores.js\":\"5d387594f3815ab5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbCorruptionSignal.js\":\"e3421cd9b23b7c43\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbStorage.js\":\"de58848f224b0095\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localDbVfs.js\":\"f1724583516cf437\",\"/knowledge-medium/pr-preview/pr-1739/src/data/localSchema.js\":\"a5736db263a72efd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/maintenance.js\":\"27b615b17d125480\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mergeProperties.js\":\"4f9720d8eac90954\",\"/knowledge-medium/pr-preview/pr-1739/src/data/metricsConsoleHook.js\":\"0fd2a6eb97db50b7\",\"/knowledge-medium/pr-preview/pr-1739/src/data/migrationsPage.js\":\"994fefdb3323ddc4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/mutators.js\":\"02dc8393c315a902\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKey.js\":\"1e254ac368a97b78\",\"/knowledge-medium/pr-preview/pr-1739/src/data/orderKeyPlacement.js\":\"3bd12561b85a8e65\",\"/knowledge-medium/pr-preview/pr-1739/src/data/outlineSurface.js\":\"0ab19b7e22b65441\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingEditorContent.js\":\"2ef8bef7cbeb47b1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pendingUploadsSql.js\":\"3273ff88597bf464\",\"/knowledge-medium/pr-preview/pr-1739/src/data/pluginStateExtensions.js\":\"0ab4c26ab72239af\",\"/knowledge-medium/pr-preview/pr-1739/src/data/powerSyncLogger.js\":\"ad1f29d4946908b6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/projectorRuntime.js\":\"986aed0e56b78cd4\",\"/knowledge-medium/pr-preview/pr-1739/src/data/properties.js\":\"ef3e502fb08ddd9e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertiesPage.js\":\"6f6ee0ef90d8796c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyChildren.js\":\"e6845e6f9ae36f3c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionFanout.js\":\"640bf56e79123c80\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionMetadata.js\":\"c0fe56d8ef48a15f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDefinitionRegistry.js\":\"590bfae9242075fb\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyDisplayMode.js\":\"8f89cec56a075204\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertyRowCreation.js\":\"73844b0007221f22\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySchemaCreation.js\":\"f41134a5b85fe74c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/propertySeeds.js\":\"f2b77fdf71661bdd\",\"/knowledge-medium/pr-preview/pr-1739/src/data/recentsPage.js\":\"f39d9c0d9c33f501\",\"/knowledge-medium/pr-preview/pr-1739/src/data/refTargetComparableProperty.js\":\"1b1c4c1097369481\",\"/knowledge-medium/pr-preview/pr-1739/src/data/referenceBlock.js\":\"af507c3d7c8c7326\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rejectedUploads.js\":\"b054f7464e5f8eb6\",\"/knowledge-medium/pr-preview/pr-1739/src/data/releasePowerSyncConnection.js\":\"f3608147c7ed0fdf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repo.js\":\"cf03ac056663d954\",\"/knowledge-medium/pr-preview/pr-1739/src/data/repoProvider.js\":\"08b27dd3689c9399\",\"/knowledge-medium/pr-preview/pr-1739/src/data/rowProperty.js\":\"49fe4988f13d31f8\",\"/knowledge-medium/pr-preview/pr-1739/src/data/searchFilter.js\":\"762756014fb90a1a\",\"/knowledge-medium/pr-preview/pr-1739/src/data/seedIdentityLedger.js\":\"ada1a4a94487c7ac\",\"/knowledge-medium/pr-preview/pr-1739/src/data/stateBlocks.js\":\"55b536151eff5f40\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralEditPolicy.js\":\"490ef528c275a024\",\"/knowledge-medium/pr-preview/pr-1739/src/data/structuralInsert.js\":\"1134b1bb2a16760f\",\"/knowledge-medium/pr-preview/pr-1739/src/data/subtreeDelete.js\":\"b36d569f70629e64\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncStreamLock.js\":\"4809703542a90ae5\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableSqlRecognizer.js\":\"58cfe78a3d2bb6d1\",\"/knowledge-medium/pr-preview/pr-1739/src/data/syncedTableWriteGuard.js\":\"45ee3b8c1c41ab66\",\"/knowledge-medium/pr-preview/pr-1739/src/data/targets.js\":\"2cdd9b3dc3efecff\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeColors.js\":\"f128c658be607647\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionMetadata.js\":\"be0212d7a7bdae84\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeDefinitionRegistry.js\":\"98dbe6a0c38b3d3d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeExtraction.js\":\"b5537b74d4762579\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeInitialValues.js\":\"a72a32be0d056501\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typePropertyGroups.js\":\"840b5b95ecbbca28\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeSeeds.js\":\"13a857b0fac70c2e\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typeTagger.js\":\"02918d82f6a7522d\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typedRecords.js\":\"58ca32eb4c8e34bf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/typesPage.js\":\"1e09f0fa948a7d82\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userPrefs.js\":\"f0ad0c7a905bd2d9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userSchemasService.js\":\"332be3599ff002dc\",\"/knowledge-medium/pr-preview/pr-1739/src/data/userTypesService.js\":\"8f103467e3e7200b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/valuePresetRegistry.js\":\"0a43d4b4f957ebdf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/visibleChildren.js\":\"0256e96d5ef914c9\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceConversion.js\":\"81f8c64551d9fa39\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceFirstSync.js\":\"27a2843e0ef4db56\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceIdNamespace.js\":\"f950a7b013cc8f97\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaceSchema.js\":\"ac4d493272dd6bcf\",\"/knowledge-medium/pr-preview/pr-1739/src/data/workspaces.js\":\"6f1fd160c13a3f4c\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadLog.js\":\"2af5f06a1b98350b\",\"/knowledge-medium/pr-preview/pr-1739/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/BlockPasteShellDecorator.js\":\"a49922f330e5e1c4\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/atTrigger.js\":\"4d5707fcadadbe09\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/autocomplete.js\":\"1b3ec8316f032ad1\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/codeMirrorExtensions.js\":\"4676864716aa5909\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/contentFlush.js\":\"858486ad6e6b8442\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/defaultInteractions.js\":\"46d135b003f86e43\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/editSettleSignal.js\":\"b6d762a6275cb3c0\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/insertImage.js\":\"e91a16b2d9816788\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceCompletionRange.js\":\"5fd22f6d38fda4a5\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/referenceTargetTypes.js\":\"44347d1fcfd68288\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/syntaxContext.js\":\"f7fd3cde9366c282\",\"/knowledge-medium/pr-preview/pr-1739/src/editor/triggerMatch.js\":\"4e26c91e9b676187\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/AppRuntimeProvider.js\":\"029e20ffe2129f44\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/BlockFocusShellDecorator.js\":\"831acbe727abb43d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/ExtensionRenderBoundary.js\":\"4bba89c98bea4a15\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/PanelContentRecovery.js\":\"3eead9fc71ad9aba\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/apiCatalog.js\":\"b217f2a56f932933\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/approveExtensionHere.js\":\"3b737b46107eea2d\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/armedCutAppMount.js\":\"680c21d02347d29f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/batchableKeyedStore.js\":\"492360577da2e2f0\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockInteraction.js\":\"1708f1b455efc22b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/blockSelectionAction.js\":\"a82a81a8c096f82f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compileExtensionModule.js\":\"3742930edca32436\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/compiledModuleCache.js\":\"94d22e77dd4896d7\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/continuousGestures.js\":\"0c50af5d9fb38c06\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/core.js\":\"5a83287d25da9497\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/defaultRenderers.js\":\"6aefd1fce49b1280\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/definitionFanoutAppMount.js\":\"213f8a643468602b\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dialogAppMount.js\":\"b60e67a1c55db6d4\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensionSeeds.js\":\"67a8c8e2663527c3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/dynamicExtensions.js\":\"cd8c7553bdb24b6c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/exampleExtensions.js\":\"6a0e311f8dc1264f\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionApprovalStatus.js\":\"cd343abd8752ec9c\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrorToast.js\":\"bcb18245644447a0\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLoadErrors.js\":\"3856a12676ca4ccd\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionLookup.js\":\"9f9ec36e992218e1\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionToggles.js\":\"0fb5f03daea34b93\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/extensionUtilitiesCss.js\":\"2348e69d632b0062\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/kernelPageDeletionGuard.js\":\"4dfa280c27b44f74\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/liveRuntime.js\":\"e821994e7c1abe2e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/openExtensionsSettings.js\":\"b56c6cc65a82079e\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/overridesCache.js\":\"66f64bd1badf4842\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/pluginIds.js\":\"6462a30fe5a3b828\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/processorRejectionToast.js\":\"e350978eedb83b68\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeActions.js\":\"7660aa5bebf12b25\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/runtimeContext.js\":\"6e1148bbe66d5b8a\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticAppExtensions.js\":\"56aed1b00b9efb02\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/staticDataExtensions.js\":\"e859e5b8ed2afca3\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/toastAppMount.js\":\"1e97c50958068381\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useOverrides.js\":\"52d3b049750a7cb1\",\"/knowledge-medium/pr-preview/pr-1739/src/extensions/useShortcutSurfaceActivations.js\":\"61e12fd5afd210e1\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/discoverToggleTree.js\":\"4ee0134df98a4f3c\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/facet.js\":\"8f071f462f84d48d\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/resolveAppRuntime.js\":\"372aa01ce6dce2da\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/runtimeEvents.js\":\"bff4460b6fa08922\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/togglable.js\":\"29acfea9650f90a8\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/variantFacet.js\":\"b0c936f269f62dbc\",\"/knowledge-medium/pr-preview/pr-1739/src/facets/verbFacet.js\":\"da0a1f55f7900a3f\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/block.js\":\"b24140a398903af5\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/focusedChild.js\":\"12738f50c00ed47f\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/propertySchemas.js\":\"7ad91df3b061f67a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/typeRegistry.js\":\"6cc571783efc383a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAncestorCrumbs.js\":\"f1a09dc2a37c3c61\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useAutocompleteListbox.js\":\"3a351244e2f1af71\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedSearch.js\":\"a3cbf4dc1b4d0b04\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useDebouncedValue.js\":\"d165ea20a4028a9c\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useFacetValue.js\":\"ce0e98cd8b6ad407\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsFocalRender.js\":\"8aa901c728f5a941\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useIsReadOnly.js\":\"58eb260fb5d77772\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMaterializeBacklog.js\":\"8141c32156e239dd\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useMinuteClock.js\":\"d583330c43c61cd4\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePanelLayoutProjection.js\":\"988cc56d9ecb1bf1\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/usePendingInvitations.js\":\"7d4ea6fbdaba3006\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRendererRegistry.js\":\"3d7e33fd4028da4a\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useRetainedFieldRows.js\":\"07dc10857ec7c9a7\",\"/knowledge-medium/pr-preview/pr-1739/src/hooks/useWorkspaces.js\":\"17084e32696e2216\",\"/knowledge-medium/pr-preview/pr-1739/src/lib/utils.js\":\"533179d7dd956486\",\"/knowledge-medium/pr-preview/pr-1739/src/main.js\":\"c935e365ad7427bc\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/MarkdownImage.js\":\"d2b8012472914604\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/blockSeparators.js\":\"0cf1897677ee7804\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/context.js\":\"10467d0c5320d2e7\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/defaultMarkdownExtension.js\":\"a3f33e20e8538967\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/extensions.js\":\"a132290843191739\",\"/knowledge-medium/pr-preview/pr-1739/src/markdown/renderMarkdownHtml.js\":\"2a18e6ee3e703b1e\",\"/knowledge-medium/pr-preview/pr-1739/src/minimal-editor.js\":\"25e47fd910492b0f\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/armedCut.js\":\"3b60cd884f4dbf62\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/captureMediaVerb.js\":\"4bc02c1672515064\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/clipboard.js\":\"bde1e82c0abfa661\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/decision.js\":\"f87360ff73dc0655\",\"/knowledge-medium/pr-preview/pr-1739/src/paste/operations.js\":\"9c0edc3d3d487f92\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/AccountHeaderItem.js\":\"89e13555920e8628\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/account-header/index.js\":\"3c7c2b944a66000f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5dacebc4587e2a16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askAgent.js\":\"75d86252448f4293\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/askedStore.js\":\"01991c8364a58c1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"93b5c4e0e441d09b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/chipState.js\":\"fc198d8858ea3842\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6e91e7d9788eb291\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/index.js\":\"7f6279cf92294624\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"53ab686f462ecadb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-dispatch-companion/schema.js\":\"714bcd77c0ffef26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c100c34d6e14485b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a9a44bba84014649\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/addMedia.js\":\"034960031cbda005\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5d75a3ac477df60d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/block.js\":\"18fe0fb9c34f291c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/context.js\":\"0be75defb4f6b20e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/displayIds.js\":\"63437b34f03675a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/index.js\":\"5caddaeffe088793\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/outline.js\":\"b923049a8f1fb0c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/properties.js\":\"f33c694942a6b89d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/refs.js\":\"127045a76a0712fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6ee319ffd1a51d3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/search.js\":\"beb2d2109ea4ccbe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/shared.js\":\"e872f7e859af0f3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"83babcce92ec5b59\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentViews/text.js\":\"1a8ad6bcfee91cbf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/agentWrites.js\":\"15dbff9fdeb848ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/authoringCatalog.js\":\"9fadab084b18585e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/blockRefTargets.js\":\"b043b4a4766c2eba\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridge.js\":\"92b0b83b53c313da\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/bridgeLoop.js\":\"ed8b638a551a2f4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/changeHistory.js\":\"f023f3ad199b06f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commands.js\":\"d4eec5a13810992b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/commentsCommands.js\":\"67089af42c2f9185\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataExtension.js\":\"1a874bd0b2d1edd8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dataModelGuide.js\":\"dc344fd43a501316\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/dayPropertyInputs.js\":\"6cbfe22f5cd9606b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/describeRuntime.js\":\"f0e0a3a948a4d574\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/extensionLint.js\":\"5edcd021b8abe6c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/grainAudit.js\":\"53395bd7d37a6c31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/healthCommand.js\":\"042e93ce5872916d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/index.js\":\"6d6543d265ae7027\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/presetIdentity.js\":\"8cb1ec4db2f2a75d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"81d75f4a24535f12\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/readMedia.js\":\"7123a33d34793dda\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/schema.js\":\"dbe0df457b45d5b6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/serialization.js\":\"fda85c9842a2d6c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/targets.js\":\"a4e908852ace7063\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/tokens.js\":\"19d07ae9127de012\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/watchEvents.js\":\"3f37edf52485d242\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/workspaceGuard.js\":\"b57b0a7a06a5a3a6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/agent-runtime/writeCommands.js\":\"cd8185e3135aac6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/AliasCollisionToast.js\":\"945ac771ab8d372f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/DuplicateNameBanner.js\":\"c0912ac374398117\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/collisionMerge.js\":\"e51719cd0fdd5cf1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/dataExtension.js\":\"61cdc918afb07b86\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/index.js\":\"998108fb5bd87da9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/mergeCollisionAction.js\":\"424074770eb95711\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/pageStyling.js\":\"3640842ecd8b21ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/rejectionToast.js\":\"ab3f0af779f31c49\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/alias/syncProcessor.js\":\"390e58419b53b2f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/actions.js\":\"eb9e3082afee218f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/addComment.js\":\"fab1e533361cbf87\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchor.js\":\"635b2022f5a5a254\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/anchorState.js\":\"89272aaa6530980e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/commentLinks.js\":\"d9447192f1fdaf4c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/confirmThreadDeletion.js\":\"2b6e1d64213ecb77\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/container.js\":\"cd8da1e38a5c2809\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/dataExtension.js\":\"a3366f6996383a10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/deleteComment.js\":\"2882038ec3799ef9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/highlights.js\":\"b50c08fd05fbeff5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/index.js\":\"ef922c5348b9955f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/linkedCommentsPill.js\":\"cf71055d6cc89229\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/margin.js\":\"eb1de0edb40a69a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginAnchorLinks.js\":\"94a31f65690da4d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/marginSchema.js\":\"59ea97f4f16428f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/newComment.js\":\"dd3fa6d44ee76deb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ownThreadPicker.js\":\"f52de378e82cda2c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/placement.js\":\"e368354cefe34254\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/queries.js\":\"8f64cf9d6c5fca45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotePosition.js\":\"c94ceb2f2cfcf2cf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedIn.js\":\"92cac8b8a8eee2d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/quotedRange.js\":\"87184fdd57ae8cab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/rangeRefs.js\":\"cd6346efa10632b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readHighlights.js\":\"849fb8e1bfd0928a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelection.js\":\"b087d117be06960c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/readSelectionUi.js\":\"6dfba88623dcc3a4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/reanchor.js\":\"467e5402c9b64347\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/schema.js\":\"063f06ffae63dc2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scope.js\":\"ffe38e101fda5c61\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/scopeThreads.js\":\"27a50817604667d3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/splitRetarget.js\":\"72e363abe2d19796\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestionCard.js\":\"b0d0f67720f3f745\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/suggestions.js\":\"62b5088fb6836230\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaries.js\":\"8288b1855a3bcd93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/summaryBatch.js\":\"f3e8a9538bb6930f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/surface.js\":\"a08a709a4bcbc109\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threadNavigation.js\":\"242ba7ac46b04d31\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/threads.js\":\"1eb57057d9befd69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/ui.js\":\"db40272b0ac49e30\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/annotations/uiStore.js\":\"035ed4838474c4dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/appIntents.js\":\"3fbd4820a642c9a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-intents/index.js\":\"4d95ee0302b47b8b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/index.js\":\"707564adaa9134f6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/app-update-prompt/status.js\":\"8a0f43a12ff2fa97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"984157232c046b3d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaBlockRenderer.js\":\"ac732924a67210ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1f0f456941421411\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/MediaUploadReconciler.js\":\"f35a47422385d70b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetDownLane.js\":\"87ef6e6987301f2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetResolver.js\":\"5eda26f4c0c15a6e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/assetUpload.js\":\"432e71d31d375808\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/attachmentCleanerIO.js\":\"95573557efcffa34\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/supabaseAuditIO.js\":\"297f8d030a3ef9f9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/blobStore.js\":\"f8d0148bc49e2a5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/browserMedia.js\":\"0d78c21d9d4e2fb4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/byteStore.js\":\"1ce291a1e48856c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanerIO.js\":\"ac4e7c3ac3e8eda3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/cleanupAttachments.js\":\"39d9d9e758b66d04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/dataExtension.js\":\"745d90690fbb31c8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/downLane.js\":\"622dbb07a3c8df0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/index.js\":\"c4c49ff711dd27df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/insertImageContribution.js\":\"238d5d94b4c5eab0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneArming.js\":\"bf15525d9528ced0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/laneLock.js\":\"ce90a7e68cda0437\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaBlock.js\":\"3f070edafa3997e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaCapture.js\":\"901e3f9b5154c752\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaLanes.js\":\"02e12e63f28f0657\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewers.js\":\"579989ae24ab5758\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/mediaViewersFacet.js\":\"da4ca0f95203cce4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/pasteCapture.js\":\"eb1ade72e9bd3433\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/resolver.js\":\"0b01d5af3e4e4307\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/retryUploadsAction.js\":\"dc5bd3a2ba24cd93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/storagePaths.js\":\"8fdf032deef38178\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadDrain.js\":\"d5432f985dc4cc6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadLaneStatus.js\":\"e487adc751d9a09b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadReconcile.js\":\"24c2a4e94782e639\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadRecovery.js\":\"7b7f8f8868145450\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/uploadStore.js\":\"461acca1688bc881\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/attachments/useAssetObjectUrl.js\":\"29f2a3d2a3123c5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"edb9bfeadd883638\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f699698d804317a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/facet.js\":\"9c3960ddafe82499\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/index.js\":\"45ed09ddda680abf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks-view/prop.js\":\"249baeb383d00205\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinkFilters.js\":\"1a2da62e13a86e7a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"08519be359c5109d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/BlockEntry.js\":\"919befc8e8ffe279\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/LinkedReferences.js\":\"f8d853c7a856231d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"00d65eece3af1b8e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dailyNoteDefaults.js\":\"5eb76e848959c0de\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/dataExtension.js\":\"6e4d92315b0e66d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/edgeExclusions.js\":\"50be377a8ba4d2b9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/filterProperty.js\":\"983513c6e500ea16\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/index.js\":\"b452816b79999380\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d24dba07498a5443\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/applies.js\":\"671810b0d6a6ddb6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/countQuery.js\":\"ae9745b4a5cf2fde\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/expansionStore.js\":\"614b7dcc0990c5df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/index.js\":\"331b33353bc4fe2f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0f02d6238a72b762\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/presentationInvalidation.js\":\"f1de89532ef38625\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyEditorOverride.js\":\"92762a3c8c72d16d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/propertyFilter.js\":\"dd706f1e3d6ca57e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/query.js\":\"945af176339e2429\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/resolveFilter.js\":\"214f0430ff419922\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sourceBatch.js\":\"0d150119fb0cde26\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/sources.js\":\"f41561d220c88683\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useBacklinks.js\":\"3fbd797104d18ae8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b53cd0d89603187c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayCelebration.js\":\"a51a6b55cd4b63d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/BirthdayOverlay.js\":\"676702ea6c9035c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/gate.js\":\"28717034e774449d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/index.js\":\"5d69b602fc75e37a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/birthday/wolfTheme.js\":\"c86f22b965090307\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/BlockDragLayer.js\":\"10984b8b9d29c5df\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dragController.js\":\"cd5217d876d76c6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/dropTarget.js\":\"695fc5b011278565\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/index.js\":\"571105f01703b85c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-drag/projection.js\":\"c7d81500879d1281\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/BlockMetaCard.js\":\"354b4ef13baa635e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-info/index.js\":\"c6a8ba5d674e506f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/AddTagDialog.js\":\"8ae4b04c0e55559d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"07438da7351983fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/TagNameIssueHint.js\":\"c792aa88233f15b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/addTagAction.js\":\"5b0ca492b34a54d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/appendTag.js\":\"694f4935672d78ce\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/config.js\":\"a98e6494028f88b1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/dataExtension.js\":\"90baf06eef1aaa6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/index.js\":\"e52c71437e8d0414\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/block-tagging/propertyEditorOverride.js\":\"a1ed18e9ebfed134\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbList.js\":\"dd0e7666184c5c8d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"efdad15633f4b34e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/Breadcrumbs.js\":\"320694933717ac90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a5099067a9ea6cfb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a58631db0b3c4617\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/index.js\":\"96080226a540b19d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3107177562d35e05\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/CharacterCountItem.js\":\"244997c26cc1db6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d2a266100b761b62\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/actions.js\":\"d6d4883fe0f3c9b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/blockType.js\":\"fc856478a0543379\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/charCount.js\":\"13d8600d5dd8695b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/dataExtension.js\":\"a0c9236a38f16eb4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/index.js\":\"8bd0b87fb654e564\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/profiles.js\":\"2ad8f97805a1886c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/properties.js\":\"26abf3e60de3b2eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/subtree.js\":\"da26f777f095f025\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/character-counter/textCounts.js\":\"8f4e5b4e4d126b84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/colemak-keybindings/index.js\":\"6234b94e9f18a8b3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/CommandPalette.js\":\"ab74722a9bf48106\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/HeaderItem.js\":\"49eb8e79e9028b14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/context.js\":\"910d4cd95fba89d4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/index.js\":\"a8f67894128f5235\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/selection.js\":\"61a8c5d425bc0b04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/toggleStore.js\":\"bd4afc16df2919f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/command-palette/useCommandPaletteActions.js\":\"e4313fd9e917d102\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/ContributorBadges.js\":\"3ac8b82d8eec2e38\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/author.js\":\"fe6be28d481d9c6a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/codeMirrorExtensions.js\":\"26d1b1b3ceddf62d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/dataExtension.js\":\"285c621bb5b1e5f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/index.js\":\"debd8f6b6f86ba60\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/mentionAutocomplete.js\":\"1aefdbd98d44243c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/processor.js\":\"9c4312478750d89f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/profiles.js\":\"d4b03cd30e787b5b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/queries.js\":\"551a3483a3082509\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/contributors/schema.js\":\"650a7817c4866302\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ca8dcac2be0c311d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c56ce88c89b57747\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/index.js\":\"9a70df1e234168cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a423e92c28fba2d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dc7cbbd06d431517\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/CalendarGrid.js\":\"e7768b1ee39bed4f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DailyNotePicker.js\":\"0e2dbe192225d89d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"40be412f8bdde82d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateNavDecorator.js\":\"cff57c78df398d75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DateScrubOverlay.js\":\"bac0750960649915\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayPropertyControl.js\":\"6acef6ee013fc54f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/DayValueReferenceControl.js\":\"41431b331018ccb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/HeaderItem.js\":\"8cd15190ebf833cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/ReschedulePicker.js\":\"ee2d7391d30d5499\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b9c154123dc59da4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/actions.js\":\"d252651ee68d4b41\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/blockDateAdapter.js\":\"7af3ec14ebdc58ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/calendar.js\":\"2bc94bf9c62df05f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dailyNotes.js\":\"2b0b329825817f9f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dataExtension.js\":\"629805e48a4f5dc3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubActions.js\":\"0c16129f0606f52d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGesture.js\":\"2ff4ee50caaa8c36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubGestureActions.js\":\"066578a9449b2eb3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dateScrubRecognizer.js\":\"09168fa255630e11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayProperty.js\":\"3a77b5fdd26ef54b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2d317b10ef3d023b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/deletionGuard.js\":\"74ee9ded92dd93f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/dueQuery.js\":\"c6f573f7df4eac19\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/index.js\":\"6d348f25a92346a0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/landing.js\":\"73ddec0a69d4e549\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/localSchema.js\":\"cbdb18ca4334048d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/referenceDateAdapter.js\":\"c19448bc207e8b57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/rescheduleAction.js\":\"35418ef5a7009cf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/schema.js\":\"0fc0087244f929f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadBlockDates.js\":\"d00c5ab94f8728e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/spreadDatesAction.js\":\"1a89558584d5f573\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/today.js\":\"2d946cc3657b28fa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f2e99c71c21fbb8c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9f3e134f3de8f591\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/audit.js\":\"0a816356fa98bad2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditAction.js\":\"e49374b5dd36490a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/auditRanges.js\":\"6ece1866eb336cb3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/diagnosticsSource.js\":\"7ddaccabaa4a504d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/divergenceScan.js\":\"26c79695cb571d3b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/index.js\":\"52794a36d5e35e96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ea4db6ea1e6b1977\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/referencesMirror.js\":\"c0a2df3164f5631a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/rowJson.js\":\"863c8b223839f549\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/schedule.js\":\"0cc6fbb4bf9b9e02\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/data-integrity/store.js\":\"50fbd3a58f3ac72c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/action.js\":\"cab22749e5f89bf9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/index.js\":\"6fba2f62975fdb80\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-maintenance/plugin.js\":\"959dbdf3fb23d127\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5337b85234058297\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/actions.js\":\"299e7278d29a6053\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/changeMarker.js\":\"60dd31697b032fcb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/diagnostics.js\":\"83ce53c145226dbd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/fileSystemAccess.js\":\"f12fe5c1028564d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/filenames.js\":\"63bef39f60c1f209\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/index.js\":\"25de94ce1aef8470\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/mirror.js\":\"e0b40c99d6897b32\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runLock.js\":\"13e93e57c36da95e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/runtimeHealth.js\":\"c6bc01fe39a9b7a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/schedule.js\":\"aff2c24b71fb8518\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/db-mirror/store.js\":\"abd918f095ff005b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/index.js\":\"c839481eba3d6072\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/default-themes/themes.js\":\"a1e9cbcff0017c3e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/facet.js\":\"239b2304ca4793d6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/diagnostics/useDiagnostics.js\":\"257cc12ce355a702\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/dismissals.js\":\"ff57492108a70289\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/index.js\":\"863e14035392ca3b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/status.js\":\"05821e948d09866e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extension-prompts/store.js\":\"5f605560d42e9ac0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3f9ace42ebeb9858\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f9cbd3c8c2906e08\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/actions.js\":\"c8018c921b470835\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/config.js\":\"9b16fabed11f656d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/dataExtension.js\":\"92ac8e455fdc6632\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/effect.js\":\"e5b8f5666903a92b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/index.js\":\"bbacf7b7442930f2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8bb539b73136a218\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extensions-settings/useToggleTree.js\":\"debf4a6f140ab7d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/ExtractTypeDialog.js\":\"226a47f285aa4833\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ef1dcbe0810b0d1c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/PropertyShapePicker.js\":\"199145c5c8414ed3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/action.js\":\"755044b0fae8ae46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/extract-type/index.js\":\"4465845c477c0737\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/FindReplaceDialog.js\":\"fa39df5b0aa74a11\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/HeaderItem.js\":\"f5da82c31d0f1a5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/dataExtension.js\":\"9439b6dbfe23541e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/index.js\":\"6eed9988e9e35e52\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/search.js\":\"568fc7374e024e1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/toggleStore.js\":\"f134ff27c4ca22eb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/LocationPropertyEditor.js\":\"63ac4852baa8658d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/MapView.js\":\"095363967adfc90b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/blockTypes.js\":\"cd835cc2e1d875bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/codeMirrorExtensions.js\":\"f631bf2ef4259e90\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/createOrFindPlace.js\":\"07f2bb8deaf0b6f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/currentLocation.js\":\"ff1bc8e94c2c3b65\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/dataExtension.js\":\"9de2258bac29b5fc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/geoContentDecorator.js\":\"ca91cb2c6d2afadf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/googlePlacesClient.js\":\"aa67514113ab0a75\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/index.js\":\"48ed2063e2fa1d71\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/locationsPage.js\":\"187e25f887ac70f5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/mapViewport.js\":\"f26658994a4d2694\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/pickCurrentLocation.js\":\"d81594649ed97641\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeAutocomplete.js\":\"342e7406f89b08f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/placeNameCollision.js\":\"8ea56ae363a514e7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/properties.js\":\"29eaf535c44fbd28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/propertyEditorOverrides.js\":\"f3a491205b6eb2e3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/query.js\":\"a666b219582c472f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/geo/usePlaceSearch.js\":\"ffce4b24d753ca66\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0eacc0bc3e804596\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e4bbdf128fe9c09a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1fe3a31bb67fafc4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/config.js\":\"45054431408690d2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/dataExtension.js\":\"1a4aee25f1d1be58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/facet.js\":\"1c078bdf6cc68dcc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/grouping.js\":\"4234ae6abfd42364\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/index.js\":\"9ae2fbf41b382616\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2d4574e540fb9010\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/query.js\":\"0105ef35f5c90701\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/resolveConfig.js\":\"e2e2f20a3ff6eec8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8385e89e8f8d7da4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8f804f3cc6bec115\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlDocumentContent.js\":\"f72be67c4a53697e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/HtmlFrame.js\":\"bc3ef544adc7dd43\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/actions.js\":\"9b3852d834958842\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/blockType.js\":\"53c498236f5762f8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/confirmRunScripts.js\":\"e558aaf89c91a35b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/dataExtension.js\":\"6533f5de43cf6a36\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameAnnotations.js\":\"b89d63e927ca8acd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameDocument.js\":\"cbe1233d99140f69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/frameTheme.js\":\"7a7eb940aef6edea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/index.js\":\"759ca5b257a678bf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/scriptConsent.js\":\"cce7413f0db380a9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/sourceMap.js\":\"91e23e8e2ba04a25\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/html-document/useDocumentScripts.js\":\"d131576a33120049\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/index.js\":\"f2e1851cd1a1ef28\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/record.js\":\"760db860671fb1b8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/recordStore.js\":\"1ea9779ed7e9ead7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/responsiveness.js\":\"d7af6ca0c8a3cccf\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/schedule.js\":\"6d0f93dbd7202835\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/interaction-metrics/sessionContext.js\":\"58b0e7fa8426f15e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9c319dc0027fc006\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e6757133cd2dfe57\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/actions.js\":\"b58701b433c27aa7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/config.js\":\"a36eeae2d3b1fcf8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/dataExtension.js\":\"09450aea52c1a27b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/effect.js\":\"2270b8b4367734a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/index.js\":\"72b5dbbe804546d9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/keyCapture.js\":\"9d0eed4e6efa1cd3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/overrideStore.js\":\"40c592de5becd34f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e35a1514e91f9d84\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/HeaderItem.js\":\"a8bf87d1ce78346e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/LeftSidebar.js\":\"f2d14488844e78b5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/actions.js\":\"283cafdeaeb75de6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/facet.js\":\"cbb5fc25fd16eceb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/index.js\":\"a1dba978a5f5c422\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/shortcuts.js\":\"027fad1a5a70fce3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/left-sidebar/toggleStore.js\":\"e2edd8b421738bc5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/MergePicker.js\":\"f5f5977570b368e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/index.js\":\"ffd193d9cde9b756\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/mergeAction.js\":\"e66194823d2bdbd2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/merge-blocks/strategy.js\":\"9791e5e4777c069b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/Button.js\":\"b30d1b9f364c5b04\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2aa6d5d83ed07dfe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d376e8eac564d329\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/facet.js\":\"279fcf7d298f6f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-bottom-nav/index.js\":\"a2ba26e3560daa30\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"719c32a46cd10e78\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5dab006154debd6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"dde3e8cbd8f59be5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f41c3f2bd265f2b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/mobile-keyboard-toolbar/index.js\":\"8f8f0cb96d7a3aa8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5285cc096df52dbc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5180346b042ec30a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/contextMenuItem.js\":\"2f8df3d7fb7aeb3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/index.js\":\"1f9e78f7b9de9d5e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveAction.js\":\"e29b009f9c1c1cfc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/moveBlocks.js\":\"e172af9ab368783f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/move-blocks/selectionAfterMove.js\":\"f15550cbe8d54812\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/TutorialBanner.js\":\"6a0a07e7352bff5c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/action.js\":\"774eb842a9ea6411\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/bannerDismissal.js\":\"e8b366d474414f00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/documents/cheatSheet.js\":\"07a1a438e387ef3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/index.js\":\"052d2fe8e48381c4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/keys.js\":\"c1bd397881090409\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/landing.js\":\"451aa53cae54dfb1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/outline.js\":\"6c4135b2a7be49c2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/onboarding/seed.js\":\"bf85465b37612c0a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/PerfTrendDialog.js\":\"28c105eb8b5d5b1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/analyze.js\":\"d51b5d1588515e83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/diagnosticsSource.js\":\"46ae183a1106f857\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/index.js\":\"96d621110dc4821f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/load.js\":\"ad228c71e2ce1703\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/monitorRun.js\":\"804830864eb64e58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/schedule.js\":\"cfc487b7cb7c64e1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/series.js\":\"0ace10e8c26dd390\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/store.js\":\"f6ee75a4993bfaef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/trendAction.js\":\"aa811e917f961e48\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/perf-monitor/verdict.js\":\"5a84d8460f297a3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/clickToEditAction.js\":\"b2dbb093dd259414\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/index.js\":\"ec6e47d3a11108b2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/plain-outliner/interactions.js\":\"bf52e977c5e9c97a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ffb38b235a73138b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGate.js\":\"80c44752ed8416a5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/MigrationGateDialog.js\":\"4eadf5a48c3072a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/action.js\":\"386e1207c9736a80\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/index.js\":\"665aa917f91a907c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/localRunMessage.js\":\"0ab51697796bc17b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/plugin.js\":\"011aaaec1057c8f1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/progressReport.js\":\"ce1d3a6f237d9ad9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/properties-migration/sweepProgress.js\":\"52da5202ee4d7ef6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/FieldRowRenderer.js\":\"adf0d6e76dc39fea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/ValueRowRenderer.js\":\"8a664cb354ba7542\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/actions.js\":\"d10d5ed306956e5f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/autocomplete.js\":\"529c82630d9efdaa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/fieldRow.js\":\"25045d88be46a5cb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/index.js\":\"a4301ed2686a4239\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/referenceWarning.js\":\"d6eb70a3debf6c1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueAutocomplete.js\":\"bd2243e182208ad0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/property-rows/valueSchema.js\":\"9d3d9f9aadb25772\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/HeaderItem.js\":\"982c30c5534b9d64\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/QuickFind.js\":\"851e3c90c572e0cd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/index.js\":\"81429361bd593c1f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/recents.js\":\"884cb18fe7ee1c3a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/resultItems.js\":\"ad348bc3925c7e69\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/selection.js\":\"270a395dd72f5c0f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/quick-find/toggleStore.js\":\"e27dc90afe67737f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/HeaderItem.js\":\"d91874d813487900\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5a353f09a18be68e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/grouping.js\":\"793a1348030300ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/index.js\":\"01f497dcfd1847f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/recents/target.js\":\"b601bb66794026b4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/codeMirrorExtensions.js\":\"6c45e255db27cf54\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/contentPrefill.js\":\"d20b25c0c7d8733d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/dataExtension.js\":\"f3f2d77c2c55a046\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/index.js\":\"4635ca785ac9b8e5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"042d1bd9fc6ea60d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/invalidation.js\":\"87ec9d446a00f6d7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/localSchema.js\":\"240e1469e19250f3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/index.js\":\"7e30692f08a54396\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d3a65a279a460b10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/index.js\":\"88d450024cad5347\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/referenceNode.js\":\"d80398941d98b3c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/remark-reference-occurrences.js\":\"512400d9e81e9181\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9ef8a1f97eeab87d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/index.js\":\"d5a7962366d93a1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"70a29ad97aa2f73a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ef3e36fa69882f76\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/mergeRetargetProcessor.js\":\"c4d81c9cbe1a19cc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/parseFence.js\":\"2cee4664a2c9b10c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceParser.js\":\"be0c1497d6b5e0ef\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referenceProjection.js\":\"8c3c4b5efdeb5263\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/referencesProcessor.js\":\"e72c3fd3e8fb0be2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/renameProcessor.js\":\"2d39617ca7d27d6d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/references/spanReplacement.js\":\"0ccbd14695bd0d4d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/htmlToOutline.js\":\"4955688730e46c68\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/index.js\":\"7e38ee7f405951c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c8eebedfa7b59573\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/rich-paste/pasteDecision.js\":\"4b16c9a8606adfb7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/action.js\":\"32025efff0b1fd43\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/blockIds.js\":\"8d2ffde123236784\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/content.js\":\"f9807dda2420c737\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/effect.js\":\"710690d677b3b9d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/ids.js\":\"771c47d504554940\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/import.js\":\"e3ea6906744438e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/index.js\":\"3445e875c5bed9bd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plan.js\":\"fea653ab101927c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/plugin.js\":\"a1049d62925b54aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/promotion.js\":\"d29392500598caa5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/properties.js\":\"5844607fe3b13183\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/references.js\":\"f2b2940db87e2303\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/report.js\":\"3a8c85cab40d0a51\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/roamMemo.js\":\"7e3f2ce6b6bb2f27\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/runtime.js\":\"d73940f3793d963f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/schemaReconciliation.js\":\"e7361f4ec472f2e2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/srsMarkers.js\":\"be9e3731c72131c7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/todo.js\":\"8cb8ea96735f573f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/typeCandidates.js\":\"587576819ae73741\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/roam-import/types.js\":\"b46be948acc5b381\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/index.js\":\"1999096b6c1577a3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/search-health/store.js\":\"21da451f509d58f7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/HeaderItem.js\":\"97d1638177fbd039\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"04664dc4cf076cde\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/index.js\":\"9b6b16ad844d6a4c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/model.js\":\"86ab0075330ccdff\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/toggleStore.js\":\"17fb7346dc2509e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/shortcut-help/useKeyInspector.js\":\"f90c91a4390f9f7d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"48e90e04b691408e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/ShellDecorator.js\":\"9ed154c671722c58\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/actions.js\":\"c4e250eb37e74073\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/exclusionsFacet.js\":\"11b98e0da8e5441a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/index.js\":\"6c616653403ed004\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/shell.js\":\"21bae98ca197e930\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/surface.js\":\"09832d4be6ae576a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/spatial-navigation/walker.js\":\"b607b24261388948\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f9ae899e09327852\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/dataExtension.js\":\"ecf00b5719e65157\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/index.js\":\"6eb8a9277c6bc4aa\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/indicator.js\":\"6b3f10a233351cf3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/moveSrsState.js\":\"9b521ab7d8ac71a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8b7242ad97d41f45\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/scheduler.js\":\"dda8ba159842390c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/schema.js\":\"bab335f4aa7561e4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6c33332210e38b2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/srsClipboard.js\":\"a9b491abd990c54b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bdb18810b34a986e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ec2f7f6b2f1d737c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/DeckPicker.js\":\"9243e8855e960e2c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewControls.js\":\"6ef66e2707821ec2\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a8ba19103d881ca1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/ReviewSession.js\":\"8d50c4faa1c03b25\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/actions.js\":\"882bcfd0f288321d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/archive.js\":\"866758cc0755ba17\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dataExtension.js\":\"fec01efb88e4cbd8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/deck.js\":\"2de7c5074d12fa37\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/dueQuery.js\":\"06b44fad02ec8e46\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/gradeDecision.js\":\"e0fe69636b687f4b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/index.js\":\"85a0a4e6cee2d559\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/keyHints.js\":\"141d497ef84cb573\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewCardLayout.js\":\"921384ee8b630c00\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/reviewProgress.js\":\"e931643c9c8d8e1e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/schema.js\":\"96441f258bf5666c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/srs-review/useDueCards.js\":\"4f9c8b8ecaef7f2d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/index.js\":\"2ea33a3f6784d188\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/startup-metrics/record.js\":\"b6e34656e87a8076\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/index.js\":\"3fbb0808c5799e1a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/persistenceStatus.js\":\"c65f3c141f2fc1c1\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/storage-persistence/requestAction.js\":\"562eebc264aa6ed8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/TypeChipsDecorator.js\":\"c6e778494dba8764\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/codeMirrorExtensions.js\":\"b9da88af536ba3fe\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/index.js\":\"4d56bc9113df3e97\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/supertags/typeAutocomplete.js\":\"8aeff99c1e4de260\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"43cdd78cba883f6b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/actions.js\":\"926357adfc5fe673\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/anchor.js\":\"e9553e5477fa116f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/events.js\":\"0e0220c13883ef1b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/gestureActions.js\":\"a700c50f8e4c71af\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/index.js\":\"0e6d27ac98c691ab\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"39d28e61930b0330\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/collect.js\":\"ce20d541c46f484c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/index.js\":\"e7ef00344890ef96\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/sync-metrics/record.js\":\"cbf83d7b23ae0a39\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/RejectionDialog.js\":\"7a2e6d6a45c13bf5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0642b5c43cfc1663\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/index.js\":\"f6b39a9e0cc80f01\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/model.js\":\"fbdc2d0f51e24295\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/queueCounts.js\":\"9d82b1f75c7976e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rejectedHelpers.js\":\"5a68dfc82d728e10\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/rematerializeAction.js\":\"74ca79b1236f02d0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/system-status/useHysteresis.js\":\"71f3793d7214a795\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/ColumnHeaders.js\":\"ea0e05c6943bc58d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/QueryUi.js\":\"0cc99817ec054486\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/TableLayout.js\":\"a653c29dcb0c61e9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/actions.js\":\"cc77fb3eb5dadd2a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/cellEdits.js\":\"8d48b3425a974b93\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/childrenViews.js\":\"2be2907928f55881\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/columns.js\":\"8968090c16eff763\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/controller.js\":\"73489bf186f5ee9e\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/convert.js\":\"099ccbe7531772a7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/dataExtension.js\":\"9e2bd5a9a9df3e8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/index.js\":\"061835c4369def0c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/keys.js\":\"61d8e7e7334e0f8f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/model.js\":\"cf3eea0eda50543f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/QueryText.js\":\"ad60480d3c2af796\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/backfill.js\":\"8785d57949c3b9ad\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/completion.js\":\"6c724a15488e0398\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/format.js\":\"030a8e54dfe540c3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/parse.js\":\"125f87b7e840c3d7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/queryValue.js\":\"6b02a69cab88ded5\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/registrations.js\":\"06ce99e02f99a9f4\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/query/source.js\":\"035e88c77d75bedc\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/registry.js\":\"d8adffefa45fcfa7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowGutter.js\":\"b3e9ebc21c6c240d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/rowVerbs.js\":\"3f74671404f92db3\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/schema.js\":\"5ac5fa26dba8bd23\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/tables/sort.js\":\"f767e5157de04214\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/effect.js\":\"cb517f8a435e7e0c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/index.js\":\"2268a8a7f168c922\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/theme-toggle/theme.js\":\"8c3908abe743404a\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/actions.js\":\"3ee23d0bd9ffe734\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/dataExtension.js\":\"35f9ba75d5bf7ed6\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/index.js\":\"0c7f8862b0b325fd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/todo/schema.js\":\"8a7dcc8664e62a83\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/TouchSelectionLayer.js\":\"85426fff00ed1d3c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/actions.js\":\"12c0bd0d263b101b\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/defaultItems.js\":\"5cbe183f7367a8be\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/facet.js\":\"7b8c6e36afe1b3a8\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/holdRecognizer.js\":\"9e2c32686804bf3f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/touch-selection/index.js\":\"0a53dc24444fc841\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/UpdateIndicator.js\":\"06a456bcbee85cea\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/index.js\":\"50fe448616ba252d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/update-indicator/loadTimes.js\":\"da8a5d35d15c144f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoNotesRenderer.js\":\"6fda0b432b6e2f6f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoPlayerRenderer.js\":\"03664c1236cceaa9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/VideoTimeStamp.js\":\"8e4508df09da8414\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/actions.js\":\"726ca49b00671a7f\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/index.js\":\"267b237e8c675025\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/markdown.js\":\"95aa6c0a90a54817\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/notes.js\":\"977fd02b0b18715d\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/registry.js\":\"cbc6702aae446803\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/remark-timestamps.js\":\"88ae9e2d643f73b7\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/video-player/view.js\":\"351463916fb1e4c9\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/LinkHints.js\":\"533cbae7b90d5def\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/index.js\":\"d25caee57ca0949c\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/model.js\":\"8de329a65894ca24\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-link-hints/settings.js\":\"36758ce1aaaa68c0\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/actions.js\":\"e02364fcabb5b647\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/index.js\":\"e8afccbfb1e953bb\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/vim-normal-mode/interactions.js\":\"4916cadfc26ad2dd\",\"/knowledge-medium/pr-preview/pr-1739/src/plugins/workspace-header/index.js\":\"8845f62fb8bb991b\",\"/knowledge-medium/pr-preview/pr-1739/src/registerServiceWorker.js\":\"4aeec9f3180d4f5a\",\"/knowledge-medium/pr-preview/pr-1739/src/requestPersistentStorage.js\":\"010bc34acfefc4e3\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authRequestDeadline.js\":\"325cee165044a87b\",\"/knowledge-medium/pr-preview/pr-1739/src/services/authStorage.js\":\"86abf8457e9494c9\",\"/knowledge-medium/pr-preview/pr-1739/src/services/powersync.js\":\"4da169e58ecc0816\",\"/knowledge-medium/pr-preview/pr-1739/src/services/supabase.js\":\"6d18e86a0880860d\",\"/knowledge-medium/pr-preview/pr-1739/src/services/uploadErrorClassifier.js\":\"e7ee271ce96caf28\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/ActiveContexts.js\":\"d3c438553ec777a0\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/HotkeyReconciler.js\":\"b33143fa3eed3138\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/WipeLocalDataDialog.js\":\"24e008680c0c6616\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionDispatch.js\":\"00f67fa788f908b4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/actionRefItems.js\":\"3a6bf706a833eefc\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/applyKeybindingOverrides.js\":\"b8c2b370fe748859\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockActions.js\":\"fa2d15564ffe1763\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/blockMergeGesture.js\":\"b73840d31f324f61\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/canonicalizeChord.js\":\"7db1c3f79e292573\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultContexts.js\":\"20597ee396d8f487\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/defaultShortcuts.js\":\"5880ea20d4ad2889\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/effectiveActions.js\":\"fb679866633982c4\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureAction.js\":\"7a645f3d1d75517e\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/gestureBinding.js\":\"59ebf7abe3574b12\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/holdRegistry.js\":\"c170f0cbc74897cc\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingConflicts.js\":\"58395ec4cfd0fe90\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/keybindingOverrides.js\":\"8e4b49f47aa1e3d3\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/pointerAction.js\":\"0e39050c595a88b6\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/resolve.js\":\"fedf66fc3007fe60\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/runAction.js\":\"39826617b55fe3a0\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/sequenceMatcher.js\":\"466af6a5a40581a9\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/types.js\":\"582e2ea016aa1705\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionContext.js\":\"5eb609e2c306ef55\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/useActionDiscovery.js\":\"7232d643dd3ed207\",\"/knowledge-medium/pr-preview/pr-1739/src/shortcuts/utils.js\":\"23d606d52ce3d94d\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/bootStore.js\":\"bb6cd5f3314b52ea\",\"/knowledge-medium/pr-preview/pr-1739/src/sw/previewDatabases.js\":\"22aebe976c513784\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/byteTransform.js\":\"7349c2c61ced4cd1\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/attachmentCleaner.js\":\"4bd130e608c0e00d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/attachmentParts.js\":\"6e7164e151d4a08e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleParts.js\":\"37113e215602ef47\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/bundleRecord.js\":\"64c3031fd229d49b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/manifest.js\":\"5c468be6c76c6bfc\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/takeBundle.js\":\"5883956248a566a3\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/bundle/verifyBundle.js\":\"ac3560c4ece4ce4b\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/cleaningStage.js\":\"d6e570c4350005e5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionKey.js\":\"c66e72a2722da957\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/conversionServer.js\":\"b07d3bbec2234613\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flip.js\":\"c88845aa6b710dde\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/flipAttempts.js\":\"fe6b93b227f96449\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/pages.js\":\"72859fec3e510215\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/preflight.js\":\"4755a37d8eba0b1e\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/reseal.js\":\"ee373cf1bb24806a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runConversion.js\":\"f04f964e598dfb25\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/runLock.js\":\"2a319e04d78c6719\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealing.js\":\"07fac5b29bbc4b8f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/sealingStage.js\":\"444a38d608f74b14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/stage.js\":\"4af3677dd27e6941\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/conversion/verifyReseal.js\":\"74079d85ff7516b7\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aad.js\":\"26198b5c0d66bf74\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/aead.js\":\"cec5fea08dc75453\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base32.js\":\"aae8b1292f3cc53a\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/base64url.js\":\"58168e16a4b233fa\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/binaryEnvelope.js\":\"912c187f2c80af98\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/byteAead.js\":\"2c8b8990218b41e2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/canary.js\":\"e5a748736ef3242f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentHash.js\":\"6cf78ba75c5a963d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/contentKey.js\":\"b1ed0d3edfba7cf4\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/derivedIdNamespace.js\":\"0f019e615097ba81\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/envelope.js\":\"d971dc02e4a46c30\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/hex.js\":\"eedd21153e1724bb\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/sha256Hex.js\":\"5997f4f78a2d9309\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/crypto/workspaceKey.js\":\"2f97800f8585ebe5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/conversionState.js\":\"cbd91fb4e295d7d9\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9b26f2a395e3279d\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/pastedKey.js\":\"00aad0ac5b555ab2\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"855ce85aaeb76851\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5dfe53a3260576cf\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/keyStore.js\":\"975204b3fc0e9106\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/mintWorkspaceKey.js\":\"d8f4ecf7edacc8d5\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/modePin.js\":\"efedb1d29a05483f\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/openWorkspaceKeys.js\":\"948ccc35ad760899\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolveWorkspaceEntry.js\":\"08d0175e99429ae0\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/resolver.js\":\"963d6937da593418\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/keys/workspaceAccess.js\":\"5b88fa26c22cdf14\",\"/knowledge-medium/pr-preview/pr-1739/src/sync/transform.js\":\"49af394466d6db31\",\"/knowledge-medium/pr-preview/pr-1739/src/themeBootDefaults.js\":\"9f9d84c9bece7cc8\",\"/knowledge-medium/pr-preview/pr-1739/src/types.js\":\"43733102c968b49e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/ClientLocalSettings.js\":\"0686a2bbe9d0916b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/abortableSleep.js\":\"d33966094ae440f1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/array.js\":\"9d4bab133f13f047\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/backlinkAutocomplete.js\":\"a0719cb80ce05a7e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockCrumbs.js\":\"db4adbe64b7e1a63\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/blockrefAutocomplete.js\":\"c979a42dc9573e6e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/cadencedIdleJob.js\":\"5adce695cd4190f1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/callbackSet.js\":\"0a4442b076ab5b28\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/clientId.js\":\"3187d9dd71ffbfc0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirror.js\":\"56741534a9e38349\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/codemirrorCompletion.js\":\"9ff18845d6143412\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/copy.js\":\"550b1619c9b3dd37\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dailyPage.js\":\"4983904db69d9995\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensics.js\":\"39dd827abbcc4579\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dbForensicsHooks.js\":\"9bde927d46f9b5ba\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/deleteBlockThroughUi.js\":\"dfdb13d8d2e50027\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dialogs.js\":\"bb8c7655ecac9062\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/dom.js\":\"b8cc4959ee348cb0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/downloadBlob.js\":\"93dde8d964e1619e\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/drawnWalk.js\":\"bbe136426eac6cca\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/exportSqliteDb.js\":\"b215bd0b65c4d95f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fileSystemAccess.js\":\"62fbf4e4796890f7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/flipSlide.js\":\"b2f0e131d3a307fd\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fnv1a.js\":\"32bb6df827e670ed\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/formatBytes.js\":\"dde3cd44642295cb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/fuzzyRank.js\":\"5785b57f09266358\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idbKeyedStore.js\":\"87d695dde865f122\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/idleCallbackPolyfill.js\":\"edf0f0cc366eb353\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardAwareScroll.js\":\"09292cf601173135\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/keyboardViewport.js\":\"7484b278a5bac46a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/lastWorkspace.js\":\"0224aa134e8dd278\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutColumns.js\":\"52710ca66002894c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionDom.js\":\"e15b569c2a74efab\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/layoutSessionId.js\":\"bbf1a7320980ed68\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkClickGestures.js\":\"7680c001c47fe6fa\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/linkTargetAutocomplete.js\":\"bbdfd26ca13f1ea9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbCorruption.js\":\"ec7c9801a57eda06\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/localDbRecovery.js\":\"868cff59c28cb694\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/markdownParser.js\":\"d92deb15c90b0275\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/memoize.js\":\"6b6bece3543b7912\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameFieldCommit.js\":\"428a0e2eccaab0c6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/nameList.js\":\"3fec5316e9fe1216\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/navigation.js\":\"e2226d61722aa621\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/omnilinerNamespace.js\":\"48398f552f35902c\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/opfsPageScan.js\":\"dfe86d0a7a416a16\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelClearance.js\":\"ae3f111366c71832\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelHistory.js\":\"89308dcd24ac8442\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLanes.js\":\"ededfd7f34187a48\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelLayoutProjection.js\":\"79e53718965987c0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelScrollAnchor.js\":\"b7e159e405f88a00\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/panelUrlFlags.js\":\"cf70b43fe6017c29\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/platform.js\":\"4b772c2e8633b082\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/pluralize.js\":\"8780f7b44b295192\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyCreation.js\":\"84af3aa20757384b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyNavigation.js\":\"d6b2ef89e5b24d16\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/propertyValueContext.js\":\"f5d5b055729f9804\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/react.js\":\"7fee10d17826a327\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeDate.js\":\"016c1e77ae6072fb\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/relativeTime.js\":\"e94bacb2873ebb4d\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/renderScope.js\":\"a599af77fdad91b0\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/resolvedThenable.js\":\"aefe2425dc82361a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/routing.js\":\"a8eacd14b29fd907\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/safeMode.js\":\"8bc390072e05fbf6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/scheduleIdle.js\":\"0bfdfc018a0f67e5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/screenWakeLock.js\":\"53453981ed3c26e5\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/selection.js\":\"47950e52a703cd37\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/softKeyboardGrab.js\":\"45b4d3aa981484d7\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/startupTimeline.js\":\"81d50bdce20930f8\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/state.js\":\"8ce2c68b5903fc40\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/string.js\":\"86a04e8c90921578\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/surfaceZoom.js\":\"cb8a5592964497ef\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/time.js\":\"037e2eb7de211499\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toast.js\":\"1e613420b3241216\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/toggleStore.js\":\"d592d2ab725fb37a\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/untilStopped.js\":\"5da32629a943f6df\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/userActivity.js\":\"d600170efb6f7b36\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewTransition.js\":\"ca51a6bf5ec053f1\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/viewport.js\":\"0ee9e2a046d7d05b\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/webLock.js\":\"122996ef38e55ad9\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceRecovery.js\":\"476085314406667f\",\"/knowledge-medium/pr-preview/pr-1739/src/utils/workspaceSnapshotStore.js\":\"dc156508b2a9ec63\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-compiler-runtime.js\":\"d1c5d04a421374b8\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-client.js\":\"2b78741bcad3cd93\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server-edge.js\":\"432a6d220aa92c0f\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-server.js\":\"c9878ed33fb1f465\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static-edge.js\":\"b12c8828c689eb66\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-static.js\":\"108ba4b0ce413bcc\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom-test-utils.js\":\"8130de6043eee571\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-dom.js\":\"ac916e1e28117abf\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react-jsx-runtime.js\":\"7d9ec329ead05bb0\",\"/knowledge-medium/pr-preview/pr-1739/src/vendor/react.js\":\"0a7898c37a72591e\",\"/knowledge-medium/pr-preview/pr-1739/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1739/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
