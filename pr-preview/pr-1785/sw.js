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
		buildId: "074891f6fc42-64c7135f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/\":\"356a2dffa50b8c9b\",\"/knowledge-medium/pr-preview/pr-1785/index.html\":\"356a2dffa50b8c9b\",\"/knowledge-medium/pr-preview/pr-1785/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1785/assets/FacadeVFS-CVO9VvLh.js\":\"a72dd069a3dcd297\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSCoopSyncVFS-QEXZOHY6.js\":\"267100346ab65de7\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSWriteAheadVFS-DyHWk-A9.js\":\"5e3b88b0d981d8e5\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-BCoQ-Mk_.js\":\"b7f21f9931401380\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-bt34Lkd4.js\":\"3a403ed695c38ed2\",\"/knowledge-medium/pr-preview/pr-1785/assets/worker-Btkd33Go.js\":\"8c8d80e5d4571ca3\",\"/knowledge-medium/pr-preview/pr-1785/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1785/chunks/app-CuTy6TeP.js\":\"f41c89446cb02c05\",\"/knowledge-medium/pr-preview/pr-1785/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1785/index.js\":\"8693483278383ed6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1785/assets/AccessHandlePoolVFS-D7noHMPx.js\":\"299fe5ae169288ea\",\"/knowledge-medium/pr-preview/pr-1785/assets/IDBBatchAtomicVFS-C6fbvlTa.js\":\"6162a432740d4178\",\"/knowledge-medium/pr-preview/pr-1785/assets/MemoryVFS-CW6xh3Gs.js\":\"9b290ce7d1e4b74a\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-DL3tp13A.js\":\"f4971c06c5acaf4f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-CLmbv2JP.js\":\"f9ecf3376b19ee8f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1785/chunks/AccessHandlePoolVFS-DvaWy8Kw.js\":\"18af2ab0fbe2768f\",\"/knowledge-medium/pr-preview/pr-1785/chunks/FacadeVFS-DKrP3hud.js\":\"298090d4fd4e22ec\",\"/knowledge-medium/pr-preview/pr-1785/chunks/IDBBatchAtomicVFS-DiagmmFX.js\":\"402775c5680c2ca5\",\"/knowledge-medium/pr-preview/pr-1785/chunks/MemoryVFS-2_BRqFe7.js\":\"18872bcd3d51e254\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSCoopSyncVFS-CCq-Rw9E.js\":\"6eca4fcd0c2f1bf3\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSWriteAheadVFS-DXv1-5eh.js\":\"490d693a81600adb\",\"/knowledge-medium/pr-preview/pr-1785/chunks/Preview-BfWd0-89.js\":\"cc580721dfb47948\",\"/knowledge-medium/pr-preview/pr-1785/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/card-DTiXXE-q.js\":\"e680b2a76546f2e7\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-mXYkOh7z.js\":\"70815e4c975f94ab\",\"/knowledge-medium/pr-preview/pr-1785/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-Dj7L1Lp9.js\":\"e75a8a898fa140b2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-async-Cg3xpB9Z.js\":\"b9df5e1c5fc8388e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-C46eiYTe.js\":\"e47eb520e47895af\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-CAQOms_O.js\":\"d659d27e3aece391\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-CtVQo9du.js\":\"6f4c9a9c3a13f307\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-CzjwHydJ.js\":\"8995f22b7f8005dc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DZSK_qUn.js\":\"85743f82b4bfdfb3\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-ZwlV5pYE.js\":\"40d2689cf12355b8\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server-legacy.browser.production-DNmyq48A.js\":\"989eabb193020f1b\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.browser.production-fDw7rIRB.js\":\"13e5bfe784b61c61\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.edge.production-BqHUjmth.js\":\"90a14e0b208c7235\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-rn_ElyNb.js\":\"4e9613fb658b633a\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-tnDBU73U.js\":\"ad6daab434b90c04\",\"/knowledge-medium/pr-preview/pr-1785/chunks/server.browser-D4kBeZ5j.js\":\"8daa9e62885f77fd\",\"/knowledge-medium/pr-preview/pr-1785/chunks/textarea-Dhq2LlhR.js\":\"5d4f36d5175c2a19\",\"/knowledge-medium/pr-preview/pr-1785/chunks/ui-DLbZLZoH.js\":\"c757c11e603a033c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-async-QL25ThzH.js\":\"32841ee9e9a4e632\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-fcvHB7So.js\":\"f2776e1b3c1db722\",\"/knowledge-medium/pr-preview/pr-1785/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1785/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/src/App.js\":\"46eae622514ae737\",\"/knowledge-medium/pr-preview/pr-1785/src/appUpdate.js\":\"cb103986f18e8cf0\",\"/knowledge-medium/pr-preview/pr-1785/src/appVersion.js\":\"363bf9563115697f\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/initialLayout.js\":\"1bed26496a65d7cf\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/resolveWorkspace.js\":\"fc76a1ac8aa3d047\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/workspaceBootstrap.js\":\"677f9bf4a03e7e40\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockComponent.js\":\"bf6d9b0a40d6b3db\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockCrumbs.js\":\"bfabb0f82183395a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockEditor.js\":\"a97a62b30266f262\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockLoadingPlaceholder.js\":\"bda71ee9c766b90c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockProperties.js\":\"3239e8c808b0ca50\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockSearchPicker.js\":\"fffa1d4232ed8ca6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ConfirmBulkDeleteDialog.js\":\"ff0ae4a247426766\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DividerHandle.js\":\"33da6ff9a0d8db09\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DraftEditor.js\":\"43c65f591c355994\",\"/knowledge-medium/pr-preview/pr-1785/src/components/GutterPill.js\":\"cac077ebe7233ddc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Header.js\":\"54dea1d62482cc53\",\"/knowledge-medium/pr-preview/pr-1785/src/components/LazyBlockComponent.js\":\"b4e39b6d9efbddc1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Login.js\":\"384e737385385206\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ZoomableSurface.js\":\"e004293c12a675ed\",\"/knowledge-medium/pr-preview/pr-1785/src/components/editModeKeepalive.js\":\"4757f378b539be98\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5f2457e6dd05c1c1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ff83cb72351e8c1d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefPropertyEditor.js\":\"aab4b8a75d712522\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefTargetTypePicker.js\":\"a093cc4b3b7a7d89\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/SelectPropertyEditor.js\":\"a936d5ecabc72303\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/TypesPropertyEditor.js\":\"f31722a6a805ae3c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/defaults.js\":\"6afeea150d05089d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/kernelValuePresets.js\":\"26ac89517c31a107\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/selectablePresets.js\":\"86df094fee0c60b7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/typesPropertyUi.js\":\"2cbfb2eec52cf86d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/AddPropertyForm.js\":\"3d2a64add1545098\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyPicker.js\":\"fe03839bcfab1f72\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyRow.js\":\"f2a786f16a39f415\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/Rows.js\":\"9f518b1c874926b0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/actions.js\":\"a8d7533d031d8465\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/declarationOnly.js\":\"36c56139bc4fd502\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/layout.js\":\"3cd72b5916b5146c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/model.js\":\"3054bd6bde04d1b3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapeUi.js\":\"84a71d37873134e8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapes.js\":\"44c399c8b4d74a18\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0025828901368402\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/visibility.js\":\"513673fbdf7fcb90\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanelSections.js\":\"e772a02092d2aad5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockEmbed.js\":\"0732b2a70c9ac861\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockLink.js\":\"e85a4921ece6b343\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockRef.js\":\"75a7a48d88ae6cbc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/ReferenceLink.js\":\"dca3e299e5f3f51f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuard.js\":\"28a4877ae85df50d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuardContext.js\":\"9fa3d9922b675821\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/linkInteraction.js\":\"3e5dd7f7c404e500\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/referenceLayout.js\":\"7e3a5adc0af848dd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/useBlockRefAncestors.js\":\"ff4605a731893d5a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockGutter.js\":\"05e9c71e98d621e2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockInfoDialog.js\":\"90db0a8f3c2c83f9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockTypeBlockRenderer.js\":\"3338040bc82aa034\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BulletHoverCard.js\":\"46dbbafc56a617be\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorContentRenderer.js\":\"7cef2e2b02ccfa03\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ca1f57ad66c05af5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ColumnResizeHandles.js\":\"7d2f842b4ffa3a4d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ca599e13db159343\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/DefaultBlockRenderer.js\":\"cccb618cdbf1f172\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/LayoutRenderer.js\":\"d5b99f92b59138cd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MarkdownContentRenderer.js\":\"0eb6c9172f5e5eb2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MissingDataRenderer.js\":\"26bbb582a0efd770\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PanelRenderer.js\":\"95c580f74e1c6cf2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f5c186e11eb98e7a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/TopLevelRenderer.js\":\"18ae45ba00c156bf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockGutterMode.js\":\"96e9dd73853a25d3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockTitleText.js\":\"f3e374e409c07784\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/fieldCreationKeydown.js\":\"f56222199debba67\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/layoutRootContext.js\":\"6548a3f23c460bca\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/TypeChip.js\":\"19640cc43c717405\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/chipStyle.js\":\"b0f3a40eb7b43178\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/anchored-floating.js\":\"827bf7cf366eb48d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/button.js\":\"1e0e4a3dbd9eb932\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/card.js\":\"81af220e227111bf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/checkbox.js\":\"6765dfbd60351dd8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/collapsible.js\":\"718f60a1514035c6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/command.js\":\"1128e6b82adf183f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/context-menu.js\":\"b67804b43a032094\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dialog.js\":\"7d5ea800c28af58b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dropdown-menu.js\":\"abb7585e8cb03e2e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/floating-listbox.js\":\"5d7e250a6f11ab59\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/index.js\":\"b288a7563c930481\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/input.js\":\"78638ba97e4a891b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/kbd.js\":\"0aa3c6c673a011c9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/label.js\":\"776f235e2d07ece0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/textarea.js\":\"ef6c3b9e183ed27c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/useEditModeYieldKeepalive.js\":\"3ee8d08c851df99b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/BootFallback.js\":\"b0e15dd1fe2597af\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/FocusedRowLazyMount.js\":\"7811bfc302756e9b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LazyViewportMount.js\":\"2a6b0593c36decb3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LocalDbCorruptionFallback.js\":\"a72bc226fe7622ba\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/error.js\":\"38ea273b8f9d4967\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/lazyMountRegistry.js\":\"69ec6b31a1910c5d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/suspense.js\":\"e5c57e3d6ed818a3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/CreateWorkspaceDialog.js\":\"9c535767fbdd458b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/PendingInvitations.js\":\"1b8bb19ae1f9290e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/SyncProgress.js\":\"cc6d5977312f6f4f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/UnlockProgress.js\":\"1f547981f2393e17\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceKeyGate.js\":\"abe0e0a99b4cd1a3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSettingsDialog.js\":\"a97ccf7a857b10a3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSwitcher.js\":\"1e088e2c8d90dbab\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSyncGate.js\":\"d81ca3ddf2a43c8f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlow.js\":\"1028a8d55edc9dbf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlowHost.js\":\"c891836675df6069\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/EncryptionSection.js\":\"e962a6f22ad04ad2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/attachmentPrompts.js\":\"32f570e9230acd9c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fee91e604ba4f859\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowDeps.js\":\"61c7ae9430e9cf64\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowStore.js\":\"ff92907a7c3b4bd3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/flowUi.js\":\"5fdae2ff15c5daf2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/useConversionRun.js\":\"ec23b0a5860aee4e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/keyUi.js\":\"239d6f834f5ebd19\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnKeyLoss.js\":\"dafcee23fbac3584\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnServerE2ee.js\":\"fab40c388f251e87\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/workspaceUnlocked.js\":\"93129ca292ae6079\",\"/knowledge-medium/pr-preview/pr-1785/src/context/backgroundSubtree.js\":\"267fe2657ae2f972\",\"/knowledge-medium/pr-preview/pr-1785/src/context/block.js\":\"1ec6355be5077877\",\"/knowledge-medium/pr-preview/pr-1785/src/context/layoutWsContext.js\":\"6394d132a2aebb3c\",\"/knowledge-medium/pr-preview/pr-1785/src/context/propertyDisplay.js\":\"eb8c65ed0d895a42\",\"/knowledge-medium/pr-preview/pr-1785/src/context/repo.js\":\"86323a39124717a0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasClaim.js\":\"ea9a7e6f1772623b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasSeatNamespace.js\":\"b865921eefb12525\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockData.js\":\"285de4979db969b1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockType.js\":\"33689982f209d9d2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/changeScope.js\":\"dc11924a3bca2af9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/codecs.js\":\"6a6a42f04830fd20\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/derivedData.js\":\"0b31797bb52a7160\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/errors.js\":\"19b588e9c6121e12\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/events.js\":\"296e6311a10b635d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/handle.js\":\"b4f33e80093692ac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/index.js\":\"01612729ba4b641d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/mutator.js\":\"9b7d69225d77412c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/processor.js\":\"9f2cd8172a8cf95e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/propertySchema.js\":\"49c32c408b489881\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/query.js\":\"8d397ed8a9db1bee\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/sameTxProcessor.js\":\"d7ec339e6bedc646\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/schema.js\":\"b4f33e80093692ac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/tx.js\":\"b4f33e80093692ac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/typedBlockQuery.js\":\"920388298b593cef\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/user.js\":\"6270e9821608c31a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresetCore.js\":\"11ed3d390e500dd3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresets.js\":\"2a6cd278a7b0ed48\",\"/knowledge-medium/pr-preview/pr-1785/src/data/attachmentCleanerIOVerb.js\":\"ca262771c4dadf1d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/block.js\":\"de02b51fe5d1b13e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockCache.js\":\"3d57eaa693cf9b8c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockId.js\":\"0dd48aba2f860f5a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockLiveness.js\":\"0826fe29727a61d8\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockMerge.js\":\"b025f1965e0586ea\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockSchema.js\":\"8077bccad5f737fc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockTypes.js\":\"b8260828bdcc2ba0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/clientContext.js\":\"fcf6dffbc3bcf5f9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/dbFileSiblings.js\":\"de494bfbd6d3fb27\",\"/knowledge-medium/pr-preview/pr-1785/src/data/definitionSeeds.js\":\"856ce9d1b0261a21\",\"/knowledge-medium/pr-preview/pr-1785/src/data/derivedIds.js\":\"6b49f4c8c643ed3b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/drawnSubtree.js\":\"ef66b5c067e2052f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facetBridge.js\":\"15fdf72217adf026\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facets.js\":\"32915c3c4f2f6e2e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/globalState.js\":\"f68c7c816490a5d4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/aliasClaimRederiveProcessor.js\":\"37417db76d82a981\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/ancestorBatch.js\":\"80db393d535426ed\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/blockTypeTypeifyProcessor.js\":\"2d9f4ad825ced105\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/clientSchema.js\":\"3506204e60a9ecdc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/commitPipeline.js\":\"a238a7923db9d4bf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/devAssertions.js\":\"2785144bfd76eb2a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/firstSync.js\":\"f11c334001be90a4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/freshInitialLoad.js\":\"cf7453904db34beb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/graphBackfillClaim.js\":\"66332aed1e587f03\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/handleStore.js\":\"80f00005a7681bb9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/idleMarkerJobs.js\":\"2e0e52a0a547adec\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/initialDownload.js\":\"648e09730b931244\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/jsonCanonical.js\":\"3311c6a100ab411c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelInvalidation.js\":\"24f170ac220c0775\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelProcessors.js\":\"38c48e149268601b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelQueries.js\":\"02023a27a2e28124\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/mergeTypeMembershipProcessor.js\":\"4445057d0c253850\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/normalizeReferencesProcessor.js\":\"513811c815453e96\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/poolInstrumentation.js\":\"3a22af5202e1693f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/processorRunner.js\":\"dd72a71bacae0025\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyCellBackfill.js\":\"725dcf9ab1b39088\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildMint.js\":\"b942f33057a3809e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildrenProcessor.js\":\"a99494bf59fbcb8c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a7414f4bb6836969\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionSynthesis.js\":\"cade0cf782ac3d44\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyKeyScan.js\":\"7794abc5ad7815e7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertySchemaResolution.js\":\"e3d33c0cc8932f08\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/raiseProtocol.js\":\"7fa319079a765f62\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/readBatch.js\":\"c8c080e99fe358f8\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/refProjection.js\":\"2b3af425cfb5fcf7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetLookups.js\":\"f4fb3061bd605022\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetProcessor.js\":\"a575821b014fe747\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/replayMerge.js\":\"cd1d38ff2f7da59c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/sqlBinds.js\":\"569905bbdd6e6e44\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5773c7bd8f88da3c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/arrivalProcessors.js\":\"101e6da22adae324\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/invalidate.js\":\"e53db7fabf1f8193\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/materialize.js\":\"dadaf64ae568afd3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/observer.js\":\"a8829c9b90ca023f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/reconcile.js\":\"f502e50779a0e025\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/timingMetrics.js\":\"ee44d8101b66af20\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/treeQueries.js\":\"3133b22098fbe55d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txEngine.js\":\"6e461946dbb2c806\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txSnapshots.js\":\"1e310c4b9403571a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/typedBlockQuery.js\":\"faafb5400901af06\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/undoManager.js\":\"622644a1eb9c4c75\",\"/knowledge-medium/pr-preview/pr-1785/src/data/invalidation.js\":\"3abd6d5100cc7856\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelDataExtension.js\":\"bfa5626d8c28e6af\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelPage.js\":\"b8abf63a1bd64031\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelValuePresetCores.js\":\"dd78b19b0603b0d8\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbCorruptionSignal.js\":\"eb7fbc1381c5be52\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbStorage.js\":\"df0b2a8a1739c13e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbVfs.js\":\"e32617cd7b78965c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localSchema.js\":\"46cd38a00b75ae51\",\"/knowledge-medium/pr-preview/pr-1785/src/data/maintenance.js\":\"bfff10a34000b664\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mergeProperties.js\":\"3699ad65880659e5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/metricsConsoleHook.js\":\"41e52d42b103d1d9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/migrationsPage.js\":\"d6282b14a0580a2c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mutators.js\":\"4033f678de817e9d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKey.js\":\"d89e28c0925c5f46\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKeyPlacement.js\":\"354319ea2965012c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/outlineSurface.js\":\"b4f6855571e8b2a3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingEditorContent.js\":\"32dae7564d913812\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingUploadsSql.js\":\"6dc43cd674628572\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pluginStateExtensions.js\":\"530ea2c3a0a058e3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/powerSyncLogger.js\":\"83a193f2c3f92aac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/projectorRuntime.js\":\"1cb3ee6e1fd1d4ce\",\"/knowledge-medium/pr-preview/pr-1785/src/data/properties.js\":\"046d865d1c36a032\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertiesPage.js\":\"56af5a70b75e6ade\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyChildren.js\":\"8a5d7eeb9b12429e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionFanout.js\":\"dd0b1146414f61f7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionMetadata.js\":\"a14d016de7e1a0d2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionRegistry.js\":\"83cea72a3d4ab4fc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDisplayMode.js\":\"e0eb4ca5efe3f723\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyRowCreation.js\":\"ed34c3c482d74d1a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySchemaCreation.js\":\"b8c18a78ba02154f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySeeds.js\":\"59615abb3fb08616\",\"/knowledge-medium/pr-preview/pr-1785/src/data/recentsPage.js\":\"9472893f7b768c20\",\"/knowledge-medium/pr-preview/pr-1785/src/data/referenceBlock.js\":\"616f0359f5ec893c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/releasePowerSyncConnection.js\":\"aaf0d1b3175ff5cb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repo.js\":\"3d915afdac17fb61\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repoProvider.js\":\"7bde9cec8a593b7a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/rowProperty.js\":\"949c380e05882149\",\"/knowledge-medium/pr-preview/pr-1785/src/data/searchFilter.js\":\"c9267fb0b54167e3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/seedIdentityLedger.js\":\"24a77bb7c4cf159b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/stateBlocks.js\":\"40c05452fca45274\",\"/knowledge-medium/pr-preview/pr-1785/src/data/structuralEditPolicy.js\":\"7ad0cf0a1b24afc3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/subtreeDelete.js\":\"bed7ff2b5430eb65\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncStreamLock.js\":\"c7c835a032e85c47\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableSqlRecognizer.js\":\"69410bd5a66ace80\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableWriteGuard.js\":\"742f757f8fa5ab13\",\"/knowledge-medium/pr-preview/pr-1785/src/data/targets.js\":\"8c33ca5f6fe33e38\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeColors.js\":\"c8c819923cf95b1b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionMetadata.js\":\"7475eb0b3e94ab2d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionRegistry.js\":\"ceba1ab78b85f03f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeExtraction.js\":\"72896e6a8e946478\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeInitialValues.js\":\"be8363e0ce8dc037\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typePropertyGroups.js\":\"1d7d4679042f7abc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeSeeds.js\":\"fc79d7202e72d026\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeTagger.js\":\"77bc67acedf6836a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typedRecords.js\":\"46cbc7f3270875ab\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typesPage.js\":\"1f92f7deed0cc07f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userPrefs.js\":\"f4c7d13114307be1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userSchemasService.js\":\"16c5b6063b16085c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userTypesService.js\":\"345f3451c3adcdac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/valuePresetRegistry.js\":\"16e8e60d59fc1362\",\"/knowledge-medium/pr-preview/pr-1785/src/data/visibleChildren.js\":\"9c2dff64fd2231ab\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceConversion.js\":\"dd8585a1372495b9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceFirstSync.js\":\"8b1e4d1be6a91d73\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceIdNamespace.js\":\"0e211a552e6c33f3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceSchema.js\":\"07f3b006be3fd9df\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaces.js\":\"7a99cb2b85100597\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadLog.js\":\"5038f804d241fe0b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/BlockPasteShellDecorator.js\":\"185eb0990456b9ac\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/atTrigger.js\":\"73da396392794cbb\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/autocomplete.js\":\"38cf8bd694e8563a\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/codeMirrorExtensions.js\":\"6bf9acea555d8c63\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/contentFlush.js\":\"592832d6489e4c4b\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/defaultInteractions.js\":\"f025d1a1fcb8f2a4\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/editSettleSignal.js\":\"6b5ec17b58fbcddf\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/insertImage.js\":\"88b01958cd73fcef\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceCompletionRange.js\":\"c8e2f6f43b5ad9a8\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceTargetTypes.js\":\"96dc119c1922200b\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/syntaxContext.js\":\"7a2dc461d1776c68\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/triggerMatch.js\":\"887fc7ca69a63063\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/AppRuntimeProvider.js\":\"9e7e2b3503183a81\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/BlockFocusShellDecorator.js\":\"7859646a3c9571fd\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/ExtensionRenderBoundary.js\":\"1ad4db9b5a4636d6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/PanelContentRecovery.js\":\"d3a7456672be097e\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/apiCatalog.js\":\"de7c4f6c89563e9c\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/approveExtensionHere.js\":\"deedb50359d6c1ef\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/armedCutAppMount.js\":\"584137feaf417f83\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/batchableKeyedStore.js\":\"59594c28b9fdf120\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockInteraction.js\":\"f89569c0ef121bc8\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockSelectionAction.js\":\"d3e382cda674fbcf\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compileExtensionModule.js\":\"55d22ff1dae165ab\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compiledModuleCache.js\":\"db46aa9c6b8426eb\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/continuousGestures.js\":\"62e663e18a210d74\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/core.js\":\"70dfa56d3696afce\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/defaultRenderers.js\":\"f6d0966957491490\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/definitionFanoutAppMount.js\":\"2dfd1e7bac2c05cd\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dialogAppMount.js\":\"efb85b78580d5c41\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensionSeeds.js\":\"eec80dbfe72702a4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensions.js\":\"20d84ab9209a855d\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/exampleExtensions.js\":\"f8cc014e9fdf6558\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionApprovalStatus.js\":\"832e781227d8b3b0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrorToast.js\":\"2c8e4a4ed7793349\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrors.js\":\"1b71a2fcbfc6d468\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLookup.js\":\"4fb250bf0ae82072\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionToggles.js\":\"7e1bf686aed93fb1\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionUtilitiesCss.js\":\"0da38a335c3e9896\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/kernelPageDeletionGuard.js\":\"64bfc2b7e05331e4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/liveRuntime.js\":\"669d5654476616c0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/openExtensionsSettings.js\":\"7e2615fa4fe34c4b\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/overridesCache.js\":\"a74c55c31288a620\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/pluginIds.js\":\"5c3b0e9a52b2ef32\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/processorRejectionToast.js\":\"a5380cb983c28b30\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeActions.js\":\"846841df7defb49f\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeContext.js\":\"0b3d001dc89054ed\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticAppExtensions.js\":\"2bde02caf5c40c88\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticDataExtensions.js\":\"bec8e82092124454\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/toastAppMount.js\":\"3a3348809112b553\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useOverrides.js\":\"57c7d0d1bb8975a5\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useShortcutSurfaceActivations.js\":\"46b215672138dbe7\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/discoverToggleTree.js\":\"95265ff996e7b6f1\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/facet.js\":\"77f85f13d7971397\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/resolveAppRuntime.js\":\"fc8d4b821499e98f\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/runtimeEvents.js\":\"25f398693dd8f867\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/togglable.js\":\"18323000aabb5bc3\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/variantFacet.js\":\"c1397ef666653734\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/verbFacet.js\":\"a5924183dcc8b263\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/block.js\":\"bfb48abb5a63db58\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/focusedChild.js\":\"50670f49eff07198\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/propertySchemas.js\":\"f44833f9eab347c5\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/typeRegistry.js\":\"30757449e3c0bfc9\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAncestorCrumbs.js\":\"11261fbc3114015b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAutocompleteListbox.js\":\"ed8a4bdb33a5428d\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedSearch.js\":\"cca3bf7434efbc86\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedValue.js\":\"ab84a31a278352a4\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsFocalRender.js\":\"c0908d10d1cf84ec\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsReadOnly.js\":\"e2e7f41ec7d19e89\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMaterializeBacklog.js\":\"7809a552c0981890\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMinuteClock.js\":\"785797ef47cbd7ca\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePanelLayoutProjection.js\":\"d6b20dd175688fab\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePendingInvitations.js\":\"c1408ad1549a8ec7\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRendererRegistry.js\":\"16d850239a0f3544\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRetainedFieldRows.js\":\"0f67105586b3beef\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useWorkspaces.js\":\"687bff7ff9fc6bbb\",\"/knowledge-medium/pr-preview/pr-1785/src/lib/utils.js\":\"86dad119363693fa\",\"/knowledge-medium/pr-preview/pr-1785/src/main.js\":\"947d866f66387a8d\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/MarkdownImage.js\":\"265b91c4f9ac116e\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/blockSeparators.js\":\"b4767b07bc96789a\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/context.js\":\"6d801d5eedf2be50\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/defaultMarkdownExtension.js\":\"d87433f2ae324a83\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/extensions.js\":\"4a26cdc1c61cdce8\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/renderMarkdownHtml.js\":\"a516a4606848cbfe\",\"/knowledge-medium/pr-preview/pr-1785/src/minimal-editor.js\":\"47806d6185f195bd\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/armedCut.js\":\"65b9a0effa95c667\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/captureMediaVerb.js\":\"220ee3f54a8c7221\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/clipboard.js\":\"f443c7bb9025b0b9\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/decision.js\":\"de58576b9f0efb75\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/operations.js\":\"adc828eeedf963de\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/AccountHeaderItem.js\":\"630162ce11b84350\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/index.js\":\"2eeedc5557fe9c89\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b8e3fcd0afbfa56a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askAgent.js\":\"a22080e1843ce84e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askedStore.js\":\"b53be5a0da2e28de\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6b78e314da0d01ac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/chipState.js\":\"e5b8f527868cf583\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/dataExtension.js\":\"97760d613eeae324\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/index.js\":\"fa754f8b27cf5781\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e24ebc43145c0a97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/schema.js\":\"aa2875997a3b98c6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7eb4aaf1fe215377\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/BridgePairingDialog.js\":\"16cd31ca8ab47bda\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/addMedia.js\":\"c56ec6042f56afa4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8f8c2d45b61c19e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/block.js\":\"17916139d9da3112\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/context.js\":\"4e778b930bd7f9b6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c2819fa8781412d8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/index.js\":\"9f0edf781aaf7d5f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/outline.js\":\"331788a563f5fcb5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/properties.js\":\"3f8e4be2889faaf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/refs.js\":\"4aee488bbc1a981d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2f051f522bdd8457\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/search.js\":\"27227ee97ab256c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/shared.js\":\"7cbd17f4c3c84b2e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7dd3cc69f21c2e18\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/text.js\":\"0390ec8b69ed3220\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentWrites.js\":\"0925749ca92e9765\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/authoringCatalog.js\":\"65889713f691fe89\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/blockRefTargets.js\":\"4f86e5ed3759714f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridge.js\":\"dfdc45b31d7724b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridgeLoop.js\":\"dff5fc346819e413\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/changeHistory.js\":\"181bebff87654c7e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commands.js\":\"4fe363e05971f64e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commentsCommands.js\":\"a08bac8ddebf1378\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataExtension.js\":\"497c8796e5424664\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataModelGuide.js\":\"84d4968c6dea079c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/describeRuntime.js\":\"e0cab8ea743dfb82\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/extensionLint.js\":\"10cc7bc64e6985ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/grainAudit.js\":\"65bfd71c13759cce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/healthCommand.js\":\"ec72a74b3c717cf2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/index.js\":\"b7c36d6c1c8ecf8e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/presetIdentity.js\":\"0c3affb3c15fe069\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4e0b4e696503ac93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/readMedia.js\":\"fe03fed6ad57f2dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/schema.js\":\"856c3126e7c4ba01\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/serialization.js\":\"6c8669e999b24156\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/targets.js\":\"047241ba8c873113\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/tokens.js\":\"e3ea3f18cb52a5c1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/watchEvents.js\":\"60919006174c2ed0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/workspaceGuard.js\":\"eeea2368d4551346\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/writeCommands.js\":\"e871b224f6dec752\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/AliasCollisionToast.js\":\"5defc6056eeb9f71\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/DuplicateNameBanner.js\":\"d3c50e75cc8e5f79\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/collisionMerge.js\":\"419055be75b8f039\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/dataExtension.js\":\"13d70f411c60ca53\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/index.js\":\"cab4ea65350de0b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/mergeCollisionAction.js\":\"1e33494741846a11\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/pageStyling.js\":\"9f97aae8a8dcf71f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/rejectionToast.js\":\"b835c75d8e28153f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/syncProcessor.js\":\"3e7fe064ba62a9bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/actions.js\":\"244cde67ddd59e32\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/addComment.js\":\"107e2510dd267914\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchor.js\":\"31e991d653e9336e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchorState.js\":\"f4dc95d1a441fd32\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/commentLinks.js\":\"e2650299ed1f8d1b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/confirmThreadDeletion.js\":\"6e0c8007d58fbe0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/container.js\":\"0b46efca0ed8a394\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/dataExtension.js\":\"94950011989f68be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/deleteComment.js\":\"02becc59186f71f0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/highlights.js\":\"38572b2196c91878\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/index.js\":\"c74f7ab8efc1e077\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/linkedCommentsPill.js\":\"46c601a7ce7b905c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/margin.js\":\"fda1c893ca802f7c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/marginSchema.js\":\"fd5958a9e0c0d88f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/newComment.js\":\"7d6186a4cbd1fbee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ownThreadPicker.js\":\"f9bc168c424926a2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/placement.js\":\"f804dab342208066\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/queries.js\":\"1581b8fa882e3970\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotePosition.js\":\"337924f517b3db0a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedIn.js\":\"fd05e8ad32048507\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedRange.js\":\"de50ec2f55bf7679\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/rangeRefs.js\":\"86c029c9511ed659\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readHighlights.js\":\"5ad0705652d136a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelection.js\":\"bc6d786ed67f5f99\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelectionUi.js\":\"3646f157107acb7e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/reanchor.js\":\"c1988ef8bdbd844c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/schema.js\":\"f2a1ad9b05e62a68\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scope.js\":\"e9999b36c2d5a974\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scopeThreads.js\":\"ac57c4e39bb8d970\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/splitRetarget.js\":\"a7c16841a8c82b80\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestionCard.js\":\"14bacaf24a766447\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestions.js\":\"25a0a7d3a62b1410\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaries.js\":\"9f8226e9d8a270cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaryBatch.js\":\"02e0bde27e7f486d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/surface.js\":\"899cab1f7677eb9f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threadNavigation.js\":\"632dc94583719d69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threads.js\":\"b5e29ba36ee340dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ui.js\":\"81d05da16fef274a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/uiStore.js\":\"995e43969686bc72\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/appIntents.js\":\"b104ed3a630b1b8e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/index.js\":\"3bafd5e7e317c861\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/index.js\":\"6b33418156b3273b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/status.js\":\"a6d9ec5f46ed36c2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"56ab5db728a83464\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaBlockRenderer.js\":\"9374edca347abf31\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaDownLaneReplicator.js\":\"54a2084d8729fb9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaUploadReconciler.js\":\"c31a08ae1f1beef5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetDownLane.js\":\"a441a0bc78f6acbe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetResolver.js\":\"3882787802f6ccff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetUpload.js\":\"2b81c56e263a858f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/attachmentCleanerIO.js\":\"890cdc324a133242\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1d9ae50afd11ee6c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/blobStore.js\":\"8d80744387b10211\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/byteStore.js\":\"e5a995a057631d2a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanerIO.js\":\"e29c9383c3069213\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanupAttachments.js\":\"d47089a554e367c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/dataExtension.js\":\"0718bde6301510ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/downLane.js\":\"44a48eeac7955b9b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/index.js\":\"b9d0d2ac67ddb2c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/insertImageContribution.js\":\"1783cbeeedc794b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneArming.js\":\"d629ce11ebbdadd4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneLock.js\":\"6f3549e6b59d86f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaBlock.js\":\"50187d2d6f8e7fb6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaCapture.js\":\"4eb51eac41b521f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewers.js\":\"a60f0c82ce9da692\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewersFacet.js\":\"96ac9566a280cc07\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/pasteCapture.js\":\"e8e6fa5b2950897c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/resolver.js\":\"b1c0680711b43b2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/retryUploadsAction.js\":\"3250d10577ec38a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/storagePaths.js\":\"a2cd6485e6f11c54\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadDrain.js\":\"eca97320a40e19ce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadLaneStatus.js\":\"e6e3e9c6f335d9b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadReconcile.js\":\"a6c1b9d4dcc0ec2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadRecovery.js\":\"cfdaf646fba1e6ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadStore.js\":\"1a2da4288e8e9cb2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/useAssetObjectUrl.js\":\"5e1962eceeaa641e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ee627f83f8d46881\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksViewSection.js\":\"42fa8b4656e03613\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/facet.js\":\"497077a5a27a4b88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/index.js\":\"36dba7e7da88a7ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/prop.js\":\"694ba491eaeea538\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinkFilters.js\":\"b9008ceae7a101f4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cefe8138e260c2cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BlockEntry.js\":\"f4fc6107c7c00947\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/LinkedReferences.js\":\"5a4cb89b7b138514\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e60555b3b604e91b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dailyNoteDefaults.js\":\"fa80f598afd598b9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dataExtension.js\":\"ae5e9920211daf7a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/edgeExclusions.js\":\"2e17728ba5bc03b6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/filterProperty.js\":\"d6ecfbe340f232d7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/index.js\":\"0d4258d51673f617\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7db1f5d1f2df5277\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/applies.js\":\"4b46296e731c41ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/countQuery.js\":\"f02d5543161d1bb5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a4ba96e0b69940c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/index.js\":\"1fe0216a1578530a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"36fc7737701e6fa1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/presentationInvalidation.js\":\"b2ef39c1abfa0db8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyEditorOverride.js\":\"ee56953e81b4f061\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyFilter.js\":\"1fb0808287c5020f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/query.js\":\"c3f06a2855fe903e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/resolveFilter.js\":\"8b679f1ec532035f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sourceBatch.js\":\"c091d1fc2190dc3f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sources.js\":\"cdac5b3da940dd89\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useBacklinks.js\":\"6703de78abfc3e93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"cd038a5841c7236b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayCelebration.js\":\"c73e1d9fa215dc5e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayOverlay.js\":\"4195e5386ef47999\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/gate.js\":\"6f698041b846904b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/index.js\":\"2c01a0cc22131882\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/wolfTheme.js\":\"acd0f778d4ce434b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/BlockDragLayer.js\":\"1f7610199d8de6d8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dragController.js\":\"b459f11eadb64f2f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dropTarget.js\":\"8b17acb6cae6336e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/index.js\":\"01352f7dc901ba46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/projection.js\":\"6fe4a72e34011eea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/BlockMetaCard.js\":\"12feaa57bb5ec65a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/index.js\":\"d956c91c0a048299\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/AddTagDialog.js\":\"a3cbebbb49f37619\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"df0b439b2fb41edc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/TagNameIssueHint.js\":\"100ff5d35b7a0293\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/addTagAction.js\":\"fbf376ec46ed1a42\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/appendTag.js\":\"bd0098ce628a1cbd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/config.js\":\"c0844d46f594b8a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/dataExtension.js\":\"dc2976b7ec014803\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/index.js\":\"2eec04febfc6bf2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/propertyEditorOverride.js\":\"8ce4b5b955665dab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbList.js\":\"316d2a12ea366998\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cef8ca1c1c39b9fc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/Breadcrumbs.js\":\"69501ad789515602\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"32a661ade090a8cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d1b2220c0e985b69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/index.js\":\"538d8e04d2e7c61e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"323d7069ee395cdc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/CharacterCountItem.js\":\"f028621cb08dbc22\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5c7a16531e8f33f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/actions.js\":\"0b26acbd8e5f2a35\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/blockType.js\":\"18119c4cd914c42c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/charCount.js\":\"49e10b76b0fc374d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/dataExtension.js\":\"6ef977c947a16a2d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/index.js\":\"ea3df9bfbef6096d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/profiles.js\":\"09c59a1f1cf825ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/properties.js\":\"e79f8eb9314601ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/textCounts.js\":\"c2c8956a20a0f4c6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/colemak-keybindings/index.js\":\"11269b19ba19dff1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/CommandPalette.js\":\"cefe0bf936939446\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/HeaderItem.js\":\"597a45be473d2a38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/context.js\":\"5d32b6e8a5a1df87\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/index.js\":\"510266a1968bb11c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/selection.js\":\"bf103c2a3c98716c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/toggleStore.js\":\"fe0d26849a8e03ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/useCommandPaletteActions.js\":\"75d1db98a6238061\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/ContributorBadges.js\":\"faeddf7788dc7857\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/author.js\":\"f5068a0b0e93a507\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/codeMirrorExtensions.js\":\"f736bb7592fbc14a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/dataExtension.js\":\"36c0cb1f3d3ca7eb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/index.js\":\"2d8075051ed31b12\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/mentionAutocomplete.js\":\"c3eb1fc3c04766f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/processor.js\":\"614e67057df6b74e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/profiles.js\":\"95393f3816a29997\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/queries.js\":\"57e7717e88209506\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/schema.js\":\"eded4c1e3f303796\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ec6760ced07a14fb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8b700b98f2f98f8b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/index.js\":\"ff0db8dfafa1a9ae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e9c5a9ea4d4bac58\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4c6a71f2ab942720\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/CalendarGrid.js\":\"7a9915d23baf3b00\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DailyNotePicker.js\":\"466b0f106cfe0a5e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"715adafc82308a69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateNavDecorator.js\":\"e3ec5012387e6e25\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateScrubOverlay.js\":\"6d21d56eb91885da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/HeaderItem.js\":\"f184d5f709c536a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/ReschedulePicker.js\":\"1e678a4782a69117\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b27db2a8a522019b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/actions.js\":\"a957cb0192257a0d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/blockDateAdapter.js\":\"17fb9f0a8ab47dbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/calendar.js\":\"18f8c3b91fedd985\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dailyNotes.js\":\"795368d62a312086\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dataExtension.js\":\"cf0697d4bc64ba42\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubActions.js\":\"9341bb20346cf4ed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGesture.js\":\"2ef282f45fc27110\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5ad2b2ba187c4860\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e35fce9397522f6c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/deletionGuard.js\":\"a27f48108ffea7c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dueQuery.js\":\"848ded7a26f4937b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/index.js\":\"ef65b66a5dff5c91\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/landing.js\":\"aece7356bb3ff204\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/localSchema.js\":\"278720d39fc0cbdf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/referenceDateAdapter.js\":\"08a7d1c97b880667\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/rescheduleAction.js\":\"61436830b39fafe8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/schema.js\":\"fb52e7123e5910fc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadBlockDates.js\":\"928b510961d6227c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadDatesAction.js\":\"92f61e993bb4878b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/today.js\":\"6495feb46ab44535\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"96ccbf308d0be20e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a012e810d04a54f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/audit.js\":\"0fd9f2d7628c847e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditAction.js\":\"70b593e92eab16ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditRanges.js\":\"57aa5ca01add479d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/diagnosticsSource.js\":\"75a81fcf42572f81\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/divergenceScan.js\":\"01e59906fb3c97b9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/index.js\":\"3ec67e7245de2240\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/propertyChildrenChecks.js\":\"bd0c76a500e05a60\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/referencesMirror.js\":\"304f78c30cfdf1be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/rowJson.js\":\"1d6309cd2aa036d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/schedule.js\":\"90eca5713a03e7cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/store.js\":\"f6564fe8053245bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/action.js\":\"9503f177e8a6b5e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/index.js\":\"7672818732b2c39a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/plugin.js\":\"f7c5818d344daeee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9dc7ace4f937062f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/actions.js\":\"561dbdf8a8523f28\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/changeMarker.js\":\"0290ae93356d92e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/diagnostics.js\":\"2bcb9d86d61b8623\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/fileSystemAccess.js\":\"10ea30d374a44b4b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/filenames.js\":\"58e139e2ce48c7e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/index.js\":\"cf106bfd91ed2d15\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/mirror.js\":\"18af23e85324229d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runLock.js\":\"a7a09cf226f31a04\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runtimeHealth.js\":\"b1473664f0dd3435\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/schedule.js\":\"7577b86d8600ac76\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/store.js\":\"ae3ba872a9fca793\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/index.js\":\"d65cee2bf424f8b1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/themes.js\":\"3c0d25c0b105f465\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/facet.js\":\"cd19a46b9fbd8fe4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/useDiagnostics.js\":\"f2144ace478d01a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/dismissals.js\":\"9a34550ea4fa06c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/index.js\":\"f445a2807eff6606\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/status.js\":\"d8ad244ec10b0410\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/store.js\":\"736114dc85add34c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b9a2047cebd719b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2b67592106a2625a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/actions.js\":\"b6d2eb17453f3ee8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/config.js\":\"e02f0bf0609b6d35\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/dataExtension.js\":\"afb0da73c521e45a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/effect.js\":\"3f37b5f6d85056f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/index.js\":\"3a2c9363fad23ffe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7a5fad6589f4cb9f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/useToggleTree.js\":\"00e9aac0dacbb0b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/ExtractTypeDialog.js\":\"fb122b75e17b1c11\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d4288ae317db3886\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/PropertyShapePicker.js\":\"b2cf17e83322cd2f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/action.js\":\"fc6a118f38e13f05\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/index.js\":\"b18681bb8868c3e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/FindReplaceDialog.js\":\"72c16e65736204dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/HeaderItem.js\":\"178ae8aa2b8510a1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/dataExtension.js\":\"6347256a9913d98d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/index.js\":\"bedd6ef15bc12fe7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/search.js\":\"61b741e32c6800c1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/toggleStore.js\":\"5bf05023a9c45ea2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/LocationPropertyEditor.js\":\"d23a05a26ca65afd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/MapView.js\":\"9c12bd8dfac3a7f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/blockTypes.js\":\"3b6faef2d41e07f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/codeMirrorExtensions.js\":\"09abc15a54a5abd4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/createOrFindPlace.js\":\"a4ff11a3e21e4045\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/currentLocation.js\":\"80ac6d228b92622d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/dataExtension.js\":\"817cadb70f50926e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/geoContentDecorator.js\":\"5ee69e7fc638ff0b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/googlePlacesClient.js\":\"64bb1aed628e6234\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/index.js\":\"d964278c8cb40b5e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/locationsPage.js\":\"5b81e610d6ac8a16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/mapViewport.js\":\"37b022fa5522b7cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/pickCurrentLocation.js\":\"880ddab2552667cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeAutocomplete.js\":\"da3aec9e78104468\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeNameCollision.js\":\"13497c306c33300f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/properties.js\":\"251aecd093958d27\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/propertyEditorOverrides.js\":\"1329ff4d01cd25be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/query.js\":\"01c5ca569f96bc7c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/usePlaceSearch.js\":\"75a847b8a2453bb9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8874be1adc497cf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"617bb8a3dcab1920\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7bdef6705416fd55\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/config.js\":\"15b298b13fb1e18b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/dataExtension.js\":\"300ed1dcdb3bfc2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/facet.js\":\"18daf3c72a33e755\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/grouping.js\":\"5ba05e01e517b571\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/index.js\":\"fe13803c78123c50\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9b657da6427574d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/query.js\":\"3179d8b88eb0010b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/resolveConfig.js\":\"91ba615cd14cc992\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"384fc29ced8721a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"df1098865d4c4829\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlDocumentContent.js\":\"f99b13622c908129\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlFrame.js\":\"c9f9f14517f05a93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/actions.js\":\"4392dd11fcc9c114\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/blockType.js\":\"c7186c057b4d175f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/confirmRunScripts.js\":\"08f8415e257a5171\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/dataExtension.js\":\"01312a7e8e10e656\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameAnnotations.js\":\"8b1865c57152f9b1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameDocument.js\":\"0c4623f779d0c7a6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameTheme.js\":\"9bd06f724df63ed8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/index.js\":\"5eab9e1bf960a61f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/scriptConsent.js\":\"172a9d4336a8342e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/sourceMap.js\":\"051901e666d897f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/useDocumentScripts.js\":\"0a29c8b9078c8911\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/index.js\":\"385f2d95290c520b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/record.js\":\"b80094db1ccbcfa2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/recordStore.js\":\"428cc0987bb728f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/responsiveness.js\":\"aec36e70944a9f9f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/schedule.js\":\"324d2943a6de3dea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/sessionContext.js\":\"0375d7d50b4e5540\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ad6b5bf6135290d8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"09cd239fc59bf5c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/actions.js\":\"585501d76470a3a5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/config.js\":\"2b04a21f64dd6f97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/dataExtension.js\":\"e3c89d4dda07e05e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/effect.js\":\"84cb1cf5ed837052\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/index.js\":\"e2bc56da9802609c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/keyCapture.js\":\"6cf6d1a87e91aedc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/overrideStore.js\":\"3451158d503f3855\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8e70f62059074c5c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/HeaderItem.js\":\"959a8965fd39d024\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/LeftSidebar.js\":\"9276336d7b7d216c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/actions.js\":\"aefeee7b1469a637\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/facet.js\":\"feb572f051bc5372\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/index.js\":\"3686c1224d49aa30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/shortcuts.js\":\"7a3e5359ccc78eec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/toggleStore.js\":\"1687b6d670573867\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/MergePicker.js\":\"13bf326e6b8d263c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/index.js\":\"c4018b1f53a4afef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/mergeAction.js\":\"35236d0ef0b69706\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/strategy.js\":\"224d7cc2ec7fd7f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/Button.js\":\"1b20a8f5598ff862\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ac9d9604a3c78484\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1e9e83535c895b73\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/facet.js\":\"1014e4c0ee7d96ce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/index.js\":\"b6216bff5fbfdafa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"09386460b944c184\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ab37de57332879bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e817bc1050f69e32\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/facet.js\":\"286b03a7d4768a3e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/index.js\":\"293e7825d10d6ec3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3afb3522d4f18ee3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2bffacdbb30a83ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/contextMenuItem.js\":\"4f11b351b6e03649\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/index.js\":\"fff8a1ffba568e44\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveAction.js\":\"2ed2dd2431cb24ed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveBlocks.js\":\"9f399c218d8e6c1b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/selectionAfterMove.js\":\"43733877ea9ad618\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/TutorialBanner.js\":\"4e9d5fba3977c0ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/action.js\":\"59cf06ca3f486cf7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/bannerDismissal.js\":\"032ca3e3b9530ff5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/documents/cheatSheet.js\":\"3e469fe62256bf26\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/index.js\":\"25dc2d39d4f87e06\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/keys.js\":\"4b9fd37d28645ded\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/landing.js\":\"a57d843ba3464947\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/outline.js\":\"5763086921f5806e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/seed.js\":\"84cf2c71c05aa214\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/PerfTrendDialog.js\":\"daae23feb10a20bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/analyze.js\":\"ae4398187edc6059\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/diagnosticsSource.js\":\"0a5ad381c4bab14d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/index.js\":\"710c8862d69c8549\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/load.js\":\"d8777bc1d2485399\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/monitorRun.js\":\"c6053d5058d60fe0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/schedule.js\":\"77cef22fb999d399\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/series.js\":\"852096de41cd7367\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/store.js\":\"14b6ea1bbac62210\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/trendAction.js\":\"4b359c18ab659adf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/verdict.js\":\"2924f866694fe079\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/clickToEditAction.js\":\"48bcdc9dbeae84ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/index.js\":\"6c8ea5f6867c50b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/interactions.js\":\"dc116ee00116af52\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e64af005a793fb4c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGate.js\":\"574eef8c6016ae03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGateDialog.js\":\"8f5e9209abdf7633\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/action.js\":\"4cba9f9e686bdc16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/index.js\":\"035c14c7913bd998\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/localRunMessage.js\":\"7189370a919cec95\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/plugin.js\":\"1d6338deea1fd458\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/progressReport.js\":\"10aae62e3483630c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/sweepProgress.js\":\"85feba5f81a0728d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/FieldRowRenderer.js\":\"d4b374037eb88ed3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/ValueRowRenderer.js\":\"f302132534788381\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/actions.js\":\"a0010bbd4350ee44\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/autocomplete.js\":\"3ec80e5b0988bb00\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/fieldRow.js\":\"30a7a34a2e56bc11\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/index.js\":\"32d45db8e8ae4ed5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/referenceWarning.js\":\"e0b8b976f972185f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueAutocomplete.js\":\"d22a803e81c9f48b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueSchema.js\":\"cd8db682d2f96304\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/HeaderItem.js\":\"cae22417ffe06675\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/QuickFind.js\":\"d86656f1b30c2673\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/index.js\":\"9104ed84091fd678\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/recents.js\":\"d4dff930833de117\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/resultItems.js\":\"ea18b8f994d6a374\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/selection.js\":\"ddba17782577a384\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/toggleStore.js\":\"1fcb2adac01c6dbe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/HeaderItem.js\":\"016c2a47c1f281f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/RecentsPageBlockRenderer.js\":\"35acf0b2ab87b17d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/grouping.js\":\"0e300b60a7a9196d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/index.js\":\"bf3cea7fbd9d996f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/target.js\":\"6ae563b4d4cecc19\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/codeMirrorExtensions.js\":\"31abac644559cd60\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/contentPrefill.js\":\"b395c93b71bf6b34\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/dataExtension.js\":\"0b35ec6846b3d9f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/index.js\":\"d7cdecc6cf39574a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6249148618af8b30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/invalidation.js\":\"a92036e2baa42368\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/localSchema.js\":\"5c81485856998b5e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/index.js\":\"2c6cf5dc449a4770\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4166e39ced4250d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/index.js\":\"a3a34024378c5a70\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/referenceNode.js\":\"53654a215bcb4c6b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/remark-reference-occurrences.js\":\"31d9ac11ae7a37d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"65789e3e7a26fb34\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/index.js\":\"1227f645eff40d50\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"07af038e4bac332a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"4504a9c1b9ef1e4e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/mergeRetargetProcessor.js\":\"768435e40662c79d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/parseFence.js\":\"590dfb0bfd145966\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceParser.js\":\"f343a203b3f36485\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceProjection.js\":\"dae458026af4ac13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referencesProcessor.js\":\"da7c8fc1b2110b61\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/renameProcessor.js\":\"83f3c7a31c020f89\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/spanReplacement.js\":\"ce404a17586edd47\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/htmlToOutline.js\":\"8c35c8827068855d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/index.js\":\"e5d0d97fecff935a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/normalizeClipboardDom.js\":\"302f7552de3a8716\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/pasteDecision.js\":\"1dba8f77210164e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/action.js\":\"5600dc19e80b7e07\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/blockIds.js\":\"ee5835c9cfbf8420\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/content.js\":\"d2b1c8cd802ef60a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/effect.js\":\"df43ad1617253242\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/ids.js\":\"584637d3078e5b0f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/import.js\":\"1baed2919e4a3ea5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/index.js\":\"fcc46e487a06bf80\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plan.js\":\"356ce0ab41e53b16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plugin.js\":\"4200e624ec5d7882\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/promotion.js\":\"e418a0d2efa23bc2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/properties.js\":\"79e5d77638a6f60a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/references.js\":\"f759b632603963a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/report.js\":\"e0ba30e5e440e708\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/roamMemo.js\":\"4ba1007e854163df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/runtime.js\":\"127ebd0b9a5a017d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/schemaReconciliation.js\":\"2ce7ad00b05f7be1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/srsMarkers.js\":\"b47c8ddc55ad8107\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/todo.js\":\"4f34714ce0428dac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/typeCandidates.js\":\"035c142accf0cb38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/types.js\":\"fcdadac865eafb6c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/index.js\":\"b349ab1a77b004cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/store.js\":\"0a748dc8995decec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/HeaderItem.js\":\"4276d487bdfe1874\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"93474d7e964eadb3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/index.js\":\"75f549652b589ec4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/model.js\":\"05d396fd5776cfce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/toggleStore.js\":\"02ea9c505d98572a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/useKeyInspector.js\":\"ef831d508c6a8a8b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c86e5cfcf2491db0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/ShellDecorator.js\":\"2907eaab579fab2a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/actions.js\":\"ae140a0e1ebe959b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9530dae45a0b3dd5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/index.js\":\"6972f4633bb3d461\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/shell.js\":\"e87c34d19d8ff04b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/surface.js\":\"f4f440dcddb40afa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/walker.js\":\"e9e634bafd65bafc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4c8c38e61b1679db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/dataExtension.js\":\"73e781a04d05c2a2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/index.js\":\"f07e1f14c828cd28\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/indicator.js\":\"bb34a05946c02eaa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/moveSrsState.js\":\"5c307d99c04174d7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b1602da8cc78fb5f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/scheduler.js\":\"c3e798bf5de69fe9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/schema.js\":\"020728e4ee6d4d69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"89d9085a1978c693\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsClipboard.js\":\"0954e790338d867e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4ffe2acb098f8975\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DailyNoteReviewHint.js\":\"93a8fbed7816c43a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DeckPicker.js\":\"769eafedebb9953d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewControls.js\":\"75ba0f4444a58c97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e1e8602fbeb6ebeb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewSession.js\":\"4f3dedf747cd6109\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/actions.js\":\"9fbd40d1ebaf139e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/archive.js\":\"e9d274768071094c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dataExtension.js\":\"38e55b015d30c2b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/deck.js\":\"a24e5f1d3393dbd7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dueQuery.js\":\"36de0d95157cc42b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/gradeDecision.js\":\"0440734e4d6236c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/index.js\":\"981f90b29482ec0d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/keyHints.js\":\"f8c6272e9ae5205a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewCardLayout.js\":\"f8b0a27f6e5cf74b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewProgress.js\":\"43801fe82cc55f0d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/schema.js\":\"6326e317dd9b4dbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/useDueCards.js\":\"8e096adea93fd606\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/index.js\":\"8fea6815139c3e78\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/record.js\":\"8bd9486f803b0054\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/index.js\":\"66f4885e524225da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/persistenceStatus.js\":\"a7d0883e70617557\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/requestAction.js\":\"cdaf1901d2249465\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/TypeChipsDecorator.js\":\"a048ad0bf153de17\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/codeMirrorExtensions.js\":\"292b107481f4ad46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/index.js\":\"6e0de47b1c53ae6f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/typeAutocomplete.js\":\"de94708d4534ab52\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a9996341e56043b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/actions.js\":\"af92a26c7e031622\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/anchor.js\":\"c3892fe684f91cee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/events.js\":\"ea02cd61a2a1eecd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/gestureActions.js\":\"d9ad3cb08f44a931\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/index.js\":\"1b38fae480503fc3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e00734a159241f43\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/collect.js\":\"5113932bfb972b3a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/index.js\":\"4440114e9a71a98e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/record.js\":\"9c9dc9a5535318d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/RejectionDialog.js\":\"197ccfdb293c3d8d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5a34f312c3eb8c54\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/index.js\":\"7130ee7e5e2731eb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/model.js\":\"594d1a98ca0fcc96\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/queueCounts.js\":\"40aa5a238539d65c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rejectedHelpers.js\":\"efa1c247c0174f70\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rematerializeAction.js\":\"91b81cb3b0614b05\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/useHysteresis.js\":\"b238a16ee24983a6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/effect.js\":\"d3beabb9b8ebbe8f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/index.js\":\"f2e935bd3b03fc16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/theme.js\":\"03b4a91f3808c7cc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/actions.js\":\"0758e484a6538c7d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/dataExtension.js\":\"e0e463194664ebee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/index.js\":\"d5bf0858a1ab264f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/schema.js\":\"61359d7fc09d924d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7a25da575decdac7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/actions.js\":\"e97664188ce3dbed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/defaultItems.js\":\"1c903b8580669048\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/facet.js\":\"b9f5822601c9cb7b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/holdRecognizer.js\":\"b3820be54f80b2ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/index.js\":\"0d3b8d9ba5a9bcdf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/UpdateIndicator.js\":\"ebd07fb790489e33\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/index.js\":\"86d69b45a6b78220\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/loadTimes.js\":\"09a6359ebb78168c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoNotesRenderer.js\":\"ba18c284e4241021\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoPlayerRenderer.js\":\"3ea444744fa58e88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoTimeStamp.js\":\"9487de9a4696e1ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/actions.js\":\"f8b4173f5e8e00f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/index.js\":\"76fe8d7300529057\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/markdown.js\":\"d9fd101a4ffc64f0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/notes.js\":\"294e00cc92c3cfef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/registry.js\":\"57c2517e72ad6d9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/remark-timestamps.js\":\"7f6035dde9d19447\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/view.js\":\"648e57dc2c638bbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/LinkHints.js\":\"422e9b31d10517df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/index.js\":\"945fada2a9dee6e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/model.js\":\"d65c4fcb7fd3e979\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/settings.js\":\"b0d75612f914c4c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/actions.js\":\"16ddaa6ccfbc902d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/index.js\":\"2caad00ba9ab0aa6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/interactions.js\":\"786ca8883bc0fc30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/workspace-header/index.js\":\"a158776d5a341f89\",\"/knowledge-medium/pr-preview/pr-1785/src/registerServiceWorker.js\":\"670b1feadf944688\",\"/knowledge-medium/pr-preview/pr-1785/src/requestPersistentStorage.js\":\"238201012d5e1fb0\",\"/knowledge-medium/pr-preview/pr-1785/src/services/authRequestDeadline.js\":\"664e572d8c0a619a\",\"/knowledge-medium/pr-preview/pr-1785/src/services/powersync.js\":\"2962d4fce6fcf039\",\"/knowledge-medium/pr-preview/pr-1785/src/services/supabase.js\":\"f510dd037d9175be\",\"/knowledge-medium/pr-preview/pr-1785/src/services/uploadErrorClassifier.js\":\"17f2307024dc2396\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/ActiveContexts.js\":\"29806dcb710eb9b4\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/HotkeyReconciler.js\":\"839f702bfb6ff0b7\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/WipeLocalDataDialog.js\":\"58f62d10f0f69f5b\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionDispatch.js\":\"29fda6f484a504bb\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionRefItems.js\":\"ad1c43dc9996e9fd\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/applyKeybindingOverrides.js\":\"662d42c208699b25\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/blockActions.js\":\"0c9d6fb19cb23af5\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/canonicalizeChord.js\":\"5d5d171df502646f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultContexts.js\":\"eb07978ceba9ca68\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultShortcuts.js\":\"0cac110f437883b2\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/effectiveActions.js\":\"60e71e8bb171010b\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureAction.js\":\"788c37f3a38706b7\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureBinding.js\":\"73ada9c837c3cbea\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/holdRegistry.js\":\"5a5959fdb1d5467b\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingConflicts.js\":\"361b59c7cc6bd16d\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingOverrides.js\":\"e666f48b9f805ff6\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/pointerAction.js\":\"a3165b998ec0cbba\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/resolve.js\":\"5fb68c3105e2f5ab\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/runAction.js\":\"cf70ae46a75dddda\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/sequenceMatcher.js\":\"1f426c376687f9ce\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/types.js\":\"ccd74c71ca7f028e\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionContext.js\":\"efa4f971c50eb4a0\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionDiscovery.js\":\"f9ba8fe46d7efd7d\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/utils.js\":\"8820cda606047890\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/bootStore.js\":\"c73e285dc0c12856\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/previewDatabases.js\":\"3a9090ad85a7f1bb\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/byteTransform.js\":\"8f02c790ea226715\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/attachmentCleaner.js\":\"04d728040ab6517f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/attachmentParts.js\":\"f795e30ca2f9084b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleParts.js\":\"d35b0f1787bb9ba4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleRecord.js\":\"cc2022b7553ab8da\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/manifest.js\":\"115aa1ca9a5d8300\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/takeBundle.js\":\"f17f085eb906e489\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/verifyBundle.js\":\"8580e1e7e2f27baa\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/cleaningStage.js\":\"fd05e8a0cfb78eaa\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionKey.js\":\"d644f371a74617b5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionServer.js\":\"f95563266c1596c5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flip.js\":\"5152e01bb01e22c3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flipAttempts.js\":\"c9decdfddb61618c\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/pages.js\":\"66f0530c11d9772c\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/preflight.js\":\"06cf7e3dc2edf7bc\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/reseal.js\":\"4573b31b91c5ec80\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runConversion.js\":\"76754acec5285493\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runLock.js\":\"7695107bd6fa8f87\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealing.js\":\"81a6459df4d3c89e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealingStage.js\":\"703ea57bf2fb144a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/stage.js\":\"1ff36f95d27e47c0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/verifyReseal.js\":\"3fca2efffb380514\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aad.js\":\"12e79908ff819949\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aead.js\":\"f002ee2cca08e3f2\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base32.js\":\"77b93f0491f69125\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base64url.js\":\"6db13ee20abd92c0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/binaryEnvelope.js\":\"82e922a56c9617b0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/byteAead.js\":\"535efdf36ae109db\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/canary.js\":\"d9e1f59a40a30ee4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentHash.js\":\"e31ca1b7e08d540f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentKey.js\":\"1dc772ff06f3d099\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/derivedIdNamespace.js\":\"27d3e22ed7fcd607\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/envelope.js\":\"772441bd1e058504\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/hex.js\":\"17593602e91e6d16\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/sha256Hex.js\":\"3e7a8abaab03bf62\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/workspaceKey.js\":\"e40b3ae29c051206\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/conversionState.js\":\"780452edbf259299\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6a1abb6d0da1f490\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/pastedKey.js\":\"3f11a0ea348480a5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8c950b3aec8f870b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3ed6ba8e3afcd956\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/keyStore.js\":\"16ea3bad67eb4ba5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/mintWorkspaceKey.js\":\"d5b6adbb65396d7a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/modePin.js\":\"378796410deedc3c\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/openWorkspaceKeys.js\":\"a466ce214ca5d3f8\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolveWorkspaceEntry.js\":\"3ddefe806bcf0a6c\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolver.js\":\"dc685e2caea37a4f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/workspaceAccess.js\":\"cf05697bdfe52777\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/transform.js\":\"0748ec06fdfe7ae5\",\"/knowledge-medium/pr-preview/pr-1785/src/themeBootDefaults.js\":\"8c8be63580db5500\",\"/knowledge-medium/pr-preview/pr-1785/src/types.js\":\"034b54d98bb66212\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/ClientLocalSettings.js\":\"bb57d6ae56c622d2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/abortableSleep.js\":\"2cb7d4a51d11132a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/array.js\":\"10117e602f546c38\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/backlinkAutocomplete.js\":\"c01e8363a69706fa\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockCrumbs.js\":\"bbebdd9e13954cd1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockrefAutocomplete.js\":\"d220bf8fc5983a34\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/cadencedIdleJob.js\":\"463cf2cfbe19b6e0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/callbackSet.js\":\"d072c828b76dab06\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/clientId.js\":\"eaa8177ae81b8484\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirror.js\":\"a65ec223ca8b7931\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirrorCompletion.js\":\"9a371910f83da1b6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/copy.js\":\"9703d63bca334b43\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dailyPage.js\":\"f9bcbb6886d404fc\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensics.js\":\"3627ebced5e7d17e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensicsHooks.js\":\"a22fcab07515feac\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/deleteBlockThroughUi.js\":\"8e41e090bda52f14\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dialogs.js\":\"181e3ed895f98cc7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dom.js\":\"3285be4b6f762767\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/downloadBlob.js\":\"59bc9475a3f2ebf1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/exportSqliteDb.js\":\"87e959f1a9d5882a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fileSystemAccess.js\":\"48299a99687c770c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/flipSlide.js\":\"b54cf04f88ea3b11\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fnv1a.js\":\"0b3e1f027accce23\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/formatBytes.js\":\"a52af6c70b89f4cf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fuzzyRank.js\":\"1699cabded88ebd9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idbKeyedStore.js\":\"b073ec6e8644949e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idleCallbackPolyfill.js\":\"fd24fb4436d693d2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardAwareScroll.js\":\"bd946423dd16a395\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardViewport.js\":\"ec9b45da9ab21d33\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/lastWorkspace.js\":\"e875023dd54fe9b6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutColumns.js\":\"8d9a428252e157b6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionDom.js\":\"406eec6f4d7b8f26\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionId.js\":\"99cd4309e6854f45\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkClickGestures.js\":\"282ee46aa89f378f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkTargetAutocomplete.js\":\"ab9955e27ed99be5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbCorruption.js\":\"ab6c95d7260c38ff\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbRecovery.js\":\"b0e8a93ad0f8720d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/markdownParser.js\":\"d8269d43c22b0e60\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/memoize.js\":\"facc865397a85445\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameFieldCommit.js\":\"6fc653699331dea7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameList.js\":\"6a4d10ff224d7072\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/navigation.js\":\"c3de47f72593f9da\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/omnilinerNamespace.js\":\"2d2e5436b6038e70\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/opfsPageScan.js\":\"21258a5079ac0b02\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelClearance.js\":\"f218bf735800c2c8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelHistory.js\":\"9244c7239ec49456\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLanes.js\":\"2eb7a196e4b83c16\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLayoutProjection.js\":\"5cb35de8b3feb36b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelScrollAnchor.js\":\"e9263dbc6c82c6ae\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelUrlFlags.js\":\"b19a314ee87e8a6e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/platform.js\":\"1fa3ec049ea32669\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/pluralize.js\":\"703a141997397b4a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyCreation.js\":\"a9d9418d579185f0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyNavigation.js\":\"b0bbad6ae1dd8d63\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyValueContext.js\":\"771c7caaf03e5fe7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/react.js\":\"4b450f0be730b3b9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeDate.js\":\"2a8ba2ac5b8e94e5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeTime.js\":\"2f28d5b94d0fe7a6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/renderScope.js\":\"54b3577b5eb4e9da\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/resolvedThenable.js\":\"f40d204f179cd3e9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/routing.js\":\"69a2a21138f7f4c3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/safeMode.js\":\"4d7763a9eb713bc0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/scheduleIdle.js\":\"da02b9e564a40f94\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/screenWakeLock.js\":\"5684037f1a4d775e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/selection.js\":\"430b3b4e57bf1c03\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/softKeyboardGrab.js\":\"b03e9c3b275b74b2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/startupTimeline.js\":\"47540d2e65e12b5b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/state.js\":\"f02116a76d613cba\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/string.js\":\"5d5e71f09577f369\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/surfaceZoom.js\":\"c20bfe6db6cc4462\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/time.js\":\"67341f59c6353ce7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toast.js\":\"a076fddf66a8614c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toggleStore.js\":\"20c0f54df56016d6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/untilStopped.js\":\"72697507d644cee1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/userActivity.js\":\"b338b8b5d38b0adf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewTransition.js\":\"9d68f6e31b90310a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewport.js\":\"6b969ec859126275\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/webLock.js\":\"62c057d890d8fa64\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceRecovery.js\":\"80d891dcf3b69baa\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceSnapshotStore.js\":\"1552285545594e0d\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-compiler-runtime.js\":\"33f66a592d7f2a9b\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-client.js\":\"ddbbdf250b202173\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server-edge.js\":\"3b8bd85b7e4f7e55\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server.js\":\"2704381939f4c31d\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static-edge.js\":\"19f379e13e54f58f\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static.js\":\"b2c0e55d7d6a4beb\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-test-utils.js\":\"0481203784e8aa26\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom.js\":\"3992619cbf7a021a\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-runtime.js\":\"9683d5871db9ce50\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react.js\":\"806b93bf560bcfc7\",\"/knowledge-medium/pr-preview/pr-1785/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
