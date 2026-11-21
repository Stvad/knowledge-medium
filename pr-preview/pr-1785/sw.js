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
		buildId: "073d3ceab8e6-a931177b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/\":\"f03d03d61ee34776\",\"/knowledge-medium/pr-preview/pr-1785/index.html\":\"f03d03d61ee34776\",\"/knowledge-medium/pr-preview/pr-1785/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1785/assets/FacadeVFS-CVO9VvLh.js\":\"a72dd069a3dcd297\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSCoopSyncVFS-QEXZOHY6.js\":\"267100346ab65de7\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSWriteAheadVFS-DyHWk-A9.js\":\"5e3b88b0d981d8e5\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-BCoQ-Mk_.js\":\"b7f21f9931401380\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-bt34Lkd4.js\":\"3a403ed695c38ed2\",\"/knowledge-medium/pr-preview/pr-1785/assets/worker-Btkd33Go.js\":\"8c8d80e5d4571ca3\",\"/knowledge-medium/pr-preview/pr-1785/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1785/chunks/app-DcHpkrx6.js\":\"97a4d56d8c0e6f1b\",\"/knowledge-medium/pr-preview/pr-1785/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1785/index.js\":\"a3bcf474c1878b26\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1785/assets/AccessHandlePoolVFS-D7noHMPx.js\":\"299fe5ae169288ea\",\"/knowledge-medium/pr-preview/pr-1785/assets/IDBBatchAtomicVFS-C6fbvlTa.js\":\"6162a432740d4178\",\"/knowledge-medium/pr-preview/pr-1785/assets/MemoryVFS-CW6xh3Gs.js\":\"9b290ce7d1e4b74a\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-DL3tp13A.js\":\"f4971c06c5acaf4f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-CLmbv2JP.js\":\"f9ecf3376b19ee8f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1785/chunks/AccessHandlePoolVFS-CAREOrqy.js\":\"7411a5b07d433c59\",\"/knowledge-medium/pr-preview/pr-1785/chunks/FacadeVFS-BOxkm3I8.js\":\"2da96b7f5168f10f\",\"/knowledge-medium/pr-preview/pr-1785/chunks/IDBBatchAtomicVFS-DZA3uUSR.js\":\"60b49587e9579ea3\",\"/knowledge-medium/pr-preview/pr-1785/chunks/MemoryVFS-DtIUVMTL.js\":\"3b0ad025399ba174\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSCoopSyncVFS-DiMBKcij.js\":\"13d84cafb3c3f212\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSWriteAheadVFS-CEEIAF2V.js\":\"f1a3a643ce7ab72a\",\"/knowledge-medium/pr-preview/pr-1785/chunks/Preview-DowQ1ZHr.js\":\"79b5975e6e484c9a\",\"/knowledge-medium/pr-preview/pr-1785/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/card-CWUQii5y.js\":\"527c7d4f77c014dd\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-DoAEV3UM.js\":\"f4a252ea5cc06e5f\",\"/knowledge-medium/pr-preview/pr-1785/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-Dj7L1Lp9.js\":\"e75a8a898fa140b2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-async-Cg3xpB9Z.js\":\"b9df5e1c5fc8388e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-C-dBp_Jb.js\":\"434bae68e36760ef\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-CjZca_zn.js\":\"596e07415a6e41a2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DKPZVk_e.js\":\"d6a0083b368e3c11\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-J7MdbS0u.js\":\"6f0ae6e1a0540115\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-L01ZqARj.js\":\"07f9a40cee8077c9\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-MgSKz9jx.js\":\"711f636b5ee0ab13\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-MpD7onu-.js\":\"751f0fadbbc9290b\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-ciJG4NMl.js\":\"8e1516271cb15bd8\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server-legacy.browser.production-BPWffThl.js\":\"7f47e7c829c34426\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.browser.production-B94_zOzn.js\":\"a68f731b9176ed33\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.edge.production-CpehlXt4.js\":\"94ea8d270a476a83\",\"/knowledge-medium/pr-preview/pr-1785/chunks/server.browser-BT7obPSy.js\":\"dd23d47edd8ab932\",\"/knowledge-medium/pr-preview/pr-1785/chunks/textarea-Dqko6kNW.js\":\"d62d2de4e9abf7ef\",\"/knowledge-medium/pr-preview/pr-1785/chunks/ui-voJPaAii.js\":\"dbf3c478409fe937\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-async-QL25ThzH.js\":\"32841ee9e9a4e632\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-fcvHB7So.js\":\"f2776e1b3c1db722\",\"/knowledge-medium/pr-preview/pr-1785/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1785/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/src/App.js\":\"a001c64645f581ee\",\"/knowledge-medium/pr-preview/pr-1785/src/appUpdate.js\":\"7043773e3bf94eae\",\"/knowledge-medium/pr-preview/pr-1785/src/appVersion.js\":\"bd60cd21577081e5\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/initialLayout.js\":\"7eb1b1e1c21ecdbc\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/resolveWorkspace.js\":\"46fc7ba73e212353\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/workspaceBootstrap.js\":\"ba751f3487551328\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockComponent.js\":\"5b3b62bf0c0ff7b8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockCrumbs.js\":\"74099d3c5c29021e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockEditor.js\":\"abd8190537072031\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockLoadingPlaceholder.js\":\"e1f0658824ac5a3b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockProperties.js\":\"a72e997ac2faed2a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockSearchPicker.js\":\"3784c95f93654684\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ConfirmBulkDeleteDialog.js\":\"d7cf81f76734004a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DividerHandle.js\":\"2619383aa10b31b1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DraftEditor.js\":\"3ef499f13dda51c3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/GutterPill.js\":\"4433b0827169af5c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Header.js\":\"6890746f9f1e3679\",\"/knowledge-medium/pr-preview/pr-1785/src/components/LazyBlockComponent.js\":\"46ab58ab373cfb6d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Login.js\":\"020e2dfb60216294\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ZoomableSurface.js\":\"fd3385966f9ca060\",\"/knowledge-medium/pr-preview/pr-1785/src/components/editModeKeepalive.js\":\"2eef8758207dcef9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyDisplay/PropertyDisplayScope.js\":\"1df24eb28c50237b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2664fe1657463314\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefPropertyEditor.js\":\"840123bb98ac3c33\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefTargetTypePicker.js\":\"7f2f1895256d5296\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/SelectPropertyEditor.js\":\"691317f1b68a8d39\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/TypesPropertyEditor.js\":\"2f7e796119ebf8c8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/defaults.js\":\"c3fd4fa26cdd2f1f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/kernelValuePresets.js\":\"8fd6fd4dbfc857a3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/selectablePresets.js\":\"163a967aaf1467bc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/typesPropertyUi.js\":\"4a40592f4350c911\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/AddPropertyForm.js\":\"69c0fa16d7f7f989\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyPicker.js\":\"4a5c91dab7629c72\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyRow.js\":\"df527f8edfd9acf0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/Rows.js\":\"7bdc34fb6bb0761e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/actions.js\":\"f1c0cbb94eeeca63\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/declarationOnly.js\":\"c45849fbd7745543\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/layout.js\":\"92b8f1b81a82b83e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/model.js\":\"97528f0105edb9fb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapeUi.js\":\"82edcd228dd4afce\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapes.js\":\"eb5fc15bac75649b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/usePropertyEditingActivation.js\":\"dfbfebf75cc02332\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/visibility.js\":\"00617a1941573c28\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanelSections.js\":\"13eadfca23cf6538\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockEmbed.js\":\"7ddbb3c32be9ad66\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockLink.js\":\"9e237d303aafdc31\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockRef.js\":\"6f881778900b754a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/ReferenceLink.js\":\"6e2853d28516421b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuard.js\":\"152540e7dad331e4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuardContext.js\":\"adfd0e1ab76a7988\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/linkInteraction.js\":\"41033b10f12f6775\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/referenceLayout.js\":\"897ca9b2b1409431\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/useBlockRefAncestors.js\":\"cd86220f9b50964a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockGutter.js\":\"74afff1a4fd05d90\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockInfoDialog.js\":\"64d4206bccee9496\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockTypeBlockRenderer.js\":\"5762e7af31562422\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BulletHoverCard.js\":\"f9f6d21721db17eb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorContentRenderer.js\":\"086e8e350c8ae14e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"143c45b3327b9d63\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ColumnResizeHandles.js\":\"a719eceac32d3508\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"03d7095d25621c0c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/DefaultBlockRenderer.js\":\"05f22fdb31c48a91\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/LayoutRenderer.js\":\"e3f9cc962cf82c41\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MarkdownContentRenderer.js\":\"190a93853960f0e0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MissingDataRenderer.js\":\"4610570a23008f8f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PanelRenderer.js\":\"dfec0831e28bebb8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PropertySchemaBlockRenderer.js\":\"54fabb96d744df45\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/TopLevelRenderer.js\":\"46704097043106f2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockGutterMode.js\":\"f521990a310d19cd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockTitleText.js\":\"abcf09faafb11a31\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/fieldCreationKeydown.js\":\"5e6eb18b55fcb926\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/layoutRootContext.js\":\"ad0b06dfecadc5f5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/TypeChip.js\":\"f1b401ce71c677bc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/chipStyle.js\":\"36975937dda3ca5c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/anchored-floating.js\":\"0c0a96522551aa9f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/button.js\":\"1289e151a005fbb5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/card.js\":\"008a0c3ab14ab154\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/checkbox.js\":\"b3dedfc4e764da34\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/collapsible.js\":\"f6a58486769eb8f1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/command.js\":\"c757350116fbdc33\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/context-menu.js\":\"09b6cd70a70f44e7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dialog.js\":\"c41555ea9ca61171\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dropdown-menu.js\":\"283c9158d15c5e6c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/floating-listbox.js\":\"a7fd77cfcf12ea65\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/index.js\":\"bbfcf3001f72e33b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/input.js\":\"786cabd3b1d6723b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/kbd.js\":\"0f1daebebc24ba6c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/label.js\":\"e38eb803078ad48b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/textarea.js\":\"5b00bb3da7b3ee39\",\"/knowledge-medium/pr-preview/pr-1785/src/components/useEditModeYieldKeepalive.js\":\"c76f1800e3841dcf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/BootFallback.js\":\"f1763039598975f1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/FocusedRowLazyMount.js\":\"d691e8d3c7e8b011\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LazyViewportMount.js\":\"ae2ec7261b33a123\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LocalDbCorruptionFallback.js\":\"c8d91c9d16ce4b0d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/error.js\":\"9bd4e041c73a4cd0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/lazyMountRegistry.js\":\"8a6b20830ff64c38\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/suspense.js\":\"e0cf8d8cb049959d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/CreateWorkspaceDialog.js\":\"31b6d83266d674cf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/PendingInvitations.js\":\"167330007e60cc34\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/SyncProgress.js\":\"094ead5a76d882a3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/UnlockProgress.js\":\"22ff0d2740df920b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceKeyGate.js\":\"29af4d3636334f1c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSettingsDialog.js\":\"957455b4f89e9ee6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSwitcher.js\":\"c09fb92277ade4b6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSyncGate.js\":\"dad0143185dc72a8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlow.js\":\"2362bf8212ecc24e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlowHost.js\":\"4fe968c0e6db9cb2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/EncryptionSection.js\":\"f89fbc4bd06f3902\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/attachmentPrompts.js\":\"de3dc4d084492b97\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8a83403aadd0c94b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowDeps.js\":\"0936f1db24b27245\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowStore.js\":\"7726cc7bac3b4adc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/flowUi.js\":\"5a58b3c7662e94d5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/useConversionRun.js\":\"1bc4b7a666b175d0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/keyUi.js\":\"288256e1a87925e9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnKeyLoss.js\":\"c9c7f53082b29c4b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnServerE2ee.js\":\"16eb04692ebdcdd8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/workspaceUnlocked.js\":\"9e846f7c4f0d3efe\",\"/knowledge-medium/pr-preview/pr-1785/src/context/backgroundSubtree.js\":\"3d5228c706bd3b3a\",\"/knowledge-medium/pr-preview/pr-1785/src/context/block.js\":\"add3d2e79552d275\",\"/knowledge-medium/pr-preview/pr-1785/src/context/layoutWsContext.js\":\"6f5d8baafdd1a2dd\",\"/knowledge-medium/pr-preview/pr-1785/src/context/propertyDisplay.js\":\"c0cdab1a51fceb03\",\"/knowledge-medium/pr-preview/pr-1785/src/context/repo.js\":\"fce5c0924bd6273a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasClaim.js\":\"6b9712d4d2b2a383\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasSeatNamespace.js\":\"6b0eed63300bbd08\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockData.js\":\"4c9a4eea6fe59b27\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockType.js\":\"319b4c3b2242c672\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/changeScope.js\":\"291fc5fca5e39109\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/codecs.js\":\"e2edb807330bc137\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/derivedData.js\":\"ddf232724c611685\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/errors.js\":\"5beaa72e86ca90d5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/events.js\":\"991c27ece943ea15\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/handle.js\":\"c6aad75fa14d5aa9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/index.js\":\"0fa569aea37d7673\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/mutator.js\":\"1f4e72f131b793da\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/processor.js\":\"8c2587a51a1c841a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/propertySchema.js\":\"0d1cff3090e64700\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/query.js\":\"c7dbfe353743ec96\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/sameTxProcessor.js\":\"d7fd5991cd8bf1ca\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/schema.js\":\"c6aad75fa14d5aa9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/tx.js\":\"c6aad75fa14d5aa9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/typedBlockQuery.js\":\"1d137c62eb79d7bf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/user.js\":\"6798202eb6bc59e6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresetCore.js\":\"aeb2ad6b08727d8e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresets.js\":\"87e438458c735842\",\"/knowledge-medium/pr-preview/pr-1785/src/data/attachmentCleanerIOVerb.js\":\"794038a12b673c90\",\"/knowledge-medium/pr-preview/pr-1785/src/data/block.js\":\"9f2e0746c9e3c8d3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockCache.js\":\"6139a9d653ae6e88\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockId.js\":\"3ae6c669c3c6abbf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockLiveness.js\":\"eae43e8bc270a1b0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockMerge.js\":\"37a665cbcd9a9b1e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockSchema.js\":\"00ee29e13ba6016c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockTypes.js\":\"46b5dcb73244afab\",\"/knowledge-medium/pr-preview/pr-1785/src/data/clientContext.js\":\"1c3abe568504ccb4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/dbFileSiblings.js\":\"c5caa3659d7fbeca\",\"/knowledge-medium/pr-preview/pr-1785/src/data/definitionSeeds.js\":\"46f772f2c5176e47\",\"/knowledge-medium/pr-preview/pr-1785/src/data/derivedIds.js\":\"2035c512f30a9bcf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/drawnSubtree.js\":\"fa4189c4bb44b41d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facetBridge.js\":\"ec96988b85861e8b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facets.js\":\"e9143311743f0273\",\"/knowledge-medium/pr-preview/pr-1785/src/data/globalState.js\":\"f4d747d7c8d41fd1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/aliasClaimRederiveProcessor.js\":\"6ab780f0ecd1836d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/ancestorBatch.js\":\"6a13dabb29d865b2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/blockTypeTypeifyProcessor.js\":\"c7d4b53a2fbd85ec\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/clientSchema.js\":\"b295d117707c7028\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/commitPipeline.js\":\"1da20ca2a0d233d3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/devAssertions.js\":\"a1efe02b44d19af4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/firstSync.js\":\"55dd1e0ad45d2a23\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/freshInitialLoad.js\":\"48f5444d3fb03e42\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/graphBackfillClaim.js\":\"7ec419cd673cc912\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/handleStore.js\":\"3b9f773338407e57\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/idleMarkerJobs.js\":\"60cb238f9a693a36\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/initialDownload.js\":\"459a2f651a4ff7a2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/jsonCanonical.js\":\"7c107a85ef4d7317\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelInvalidation.js\":\"f7698c161dd14873\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelProcessors.js\":\"e75a46d757407b48\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelQueries.js\":\"aed3ea81d5fb0baf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/mergeTypeMembershipProcessor.js\":\"3f405f886b5b3d6a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/normalizeReferencesProcessor.js\":\"2b8a68a3d1aa0f0d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/poolInstrumentation.js\":\"e88d2e949ab6cf19\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/processorRunner.js\":\"179992c845883781\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyCellBackfill.js\":\"6e5335697e628f9f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildMint.js\":\"dc533c4779f57f43\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildrenProcessor.js\":\"e8f3e829f881f9fb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2188a3ec5638e710\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionSynthesis.js\":\"000e6e7053740745\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyKeyScan.js\":\"2f63a1709a4c8913\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertySchemaResolution.js\":\"8e448b82a6eaf5f5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/raiseProtocol.js\":\"899991a128dcaf0e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/readBatch.js\":\"f860f9378e78c1e5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/refProjection.js\":\"102bb2e73eadafa9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetLookups.js\":\"75cb277eec7b7cbd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetProcessor.js\":\"888f2d06ecf6e8a0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/replayMerge.js\":\"356dc9449fe5b9b7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/sqlBinds.js\":\"3f61658eae6b474c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"de888c40cfce5c66\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/arrivalProcessors.js\":\"86717342cb66e89a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/invalidate.js\":\"5df77fc9aa670680\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/materialize.js\":\"9cc329e52b4137a6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/observer.js\":\"8969acb2865ba79d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/reconcile.js\":\"2059ed5dde21cd8d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/timingMetrics.js\":\"66fddddfd92b33b0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/treeQueries.js\":\"cecfa9bc97f10d78\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txEngine.js\":\"39fb453fdb91c50b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txSnapshots.js\":\"0e0d33b732bbf588\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/typedBlockQuery.js\":\"5a05e96e5483593d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/undoManager.js\":\"3550a5ce6786ba82\",\"/knowledge-medium/pr-preview/pr-1785/src/data/invalidation.js\":\"3027d35eacfedcb2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelDataExtension.js\":\"8937bce5c530c0a7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelPage.js\":\"1c0e5a5452710b67\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelValuePresetCores.js\":\"1ef60003c9b8bf49\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbCorruptionSignal.js\":\"68639417db83c7f9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbStorage.js\":\"a5a18ed230a23f56\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbVfs.js\":\"6557ab667ccdc811\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localSchema.js\":\"a1bea73e141576e5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/maintenance.js\":\"afd17befb227ecd9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mergeProperties.js\":\"62e78b9cb13781c2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/metricsConsoleHook.js\":\"d6fbfc967c4bcbcd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/migrationsPage.js\":\"128d9b404c1528dc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mutators.js\":\"79f37a88dbf12c18\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKey.js\":\"93792cddd89bd66f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKeyPlacement.js\":\"43c672d0ad50b9b0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/outlineSurface.js\":\"b371a59042c96de4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingEditorContent.js\":\"6758a2deefca164f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingUploadsSql.js\":\"043257301d8ac815\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pluginStateExtensions.js\":\"542f4257b054d8a5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/powerSyncLogger.js\":\"af58b601fc489654\",\"/knowledge-medium/pr-preview/pr-1785/src/data/projectorRuntime.js\":\"060e87d5fde2b492\",\"/knowledge-medium/pr-preview/pr-1785/src/data/properties.js\":\"d20b95071c81861d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertiesPage.js\":\"64289e01f0489cfa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyChildren.js\":\"0419ca3671636112\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionFanout.js\":\"aaeebee759dbefd5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionMetadata.js\":\"adebe3a4febf531d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionRegistry.js\":\"ac5c9e36de872266\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDisplayMode.js\":\"e09928fe74cd5f10\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyRowCreation.js\":\"704d23db99c13e5f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySchemaCreation.js\":\"7103afef2729fc77\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySeeds.js\":\"18f0421f6bccda2e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/recentsPage.js\":\"2b98e5fdcbbc6718\",\"/knowledge-medium/pr-preview/pr-1785/src/data/referenceBlock.js\":\"d0b7d8793cb32a05\",\"/knowledge-medium/pr-preview/pr-1785/src/data/releasePowerSyncConnection.js\":\"e891c60d2721ad33\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repo.js\":\"9f8e71cd584b5eeb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repoProvider.js\":\"926cf6d0e8fe36aa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/rowProperty.js\":\"37f66b7ece66560d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/searchFilter.js\":\"d15ab640c7db84fb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/seedIdentityLedger.js\":\"c7d3283d7e5d2bd6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/stateBlocks.js\":\"2272ca9fffbf014c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/structuralEditPolicy.js\":\"c1e22a7935cf4ad9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/subtreeDelete.js\":\"fdd8a54b5012018b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncStreamLock.js\":\"213a6b485d476bda\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableSqlRecognizer.js\":\"e65b548516bafb52\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableWriteGuard.js\":\"bfb2443ed4f08859\",\"/knowledge-medium/pr-preview/pr-1785/src/data/targets.js\":\"8f1e91a2cd49ce3a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeColors.js\":\"0ce31b6a231d5d57\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionMetadata.js\":\"13b211eb97cb25fe\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionRegistry.js\":\"87bc6e5648e061f7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeExtraction.js\":\"861380be8b4d0899\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeInitialValues.js\":\"b3a830c1a9d6d51c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typePropertyGroups.js\":\"84d142f705aab184\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeSeeds.js\":\"2014a71e90ccc48d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeTagger.js\":\"6d23ef310b005313\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typedRecords.js\":\"b9300c390489e9da\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typesPage.js\":\"e148cb634e24e4e4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userPrefs.js\":\"72998a0abdaa7ecf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userSchemasService.js\":\"9f41f70988dd4c7d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userTypesService.js\":\"73da809799b1377d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/valuePresetRegistry.js\":\"9e94559b6467191a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/visibleChildren.js\":\"d1b2b26eab327a55\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceConversion.js\":\"eefeb4243293c0ce\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceFirstSync.js\":\"1007bdbbc20d987d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceIdNamespace.js\":\"335d4b0fed2fef08\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceSchema.js\":\"fe84bf23811ae80d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaces.js\":\"daf63507fcb50313\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadLog.js\":\"9bee96053ffc4f7e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/BlockPasteShellDecorator.js\":\"6a7b7bc91d180675\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/atTrigger.js\":\"b571192f99a09a46\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/autocomplete.js\":\"7c5928f4818462cc\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/codeMirrorExtensions.js\":\"b33bad305448fc07\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/contentFlush.js\":\"d55261fef742fdd1\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/defaultInteractions.js\":\"47761dca203564d2\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/editSettleSignal.js\":\"da4e469c9074b5ab\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/insertImage.js\":\"55def767ff590981\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceCompletionRange.js\":\"05c3ef580e984c46\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceTargetTypes.js\":\"d89e02921b281c46\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/syntaxContext.js\":\"91b1ec1aaf3bb59c\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/triggerMatch.js\":\"d9b327be2f0bd8d8\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/AppRuntimeProvider.js\":\"c4d2e5cfcfec0336\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/BlockFocusShellDecorator.js\":\"7093132a4682c2a1\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/ExtensionRenderBoundary.js\":\"2a4d0940c94d7677\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/PanelContentRecovery.js\":\"7b1ac326e66fd88f\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/apiCatalog.js\":\"6138e391cdbd4e75\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/approveExtensionHere.js\":\"3891c75190241423\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/armedCutAppMount.js\":\"4a66a1352a6f0ad8\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/batchableKeyedStore.js\":\"e08e14f73ff4fd9a\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockInteraction.js\":\"5a29c8451e32c3a9\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockSelectionAction.js\":\"031778ce50268890\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compileExtensionModule.js\":\"2154a48a42ad9764\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compiledModuleCache.js\":\"ac5186addccad239\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/continuousGestures.js\":\"bfa36678cba27a28\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/core.js\":\"fd7ebaee45bcaf10\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/defaultRenderers.js\":\"0325b7899e1d1b4d\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/definitionFanoutAppMount.js\":\"a05b7cfccff1f913\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dialogAppMount.js\":\"7a215c1c2cd69eee\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensionSeeds.js\":\"add82746104087c0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensions.js\":\"6222c294f4829cf1\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/exampleExtensions.js\":\"0be89288153398fd\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionApprovalStatus.js\":\"9176ebc2eb139ce4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrorToast.js\":\"5afc198647d35307\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrors.js\":\"56f57cbc0e523cc3\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLookup.js\":\"c07728a33bd1248d\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionToggles.js\":\"6090e171375254f6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionUtilitiesCss.js\":\"42680eba6f8973d1\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/kernelPageDeletionGuard.js\":\"fa9cfded75efaf56\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/liveRuntime.js\":\"3c9cc97856821c91\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/openExtensionsSettings.js\":\"24ca3fe6c5e342a1\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/overridesCache.js\":\"ddf4ef606edb57b6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/pluginIds.js\":\"5d4777caf584a8e2\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/processorRejectionToast.js\":\"9820a1b422d8bf11\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeActions.js\":\"86aa0eaa68234bab\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeContext.js\":\"a0fb51e9cc0a2d86\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticAppExtensions.js\":\"c3cb0c0cb3d55c90\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticDataExtensions.js\":\"fdec5e576c0ae5e4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/toastAppMount.js\":\"683f49d18ca55db8\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useOverrides.js\":\"d4e1ecdaf5d4da10\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useShortcutSurfaceActivations.js\":\"2c056139143539dd\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/discoverToggleTree.js\":\"e95cf905ad375b37\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/facet.js\":\"3ab173d979bf6855\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/resolveAppRuntime.js\":\"7ff647ba2da60eaf\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/runtimeEvents.js\":\"3bb7d74c78cd6740\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/togglable.js\":\"aee510319a5bd542\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/variantFacet.js\":\"9abc0dffd4c99797\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/verbFacet.js\":\"7ca7d5458f79cecc\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/block.js\":\"4c4fab2307eb9c2b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/focusedChild.js\":\"3a473f2d4a2ae535\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/propertySchemas.js\":\"c24844f9b7976d8f\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/typeRegistry.js\":\"d5e4f741a3982759\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAncestorCrumbs.js\":\"67106fd7adc6524b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAutocompleteListbox.js\":\"27377789d4a11d3a\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedSearch.js\":\"0e76945999180f1a\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedValue.js\":\"93aa4fa0213a7f7b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsFocalRender.js\":\"8c23a2e22092f39a\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsReadOnly.js\":\"45fc33db256ca636\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMaterializeBacklog.js\":\"47d2d8c52dd775c3\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMinuteClock.js\":\"7766703ba3673f19\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePanelLayoutProjection.js\":\"727ae93087c7b0ea\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePendingInvitations.js\":\"2655bafcecf16a3f\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRendererRegistry.js\":\"0e675423a98601d3\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRetainedFieldRows.js\":\"e7dac233d854184a\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useWorkspaces.js\":\"1d69a90f475bb1a3\",\"/knowledge-medium/pr-preview/pr-1785/src/lib/utils.js\":\"a1eb9c6f387af3c8\",\"/knowledge-medium/pr-preview/pr-1785/src/main.js\":\"b30e7ebe8e2248d4\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/MarkdownImage.js\":\"106517e09688ba87\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/blockSeparators.js\":\"58edb3668f25b6f6\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/context.js\":\"b6e1d6c5d0031709\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/defaultMarkdownExtension.js\":\"8401c675122178e5\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/extensions.js\":\"d56ea6a4fe8a2906\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/renderMarkdownHtml.js\":\"9e8741e51c791325\",\"/knowledge-medium/pr-preview/pr-1785/src/minimal-editor.js\":\"48b27d3e59610ad7\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/armedCut.js\":\"b2e98796b837c667\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/captureMediaVerb.js\":\"ae270bc618673fbb\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/clipboard.js\":\"3891e7cf72892c14\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/decision.js\":\"c2499702da9f4b60\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/operations.js\":\"55cfc02745f9aad5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/AccountHeaderItem.js\":\"c285c82636afe81d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/index.js\":\"8b8a21997446065c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4f7998f43923ab0f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askAgent.js\":\"afb5ad3b42672ae9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askedStore.js\":\"cc4a1d88a0636ee9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ed6c724abc2427d4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/chipState.js\":\"997ae61e6d70d6bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1c396fa02dcb654f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/index.js\":\"659b850b06562997\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"389a3242e44c3731\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/schema.js\":\"c9add87f2f02b22a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5741fb8c23d56bee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/BridgePairingDialog.js\":\"80ff1f4e4c97d3d7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/addMedia.js\":\"0bc1d69f59e61da4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e3f84b02607b6ac5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/block.js\":\"8b9c14650ce4fad8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/context.js\":\"8c0533bd83f3e726\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fa50934c42dffae8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/index.js\":\"1f9d5e7e1b27ee4a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/outline.js\":\"737e07c3c755e68f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/properties.js\":\"497bab218ef22225\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/refs.js\":\"89f6c299a36e80f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ad51a6be2342d87d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/search.js\":\"8028b04fa77c2d42\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/shared.js\":\"049f678dd0704d75\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1226a29858c6bd4d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/text.js\":\"a27bbce7fc47721f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentWrites.js\":\"6fcac27d5a0e0419\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/authoringCatalog.js\":\"664c888eb56396c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/blockRefTargets.js\":\"c10c442a3a07ecb2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridge.js\":\"65a3e8678ef64a2f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridgeLoop.js\":\"7448fbd9620f42ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/changeHistory.js\":\"3ff82844adf9e04b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commands.js\":\"76e865e47bd92480\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commentsCommands.js\":\"89a0f0b46b0ea891\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataExtension.js\":\"432dca7ccf7f880e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataModelGuide.js\":\"cce40a0496d243a2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/describeRuntime.js\":\"92eecbe10c19854f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/extensionLint.js\":\"aa80e16b9faa3a63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/grainAudit.js\":\"c2d58212559cc87c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/healthCommand.js\":\"1cc2bfe924ff5c63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/index.js\":\"1b8715dc6673ed93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/presetIdentity.js\":\"c4aa41503d488084\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9ed09f21401393c2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/readMedia.js\":\"f0117afb0d5ea9ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/schema.js\":\"42f569173539674b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/serialization.js\":\"93c9a681c48ff580\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/targets.js\":\"881f50e69567ec2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/tokens.js\":\"a0a7d072ec948c40\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/watchEvents.js\":\"8d7cfb08acce294a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/workspaceGuard.js\":\"b214b2830abd4d70\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/writeCommands.js\":\"6b719b469791fdb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/AliasCollisionToast.js\":\"03a87c01bef7dc10\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/DuplicateNameBanner.js\":\"a12de7acaa8a1565\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/collisionMerge.js\":\"30388531f15de418\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/dataExtension.js\":\"ee5f406ec4bc139e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/index.js\":\"ca74ea3a4b8325a1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/mergeCollisionAction.js\":\"6ec0582e711fc533\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/pageStyling.js\":\"eaa663ff2e3e835a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/rejectionToast.js\":\"42af11b0bd536196\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/syncProcessor.js\":\"9d9df27ba04ef782\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/actions.js\":\"0ee7d63fa0494469\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/addComment.js\":\"dd7e92bf69d48926\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchor.js\":\"e4bc320dc7ca15f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchorState.js\":\"df4b8267e71bcded\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/commentLinks.js\":\"772146e55b9dc8dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/confirmThreadDeletion.js\":\"c0b6d744461cc9f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/container.js\":\"1b53d93bd5655c2d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/dataExtension.js\":\"2096e4818cfa21cc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/deleteComment.js\":\"84cfc004a264da0e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/highlights.js\":\"82ff489ced55ebc9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/index.js\":\"927a5bc94ef72bf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/linkedCommentsPill.js\":\"f159bcd58b9d2bb2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/margin.js\":\"b6dc21c98ae26cf3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/marginSchema.js\":\"4edda1adb06b3a77\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/newComment.js\":\"da900442c3422896\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ownThreadPicker.js\":\"05b92d3078fa0a6e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/placement.js\":\"92de052db98fce9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/queries.js\":\"7f224d8d0e131b7f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotePosition.js\":\"09f2ce26dca1a2ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedIn.js\":\"9e4fe5e360e295a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedRange.js\":\"923a0b34ebb050e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/rangeRefs.js\":\"807f45ff88dafa1a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readHighlights.js\":\"0e916fadb833878c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelection.js\":\"b86f7e3efd2fdf65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelectionUi.js\":\"48c83b200869139b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/reanchor.js\":\"6ee5c12dc0a894d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/schema.js\":\"a7bccd0724d37f2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scope.js\":\"40d9b03851c08966\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scopeThreads.js\":\"ccb58ec67210a43a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/splitRetarget.js\":\"bb1ae53df7c7db16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestionCard.js\":\"fdb58dde48eee599\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestions.js\":\"1cfbff1c6abed1ac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaries.js\":\"ff4717727d24b3d7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaryBatch.js\":\"30cab40b147871b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/surface.js\":\"5bf82a3fd681c707\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threadNavigation.js\":\"760bc5f892e333d4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threads.js\":\"a0c21da5525a54c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ui.js\":\"981d7409780ea2ec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/uiStore.js\":\"50cbbe1e2ac66a2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/appIntents.js\":\"ae43a175e1283e1e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/index.js\":\"d396df67ab0f0dcd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/index.js\":\"2461e5bf2fc6a12c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/status.js\":\"d1d63c761588322d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5915421bf280548c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaBlockRenderer.js\":\"25707c37020860b1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5326567b106eae48\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaUploadReconciler.js\":\"33566a3816a95055\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetDownLane.js\":\"04930e979e2b973b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetResolver.js\":\"117fc078a302dbfe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetUpload.js\":\"2db76246c7b5699f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/attachmentCleanerIO.js\":\"fe365fe89f66fdd9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/supabaseAuditIO.js\":\"293634fd01dad740\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/blobStore.js\":\"b2f11da7332aab0b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/byteStore.js\":\"8e469ed7e704d8cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanerIO.js\":\"00673c474ba4d273\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanupAttachments.js\":\"eac13c91f0a4e074\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/dataExtension.js\":\"07757e1cc900f56a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/downLane.js\":\"b2c7775ac26df80f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/index.js\":\"6b5c6282910917da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/insertImageContribution.js\":\"fa3d0dcadd9c109a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneArming.js\":\"a25673fa09b753df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneLock.js\":\"bdf6e658664d72ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaBlock.js\":\"1e8977a67c77524b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaCapture.js\":\"9fa78f90081ff799\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewers.js\":\"895784efff803f3f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewersFacet.js\":\"87c048a991f897ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/pasteCapture.js\":\"652fd2d729168877\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/resolver.js\":\"1d3b9a8037d59d4f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/retryUploadsAction.js\":\"68b1eed8e365cdd1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/storagePaths.js\":\"fd353406e38b2bb7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadDrain.js\":\"d06f17e782d09875\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadLaneStatus.js\":\"25dbe0039650ae34\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadReconcile.js\":\"f8e3644029d99f23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadRecovery.js\":\"5650fe629fc1adbe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadStore.js\":\"1ae05db4c6b9b272\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/useAssetObjectUrl.js\":\"da8e9a226fd71b6d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"1ce018b635291531\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksViewSection.js\":\"762a112ed677dbab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/facet.js\":\"9d4ecfe4a7f7e1ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/index.js\":\"463c26f8bb7ad829\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/prop.js\":\"e884f43c1585a515\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinkFilters.js\":\"4808688566507a5c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ed70681a5ce5b6ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BlockEntry.js\":\"9de951b5cb30fbb3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/LinkedReferences.js\":\"724654731f77bf8e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"baf74bc2ea46eb57\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dailyNoteDefaults.js\":\"1720dbb3c78a6728\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dataExtension.js\":\"bdf3a0ee5afaa3d4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/edgeExclusions.js\":\"d8f31ec4b13747d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/filterProperty.js\":\"c53a96fed7e75d68\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/index.js\":\"111206106eeb0d95\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"41aa5cbc05c39b4d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/applies.js\":\"b8a65d2b3975dc8a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/countQuery.js\":\"4ca4de6637cacc92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b6a4e97c311e9114\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/index.js\":\"2d25004cc5d002e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9c4f0ead577c5cc6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/presentationInvalidation.js\":\"adc3b1cd77db93e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyEditorOverride.js\":\"a07af22011a6f5b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyFilter.js\":\"9c0ef2ca602443b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/query.js\":\"1dc061899a8c6fa9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/resolveFilter.js\":\"9729c0094e2a9aea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sourceBatch.js\":\"4d3f8cd14b2699d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sources.js\":\"d0e7a7e775e34212\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useBacklinks.js\":\"fc6e41d8b083bfc5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"632eaba2a6fceb44\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayCelebration.js\":\"e8400388c615cda2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayOverlay.js\":\"c069e009fcee7f34\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/gate.js\":\"1182ee4f649b3e92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/index.js\":\"9747382c213419df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/wolfTheme.js\":\"6ba1e7ba5a9f0041\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/BlockDragLayer.js\":\"f04e9f038b0ac649\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dragController.js\":\"d5513cf17b2f40c2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dropTarget.js\":\"ebc759d93d44f923\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/index.js\":\"f74b67a5e31ecd80\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/projection.js\":\"e515a6137c6be979\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/BlockMetaCard.js\":\"221ec1f094f29908\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/index.js\":\"7d832754cdeb5bc4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/AddTagDialog.js\":\"b28408788f466fa3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"27ffb992978968a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/TagNameIssueHint.js\":\"50f2cad958623668\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/addTagAction.js\":\"4efb66c26c58571d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/appendTag.js\":\"a4fc85f1e070a77a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/config.js\":\"327f0ec85becd0ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/dataExtension.js\":\"ac213240d208a9d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/index.js\":\"3d3f9c864e282428\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/propertyEditorOverride.js\":\"2c12ecda1c49cd03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5daf9d0561baf9b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"772e09ef6ba4f358\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c9ec8e0638e4ea0f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"82cba58a9559ed36\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ffbf64f63f53295a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/index.js\":\"2a957f0bb1c8f018\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"36897804121bfc30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/CharacterCountItem.js\":\"020112871624e44a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/ProfilePropertyEditor.js\":\"83fb8853f185d56c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/actions.js\":\"227c0260a01f1658\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/blockType.js\":\"24d4f5cc11e237b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/charCount.js\":\"2be8018b1cc44ca1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/dataExtension.js\":\"4cfb14c1ed0d0c07\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/index.js\":\"2533537d7ca75fec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/profiles.js\":\"d344f6b95bcabaf3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/properties.js\":\"17b55c61a6b2ea27\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/textCounts.js\":\"6aae01e16482adc4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/colemak-keybindings/index.js\":\"2d4b356a582cfb30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/CommandPalette.js\":\"824587eb7fbd9181\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/HeaderItem.js\":\"12014a90be3ad1db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/context.js\":\"317459191f77b778\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/index.js\":\"93ae3565e393613d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/selection.js\":\"dc983a0f2fbc6d06\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/toggleStore.js\":\"c74c9d46487f84f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/useCommandPaletteActions.js\":\"8f1894e62f7732f3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/ContributorBadges.js\":\"422d0530881cb080\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/author.js\":\"e8106a5957eb0abe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/codeMirrorExtensions.js\":\"bfe4e38fb5133319\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/dataExtension.js\":\"c0a45e529edd45c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/index.js\":\"8a2405be6c53eb46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/mentionAutocomplete.js\":\"ebb47354cf3b45ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/processor.js\":\"8913d3be8f01f66d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/profiles.js\":\"f382334a6c94d22b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/queries.js\":\"e622828d3c4c9741\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/schema.js\":\"e9462cdf8f3fa222\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9d4f2b6b533aa517\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7e29548f36c651c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/index.js\":\"236bbc6ef78d8da7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"95ddacef51083bf1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5653691f35dd679e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/CalendarGrid.js\":\"0e282a5937eff244\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DailyNotePicker.js\":\"d9e83b5f7c59e6bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3e72208d5bc26427\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateNavDecorator.js\":\"1d57bcf63ed2df52\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateScrubOverlay.js\":\"b6c467a52e46f2bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/HeaderItem.js\":\"0a3ca8421fc72f9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/ReschedulePicker.js\":\"507813ab23a67406\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4656e954279b2434\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/actions.js\":\"3e77f63bdbaa3829\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/blockDateAdapter.js\":\"a6149d5b79975a11\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/calendar.js\":\"99b56a97731f13a2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dailyNotes.js\":\"3fee37ab36294ea7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dataExtension.js\":\"0dd1361b325e53c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubActions.js\":\"266934537f37a687\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGesture.js\":\"62009d034379de79\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGestureActions.js\":\"65a335f51eab2fb6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubRecognizer.js\":\"cd57431ef1198300\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/deletionGuard.js\":\"144f00c87dc6593a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dueQuery.js\":\"8568640ff93efaaf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/index.js\":\"269d768471f4896b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/landing.js\":\"6e5ce1352a16b30c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/localSchema.js\":\"884305dfd94ed62c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/referenceDateAdapter.js\":\"0f90c8e9ac0f1af9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/rescheduleAction.js\":\"e2bfb500b5d54f79\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/schema.js\":\"dabd728013028c8b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadBlockDates.js\":\"85f1ea2ffcb88ff1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadDatesAction.js\":\"7d08ef3e12cd73e6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/today.js\":\"df11897abd6760cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"16a46af9f6dc9f8f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e74925c939db6e00\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/audit.js\":\"d59dcbd74ddded5b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditAction.js\":\"58b538ba4329d56e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditRanges.js\":\"bc6c0912e20545c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/diagnosticsSource.js\":\"2bf30ebf946e995f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/divergenceScan.js\":\"733968656784eddb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/index.js\":\"891bb0d406cc0881\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2a1e54f47649354e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/referencesMirror.js\":\"02df73a2091757ae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/rowJson.js\":\"3b5d700c73f914bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/schedule.js\":\"1258b28e61d35c62\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/store.js\":\"60105f76e1259194\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/action.js\":\"e35d84d3f42d72f3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/index.js\":\"1e83985afb09d38a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/plugin.js\":\"12659fe5503def4e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e12caf26692130aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/actions.js\":\"991b1eac15dc3efb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/changeMarker.js\":\"a14ca1db22e4f9e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/diagnostics.js\":\"21b41cc605ddfb90\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/fileSystemAccess.js\":\"be54afcffc67feee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/filenames.js\":\"04705d54dbc16489\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/index.js\":\"17f41d83bac0ef3e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/mirror.js\":\"f888baa996f4fe44\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runLock.js\":\"0e1898118af2c322\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runtimeHealth.js\":\"800654810d74bd46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/schedule.js\":\"b0c607ade169c8a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/store.js\":\"791089b79ad21ed0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/index.js\":\"17c400edb1d79e9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/themes.js\":\"b541d4edae3e1afc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/facet.js\":\"c66fbd51d8c2648c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/useDiagnostics.js\":\"0e9a3cf666554e63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/dismissals.js\":\"320f8d77881396e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/index.js\":\"3edc25559346c738\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/status.js\":\"23e4fefeeaf45c1c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/store.js\":\"7b524ccba20ce2b9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9d29a059c5e27a49\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6a960509cf8d0c57\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/actions.js\":\"7a7eb6dc6147361b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/config.js\":\"0f7efd7831e26b92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/dataExtension.js\":\"2718d282473d2fef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/effect.js\":\"29b9c3f034654c68\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/index.js\":\"f7a1911c8b33e71b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/propertyEditorOverride.js\":\"aaac906168947315\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/useToggleTree.js\":\"5dd499418f5aaa84\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/ExtractTypeDialog.js\":\"c0de15506fa3ab46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e3d77b19df6e08c1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/PropertyShapePicker.js\":\"5f6baf4488f074f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/action.js\":\"ed2a23faa95a8dfe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/index.js\":\"fdb84ae5c1c5bb31\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/FindReplaceDialog.js\":\"3719dcd14a5dc3e0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/HeaderItem.js\":\"801e4f7fb8615b22\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/dataExtension.js\":\"a4e4fa620152e709\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/index.js\":\"d4257972a6a158d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/search.js\":\"98862b46297d37b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/toggleStore.js\":\"47b49cd87de46da3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/LocationPropertyEditor.js\":\"ee02472fe43b5267\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/MapView.js\":\"7660e8dded5e1e59\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/blockTypes.js\":\"4a4c76ef40c364c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/codeMirrorExtensions.js\":\"3607b4e9434b9e0b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/createOrFindPlace.js\":\"299cb1fb5f322d48\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/currentLocation.js\":\"8c42d19b3f96189e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/dataExtension.js\":\"37a115abc4c3806a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/geoContentDecorator.js\":\"f5b5c613886a8ba1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/googlePlacesClient.js\":\"091d7b0b8984b495\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/index.js\":\"59d2711e639b7492\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/locationsPage.js\":\"2cc2ccfe1eff1660\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/mapViewport.js\":\"08f8e3db2472d41d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/pickCurrentLocation.js\":\"1ff2d45b5ee30604\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeAutocomplete.js\":\"1fa764225a4d4d59\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeNameCollision.js\":\"83220125c827101d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/properties.js\":\"0bc50dfeec79cb7e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/propertyEditorOverrides.js\":\"318fa54fb5b4326b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/query.js\":\"99a24eeb993001a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/usePlaceSearch.js\":\"cdb42959c466d6d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"fb0339b13ddad0ae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"25a12f1824260510\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"88aada5ccb80b54e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/config.js\":\"402b4c3a69af014a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/dataExtension.js\":\"a402eed095bea746\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/facet.js\":\"c29702a66078aa18\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/grouping.js\":\"91f8b6e64fa9b04e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/index.js\":\"45dcda70278cad11\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1354bce7cbab6351\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/query.js\":\"4ac57d0212c47859\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/resolveConfig.js\":\"2d600c90640d4b9e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"040c3440110ee250\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"eb188463f84cc874\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlDocumentContent.js\":\"12ed52502bd8034d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlFrame.js\":\"11c35249f7866e1c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/actions.js\":\"c0735bc311b41068\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/blockType.js\":\"6538bbacfc4c26ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/confirmRunScripts.js\":\"7066f0e8ed022f22\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/dataExtension.js\":\"6092c21b5aaae347\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameAnnotations.js\":\"7a6f42f50139e1b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameDocument.js\":\"2df5a7579704e4ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameTheme.js\":\"9fcc0f6bab6be983\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/index.js\":\"3f20bfc6ac063c1f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/scriptConsent.js\":\"396149cd0cd77bb4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/sourceMap.js\":\"61ff790c19aeac62\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/useDocumentScripts.js\":\"8c931b9e12a6a6c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/index.js\":\"f323a3d3738271c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/record.js\":\"48404ad00dac5564\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/recordStore.js\":\"89ff8eefe0ce66e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/responsiveness.js\":\"f793bd5b90abe689\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/schedule.js\":\"7f427ef85a75209c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/sessionContext.js\":\"47005c4c20b72fed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8469d1a2a45cea30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"add9b73136cc67e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/actions.js\":\"164bd91f500a812e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/config.js\":\"a9af77b0621bbb92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/dataExtension.js\":\"130b46c17b2d70dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/effect.js\":\"89c364ce69cfde58\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/index.js\":\"0388730faa3715b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/keyCapture.js\":\"174bbc64b9ce51b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/overrideStore.js\":\"0e321c76ca925c53\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b3ac58ed4add5d3c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/HeaderItem.js\":\"44f0100ce82cc062\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/LeftSidebar.js\":\"9f5363817dbbcd18\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/actions.js\":\"9df127287afae643\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/facet.js\":\"5e2f2e95d0445791\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/index.js\":\"8cb6b56cf776b558\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/shortcuts.js\":\"e2cde1117a9c9b17\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/toggleStore.js\":\"38121ae926595eea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/MergePicker.js\":\"75914b253996c181\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/index.js\":\"c296885c6443e1dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/mergeAction.js\":\"04f27e7ea7311259\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/strategy.js\":\"4a1cf1bec07dd72a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/Button.js\":\"5119437b662e8fbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"fcd280ed48d468e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/defaultItems.js\":\"521ae1b50482ebb6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/facet.js\":\"0dfba47da9acaa24\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/index.js\":\"3b2f19f95dc320ae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1cfb3c7ae930c5dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6f31e40ce8876fa9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4fa84096003a46d4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2f473d8082d2e707\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/index.js\":\"53d0086606262845\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/MoveDestinationPicker.js\":\"40bafd9c291f0856\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1c1b2f2730c76077\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/contextMenuItem.js\":\"f50f5b5b992bd62f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/index.js\":\"dce099f4479754c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveAction.js\":\"9eaa8a1b50acf740\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveBlocks.js\":\"33f0948806748145\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/selectionAfterMove.js\":\"dba2a0ee65131090\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/TutorialBanner.js\":\"921e10e9e6e52e21\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/action.js\":\"67640054f1501683\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/bannerDismissal.js\":\"866f74fcf5065d7d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/documents/cheatSheet.js\":\"771749eecf338103\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/index.js\":\"1b287f940403b5e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/keys.js\":\"7eb0f9b790d4f98d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/landing.js\":\"be0f277e15dff7b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/outline.js\":\"77453dfc7bf13664\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/seed.js\":\"ed81533429156dd5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f2e70a9931101479\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/analyze.js\":\"b824fdad9862ace0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/diagnosticsSource.js\":\"161206312b27658a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/index.js\":\"c66189832536663b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/load.js\":\"eeb826273509a80c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/monitorRun.js\":\"7f0c031368b96cff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/schedule.js\":\"81e5c0e88d2dde03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/series.js\":\"d89963bb2a115d99\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/store.js\":\"d9949ab3f7002743\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/trendAction.js\":\"59500345fb909e6b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/verdict.js\":\"7b96db59d96bb4d6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/clickToEditAction.js\":\"03330d485abef370\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/index.js\":\"acfd8e6824367c4a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/interactions.js\":\"04f23508fb2a0cd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7de4dc566a6dbc60\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGate.js\":\"16db6f1acf67fe14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGateDialog.js\":\"5e3eeaa4546cf8ac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/action.js\":\"6ff8ae3c5d1eda56\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/index.js\":\"2b01b67ae64436f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/localRunMessage.js\":\"058545355b16fc1b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/plugin.js\":\"40d0292ebd1d1924\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/progressReport.js\":\"6319ed93ef730041\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/sweepProgress.js\":\"59930742c7c44800\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/FieldRowRenderer.js\":\"e0bb25ea5f6b4ed6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/ValueRowRenderer.js\":\"1e9d68f62462b744\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/actions.js\":\"bf0fb3b227bc60b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/autocomplete.js\":\"740e06665989410a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/fieldRow.js\":\"6c6e07678dd40e8e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/index.js\":\"81601ce173bb44c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/referenceWarning.js\":\"98674496ed37ca09\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueAutocomplete.js\":\"3ff8731e935e6863\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueSchema.js\":\"ce04d5ec8e1c9dab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/HeaderItem.js\":\"2d44f83c4f81e896\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/QuickFind.js\":\"fd2bedbc313b0db6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/index.js\":\"7245f517d27730e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/recents.js\":\"6329dae9c992647c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/resultItems.js\":\"8b59fdfcbe626604\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/selection.js\":\"f63be8ea09890fe2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/toggleStore.js\":\"1f4aa30da17ec750\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/HeaderItem.js\":\"de9bef9d7151b553\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/RecentsPageBlockRenderer.js\":\"503265a49fa3760e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/grouping.js\":\"459a49748e1ae96c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/index.js\":\"81ab71f61225ef69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/target.js\":\"0cc9b3dd9cffe8ed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/codeMirrorExtensions.js\":\"2316ac8ae7f1addf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/contentPrefill.js\":\"8db4138044fe9bc4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/dataExtension.js\":\"44663cd8af1a5957\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/index.js\":\"70979c6c22b68d64\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8a2b7db0abb30634\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/invalidation.js\":\"c4db672cd7ff3f75\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/localSchema.js\":\"7026004e19d33d97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/index.js\":\"f0251e97a1abeec9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"baacfe420a008916\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/index.js\":\"7af85927669d5298\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/referenceNode.js\":\"8a40ce273fe93d67\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/remark-reference-occurrences.js\":\"662b9e122ed68ddf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4011add8710a59a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/index.js\":\"d8ec99bbb1aa271f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"34eec939a2c24b42\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b38bc920d77a8cd9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/mergeRetargetProcessor.js\":\"02af22f1492d9c3a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/parseFence.js\":\"10f5271710eec8c1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceParser.js\":\"cce2b4b30bdb3dd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceProjection.js\":\"e89d01233b4d1662\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referencesProcessor.js\":\"a6a378d58b7d2dd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/renameProcessor.js\":\"f94114c1717ec39a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/spanReplacement.js\":\"3dd949aae2642844\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/htmlToOutline.js\":\"1c730ae2fb4f78cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/index.js\":\"4475b9babcd584c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e07895db2088a55c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/pasteDecision.js\":\"a80091bb88807d7c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/action.js\":\"97ea849fada5a006\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/blockIds.js\":\"5b0d89b87ba2d1b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/content.js\":\"995a3abba727ce95\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/effect.js\":\"78534c211ff5ead0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/ids.js\":\"53ad950f4594f5c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/import.js\":\"5e696c6aeaf25ee2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/index.js\":\"8fe1669d68e7680e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plan.js\":\"1fa0edd6d29a8b7b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plugin.js\":\"ba6605643f03e3f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/promotion.js\":\"bdf75363d6f9b704\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/properties.js\":\"9f9b1e4f88bf26eb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/references.js\":\"9f3ea841dbcaae4e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/report.js\":\"e1933dfa41234feb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/roamMemo.js\":\"9c2798db3c1486c2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/runtime.js\":\"cfa94ae628a66989\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/schemaReconciliation.js\":\"9a4ad3c0b8e67492\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/srsMarkers.js\":\"5eacbdc35d0efad6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/todo.js\":\"26306d5b20d218ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/typeCandidates.js\":\"a9cb25b8262bf1b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/types.js\":\"2b47b001de8b28db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/index.js\":\"4535806bb3ae064d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/store.js\":\"8c21754f48fd7b67\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/HeaderItem.js\":\"18228bb157e9f1c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3652c2c14fb2a2ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/index.js\":\"9d1e7c80ce6ed79f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/model.js\":\"7a03b628685f6b92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/toggleStore.js\":\"50ca1f86ebf0be2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/useKeyInspector.js\":\"d7a2d7394f9e205a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f58e94e7b9a1dea8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/ShellDecorator.js\":\"7a42d9796f52ae76\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/actions.js\":\"c46aba850fec2fcc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8335ed9594838089\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/index.js\":\"3a078ec90600ce83\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/shell.js\":\"7dbb88fe0b58d04b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/surface.js\":\"f0ea701c7ffd9800\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/walker.js\":\"18d19e0d4ad2bfdb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/RescheduleToast.js\":\"96445b607e56f27a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/dataExtension.js\":\"2ab7ba458be5dfae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/index.js\":\"bfa086245b47951d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/indicator.js\":\"d0dd7030ffd28abd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/moveSrsState.js\":\"795a315b8b655d25\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0138c89e9bfda493\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/scheduler.js\":\"0a6297a15943533e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/schema.js\":\"80920a18ef3a15c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f125ced790455672\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsClipboard.js\":\"0055f358dc5747ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"50e4fe2b77a5247f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DailyNoteReviewHint.js\":\"84b00c455b06d9bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DeckPicker.js\":\"cef5b2a4dd586cb5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewControls.js\":\"e898c2d87664f3d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewDeckRenderer.js\":\"85c41f45403b595e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewSession.js\":\"4c4df4b0914de3c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/actions.js\":\"8599f6255d69f165\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/archive.js\":\"52813541ab0cbc07\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dataExtension.js\":\"6d0828bbdf7d4331\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/deck.js\":\"d5a3ea3819cff41f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dueQuery.js\":\"da9b4ad41cfeebbe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/gradeDecision.js\":\"07ac353a939dba94\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/index.js\":\"ac195eda31de234e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/keyHints.js\":\"986267a4dd016ad7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewCardLayout.js\":\"a050edf4f80895ec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewProgress.js\":\"7ecb0f99d86a7ffd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/schema.js\":\"3f33d500d9ea4ce1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/useDueCards.js\":\"a528ef9b3e8ad0f0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/index.js\":\"c0ef4b3a266ad2c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/record.js\":\"102d882d8418f823\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/index.js\":\"9c7ab4e92f01fedf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/persistenceStatus.js\":\"2467fc6ba3372583\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/requestAction.js\":\"118bb77637235fcb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/TypeChipsDecorator.js\":\"92996979680f16ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/codeMirrorExtensions.js\":\"2a92dbf4861545c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/index.js\":\"c27fba19269d9752\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/typeAutocomplete.js\":\"e79b3fe300e85f75\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9c13181551983c62\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/actions.js\":\"2e6422262d966734\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/anchor.js\":\"f5b3099058709482\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/events.js\":\"1d7bef16b30140aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/gestureActions.js\":\"4c1c45272aa702a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/index.js\":\"7985525bf7e6dc47\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9f19c59297ad5e76\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/collect.js\":\"71b39ca6857587ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/index.js\":\"a8f33e3fe8e6aa98\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/record.js\":\"66bf83242d62bbbb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/RejectionDialog.js\":\"b3158494383585fd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/SystemStatusHeaderItem.js\":\"52f45a83e9340492\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/index.js\":\"5bd62b17f0fb35d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/model.js\":\"7bd462f9b1da06e0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/queueCounts.js\":\"a24f21504b428015\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rejectedHelpers.js\":\"1ae01dc5f1378c63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rematerializeAction.js\":\"44ce3e8bb43297ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/useHysteresis.js\":\"2d585592190141d4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/effect.js\":\"38c4ab5ae31f4299\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/index.js\":\"582ee173a8edaeb3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/theme.js\":\"bff7aefcd83aeae6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/actions.js\":\"cc9f66b36ea4c940\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/dataExtension.js\":\"61b04f1df0a4f5cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/index.js\":\"1df8422ffdda52bc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/schema.js\":\"5519002a96d23ae2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/TouchSelectionLayer.js\":\"46242f204754b58a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/actions.js\":\"a8d016fd879ea75f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/defaultItems.js\":\"ff061f22aa1ec27f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/facet.js\":\"7d0e74b4ef0cf367\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/holdRecognizer.js\":\"64ee4672039ade78\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/index.js\":\"efc4c6323b6a93e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/UpdateIndicator.js\":\"feed7fd4ac39700e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/index.js\":\"8f60590a0001fc08\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/loadTimes.js\":\"5c143d4eac0a001b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoNotesRenderer.js\":\"050f4db6b517c47e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoPlayerRenderer.js\":\"e8be781278bc7f96\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoTimeStamp.js\":\"ad9dc389ae961124\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/actions.js\":\"eb0faf6d980ae64d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/index.js\":\"82ff822adf7ed775\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/markdown.js\":\"caf60b04e7a3810a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/notes.js\":\"5c69011585e34799\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/registry.js\":\"28413258c54be374\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/remark-timestamps.js\":\"2932399a7d0f2cb8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/view.js\":\"b9e36e2bc340facc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/LinkHints.js\":\"b4db8d50b94c4ae7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/index.js\":\"fff567bba75e4ac0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/model.js\":\"3a426c70f1b4e6b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/settings.js\":\"c754ef68c1628cd4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/actions.js\":\"f4c6d8c80633e719\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/index.js\":\"2d42bc4c13c5f6fc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/interactions.js\":\"433f3311f0e67340\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/workspace-header/index.js\":\"490368d23de62b3f\",\"/knowledge-medium/pr-preview/pr-1785/src/registerServiceWorker.js\":\"e3b797da07299f66\",\"/knowledge-medium/pr-preview/pr-1785/src/requestPersistentStorage.js\":\"81fd1e29605f99f1\",\"/knowledge-medium/pr-preview/pr-1785/src/services/authRequestDeadline.js\":\"80efcdc4b4924d60\",\"/knowledge-medium/pr-preview/pr-1785/src/services/powersync.js\":\"e6d2f399ed449ff2\",\"/knowledge-medium/pr-preview/pr-1785/src/services/supabase.js\":\"ffcfcb93aa4761b0\",\"/knowledge-medium/pr-preview/pr-1785/src/services/uploadErrorClassifier.js\":\"9fa9b34d78369151\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/ActiveContexts.js\":\"d79537a327fa91b3\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/HotkeyReconciler.js\":\"35886649af922609\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/WipeLocalDataDialog.js\":\"dc2a6f6cafd88db4\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionDispatch.js\":\"0c04c5b1407acbd0\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionRefItems.js\":\"a173b84e954fee1d\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/applyKeybindingOverrides.js\":\"2d659a45c46f72a0\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/blockActions.js\":\"6e703169ff48414f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/canonicalizeChord.js\":\"810a8852ca271786\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultContexts.js\":\"055b5ea6a224a2c4\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultShortcuts.js\":\"cbae37b443fc7914\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/effectiveActions.js\":\"ab7d72d6412afd90\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureAction.js\":\"90709e93ee57064c\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureBinding.js\":\"aeaf175e215c41e3\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/holdRegistry.js\":\"4c6073a481bb8970\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingConflicts.js\":\"362aeec1c872a66a\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingOverrides.js\":\"351d2deac94a934b\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/pointerAction.js\":\"2e8db580a8b69f5f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/resolve.js\":\"eba1976276d9323f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/runAction.js\":\"0daaa7a9f69a17be\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/sequenceMatcher.js\":\"9a77bfc130148dce\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/types.js\":\"a215ffa6b03b9f0e\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionContext.js\":\"048dcb16577ee6cb\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionDiscovery.js\":\"26d68601bcc1a092\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/utils.js\":\"9441b8e5867185a4\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/bootStore.js\":\"ece0c61365d7601a\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/previewDatabases.js\":\"c9f01650b52175cc\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/byteTransform.js\":\"00dde3e6631e48f0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/attachmentCleaner.js\":\"cebef79ba9678cf3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/attachmentParts.js\":\"ca8477739855fa0e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleParts.js\":\"e0f8470fafae4a38\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleRecord.js\":\"bd40bca54fb56685\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/manifest.js\":\"3880fe763ab93f94\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/takeBundle.js\":\"9ca005f6339ed08a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/verifyBundle.js\":\"219e09f7e46c1279\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/cleaningStage.js\":\"1e111b1e298bc293\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionKey.js\":\"356f733cc2e82e9f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionServer.js\":\"148eea16797b8da5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flip.js\":\"c8910ef28f1bc0f5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flipAttempts.js\":\"7443eabd17a06610\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/pages.js\":\"f7d088aa5beb0179\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/preflight.js\":\"ee60c2bab2bd5e03\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/reseal.js\":\"29245fea04ec568e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runConversion.js\":\"cb5268cde1bcbafd\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runLock.js\":\"774373fb0026b16a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealing.js\":\"0a7c144aad692414\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealingStage.js\":\"7762631c5296238a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/stage.js\":\"35779000f67f6116\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/verifyReseal.js\":\"b0d448355aeb46f5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aad.js\":\"69abd5fad19731a9\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aead.js\":\"bc974ad8b67b50af\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base32.js\":\"26e7011bd8e129d3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base64url.js\":\"a82b159229d5e34a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/binaryEnvelope.js\":\"3b288bc192ca9aca\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/byteAead.js\":\"39c203fb8c91e4bb\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/canary.js\":\"381849d50c0ff317\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentHash.js\":\"b6a880b2cd29bd96\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentKey.js\":\"28360f19072900e1\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/derivedIdNamespace.js\":\"3a96aa82f30b8a19\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/envelope.js\":\"3d64745f458014be\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/hex.js\":\"2470c4e63829ab10\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/sha256Hex.js\":\"100287c94e0c00e3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/workspaceKey.js\":\"8ac780553cd10e9c\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/conversionState.js\":\"899f234566f5cd53\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/createEncryptedWorkspace.js\":\"52b5c2d3bdd786df\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/pastedKey.js\":\"f3c5a447136b7de0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"497192e8ff314347\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a36ded5c90ae9882\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/keyStore.js\":\"5c92b587e6e60a41\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/mintWorkspaceKey.js\":\"48a58d4924287861\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/modePin.js\":\"d848df9ba297668d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/openWorkspaceKeys.js\":\"6c4c4a9004e64d5a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolveWorkspaceEntry.js\":\"24111d7c829d8f7b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolver.js\":\"f5cbc94aaefec26b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/workspaceAccess.js\":\"acc58877567746ea\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/transform.js\":\"617d3e862905e572\",\"/knowledge-medium/pr-preview/pr-1785/src/themeBootDefaults.js\":\"88600f633ee8637b\",\"/knowledge-medium/pr-preview/pr-1785/src/types.js\":\"d82df107306dd262\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/ClientLocalSettings.js\":\"d1d204b24df07746\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/abortableSleep.js\":\"b70f8a184af1062d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/array.js\":\"c9e0aac02f2a1514\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/backlinkAutocomplete.js\":\"ff34ee630cd2a719\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockCrumbs.js\":\"d2f6b74c25be52b2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockrefAutocomplete.js\":\"ce7043ac0e5af5b4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/cadencedIdleJob.js\":\"b552795a94eb443b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/callbackSet.js\":\"837a955eec3cf4a6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/clientId.js\":\"0816d79562758280\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirror.js\":\"1d2e84cccf593949\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirrorCompletion.js\":\"957bbfb71f75b0de\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/copy.js\":\"3b861b2475afe433\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dailyPage.js\":\"a1f74d14ebecc1c4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensics.js\":\"87467d748c1e72a8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensicsHooks.js\":\"bcf2bc08a7e329e8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/deleteBlockThroughUi.js\":\"e5b088ee70d56e24\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dialogs.js\":\"dadf0d5f649b36eb\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dom.js\":\"b7ba9ac58d150591\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/downloadBlob.js\":\"9815db9e80427a44\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/exportSqliteDb.js\":\"db86fdab137fcba3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fileSystemAccess.js\":\"854169379a937fda\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/flipSlide.js\":\"23f7fb33a43125b9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fnv1a.js\":\"3bd14203ef7d77e2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/formatBytes.js\":\"8b449fdb15078b1e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fuzzyRank.js\":\"ad2da6b8ce527f2b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idbKeyedStore.js\":\"776e0d60055f4f0b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idleCallbackPolyfill.js\":\"956314280e4571bf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardAwareScroll.js\":\"f58dd4e4d1186bf5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardViewport.js\":\"e32f8b1e1fbdd8e1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/lastWorkspace.js\":\"da3b7ec37d6272bf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutColumns.js\":\"5391b60968a85515\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionDom.js\":\"2dcbc3358ed0e3de\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionId.js\":\"b4027337bdfe585b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkClickGestures.js\":\"73ed98c42b5aade3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkTargetAutocomplete.js\":\"30d8d230b945517c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbCorruption.js\":\"37210ca350b45f48\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbRecovery.js\":\"dfb3772a8d049fa5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/markdownParser.js\":\"6d32c6ea5a281639\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/memoize.js\":\"119b9a3ec45e47bb\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameFieldCommit.js\":\"24f3ac3671f2fc92\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameList.js\":\"7fa6166574162a14\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/navigation.js\":\"1fd0a1fc70de8162\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/omnilinerNamespace.js\":\"2978d76e7927a73d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/opfsPageScan.js\":\"e26cf419d9dffab4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelClearance.js\":\"b9a61f9fd0b4649c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelHistory.js\":\"41ac363479198af2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLanes.js\":\"40b26f8808663ce1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLayoutProjection.js\":\"0446b7914cb22844\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelScrollAnchor.js\":\"b92d679d0b86297f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelUrlFlags.js\":\"95f26f41eda5aa13\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/platform.js\":\"47506f0e9b696ea2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/pluralize.js\":\"62b77172bf7e1b5f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyCreation.js\":\"6b94a708558a1791\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyNavigation.js\":\"987a60e739daaaeb\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyValueContext.js\":\"7ab691f589fddfe4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/react.js\":\"80a37dac3a33c787\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeDate.js\":\"b39f4b55037d3629\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeTime.js\":\"e0aabbe5a3e36d5a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/renderScope.js\":\"57414fd2af4cba7b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/resolvedThenable.js\":\"df8c7e56eac161bb\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/routing.js\":\"df5422bf8a9122b9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/safeMode.js\":\"905ba6b788e0e06e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/scheduleIdle.js\":\"ffd23b046ef9ce7e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/screenWakeLock.js\":\"630e8a3295e800c8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/selection.js\":\"9b99c6449328fa85\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/softKeyboardGrab.js\":\"4747b152207d268a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/startupTimeline.js\":\"922203c079c02132\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/state.js\":\"fe3b0d22b8572072\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/string.js\":\"a30053a47a4bc3c2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/surfaceZoom.js\":\"4fa35f79695fcf23\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/time.js\":\"3350580332f8a941\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toast.js\":\"65df71177a5330ac\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toggleStore.js\":\"c2794d1c31f4d34a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/untilStopped.js\":\"e3bad53cca3bfb5e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/userActivity.js\":\"b3a9b48422ea341c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewTransition.js\":\"2da04ba20c086dd4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewport.js\":\"d831f90d94499c99\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/webLock.js\":\"e31264f1e5ea1587\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceRecovery.js\":\"31ffb332924116b8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceSnapshotStore.js\":\"8c03f69fd34c46d2\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-compiler-runtime.js\":\"f1ea44ebfd456344\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-client.js\":\"ee451ed5efa0f3d9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server-edge.js\":\"eac52233b794948e\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server.js\":\"b6921ce293ab9c61\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static-edge.js\":\"0c6e58061ae12578\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static.js\":\"863ea89ee692134e\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-test-utils.js\":\"155630b05919920f\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom.js\":\"bb365722b3d4205f\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-runtime.js\":\"80130b1dbfb11de8\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react.js\":\"9761cb72f97b16ad\",\"/knowledge-medium/pr-preview/pr-1785/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
