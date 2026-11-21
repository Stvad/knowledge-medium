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
		buildId: "82ec8ab07660-1843caf1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1782/\":\"2f093e85113c329e\",\"/knowledge-medium/pr-preview/pr-1782/index.html\":\"2f093e85113c329e\",\"/knowledge-medium/pr-preview/pr-1782/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1782/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1782/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1782/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1782/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1782/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1782/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1782/assets/FacadeVFS-B0vORneq.js\":\"8da88f430443cc2b\",\"/knowledge-medium/pr-preview/pr-1782/assets/OPFSCoopSyncVFS-iwYSUwiY.js\":\"dafbe84de1b4dd63\",\"/knowledge-medium/pr-preview/pr-1782/assets/OPFSWriteAheadVFS-DNLvA5GV.js\":\"9b8140c7bf39d1f5\",\"/knowledge-medium/pr-preview/pr-1782/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1782/assets/wa-sqlite-YRsPQuvQ.js\":\"06d285e6435b48fa\",\"/knowledge-medium/pr-preview/pr-1782/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1782/assets/wa-sqlite-async-DhFIt1_7.js\":\"4735af7bbf383f9f\",\"/knowledge-medium/pr-preview/pr-1782/assets/worker-BGIrW7ED.js\":\"790294aecbe6f3c2\",\"/knowledge-medium/pr-preview/pr-1782/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1782/chunks/app-DVvgCO_H.js\":\"5a27f7b5b47570f8\",\"/knowledge-medium/pr-preview/pr-1782/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1782/index.js\":\"4b98c55a6212f3f6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1782/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1782/assets/AccessHandlePoolVFS-BFymzp1s.js\":\"c8e191f88cd52eb8\",\"/knowledge-medium/pr-preview/pr-1782/assets/IDBBatchAtomicVFS-BVf0BP9m.js\":\"5b7c9e1d0e9b9898\",\"/knowledge-medium/pr-preview/pr-1782/assets/MemoryVFS-D8nwfrZr.js\":\"842a7307afab3436\",\"/knowledge-medium/pr-preview/pr-1782/assets/mc-wa-sqlite-CV_f5bco.js\":\"61352aa444fb2be6\",\"/knowledge-medium/pr-preview/pr-1782/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1782/assets/mc-wa-sqlite-async-Briw9rkz.js\":\"7e49c3d1ed78f8a4\",\"/knowledge-medium/pr-preview/pr-1782/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1782/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1782/chunks/AccessHandlePoolVFS-C5PlfO2Y.js\":\"b15945267f41595d\",\"/knowledge-medium/pr-preview/pr-1782/chunks/FacadeVFS-qYX9RlnK.js\":\"7a46d0491703da93\",\"/knowledge-medium/pr-preview/pr-1782/chunks/IDBBatchAtomicVFS-DLUt6GS9.js\":\"13f81334a1a35972\",\"/knowledge-medium/pr-preview/pr-1782/chunks/MemoryVFS-B7NuaM0X.js\":\"b80fda46cc6076bb\",\"/knowledge-medium/pr-preview/pr-1782/chunks/OPFSCoopSyncVFS-C7fmXBr_.js\":\"d5af812ec6847353\",\"/knowledge-medium/pr-preview/pr-1782/chunks/OPFSWriteAheadVFS-CDNGyF8a.js\":\"c29c493d4381689f\",\"/knowledge-medium/pr-preview/pr-1782/chunks/Preview-tYR-H2Jy.js\":\"b149ed17aa472701\",\"/knowledge-medium/pr-preview/pr-1782/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1782/chunks/card-C4mqqdhX.js\":\"3877b2480fd1dd91\",\"/knowledge-medium/pr-preview/pr-1782/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1782/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1782/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1782/chunks/dist-Dh0B_-ig.js\":\"850cde96913afd22\",\"/knowledge-medium/pr-preview/pr-1782/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1782/chunks/mc-wa-sqlite-D2_lfHHV.js\":\"f743f284a576cb26\",\"/knowledge-medium/pr-preview/pr-1782/chunks/mc-wa-sqlite-async-dDbcYZFp.js\":\"5db9b8f50d02a00b\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-5RwyBiUY.js\":\"a1f2bb1fda448b5e\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-BAhGS-mM.js\":\"0d3ea08e72b628a5\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-BJK02ORs.js\":\"95ce535d648bc313\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-CM7Ij2ae.js\":\"4e58d2263eb7e307\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-CrjfhDfw.js\":\"e93bf851debe78c2\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-D90yQPm8.js\":\"62d86d0f1da44dc0\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-DCNZEVm3.js\":\"f341a422dea72664\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-dom-server-legacy.browser.production-BcibhXuB.js\":\"3dbce88fdc522867\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-dom-server.browser.production-DVCtkWNA.js\":\"b92d5d4c84fa9268\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-dom-server.edge.production-CzGw9KPH.js\":\"d35998d6de4e285b\",\"/knowledge-medium/pr-preview/pr-1782/chunks/react-fk5xRWR7.js\":\"58bacdb5335caf92\",\"/knowledge-medium/pr-preview/pr-1782/chunks/server.browser-BIO-cHQx.js\":\"e3b7026afa1d8df0\",\"/knowledge-medium/pr-preview/pr-1782/chunks/textarea-CFp3FKTP.js\":\"00f2839f0a0a4149\",\"/knowledge-medium/pr-preview/pr-1782/chunks/ui-DIXX9JFV.js\":\"c3504879d558b119\",\"/knowledge-medium/pr-preview/pr-1782/chunks/wa-sqlite-BRMGYhh-.js\":\"4cb974e880e6f4a8\",\"/knowledge-medium/pr-preview/pr-1782/chunks/wa-sqlite-async-Cbfv7gEV.js\":\"f8d7977aaea08a62\",\"/knowledge-medium/pr-preview/pr-1782/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1782/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1782/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1782/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1782/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1782/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1782/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1782/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1782/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1782/src/App.js\":\"7970f19b792f8b50\",\"/knowledge-medium/pr-preview/pr-1782/src/appUpdate.js\":\"d01c5d0d452799c4\",\"/knowledge-medium/pr-preview/pr-1782/src/appVersion.js\":\"8a1296d477351757\",\"/knowledge-medium/pr-preview/pr-1782/src/bootstrap/initialLayout.js\":\"d409300a2f1e4d32\",\"/knowledge-medium/pr-preview/pr-1782/src/bootstrap/resolveWorkspace.js\":\"dfb7d6d4dbd99ddb\",\"/knowledge-medium/pr-preview/pr-1782/src/bootstrap/workspaceBootstrap.js\":\"263e9427054619d4\",\"/knowledge-medium/pr-preview/pr-1782/src/components/BlockComponent.js\":\"f52534a2d255ac19\",\"/knowledge-medium/pr-preview/pr-1782/src/components/BlockCrumbs.js\":\"9a14d51ddbe519bb\",\"/knowledge-medium/pr-preview/pr-1782/src/components/BlockEditor.js\":\"0d606b172965bd8f\",\"/knowledge-medium/pr-preview/pr-1782/src/components/BlockLoadingPlaceholder.js\":\"e18296646f308597\",\"/knowledge-medium/pr-preview/pr-1782/src/components/BlockProperties.js\":\"dca31197b7f4ebac\",\"/knowledge-medium/pr-preview/pr-1782/src/components/BlockSearchPicker.js\":\"f7d807a0f39bfcf2\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ConfirmBulkDeleteDialog.js\":\"4ee031ee20bd44b8\",\"/knowledge-medium/pr-preview/pr-1782/src/components/DividerHandle.js\":\"4a2083c00acd7bdc\",\"/knowledge-medium/pr-preview/pr-1782/src/components/DraftEditor.js\":\"d43997c1ddff6918\",\"/knowledge-medium/pr-preview/pr-1782/src/components/GutterPill.js\":\"13b700bce55bc9b0\",\"/knowledge-medium/pr-preview/pr-1782/src/components/Header.js\":\"3902f36ab0c55af3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/LazyBlockComponent.js\":\"834caf804ae4a9b8\",\"/knowledge-medium/pr-preview/pr-1782/src/components/Login.js\":\"c99dcad0b7f9224d\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ZoomableSurface.js\":\"c0c16548746c4a44\",\"/knowledge-medium/pr-preview/pr-1782/src/components/editModeKeepalive.js\":\"4289600133dcab03\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyDisplay/PropertyDisplayScope.js\":\"97f2e5f3371fb39c\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a0319007bad3c4f3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/RefPropertyEditor.js\":\"2dd3a7a4ab8c6446\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/RefTargetTypePicker.js\":\"0f7ab7c0913fb3f6\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/SelectPropertyEditor.js\":\"2b53c949330dba25\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/TypesPropertyEditor.js\":\"30ce155ac9312393\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/defaults.js\":\"f0c2f716d2829dae\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/kernelValuePresets.js\":\"517deefc7a9eeacc\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/selectablePresets.js\":\"a78a904c4cd1d58c\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyEditors/typesPropertyUi.js\":\"18dbc869143e9bcb\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/AddPropertyForm.js\":\"9147ab71a0510911\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/PropertyPicker.js\":\"b4c867117964e0f3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/PropertyRow.js\":\"d6bc9c5661e20bff\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/Rows.js\":\"3a0eb34e26531b72\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/actions.js\":\"d13cdb6a6d00e329\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/declarationOnly.js\":\"890efbef33c95191\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/layout.js\":\"07bacd70fe252a6d\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/model.js\":\"ad5f133dfdbd22d7\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/shapeUi.js\":\"16173b2c424cc59d\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/shapes.js\":\"9a8faf212dc0c8f0\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/usePropertyEditingActivation.js\":\"faed841a625eb12b\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanel/visibility.js\":\"1bb0c97afd11be55\",\"/knowledge-medium/pr-preview/pr-1782/src/components/propertyPanelSections.js\":\"39e6574ae9216a88\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/BlockEmbed.js\":\"28be1fd0419af955\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/BlockLink.js\":\"822b547a46d0852d\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/BlockRef.js\":\"8d1ade543424d835\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/ReferenceLink.js\":\"80cf21ada17bba7f\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/cycleGuard.js\":\"e5029e1a47d914e2\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/cycleGuardContext.js\":\"9aaed585a7d7257c\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/linkInteraction.js\":\"c5b3d74d8deb2545\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/referenceLayout.js\":\"fe5687274db0ee89\",\"/knowledge-medium/pr-preview/pr-1782/src/components/references/useBlockRefAncestors.js\":\"133ccc3febf021dc\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/BlockGutter.js\":\"127d700042dcf97d\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/BlockInfoDialog.js\":\"c4f8289aa91b41f1\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/BlockTypeBlockRenderer.js\":\"a66d8cf23addc2e1\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/BulletHoverCard.js\":\"38945c53329b0fcb\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/CodeMirrorContentRenderer.js\":\"021736c6607163a5\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"61a50b002c8b52c3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/ColumnResizeHandles.js\":\"d6b9ed8477073514\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"8125e82d07168feb\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/DefaultBlockRenderer.js\":\"56660ec2e92a1a1f\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/LayoutRenderer.js\":\"61123efb4adbccd3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/MarkdownContentRenderer.js\":\"cd1a4fe8438db331\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/MissingDataRenderer.js\":\"fb157a22bd01b986\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/PanelRenderer.js\":\"ff0af1cc24b47559\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8453fa9a3282f49b\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/TopLevelRenderer.js\":\"7fe00fdb1cb18fbf\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/blockGutterMode.js\":\"f353188e22b8818b\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/blockTitleText.js\":\"cb85d48e88552614\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/fieldCreationKeydown.js\":\"38607cf5313ae475\",\"/knowledge-medium/pr-preview/pr-1782/src/components/renderer/layoutRootContext.js\":\"0c0bc1b720240359\",\"/knowledge-medium/pr-preview/pr-1782/src/components/typeChip/TypeChip.js\":\"b7dbe72b308018fd\",\"/knowledge-medium/pr-preview/pr-1782/src/components/typeChip/chipStyle.js\":\"51f2e1206b39bb80\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/anchored-floating.js\":\"eca8761d1b679ec7\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/button.js\":\"85a911550d901d57\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/card.js\":\"2694581ace45d5ed\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/checkbox.js\":\"2c9886f5aa24e744\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/collapsible.js\":\"ed65b01dbef17139\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/command.js\":\"1fe8f9dfcdc229a3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/context-menu.js\":\"e92fe55bc07c24b7\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/dialog.js\":\"ae904b6e896ea663\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/dropdown-menu.js\":\"f38920bc9a44a7e9\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/floating-listbox.js\":\"0f5cf71093a47192\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/index.js\":\"10100c503e73824b\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/input.js\":\"14aee6420446a91c\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/kbd.js\":\"824716e99e8ffe7a\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/label.js\":\"19511b8c110c372a\",\"/knowledge-medium/pr-preview/pr-1782/src/components/ui/textarea.js\":\"1b1f50d612895794\",\"/knowledge-medium/pr-preview/pr-1782/src/components/useEditModeYieldKeepalive.js\":\"d9dd0502dcc52506\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/BootFallback.js\":\"c4f79a8bacf4fbaf\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/FocusedRowLazyMount.js\":\"11eba848b4e239d7\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/LazyViewportMount.js\":\"060884ae91ec43b7\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/LocalDbCorruptionFallback.js\":\"dfc758c586fd2817\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/error.js\":\"01b6df8d459b4e9b\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/lazyMountRegistry.js\":\"15bb018e0dfd2470\",\"/knowledge-medium/pr-preview/pr-1782/src/components/util/suspense.js\":\"b92bb83f84f831ed\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/CreateWorkspaceDialog.js\":\"96601f1737c69a58\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/PendingInvitations.js\":\"f48cae0145c86ac4\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/SyncProgress.js\":\"6059500cdef07494\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/UnlockProgress.js\":\"576c93abae9331ff\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/WorkspaceKeyGate.js\":\"5bd9756a251866b8\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/WorkspaceSettingsDialog.js\":\"27b5e7ee0ca5bd5e\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/WorkspaceSwitcher.js\":\"b56b104de70e0dee\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/WorkspaceSyncGate.js\":\"9ce57976523fa807\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/ConversionFlow.js\":\"af1fde07b5019b99\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/ConversionFlowHost.js\":\"6a2bb04f08601ca9\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/EncryptionSection.js\":\"8c088deae3628c84\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/attachmentPrompts.js\":\"48ea378f39ab695a\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/bundleFolderPrompts.js\":\"cb365b719ae71998\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/conversionFlowDeps.js\":\"b2ea8bf2200071a3\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/conversionFlowStore.js\":\"3cd9de234c49d43a\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/flowUi.js\":\"5fd7242578c785e2\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/conversion/useConversionRun.js\":\"214eb2f2cc5113d6\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/keyUi.js\":\"c5dc34678778bff7\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/useCloseOnKeyLoss.js\":\"e342a8f99b8b0ef6\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/useCloseOnServerE2ee.js\":\"9dfbbb7a07ef046d\",\"/knowledge-medium/pr-preview/pr-1782/src/components/workspace/workspaceUnlocked.js\":\"cabd9b8df3e5b8fe\",\"/knowledge-medium/pr-preview/pr-1782/src/context/backgroundSubtree.js\":\"3f1b11db1c0bd324\",\"/knowledge-medium/pr-preview/pr-1782/src/context/block.js\":\"a40eab68c67bff3a\",\"/knowledge-medium/pr-preview/pr-1782/src/context/layoutWsContext.js\":\"9896480e809a6660\",\"/knowledge-medium/pr-preview/pr-1782/src/context/propertyDisplay.js\":\"a0806fdee2028eaf\",\"/knowledge-medium/pr-preview/pr-1782/src/context/repo.js\":\"a191c8993741cabd\",\"/knowledge-medium/pr-preview/pr-1782/src/data/aliasClaim.js\":\"74bdd8e4ec92658a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/aliasSeatNamespace.js\":\"ecb8c4ec41ab7e0d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/blockData.js\":\"0f826aa6ec67d732\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/blockType.js\":\"ab4044276792a3c8\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/changeScope.js\":\"9651630f6b9356d2\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/codecs.js\":\"1c01a6b293ccdd19\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/derivedData.js\":\"c9d0f4b80d21be36\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/errors.js\":\"bbb28a5af545a916\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/events.js\":\"2eb0d2203afe8791\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/handle.js\":\"c4a1603e2382a1b1\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/index.js\":\"34a0c1609121da03\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/mutator.js\":\"f25cb734fc71720b\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/processor.js\":\"ecdf85b063892319\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/propertySchema.js\":\"96252300953f0758\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/query.js\":\"4c18ee89df840547\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/sameTxProcessor.js\":\"00759a2c47f5fbc2\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/schema.js\":\"c4a1603e2382a1b1\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/tx.js\":\"c4a1603e2382a1b1\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/typedBlockQuery.js\":\"14976925c77bad6e\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/user.js\":\"556a4a022b0de97c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/valuePresetCore.js\":\"53fdfdfefcd10e72\",\"/knowledge-medium/pr-preview/pr-1782/src/data/api/valuePresets.js\":\"b6ddaadff6077a78\",\"/knowledge-medium/pr-preview/pr-1782/src/data/attachmentCleanerIOVerb.js\":\"5cff7c45f2774362\",\"/knowledge-medium/pr-preview/pr-1782/src/data/block.js\":\"a7d79b58f1fe18f7\",\"/knowledge-medium/pr-preview/pr-1782/src/data/blockCache.js\":\"c4c889f59d5a547e\",\"/knowledge-medium/pr-preview/pr-1782/src/data/blockId.js\":\"3f0578a6ab0475b4\",\"/knowledge-medium/pr-preview/pr-1782/src/data/blockLiveness.js\":\"fda8575f384438b9\",\"/knowledge-medium/pr-preview/pr-1782/src/data/blockMerge.js\":\"a270cfbdd3f33da6\",\"/knowledge-medium/pr-preview/pr-1782/src/data/blockSchema.js\":\"b0acd7548151a436\",\"/knowledge-medium/pr-preview/pr-1782/src/data/blockTypes.js\":\"b96b5e6436431c0a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/clientContext.js\":\"52ed959475ece836\",\"/knowledge-medium/pr-preview/pr-1782/src/data/dbFileSiblings.js\":\"a9bf00390434cc61\",\"/knowledge-medium/pr-preview/pr-1782/src/data/definitionSeeds.js\":\"d01620203fe2a3f3\",\"/knowledge-medium/pr-preview/pr-1782/src/data/derivedIds.js\":\"79e042b1f8629ebf\",\"/knowledge-medium/pr-preview/pr-1782/src/data/drawnSubtree.js\":\"349a998632bf63ae\",\"/knowledge-medium/pr-preview/pr-1782/src/data/facetBridge.js\":\"f895f92a494c4cae\",\"/knowledge-medium/pr-preview/pr-1782/src/data/facets.js\":\"5e62de78a076c2b4\",\"/knowledge-medium/pr-preview/pr-1782/src/data/globalState.js\":\"89b20059bf4830d6\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/aliasClaimRederiveProcessor.js\":\"79a5d47e8af2b5b8\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/ancestorBatch.js\":\"5bb43201b1740ae5\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/blockTypeTypeifyProcessor.js\":\"c8b8141e19efce28\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/clientSchema.js\":\"e972269df19ed692\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/commitPipeline.js\":\"b55d49a095caa1b5\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/devAssertions.js\":\"01c47e126a6a2c78\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/firstSync.js\":\"cf87545fca75b7f8\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/freshInitialLoad.js\":\"fd8e9e051e442333\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/graphBackfillClaim.js\":\"19e836c8c7718f6b\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/handleStore.js\":\"3a9388de86586540\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/idleMarkerJobs.js\":\"0d8c7c717478bad7\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/initialDownload.js\":\"7957e663f0deb566\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/jsonCanonical.js\":\"1faf24b3d387a66d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/kernelInvalidation.js\":\"99b579a45e62c715\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/kernelProcessors.js\":\"ed9c69a4f0b17091\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/kernelQueries.js\":\"5418ccb6b69e6e8c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/mergeTypeMembershipProcessor.js\":\"e0550b6899359bfd\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/normalizeReferencesProcessor.js\":\"35c9cad7771b4175\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/poolInstrumentation.js\":\"fbab5db9b8e55c71\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/processorRunner.js\":\"16b56c809a899f58\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertyCellBackfill.js\":\"5a96366aeb88ef57\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertyChildMint.js\":\"a5ef4c05fb25ba9d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertyChildrenProcessor.js\":\"0749ee57e16b39c7\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d45dc4bc1f959f2d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertyDefinitionSynthesis.js\":\"2f2c5d49f38ccfee\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertyKeyScan.js\":\"9659b68b8fc9d2e8\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/propertySchemaResolution.js\":\"ad4c3267eea39086\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/raiseProtocol.js\":\"9d81fe0773442a6f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/readBatch.js\":\"eb4d36d6dbe1776d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/refProjection.js\":\"c9fa0db5c9a1f8fc\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/referenceTargetLookups.js\":\"9e0015bea72fcf87\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/referenceTargetProcessor.js\":\"0c5005e36a8e3ef9\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/replayMerge.js\":\"24dcd1599cf4f234\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/sqlBinds.js\":\"56af4d9d2dd535eb\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c4b60c76125eaf8b\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/syncObserver/arrivalProcessors.js\":\"65333b28c57ff767\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/syncObserver/invalidate.js\":\"181d3962e1535aec\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/syncObserver/materialize.js\":\"f23cb0a18d0b0a5f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/syncObserver/observer.js\":\"f7da23c6e1b8ea8f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/syncObserver/reconcile.js\":\"e0482f077df42d93\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/timingMetrics.js\":\"c2bd98130bcf7564\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/treeQueries.js\":\"cfe6a302be4dda63\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/txEngine.js\":\"e47675696b4da30c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/txSnapshots.js\":\"d975f4251ffa4926\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/typedBlockQuery.js\":\"f2ec2ec338dfa44f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/internals/undoManager.js\":\"014887df13d04f9f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/invalidation.js\":\"cf485678c32891a3\",\"/knowledge-medium/pr-preview/pr-1782/src/data/kernelDataExtension.js\":\"aa2ab4f24e6b9c1d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/kernelPage.js\":\"c1ac70f9d3762f0c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/kernelValuePresetCores.js\":\"10b9402fe441855c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/localDbCorruptionSignal.js\":\"bd4f56f61dd12765\",\"/knowledge-medium/pr-preview/pr-1782/src/data/localDbStorage.js\":\"53ba84dca231138f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/localDbVfs.js\":\"d9d344c02a8f0612\",\"/knowledge-medium/pr-preview/pr-1782/src/data/localSchema.js\":\"b60b4b43cf2a5fd6\",\"/knowledge-medium/pr-preview/pr-1782/src/data/maintenance.js\":\"2d8d63a5d93efb6c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/mergeProperties.js\":\"23b66bef493ce48d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/metricsConsoleHook.js\":\"1bc0cd991636cb1b\",\"/knowledge-medium/pr-preview/pr-1782/src/data/migrationsPage.js\":\"bc5c1fc39a1d70d7\",\"/knowledge-medium/pr-preview/pr-1782/src/data/mutators.js\":\"ded1ffba8864be4e\",\"/knowledge-medium/pr-preview/pr-1782/src/data/orderKey.js\":\"80543c310c9900aa\",\"/knowledge-medium/pr-preview/pr-1782/src/data/orderKeyPlacement.js\":\"f03e81e4a23cdf2a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/outlineSurface.js\":\"8196db56b9230b2e\",\"/knowledge-medium/pr-preview/pr-1782/src/data/pendingEditorContent.js\":\"523c305fedd39328\",\"/knowledge-medium/pr-preview/pr-1782/src/data/pendingUploadsSql.js\":\"412f7c5f5f4ace61\",\"/knowledge-medium/pr-preview/pr-1782/src/data/pluginStateExtensions.js\":\"d83324e70f19af0a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/powerSyncLogger.js\":\"05880753c2a9ca65\",\"/knowledge-medium/pr-preview/pr-1782/src/data/projectorRuntime.js\":\"2ae2b5687514f8d0\",\"/knowledge-medium/pr-preview/pr-1782/src/data/properties.js\":\"c3846086961717e6\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertiesPage.js\":\"250167f49249f37d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertyChildren.js\":\"90c06b778c666e3e\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertyDefinitionFanout.js\":\"a7ddea95870de622\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertyDefinitionMetadata.js\":\"860c5ea433c60051\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertyDefinitionRegistry.js\":\"c1d8cdd7c05db823\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertyDisplayMode.js\":\"8d0e1d4b71049b00\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertyRowCreation.js\":\"a979d5f4075f20e7\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertySchemaCreation.js\":\"e90f5ef8679e0ef2\",\"/knowledge-medium/pr-preview/pr-1782/src/data/propertySeeds.js\":\"f076c324ecd10fcb\",\"/knowledge-medium/pr-preview/pr-1782/src/data/recentsPage.js\":\"b4dd9ba82c770c2f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/referenceBlock.js\":\"a22c06cae929b96d\",\"/knowledge-medium/pr-preview/pr-1782/src/data/releasePowerSyncConnection.js\":\"617237c12f5ec998\",\"/knowledge-medium/pr-preview/pr-1782/src/data/repo.js\":\"749c4ee5de5a932f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/repoProvider.js\":\"23df88bdc3ae70cc\",\"/knowledge-medium/pr-preview/pr-1782/src/data/rowProperty.js\":\"93ceb5b53f2ff0fb\",\"/knowledge-medium/pr-preview/pr-1782/src/data/searchFilter.js\":\"71cb77959352f07f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/seedIdentityLedger.js\":\"a9d6c537219a53bf\",\"/knowledge-medium/pr-preview/pr-1782/src/data/stateBlocks.js\":\"31491cd2d87efa0a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/structuralEditPolicy.js\":\"c2c110f5e674a34b\",\"/knowledge-medium/pr-preview/pr-1782/src/data/subtreeDelete.js\":\"c71bf895c58b69c9\",\"/knowledge-medium/pr-preview/pr-1782/src/data/syncStreamLock.js\":\"a45e4f3b897c0eac\",\"/knowledge-medium/pr-preview/pr-1782/src/data/syncedTableSqlRecognizer.js\":\"84824d640d894bf6\",\"/knowledge-medium/pr-preview/pr-1782/src/data/syncedTableWriteGuard.js\":\"095bbd789c9d61e7\",\"/knowledge-medium/pr-preview/pr-1782/src/data/targets.js\":\"e66e782d75d0ec9e\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeColors.js\":\"03101493f1913ed0\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeDefinitionMetadata.js\":\"a8c60e9cdbda4f9f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeDefinitionRegistry.js\":\"010d2c6546fcf010\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeExtraction.js\":\"ab1b255e3b0748ee\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeInitialValues.js\":\"84db6131cc96c653\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typePropertyGroups.js\":\"1c0569093bda6d20\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeSeeds.js\":\"25505c4b2d4d6c50\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typeTagger.js\":\"2837c09f2f3e7816\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typedRecords.js\":\"51a18d7a27709446\",\"/knowledge-medium/pr-preview/pr-1782/src/data/typesPage.js\":\"5e406527b4ab209f\",\"/knowledge-medium/pr-preview/pr-1782/src/data/userPrefs.js\":\"81d24aff6175cc13\",\"/knowledge-medium/pr-preview/pr-1782/src/data/userSchemasService.js\":\"db49a284d3cf147a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/userTypesService.js\":\"c3453a21891aca39\",\"/knowledge-medium/pr-preview/pr-1782/src/data/valuePresetRegistry.js\":\"eb7dc317865df188\",\"/knowledge-medium/pr-preview/pr-1782/src/data/visibleChildren.js\":\"1df0f651b8d55560\",\"/knowledge-medium/pr-preview/pr-1782/src/data/workspaceConversion.js\":\"544ef5dfd324d314\",\"/knowledge-medium/pr-preview/pr-1782/src/data/workspaceFirstSync.js\":\"c9f67f8de6907c42\",\"/knowledge-medium/pr-preview/pr-1782/src/data/workspaceIdNamespace.js\":\"6faab74f7808b16c\",\"/knowledge-medium/pr-preview/pr-1782/src/data/workspaceSchema.js\":\"070caaa37c379938\",\"/knowledge-medium/pr-preview/pr-1782/src/data/workspaces.js\":\"c40d6bab52937057\",\"/knowledge-medium/pr-preview/pr-1782/src/data/writeAheadLog.js\":\"814f632181dfa37a\",\"/knowledge-medium/pr-preview/pr-1782/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/BlockPasteShellDecorator.js\":\"215826faa89efb67\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/atTrigger.js\":\"fb45b165083bd68d\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/autocomplete.js\":\"be1ce7a64cd61489\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/codeMirrorExtensions.js\":\"049b11115ad3fdba\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/contentFlush.js\":\"91b430c98af147d2\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/defaultInteractions.js\":\"604cd75a18ee6f5f\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/editSettleSignal.js\":\"15b5ecefcacba58a\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/insertImage.js\":\"0e23689563428405\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/referenceCompletionRange.js\":\"7dced23f80d48015\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/referenceTargetTypes.js\":\"3aac24b7c2d0430f\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/syntaxContext.js\":\"3dd94f6d7a2b8a6c\",\"/knowledge-medium/pr-preview/pr-1782/src/editor/triggerMatch.js\":\"8818231e0410f3ad\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/AppRuntimeProvider.js\":\"2cc9aa8914fb6e78\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/BlockFocusShellDecorator.js\":\"cf6f1e593bf08c19\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/ExtensionRenderBoundary.js\":\"19eab44834009df1\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/PanelContentRecovery.js\":\"de14e1925f1ad4dd\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/apiCatalog.js\":\"0ab8328f48a7d8e7\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/approveExtensionHere.js\":\"8f5d6b46e3fdb3e0\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/armedCutAppMount.js\":\"f005da874ba8c112\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/batchableKeyedStore.js\":\"3a7f037d46e05389\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/blockInteraction.js\":\"ce770623ced647e2\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/blockSelectionAction.js\":\"28e9d95e0b870913\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/compileExtensionModule.js\":\"2ecb3556c3b252c7\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/compiledModuleCache.js\":\"f96831b7b95a146b\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/continuousGestures.js\":\"e2e170f0bbdfd499\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/core.js\":\"311daafdb08f3600\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/defaultRenderers.js\":\"0f0d0546a043358d\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/definitionFanoutAppMount.js\":\"6f43295e5365fd0f\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/dialogAppMount.js\":\"01dab03ad142c771\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/dynamicExtensionSeeds.js\":\"76a2e15bb2ac57c2\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/dynamicExtensions.js\":\"668dec01fe9fb39f\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/exampleExtensions.js\":\"4a553391fc40c513\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/extensionApprovalStatus.js\":\"c515f3bdbe323477\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/extensionLoadErrorToast.js\":\"9f071f2b67a71991\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/extensionLoadErrors.js\":\"069c6ade2e30549a\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/extensionLookup.js\":\"28ed9b88750606cc\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/extensionToggles.js\":\"1a4462fb280f04dd\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/extensionUtilitiesCss.js\":\"6bec3d8aae2669b2\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/kernelPageDeletionGuard.js\":\"9566d11f1b966ce8\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/liveRuntime.js\":\"a21fd2a464797cfe\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/openExtensionsSettings.js\":\"2a26d53f861ac9e0\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/overridesCache.js\":\"4763e4fd3a053bb4\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/pluginIds.js\":\"931b325441c80404\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/processorRejectionToast.js\":\"ce81cb11a1152683\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/runtimeActions.js\":\"2ff66a93d822e382\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/runtimeContext.js\":\"8c9702a601d228af\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/staticAppExtensions.js\":\"de26c043b35df8a9\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/staticDataExtensions.js\":\"efe318e84e324a0b\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/toastAppMount.js\":\"2f913ebc5af85468\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/useOverrides.js\":\"fc46a0568de5961e\",\"/knowledge-medium/pr-preview/pr-1782/src/extensions/useShortcutSurfaceActivations.js\":\"898c0d09497013f7\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/discoverToggleTree.js\":\"7c80e7ecf33148b9\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/facet.js\":\"f3c8b288df367c86\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/resolveAppRuntime.js\":\"c79fdd09ac3fef48\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/runtimeEvents.js\":\"d361256adaaf76a2\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/togglable.js\":\"d0bc74261ab5fc27\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/variantFacet.js\":\"6aa3e22ece2a65e6\",\"/knowledge-medium/pr-preview/pr-1782/src/facets/verbFacet.js\":\"4d5e5f011a0a6a8d\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/block.js\":\"601b4404777ccb72\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/focusedChild.js\":\"97ba78dd1c6981ce\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/propertySchemas.js\":\"0d33d3bf8be10f58\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/typeRegistry.js\":\"9182c59cf5db6b07\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useAncestorCrumbs.js\":\"377f853981f442c8\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useAutocompleteListbox.js\":\"a93db2f7db047dba\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useDebouncedSearch.js\":\"a9ab72d9da2ebb44\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useDebouncedValue.js\":\"4d8ffa0dc8a86373\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useIsFocalRender.js\":\"8cdf2111a2ae3eb4\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useIsReadOnly.js\":\"291459f426a720c1\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useMaterializeBacklog.js\":\"8e19262481769145\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useMinuteClock.js\":\"2bdd257d52796049\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/usePanelLayoutProjection.js\":\"f6621e9d14a2e216\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/usePendingInvitations.js\":\"40faa6beb6dd4b56\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useRendererRegistry.js\":\"82dc9c31e1500f07\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useRetainedFieldRows.js\":\"677444a54a0e5621\",\"/knowledge-medium/pr-preview/pr-1782/src/hooks/useWorkspaces.js\":\"c9deab3a3af8c0f7\",\"/knowledge-medium/pr-preview/pr-1782/src/lib/utils.js\":\"971575dc78eb7e62\",\"/knowledge-medium/pr-preview/pr-1782/src/main.js\":\"d44bf1bd49a5e958\",\"/knowledge-medium/pr-preview/pr-1782/src/markdown/MarkdownImage.js\":\"1e46f30af535f40c\",\"/knowledge-medium/pr-preview/pr-1782/src/markdown/blockSeparators.js\":\"72d012e562ad1b1d\",\"/knowledge-medium/pr-preview/pr-1782/src/markdown/context.js\":\"8f0ab5c010a109ba\",\"/knowledge-medium/pr-preview/pr-1782/src/markdown/defaultMarkdownExtension.js\":\"ccd2c5270dd5c828\",\"/knowledge-medium/pr-preview/pr-1782/src/markdown/extensions.js\":\"aea62b33170607e2\",\"/knowledge-medium/pr-preview/pr-1782/src/markdown/renderMarkdownHtml.js\":\"b291b4ac219d616a\",\"/knowledge-medium/pr-preview/pr-1782/src/minimal-editor.js\":\"7fe2045cc3c43a1a\",\"/knowledge-medium/pr-preview/pr-1782/src/paste/armedCut.js\":\"75d5dce194a98785\",\"/knowledge-medium/pr-preview/pr-1782/src/paste/captureMediaVerb.js\":\"97bf7f0dee2c59d8\",\"/knowledge-medium/pr-preview/pr-1782/src/paste/clipboard.js\":\"5f3ab638fb3404c2\",\"/knowledge-medium/pr-preview/pr-1782/src/paste/decision.js\":\"1a7fb4b06aec24fc\",\"/knowledge-medium/pr-preview/pr-1782/src/paste/operations.js\":\"9d7a9d4ea93c20d8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/account-header/AccountHeaderItem.js\":\"9e1c09cb76678d3e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/account-header/index.js\":\"7f6eac91cfa5466b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e11dc55555dd306e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/askAgent.js\":\"fc21074cc460ceab\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/askedStore.js\":\"5824d0ab79956b20\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"77ded72da02c3c97\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/chipState.js\":\"869152ebe2273b68\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/dataExtension.js\":\"22ee4a55974d7e10\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/index.js\":\"721758a845759f5d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"aea94ce949eed94c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-dispatch-companion/schema.js\":\"a88a2de2c3957bac\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0aa641f14d909e27\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9096195b805155a7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/addMedia.js\":\"c0b12ccb1f08ff6f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/backlinks.js\":\"aa980a8b2f436db4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/block.js\":\"e645fc592cb8d36d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/context.js\":\"d240e428c94f57ab\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/displayIds.js\":\"47c56de73904e607\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/index.js\":\"3c0d39033e1e9ab8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/outline.js\":\"9a742c4740dc37cf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/properties.js\":\"c790bc83fdd478e2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/refs.js\":\"7faf224f150c8e65\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e119292ec1a98889\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/search.js\":\"3bb94a764fcd3787\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/shared.js\":\"e6a1c6c43ad340a8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9ad5f7520c7e1114\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentViews/text.js\":\"5e24e1c65deaa5a0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/agentWrites.js\":\"67f3fd8a2951b4e1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/authoringCatalog.js\":\"c691728575ea68df\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/blockRefTargets.js\":\"af4cdc3710207adc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/bridge.js\":\"788c2cd3a294ffc7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/bridgeLoop.js\":\"77a393869cd56b49\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/changeHistory.js\":\"e9b26310f53e48a4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/commands.js\":\"5a53c440beb8e1e1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/commentsCommands.js\":\"8592f06691893bd5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/dataExtension.js\":\"a7399796e0872ec5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/dataModelGuide.js\":\"1341514c5d7257e0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/describeRuntime.js\":\"461a1ab02cfef026\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/extensionLint.js\":\"4e0fdd7f218f33ff\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/grainAudit.js\":\"28e54aa5b2947e00\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/healthCommand.js\":\"ff240be9f12d2565\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/index.js\":\"8bc4febc60d131b8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/presetIdentity.js\":\"761c0214f7bc4518\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a87ee6181092936d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/readMedia.js\":\"1b078750fbfc5622\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/schema.js\":\"ba603a466a9f2473\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/serialization.js\":\"228c1d9b570144e9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/targets.js\":\"43c19246f1136a67\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/tokens.js\":\"783e77f447e97265\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/watchEvents.js\":\"2ec411fdd8e8d633\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/workspaceGuard.js\":\"7c3523160ba670f0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/agent-runtime/writeCommands.js\":\"47cfd0c7fa479561\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/AliasCollisionToast.js\":\"9b45e7cc34a10386\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/DuplicateNameBanner.js\":\"06ff7088ee65647c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/collisionMerge.js\":\"f647f5197efa3d24\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/dataExtension.js\":\"1d95448a348c6d3f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/index.js\":\"b5b13d11c8015ccd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/mergeCollisionAction.js\":\"d5973a7872c02e0c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/pageStyling.js\":\"2bba43cabef8bffd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/rejectionToast.js\":\"f2b895f5feaab4fc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/alias/syncProcessor.js\":\"95bf5d7bd4c740fb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/actions.js\":\"323b377c6f9f241e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/addComment.js\":\"7295f80b3506f137\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/anchor.js\":\"200d69637dcfa4c4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/anchorState.js\":\"78856a1b81587892\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/commentLinks.js\":\"a5a3a59e008d77d1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/confirmThreadDeletion.js\":\"ae1791af473e2eee\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/container.js\":\"89f665b22a809466\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/dataExtension.js\":\"fda37c3f063593c7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/deleteComment.js\":\"57801be24b6d101e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/highlights.js\":\"4764f7b25023928e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/index.js\":\"472621f412e98d60\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/linkedCommentsPill.js\":\"e1f59f2e5f03f23f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/margin.js\":\"dfc83ce380f26297\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/marginSchema.js\":\"26a74a9dcc342355\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/newComment.js\":\"0e0001259f0034c7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/ownThreadPicker.js\":\"60e8070e9efeaeef\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/placement.js\":\"39cfbb0ffb14e905\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/queries.js\":\"f9a3d0155be2fd44\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/quotePosition.js\":\"e6cedcd6f99c3eed\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/quotedIn.js\":\"752ee83203219d78\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/quotedRange.js\":\"744b18cf1ab1e980\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/rangeRefs.js\":\"64f5b141c6b0d40d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/readHighlights.js\":\"fddfa3b7a064e549\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/readSelection.js\":\"f0d54d2ed30be91b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/readSelectionUi.js\":\"0c56a5b4f1aeae84\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/reanchor.js\":\"50811b6e58f12848\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/schema.js\":\"5cf4c96a9e4f57b1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/scope.js\":\"742e9b5f0eb15223\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/scopeThreads.js\":\"732201bf256367fc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/splitRetarget.js\":\"c21a365e02c29e1d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/suggestionCard.js\":\"2551d57048269a1b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/suggestions.js\":\"a463f51d613b2b2d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/summaries.js\":\"b8bd4642e504e92f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/summaryBatch.js\":\"d07e37a2896a7d60\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/surface.js\":\"b211d3bd594cb4aa\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/threadNavigation.js\":\"f1f93ed77ecfbc89\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/threads.js\":\"83d0b69332581ec5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/ui.js\":\"6745c84b01dc0380\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/annotations/uiStore.js\":\"b8eaea83bcd83c87\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/app-intents/appIntents.js\":\"1525ae04f038cee9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/app-intents/index.js\":\"af214c2d2b2f4ff3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/app-update-prompt/index.js\":\"d27039c126d5b1e8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/app-update-prompt/status.js\":\"3e26f1ebb79e221b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"09aebd702d1a41ce\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/MediaBlockRenderer.js\":\"dddfe1abb846d24b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d55153410a871860\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/MediaUploadReconciler.js\":\"117b2f59fc58133d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/assetDownLane.js\":\"3bc606ff215e81fe\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/assetResolver.js\":\"7ce8b9a5fbc4fc04\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/assetUpload.js\":\"21e3de6bc710a6ac\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/attachmentCleanerIO.js\":\"f1969fed53864caf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/audit/supabaseAuditIO.js\":\"286119f571d6d3bc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/blobStore.js\":\"24fd7f76e1d88828\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/byteStore.js\":\"f7dbe199eb83bc8b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/cleanerIO.js\":\"89563c93d67ad8e1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/cleanupAttachments.js\":\"35521491dd1fce5d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/dataExtension.js\":\"35668c330ef1e2cf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/downLane.js\":\"12eb65ab46f9598a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/index.js\":\"29f1568efec16c23\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/insertImageContribution.js\":\"854c931cc89fd82b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/laneArming.js\":\"ca3066d41de07bac\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/laneLock.js\":\"c092be8024d824f6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/mediaBlock.js\":\"b57914f96159dd59\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/mediaCapture.js\":\"831cba8cac9e0746\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/mediaViewers.js\":\"4cadb15aed927591\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/mediaViewersFacet.js\":\"41efd221bbdda524\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/pasteCapture.js\":\"a4c21db77d943a24\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/resolver.js\":\"fbdbeadf56a37b9b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/retryUploadsAction.js\":\"6651f0e7a86538a2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/storagePaths.js\":\"596ab40584436ef6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/uploadDrain.js\":\"d01b1116c8a20ce5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/uploadLaneStatus.js\":\"645ae080cf064e6c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/uploadReconcile.js\":\"80afc8d470c25ff2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/uploadRecovery.js\":\"60e17e8f4d56943b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/uploadStore.js\":\"f1e532df15573f0e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/attachments/useAssetObjectUrl.js\":\"0658b2ee92d0ddb7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"627867f1da06173c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8ca9d585030878e1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks-view/facet.js\":\"07f77e2d2eb9e06b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks-view/index.js\":\"9955541b8374cabf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks-view/prop.js\":\"051f112f1e187868\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/BacklinkFilters.js\":\"3e2156f8c0d03a94\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"203d78dab82147a5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/BlockEntry.js\":\"4e21397b77d6cc9e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/LinkedReferences.js\":\"febf7201f02a6673\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8550c8a3c280caf0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/dailyNoteDefaults.js\":\"035035b8e5fcd66f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/dataExtension.js\":\"88ebb702689843d6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/edgeExclusions.js\":\"40c5c0fa973beecf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/filterProperty.js\":\"fdd35b74dd89f540\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/index.js\":\"cbd36f44e6f0f7a2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"116331e7ace1d82d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/inline-counts/applies.js\":\"27638b0e02ba5b52\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/inline-counts/countQuery.js\":\"3d4c29572c7d068a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2e6f712afd24d5da\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/inline-counts/index.js\":\"15f9db57e11c47d7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e2acc8715c6a2a6a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/presentationInvalidation.js\":\"eb3e036f8353c394\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/propertyEditorOverride.js\":\"64dc450b5c3b0ce1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/propertyFilter.js\":\"2047bc36ba7ac175\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/query.js\":\"f2521e3798c2d679\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/resolveFilter.js\":\"a997592bce780dac\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/sourceBatch.js\":\"682186c97864e7c1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/sources.js\":\"e295c6472983f19c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/useBacklinks.js\":\"e3f8810778b7c06f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ad1a8f36b77293bd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/birthday/BirthdayCelebration.js\":\"d1e6885191100de7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/birthday/BirthdayOverlay.js\":\"7ad7d26046d2c4cf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/birthday/gate.js\":\"8b6096175919d8cf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/birthday/index.js\":\"c5e9afae40df01d2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/birthday/wolfTheme.js\":\"2b14e5e753c5f3a8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-drag/BlockDragLayer.js\":\"803c03b4f9f2092b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-drag/dragController.js\":\"d26291525826fe92\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-drag/dropTarget.js\":\"2589e28321b673f4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-drag/index.js\":\"9d7462aad0fdb3a9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-drag/projection.js\":\"6423a00ffac2d156\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-info/BlockMetaCard.js\":\"8b6ce69b534502e0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-info/index.js\":\"c2399890656e68ee\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/AddTagDialog.js\":\"978d6a5f38a81b30\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f8d4cf399ed18341\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/TagNameIssueHint.js\":\"31126fd6da22bce1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/addTagAction.js\":\"deaf3bb58fa3cccc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/appendTag.js\":\"b6ee89e9385aebd0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/config.js\":\"308c5178235a3be6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/dataExtension.js\":\"ef05f8a853fd6ba0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/index.js\":\"7595edfe9397da90\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/block-tagging/propertyEditorOverride.js\":\"61710b7236975f4e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/BreadcrumbList.js\":\"af09de943e15857b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"aa85d3e1a5c78de2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e2ab8ab75c629399\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"46beef85e9daf0c3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9cc405d59ea1444d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/index.js\":\"586740c00e0e041e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"59d12b10170cfc0d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/CharacterCountItem.js\":\"a17d2806cc21a1d3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9df03704a4e0d044\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/actions.js\":\"a0c110ec8960e53a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/blockType.js\":\"0916b5ad594450d0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/charCount.js\":\"c66fda426b025a51\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/dataExtension.js\":\"8750dcf71ddb8642\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/index.js\":\"a2725b6b1ca1f17d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/profiles.js\":\"12d26146542bcfe8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/properties.js\":\"16212295e0eb9432\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/character-counter/textCounts.js\":\"a9d45e08a1cce92b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/colemak-keybindings/index.js\":\"a0bba6fca4dc74ee\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/CommandPalette.js\":\"4083754c08fb92b5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/HeaderItem.js\":\"971a12d343a64a2c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/context.js\":\"7017521be8b982e0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/index.js\":\"2e24d72ebfe87b09\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/selection.js\":\"0538eb26b425fa85\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/toggleStore.js\":\"c51757baee0bd6d8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/command-palette/useCommandPaletteActions.js\":\"5778b8f1b6d3f9dc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/ContributorBadges.js\":\"5523b40547cf4da5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/author.js\":\"f7ae818e8b196630\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/codeMirrorExtensions.js\":\"90f23b22e9ccf1c7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/dataExtension.js\":\"4e42024237ecd37c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/index.js\":\"83f4e4264f092ec4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/mentionAutocomplete.js\":\"e7d19ae86b10abd9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/processor.js\":\"29e3216aae539561\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/profiles.js\":\"5e5b28478c266e1c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/queries.js\":\"f4af132ca4f12169\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/contributors/schema.js\":\"3629ab0c857aae57\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ff15dc5a9ec0f65e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4717a44a817e2b42\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/cursor-follows-scroll/index.js\":\"8107e250b5f2d778\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"831922c744e1c25c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"78bd4bd5eceb5a5b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/CalendarGrid.js\":\"3efdad84d446bac9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/DailyNotePicker.js\":\"67007e0845edb95a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1eec7ec9b70ef017\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/DateNavDecorator.js\":\"c81171212e3e2070\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/DateScrubOverlay.js\":\"bd78c0b814280265\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/HeaderItem.js\":\"c0385b9e452aff78\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/ReschedulePicker.js\":\"b3ad2d5b49983733\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/SpreadDatesDialog.js\":\"484e62b7f0211f8f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/actions.js\":\"ae0c5d42a40b0d53\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/blockDateAdapter.js\":\"ee33a947144f07a7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/calendar.js\":\"abcdcd4e2f64910f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dailyNotes.js\":\"cbb95fda0f3742dd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dataExtension.js\":\"6300dbbd0f99cfc6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dateScrubActions.js\":\"dc8c3aa29410c95b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dateScrubGesture.js\":\"50ef8c2986d3af14\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dateScrubGestureActions.js\":\"be6006f700b345ea\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5f805c211e608015\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/deletionGuard.js\":\"55102397a980a538\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/dueQuery.js\":\"0a19ad4d2501f08e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/index.js\":\"02a74dbdc4ed9d24\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/landing.js\":\"5daed1c905806c9b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/localSchema.js\":\"71120da8c7c84182\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/referenceDateAdapter.js\":\"81b7b2e5337ddcaa\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/rescheduleAction.js\":\"5d6387018469bb4f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/schema.js\":\"7731ad63188c3750\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/spreadBlockDates.js\":\"3109bc3aa8cf13b8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/spreadDatesAction.js\":\"a32f8fd169fe7146\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/today.js\":\"6286ca6fba97d4b4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2628369bb4836a36\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4701007236f00e81\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/audit.js\":\"b613dd11f0c6c7b5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/auditAction.js\":\"536b9599d66aff7f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/auditRanges.js\":\"c2dbddd4111ab41f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/diagnosticsSource.js\":\"8b0362763f65a42c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/divergenceScan.js\":\"158cae0916330511\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/index.js\":\"3feb71ac1f668ec6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0b1f18412e69113d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/referencesMirror.js\":\"23b7200410baa3a8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/rowJson.js\":\"4c0df6e2ab3f17df\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/schedule.js\":\"3aa8f3d755073f70\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/data-integrity/store.js\":\"9de2c42cb47c6d9f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-maintenance/action.js\":\"5fd7217bc22bb361\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-maintenance/index.js\":\"b9b37434c18b6176\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-maintenance/plugin.js\":\"957761c4be07319f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2c9580f521e22e7c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/actions.js\":\"3ab6cfd78b332874\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/changeMarker.js\":\"760a32cbe55df92d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/diagnostics.js\":\"91b09b8517a5c057\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/fileSystemAccess.js\":\"ec1f8267d54cc088\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/filenames.js\":\"9a02125dad820fa9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/index.js\":\"57f294cfd857bff9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/mirror.js\":\"1f9d8100c572bead\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/runLock.js\":\"ebf76b75339d776e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/runtimeHealth.js\":\"6771a12cf0cf531a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/schedule.js\":\"1797e942a126995d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/db-mirror/store.js\":\"e14e52ce8692fc6e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/default-themes/index.js\":\"5b3205e485b7f821\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/default-themes/themes.js\":\"4321419d7b44e37c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/diagnostics/facet.js\":\"de93e731806c32d9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/diagnostics/useDiagnostics.js\":\"3f02cf3c4b14a54a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extension-prompts/dismissals.js\":\"e3c89cf9931241ef\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extension-prompts/index.js\":\"37881faa16dea74b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extension-prompts/status.js\":\"bbfbf5312aeb7d17\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extension-prompts/store.js\":\"48eed4bfb85c99c2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"31385a0f58b17bce\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c66a7caa6e8e4253\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/actions.js\":\"f770c60c40f7ee5e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/config.js\":\"1cb637d515ee593b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/dataExtension.js\":\"10e4356351444d73\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/effect.js\":\"43b6e981e36e1c9d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/index.js\":\"77102e3885b79066\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/propertyEditorOverride.js\":\"92393c1f83601411\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extensions-settings/useToggleTree.js\":\"5084c1cf8abdd076\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extract-type/ExtractTypeDialog.js\":\"82af0f07620f1555\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c23bc6613862e48d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extract-type/PropertyShapePicker.js\":\"9b75400ef4ac3075\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extract-type/action.js\":\"4fe9fd72fac0c669\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/extract-type/index.js\":\"ea19b3c42def9dcc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/FindReplaceDialog.js\":\"d13b159c16a1e4d0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/HeaderItem.js\":\"f7ba5f3d09b61c17\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/dataExtension.js\":\"7b9d32ec44265e87\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/index.js\":\"b0474fc2bcc8b8f6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/search.js\":\"4b3623c307ae91f5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/toggleStore.js\":\"b8c5ca01bf20b8a5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/LocationPropertyEditor.js\":\"62bdbe7ec46ed08b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/MapView.js\":\"89b2d5e790a316ce\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/blockTypes.js\":\"f84871f1420e9b6c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/codeMirrorExtensions.js\":\"e396afb89a7806cd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/createOrFindPlace.js\":\"5dea4342f14fae08\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/currentLocation.js\":\"fd2020cca5760d10\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/dataExtension.js\":\"a0f7b954f3d5ce6b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/geoContentDecorator.js\":\"dad7108e9f51eec6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/googlePlacesClient.js\":\"73f10c6bfeb7c43f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/index.js\":\"91846e68b4f28193\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/locationsPage.js\":\"260d0006e5983607\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/mapViewport.js\":\"072fc52994c25b69\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/pickCurrentLocation.js\":\"aa9b7cc404c8da4c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/placeAutocomplete.js\":\"3032a4b96e545412\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/placeNameCollision.js\":\"338b1cb465a0ff39\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/properties.js\":\"69a96968cd59009e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/propertyEditorOverrides.js\":\"2506dd94014986fd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/query.js\":\"8f1855fdc57c6183\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/geo/usePlaceSearch.js\":\"0723b6d0000dbf4a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"72795e1ed089e278\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"56841e126700c748\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6e33ee08171800f7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/config.js\":\"c21f0d07130b59fb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/dataExtension.js\":\"3063512e5774c61d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/facet.js\":\"1ab85883bb4ca96e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/grouping.js\":\"465b1d578a5adddb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/index.js\":\"f4a39a75bc96c2c0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"67893d55733df37d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/query.js\":\"aa018c8506f76646\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/resolveConfig.js\":\"a82ecce15220ecdc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5e4b2799ebd5d068\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"eb11d58f925626be\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/HtmlDocumentContent.js\":\"c2804548ae8cda40\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/HtmlFrame.js\":\"a893c3e1d114a24f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/actions.js\":\"7bba17c835129da0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/blockType.js\":\"3b1eb17b5306bf87\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/confirmRunScripts.js\":\"047e85834f864f8c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/dataExtension.js\":\"09223c444e9e5782\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/frameAnnotations.js\":\"6e3991462e57d078\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/frameDocument.js\":\"529e3458516bdc5b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/frameTheme.js\":\"18f4e68af9aeac7d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/index.js\":\"5ecc92fde556a56b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/scriptConsent.js\":\"3d7fd0eb921e0994\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/sourceMap.js\":\"1eee440a41542df4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/html-document/useDocumentScripts.js\":\"d677b136b499902a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/interaction-metrics/index.js\":\"ccf707f1e967ff22\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/interaction-metrics/record.js\":\"4f7efbf1bb2113c2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/interaction-metrics/recordStore.js\":\"d38006820475e238\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/interaction-metrics/responsiveness.js\":\"0f935ac8fc84fa86\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/interaction-metrics/schedule.js\":\"f177c5d926b8a7d4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/interaction-metrics/sessionContext.js\":\"a8acccc13ff6ed89\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d19f4f02fca59eca\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"52b83b95f1b52b05\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/actions.js\":\"4872726008500e63\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/config.js\":\"dba631a2b5581610\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/dataExtension.js\":\"c02267b01356d2fb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/effect.js\":\"081d4aafef783dd8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/index.js\":\"1555bad354357e31\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/keyCapture.js\":\"6efb640f83cc9201\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/overrideStore.js\":\"f9276b20315322b8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2aad1be20d37df65\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/HeaderItem.js\":\"b9fef7a008a686ca\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/LeftSidebar.js\":\"7f2baa6ae1675f85\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/actions.js\":\"a73aba81959637de\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/facet.js\":\"7c478b1fe082530c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/index.js\":\"317f42cbacf4ff62\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/shortcuts.js\":\"eff75a31b9fc5827\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/left-sidebar/toggleStore.js\":\"20f8098d7225b497\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/merge-blocks/MergePicker.js\":\"1d2742d6b3f04b09\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/merge-blocks/index.js\":\"4d99109643901d6e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/merge-blocks/mergeAction.js\":\"9cd1e7a6dba192eb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/merge-blocks/strategy.js\":\"23a6369089bc0c74\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-bottom-nav/Button.js\":\"635aabfcd1c6a05e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2e6334b38fe5896f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-bottom-nav/defaultItems.js\":\"365c7f9edbb75aca\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-bottom-nav/facet.js\":\"d89ca5eb2995ef8f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-bottom-nav/index.js\":\"fa7e602508517515\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9fd43f0c57890e56\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-keyboard-toolbar/actions.js\":\"438d62fddfe1d86a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e66e42dcefe8036d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9c670c45be76fc14\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/mobile-keyboard-toolbar/index.js\":\"a8c9450bf26313e9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2adf0e8a218f34af\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/blockSubtreeMembership.js\":\"98711d82f064e93d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/contextMenuItem.js\":\"a2a4846e0019a68f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/index.js\":\"8549c523a0c1bafc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/moveAction.js\":\"9f75d55bb3efb7e5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/moveBlocks.js\":\"a135136e43114ef9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/move-blocks/selectionAfterMove.js\":\"33af9e94acecbb3a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/TutorialBanner.js\":\"6aae7f28ae44157f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/action.js\":\"b74ed56af276b4dd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/bannerDismissal.js\":\"7c44f6d5789e177f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/documents/cheatSheet.js\":\"1b508aa20d419151\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/index.js\":\"8f3d64d70482231c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/keys.js\":\"d4cfd7002c1eda3c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/landing.js\":\"79e265da0d7ca035\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/outline.js\":\"257ec3d6afa5d9df\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/onboarding/seed.js\":\"2027f2147a0f5f44\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/PerfTrendDialog.js\":\"11460c89fb1a904e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/analyze.js\":\"4d9d95cb16c4bf3f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/diagnosticsSource.js\":\"e47961a9dfaa49e3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/index.js\":\"0aca57045500c70b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/load.js\":\"cf1683ce9bd61ee1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/monitorRun.js\":\"dafbc7419121266d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/schedule.js\":\"018c7ad976b971e7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/series.js\":\"b5f689251765fe16\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/store.js\":\"c28436113134c43f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/trendAction.js\":\"8e72603f2940eaf7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/perf-monitor/verdict.js\":\"b48f43610700c375\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/plain-outliner/clickToEditAction.js\":\"8317573a0c99c3c1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/plain-outliner/index.js\":\"ca36dcf2d3d5bedc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/plain-outliner/interactions.js\":\"26aa53102fd36d17\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5bb4a9854d919bcf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/MigrationGate.js\":\"c663315f98b85667\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/MigrationGateDialog.js\":\"f73393d8c893a176\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/action.js\":\"444065b815e7fcd6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/index.js\":\"48f805add4bda7b4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/localRunMessage.js\":\"bf054f8381ec8023\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/plugin.js\":\"47219e60bbb9226a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/progressReport.js\":\"cbe2a1ffe9d76087\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/properties-migration/sweepProgress.js\":\"dc399c9162ea841f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/FieldRowRenderer.js\":\"aa6914c51f33ae38\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/ValueRowRenderer.js\":\"387b9b4255e6f798\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/actions.js\":\"71af2c8a9c1bd7f4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/autocomplete.js\":\"2883cde1c8aab240\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/fieldRow.js\":\"c301a9baff2ec4b9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/index.js\":\"ea6957904f6fa6f7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/referenceWarning.js\":\"abd35c70759f1e35\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/valueAutocomplete.js\":\"a34fa774a17dfc7d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/property-rows/valueSchema.js\":\"21f23f85b84c377b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/HeaderItem.js\":\"8ecda198f1bf5a59\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/QuickFind.js\":\"614a46d32bf411f4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/index.js\":\"0a2d1a48d1008b65\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/recents.js\":\"6c3c5d8d3d9f6e3d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/resultItems.js\":\"f9ea01d14411401e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/selection.js\":\"c81dd4cfbddf9bb8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/quick-find/toggleStore.js\":\"84c46e1372160fcb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/recents/HeaderItem.js\":\"0dab0bcc82995f31\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7d78339feb1eafb9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/recents/grouping.js\":\"78321cb2e4c27b27\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/recents/index.js\":\"1872383dad3d96e0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/recents/target.js\":\"eabb29c58fe6e297\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/codeMirrorExtensions.js\":\"29036a2561730155\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/contentPrefill.js\":\"1d54cf1395d2cfc1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/dataExtension.js\":\"452c40177a6f5522\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/index.js\":\"c4a3dfa5c28c2d04\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"98f7e94a06ea1c1c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/invalidation.js\":\"2f73016ceb03e103\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/localSchema.js\":\"463e10473062453f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/blockrefs/index.js\":\"7ab929f4fbcb234d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"36696cf0b223f965\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/index.js\":\"92c10f1e3d3105fd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/referenceNode.js\":\"b6f047e771171906\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a9a10bcfca9e5ed8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2578ef5c843da448\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/wikilinks/index.js\":\"f83cfc3a9a792638\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"961739fb735468c2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3e7167de99d6458c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/mergeRetargetProcessor.js\":\"07125dd8b7c99c95\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/parseFence.js\":\"efaefec17dc39354\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/referenceParser.js\":\"50ed78f2da30b2d8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/referenceProjection.js\":\"4918bb1a31569c13\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/referencesProcessor.js\":\"47c24d81538e9d9e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/renameProcessor.js\":\"2e9389089d75268c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/references/spanReplacement.js\":\"7cd098da534ccffd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/rich-paste/htmlToOutline.js\":\"8a167c478688ff00\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/rich-paste/index.js\":\"ed37a0d5572f5e1f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ec28d0c7738e35d3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/rich-paste/pasteDecision.js\":\"57d581b0c207d4e7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/action.js\":\"3418ee5e906ac6b9\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/blockIds.js\":\"b83e77dd8cc6e3bf\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/content.js\":\"e00985a39cc5a9f5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/effect.js\":\"f08971d561d41d62\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/ids.js\":\"68dbfd93b18887a6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/import.js\":\"f2564fe4c5ff386e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/index.js\":\"64fb9d432a31e63b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/plan.js\":\"dfa7be6cf629d8fe\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/plugin.js\":\"9a4b732643d68206\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/promotion.js\":\"0956dda75788ddca\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/properties.js\":\"4900559ba79c5d2f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/references.js\":\"c0b70dd406ef188a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/report.js\":\"dc48b6845aac9577\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/roamMemo.js\":\"3b246e6c08e2a6c0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/runtime.js\":\"9c42dbb4dfdf335f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/schemaReconciliation.js\":\"d9c917ca8ac05266\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/srsMarkers.js\":\"ae9bde8ab0143fb3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/todo.js\":\"e733259231bdbb7a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/typeCandidates.js\":\"23d5022f45e1a463\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/roam-import/types.js\":\"0eed8deb208f1f3d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/search-health/index.js\":\"5c37eb24c8513dd4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/search-health/store.js\":\"4af04968e0090573\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/shortcut-help/HeaderItem.js\":\"e992cf97ad782d51\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6225e51d05eb19b7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/shortcut-help/index.js\":\"76b14a7864311a84\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/shortcut-help/model.js\":\"4e2ead93ed1f2cd2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/shortcut-help/toggleStore.js\":\"b57498a98705df84\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/shortcut-help/useKeyInspector.js\":\"804f89625789617b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"894fb5ff34794574\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/ShellDecorator.js\":\"0b89b3db4bdf611d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/actions.js\":\"58e2c5f0ec40b6fb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3f47a472aed6ff19\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/index.js\":\"806579bb28f54a8a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/shell.js\":\"066aae90465735f1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/surface.js\":\"e6cc84e5d7b5e2d7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/spatial-navigation/walker.js\":\"8ecb3c5811b88508\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c6afdc6924784178\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/dataExtension.js\":\"bf1652d4eb80456a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/index.js\":\"2df8e89f86046fed\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/indicator.js\":\"d44638045c6dbb0e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/moveSrsState.js\":\"78631091b9bcb277\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7b4f017911f98f79\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/scheduler.js\":\"e5c61ee468604c5a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/schema.js\":\"857cd1404104e221\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9db98558b6924fc4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/srsClipboard.js\":\"90e5dad80263e03f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f18a25df7ec6d77a\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b254079db1317c00\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/DeckPicker.js\":\"030cfe5c682cd396\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/ReviewControls.js\":\"ce3259b1969281a6\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/ReviewDeckRenderer.js\":\"28fd5e759e7ff5c7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/ReviewSession.js\":\"1666e09e7ba1fbe5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/actions.js\":\"6d383bbcaed3a76d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/archive.js\":\"6fbd6d34c34107e8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/dataExtension.js\":\"a2f835c500a8a2bc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/deck.js\":\"296886d90c4fe46d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/dueQuery.js\":\"c1216559f651b063\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/gradeDecision.js\":\"b15e086cce84e5ef\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/index.js\":\"ab890dbd9133fb4f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/keyHints.js\":\"de34833aca69cc89\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/reviewCardLayout.js\":\"9e19c9b74c3fce1f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/reviewProgress.js\":\"6567c4cf35929ed5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/schema.js\":\"e87e0e2bc60fe4b1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/srs-review/useDueCards.js\":\"4ea9cf3c5de0f8d8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/startup-metrics/index.js\":\"93af1987e072011f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/startup-metrics/record.js\":\"129a16cdbbafe61d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/storage-persistence/index.js\":\"50c0630648d412e8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/storage-persistence/persistenceStatus.js\":\"cd6fde1203a6fbe1\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/storage-persistence/requestAction.js\":\"165495e36f5b697b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/supertags/TypeChipsDecorator.js\":\"db34a98251ec0c37\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/supertags/codeMirrorExtensions.js\":\"8b18cf621dd49f93\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/supertags/index.js\":\"d286d6a5c669be14\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/supertags/typeAutocomplete.js\":\"1470cd4824e1a584\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e3716e0197579d52\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/actions.js\":\"09586426f2b93bc7\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/anchor.js\":\"26c37e9917a49927\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/events.js\":\"8f60c500eea681eb\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/gestureActions.js\":\"a1e7415e21851c18\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/index.js\":\"e18afd0da6d793d0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6da05681f0cf033b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/sync-metrics/collect.js\":\"f6ae8387cab7afa5\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/sync-metrics/index.js\":\"c6c7301ee42081c8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/sync-metrics/record.js\":\"0a6bf1c3e402595f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/RejectionDialog.js\":\"3502ba3ce12d3f43\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/SystemStatusHeaderItem.js\":\"25cbb3da8d936a1f\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/index.js\":\"f41358f7ea5087a3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/model.js\":\"e7c49dc58f21c144\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/queueCounts.js\":\"93db87567280f713\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/rejectedHelpers.js\":\"5e16386ada3374de\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/rematerializeAction.js\":\"436d23ff78fc17b2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/system-status/useHysteresis.js\":\"aea9ae7b3d73cdcc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/theme-toggle/effect.js\":\"1dc5caa0144667ee\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/theme-toggle/index.js\":\"95cbe6f284a693df\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/theme-toggle/theme.js\":\"5f461a19208229e3\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/todo/actions.js\":\"ce1843c3dbf41c04\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/todo/dataExtension.js\":\"e5ad373ba36d35bd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/todo/index.js\":\"152badf2ed23afb2\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/todo/schema.js\":\"394ff1d2d27e48fc\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a0fb4a618a03b6ec\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/touch-selection/actions.js\":\"76c71a4a9cde6621\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/touch-selection/defaultItems.js\":\"b8484b13f5a87219\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/touch-selection/facet.js\":\"581109a4208782dd\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/touch-selection/holdRecognizer.js\":\"27e335cea81cd61c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/touch-selection/index.js\":\"0ad41b97eb930d85\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/update-indicator/UpdateIndicator.js\":\"c94eb9c1a950f158\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/update-indicator/index.js\":\"f3b81f54afa96641\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/update-indicator/loadTimes.js\":\"615754636f8c4961\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/VideoNotesRenderer.js\":\"d3ffc368c8cb25c8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/VideoPlayerRenderer.js\":\"71ee0998ee1f8d9b\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/VideoTimeStamp.js\":\"7c88169a03e5c31d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/actions.js\":\"a8d59a73905d6c7c\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/index.js\":\"ca585c98665c78db\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/markdown.js\":\"e97bec6f696b25e8\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/notes.js\":\"1a8fe090cd151107\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/registry.js\":\"0ab45501c50169e0\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/remark-timestamps.js\":\"f854533cf783647d\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/video-player/view.js\":\"a035c782f50b0040\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-link-hints/LinkHints.js\":\"f542aaf21ff9446e\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-link-hints/index.js\":\"4c36259f35af5e88\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-link-hints/model.js\":\"ac3b19eb9b5c6673\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-link-hints/settings.js\":\"b80ad46b69c10aed\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-normal-mode/actions.js\":\"a1dabd2d532b1e56\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-normal-mode/index.js\":\"52985969de436bc4\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/vim-normal-mode/interactions.js\":\"bfb0d3f327020409\",\"/knowledge-medium/pr-preview/pr-1782/src/plugins/workspace-header/index.js\":\"4deb04634ba692ba\",\"/knowledge-medium/pr-preview/pr-1782/src/registerServiceWorker.js\":\"862ddbf49821d27d\",\"/knowledge-medium/pr-preview/pr-1782/src/requestPersistentStorage.js\":\"2d22b9cbcb525c53\",\"/knowledge-medium/pr-preview/pr-1782/src/services/authRequestDeadline.js\":\"4720fa66751deb62\",\"/knowledge-medium/pr-preview/pr-1782/src/services/powersync.js\":\"abed213579627880\",\"/knowledge-medium/pr-preview/pr-1782/src/services/supabase.js\":\"61edaa65ec358127\",\"/knowledge-medium/pr-preview/pr-1782/src/services/uploadErrorClassifier.js\":\"02f554f1d6bceeac\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/ActiveContexts.js\":\"5dba0d5b09d93f86\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/HotkeyReconciler.js\":\"91b39ef10a3afe03\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/WipeLocalDataDialog.js\":\"9fad72f2a9e45a4f\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/actionDispatch.js\":\"74e2a8ab0a06c766\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/actionRefItems.js\":\"8dedba4826323b12\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/applyKeybindingOverrides.js\":\"205d6bb924e7e40a\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/blockActions.js\":\"a3d7114d229263c4\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/canonicalizeChord.js\":\"7be1e04b144120c8\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/defaultContexts.js\":\"652ce77641cac2f4\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/defaultShortcuts.js\":\"105973d620b627b9\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/effectiveActions.js\":\"1d366ec4448dc985\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/gestureAction.js\":\"a0e754dc5d90e39e\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/gestureBinding.js\":\"0e888a6d8a80307f\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/holdRegistry.js\":\"4c290eded9cd695e\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/keybindingConflicts.js\":\"ac646a00b55c7421\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/keybindingOverrides.js\":\"9b35b10b602df4f6\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/pointerAction.js\":\"32a91bfca38930b8\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/resolve.js\":\"7a65b72fe212dae6\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/runAction.js\":\"16c68b0f1259c714\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/sequenceMatcher.js\":\"56eae958fc310098\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/types.js\":\"45856be2325a812f\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/useActionContext.js\":\"dd92559ced75bd42\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/useActionDiscovery.js\":\"36fdbaf9c81a3958\",\"/knowledge-medium/pr-preview/pr-1782/src/shortcuts/utils.js\":\"9fbe02456301828a\",\"/knowledge-medium/pr-preview/pr-1782/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1782/src/sw/bootStore.js\":\"12d7f59d6b4b9f99\",\"/knowledge-medium/pr-preview/pr-1782/src/sw/previewDatabases.js\":\"8b426240d4d61fb6\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/byteTransform.js\":\"e95d7ba831e06dc1\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/attachmentCleaner.js\":\"deaf0dad3d4ebcd0\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/bundle/attachmentParts.js\":\"465b64a348452c3a\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/bundle/bundleParts.js\":\"670471e1d7d4b449\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/bundle/bundleRecord.js\":\"e2b685f6e0902eb6\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/bundle/manifest.js\":\"7d970a691dfe431e\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/bundle/takeBundle.js\":\"a895475e56b53a9a\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/bundle/verifyBundle.js\":\"46b64b61b815c263\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/cleaningStage.js\":\"1ac58ef77bb2730a\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/conversionKey.js\":\"fcc09483de57e7cd\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/conversionServer.js\":\"157bccf729cb6bfb\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/flip.js\":\"7b43c502febbd98c\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/flipAttempts.js\":\"95a78985efef3502\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/pages.js\":\"011d55eab4cb59c8\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/preflight.js\":\"3ab61a5ced3a006a\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/reseal.js\":\"062796188e6b8378\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/runConversion.js\":\"af9afe8d3d0eb99e\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/runLock.js\":\"a52d83620c146f47\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/sealing.js\":\"f0da01dc3dd0bcf4\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/sealingStage.js\":\"4bc61483d1ad6af1\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/stage.js\":\"48e83368c4bc7846\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/conversion/verifyReseal.js\":\"d234d39d81c41632\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/aad.js\":\"eba7294b4503ce7c\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/aead.js\":\"bf9d53ffe9837309\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/base32.js\":\"5fe8fad825b24166\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/base64url.js\":\"54bf9ec6081ba2be\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/binaryEnvelope.js\":\"eb1e15ddeba94988\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/byteAead.js\":\"3b761e6f28950120\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/canary.js\":\"d60bad5cca9583e5\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/contentHash.js\":\"888b163aeca6ce1d\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/contentKey.js\":\"48f1177f2feb2f16\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/derivedIdNamespace.js\":\"6298dbc562da4889\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/envelope.js\":\"4bd3786a3e77b882\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/hex.js\":\"ad7e588e04592237\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/sha256Hex.js\":\"933eee2eb7bde1f2\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/crypto/workspaceKey.js\":\"7fb9c18c9c298bce\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/conversionState.js\":\"9adc40ba385eeb33\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6b0123836725ebbf\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/flows/pastedKey.js\":\"28dbb52e104afe30\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c5c798a10c2f5e4c\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a9c45b673551da19\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/keyStore.js\":\"ba4d0bbe4dee5184\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/mintWorkspaceKey.js\":\"f3c26f8fb69d46ea\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/modePin.js\":\"e97c5ec4f9022beb\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/openWorkspaceKeys.js\":\"d9627ad78885da6b\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/resolveWorkspaceEntry.js\":\"671ea57ae958eab6\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/resolver.js\":\"2664279c1f58dcba\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/keys/workspaceAccess.js\":\"eefe85c6d84622fe\",\"/knowledge-medium/pr-preview/pr-1782/src/sync/transform.js\":\"eb6bafe267d4b70e\",\"/knowledge-medium/pr-preview/pr-1782/src/themeBootDefaults.js\":\"6cf6dddc5ed8bc6e\",\"/knowledge-medium/pr-preview/pr-1782/src/types.js\":\"c0423cd4e912f4f6\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/ClientLocalSettings.js\":\"6c738772632959cb\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/abortableSleep.js\":\"66783975ef3c4179\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/array.js\":\"0b1d55cd048c0093\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/backlinkAutocomplete.js\":\"2f3563e77bd76be2\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/blockCrumbs.js\":\"6becc66c4d360586\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/blockrefAutocomplete.js\":\"b08ce287023da7cc\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/cadencedIdleJob.js\":\"c1668da88d7d6f07\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/callbackSet.js\":\"3366a27b104255cb\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/clientId.js\":\"ebbf6f9f34708d62\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/codemirror.js\":\"10c2574482995c1d\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/codemirrorCompletion.js\":\"764a267b6dd163c4\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/copy.js\":\"a0ebf35997554ffa\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/dailyPage.js\":\"9c6d18717967a443\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/dbForensics.js\":\"e10e39efe797d12f\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/dbForensicsHooks.js\":\"24616b46c8367767\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/deleteBlockThroughUi.js\":\"2e832571b5fba127\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/dialogs.js\":\"273a4789046243d4\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/dom.js\":\"ee42ce00c68114a7\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/downloadBlob.js\":\"e4c57f11ca28bf23\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/exportSqliteDb.js\":\"1713d7ab6a5d30c3\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/fileSystemAccess.js\":\"718594353d5d8a41\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/flipSlide.js\":\"5c865353dbcee337\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/fnv1a.js\":\"787ab021ca0dc86e\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/formatBytes.js\":\"29f6721f5a5b0b38\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/fuzzyRank.js\":\"8b305225535d04a4\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/idbKeyedStore.js\":\"7958275e7a60c3e8\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/idleCallbackPolyfill.js\":\"00cd1d45a2f542e7\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/keyboardAwareScroll.js\":\"447162d67b194536\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/keyboardViewport.js\":\"f11623bcb7b1dd46\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/lastWorkspace.js\":\"5ebce99717bfcb7b\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/layoutColumns.js\":\"55b072ddb010fa6d\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/layoutSessionDom.js\":\"b25c75aa37ca7ba6\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/layoutSessionId.js\":\"aa680c3b95be780a\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/linkClickGestures.js\":\"0b5464ad17e9a0d0\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/linkTargetAutocomplete.js\":\"0b532e811070ffca\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/localDbCorruption.js\":\"42479c47e6beb1d2\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/localDbRecovery.js\":\"495ba62e869800bf\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/markdownParser.js\":\"741cbe43ff7ca090\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/memoize.js\":\"a70c23e23fd44449\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/nameFieldCommit.js\":\"f07824c267106f59\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/nameList.js\":\"cc6e019b125c2c7d\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/navigation.js\":\"a0eee59383ae11d5\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/omnilinerNamespace.js\":\"d6e594a378422a5e\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/opfsPageScan.js\":\"00de1b2816377837\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/panelClearance.js\":\"1c205cccb30aa975\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/panelHistory.js\":\"7d3c5bb6471973c7\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/panelLanes.js\":\"b10c3aab5f04fa63\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/panelLayoutProjection.js\":\"be9ba0f0eb856b94\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/panelScrollAnchor.js\":\"14455693f8fdfe5d\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/panelUrlFlags.js\":\"679b3dd5bb6afd10\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/platform.js\":\"73d1a91f3f2baf23\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/pluralize.js\":\"0d751a5cf90dacd5\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/propertyCreation.js\":\"514504da45d149ab\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/propertyNavigation.js\":\"19da0b031a20c46f\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/propertyValueContext.js\":\"ee27e68320cc9c5f\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/react.js\":\"1658e2cdde54ec6e\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/relativeDate.js\":\"b802f9659833b694\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/relativeTime.js\":\"6b30244798b629bc\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/renderScope.js\":\"578157f10aae4a77\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/resolvedThenable.js\":\"44817ff0e8e8f080\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/routing.js\":\"6e4bc63dece631db\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/safeMode.js\":\"75d806f54ae722b3\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/scheduleIdle.js\":\"1dfd822c0880b47e\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/screenWakeLock.js\":\"a567737ff6fcaea0\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/selection.js\":\"f1548c8fd596a2eb\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/softKeyboardGrab.js\":\"320aee67142444b2\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/startupTimeline.js\":\"cf78649bd510bc92\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/state.js\":\"04916ac08b2aa655\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/string.js\":\"d13a469aa216a883\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/surfaceZoom.js\":\"21033d5b7f8bddb4\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/time.js\":\"7d9d44434525cc5f\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/toast.js\":\"08b0d8156583b4d2\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/toggleStore.js\":\"b92d64e075a1a172\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/untilStopped.js\":\"ef2ab2daf2cb1a5d\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/userActivity.js\":\"9c2f969e5db0d3fc\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/viewTransition.js\":\"9380896a6cae9f88\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/viewport.js\":\"5c0285d806a07ae0\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/webLock.js\":\"5a25be4f04fffb75\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/workspaceRecovery.js\":\"d1c03ca314d3010a\",\"/knowledge-medium/pr-preview/pr-1782/src/utils/workspaceSnapshotStore.js\":\"acb867352116918f\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-compiler-runtime.js\":\"d400572be2403b63\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom-client.js\":\"d29088c0793e43b0\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom-server-edge.js\":\"846d1f67a259fb64\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom-server.js\":\"a3182706c0294d80\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom-static-edge.js\":\"8101ddc3b9f450c1\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom-static.js\":\"6075c3281dc4f9ce\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom-test-utils.js\":\"c8e9e52a11364af9\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-dom.js\":\"8bb60a5b05ba7a73\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react-jsx-runtime.js\":\"3d9c3f42892dbdec\",\"/knowledge-medium/pr-preview/pr-1782/src/vendor/react.js\":\"511effdc014e9b20\",\"/knowledge-medium/pr-preview/pr-1782/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1782/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1782/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
