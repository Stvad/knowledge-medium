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
		buildId: "574d9c7cd0f0-e4d68034",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/\":\"6b6152d803cbfd97\",\"/knowledge-medium/pr-preview/pr-1785/index.html\":\"6b6152d803cbfd97\",\"/knowledge-medium/pr-preview/pr-1785/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1785/assets/FacadeVFS-CVO9VvLh.js\":\"a72dd069a3dcd297\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSCoopSyncVFS-QEXZOHY6.js\":\"267100346ab65de7\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSWriteAheadVFS-DyHWk-A9.js\":\"5e3b88b0d981d8e5\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-BCoQ-Mk_.js\":\"b7f21f9931401380\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-bt34Lkd4.js\":\"3a403ed695c38ed2\",\"/knowledge-medium/pr-preview/pr-1785/assets/worker-Btkd33Go.js\":\"8c8d80e5d4571ca3\",\"/knowledge-medium/pr-preview/pr-1785/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1785/chunks/app-AlpLbYWP.js\":\"dabd0de20b06038d\",\"/knowledge-medium/pr-preview/pr-1785/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1785/index.js\":\"72d2181fc45c6d78\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1785/assets/AccessHandlePoolVFS-D7noHMPx.js\":\"299fe5ae169288ea\",\"/knowledge-medium/pr-preview/pr-1785/assets/IDBBatchAtomicVFS-C6fbvlTa.js\":\"6162a432740d4178\",\"/knowledge-medium/pr-preview/pr-1785/assets/MemoryVFS-CW6xh3Gs.js\":\"9b290ce7d1e4b74a\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-DL3tp13A.js\":\"f4971c06c5acaf4f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-CLmbv2JP.js\":\"f9ecf3376b19ee8f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1785/chunks/AccessHandlePoolVFS-Czl723R5.js\":\"89a8425a35218df4\",\"/knowledge-medium/pr-preview/pr-1785/chunks/FacadeVFS-hG1pTQyK.js\":\"533876f9d724be46\",\"/knowledge-medium/pr-preview/pr-1785/chunks/IDBBatchAtomicVFS-eMCwbHQz.js\":\"aa19256470d469c3\",\"/knowledge-medium/pr-preview/pr-1785/chunks/MemoryVFS-fhIEvbnZ.js\":\"3db7e31001a47851\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSCoopSyncVFS-CuSZedbO.js\":\"ce15643218fb8f7e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSWriteAheadVFS-GCHVdsyn.js\":\"7053bb92c4531bd0\",\"/knowledge-medium/pr-preview/pr-1785/chunks/Preview-BcrUdPZ1.js\":\"db831dae05d17de2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/card-C62K_FNi.js\":\"97324d580acc71e8\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-D1RWZB5B.js\":\"4ea86ce676e1dc5d\",\"/knowledge-medium/pr-preview/pr-1785/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-Dj7L1Lp9.js\":\"e75a8a898fa140b2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-async-Cg3xpB9Z.js\":\"b9df5e1c5fc8388e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-B-yU0xEt.js\":\"7ac1a13968b031f7\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-B1xKFTx9.js\":\"a8799c09c2257a97\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-BOg3BXBL.js\":\"17bbbd7bb9154d96\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-BPFU3Nn2.js\":\"3777fb29dd4735db\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-CYqu2b37.js\":\"37a694619e77cded\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DpORMvRN.js\":\"131813d6bb509ca9\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-Wxsd4tgU.js\":\"9b118e7a81f7c474\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server-legacy.browser.production-DPVXaZ3K.js\":\"763cd2aa255d4b56\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.browser.production-wYEyuGsI.js\":\"41fe19dfde749ddc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.edge.production-SJGNxBvy.js\":\"cdf18e0994aff8b2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-n4kbLtBW.js\":\"c71785fbc73effb3\",\"/knowledge-medium/pr-preview/pr-1785/chunks/server.browser-CEy4hMKF.js\":\"8e0385f4598f7077\",\"/knowledge-medium/pr-preview/pr-1785/chunks/textarea-kUtWx0qT.js\":\"d807e6f974154448\",\"/knowledge-medium/pr-preview/pr-1785/chunks/ui-BsTWJBeZ.js\":\"2af454ee96b062aa\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-async-QL25ThzH.js\":\"32841ee9e9a4e632\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-fcvHB7So.js\":\"f2776e1b3c1db722\",\"/knowledge-medium/pr-preview/pr-1785/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1785/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/src/App.js\":\"255163b92befbaca\",\"/knowledge-medium/pr-preview/pr-1785/src/appUpdate.js\":\"7cdca89a610bf2bb\",\"/knowledge-medium/pr-preview/pr-1785/src/appVersion.js\":\"bbf77aef7dce1ac8\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/initialLayout.js\":\"bbb8603a5fe6643f\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/resolveWorkspace.js\":\"a0cacde46fb4cfee\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/workspaceBootstrap.js\":\"7a96b477090c2614\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockComponent.js\":\"fd07a669e877f81a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockCrumbs.js\":\"13067a389ded9e16\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockEditor.js\":\"b4ecb059b551077d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockLoadingPlaceholder.js\":\"6112652e1c49aebd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockProperties.js\":\"2d02dd0ac22b0128\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockSearchPicker.js\":\"737ea09646a448d1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ConfirmBulkDeleteDialog.js\":\"0301fdfdb5c50004\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DividerHandle.js\":\"3d9e74bbce479ab2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DraftEditor.js\":\"84dca9cd9e0494fa\",\"/knowledge-medium/pr-preview/pr-1785/src/components/GutterPill.js\":\"c599bf571d3df9e0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Header.js\":\"9c0e09d5583b8333\",\"/knowledge-medium/pr-preview/pr-1785/src/components/LazyBlockComponent.js\":\"476ce33649c85762\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Login.js\":\"897db3852349b7bb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ZoomableSurface.js\":\"f40e9d3f4fe1a1b2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/editModeKeepalive.js\":\"7fbd3a3e386b0353\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6bcb30541101cae1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4fd31f6b6d5870fb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefPropertyEditor.js\":\"5f5153d449b26a7d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefTargetTypePicker.js\":\"a6e7819229f11b7f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/SelectPropertyEditor.js\":\"23552012208b0647\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/TypesPropertyEditor.js\":\"30b89f828bcae07a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/defaults.js\":\"6fb82d64db1d5436\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/kernelValuePresets.js\":\"5e56a4874ee3bd20\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/selectablePresets.js\":\"516bad8af50ed5f4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/typesPropertyUi.js\":\"a6c05c09048235cd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/AddPropertyForm.js\":\"ba68daaf4b7ab0a7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyPicker.js\":\"f92861eace67e6b2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyRow.js\":\"cc44f79549a068ea\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/Rows.js\":\"5315b33bade88598\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/actions.js\":\"83902a1fecb2acbb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/declarationOnly.js\":\"9f8b5ca7fde4df03\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/layout.js\":\"739c07f3ea8b0b23\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/model.js\":\"28372c72113d70b4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapeUi.js\":\"a26f930fc7adb438\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapes.js\":\"6e7dcb9d13b27ded\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4c33435bf560bdc7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/visibility.js\":\"35d8ce400bb3ae84\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanelSections.js\":\"08ca026661f2cea7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockEmbed.js\":\"5e9e6c8284f90b15\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockLink.js\":\"acbbd2c3e51f6f9b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockRef.js\":\"f87b4fca2889301f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/ReferenceLink.js\":\"dc1b0ba85272b005\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuard.js\":\"e5e3523bb7b796fb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuardContext.js\":\"74123a265aa62fd7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/linkInteraction.js\":\"f6f76a0bc7ad9d2c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/referenceLayout.js\":\"912c005fd306269e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/useBlockRefAncestors.js\":\"b49c730cacc3e187\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockGutter.js\":\"51777679a77719e0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockInfoDialog.js\":\"04df9191eefa9617\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockTypeBlockRenderer.js\":\"241969393a95b293\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BulletHoverCard.js\":\"7ebe7849603fdc74\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorContentRenderer.js\":\"2fb968c30a07893d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f59411f5b3125521\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ColumnResizeHandles.js\":\"a5d1f3bc51bd3b56\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"deb2bf0f0789e213\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/DefaultBlockRenderer.js\":\"88bf1f5c720ac075\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/LayoutRenderer.js\":\"4d7f7aa27e429167\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MarkdownContentRenderer.js\":\"4ab76638f18d7442\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MissingDataRenderer.js\":\"7cf4e9067f851339\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PanelRenderer.js\":\"11726118f781e575\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a3248807f3a08898\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/TopLevelRenderer.js\":\"33f35b45df098211\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockGutterMode.js\":\"6c798cbaeb3cc5c9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockTitleText.js\":\"098dcea28fc1a792\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/fieldCreationKeydown.js\":\"4a9bc4dad2d704ba\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/layoutRootContext.js\":\"3daa6a5392cb6659\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/TypeChip.js\":\"e635a1a5dbf5e6ae\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/chipStyle.js\":\"8ca4a1df278b7bfe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/anchored-floating.js\":\"ee5160a40f71eb18\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/button.js\":\"78f919392d2656f6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/card.js\":\"c07e603d1ccd5799\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/checkbox.js\":\"ed1a524c4fb7983b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/collapsible.js\":\"aabd1ccf5d76cd4b\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/command.js\":\"d7af3c6cc51447fd\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/context-menu.js\":\"15534d46c06138b2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dialog.js\":\"f86d4e3f8a243e27\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dropdown-menu.js\":\"40991001b50448a2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/floating-listbox.js\":\"05243bf15ec626b0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/index.js\":\"8fd7627d6dddf638\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/input.js\":\"ccdbb396f2a13d13\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/kbd.js\":\"63e182ba2b25d428\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/label.js\":\"3605d39ddab11ba1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/textarea.js\":\"076c853295617e5a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/useEditModeYieldKeepalive.js\":\"b433fe0ba8a198be\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/BootFallback.js\":\"e0dc8a9cb2229bb5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/FocusedRowLazyMount.js\":\"637dd857f0ca58d1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LazyViewportMount.js\":\"2e4c4faaa5b7aedb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LocalDbCorruptionFallback.js\":\"aae31e1255c0a9eb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/error.js\":\"3a81a5a9d849cbbe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/lazyMountRegistry.js\":\"034104a683dc2db2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/suspense.js\":\"3013c1dad83c7799\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/CreateWorkspaceDialog.js\":\"9f3c8208b60588e0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/PendingInvitations.js\":\"26df63444701842a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/SyncProgress.js\":\"40986b624a2d32f3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/UnlockProgress.js\":\"7abae3bda50d4d8e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceKeyGate.js\":\"97c4078caff5e644\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSettingsDialog.js\":\"42ae9f53aa2d7d32\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSwitcher.js\":\"d841eedf33deed4e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSyncGate.js\":\"4fa1063621f4c5a5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlow.js\":\"35bb2469544b7a52\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlowHost.js\":\"551f5894749c765e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/EncryptionSection.js\":\"89fe184b83195b6e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/attachmentPrompts.js\":\"bcbc0dad6778d613\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fb28873d4c6046cb\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowDeps.js\":\"c609433a70155375\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowStore.js\":\"3d95387908105017\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/flowUi.js\":\"75d6d8da094c416a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/useConversionRun.js\":\"2406cd603c6760b1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/keyUi.js\":\"b0d305c724dee598\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnKeyLoss.js\":\"2793a97febc7ea78\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnServerE2ee.js\":\"efc9d9f57670b35c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/workspaceUnlocked.js\":\"e33a3c902914d27c\",\"/knowledge-medium/pr-preview/pr-1785/src/context/backgroundSubtree.js\":\"d90d8d44487c084f\",\"/knowledge-medium/pr-preview/pr-1785/src/context/block.js\":\"7595f3716a9bd44c\",\"/knowledge-medium/pr-preview/pr-1785/src/context/layoutWsContext.js\":\"eafd6c1abde90bde\",\"/knowledge-medium/pr-preview/pr-1785/src/context/propertyDisplay.js\":\"328091676df76a58\",\"/knowledge-medium/pr-preview/pr-1785/src/context/repo.js\":\"905fa411b108a192\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasClaim.js\":\"448fa60b125caefa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasSeatNamespace.js\":\"2a5d6a6dc3d85a53\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockData.js\":\"2127764a6efda68d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockType.js\":\"aba9f7f0cbc65ca4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/changeScope.js\":\"9183de2b91728245\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/codecs.js\":\"8185b7fd7390f0aa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/derivedData.js\":\"c8145e20f1daa46f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/errors.js\":\"d59e6f6fed75ee1e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/events.js\":\"b40c72072d3a7f4e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/handle.js\":\"4fd4689af8038852\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/index.js\":\"96dfab0d355ab650\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/mutator.js\":\"e1ac6224fe058eb9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/processor.js\":\"014b275ca8541221\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/propertySchema.js\":\"9a6df029ac498b5a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/query.js\":\"e4f32f4944bd110b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/sameTxProcessor.js\":\"60299888786a0044\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/schema.js\":\"4fd4689af8038852\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/tx.js\":\"4fd4689af8038852\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/typedBlockQuery.js\":\"8796d9f617e04d58\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/user.js\":\"c46e3519e8dec28c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresetCore.js\":\"a0dcd899605e3dcf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresets.js\":\"f72d77d28ebcc32c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/attachmentCleanerIOVerb.js\":\"a978fb44367d1f99\",\"/knowledge-medium/pr-preview/pr-1785/src/data/block.js\":\"41e1d893b56b1ed4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockCache.js\":\"8ef4130a898f630e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockId.js\":\"8ef613d7c0b38b9e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockLiveness.js\":\"f1a6481d3e74a586\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockMerge.js\":\"985ab6a4170cff9f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockSchema.js\":\"457d7dc0d4cb6084\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockTypes.js\":\"bfb3d9b1820fdb74\",\"/knowledge-medium/pr-preview/pr-1785/src/data/clientContext.js\":\"d15c4fd7b6c9df53\",\"/knowledge-medium/pr-preview/pr-1785/src/data/dbFileSiblings.js\":\"78b1d5f57bced7fa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/definitionSeeds.js\":\"fe5a9724073ebed5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/derivedIds.js\":\"1b29554d1f2305e3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/drawnSubtree.js\":\"429e8d75e861fed3\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facetBridge.js\":\"8f10d62761a3d039\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facets.js\":\"0fb24066df0931ba\",\"/knowledge-medium/pr-preview/pr-1785/src/data/globalState.js\":\"c71a7d601ec40003\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/aliasClaimRederiveProcessor.js\":\"1d96a6e8f4dd4ce6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/ancestorBatch.js\":\"bab4d423af73e6a9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/blockTypeTypeifyProcessor.js\":\"44cc91baf6fa24a7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/clientSchema.js\":\"90f59c69cbde331f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/commitPipeline.js\":\"38839301c8d511df\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/devAssertions.js\":\"23dba55129ebafda\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/firstSync.js\":\"7b99ebcaff63c321\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/freshInitialLoad.js\":\"8938e3307acac0ce\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/graphBackfillClaim.js\":\"9088ad0417468007\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/handleStore.js\":\"727924214a6dad43\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/idleMarkerJobs.js\":\"146cad10aeb6351f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/initialDownload.js\":\"a76bf76768278300\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/jsonCanonical.js\":\"fa07278559b88983\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelInvalidation.js\":\"2220a7492dc61e84\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelProcessors.js\":\"a4d0a54c14096415\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelQueries.js\":\"8d12f2972228676d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/mergeTypeMembershipProcessor.js\":\"bf742d3e01e15f7a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/normalizeReferencesProcessor.js\":\"ec8400b575a9d015\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/poolInstrumentation.js\":\"1dc46f3626148c6b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/processorRunner.js\":\"c73f03057efe8321\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyCellBackfill.js\":\"9672ded2662fb9c4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildMint.js\":\"05c887a8ba0b7eb4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildrenProcessor.js\":\"9f2474340666d8e9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionChangeProcessor.js\":\"fd1561f3c51e8aa1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionSynthesis.js\":\"c801157499e6c4f0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyKeyScan.js\":\"0e8d54ff78aaaf3c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertySchemaResolution.js\":\"a8659f7a11f10ead\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/raiseProtocol.js\":\"7e1b1a63b61f1f4f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/readBatch.js\":\"208a0912aa5f1a5e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/refProjection.js\":\"1d9b5544dc195c75\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetLookups.js\":\"6ebd1eb7832d4fd1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetProcessor.js\":\"568504f7853f2477\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/replayMerge.js\":\"a2de320b48813ede\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/sqlBinds.js\":\"59739cb51aba3e12\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"79037cbf58d1e536\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/arrivalProcessors.js\":\"b275524eb2f99f5f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/invalidate.js\":\"71361dc9a6abf995\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/materialize.js\":\"e4c2a7d36f00ef77\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/observer.js\":\"917388d8794edf41\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/reconcile.js\":\"bc071dd4c0ae4c0a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/timingMetrics.js\":\"a51eb77b344cbe09\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/treeQueries.js\":\"8d77f01379a154c6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txEngine.js\":\"b5f6b0a6974c8a5a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txSnapshots.js\":\"c9e8fabf32d2d6e8\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/typedBlockQuery.js\":\"95c47eaa96bdf3cf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/undoManager.js\":\"496d6086d0963bee\",\"/knowledge-medium/pr-preview/pr-1785/src/data/invalidation.js\":\"aef3da8eb3e0865e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelDataExtension.js\":\"729740e43a7bb38b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelPage.js\":\"1be1770ab4dd4b5b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelValuePresetCores.js\":\"d83b786726985863\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbCorruptionSignal.js\":\"415255f737758801\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbStorage.js\":\"927cfd0e4eb6b985\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbVfs.js\":\"e098b346e1177153\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localSchema.js\":\"9e2b132c4bb9511b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/maintenance.js\":\"d30eb8087e831bbc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mergeProperties.js\":\"57a9a629e1b82873\",\"/knowledge-medium/pr-preview/pr-1785/src/data/metricsConsoleHook.js\":\"83a1922684e358a5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/migrationsPage.js\":\"9822601b27168bea\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mutators.js\":\"465132b8dae59cf0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKey.js\":\"fa42f6b4d03852e4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKeyPlacement.js\":\"0232af3a44f79f24\",\"/knowledge-medium/pr-preview/pr-1785/src/data/outlineSurface.js\":\"0cef53a1456bbbeb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingEditorContent.js\":\"358f7871ea695975\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingUploadsSql.js\":\"bcd9889d942d9a40\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pluginStateExtensions.js\":\"6e4d9b9dc5e84164\",\"/knowledge-medium/pr-preview/pr-1785/src/data/powerSyncLogger.js\":\"ca60cabf42ef2c95\",\"/knowledge-medium/pr-preview/pr-1785/src/data/projectorRuntime.js\":\"01638f2d0adb25f4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/properties.js\":\"34690b5ea5dcecac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertiesPage.js\":\"f7d53a9aa8d4c126\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyChildren.js\":\"6437dda088995930\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionFanout.js\":\"00ea512ae3cde70d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionMetadata.js\":\"e396e1a760320114\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionRegistry.js\":\"bc36e4d4c08f0a48\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDisplayMode.js\":\"dae4ed1366391421\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyRowCreation.js\":\"34ab241a91cc5a56\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySchemaCreation.js\":\"8cea783418980fb0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySeeds.js\":\"ccd8a28a1016ee4e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/recentsPage.js\":\"802d02aed26d44b0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/referenceBlock.js\":\"39f0365a0b293041\",\"/knowledge-medium/pr-preview/pr-1785/src/data/releasePowerSyncConnection.js\":\"de52f8c103dda8bf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repo.js\":\"ba6070452a806b75\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repoProvider.js\":\"41e23c65c051b70c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/rowProperty.js\":\"676f1cea3c75a608\",\"/knowledge-medium/pr-preview/pr-1785/src/data/searchFilter.js\":\"94eb6ecec1be5810\",\"/knowledge-medium/pr-preview/pr-1785/src/data/seedIdentityLedger.js\":\"87cf71461181ddf4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/stateBlocks.js\":\"41d2b7d9cab2efb4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/structuralEditPolicy.js\":\"4933ed3af20f1fbb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/subtreeDelete.js\":\"0bb80edd7ed231ec\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncStreamLock.js\":\"f1befad9b477762c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableSqlRecognizer.js\":\"2f99ab4343bb74d0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableWriteGuard.js\":\"d1f120fd5072562d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/targets.js\":\"1ecf52368546bf62\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeColors.js\":\"217785508cb629f2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionMetadata.js\":\"ed23aac05ff25d86\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionRegistry.js\":\"29d06ee875f3371b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeExtraction.js\":\"880d7b1919664795\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeInitialValues.js\":\"d58c0465b941cf7d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typePropertyGroups.js\":\"730cceb7f25473ff\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeSeeds.js\":\"e4fb25cf2b85d9e5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeTagger.js\":\"fa4affcdb66e7a45\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typedRecords.js\":\"4e34c7a2221c6103\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typesPage.js\":\"af407b2c67c0cab2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userPrefs.js\":\"1d0dd3d74dadeed2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userSchemasService.js\":\"2241a84f7e5a80ca\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userTypesService.js\":\"099b966437e29601\",\"/knowledge-medium/pr-preview/pr-1785/src/data/valuePresetRegistry.js\":\"90ba6861a22d1867\",\"/knowledge-medium/pr-preview/pr-1785/src/data/visibleChildren.js\":\"b1ccb95b63e58ebc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceConversion.js\":\"624cf88e110d9a89\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceFirstSync.js\":\"684c73d5dbbde022\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceIdNamespace.js\":\"ec7cdfc4c992cab5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceSchema.js\":\"25f9bedbd2ccf98a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaces.js\":\"9b7ef7d0cfde7e0c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadLog.js\":\"22abbe64b697d972\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/BlockPasteShellDecorator.js\":\"58b4c70464800231\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/atTrigger.js\":\"c9770c9a4fb4246a\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/autocomplete.js\":\"1fd4598f2efbc204\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/codeMirrorExtensions.js\":\"bfbe6f0bc927248f\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/contentFlush.js\":\"8ee7f6b07659c0e7\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/defaultInteractions.js\":\"54d8994a0a9969d4\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/editSettleSignal.js\":\"83eacd9149bb389c\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/insertImage.js\":\"18a28ceb41c5eb15\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceCompletionRange.js\":\"60c3691a5e4ccdd7\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceTargetTypes.js\":\"75d6057bcde7c77f\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/syntaxContext.js\":\"5f6947d6ed2ce4ce\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/triggerMatch.js\":\"3603924f9aa40a5f\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/AppRuntimeProvider.js\":\"a8e3d0882f0755e6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/BlockFocusShellDecorator.js\":\"1144385fa2d085b4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/ExtensionRenderBoundary.js\":\"6fbd3fde10067e23\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/PanelContentRecovery.js\":\"65884a75d877dee4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/apiCatalog.js\":\"47da2f2ee1ec724e\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/approveExtensionHere.js\":\"8b92dd67dc33d4bc\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/armedCutAppMount.js\":\"7dedfa07f33a8165\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/batchableKeyedStore.js\":\"b9c1240955dc32da\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockInteraction.js\":\"f924b05a3d22cc0c\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockSelectionAction.js\":\"b5167778a6425860\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compileExtensionModule.js\":\"000597593faeb9bf\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compiledModuleCache.js\":\"c0d4faf21414b939\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/continuousGestures.js\":\"64a77e9a7ae26789\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/core.js\":\"f8b8ece872113dd0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/defaultRenderers.js\":\"fa8155c220fce9bb\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/definitionFanoutAppMount.js\":\"0050069d42c94ed3\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dialogAppMount.js\":\"a574b4acaac2243a\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensionSeeds.js\":\"1b9d87e33cffb4ca\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensions.js\":\"a84be491e63a35d7\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/exampleExtensions.js\":\"0f14fedb30e515ac\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionApprovalStatus.js\":\"eb23be1b7f696f23\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrorToast.js\":\"39826faec0f418b6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrors.js\":\"479ddc8c415481f0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLookup.js\":\"89b249f0ed22ca80\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionToggles.js\":\"8dcd30809acc5d64\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionUtilitiesCss.js\":\"fa59436e19488ca6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/kernelPageDeletionGuard.js\":\"fb0967a153882ba0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/liveRuntime.js\":\"e0a180fdb858dc73\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/openExtensionsSettings.js\":\"c736fecdc675066c\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/overridesCache.js\":\"d1833316b14af427\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/pluginIds.js\":\"6bd410052a38993d\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/processorRejectionToast.js\":\"1c270b473bebca2c\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeActions.js\":\"7b9622e339da51a6\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeContext.js\":\"4b01b5df05dd121c\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticAppExtensions.js\":\"edfc3c7fd033060e\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticDataExtensions.js\":\"079865869074bd7b\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/toastAppMount.js\":\"2103fa5d69da71a4\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useOverrides.js\":\"8b754dde84bba444\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useShortcutSurfaceActivations.js\":\"1c218082befb9552\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/discoverToggleTree.js\":\"4efd9e5973b8c008\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/facet.js\":\"71cde132bcc2edc1\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/resolveAppRuntime.js\":\"ae67bc940268a442\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/runtimeEvents.js\":\"b3e19f2cedd35577\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/togglable.js\":\"0b8a59a4371b9470\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/variantFacet.js\":\"78895f2683b25b96\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/verbFacet.js\":\"39e12abf6c798b4a\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/block.js\":\"c9b82b21388cadc5\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/focusedChild.js\":\"db476ef1f59288e1\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/propertySchemas.js\":\"0a38e0f6502b0cb5\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/typeRegistry.js\":\"4e96abafa2bfde78\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAncestorCrumbs.js\":\"f6f72eeb368aa7f1\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAutocompleteListbox.js\":\"3f9e9a894fbc09e7\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedSearch.js\":\"a614c26e6ca18055\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedValue.js\":\"d5c924b4d111c847\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsFocalRender.js\":\"f1fbfe5e38dff76c\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsReadOnly.js\":\"36a711a243035c9d\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMaterializeBacklog.js\":\"7e3838c4a2004aa4\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMinuteClock.js\":\"afb6c1540b73a40e\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePanelLayoutProjection.js\":\"105042879ea60d0f\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePendingInvitations.js\":\"229eebb72465f286\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRendererRegistry.js\":\"2a89d9db1ecd9ee0\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRetainedFieldRows.js\":\"ad9a32943d9de95a\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useWorkspaces.js\":\"7e18bf898c3dd872\",\"/knowledge-medium/pr-preview/pr-1785/src/lib/utils.js\":\"30a769ead009620a\",\"/knowledge-medium/pr-preview/pr-1785/src/main.js\":\"3c9f30b6597d740a\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/MarkdownImage.js\":\"66e3c9546f350fd4\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/blockSeparators.js\":\"53053fcdadaa23a0\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/context.js\":\"1f0a0ef287e7d01c\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/defaultMarkdownExtension.js\":\"5a73ca9926298e55\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/extensions.js\":\"724742fe1613ee26\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/renderMarkdownHtml.js\":\"1853c4af5a6dc032\",\"/knowledge-medium/pr-preview/pr-1785/src/minimal-editor.js\":\"ced4125d8d512598\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/armedCut.js\":\"b0ec7c2c3454b99d\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/captureMediaVerb.js\":\"53c317c096b03eb1\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/clipboard.js\":\"964b8149d91819b5\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/decision.js\":\"1f0064a6da95935a\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/operations.js\":\"6a4fa2e37e1dfcad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/AccountHeaderItem.js\":\"ed31a78e173f1a92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/index.js\":\"4da56440f5bab0aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4a6be8c56f029d92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askAgent.js\":\"e33362af9209ccc1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askedStore.js\":\"638ba5f16a8232c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"feaeec8fa9386d94\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/chipState.js\":\"ec35d0b24b98f53c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cc3445fa930a72f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/index.js\":\"138b7f0974f3fa76\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b83c62d94cc18b08\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/schema.js\":\"b1b6440959b047df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7a78a59566af1b41\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ac4a6f4aa74b8836\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/addMedia.js\":\"792082a79272a0a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4ad278eafa8e9ba6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/block.js\":\"2bf68cf22343d051\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/context.js\":\"ac3697f5e9e24072\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c4b9d4e5ba4708f4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/index.js\":\"399a034dbcba4716\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/outline.js\":\"a07e05e7ebad49f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/properties.js\":\"e93cbee544cdc851\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/refs.js\":\"52fd9e3d61fb962f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1d0af10e202715bc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/search.js\":\"4947a497432a3050\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/shared.js\":\"7354267098ffbe0d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"512eb1c27950335e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/text.js\":\"9c1fda8e86c17007\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentWrites.js\":\"78cee31f5d08cc99\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/authoringCatalog.js\":\"2823f9608f148afa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/blockRefTargets.js\":\"a0b8d642deca9a50\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridge.js\":\"6ae3277dff3b5088\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridgeLoop.js\":\"6328e33cc5e1641b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/changeHistory.js\":\"51a1e433d60a249b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commands.js\":\"52a98e4e87ead2ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commentsCommands.js\":\"a63eb352f76e267f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataExtension.js\":\"4e65746e6f4508f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataModelGuide.js\":\"cf3f62110446bfac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/describeRuntime.js\":\"4e2db2764d474000\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/extensionLint.js\":\"5379ece27c9096e3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/grainAudit.js\":\"8ff62856682b8bc3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/healthCommand.js\":\"e792074dc63aa1bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/index.js\":\"3b22d2150400b46a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/presetIdentity.js\":\"9ce697b81f45de2f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4603fb9f645469b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/readMedia.js\":\"ac1c04761429fb19\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/schema.js\":\"24131a9f2cc32ccd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/serialization.js\":\"078f9df1b3b050c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/targets.js\":\"d1335fea32f35735\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/tokens.js\":\"8954cc0e97b83d77\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/watchEvents.js\":\"d0757d3b33dd9926\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/workspaceGuard.js\":\"88712fb58390d1ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/writeCommands.js\":\"11e8bb46f59b8a61\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/AliasCollisionToast.js\":\"e62107f2d361a18b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/DuplicateNameBanner.js\":\"d13aa9e45cda61c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/collisionMerge.js\":\"c6284e973e16928c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/dataExtension.js\":\"ccfdf42347f0af45\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/index.js\":\"01a7af6bdb5d3359\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/mergeCollisionAction.js\":\"5a7dfa9d519bfd99\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/pageStyling.js\":\"cdb877702816b5e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/rejectionToast.js\":\"c74b206be566ce03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/syncProcessor.js\":\"1834fff0062b8cab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/actions.js\":\"bd91c183f3a06a44\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/addComment.js\":\"691ff3a5ca831ee8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchor.js\":\"d8a86e3c1afc152c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchorState.js\":\"1b7f467bba082be3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/commentLinks.js\":\"d880e5811d2056fc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/confirmThreadDeletion.js\":\"26db163f30288154\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/container.js\":\"f48c1c70fc6013d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/dataExtension.js\":\"7574f95604a4a2b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/deleteComment.js\":\"073f19b8c20f92d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/highlights.js\":\"42ffe5f914954176\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/index.js\":\"46c60a6966d99d51\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/linkedCommentsPill.js\":\"05abac6061e035b9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/margin.js\":\"75679e2d029f3f0b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/marginSchema.js\":\"690191fc8f405947\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/newComment.js\":\"2bef78893727fd3f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ownThreadPicker.js\":\"37586ee5c029c14c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/placement.js\":\"3a14acff7825f17e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/queries.js\":\"586aca1d7b7d0b28\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotePosition.js\":\"1169ed610b6fa72a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedIn.js\":\"5cb11f467aa27b9e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedRange.js\":\"db2a607efa90ecb9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/rangeRefs.js\":\"74b10c5412f11d12\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readHighlights.js\":\"fe0327205ec81009\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelection.js\":\"8e0456bd8e6cdf6f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelectionUi.js\":\"bf4a8e68acd06dc7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/reanchor.js\":\"15891600fae428f0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/schema.js\":\"c3aeb506c018dd16\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scope.js\":\"006e2d861d2adee4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scopeThreads.js\":\"07f0ec5b20afd76f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/splitRetarget.js\":\"9d223d9312cc2ddd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestionCard.js\":\"3090ef57e9357be2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestions.js\":\"2f5ee9da104334f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaries.js\":\"226951821bff87cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaryBatch.js\":\"e3f07e8a43e3a8f1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/surface.js\":\"e8a1f3245c100689\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threadNavigation.js\":\"2b26a788b4af3ea5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threads.js\":\"22f723584c6df261\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ui.js\":\"fb4c3dd0baba394b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/uiStore.js\":\"04dbfc5216cc58a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/appIntents.js\":\"7f67b1ed0c49a4b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/index.js\":\"f39fd1cfc0b737b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/index.js\":\"b73d112f39ea416e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/status.js\":\"bb21719e9c787910\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4d6fec0e0049b002\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaBlockRenderer.js\":\"309f663119cdd5b6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c105a58ee7a4e970\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaUploadReconciler.js\":\"14327bc370b72f9f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetDownLane.js\":\"9c430f6dd973ef25\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetResolver.js\":\"be21292f8f5de1c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetUpload.js\":\"a0221f85016c7470\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/attachmentCleanerIO.js\":\"625700551677dc57\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/supabaseAuditIO.js\":\"19269e88974980e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/blobStore.js\":\"d95620fce203baad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/byteStore.js\":\"36ff9d79732ad4cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanerIO.js\":\"d06542f39a8ee790\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanupAttachments.js\":\"ce30c81aa523d7a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/dataExtension.js\":\"abf55f05339f06f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/downLane.js\":\"6b5c39256a95772d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/index.js\":\"089ddb11e12714d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/insertImageContribution.js\":\"9c730c35019b598b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneArming.js\":\"d9142a5228c0c2ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneLock.js\":\"a55cd1d71e86df37\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaBlock.js\":\"b46b84d94e5169c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaCapture.js\":\"b57e8e7280c709fa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewers.js\":\"236f06740b76767b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewersFacet.js\":\"56ffa213fcda3d97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/pasteCapture.js\":\"6afb248d62984c71\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/resolver.js\":\"391f1cc7ebdca22e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/retryUploadsAction.js\":\"1e10d13f2e666d96\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/storagePaths.js\":\"49990e8b10337698\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadDrain.js\":\"830da6be552ff5d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadLaneStatus.js\":\"e6a3bc931a3e788e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadReconcile.js\":\"6c42be0a2b6de246\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadRecovery.js\":\"d5924ff8da5d89f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadStore.js\":\"d000e08c0b2da2ac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/useAssetObjectUrl.js\":\"cdcd01bee0287ddb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a7548e9ac84c3c2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6c9c7abb07482e03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/facet.js\":\"0c62c6a573c5af5f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/index.js\":\"1ba021d70a638af8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/prop.js\":\"525a636a8af1c409\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinkFilters.js\":\"37669606f3342b05\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"422e7a8579a319c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BlockEntry.js\":\"121ab429aa412d2f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/LinkedReferences.js\":\"c8f7409aa0c2150e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"984c9a220f01697e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dailyNoteDefaults.js\":\"493ae764c3be073d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dataExtension.js\":\"b5ac5e94ed6d6cb9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/edgeExclusions.js\":\"5cca0839407195c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/filterProperty.js\":\"b13b12be8cea28ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/index.js\":\"fd40238b3ce75244\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c2b057a47234c4fa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/applies.js\":\"2d7866d07695c4e2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/countQuery.js\":\"97987d3bdd02c96b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/expansionStore.js\":\"69f96e530d5ca630\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/index.js\":\"bc3a9ffe17716338\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"403469e8dda37349\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/presentationInvalidation.js\":\"5f38fdc4a75de768\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyEditorOverride.js\":\"13d58fe6c96210da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyFilter.js\":\"2382b8227ecfa9dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/query.js\":\"66ae18c212db1f88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/resolveFilter.js\":\"6c3b62b477013479\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sourceBatch.js\":\"0c9db005d1e9b3f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sources.js\":\"3e20e42a7a79305c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useBacklinks.js\":\"1dc1f1c7d6932fde\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b0bd611de56641f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayCelebration.js\":\"5fa35f538de9a9bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayOverlay.js\":\"805486e5a4d3e759\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/gate.js\":\"4cd94d0b5835bdc7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/index.js\":\"6eb1ab010e946efd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/wolfTheme.js\":\"3cca695b3be8fe1b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/BlockDragLayer.js\":\"b24b13edc10a4f03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dragController.js\":\"e3756422dc896b59\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dropTarget.js\":\"be270d2ebad1bfdf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/index.js\":\"bd5e5a72d23a1527\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/projection.js\":\"65666abd626a39e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/BlockMetaCard.js\":\"3f22c8f79e522887\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/index.js\":\"6773a37706377136\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/AddTagDialog.js\":\"b7cba4ba874290df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"deca085fc0cd09db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/TagNameIssueHint.js\":\"a36f12ef7f7f487b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/addTagAction.js\":\"c446a028194cee6d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/appendTag.js\":\"189de316d7c9fedd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/config.js\":\"0a512c55fa7652c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/dataExtension.js\":\"90fde67d9d2e0739\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/index.js\":\"8bbd2809036e9cdc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/propertyEditorOverride.js\":\"a99c0fa31a1e620c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a338be8a88e6a41a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9d553bc9deaf0369\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/Breadcrumbs.js\":\"cd80e5a09010d1b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"495261449c2f6e13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a57d0df001089386\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/index.js\":\"4fcadc3e31881d40\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6dd4a92886004b6c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/CharacterCountItem.js\":\"6dcd25507234da93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3426aa301a24c10c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/actions.js\":\"ec55f47db1185665\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/blockType.js\":\"c241603cd6968fe7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/charCount.js\":\"b0a4b0e710befcc5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/dataExtension.js\":\"fe1422abf2f8a08e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/index.js\":\"52bdf278a7dcc6f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/profiles.js\":\"6463712e9cf7353d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/properties.js\":\"c9ac560c972e8672\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/textCounts.js\":\"83fb817bb91e063e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/colemak-keybindings/index.js\":\"d146bd0a2d291ae0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/CommandPalette.js\":\"3468c89331fe2971\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/HeaderItem.js\":\"7c0cfc425dbae05d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/context.js\":\"833484b9eaa28c75\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/index.js\":\"432c1d2defce0310\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/selection.js\":\"05b20bf3192d2e18\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/toggleStore.js\":\"cce1762f4c82c6ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/useCommandPaletteActions.js\":\"2013cf08355fe20b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/ContributorBadges.js\":\"3d6923c06dba547a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/author.js\":\"7a629f0507f065e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/codeMirrorExtensions.js\":\"b23f1a5fc198403d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/dataExtension.js\":\"acab81191d9aef5c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/index.js\":\"05592efae136438f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/mentionAutocomplete.js\":\"8b0f1487a1c0436c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/processor.js\":\"0ef544301df51552\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/profiles.js\":\"38c11962372a66dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/queries.js\":\"d777c3fe7677c5dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/schema.js\":\"24504557edbaea47\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"12c18381b210eed7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5edc66c441182612\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/index.js\":\"8ecf5d935b73f6db\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3b4db9b768150b75\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d0802fabc0513db4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/CalendarGrid.js\":\"34837a57ff25d38c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DailyNotePicker.js\":\"5a4c2cbf69a939a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7ca819364f502601\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateNavDecorator.js\":\"186b89ee44ff8a6c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateScrubOverlay.js\":\"771ad46631039fc0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/HeaderItem.js\":\"03e39c4a7a9e2431\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/ReschedulePicker.js\":\"4e654adcf124da64\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/SpreadDatesDialog.js\":\"39bd8550d0c17d92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/actions.js\":\"38123185f4d9a4a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/blockDateAdapter.js\":\"2fed599962a9ca85\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/calendar.js\":\"c23f1568e0815062\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dailyNotes.js\":\"52f88b03ec721a33\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dataExtension.js\":\"e3f34323229f1713\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubActions.js\":\"a37ab5dc1bca9c22\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGesture.js\":\"87dc300c13c7d599\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGestureActions.js\":\"339231c4537c4e66\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a2886449e7ddb352\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/deletionGuard.js\":\"3429800f72aeb8f3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dueQuery.js\":\"7f6a83b4fab189b1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/index.js\":\"77ef24f60538761b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/landing.js\":\"a3d46f3c1c7c261d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/localSchema.js\":\"efb9e8e0a1339eed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/referenceDateAdapter.js\":\"4a6f43be815d4825\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/rescheduleAction.js\":\"890d8cd9be2e7ce7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/schema.js\":\"84ca75316436a4c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadBlockDates.js\":\"eb02ea50107b5d3a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadDatesAction.js\":\"8a71cf4897c6446d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/today.js\":\"d7871309e82c3470\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"74eb372c41835a17\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a290aa57746b65df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/audit.js\":\"0f9c7f79d2375550\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditAction.js\":\"3f8d4235667501a2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditRanges.js\":\"5d57c7088262494d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/diagnosticsSource.js\":\"7e597c313d6b2d2e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/divergenceScan.js\":\"42a8f4efe8c98af0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/index.js\":\"f23959053227fbb9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6a8975ba149e9c99\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/referencesMirror.js\":\"544179537daf1d2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/rowJson.js\":\"9d1dceaf293e0d84\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/schedule.js\":\"756bb2f1a5c5b830\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/store.js\":\"98484c63fb1ce23f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/action.js\":\"7d74bdc7b945bf42\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/index.js\":\"c91c10c5308aae89\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/plugin.js\":\"3604f11bb901398a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"849d6a941f245f39\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/actions.js\":\"a0b6e9cb0b28bad2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/changeMarker.js\":\"d5e45d390e9ccb0d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/diagnostics.js\":\"e88d882bd501c0be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/fileSystemAccess.js\":\"1f7ec22d41659384\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/filenames.js\":\"284603548d32870a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/index.js\":\"d2842493382ef221\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/mirror.js\":\"e971ca8956a9f550\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runLock.js\":\"ec29a791a4f58f41\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runtimeHealth.js\":\"5660fcf953ce0bb4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/schedule.js\":\"1db66b6bba67686d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/store.js\":\"1059068347be5175\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/index.js\":\"1d5892679a6aa9c1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/themes.js\":\"a69e1b35b1e1bfaa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/facet.js\":\"9eb7eaf2d1a38418\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/useDiagnostics.js\":\"d56ee61446764b83\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/dismissals.js\":\"427cf5a492cce94b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/index.js\":\"31314b29b926fdef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/status.js\":\"cc9885ee7d421617\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/store.js\":\"da039246723318f4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0b2dc5e64d0bf6e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fca0196ada8092e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/actions.js\":\"5767d5b37816a0bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/config.js\":\"f2c0d8f99fb7cb98\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/dataExtension.js\":\"a503f4098d61844c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/effect.js\":\"d58c817ba57b62dc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/index.js\":\"8b201755f78ffdfe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a765113dc9963ab8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/useToggleTree.js\":\"ecdfc57f9b21d432\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/ExtractTypeDialog.js\":\"54ba5025415b4b32\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"115fe15b3fc37610\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/PropertyShapePicker.js\":\"f234baecf65f7a13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/action.js\":\"0ddbcb47d601d5d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/index.js\":\"9d7498b022c25a13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/FindReplaceDialog.js\":\"537ad4aeb9f7ad00\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/HeaderItem.js\":\"f151a5b780e89fa7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/dataExtension.js\":\"026e152f267aa7ce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/index.js\":\"eeb3019680cc7369\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/search.js\":\"7fb418aff8d6fe5a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/toggleStore.js\":\"8446543a67798a48\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/LocationPropertyEditor.js\":\"cfecf62a74d38140\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/MapView.js\":\"6fa415b98b0dbca9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/blockTypes.js\":\"33347e112cacd661\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/codeMirrorExtensions.js\":\"59085cb3c6226012\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/createOrFindPlace.js\":\"e3e5678c7c772eb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/currentLocation.js\":\"cb6afd146f010692\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/dataExtension.js\":\"3538a78129dc5fdf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/geoContentDecorator.js\":\"6ce12b49cdc5ebc6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/googlePlacesClient.js\":\"15cd98c177f9c538\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/index.js\":\"54456a38e2a4cca8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/locationsPage.js\":\"6eb551dd7e3087b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/mapViewport.js\":\"0b2b2a5b16ca758e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/pickCurrentLocation.js\":\"9d335efbbc2a68d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeAutocomplete.js\":\"be73c1476746a046\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeNameCollision.js\":\"414dbfe77a62ac4c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/properties.js\":\"e9f661e09b506774\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/propertyEditorOverrides.js\":\"ef156dde4b717493\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/query.js\":\"33c0100ef5d7f177\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/usePlaceSearch.js\":\"18c727526814d777\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"613da27debaf55ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"625d75c533ae9f47\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3e9f6b6621b7e403\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/config.js\":\"c18e063bfc7977bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/dataExtension.js\":\"59684d409c6a4d5e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/facet.js\":\"19f5d12566f401a6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/grouping.js\":\"b9abedc5c2523a31\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/index.js\":\"1e06c52e01b9ca7a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"06aa5f558d611efa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/query.js\":\"fe09e23b33c7cea4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/resolveConfig.js\":\"a4aca631d25c4858\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5665735202fc1b07\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"babb5418e6af3501\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlDocumentContent.js\":\"51649df81b6fb6e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlFrame.js\":\"dcc0e18d608535ec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/actions.js\":\"9c1cc51ba5fa1583\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/blockType.js\":\"7a0d4f69e9a42d48\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/confirmRunScripts.js\":\"e0ba6bbb510e66b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/dataExtension.js\":\"7d61b5ccf5cb5574\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameAnnotations.js\":\"fb1e36b6e756e7ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameDocument.js\":\"70a879ec80052045\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameTheme.js\":\"87be6e289870a900\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/index.js\":\"9af8d1ead1cc9e7e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/scriptConsent.js\":\"703dc0900e6a777f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/sourceMap.js\":\"866c9cc49e58c479\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/useDocumentScripts.js\":\"b701bb45c188dc14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/index.js\":\"e79bbe1b99c932b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/record.js\":\"f49ad10e3cc592ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/recordStore.js\":\"e1ce2e100f9f8ef8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/responsiveness.js\":\"632eda13ee7c4271\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/schedule.js\":\"247e78fb3e09bbb6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/sessionContext.js\":\"186188e56d089fa3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3ab6179d55845c72\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"94fc2a2d2fd575f3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/actions.js\":\"87a5e6da1ac38bfe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/config.js\":\"95c6b3f9ac184163\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/dataExtension.js\":\"a2b3b13081e05ed1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/effect.js\":\"9d4bccd57320fcb6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/index.js\":\"fe43038db7b26e04\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/keyCapture.js\":\"c265e842c2fcda4f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/overrideStore.js\":\"f481ad782111a0f0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6c2de42eab835b84\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/HeaderItem.js\":\"22f81da8471a38d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/LeftSidebar.js\":\"34bcf014c19e4c1b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/actions.js\":\"30cb6a67fcc56de2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/facet.js\":\"e6f982eb9dc2d9f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/index.js\":\"b15d9a76626d626c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/shortcuts.js\":\"e021da77e1bb551e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/toggleStore.js\":\"003d690490d4ac0f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/MergePicker.js\":\"f1b2fc924f178c23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/index.js\":\"0ccd91244539f18a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/mergeAction.js\":\"931d7c9bd910c87f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/strategy.js\":\"c965bff9acecaf81\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/Button.js\":\"a4df9ca23d769544\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d9f9963cfdd1d962\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f80f85ab35c55686\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/facet.js\":\"5c719993a64349e9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/index.js\":\"6a03e65b9c1f583a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f8f25e14c4ab53bc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/actions.js\":\"69e0f61d9cb8d97c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f07de7223790f8b6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/facet.js\":\"96370efc5d8b3f23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/index.js\":\"324311939ceb5854\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5db3897b1be46c29\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0e5d3f4e2ab4f3a1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/contextMenuItem.js\":\"d9f68e90fb7cb709\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/index.js\":\"f32152700aed7887\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveAction.js\":\"dbb59d12593c3a89\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveBlocks.js\":\"663e9279ba5838cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/selectionAfterMove.js\":\"82b9e6b504335efc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/TutorialBanner.js\":\"4417c10c472e3283\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/action.js\":\"9eca875af3d20064\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/bannerDismissal.js\":\"e404be7ef89bfc9f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/documents/cheatSheet.js\":\"c3a84269341c480b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/index.js\":\"b7ee299077fea3b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/keys.js\":\"da5821f32c1f0d4b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/landing.js\":\"f46c7f486d232e3e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/outline.js\":\"f2c891af256b15d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/seed.js\":\"6f31e6d136789f73\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b99ecdd984c8710f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/analyze.js\":\"61db3d0a17d7d024\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/diagnosticsSource.js\":\"8f7374e8e35b25d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/index.js\":\"abc14615f41270e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/load.js\":\"844184e691b82fd5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/monitorRun.js\":\"0e68689948993fa3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/schedule.js\":\"1c5846692319e98a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/series.js\":\"b6f4ae1e249834b8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/store.js\":\"c577484c53418e71\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/trendAction.js\":\"5933659aaeb4182a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/verdict.js\":\"a9523775001e2651\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/clickToEditAction.js\":\"363672a7291dd42e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/index.js\":\"f4d1f6382f9e6ed3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/interactions.js\":\"f87c49fe02b0c04a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"af57a816ec34ecb2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGate.js\":\"48dd569e80e22ce4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGateDialog.js\":\"0b5eea2bae792768\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/action.js\":\"4f8c9a5a32c22857\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/index.js\":\"076dd593ee799a87\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/localRunMessage.js\":\"69781e775fe0c118\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/plugin.js\":\"64c436130cf5d029\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/progressReport.js\":\"0506e2c27bbe456f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/sweepProgress.js\":\"aadb6f16db55b3e0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/FieldRowRenderer.js\":\"84164dc565e5ccd6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/ValueRowRenderer.js\":\"859e4ec2b60e48a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/actions.js\":\"98a98ae65a870bde\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/autocomplete.js\":\"b00e3498c44192bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/fieldRow.js\":\"bc4b85b279af8ffa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/index.js\":\"0c68632394d5abb1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/referenceWarning.js\":\"fd5cd10735fbf517\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueAutocomplete.js\":\"d212db8a552aa6c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueSchema.js\":\"5ea18f8e834e3372\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/HeaderItem.js\":\"e275e5324434a803\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/QuickFind.js\":\"85daedc165f93d36\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/index.js\":\"c45045390f182c2a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/recents.js\":\"135047ad8663bc21\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/resultItems.js\":\"aa32ee75bd2a4918\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/selection.js\":\"12e05ee9f6701907\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/toggleStore.js\":\"1ad4b773d87a7e30\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/HeaderItem.js\":\"1771fe87eba7587d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6a61d89ad202a183\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/grouping.js\":\"ec7b2118b68b963c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/index.js\":\"dfa70c56d2051eb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/target.js\":\"b120a9bc9ab97f9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/codeMirrorExtensions.js\":\"c6f4c28051cc8021\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/contentPrefill.js\":\"7ad345c221f4f98d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/dataExtension.js\":\"b556b17320e56e23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/index.js\":\"063fc06ad6f1918c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bc5fc973639a57e0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/invalidation.js\":\"1e2416433ea71ad2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/localSchema.js\":\"ec31b475cd1d3b19\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/index.js\":\"daec54131f946da7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"978e19d7737c6181\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/index.js\":\"2fc4c23dc6e8a4a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/referenceNode.js\":\"7da983308f5430af\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a38b508fd68f7713\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"415b1950fc3c2b66\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/index.js\":\"cedaf0b202bdfc0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1829c76efe7cca0b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2e32e0253a0ff0ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/mergeRetargetProcessor.js\":\"767d407faa43e41a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/parseFence.js\":\"349d533b7c8a1a67\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceParser.js\":\"22b9fc4cac26a3c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceProjection.js\":\"9e1671f6a526d4c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referencesProcessor.js\":\"4d0c9268898e6ddf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/renameProcessor.js\":\"19b06fe8e70b4943\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/spanReplacement.js\":\"8488054e7ea4c80a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/htmlToOutline.js\":\"6d42a4b94b22057d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/index.js\":\"58e8657afa6056e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/normalizeClipboardDom.js\":\"96eec7349927f595\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/pasteDecision.js\":\"5f678f2bdb5c1134\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/action.js\":\"fe68f84a8d6e4643\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/blockIds.js\":\"52e4bd5fe55828e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/content.js\":\"984316dff00a6734\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/effect.js\":\"4e0c810d7f6179f4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/ids.js\":\"352fdb411e6972d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/import.js\":\"661eda384938d71d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/index.js\":\"3806d70b11f86d33\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plan.js\":\"d73ffdb64d0d7968\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plugin.js\":\"6001b04a13dd6773\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/promotion.js\":\"8ca7eccd954f51a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/properties.js\":\"b790d5db76f55ad5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/references.js\":\"bc37a1610fc30217\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/report.js\":\"895dc0516c12132a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/roamMemo.js\":\"f4ca3e025351b582\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/runtime.js\":\"5826cbd2112e9df1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/schemaReconciliation.js\":\"84d78d7f03bb6590\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/srsMarkers.js\":\"f14ef55040ed4e6b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/todo.js\":\"9f3a2164ed7d3cf1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/typeCandidates.js\":\"7b52678dab323a3d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/types.js\":\"121f49111ad2092a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/index.js\":\"66914180c4421ae2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/store.js\":\"11483dc4be14ea2e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/HeaderItem.js\":\"f40c06b91486d26a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"94e4cb83ca3e57ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/index.js\":\"9fba49821c5a8b2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/model.js\":\"f657103823f47c71\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/toggleStore.js\":\"6231019d3407a99f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/useKeyInspector.js\":\"e1187a1b341965b9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"40dd7436ea2a4ad8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/ShellDecorator.js\":\"e70712407518049a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/actions.js\":\"ed3dc40901bcb016\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/exclusionsFacet.js\":\"34a764462d787238\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/index.js\":\"36df6a418d7d807b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/shell.js\":\"eadf3b23036c67b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/surface.js\":\"6ee19a608d8c06e2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/walker.js\":\"ae0e783f7cdf1147\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6f7be61fd961ff32\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/dataExtension.js\":\"3d2b586d8bf9d7c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/index.js\":\"320f5fb1d9435a7b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/indicator.js\":\"d98d75be48680b73\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/moveSrsState.js\":\"2edfa07f0f9bb78f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"039e95f443b7a3a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/scheduler.js\":\"60df32131f004208\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/schema.js\":\"3a8b973227243645\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a89c00b59ae64852\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsClipboard.js\":\"0d8ae95167db2ed9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d2fe9b5d0fe9b167\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DailyNoteReviewHint.js\":\"677cf9ec53868b43\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DeckPicker.js\":\"9dc9e0fdc6008b01\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewControls.js\":\"f6b22f0559c17a4c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2fc81426072cc5d1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewSession.js\":\"de5c089aef5af67e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/actions.js\":\"4f09dc23ffc42771\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/archive.js\":\"0c02474f530304b2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dataExtension.js\":\"9bb26759abfd454e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/deck.js\":\"e273e81d30f7a784\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dueQuery.js\":\"fa43941929f0e7a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/gradeDecision.js\":\"e8a1c382b86b08c2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/index.js\":\"315de8ea6a1bb1dd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/keyHints.js\":\"5adb8ec5c2ab3403\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewCardLayout.js\":\"08ab391097c73a8d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewProgress.js\":\"babd560d0c1badd1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/schema.js\":\"0b0d14f282861ff2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/useDueCards.js\":\"bb1a16f582db9fbc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/index.js\":\"fd7a8d5080df7450\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/record.js\":\"b560b809336119c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/index.js\":\"9e40a5c36aff5e09\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/persistenceStatus.js\":\"7a45302d26fe10ca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/requestAction.js\":\"f3633a4afdacdac6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/TypeChipsDecorator.js\":\"bbe3c1e50b9f7778\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/codeMirrorExtensions.js\":\"105f2aae84e3d46b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/index.js\":\"3700acf8c78a4e6b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/typeAutocomplete.js\":\"23d862b3b6a0599d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d82386f7b92ae304\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/actions.js\":\"c34ae1d4e0639684\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/anchor.js\":\"36d0911e56028453\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/events.js\":\"38f21a101f3e0eea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/gestureActions.js\":\"3246e4a9b52d4cb9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/index.js\":\"c292b10036ccad6a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5bd62094f88d9d06\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/collect.js\":\"8507855e4b3444eb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/index.js\":\"84020e90d10af537\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/record.js\":\"fbee89f2aaa1cc03\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/RejectionDialog.js\":\"b2788de80115ae09\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f1f31401f0dc93cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/index.js\":\"a6b082b9537a8a99\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/model.js\":\"5a12af413ef073fd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/queueCounts.js\":\"08034e8c48a57a4d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rejectedHelpers.js\":\"ca43c038a2398096\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rematerializeAction.js\":\"cccf024d99162a73\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/useHysteresis.js\":\"4148216a2810cbbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/effect.js\":\"14cc977b108e385a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/index.js\":\"372845ef6225f407\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/theme.js\":\"1bf6f61421a589d2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/actions.js\":\"19127f4701d93700\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/dataExtension.js\":\"53cd23e8230d127e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/index.js\":\"2a08fa39ac4f7f84\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/schema.js\":\"cbecaac794e71567\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1f9da2af81951f20\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/actions.js\":\"8277bb6d9231a75a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/defaultItems.js\":\"47df0d02cee7feb3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/facet.js\":\"f3a526f55743e884\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/holdRecognizer.js\":\"b77ecb5dc97f974c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/index.js\":\"a6881e3a37707823\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/UpdateIndicator.js\":\"763fdf97f5d5912d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/index.js\":\"abe912f00649353d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/loadTimes.js\":\"d44fb4c617b4b5b0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoNotesRenderer.js\":\"1bb7ebf6b82af46e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoPlayerRenderer.js\":\"69ea1fc0d87d6df5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoTimeStamp.js\":\"3e3f7e7ce5146865\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/actions.js\":\"c47b5ad531eebadf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/index.js\":\"08728e2539bc8184\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/markdown.js\":\"fa5c7970b28d693e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/notes.js\":\"02dddbf978ed5c9e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/registry.js\":\"891571122861051d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/remark-timestamps.js\":\"771475b023ee091f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/view.js\":\"040805a8de45c74e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/LinkHints.js\":\"64b3d89883ccb1c6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/index.js\":\"76ce6a6ac87be122\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/model.js\":\"2a8fdf7b49205ac6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/settings.js\":\"69dcd526e15e558a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/actions.js\":\"dfe6c19fc6c5b755\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/index.js\":\"5d81a5b611bbc33a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/interactions.js\":\"34d3dc56429b494b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/workspace-header/index.js\":\"4a5f60bcfec6f4df\",\"/knowledge-medium/pr-preview/pr-1785/src/registerServiceWorker.js\":\"fa20cc00096bffaa\",\"/knowledge-medium/pr-preview/pr-1785/src/requestPersistentStorage.js\":\"ce2e948faa0a4ab6\",\"/knowledge-medium/pr-preview/pr-1785/src/services/authRequestDeadline.js\":\"c59b12e2b078017a\",\"/knowledge-medium/pr-preview/pr-1785/src/services/powersync.js\":\"9e7a5a2b2e988531\",\"/knowledge-medium/pr-preview/pr-1785/src/services/supabase.js\":\"5d88f895c0ece674\",\"/knowledge-medium/pr-preview/pr-1785/src/services/uploadErrorClassifier.js\":\"483c790ac1717eee\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/ActiveContexts.js\":\"a25c71f10e9fd2ea\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/HotkeyReconciler.js\":\"e7e8fe74860fac6a\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/WipeLocalDataDialog.js\":\"d9799a64cb2b2c59\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionDispatch.js\":\"6c39403726847b6e\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionRefItems.js\":\"c793338fa3b44d38\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/applyKeybindingOverrides.js\":\"3b1b5de1053a216f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/blockActions.js\":\"02f08c9247630076\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/canonicalizeChord.js\":\"ab5c5067ae81f258\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultContexts.js\":\"3f93b69e85cd6955\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultShortcuts.js\":\"8a1b748f2323fbf9\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/effectiveActions.js\":\"0287a9690e2f1a74\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureAction.js\":\"2e98ecd3d0610cbd\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureBinding.js\":\"cad2601fc33c8471\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/holdRegistry.js\":\"bf685968e53a4b2c\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingConflicts.js\":\"ee08ca97d8a7e642\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingOverrides.js\":\"e9d67730acf4610f\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/pointerAction.js\":\"5c4c35b394b78eb8\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/resolve.js\":\"b8e7b09f1043d8c4\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/runAction.js\":\"82dc6947bd255102\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/sequenceMatcher.js\":\"d9a062b6d544ac42\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/types.js\":\"25abbe4ba413e7bb\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionContext.js\":\"ef6ebe776e747340\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionDiscovery.js\":\"1bf3c018c76d47c3\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/utils.js\":\"b52e864a9fc5e817\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/bootStore.js\":\"921187e12b5f6fc2\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/previewDatabases.js\":\"cd13016f5bd5ba14\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/byteTransform.js\":\"b1615c2fbfe1bb2e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/attachmentCleaner.js\":\"f1d573b33338f6f0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/attachmentParts.js\":\"34d2cdb9dcc50823\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleParts.js\":\"046a59125ba6f03e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleRecord.js\":\"7a9fd0fcfd01a027\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/manifest.js\":\"b4d6e046de57a7a3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/takeBundle.js\":\"449a66c1dd6d5fa3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/verifyBundle.js\":\"20b89852d6c8854b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/cleaningStage.js\":\"29fd6e7ec938f75e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionKey.js\":\"c02a26929e0ccf50\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionServer.js\":\"3dd2cbf872012f0d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flip.js\":\"e97ec9b7a240e225\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flipAttempts.js\":\"d42fc30990be172e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/pages.js\":\"3c8b6be293df360e\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/preflight.js\":\"d9499efd5c4320bf\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/reseal.js\":\"0a61b2e4867a2fc8\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runConversion.js\":\"c94b74a064627302\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runLock.js\":\"d05da4102da77162\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealing.js\":\"d000602e7bf000a8\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealingStage.js\":\"6b7fba59822f23a1\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/stage.js\":\"0e351d08b59aca12\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/verifyReseal.js\":\"dd404a56401e4537\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aad.js\":\"44e0d49bf6aa1943\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aead.js\":\"a6707a6414a39647\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base32.js\":\"12af3db177452a58\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base64url.js\":\"bcf44001cdb56bb7\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/binaryEnvelope.js\":\"e65a3834b49f1521\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/byteAead.js\":\"6db9379374bb43d2\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/canary.js\":\"4310a9682b5b14c6\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentHash.js\":\"fa0aedf7ae084dc4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentKey.js\":\"1089a59a6e4ab08f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/derivedIdNamespace.js\":\"3a21566c47dd21c0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/envelope.js\":\"fe9f284a8b3fbd43\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/hex.js\":\"4180d01b33ed2355\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/sha256Hex.js\":\"d498d13e72dff9ba\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/workspaceKey.js\":\"105a2043992880ad\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/conversionState.js\":\"b886ddfd9463ce48\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/createEncryptedWorkspace.js\":\"df1293ecd00447fc\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/pastedKey.js\":\"e226eb7ce48630a8\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1de072edb2a16bc1\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2569c50c858f2d51\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/keyStore.js\":\"7e70db3aa78ba8f3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/mintWorkspaceKey.js\":\"f5e6e601466f8364\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/modePin.js\":\"bc83f6d1a0381270\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/openWorkspaceKeys.js\":\"d9b90c59159abbc4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolveWorkspaceEntry.js\":\"077776ea77614c08\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolver.js\":\"7fab94480824d81a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/workspaceAccess.js\":\"e3687ad0c832eff4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/transform.js\":\"5aeedf0d6d117fe5\",\"/knowledge-medium/pr-preview/pr-1785/src/themeBootDefaults.js\":\"d478a9519d73c8d8\",\"/knowledge-medium/pr-preview/pr-1785/src/types.js\":\"b973e2f98d1d972f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/ClientLocalSettings.js\":\"526ab5cc2389909d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/abortableSleep.js\":\"87affa85832bf11e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/array.js\":\"ab7f073d2b6eac98\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/backlinkAutocomplete.js\":\"20ce3d9d04ad99a1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockCrumbs.js\":\"d541bb541c08db4a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockrefAutocomplete.js\":\"c47bb6f171d8e989\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/cadencedIdleJob.js\":\"433b3b65361a540f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/callbackSet.js\":\"24ddddfb43d28420\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/clientId.js\":\"f7d3993313047aab\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirror.js\":\"cf3806a60b6cf689\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirrorCompletion.js\":\"ad7b056ca12f4833\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/copy.js\":\"8da7b73110b228d8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dailyPage.js\":\"321f1dfc2fc11f26\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensics.js\":\"e41c0807f20f40ba\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensicsHooks.js\":\"0ad482ae0a6cc878\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/deleteBlockThroughUi.js\":\"2335a42636e0de31\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dialogs.js\":\"16b2da4e984116f9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dom.js\":\"d27f1a22d8bfa679\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/downloadBlob.js\":\"2b56e2a50bf106c2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/exportSqliteDb.js\":\"5c9977f6a73eb0b3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fileSystemAccess.js\":\"d997a9ebcaebb30e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/flipSlide.js\":\"fca5be7d3036b02d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fnv1a.js\":\"0d8fdfdd777479f2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/formatBytes.js\":\"129a5c651ae9e035\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fuzzyRank.js\":\"303154b0ad2f663b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idbKeyedStore.js\":\"e9b7c20679795bc1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idleCallbackPolyfill.js\":\"ab66cd024b64c0c9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardAwareScroll.js\":\"074cde273e1e9ca2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardViewport.js\":\"3344356627ae7748\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/lastWorkspace.js\":\"bc913fdb8fe416ce\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutColumns.js\":\"631d02d0a875f0a1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionDom.js\":\"f0c2e0d2581514aa\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionId.js\":\"f9108510bf61c6ee\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkClickGestures.js\":\"2310381e5b912cfe\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkTargetAutocomplete.js\":\"951d7336b494d7be\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbCorruption.js\":\"72561f0c024f88cc\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbRecovery.js\":\"26d83d5d11d2bae3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/markdownParser.js\":\"9fa173a0d5dbe012\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/memoize.js\":\"4c50c6dfcdb8e81a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameFieldCommit.js\":\"65913e51f63f270a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameList.js\":\"86fd244f655aecbf\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/navigation.js\":\"e99c22465df3badd\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/omnilinerNamespace.js\":\"9c8340850de3c36f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/opfsPageScan.js\":\"7176051589acaa5a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelClearance.js\":\"facae8f7ee2f2482\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelHistory.js\":\"7b7520af230fea3c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLanes.js\":\"5fc0228f05cb4e32\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLayoutProjection.js\":\"708887f876bc428d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelScrollAnchor.js\":\"00ef178c9355ede6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelUrlFlags.js\":\"399dee2f1c8e969e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/platform.js\":\"e43b0a601772c1c6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/pluralize.js\":\"887bf2a3473a435b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyCreation.js\":\"d503f5a0b79b6d2a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyNavigation.js\":\"427d2153fc676c62\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyValueContext.js\":\"1d56f61888112d2e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/react.js\":\"cee3c4ee4f519f49\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeDate.js\":\"e780affeec41ad43\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeTime.js\":\"1807a88fec0066f2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/renderScope.js\":\"2178dda86837252b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/resolvedThenable.js\":\"c0fbb652a106194a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/routing.js\":\"77ea2933a91f119b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/safeMode.js\":\"940390253bc15baa\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/scheduleIdle.js\":\"8c6b7dc46f9b687d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/screenWakeLock.js\":\"ff589d557d1915d0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/selection.js\":\"44e3a5955226f111\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/softKeyboardGrab.js\":\"4467a305d2475734\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/startupTimeline.js\":\"72544178b4e1ac06\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/state.js\":\"0e9bc9e2295491b9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/string.js\":\"451b6b9883e05707\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/surfaceZoom.js\":\"799cc2300f3332b6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/time.js\":\"c7c1ef5ac1b11568\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toast.js\":\"8c051acba1885a07\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toggleStore.js\":\"90fee625388c3789\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/untilStopped.js\":\"4a9a368427d9b679\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/userActivity.js\":\"ac9c9ce77c129690\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewTransition.js\":\"db0ca4aa382694ae\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewport.js\":\"00dc8e25ddc0541c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/webLock.js\":\"d32ec5b55c8cc9a2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceRecovery.js\":\"4782cbf2e16bea61\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceSnapshotStore.js\":\"9370ab9bdc202762\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-compiler-runtime.js\":\"4c84f27662d870f7\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-client.js\":\"011181bb3cb29ae1\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server-edge.js\":\"ae70c03842a2f179\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server.js\":\"96ba73683a4eea31\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static-edge.js\":\"d4b7a1ef73796705\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static.js\":\"ecd8c6b716ce9a37\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-test-utils.js\":\"d79658ba7351e604\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom.js\":\"e162f460876dbca3\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-runtime.js\":\"b0a021778b58222b\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react.js\":\"71ccdd7017050729\",\"/knowledge-medium/pr-preview/pr-1785/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
