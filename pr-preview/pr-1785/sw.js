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
		buildId: "c85681651b12-99f3487e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/\":\"ccb8b83368160957\",\"/knowledge-medium/pr-preview/pr-1785/index.html\":\"ccb8b83368160957\",\"/knowledge-medium/pr-preview/pr-1785/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1785/assets/FacadeVFS-CVO9VvLh.js\":\"a72dd069a3dcd297\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSCoopSyncVFS-QEXZOHY6.js\":\"267100346ab65de7\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSWriteAheadVFS-DyHWk-A9.js\":\"5e3b88b0d981d8e5\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-BCoQ-Mk_.js\":\"b7f21f9931401380\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-bt34Lkd4.js\":\"3a403ed695c38ed2\",\"/knowledge-medium/pr-preview/pr-1785/assets/worker-Btkd33Go.js\":\"8c8d80e5d4571ca3\",\"/knowledge-medium/pr-preview/pr-1785/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1785/chunks/app-XY2X1QlB.js\":\"314d7cc1b80c8a6f\",\"/knowledge-medium/pr-preview/pr-1785/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1785/index.js\":\"6c9087936d92fe6a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1785/assets/AccessHandlePoolVFS-D7noHMPx.js\":\"299fe5ae169288ea\",\"/knowledge-medium/pr-preview/pr-1785/assets/IDBBatchAtomicVFS-C6fbvlTa.js\":\"6162a432740d4178\",\"/knowledge-medium/pr-preview/pr-1785/assets/MemoryVFS-CW6xh3Gs.js\":\"9b290ce7d1e4b74a\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-DL3tp13A.js\":\"f4971c06c5acaf4f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-CLmbv2JP.js\":\"f9ecf3376b19ee8f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1785/chunks/AccessHandlePoolVFS-BDFFj7aB.js\":\"08c87d3d662f2d72\",\"/knowledge-medium/pr-preview/pr-1785/chunks/FacadeVFS-Dq6zhJlo.js\":\"e0bc101b565328c7\",\"/knowledge-medium/pr-preview/pr-1785/chunks/IDBBatchAtomicVFS-DwcmapCG.js\":\"22c7b730ad6121d6\",\"/knowledge-medium/pr-preview/pr-1785/chunks/MemoryVFS-DHJMRSP2.js\":\"269895b760e48486\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSCoopSyncVFS-kS9t4znt.js\":\"987de56fb458e9e0\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSWriteAheadVFS-TxfyaPV3.js\":\"96f15dcfe3229525\",\"/knowledge-medium/pr-preview/pr-1785/chunks/Preview-G8a72uuW.js\":\"0316eb1e6cbae7b4\",\"/knowledge-medium/pr-preview/pr-1785/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/card-BfI5ryPk.js\":\"abb3d5bfdd99ef4f\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-B97PNjEN.js\":\"9292253789b578b4\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-Dj7L1Lp9.js\":\"e75a8a898fa140b2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-async-Cg3xpB9Z.js\":\"b9df5e1c5fc8388e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-BAcrPEE9.js\":\"3c61c0f781139ddf\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-BSS6GtNO.js\":\"959fb393b3e062ec\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DB6pvZmr.js\":\"0bf0d2d0a514767b\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DSXS7MV7.js\":\"2abbd75449adae46\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DemIcngZ.js\":\"58f4006f228222c8\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-Den75Q1D.js\":\"93213e23c5fd622c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DwTo3K8K.js\":\"cdf1f1dee647d974\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server-legacy.browser.production-D0dkMP1R.js\":\"9add2025d9001532\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.browser.production-CgJAEt8-.js\":\"cfb07051c2cc8934\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.edge.production-Den4vxji.js\":\"5b0ec3f095540d17\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-s63HW415.js\":\"96eca38b2b8075b6\",\"/knowledge-medium/pr-preview/pr-1785/chunks/server.browser-CdZlRLb6.js\":\"27486311823d5b8a\",\"/knowledge-medium/pr-preview/pr-1785/chunks/textarea-UgdXxf8a.js\":\"7e3f781e7e6a8f0a\",\"/knowledge-medium/pr-preview/pr-1785/chunks/ui-5taRybT-.js\":\"de7393a100d1d5dd\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-async-QL25ThzH.js\":\"32841ee9e9a4e632\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-fcvHB7So.js\":\"f2776e1b3c1db722\",\"/knowledge-medium/pr-preview/pr-1785/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1785/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/src/App.js\":\"ecd3d0cea414ba5d\",\"/knowledge-medium/pr-preview/pr-1785/src/appUpdate.js\":\"f1d07cc32d8cc5aa\",\"/knowledge-medium/pr-preview/pr-1785/src/appVersion.js\":\"2c13642fc66f0ed7\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/initialLayout.js\":\"c8c134678dae3ae5\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/resolveWorkspace.js\":\"fb08160e734b7e38\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/workspaceBootstrap.js\":\"6f003becbbd70264\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockComponent.js\":\"c6885c9a5d8adcfe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockCrumbs.js\":\"736a6e8d015066ed\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockEditor.js\":\"367ec46cc698b200\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockLoadingPlaceholder.js\":\"47d94c1c866e989c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockProperties.js\":\"bf0c5b14a87ab553\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockSearchPicker.js\":\"a603ec19dd98cdf4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ConfirmBulkDeleteDialog.js\":\"ee13db73fd10e548\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DividerHandle.js\":\"c766a7d4f3a506c4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DraftEditor.js\":\"c9b26d68a0e743d1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/GutterPill.js\":\"9a7cf87daf928839\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Header.js\":\"6540ef2b1f323bbd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/LazyBlockComponent.js\":\"0c8025b2315fb54d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Login.js\":\"3f165439a8af05b6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ZoomableSurface.js\":\"6e92bedcb2b9c6da\",\"/knowledge-medium/pr-preview/pr-1785/src/components/editModeKeepalive.js\":\"009ecd7d7ff49092\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ba5ee413e14e0159\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e8576c0370e0db2a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefPropertyEditor.js\":\"ea7b92f9e641e3b4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefTargetTypePicker.js\":\"600148259f8672fa\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/SelectPropertyEditor.js\":\"60a015af17ba7b42\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/TypesPropertyEditor.js\":\"08f78bbc4d1c96fe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/defaults.js\":\"d05ae83abf6e4001\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/kernelValuePresets.js\":\"f8eef9637379b0f0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/selectablePresets.js\":\"6f8f4b74e80ea7ce\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/typesPropertyUi.js\":\"2f8568c9ad0b643b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/AddPropertyForm.js\":\"0b88cba4214dd45c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyPicker.js\":\"906d5784ea7870b3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyRow.js\":\"872addd989872156\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/Rows.js\":\"a1786ddc05d2768d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/actions.js\":\"29b2d8f299647d5a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/declarationOnly.js\":\"193b1750288bb3ed\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/layout.js\":\"9ee143bcb8c8873f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/model.js\":\"1a2bae81531c47c7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapeUi.js\":\"570c88f66658163b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapes.js\":\"054a9313c7288c23\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8149b5d8c5f12733\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/visibility.js\":\"079715de6fa27ebc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanelSections.js\":\"a2a578136268dbf9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockEmbed.js\":\"8b80b0bb18d1a6d5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockLink.js\":\"3cbf65a0ee543672\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockRef.js\":\"92f8b8232f453bff\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/ReferenceLink.js\":\"b5e0bd91568506a9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuard.js\":\"739575ebe57b1eb2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuardContext.js\":\"bbaf3f969834bcba\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/linkInteraction.js\":\"30354eecf6a1e272\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/referenceLayout.js\":\"610f4195347dc478\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/useBlockRefAncestors.js\":\"bca1d1689c419ff0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockGutter.js\":\"536a26f64a7c8c08\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockInfoDialog.js\":\"dafa7e9712edf7b6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockTypeBlockRenderer.js\":\"161286ca8d949c60\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BulletHoverCard.js\":\"012376d28f696aeb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorContentRenderer.js\":\"f1ca7dae38258be6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"63050d4c04eb8b92\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ColumnResizeHandles.js\":\"080022aee06672a9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"28663a44c6ab756b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/DefaultBlockRenderer.js\":\"7170f3424b71a4c7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/LayoutRenderer.js\":\"ba31506d36072c46\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MarkdownContentRenderer.js\":\"e64e85a25fa4d287\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MissingDataRenderer.js\":\"20e38fccc1198bf1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PanelRenderer.js\":\"a04b4b0c40bd5147\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7f3f17034434b8c3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/TopLevelRenderer.js\":\"67b1328d81bea4cd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockGutterMode.js\":\"2ae3c2c6b5505055\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockTitleText.js\":\"8f56c4774963740d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/fieldCreationKeydown.js\":\"d192c114625b4dcd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/layoutRootContext.js\":\"6ddd0340731c94bb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/TypeChip.js\":\"a2dd4b8678bbc56e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/chipStyle.js\":\"8daff4fa95c859ef\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/anchored-floating.js\":\"d6b9cca43e29f910\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/button.js\":\"c844babfef6d5d9a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/card.js\":\"c48e61ab2112ef79\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/checkbox.js\":\"7b448a53487743d5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/collapsible.js\":\"37c1bac94ddded98\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/command.js\":\"258796fcd6726f20\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/context-menu.js\":\"89c3742224facef3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dialog.js\":\"592f19ebe168da41\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dropdown-menu.js\":\"480e75b9f5f6800c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/floating-listbox.js\":\"e98e1ae987e8a300\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/index.js\":\"3ff1cf505258276e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/input.js\":\"bfbf8efcac05ccdb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/kbd.js\":\"db31b668eb5700ae\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/label.js\":\"b413aa5138912e53\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/textarea.js\":\"2acb7ccc3fdc51c8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/useEditModeYieldKeepalive.js\":\"17573d895d60f0b0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/BootFallback.js\":\"45679dcba2287559\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/FocusedRowLazyMount.js\":\"2e638ca4520deee7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LazyViewportMount.js\":\"af3e5c7de8592e52\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LocalDbCorruptionFallback.js\":\"8c9da2a5e124da1d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/error.js\":\"ae8fa3bae353a846\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/lazyMountRegistry.js\":\"92b543e4218caf33\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/suspense.js\":\"33a1601bb0856880\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/CreateWorkspaceDialog.js\":\"3925ddcdfcb8c200\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/PendingInvitations.js\":\"419a12bbe4e25540\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/SyncProgress.js\":\"d399362ae139de79\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/UnlockProgress.js\":\"2ee9bea2ac8f0e5d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceKeyGate.js\":\"2a0b295eeb9382c6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSettingsDialog.js\":\"2d624b837ff348a8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSwitcher.js\":\"5331724d7d7e0092\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSyncGate.js\":\"300d6940d188bfeb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlow.js\":\"e7daced98ba98d73\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlowHost.js\":\"a815d36d649c19d6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/EncryptionSection.js\":\"45127c98e6c2f10d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/attachmentPrompts.js\":\"e0e4bea56a617f56\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/bundleFolderPrompts.js\":\"278d478a05cf06e2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowDeps.js\":\"490fe71d3c1e0821\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowStore.js\":\"08d806bea1c35b41\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/flowUi.js\":\"91c87a421e28a03c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/useConversionRun.js\":\"6ba3a4ec2624473b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/keyUi.js\":\"08fd1c52a8e793a6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnKeyLoss.js\":\"fe0565566ed5e653\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnServerE2ee.js\":\"7c9fa188eed13ed3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/workspaceUnlocked.js\":\"75e938d471101c09\",\"/knowledge-medium/pr-preview/pr-1785/src/context/backgroundSubtree.js\":\"7ab846a5d712950e\",\"/knowledge-medium/pr-preview/pr-1785/src/context/block.js\":\"c4d87db55e105b8e\",\"/knowledge-medium/pr-preview/pr-1785/src/context/layoutWsContext.js\":\"18e159f3fdd19079\",\"/knowledge-medium/pr-preview/pr-1785/src/context/propertyDisplay.js\":\"bda04b33f905d454\",\"/knowledge-medium/pr-preview/pr-1785/src/context/repo.js\":\"9d79692a96f4ac7b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasClaim.js\":\"8f723af52992c129\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasSeatNamespace.js\":\"385bdd3aae3b7ccb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockData.js\":\"478750069a62cc5a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockType.js\":\"5fecf98dcf04eef8\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/changeScope.js\":\"dec7bdcd964245b3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/codecs.js\":\"b4406653b6281353\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/derivedData.js\":\"42a22ae062005487\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/errors.js\":\"7475ea89ab4230d0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/events.js\":\"7042921514fff908\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/handle.js\":\"7a8c2ff5d8f74e7b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/index.js\":\"3f79ce288ca3486b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/mutator.js\":\"933fdf4c5e66e09f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/processor.js\":\"626b97d97ddcd896\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/propertySchema.js\":\"72e86f13593ef74e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/query.js\":\"6673e0ef089ac848\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/sameTxProcessor.js\":\"983b6e48925fff90\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/schema.js\":\"7a8c2ff5d8f74e7b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/tx.js\":\"7a8c2ff5d8f74e7b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/typedBlockQuery.js\":\"5832b076d6987b41\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/user.js\":\"3f954067021abeb0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresetCore.js\":\"dd6ea8162c5daf2e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresets.js\":\"47ad487fce159a74\",\"/knowledge-medium/pr-preview/pr-1785/src/data/attachmentCleanerIOVerb.js\":\"097b91d366205b8e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/block.js\":\"380a05f66d1180a2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockCache.js\":\"4c45539e0cebd8aa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockId.js\":\"fe61d424237b9eff\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockLiveness.js\":\"bd58df1e974029d2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockMerge.js\":\"47efa8844e6254c3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockSchema.js\":\"c8cac348e3254d80\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockTypes.js\":\"71011652cfb1102f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/clientContext.js\":\"65d893cae70937a5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/dbFileSiblings.js\":\"d8e333879cbf3e75\",\"/knowledge-medium/pr-preview/pr-1785/src/data/definitionSeeds.js\":\"5bc83a96d7e83dcf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/derivedIds.js\":\"beb30fca208a5a52\",\"/knowledge-medium/pr-preview/pr-1785/src/data/drawnSubtree.js\":\"7dc689dcd2be1a90\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facetBridge.js\":\"38e1d26a07c310cf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facets.js\":\"f5e2d9db6e342031\",\"/knowledge-medium/pr-preview/pr-1785/src/data/globalState.js\":\"fcd8735e92e907c7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/aliasClaimRederiveProcessor.js\":\"b7d76caef7b7e9d6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/ancestorBatch.js\":\"49ad3bba39212a24\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/blockTypeTypeifyProcessor.js\":\"adddd273192c48ba\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/clientSchema.js\":\"46cb1c2d8796a7b4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/commitPipeline.js\":\"2025aaee945fe0af\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/devAssertions.js\":\"8a3d6c164f2512da\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/firstSync.js\":\"bfe3c5cc138edf65\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/freshInitialLoad.js\":\"40e1df579b329a42\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/graphBackfillClaim.js\":\"644e4056d40e8316\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/handleStore.js\":\"6e681398e276f322\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/idleMarkerJobs.js\":\"407a11da112fd2ee\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/initialDownload.js\":\"85df7f55cb1ce933\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/jsonCanonical.js\":\"32b110c6f608a757\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelInvalidation.js\":\"2dab96218d1bb063\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelProcessors.js\":\"611bce09eb31276a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelQueries.js\":\"d0e6e57e78ca1f9b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/mergeTypeMembershipProcessor.js\":\"668f12a71d753b8e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/normalizeReferencesProcessor.js\":\"b99e2c6d76b57d1a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/poolInstrumentation.js\":\"d910be7411a25180\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/processorRunner.js\":\"4976682b7e0755af\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyCellBackfill.js\":\"a71822fe35dac358\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildMint.js\":\"76077c7c961daf1d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildrenProcessor.js\":\"455a8313a5701e19\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionChangeProcessor.js\":\"906f41d92c0ac737\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionSynthesis.js\":\"d839fcf080325d9b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyKeyScan.js\":\"4e96f6be814ca48f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertySchemaResolution.js\":\"941336f4d065b64d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/raiseProtocol.js\":\"d8dd6ca25099558e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/readBatch.js\":\"9542554f9fbbc2b1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/refProjection.js\":\"d6b95ad365cd22b2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetLookups.js\":\"2fe3b9e85dc8c46b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetProcessor.js\":\"384262030ba5f0e2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/replayMerge.js\":\"89298182cc5488cc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/sqlBinds.js\":\"52953e231f11c040\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"007ef6a85aecac3f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/arrivalProcessors.js\":\"f343cf3ad7116cac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/invalidate.js\":\"43f35b3ad9d3679f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/materialize.js\":\"eec521a34897c2c1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/observer.js\":\"7e1b85c1da2266c9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/reconcile.js\":\"8560086bfcc119e8\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/timingMetrics.js\":\"828fdd5752bd4ec3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/treeQueries.js\":\"9868a27b5a94a2fb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txEngine.js\":\"ccad143b8ee90b0d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txSnapshots.js\":\"cdc6c067faaf6475\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/typedBlockQuery.js\":\"ac852c4357a15267\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/undoManager.js\":\"33ac11c4fb4edf2a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/invalidation.js\":\"dafc2b6214e19fb6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelDataExtension.js\":\"41e642cb13ffffd0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelPage.js\":\"2c60737a49614026\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelValuePresetCores.js\":\"ba7f24a6789482a7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbCorruptionSignal.js\":\"d3e63c576a4d5678\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbStorage.js\":\"0908afd88daf184a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbVfs.js\":\"0a9ce47b58700b82\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localSchema.js\":\"fa3bca35faaa58da\",\"/knowledge-medium/pr-preview/pr-1785/src/data/maintenance.js\":\"aa3936c01b407ca0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mergeProperties.js\":\"877273a3a6a218b0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/metricsConsoleHook.js\":\"55ff6a91224d45ce\",\"/knowledge-medium/pr-preview/pr-1785/src/data/migrationsPage.js\":\"94e51ec307ab519b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mutators.js\":\"13ea4ba15b0ac28a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKey.js\":\"35c79e5aed16d1f0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKeyPlacement.js\":\"773f89d7513a4441\",\"/knowledge-medium/pr-preview/pr-1785/src/data/outlineSurface.js\":\"d2f6a4a6d2201b6a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingEditorContent.js\":\"bfc89d28005ce99d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingUploadsSql.js\":\"e5d32afdc79815e5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pluginStateExtensions.js\":\"9815c7ae9e520a53\",\"/knowledge-medium/pr-preview/pr-1785/src/data/powerSyncLogger.js\":\"7aa697160086e70b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/projectorRuntime.js\":\"ab06c3f44c7e5f09\",\"/knowledge-medium/pr-preview/pr-1785/src/data/properties.js\":\"79b530c2efc7543c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertiesPage.js\":\"93525507c9720fde\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyChildren.js\":\"f6fbc6e8fdd98849\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionFanout.js\":\"b0237aa705621fd9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionMetadata.js\":\"3201b4e4a9196f9d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionRegistry.js\":\"6b77fd90f697e2d2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDisplayMode.js\":\"576be2599dfe9443\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyRowCreation.js\":\"97543cc3a007c174\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySchemaCreation.js\":\"2bfd29f4509f8851\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySeeds.js\":\"b3a9c36fc6990b7d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/recentsPage.js\":\"e1ae065e5a491038\",\"/knowledge-medium/pr-preview/pr-1785/src/data/referenceBlock.js\":\"2e4686ee0f403617\",\"/knowledge-medium/pr-preview/pr-1785/src/data/releasePowerSyncConnection.js\":\"4d3d6d00aa5711f9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repo.js\":\"75358c86ae0acb58\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repoProvider.js\":\"eff11e2ceb39df9d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/rowProperty.js\":\"c31007a5beff6a91\",\"/knowledge-medium/pr-preview/pr-1785/src/data/searchFilter.js\":\"4ab5c6e75b42b866\",\"/knowledge-medium/pr-preview/pr-1785/src/data/seedIdentityLedger.js\":\"8445a2fe34b933c7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/stateBlocks.js\":\"95d9c8f192c280fe\",\"/knowledge-medium/pr-preview/pr-1785/src/data/structuralEditPolicy.js\":\"a19af630149aa542\",\"/knowledge-medium/pr-preview/pr-1785/src/data/subtreeDelete.js\":\"1162b3d8daeb43c4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncStreamLock.js\":\"c30f86e6ff88e6a2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableSqlRecognizer.js\":\"4303964e8a745e7f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableWriteGuard.js\":\"dff3827e190378b4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/targets.js\":\"e27054db72f64fd3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeColors.js\":\"8ecba8009a658ad9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionMetadata.js\":\"b2f5140cad554561\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionRegistry.js\":\"bc451cd7ac2e4cb7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeExtraction.js\":\"3c9ead5ccfbb1e98\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeInitialValues.js\":\"3225fff4a076f5b4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typePropertyGroups.js\":\"a167b0ab740058b4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeSeeds.js\":\"1f39ce64dbae9c4c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeTagger.js\":\"b65ad777b648b158\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typedRecords.js\":\"1e74d13c54762ad6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typesPage.js\":\"76c48d49f2103c56\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userPrefs.js\":\"545ae29e499393bd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userSchemasService.js\":\"5a9fa2f6108f1b9d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userTypesService.js\":\"8a103385e713acb5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/valuePresetRegistry.js\":\"bc16df73e130567d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/visibleChildren.js\":\"410635e51d0ab3d1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceConversion.js\":\"131bd7b76d883097\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceFirstSync.js\":\"0e49aaba42500e61\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceIdNamespace.js\":\"68b7f96012378a08\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceSchema.js\":\"c38866b62339717c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaces.js\":\"e474c8136ad6d609\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadLog.js\":\"44b8d2b6c30f7130\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/BlockPasteShellDecorator.js\":\"e5be0e7da558188d\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/atTrigger.js\":\"2c84214a28627b52\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/autocomplete.js\":\"6c536e18cda6b73e\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/codeMirrorExtensions.js\":\"1abf3f47792ea9b6\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/contentFlush.js\":\"54eafd19078fc7c1\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/defaultInteractions.js\":\"3d3b96c2fe5c77a8\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/editSettleSignal.js\":\"dc37fa376eaeb949\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/insertImage.js\":\"5c914708230bd53c\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceCompletionRange.js\":\"27b8edcf0e616f3d\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceTargetTypes.js\":\"bfc0171e78d480f2\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/syntaxContext.js\":\"8985268d9c3e3561\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/triggerMatch.js\":\"9db5331f45670975\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/AppRuntimeProvider.js\":\"a0ffd1002299b36d\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/BlockFocusShellDecorator.js\":\"fcf6cd6c928292e6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/ExtensionRenderBoundary.js\":\"9619c556d8ce5ea2\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/PanelContentRecovery.js\":\"f2169f751077602e\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/apiCatalog.js\":\"e4393e3c6b32e82e\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/approveExtensionHere.js\":\"c9c6bbbc53d25440\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/armedCutAppMount.js\":\"0a8d469f79acbb24\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/batchableKeyedStore.js\":\"461816978dca22ad\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockInteraction.js\":\"2378cb76120e4906\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockSelectionAction.js\":\"50a50850fcf5530b\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compileExtensionModule.js\":\"f34f92f70d4acafa\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compiledModuleCache.js\":\"9529bc351aeaf221\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/continuousGestures.js\":\"bdafcca8e7f9cbba\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/core.js\":\"ebf69dbe59263420\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/defaultRenderers.js\":\"e7237f934f939d0e\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/definitionFanoutAppMount.js\":\"f6ba98cbb7d54af5\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dialogAppMount.js\":\"92acafc9bfd3c940\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensionSeeds.js\":\"ea4774efdabb5aa6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensions.js\":\"878219b0b042f073\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/exampleExtensions.js\":\"b91acf8185e98f87\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionApprovalStatus.js\":\"d50195978fc7caa5\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrorToast.js\":\"5f391789e6733844\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrors.js\":\"e99ad58cd0d22b80\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLookup.js\":\"2063543d6b1b0914\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionToggles.js\":\"cb99355f50db8db5\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionUtilitiesCss.js\":\"0a064f600ccc98e7\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/kernelPageDeletionGuard.js\":\"2921ceeea7ac371b\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/liveRuntime.js\":\"0ceee593cd2508d2\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/openExtensionsSettings.js\":\"ef99a63f8ccab8da\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/overridesCache.js\":\"bc339dadb0907581\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/pluginIds.js\":\"c0384770de0e9453\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/processorRejectionToast.js\":\"348178247850a279\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeActions.js\":\"f1be6b075fdba9d6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeContext.js\":\"b4b722b468a729cc\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticAppExtensions.js\":\"1e80e3936373a5c1\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticDataExtensions.js\":\"c08c77014e50919b\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/toastAppMount.js\":\"2251eaab6ebbe4cb\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useOverrides.js\":\"9cbd2d2c62023313\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useShortcutSurfaceActivations.js\":\"186a164d59bfa32e\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/discoverToggleTree.js\":\"50f0205c0a649166\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/facet.js\":\"bcdbc60e4a2cfe52\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/resolveAppRuntime.js\":\"8d4e40852f882973\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/runtimeEvents.js\":\"2b105241111c6976\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/togglable.js\":\"99bef413a244602e\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/variantFacet.js\":\"0f229540073bdb27\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/verbFacet.js\":\"b3917cf85522f071\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/block.js\":\"54f769e033e1593f\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/focusedChild.js\":\"94b4059705847f8c\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/propertySchemas.js\":\"1d4e4fe63df9eb3f\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/typeRegistry.js\":\"9c041ca680c73daf\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAncestorCrumbs.js\":\"85d98c2795e7cbfe\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAutocompleteListbox.js\":\"e1b7aa0c685fc088\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedSearch.js\":\"2df0ce97814181a8\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedValue.js\":\"dfb0e72547e8054b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsFocalRender.js\":\"0b1fde266873fc9b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsReadOnly.js\":\"111ea02d2823e546\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMaterializeBacklog.js\":\"b9a98fb13152b734\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMinuteClock.js\":\"6cda700d7c96b263\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePanelLayoutProjection.js\":\"4d9daa4d3db05160\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePendingInvitations.js\":\"db60eb9b7cf8ad6b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRendererRegistry.js\":\"9c2289e8ee4da9c7\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRetainedFieldRows.js\":\"57c1b1fc05425c5f\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useWorkspaces.js\":\"77203a43a72e8577\",\"/knowledge-medium/pr-preview/pr-1785/src/lib/utils.js\":\"704d024811e4ae4f\",\"/knowledge-medium/pr-preview/pr-1785/src/main.js\":\"b1be89471ff68508\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/MarkdownImage.js\":\"5d400b14bfa9a5ef\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/blockSeparators.js\":\"5925d2a581c97df8\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/context.js\":\"633f630541c719aa\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/defaultMarkdownExtension.js\":\"9ebe298e875decb3\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/extensions.js\":\"2b07c33c537ed407\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/renderMarkdownHtml.js\":\"4ac91ee852fddc62\",\"/knowledge-medium/pr-preview/pr-1785/src/minimal-editor.js\":\"a823501aa602071f\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/armedCut.js\":\"27f7eafa0b01b3af\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/captureMediaVerb.js\":\"260965b49e83f7f4\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/clipboard.js\":\"302f6e5dfad3734b\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/decision.js\":\"75416d2049708c73\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/operations.js\":\"3cff848ea4c85341\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/AccountHeaderItem.js\":\"7a2b9909fac41116\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/index.js\":\"254264ba2beba593\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ffce12c2e057a2ac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askAgent.js\":\"4ec85af5fdae05ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askedStore.js\":\"e08fedf07aa4fbd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"410eff94256f5318\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/chipState.js\":\"dc93fecfb7a97f4f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8926605010db5bfe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/index.js\":\"245da03e041cfc91\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c8f21ef0f73319bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/schema.js\":\"90206b5f5acf3cd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c268bf451c557a00\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fc9c5642987de4ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/addMedia.js\":\"6564a233293db0fa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/backlinks.js\":\"365cef3007d8d939\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/block.js\":\"1d4ff0a2b9f5c00a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/context.js\":\"98d11d4d3f1b737b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1465042681ca6d53\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/index.js\":\"6004a3b285f24371\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/outline.js\":\"dbb2c9709d9cc9e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/properties.js\":\"af873fb8a3c055e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/refs.js\":\"f575e73fade0d936\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bc65c9773985d0d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/search.js\":\"5c9a45a929b7a04e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/shared.js\":\"9f999b145161e049\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"973e36b0f6b1079f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/text.js\":\"b9afd8bd251974c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentWrites.js\":\"93e9bd1fa960600a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/authoringCatalog.js\":\"5a7089e305cb0ecc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/blockRefTargets.js\":\"38105495d8e7bd75\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridge.js\":\"5a6563a3d6ae2823\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridgeLoop.js\":\"29ccbd35876a1d8a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/changeHistory.js\":\"4caf668557708097\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commands.js\":\"ca01d630feb610a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commentsCommands.js\":\"1489dcde43f16635\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataExtension.js\":\"1edde54e24e93659\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataModelGuide.js\":\"f2fdd29f050fdb18\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/describeRuntime.js\":\"cde9dff1dc398baa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/extensionLint.js\":\"156c090130971952\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/grainAudit.js\":\"12628466a7a3e93f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/healthCommand.js\":\"0ffe15d9eb2edf52\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/index.js\":\"63e755d8489dc0cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/presetIdentity.js\":\"965090bcbba04171\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3b1dcc515b63f10a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/readMedia.js\":\"312357ac1e8c44df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/schema.js\":\"23cbd468c2b94f10\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/serialization.js\":\"290f9518d32fd8b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/targets.js\":\"0f2083cdd93db514\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/tokens.js\":\"2348ef5d3bc35065\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/watchEvents.js\":\"f71f5e4247008fd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/workspaceGuard.js\":\"a4e6ce6a42ae4ac4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/writeCommands.js\":\"c88040c5701d6c9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/AliasCollisionToast.js\":\"082b256485d9e9be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/DuplicateNameBanner.js\":\"b123b9224fa152f1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/collisionMerge.js\":\"7ff2ded3351dfb1a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/dataExtension.js\":\"5776d56a6bd364f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/index.js\":\"2d84389128478bc1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/mergeCollisionAction.js\":\"97b3fa21b44f59b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/pageStyling.js\":\"6c2972945a3e26ed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/rejectionToast.js\":\"a62e1d32476487fb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/syncProcessor.js\":\"0805fe846f7affdc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/actions.js\":\"03e1521babde8a13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/addComment.js\":\"8ed6cb510be23555\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchor.js\":\"4d7d88256623ac98\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchorState.js\":\"34290584808eccb7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/commentLinks.js\":\"0026bd3796f32d90\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/confirmThreadDeletion.js\":\"579d7db927247460\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/container.js\":\"c340622b2008e754\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/dataExtension.js\":\"f542d8916abcd454\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/deleteComment.js\":\"4b6504dbb823be54\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/highlights.js\":\"2c3d6448c8225b86\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/index.js\":\"5e0c5ad617c61462\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/linkedCommentsPill.js\":\"30f982babadaecfa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/margin.js\":\"2b2e1c60b0eb0b93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/marginSchema.js\":\"663c64d2b28c3db0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/newComment.js\":\"a5d1070fcca59597\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ownThreadPicker.js\":\"23886f08d027a70a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/placement.js\":\"93ce56095f23597d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/queries.js\":\"76aee62288323107\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotePosition.js\":\"f9e389de5cafcadd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedIn.js\":\"5f6a846efae3dbba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedRange.js\":\"b5c7334640511bfd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/rangeRefs.js\":\"c57300372cc92f98\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readHighlights.js\":\"02c10c61325969ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelection.js\":\"5cc8f241ec34c10b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelectionUi.js\":\"d0e41ff1e7f4f37d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/reanchor.js\":\"df02b1087757b330\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/schema.js\":\"240eb89bea41a18b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scope.js\":\"61829886fc031bc0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scopeThreads.js\":\"2bb96b089cd75271\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/splitRetarget.js\":\"03576cfba4906a6c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestionCard.js\":\"32e5ed97d90a96c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestions.js\":\"c9a1027ed490a502\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaries.js\":\"1a1c079f071fb978\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaryBatch.js\":\"1be355423f00daf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/surface.js\":\"a1f54254e0cff27c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threadNavigation.js\":\"818252af08b74a4a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threads.js\":\"1e22c784b80c98f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ui.js\":\"a7081b7de0b1b78c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/uiStore.js\":\"10721c0fd58ff143\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/appIntents.js\":\"fac5d96cfac964cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/index.js\":\"5db77341beb6fdf1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/index.js\":\"3a48aa99815c7ae3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/status.js\":\"38063c9f55dd9188\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"aef31e3ff6f48324\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaBlockRenderer.js\":\"77d7752a0673f426\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaDownLaneReplicator.js\":\"71dd396154ed345b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaUploadReconciler.js\":\"4de1f9795b5d8c2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetDownLane.js\":\"5d70e0d712f9efd7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetResolver.js\":\"656c49022b7b03b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetUpload.js\":\"d22577d99a787ecb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/attachmentCleanerIO.js\":\"2aa9aa22447ec60e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/supabaseAuditIO.js\":\"10e7f7b3650d0e9b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/blobStore.js\":\"654335c7de160278\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/byteStore.js\":\"e90a92ccd86287b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanerIO.js\":\"2c354e7267fd034a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanupAttachments.js\":\"02b239dd2ca4b889\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/dataExtension.js\":\"b2d1b33abe70bfa8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/downLane.js\":\"4f55bfa527650a16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/index.js\":\"5fe14ef8c70031cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/insertImageContribution.js\":\"215878edf1b8322b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneArming.js\":\"46a881b538171c5f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneLock.js\":\"9663fe3554cf8c8b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaBlock.js\":\"f801c015d82aca88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaCapture.js\":\"06d2ffb6d6c16f58\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewers.js\":\"8f2532ba8d60f0e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewersFacet.js\":\"41c560e123a44bdd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/pasteCapture.js\":\"d24630e95a24b3b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/resolver.js\":\"8ca3de0d63ef8654\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/retryUploadsAction.js\":\"6c4468d5301598bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/storagePaths.js\":\"a027ad4cb7b50054\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadDrain.js\":\"b44b13d7f47c102b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadLaneStatus.js\":\"e85f9ee26a6dd999\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadReconcile.js\":\"fc1c8bb2a74bf815\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadRecovery.js\":\"cfe2fb4c84f6d8be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadStore.js\":\"703bf6968e00d8ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/useAssetObjectUrl.js\":\"28455e650d238abd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c7621c498d5d789f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bd69539b66aa34d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/facet.js\":\"2091ddaca756ba34\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/index.js\":\"e39d2ff7887845ed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/prop.js\":\"13701f685b307eb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinkFilters.js\":\"08f6a4aa3a8f7e8b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4bbbc74915173f9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BlockEntry.js\":\"f75eb57248a5998d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/LinkedReferences.js\":\"934f26c0370976fa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bcbe4989528ee628\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dailyNoteDefaults.js\":\"09f40f57e360404d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dataExtension.js\":\"d425486ffb1a9fc8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/edgeExclusions.js\":\"12c355dcf2da8c2e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/filterProperty.js\":\"d6a4bae5292e5b38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/index.js\":\"fbb55cf0a6f49982\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"285209c42c81ccf2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/applies.js\":\"7beb8b1397f225e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/countQuery.js\":\"27329ffe7fd669c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d7fd23da6915831d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/index.js\":\"42d754b3cd529133\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ba8d76c293e8d79e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/presentationInvalidation.js\":\"9b359ed82ecada52\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyEditorOverride.js\":\"6579bb1f9719c0db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyFilter.js\":\"4e65670d14768ac9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/query.js\":\"bb0e060a7b083f0e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/resolveFilter.js\":\"52e6b012be9a6938\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sourceBatch.js\":\"3de1448e0607d590\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sources.js\":\"cd00abec7d4fb11d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useBacklinks.js\":\"0f5cfbb9ff5643f1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c6255b63f1016c7f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayCelebration.js\":\"6a2557ed40ef9ab2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayOverlay.js\":\"f62ef75c08f3a67f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/gate.js\":\"080aa98550a04bcd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/index.js\":\"83e73885852c08a6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/wolfTheme.js\":\"1e1d861e17d9b002\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/BlockDragLayer.js\":\"f1e7c8cf871a1a31\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dragController.js\":\"2cb90becfaa263ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dropTarget.js\":\"85146575080ca4e6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/index.js\":\"174a11097f9d7160\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/projection.js\":\"a57c858ea0db0986\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/BlockMetaCard.js\":\"432e0028c9e925a6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/index.js\":\"cf4945bd53c4e990\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/AddTagDialog.js\":\"bdc5033a47062dd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7ab48f0ec6ed5185\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/TagNameIssueHint.js\":\"48b0febb2824097e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/addTagAction.js\":\"bd3ccd4055aad33a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/appendTag.js\":\"fe352c21fe51aded\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/config.js\":\"bd1163a5c42af693\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/dataExtension.js\":\"e68a5805cd47e545\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/index.js\":\"aaa8c61485d48eae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/propertyEditorOverride.js\":\"14c854a0a59fadb3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2d649a71fbed9a9f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"819e3de3ade9ec0a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/Breadcrumbs.js\":\"14fa309b78303aa1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eed99d3802c21d59\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7cca36de7d76657b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/index.js\":\"15b73ecbd39a16c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a8fbc4b321753d96\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/CharacterCountItem.js\":\"59ab1c6ff1eb20b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/ProfilePropertyEditor.js\":\"14f9816b92431c91\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/actions.js\":\"890b1d76993a4ff8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/blockType.js\":\"211a1a6dac3163c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/charCount.js\":\"0c4b398553df12a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/dataExtension.js\":\"58c78c13d57d48cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/index.js\":\"d71ca266eb71cca9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/profiles.js\":\"f8e94ca6ef8249bc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/properties.js\":\"49945c14e1665d72\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/textCounts.js\":\"84695a52c742f448\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/colemak-keybindings/index.js\":\"12d105bcbbcb8fc1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/CommandPalette.js\":\"4fc23da74bf826a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/HeaderItem.js\":\"4e4666cb3fcdcc2e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/context.js\":\"3670b28d758b25c2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/index.js\":\"17d492b5c1598cf9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/selection.js\":\"6fa4b549854c50f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/toggleStore.js\":\"fcce404929414df7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/useCommandPaletteActions.js\":\"f8d82a4084b328a5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/ContributorBadges.js\":\"c21c14a58183fb85\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/author.js\":\"afd9197201745d04\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/codeMirrorExtensions.js\":\"ce89aaae41bcd79d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/dataExtension.js\":\"c978b748a9f7df51\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/index.js\":\"0a021c21b2d40a0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/mentionAutocomplete.js\":\"271e6509df1a0077\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/processor.js\":\"681d2edbc5567faa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/profiles.js\":\"af5d3251c0061c0e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/queries.js\":\"8e8b0e2f06a95934\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/schema.js\":\"b78305c9d5396a27\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3294f8b2a5128678\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f9377bc8cffc36aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/index.js\":\"88c7da7d2c87bec8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fed70f3c0c962bd0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d4ae6000fda00ed8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/CalendarGrid.js\":\"c4468ced190662e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DailyNotePicker.js\":\"c73d57a34ae1e1b1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"68bc9a4c9c2e712b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateNavDecorator.js\":\"056497488d668b06\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateScrubOverlay.js\":\"51b5120fccbbe4b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/HeaderItem.js\":\"bf7ff67435fddcee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/ReschedulePicker.js\":\"f66d724ca122577f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/SpreadDatesDialog.js\":\"fb923d6323548ff8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/actions.js\":\"cd9c96e7b64b2594\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/blockDateAdapter.js\":\"b99bd5d6a1015a33\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/calendar.js\":\"7962eecf76c803d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dailyNotes.js\":\"e8a49cc5d5aae7a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dataExtension.js\":\"e8b567334ac38b7d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubActions.js\":\"268a13586d37ecdb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGesture.js\":\"7ba810843a3a4625\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5f1322ab990332a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c4c944b1047cc939\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/deletionGuard.js\":\"3ed32a74998219cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dueQuery.js\":\"846d8d4b956565e0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/index.js\":\"eb5faff5cd84a726\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/landing.js\":\"2295837af3344121\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/localSchema.js\":\"a00e1babce33662b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/referenceDateAdapter.js\":\"1765c9e97ae6f554\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/rescheduleAction.js\":\"6638fb58a7701dc1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/schema.js\":\"36ca13b5543196c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadBlockDates.js\":\"6a627eef21b08b15\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadDatesAction.js\":\"d655a2a22f68f636\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/today.js\":\"f7d76924e0047bd6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7545c352ccdeb049\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"707dff587a560d40\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/audit.js\":\"9ac1cb4ff76bad23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditAction.js\":\"e0eb9d672b652094\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditRanges.js\":\"22ca5655f3377a2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/diagnosticsSource.js\":\"6ce262464f560ff4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/divergenceScan.js\":\"1d8c79fb0b620de8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/index.js\":\"ab2d50cfcb329367\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0120733673d6fba6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/referencesMirror.js\":\"efe1bfd483f875db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/rowJson.js\":\"6d8abd2e8acb8afb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/schedule.js\":\"eb2c1af9df6b5010\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/store.js\":\"4ec9465f9f784437\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/action.js\":\"8840406f917dd0c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/index.js\":\"a43249927b5bacc0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/plugin.js\":\"a1dd09a289719109\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"111f9c805b77e96a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/actions.js\":\"3466b18f7b1eb939\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/changeMarker.js\":\"edd6670f0ec6aa19\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/diagnostics.js\":\"49efdb10f802052d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/fileSystemAccess.js\":\"f3c06f06e8da2326\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/filenames.js\":\"9fc49b1de6028b31\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/index.js\":\"6647f3b1b3a15078\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/mirror.js\":\"7d507d82d6007bf1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runLock.js\":\"f4c9eb5c8c55944d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runtimeHealth.js\":\"e6b0f287040eeb23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/schedule.js\":\"2ea7b65e13fed792\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/store.js\":\"b03e5a1baa85e12b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/index.js\":\"98dd050a3524a79e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/themes.js\":\"2911fa740b939367\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/facet.js\":\"075cedd080dc93e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/useDiagnostics.js\":\"f8b30c45eb9521a3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/dismissals.js\":\"8dbc0928d11e3440\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/index.js\":\"7ad8aa49b06a4d5a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/status.js\":\"70ccf6a6d005cc73\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/store.js\":\"8cdba258325d880a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"efc21dcddc58b008\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f5dc53c7bd522ed2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/actions.js\":\"c15bf1a6c5ff3ab6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/config.js\":\"ff0febed471bc4bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/dataExtension.js\":\"6d350906f128a5e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/effect.js\":\"cbdee94a6bcf43e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/index.js\":\"43ec94a97aa0e971\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/propertyEditorOverride.js\":\"974e928e4b3be958\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/useToggleTree.js\":\"84df21bd7b10f013\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/ExtractTypeDialog.js\":\"546bbf3c24ff4945\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7e80922e1beff00e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/PropertyShapePicker.js\":\"2e3a08a4a559ce48\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/action.js\":\"dcee37b407b12407\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/index.js\":\"cb98d44917726696\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/FindReplaceDialog.js\":\"2f19e5f65a1f8a2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/HeaderItem.js\":\"87f4ef09afe8a9ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/dataExtension.js\":\"926ad744850650c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/index.js\":\"33068e61bd818af9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/search.js\":\"ae32a68261b56fcb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/toggleStore.js\":\"75d29bd82a79c011\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/LocationPropertyEditor.js\":\"040a5e1e011656bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/MapView.js\":\"028ddada735b35de\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/blockTypes.js\":\"6cfd7cb662170e13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/codeMirrorExtensions.js\":\"4fcd561e9198ecad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/createOrFindPlace.js\":\"9b4c3e9aa6b865ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/currentLocation.js\":\"9afa7c72f05ccf4f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/dataExtension.js\":\"3584b200afb9a564\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/geoContentDecorator.js\":\"fd1f584512be7617\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/googlePlacesClient.js\":\"d8a1c38990eb3296\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/index.js\":\"8c900d7ebcfdfcc5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/locationsPage.js\":\"30485c31c3f0ca8a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/mapViewport.js\":\"a75c77078348a57c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/pickCurrentLocation.js\":\"5b43ff27ee676e8e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeAutocomplete.js\":\"4c06f0c3ec3d8fc0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeNameCollision.js\":\"d52fbc85e9ccc850\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/properties.js\":\"6fe6f32fa5bab832\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/propertyEditorOverrides.js\":\"3b6a1a5fc101495c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/query.js\":\"099c31c13c88ad22\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/usePlaceSearch.js\":\"f8ce826e714f0509\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0810831617828353\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"211c172205568a24\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1a5eae13ce99e2d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/config.js\":\"15e85aa7db4396f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/dataExtension.js\":\"3a259c07a6c77dc9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/facet.js\":\"3df5addb7872c993\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/grouping.js\":\"c6d0044385cee980\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/index.js\":\"06842302310e78bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fab4dee8a2fc5c9b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/query.js\":\"cc5c43c456904348\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/resolveConfig.js\":\"4179d6ed136fcf4e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e072516a6ed099bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2762b455a8671574\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlDocumentContent.js\":\"f00ed4a427c04d21\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlFrame.js\":\"ae805b1bd3b58b3f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/actions.js\":\"673642ab309959fe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/blockType.js\":\"890dba7c87aba2ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/confirmRunScripts.js\":\"7a33cca2a99a01b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/dataExtension.js\":\"e5e3f92e9e5eb551\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameAnnotations.js\":\"34ecb284d7b18449\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameDocument.js\":\"08468b89dffff214\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameTheme.js\":\"23ed8e4c21b9c518\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/index.js\":\"95c0cda8fceaab08\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/scriptConsent.js\":\"0a9be79ad264dfdf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/sourceMap.js\":\"66c556f9277773ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/useDocumentScripts.js\":\"ccd5c3799ccd079c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/index.js\":\"9ba026a935dd4179\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/record.js\":\"226797a1c1dbdf54\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/recordStore.js\":\"e5c3ddf99ea362bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/responsiveness.js\":\"8a9fd8c12fac0878\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/schedule.js\":\"a2890ff5e83dc71e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/sessionContext.js\":\"1eea007163535d72\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"597a63ec9c09f9c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"56c0025224957fdd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/actions.js\":\"8e62a1b0977844a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/config.js\":\"a1188c033130050e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/dataExtension.js\":\"be027a4b4daa3ee7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/effect.js\":\"33df13ac979f848d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/index.js\":\"ebd5823e12053da1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/keyCapture.js\":\"5148ead9a1480b15\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/overrideStore.js\":\"0e1d3929a0c7d171\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dbf4817298e4cff1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/HeaderItem.js\":\"90247eac494ecca5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/LeftSidebar.js\":\"130e1d46a5ed5ab6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/actions.js\":\"1e407da83ac275d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/facet.js\":\"c4779bea3a39492e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/index.js\":\"b3b96a178d244dbc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/shortcuts.js\":\"80e1b6cea001cd4c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/toggleStore.js\":\"aa683676c871b3e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/MergePicker.js\":\"3beca62c97ab9601\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/index.js\":\"296a6d0bcc8f4d32\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/mergeAction.js\":\"169a44d2fdca90ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/strategy.js\":\"9e5dbe6be042622f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/Button.js\":\"9282c99856e562b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8125ca0ed31394cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0c49d27a28c01ebc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/facet.js\":\"1bb5d05d891f8955\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/index.js\":\"2c0c43b61e15c239\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"77c7b933b51008ae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7134776435615c24\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5cb0accd64c5d0f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3c5ef4037c94b9c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/index.js\":\"e4c991ff0462ecc9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/MoveDestinationPicker.js\":\"87ef283cf7a05eee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ba731c4cb62fd3e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/contextMenuItem.js\":\"e781453f790a870b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/index.js\":\"fb331581ebd7036b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveAction.js\":\"37994dfdeeb518cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveBlocks.js\":\"8d12f4ca469219f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/selectionAfterMove.js\":\"573b397943e227ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/TutorialBanner.js\":\"84d949b57e251369\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/action.js\":\"43a1ab7871ac5aa7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/bannerDismissal.js\":\"a872c09c4531f630\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/documents/cheatSheet.js\":\"b9f63e129dc10d48\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/index.js\":\"64bb9ba22cedaa40\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/keys.js\":\"35fa7ae15167978b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/landing.js\":\"c67f0667914a86aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/outline.js\":\"21838659e2b7ec65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/seed.js\":\"7b324442aa943751\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1c38ee6c712a2257\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/analyze.js\":\"58cb4bca6db85caf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/diagnosticsSource.js\":\"b79c45f8897d8511\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/index.js\":\"4591f5ddfca891aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/load.js\":\"f74e5181d764ac5c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/monitorRun.js\":\"bc52fcf770bc01e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/schedule.js\":\"cc5f2c76f700d162\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/series.js\":\"0e43624b88522ee7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/store.js\":\"92e8878412ff336b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/trendAction.js\":\"a1feb502aa0b9bb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/verdict.js\":\"c6046c6b5ee53164\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/clickToEditAction.js\":\"bdbaba21d9cb7a7c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/index.js\":\"624d1e156b8a4fb6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/interactions.js\":\"e33d0733df0c5e8d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b772f66e99005d72\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGate.js\":\"7fde736624ddc61d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGateDialog.js\":\"7ecdc5924376412a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/action.js\":\"69151446e200c5a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/index.js\":\"0141fb084da889bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/localRunMessage.js\":\"2d104e077f228d06\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/plugin.js\":\"2dfd0e34a0654fc0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/progressReport.js\":\"b0e6e4f3be1b9c9c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/sweepProgress.js\":\"502819a0cb447f8b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/FieldRowRenderer.js\":\"df19c09cd48b6de1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/ValueRowRenderer.js\":\"85189709e60d4c71\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/actions.js\":\"7e3c66ed657b0b3c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/autocomplete.js\":\"3939761e75c6a398\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/fieldRow.js\":\"49ccf17a851ee8e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/index.js\":\"c8db22d129f6e7ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/referenceWarning.js\":\"522e45aade35d491\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueAutocomplete.js\":\"e243ae1b9093211b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueSchema.js\":\"69d7ee05c69c91f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/HeaderItem.js\":\"b23f01077bd5282f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/QuickFind.js\":\"e8b05bfbc3bc543f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/index.js\":\"dfdc944f12f7c8b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/recents.js\":\"e9ec1630eb0eac50\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/resultItems.js\":\"3b22493e8104fb56\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/selection.js\":\"a243116ca3d18fc2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/toggleStore.js\":\"d72f2246d620985d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/HeaderItem.js\":\"ff18eae5fa008410\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c8820007461b2ac5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/grouping.js\":\"e62608e4c8df30c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/index.js\":\"74f4e3596bf98c3d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/target.js\":\"79b5e63072c3d857\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/codeMirrorExtensions.js\":\"de1c4363c700fb79\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/contentPrefill.js\":\"9ba06ce72c8b772b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/dataExtension.js\":\"ad8b3926dafeebcb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/index.js\":\"369fc1c67cfbefb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6a6283451d7861b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/invalidation.js\":\"66297b23697df24e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/localSchema.js\":\"aebe4520f75b9809\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/index.js\":\"6625cc5671961b20\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9880fdfe5905f693\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/index.js\":\"26593229fb03e0dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/referenceNode.js\":\"18bcc1d141d96191\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/remark-reference-occurrences.js\":\"bc1adad3d054aa5c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"42abf993acb23bce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/index.js\":\"f5d911a948e00299\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8626dc6114d31c8c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fb4076104ac8326b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/mergeRetargetProcessor.js\":\"aae773a384e1deda\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/parseFence.js\":\"cbdc8d235b46b72c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceParser.js\":\"831b978afb1a43ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceProjection.js\":\"2a0e18a45b597cc5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referencesProcessor.js\":\"fcb766fdc9ee4165\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/renameProcessor.js\":\"e901e8ba2c741d66\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/spanReplacement.js\":\"b431a6bb63f57e2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/htmlToOutline.js\":\"32a813bbc5b0bef7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/index.js\":\"b94a79aaabee812b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2ad1c069a1ffd8fc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/pasteDecision.js\":\"d4ca0fd36b84b57f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/action.js\":\"153dcaf5cb7bfddd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/blockIds.js\":\"20972e8cd250271a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/content.js\":\"0f3492b7ab7ba6e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/effect.js\":\"6ecc930740792f53\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/ids.js\":\"7867e3af6af0106f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/import.js\":\"8607bd00434489e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/index.js\":\"79486a0e359b2f9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plan.js\":\"07579ccf3d964b6b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plugin.js\":\"500b66273a10e3f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/promotion.js\":\"d2c49d795c5e6c3a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/properties.js\":\"2e8c6fa4ba93b9dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/references.js\":\"8155eb728f5e935e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/report.js\":\"81ea1fc797d7538e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/roamMemo.js\":\"9d0dc24411f762ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/runtime.js\":\"549c301fe5f49450\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/schemaReconciliation.js\":\"b4d648bd2f58fdb5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/srsMarkers.js\":\"df72c58998774b2a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/todo.js\":\"c570d850bfe3c475\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/typeCandidates.js\":\"6d72893ff8679147\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/types.js\":\"3aac755ed80ac8ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/index.js\":\"2d2e95cb8411985b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/store.js\":\"3d6b1413d492afa6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/HeaderItem.js\":\"ca9d108e76285c6e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3ddf6e85640db2dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/index.js\":\"bdf16ffcf0496593\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/model.js\":\"5ceea46efcaed5b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/toggleStore.js\":\"41f3e584532780c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/useKeyInspector.js\":\"6d076641f3b4aa0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5b1098ebc8baf24c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/ShellDecorator.js\":\"28e0a6b08d907342\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/actions.js\":\"d97af784a5788ee4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7b29ee070717847a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/index.js\":\"397184422e2f2ec5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/shell.js\":\"357ffef76bb4ad45\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/surface.js\":\"f739f9011f56f635\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/walker.js\":\"e00518cf181cc4d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3dcabc7aed58b699\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/dataExtension.js\":\"92268c9f76a41a30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/index.js\":\"6eb14e9ed6485797\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/indicator.js\":\"90d6b59e7f45c344\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/moveSrsState.js\":\"016d7bce11250f46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1c69b700a743c2eb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/scheduler.js\":\"bdb6e121f917d8f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/schema.js\":\"62cd1879e5bf7b22\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3a9c24d4f9f92e6e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsClipboard.js\":\"f57eb07d4b81badc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bf4a1593b5b6f596\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DailyNoteReviewHint.js\":\"26a0afd27334db97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DeckPicker.js\":\"548547e4e12cd1bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewControls.js\":\"e2caabb590602664\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewDeckRenderer.js\":\"35e7e731a746b871\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewSession.js\":\"eeda47ab9fcbd32a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/actions.js\":\"62ff8eb97fdd678f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/archive.js\":\"ca237da21feb0c78\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dataExtension.js\":\"1f28a05ab5850a42\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/deck.js\":\"70a45144afdfb9e2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dueQuery.js\":\"dc7db7dd95d5cec2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/gradeDecision.js\":\"5f9f71c5dd8e3ee8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/index.js\":\"74adeee48218b6ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/keyHints.js\":\"8cb689aabf074dce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewCardLayout.js\":\"bd64f2c77f1c759f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewProgress.js\":\"4be2ee58f4380d97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/schema.js\":\"ff9fd42f7f81fe8f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/useDueCards.js\":\"0ab9038de625a428\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/index.js\":\"a8619468906ba16a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/record.js\":\"13a1f6b0a68b4857\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/index.js\":\"667377c8c0385429\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/persistenceStatus.js\":\"5302d8808a7b1dba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/requestAction.js\":\"78267ef2616bd6cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/TypeChipsDecorator.js\":\"eed5b8e35a51609b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/codeMirrorExtensions.js\":\"f136c9e9b8310de8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/index.js\":\"36b2209e11e93ba6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/typeAutocomplete.js\":\"43f708375214397d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0cf2913612bedc6b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/actions.js\":\"bbded75ca0491b85\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/anchor.js\":\"f5b800f3b28bb907\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/events.js\":\"dcee38eb7cd4a3bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/gestureActions.js\":\"16249dfbbf123aef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/index.js\":\"576dd32361d457eb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c773c379625fd2df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/collect.js\":\"818eccc2d6ce621f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/index.js\":\"3a5ae6d155a59d37\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/record.js\":\"38849a4b645c1a54\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/RejectionDialog.js\":\"a890fb91fbd21389\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/SystemStatusHeaderItem.js\":\"bd2696d10f14c583\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/index.js\":\"0c7c1bb1e3bba56b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/model.js\":\"a79600d629ced114\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/queueCounts.js\":\"2e27d576944e2478\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rejectedHelpers.js\":\"0a56991a52736c77\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rematerializeAction.js\":\"de002f8641f03dc6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/useHysteresis.js\":\"c9932287c416718f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/effect.js\":\"e5cfbc85fef06c08\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/index.js\":\"404dda476dc8588e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/theme.js\":\"87f1795ca9159fa5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/actions.js\":\"eddb2adeef293c06\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/dataExtension.js\":\"5234141224f1f919\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/index.js\":\"fdbece4e91fbe939\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/schema.js\":\"2b81993afb0ecc2a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e7e036f1f6dcd13a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/actions.js\":\"8fb95bf00d040f26\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/defaultItems.js\":\"a43b4d6383cbf45d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/facet.js\":\"497f750ec5ccb4b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/holdRecognizer.js\":\"7f64ea13f5f23115\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/index.js\":\"16637d7ce1d62d4b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/UpdateIndicator.js\":\"35615335fb8a5aad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/index.js\":\"3335d8f1e46be75a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/loadTimes.js\":\"ce690c6d2f2a665f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoNotesRenderer.js\":\"e11765c45d5c0acf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoPlayerRenderer.js\":\"b22aec808c2827de\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoTimeStamp.js\":\"8d595207b2038292\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/actions.js\":\"ca4051a427149a66\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/index.js\":\"576de20952359944\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/markdown.js\":\"2f829d782de1c88f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/notes.js\":\"1aa136bf9495cb65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/registry.js\":\"f4921d43e869518a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/remark-timestamps.js\":\"9752ed9c1cce43db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/view.js\":\"31594eef6182cc38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/LinkHints.js\":\"fd3511731d9dc2cc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/index.js\":\"fdcd6319df2bfbe3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/model.js\":\"383a3f52635a0dda\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/settings.js\":\"ac3e26c8bf19af7e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/actions.js\":\"5ca1c4363fbf5ee4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/index.js\":\"45f82cb5639fc281\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/interactions.js\":\"8bcb48c6749bc1b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/workspace-header/index.js\":\"5898c0c2b8a27249\",\"/knowledge-medium/pr-preview/pr-1785/src/registerServiceWorker.js\":\"d8be94e595806708\",\"/knowledge-medium/pr-preview/pr-1785/src/requestPersistentStorage.js\":\"8269c6c1eec37b9d\",\"/knowledge-medium/pr-preview/pr-1785/src/services/authRequestDeadline.js\":\"81595da741cdf1ba\",\"/knowledge-medium/pr-preview/pr-1785/src/services/powersync.js\":\"65f84a5d959645a0\",\"/knowledge-medium/pr-preview/pr-1785/src/services/supabase.js\":\"e39339c94f9e8601\",\"/knowledge-medium/pr-preview/pr-1785/src/services/uploadErrorClassifier.js\":\"bca0e579bfc5ad38\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/ActiveContexts.js\":\"53dc3ca368df45ee\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/HotkeyReconciler.js\":\"7b65dbdd38588b1c\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/WipeLocalDataDialog.js\":\"5a16272436ec2680\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionDispatch.js\":\"88605976c67597af\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionRefItems.js\":\"515426fbc8022a95\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/applyKeybindingOverrides.js\":\"68d978f56e1b90cc\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/blockActions.js\":\"331e34ac6e11c43d\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/canonicalizeChord.js\":\"b3c962ae2076710c\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultContexts.js\":\"30cb39fe21448a30\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultShortcuts.js\":\"69d0e4f68cc2c952\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/effectiveActions.js\":\"3a8b343d10468358\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureAction.js\":\"51d8a9eead659ba7\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureBinding.js\":\"a121f846b585ce37\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/holdRegistry.js\":\"0ba0ce0876f5a1e5\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingConflicts.js\":\"f658219b0f1c8df0\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingOverrides.js\":\"828eb8ae522eb313\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/pointerAction.js\":\"f44034cf44a993c9\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/resolve.js\":\"99c2272aa0991c95\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/runAction.js\":\"b2ec93c2960c5166\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/sequenceMatcher.js\":\"fb4098fd0aa44896\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/types.js\":\"3b732ce544f5640c\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionContext.js\":\"bea44f418ba69a7f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionDiscovery.js\":\"a539e2c91eb0a089\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/utils.js\":\"f082aa47a91ea014\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/bootStore.js\":\"7a89c57fd58a9839\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/previewDatabases.js\":\"5997d509314782cd\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/byteTransform.js\":\"30094a63b47c1a77\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/attachmentCleaner.js\":\"b59ca8510fab696e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/attachmentParts.js\":\"bee687d7dc0f82b6\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleParts.js\":\"28e1081360bb4ed1\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleRecord.js\":\"14b82deee3b10707\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/manifest.js\":\"077eebcc110adf75\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/takeBundle.js\":\"9b7d085df8ec7ee4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/verifyBundle.js\":\"a92dda5cf6213a4d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/cleaningStage.js\":\"b74038fcde65ad72\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionKey.js\":\"b44404be18c5a4ef\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionServer.js\":\"294b7de19a19e841\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flip.js\":\"ec7f1f11a29b30e8\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flipAttempts.js\":\"23d7f1d477a5c10a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/pages.js\":\"43cde35189a91a25\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/preflight.js\":\"16bad65ec1110d09\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/reseal.js\":\"b0b2a906eb828842\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runConversion.js\":\"f8c4120eaea0db8b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runLock.js\":\"af6c5dad1b42e96b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealing.js\":\"60986086b50bc84d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealingStage.js\":\"3aca4621ee596f4e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/stage.js\":\"e4bd0cceeef2dfaf\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/verifyReseal.js\":\"4c114f410460980b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aad.js\":\"bee12a6d01e619cd\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aead.js\":\"2b1522c0ccaf8038\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base32.js\":\"901dab03b98e3ff4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base64url.js\":\"1d6237fc07d5959b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/binaryEnvelope.js\":\"4de351ba9aae89f9\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/byteAead.js\":\"1c740fd1211461f7\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/canary.js\":\"2207c20d910eb150\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentHash.js\":\"ad627ea1be507040\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentKey.js\":\"67bebfddeb484925\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/derivedIdNamespace.js\":\"b92c8b8cfa5c93e0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/envelope.js\":\"8674b53df588fced\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/hex.js\":\"56e40bd4101be51b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/sha256Hex.js\":\"993c4bc2804a12be\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/workspaceKey.js\":\"fcd8f75a8e423dce\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/conversionState.js\":\"169f3fadc9efa980\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0e123e5fa7bead5f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/pastedKey.js\":\"e1dea635435d24e7\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"75b5901adca60e26\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e0ec5edc946f0f89\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/keyStore.js\":\"69d93c0e66ac54ef\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/mintWorkspaceKey.js\":\"6699a9f8cb6b8057\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/modePin.js\":\"d4479b36a548b4b9\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/openWorkspaceKeys.js\":\"e05fe12fa2faccab\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolveWorkspaceEntry.js\":\"b3aa892bc3a77c90\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolver.js\":\"5324aa3b3866b883\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/workspaceAccess.js\":\"ffe600865429aaad\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/transform.js\":\"fe95b926862156bc\",\"/knowledge-medium/pr-preview/pr-1785/src/themeBootDefaults.js\":\"73542e80a0d2205b\",\"/knowledge-medium/pr-preview/pr-1785/src/types.js\":\"0b626eadc9f40211\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/ClientLocalSettings.js\":\"29715a8bf15307cb\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/abortableSleep.js\":\"791655267ef1dc12\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/array.js\":\"c8ec9865358ecddf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/backlinkAutocomplete.js\":\"f971392e5155220b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockCrumbs.js\":\"1ada84cf32221bca\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockrefAutocomplete.js\":\"e24884d235b3b472\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/cadencedIdleJob.js\":\"4c4ea2b35fe32c0d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/callbackSet.js\":\"1fc6fc5f3cf35385\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/clientId.js\":\"c96c4cba4bb5c380\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirror.js\":\"f278c4a90daab710\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirrorCompletion.js\":\"5884cf413016c22c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/copy.js\":\"12efba66668ee2c9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dailyPage.js\":\"d796a2f8f45ce8ea\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensics.js\":\"1e56cb41650fa19f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensicsHooks.js\":\"008d7f9720505ea0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/deleteBlockThroughUi.js\":\"022b0d25f31af828\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dialogs.js\":\"0975b48bba68e470\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dom.js\":\"a7c123929a74e138\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/downloadBlob.js\":\"bb2573c2f1d61924\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/exportSqliteDb.js\":\"681cd29a62462ad5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fileSystemAccess.js\":\"3819cc121bc0dd96\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/flipSlide.js\":\"db10fc15e07dfd9d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fnv1a.js\":\"ef76534a0eed7d3c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/formatBytes.js\":\"466742927d2a5c8d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fuzzyRank.js\":\"912b49fd7d14bf7b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idbKeyedStore.js\":\"09496cf4de05811e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idleCallbackPolyfill.js\":\"cd62d1c6582a8b5f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardAwareScroll.js\":\"2cc2af0b4927faf4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardViewport.js\":\"4591312a4e279e4a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/lastWorkspace.js\":\"1fe110220c6a0891\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutColumns.js\":\"61227641f852f27a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionDom.js\":\"6f9a3916213dfc4a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionId.js\":\"94ba7c3a5eb6562c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkClickGestures.js\":\"2a5003bcd907684d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkTargetAutocomplete.js\":\"38487270bd05a8ec\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbCorruption.js\":\"46072bebdec67e2c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbRecovery.js\":\"5736a358a67612d0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/markdownParser.js\":\"da48bd112925ed23\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/memoize.js\":\"1b05d201e8637724\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameFieldCommit.js\":\"e84167306d71ff85\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameList.js\":\"c11691cff7917174\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/navigation.js\":\"fe9f0bc7dddc8d9e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/omnilinerNamespace.js\":\"b63361f5d0796543\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/opfsPageScan.js\":\"374938ecdeaed536\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelClearance.js\":\"e4a9226964e2652b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelHistory.js\":\"161179445068804e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLanes.js\":\"794d75c226171369\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLayoutProjection.js\":\"71c9879ae9f73655\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelScrollAnchor.js\":\"a6d33215c401ce78\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelUrlFlags.js\":\"1547330f68df8a78\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/platform.js\":\"8b3b74983ff026e1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/pluralize.js\":\"5f8b34b50f6f1c70\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyCreation.js\":\"e9f7bef05e73221f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyNavigation.js\":\"7efb4d98de8ea389\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyValueContext.js\":\"c69ca63d57f00e27\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/react.js\":\"de84efaeb6d812e1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeDate.js\":\"a2846e53da3fdf17\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeTime.js\":\"f4a74b13d38832fd\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/renderScope.js\":\"4060c3dbdd92ce28\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/resolvedThenable.js\":\"93ff5c9f03c1a207\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/routing.js\":\"2b592e424621d31a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/safeMode.js\":\"55355fb3ba5a8d06\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/scheduleIdle.js\":\"48d904e70c72b40e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/screenWakeLock.js\":\"d74ff9cc38b4613e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/selection.js\":\"f4bafa0213cdf915\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/softKeyboardGrab.js\":\"4f270cb4baa1fb25\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/startupTimeline.js\":\"56ce57b41bc0c814\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/state.js\":\"a52e83d301f4d591\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/string.js\":\"c58148d2f4775cd7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/surfaceZoom.js\":\"928f633fd82f8ebf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/time.js\":\"cf0e5523e7485bb5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toast.js\":\"a86b43ce003eefdc\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toggleStore.js\":\"433ba4c0c65a8c29\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/untilStopped.js\":\"d56d10280354dd55\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/userActivity.js\":\"889eecf82caf204c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewTransition.js\":\"d56cf94df4a585a7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewport.js\":\"d04a97702dfabdb6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/webLock.js\":\"4339e58f29a06b7f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceRecovery.js\":\"6d4bf164cc878935\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceSnapshotStore.js\":\"8a6d9e765965392e\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-compiler-runtime.js\":\"b6e967665804614c\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-client.js\":\"5b351e5cc330ad22\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server-edge.js\":\"d6dd35dd6fbe58c5\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server.js\":\"2af4e9c11c6992f4\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static-edge.js\":\"083627a764c8580f\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static.js\":\"86ed47e85aec1e9c\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-test-utils.js\":\"6ec5a0a4791013a5\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom.js\":\"956b8bcb5fc3ca0e\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-runtime.js\":\"3652892a6535de2f\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react.js\":\"9511aecda981ae75\",\"/knowledge-medium/pr-preview/pr-1785/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
