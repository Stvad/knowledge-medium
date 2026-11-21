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
		buildId: "a6dd37effb74-d1299657",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/\":\"e12429969554aa31\",\"/knowledge-medium/pr-preview/pr-1785/index.html\":\"e12429969554aa31\",\"/knowledge-medium/pr-preview/pr-1785/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1785/assets/FacadeVFS-CVO9VvLh.js\":\"a72dd069a3dcd297\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSCoopSyncVFS-QEXZOHY6.js\":\"267100346ab65de7\",\"/knowledge-medium/pr-preview/pr-1785/assets/OPFSWriteAheadVFS-DyHWk-A9.js\":\"5e3b88b0d981d8e5\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-BCoQ-Mk_.js\":\"b7f21f9931401380\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/assets/wa-sqlite-async-bt34Lkd4.js\":\"3a403ed695c38ed2\",\"/knowledge-medium/pr-preview/pr-1785/assets/worker-Btkd33Go.js\":\"8c8d80e5d4571ca3\",\"/knowledge-medium/pr-preview/pr-1785/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1785/chunks/app-DKPcdE6N.js\":\"a32fc6be8e3f6666\",\"/knowledge-medium/pr-preview/pr-1785/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1785/index.js\":\"7fab2383760333f1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1785/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1785/assets/AccessHandlePoolVFS-D7noHMPx.js\":\"299fe5ae169288ea\",\"/knowledge-medium/pr-preview/pr-1785/assets/IDBBatchAtomicVFS-C6fbvlTa.js\":\"6162a432740d4178\",\"/knowledge-medium/pr-preview/pr-1785/assets/MemoryVFS-CW6xh3Gs.js\":\"9b290ce7d1e4b74a\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-DL3tp13A.js\":\"f4971c06c5acaf4f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-CLmbv2JP.js\":\"f9ecf3376b19ee8f\",\"/knowledge-medium/pr-preview/pr-1785/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1785/chunks/AccessHandlePoolVFS-B9eim_Rk.js\":\"ccc130931f918351\",\"/knowledge-medium/pr-preview/pr-1785/chunks/FacadeVFS-DluT2iGt.js\":\"311ccb85b8f3b994\",\"/knowledge-medium/pr-preview/pr-1785/chunks/IDBBatchAtomicVFS-DZvczLUN.js\":\"a7ce63930e68c7f9\",\"/knowledge-medium/pr-preview/pr-1785/chunks/MemoryVFS-XWpl0JZd.js\":\"db7edf05719964be\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSCoopSyncVFS-D4mhZGsx.js\":\"4664c6a4251af951\",\"/knowledge-medium/pr-preview/pr-1785/chunks/OPFSWriteAheadVFS-B2KhiD3S.js\":\"ebab5af2377c64ec\",\"/knowledge-medium/pr-preview/pr-1785/chunks/Preview-DrT9SQXt.js\":\"a38a8158d322b90e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1785/chunks/card-C2a6PfBh.js\":\"14c29a85b628e312\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/dist-CUtVqetw.js\":\"9164666b9ad7d23d\",\"/knowledge-medium/pr-preview/pr-1785/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-Dj7L1Lp9.js\":\"e75a8a898fa140b2\",\"/knowledge-medium/pr-preview/pr-1785/chunks/mc-wa-sqlite-async-Cg3xpB9Z.js\":\"b9df5e1c5fc8388e\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react--nSzcNNh.js\":\"8da7622704fc5b22\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-6SuHYqsX.js\":\"a64a52d5046af964\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-9glGF0Lp.js\":\"f8e97daf9d6305f4\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-C9V97ucO.js\":\"040ceb41d62752c7\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-DEnZVXyp.js\":\"741b848cfd004a25\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-cWmLa3kq.js\":\"cd45e4bf3be1c365\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server-legacy.browser.production-D0L4bGMd.js\":\"3025b8e4891d6fde\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.browser.production-BDrO-4KF.js\":\"73512276030a424b\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-dom-server.edge.production-CqeHYl_Y.js\":\"6c9596ad8690b114\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-m8BXHluO.js\":\"fe0d00f221120028\",\"/knowledge-medium/pr-preview/pr-1785/chunks/react-qA0yuN4p.js\":\"a1699dfb36eefacc\",\"/knowledge-medium/pr-preview/pr-1785/chunks/server.browser-ChHJx1ES.js\":\"daff17b9edf15274\",\"/knowledge-medium/pr-preview/pr-1785/chunks/textarea-Czh4Kx3n.js\":\"f20d098b12fdafc1\",\"/knowledge-medium/pr-preview/pr-1785/chunks/ui-CcZ3fXTT.js\":\"aa5b9cfeb91ccdc4\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-async-QL25ThzH.js\":\"32841ee9e9a4e632\",\"/knowledge-medium/pr-preview/pr-1785/chunks/wa-sqlite-fcvHB7So.js\":\"f2776e1b3c1db722\",\"/knowledge-medium/pr-preview/pr-1785/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1785/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1785/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1785/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1785/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1785/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1785/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1785/src/App.js\":\"30df353248d2b9ac\",\"/knowledge-medium/pr-preview/pr-1785/src/appUpdate.js\":\"2a349fb6c35b9c72\",\"/knowledge-medium/pr-preview/pr-1785/src/appVersion.js\":\"6f0e7d7763333cc4\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/initialLayout.js\":\"2adb80558a99fefd\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/resolveWorkspace.js\":\"24873d27d5bfda48\",\"/knowledge-medium/pr-preview/pr-1785/src/bootstrap/workspaceBootstrap.js\":\"7230e50235428db1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockComponent.js\":\"7f60fcd9119741f5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockCrumbs.js\":\"dc4538398b1bee04\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockEditor.js\":\"067219b98a9227c3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockLoadingPlaceholder.js\":\"2a5271a54a02eb68\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockProperties.js\":\"565b1ad376b8584a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/BlockSearchPicker.js\":\"5029b9e7333e585d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ConfirmBulkDeleteDialog.js\":\"9067cf17e152ec39\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DividerHandle.js\":\"a5176e5014740e3a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/DraftEditor.js\":\"6fd632d36c0ca25f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/GutterPill.js\":\"d1adc212ee2a69f8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Header.js\":\"04d878400389c96f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/LazyBlockComponent.js\":\"d326c1d65b5bb6aa\",\"/knowledge-medium/pr-preview/pr-1785/src/components/Login.js\":\"76898e488ef954db\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ZoomableSurface.js\":\"baa811814443fa62\",\"/knowledge-medium/pr-preview/pr-1785/src/components/editModeKeepalive.js\":\"65acd573ab147a94\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c97a9a9a3e0e7270\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"27626fce24226579\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefPropertyEditor.js\":\"537df8ccf4da3752\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/RefTargetTypePicker.js\":\"957f231413a190c5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/SelectPropertyEditor.js\":\"a195e2943344e4a1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/TypesPropertyEditor.js\":\"16fe24d2a602cb35\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/defaults.js\":\"362d472a243bb1e8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/kernelValuePresets.js\":\"5b21c5bf82fc4f50\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/selectablePresets.js\":\"91df80cd5fd5586e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyEditors/typesPropertyUi.js\":\"331300df3d5fda36\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/AddPropertyForm.js\":\"831b380c84b91c16\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyPicker.js\":\"f5fefc57b99f0226\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/PropertyRow.js\":\"fa48daf58ee01cbe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/Rows.js\":\"7a9d8bcddfcc2b0f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/actions.js\":\"cbd5dd792a6356a0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/declarationOnly.js\":\"975269c05bcd73a6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/layout.js\":\"1100b12a649b75ad\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/model.js\":\"320d79b7fa8c3ff7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapeUi.js\":\"720d68e089074f08\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/shapes.js\":\"f2639d109bdff708\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/usePropertyEditingActivation.js\":\"10c1485cf66f6be6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanel/visibility.js\":\"5e504c093b434a3d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/propertyPanelSections.js\":\"96c8d7dc80c824aa\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockEmbed.js\":\"efdf89e250643af8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockLink.js\":\"8bb2695019440950\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/BlockRef.js\":\"25ceb132b305fca0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/ReferenceLink.js\":\"13101f0b1f8a666d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuard.js\":\"7a08bfd16391b174\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/cycleGuardContext.js\":\"06a730cf07725aa0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/linkInteraction.js\":\"1ac8512a12f5a2f7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/referenceLayout.js\":\"2192302661560de4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/references/useBlockRefAncestors.js\":\"0b169509d6cdeba1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockGutter.js\":\"c6098779380f3c4d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockInfoDialog.js\":\"cbb92cbd76e557c1\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BlockTypeBlockRenderer.js\":\"995b584e6418b037\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/BulletHoverCard.js\":\"6374ec36e464c984\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorContentRenderer.js\":\"4eb69a84859ec059\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"45264c6130447a25\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ColumnResizeHandles.js\":\"8542ac3f6fbd9227\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a327ccb2689f4a11\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/DefaultBlockRenderer.js\":\"02b9dba6587e0bb6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/LayoutRenderer.js\":\"d60dad4aa762e572\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MarkdownContentRenderer.js\":\"93a38108afba45fe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/MissingDataRenderer.js\":\"a83c05f207bcf7d4\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PanelRenderer.js\":\"27a6879ef0a6c5fa\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/PropertySchemaBlockRenderer.js\":\"58719ecd0f58225f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/TopLevelRenderer.js\":\"bc2b355126dd55bf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockGutterMode.js\":\"d9697c27fdc907bc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/blockTitleText.js\":\"7d79415d30b50969\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/fieldCreationKeydown.js\":\"56e2ca91f01c0e2d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/renderer/layoutRootContext.js\":\"80d7a1e5bc96713d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/TypeChip.js\":\"012111600dea088f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/typeChip/chipStyle.js\":\"bc5190ddc8ab1e39\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/anchored-floating.js\":\"b889ab02140f7d74\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/button.js\":\"400d974e8af542e8\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/card.js\":\"d43fe1b6f744a410\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/checkbox.js\":\"aa1cc6ba92a4b7c0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/collapsible.js\":\"880a63a378bfedc9\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/command.js\":\"fda48d3c56ec754d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/context-menu.js\":\"821f9aec859676ca\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dialog.js\":\"2c5ab72a2502bba3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/dropdown-menu.js\":\"c62738e75ff03f03\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/floating-listbox.js\":\"c448c091a2d4aa52\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/index.js\":\"8bcfa0a4c791febe\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/input.js\":\"a4ef8f12f7ec528f\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/kbd.js\":\"b39e1947f22c85e5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/label.js\":\"f29216b35af57e3c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/ui/textarea.js\":\"434cbaa1d068abb3\",\"/knowledge-medium/pr-preview/pr-1785/src/components/useEditModeYieldKeepalive.js\":\"b5ddd5e17578cdf7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/BootFallback.js\":\"8efbc68456f2a21e\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/FocusedRowLazyMount.js\":\"46003510e3ef392a\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LazyViewportMount.js\":\"60d33e55ff666b26\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/LocalDbCorruptionFallback.js\":\"3b34c44156e6a0b2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/error.js\":\"bf2cdb712533bba6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/lazyMountRegistry.js\":\"0f366156fbe3dc67\",\"/knowledge-medium/pr-preview/pr-1785/src/components/util/suspense.js\":\"c3b7da7b036c6195\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/CreateWorkspaceDialog.js\":\"ac472246d1558981\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/PendingInvitations.js\":\"db892f8c4276f6c5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/SyncProgress.js\":\"1ca8be1efaf56d08\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/UnlockProgress.js\":\"1ec52f86e65aaea6\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceKeyGate.js\":\"aa2a4257b441716c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSettingsDialog.js\":\"3a9c403a21a772dc\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSwitcher.js\":\"7d8f80c87297dd60\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/WorkspaceSyncGate.js\":\"4432022ca64332bf\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlow.js\":\"51e7f9919a7afc76\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/ConversionFlowHost.js\":\"c8c645cfe6685676\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/EncryptionSection.js\":\"9605ecb4bd7f2ed0\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/attachmentPrompts.js\":\"ecf8ebf9641b5069\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/bundleFolderPrompts.js\":\"01e39dc9176a5bb7\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowDeps.js\":\"4201e39ca0b4f8ab\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/conversionFlowStore.js\":\"b9cd484bbdb51e7c\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/flowUi.js\":\"100a5f42ea6947f5\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/conversion/useConversionRun.js\":\"2d9c7729ef33b0a2\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/keyUi.js\":\"6a2e893b8ad89f6d\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnKeyLoss.js\":\"5a93ad73d419b470\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/useCloseOnServerE2ee.js\":\"bb7adc408f073c90\",\"/knowledge-medium/pr-preview/pr-1785/src/components/workspace/workspaceUnlocked.js\":\"15c3ed54870327d8\",\"/knowledge-medium/pr-preview/pr-1785/src/context/backgroundSubtree.js\":\"d98275493b0aec10\",\"/knowledge-medium/pr-preview/pr-1785/src/context/block.js\":\"e92f7f83c435913c\",\"/knowledge-medium/pr-preview/pr-1785/src/context/layoutWsContext.js\":\"4c61b66600937de4\",\"/knowledge-medium/pr-preview/pr-1785/src/context/propertyDisplay.js\":\"7210bf5172c09032\",\"/knowledge-medium/pr-preview/pr-1785/src/context/repo.js\":\"fcd2629264ad2f6b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasClaim.js\":\"c0c406d9c9d4fd1b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/aliasSeatNamespace.js\":\"a5fde8fb2791e24e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockData.js\":\"3c0cc38c45d5b64b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/blockType.js\":\"8ad9e58693840ade\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/changeScope.js\":\"36cbfeddb7bc7efa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/codecs.js\":\"f3523dec9eb8aa37\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/derivedData.js\":\"4be61da8d5c25a55\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/errors.js\":\"746003d74c99824b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/events.js\":\"b1a588dfd910c1a5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/handle.js\":\"7a51f43a41da4dd6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/index.js\":\"b9aceab2b960d13b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/mutator.js\":\"88f0a6de0427d331\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/processor.js\":\"8af24a4a7dfc8691\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/propertySchema.js\":\"1295936d5b3e5a72\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/query.js\":\"b7d06763c37e1bc7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/sameTxProcessor.js\":\"5a3779c5c9c17c9d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/schema.js\":\"7a51f43a41da4dd6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/tx.js\":\"7a51f43a41da4dd6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/typedBlockQuery.js\":\"a70894d7e7dbab0c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/user.js\":\"4bff015023df2db5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresetCore.js\":\"8610e8651bb2956a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/api/valuePresets.js\":\"4b1c99dc1465bdd4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/attachmentCleanerIOVerb.js\":\"f4f54b5780a271fe\",\"/knowledge-medium/pr-preview/pr-1785/src/data/block.js\":\"6580a9b510083c9c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockCache.js\":\"6c4babd4cab474aa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockId.js\":\"f0d8fe936e3b7ba7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockLiveness.js\":\"ccb3d0e263e14563\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockMerge.js\":\"9e3c57b97972fe57\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockSchema.js\":\"acf3293e18f294fd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/blockTypes.js\":\"cd6e6e527e70cae5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/clientContext.js\":\"572a1eecb4046ef4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/dbFileSiblings.js\":\"67c707784bb9a4f2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/definitionSeeds.js\":\"6c904ccdf7cc16dd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/derivedIds.js\":\"7525e3bd0bc93a73\",\"/knowledge-medium/pr-preview/pr-1785/src/data/drawnSubtree.js\":\"34c940bc2ee62f1d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facetBridge.js\":\"ae37048469410ba4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/facets.js\":\"1abd4cfaf6e950aa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/globalState.js\":\"5abca24b5b776dcb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/aliasClaimRederiveProcessor.js\":\"fe643748a908100e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/ancestorBatch.js\":\"3be919c7e63aad8f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/blockTypeTypeifyProcessor.js\":\"f80f2428c1e43e14\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/clientSchema.js\":\"205cd76e9e16fa91\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/commitPipeline.js\":\"c3a013658bbd7b41\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/devAssertions.js\":\"55f802f089c09863\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/firstSync.js\":\"b62d4961838056ce\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/freshInitialLoad.js\":\"ead410fcbf2f5db9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/graphBackfillClaim.js\":\"fc939d71afcb0861\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/handleStore.js\":\"f4af9f8e8bec3fbb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/idleMarkerJobs.js\":\"7822c5b0ee754a3d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/initialDownload.js\":\"1a772935ed4bd22e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/jsonCanonical.js\":\"c6a004eb3334cd6d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelInvalidation.js\":\"262eb138065c935b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelProcessors.js\":\"de40a6e44fd21096\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/kernelQueries.js\":\"439bb692d73527e2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/mergeTypeMembershipProcessor.js\":\"8bf5f66a9e899b2a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/normalizeReferencesProcessor.js\":\"0abd6f68cbbb5cc6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/poolInstrumentation.js\":\"7cbe61f34062062f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/processorRunner.js\":\"cacc16c26bcf31cf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyCellBackfill.js\":\"da7f7b50e1fe4cdb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildMint.js\":\"52fa6581fe5ce77f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyChildrenProcessor.js\":\"5b85f98e3fb94933\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionChangeProcessor.js\":\"189518dc0a5d64a7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyDefinitionSynthesis.js\":\"54997ff02b9f53b5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertyKeyScan.js\":\"27743446051b1dd1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/propertySchemaResolution.js\":\"4a5c71ab11cb6d85\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/raiseProtocol.js\":\"e0efe0efb913699b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/readBatch.js\":\"fbb0294cea45a425\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/refProjection.js\":\"b0d142b8725b5eb1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetLookups.js\":\"cf0d5bf90fcd4eac\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/referenceTargetProcessor.js\":\"34756bda898253ba\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/replayMerge.js\":\"de1b9d4ce04432ca\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/sqlBinds.js\":\"b5c96260d5e29e58\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"79c44c86375925b5\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/arrivalProcessors.js\":\"7d97bda83e9a7cd1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/invalidate.js\":\"5ff335e1e389e831\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/materialize.js\":\"53f1218a5c80172a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/observer.js\":\"ab71417d0374fe3e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/syncObserver/reconcile.js\":\"28596b27075362d0\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/timingMetrics.js\":\"d8cb03348c39d100\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/treeQueries.js\":\"c9386a97801399fd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txEngine.js\":\"f977b16e04ff7751\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/txSnapshots.js\":\"54a07b4f51d6d3a4\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/typedBlockQuery.js\":\"48772f0908fd027f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/internals/undoManager.js\":\"cae2f3dca7f76326\",\"/knowledge-medium/pr-preview/pr-1785/src/data/invalidation.js\":\"076bbe32ec7f9826\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelDataExtension.js\":\"a5bde017b555c23b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelPage.js\":\"031baa1ecc7bba3d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/kernelValuePresetCores.js\":\"989a4740a18ecf06\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbCorruptionSignal.js\":\"9ce9d912354ed09e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbStorage.js\":\"85fbc457b8671815\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localDbVfs.js\":\"08e28f69abc4163c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/localSchema.js\":\"2c66e099cfd07f43\",\"/knowledge-medium/pr-preview/pr-1785/src/data/maintenance.js\":\"6194d9edde639c07\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mergeProperties.js\":\"bf41491e452e9163\",\"/knowledge-medium/pr-preview/pr-1785/src/data/metricsConsoleHook.js\":\"51b9faf43894852c\",\"/knowledge-medium/pr-preview/pr-1785/src/data/migrationsPage.js\":\"86025545c21eb7b7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/mutators.js\":\"07868f6be7c0f24b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKey.js\":\"5067af1b0039cb80\",\"/knowledge-medium/pr-preview/pr-1785/src/data/orderKeyPlacement.js\":\"e373adbb0a3ecf02\",\"/knowledge-medium/pr-preview/pr-1785/src/data/outlineSurface.js\":\"27d647d9ccf3c234\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingEditorContent.js\":\"13821aac0905a526\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pendingUploadsSql.js\":\"9ad9784ece9f7153\",\"/knowledge-medium/pr-preview/pr-1785/src/data/pluginStateExtensions.js\":\"238b270b80f53e9a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/powerSyncLogger.js\":\"208bf506e2b04b3b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/projectorRuntime.js\":\"6d41fa28317d0884\",\"/knowledge-medium/pr-preview/pr-1785/src/data/properties.js\":\"88a39c1dfd5c66bb\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertiesPage.js\":\"651ad15107117087\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyChildren.js\":\"150c886c8e1249aa\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionFanout.js\":\"d7af48a76ed1867d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionMetadata.js\":\"a46185a92430c503\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDefinitionRegistry.js\":\"5c36a55a2f83a41a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyDisplayMode.js\":\"c36e43f143038175\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertyRowCreation.js\":\"48a12fb3f9a50f66\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySchemaCreation.js\":\"029cd04d75cd2fb6\",\"/knowledge-medium/pr-preview/pr-1785/src/data/propertySeeds.js\":\"0483b5f223b76301\",\"/knowledge-medium/pr-preview/pr-1785/src/data/recentsPage.js\":\"143789c84b0a9e21\",\"/knowledge-medium/pr-preview/pr-1785/src/data/referenceBlock.js\":\"9e1e78b599e3a0a9\",\"/knowledge-medium/pr-preview/pr-1785/src/data/releasePowerSyncConnection.js\":\"779ff92d6b9ad799\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repo.js\":\"a63d3c9928f98e41\",\"/knowledge-medium/pr-preview/pr-1785/src/data/repoProvider.js\":\"539d1ae036132eff\",\"/knowledge-medium/pr-preview/pr-1785/src/data/rowProperty.js\":\"5a86aa5bfd15f991\",\"/knowledge-medium/pr-preview/pr-1785/src/data/searchFilter.js\":\"85e4bb40ede3da35\",\"/knowledge-medium/pr-preview/pr-1785/src/data/seedIdentityLedger.js\":\"3b21eb2b7d372eda\",\"/knowledge-medium/pr-preview/pr-1785/src/data/stateBlocks.js\":\"9408787f459b1547\",\"/knowledge-medium/pr-preview/pr-1785/src/data/structuralEditPolicy.js\":\"48ddf1a6f07ba1dc\",\"/knowledge-medium/pr-preview/pr-1785/src/data/subtreeDelete.js\":\"8d53e0fcea41f38f\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncStreamLock.js\":\"3cc96033ed6f3b66\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableSqlRecognizer.js\":\"49738213f112da41\",\"/knowledge-medium/pr-preview/pr-1785/src/data/syncedTableWriteGuard.js\":\"cb05e06034711e69\",\"/knowledge-medium/pr-preview/pr-1785/src/data/targets.js\":\"1fa7be0aae484fbf\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeColors.js\":\"f64bec5ca2f61319\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionMetadata.js\":\"5472b166b347e697\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeDefinitionRegistry.js\":\"7d6747c976e744e7\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeExtraction.js\":\"e444144901f43729\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeInitialValues.js\":\"d0628f1d5a35bcf1\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typePropertyGroups.js\":\"eaf41c08f74b09ee\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeSeeds.js\":\"d24c0db69f96c861\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typeTagger.js\":\"29b2e83f2df4c63b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typedRecords.js\":\"44fd688c3ef00a8b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/typesPage.js\":\"4f3920e168d445fe\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userPrefs.js\":\"876f728532142390\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userSchemasService.js\":\"4b712fcc2c12180e\",\"/knowledge-medium/pr-preview/pr-1785/src/data/userTypesService.js\":\"2199f7f12f63d833\",\"/knowledge-medium/pr-preview/pr-1785/src/data/valuePresetRegistry.js\":\"61a8591b4a6beafd\",\"/knowledge-medium/pr-preview/pr-1785/src/data/visibleChildren.js\":\"4a38174ac45e3c7a\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceConversion.js\":\"ffdf43290c67c60b\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceFirstSync.js\":\"a4643711f49ad0ae\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceIdNamespace.js\":\"bcb99c8187b79291\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaceSchema.js\":\"4bc6b07754c58481\",\"/knowledge-medium/pr-preview/pr-1785/src/data/workspaces.js\":\"b1a42067dbb5fae2\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadLog.js\":\"684605093b51eb6d\",\"/knowledge-medium/pr-preview/pr-1785/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/BlockPasteShellDecorator.js\":\"2adb4aa79ad8cc4c\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/atTrigger.js\":\"3fe10fbb701393d1\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/autocomplete.js\":\"45f84218b1fbf5f2\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/codeMirrorExtensions.js\":\"8b987190cb165f96\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/contentFlush.js\":\"2d1f240955749034\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/defaultInteractions.js\":\"454a370fbe80b693\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/editSettleSignal.js\":\"202c3a49e521677b\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/insertImage.js\":\"bab55cabe3df32c1\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceCompletionRange.js\":\"e6c4dbe743811dcb\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/referenceTargetTypes.js\":\"663d480b5bb8f50a\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/syntaxContext.js\":\"d1563fe4e15e9f09\",\"/knowledge-medium/pr-preview/pr-1785/src/editor/triggerMatch.js\":\"2f99507ea38989da\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/AppRuntimeProvider.js\":\"2a9250262874bfaa\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/BlockFocusShellDecorator.js\":\"10a946871fb43e29\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/ExtensionRenderBoundary.js\":\"83ce4ef596e491f3\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/PanelContentRecovery.js\":\"67efd5da7be14f67\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/apiCatalog.js\":\"89e8c4b132219add\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/approveExtensionHere.js\":\"1eee160e1f3c0755\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/armedCutAppMount.js\":\"d4e2e0d182e8d9ed\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/batchableKeyedStore.js\":\"7215a17a50ca00b9\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockInteraction.js\":\"db5ee2487eed24b2\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/blockSelectionAction.js\":\"c825cd66f1a39c65\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compileExtensionModule.js\":\"9447331700c6a5be\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/compiledModuleCache.js\":\"acf884b7d435c056\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/continuousGestures.js\":\"5c64cbb622a1dc9a\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/core.js\":\"9095558efdff9f6f\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/defaultRenderers.js\":\"a614c1c1778434f3\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/definitionFanoutAppMount.js\":\"47eb24f971a312b5\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dialogAppMount.js\":\"cd8e059ffd9885cb\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensionSeeds.js\":\"4cb5ecfc6edeb762\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/dynamicExtensions.js\":\"2e22dbd38f52e627\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/exampleExtensions.js\":\"bb6c0d7d9fc2d442\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionApprovalStatus.js\":\"ded045da8ecfd34a\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrorToast.js\":\"32f0e063c4d8a095\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLoadErrors.js\":\"b5810cd4c117c4d0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionLookup.js\":\"d7b55d627335e468\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionToggles.js\":\"23d435e1bc538995\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/extensionUtilitiesCss.js\":\"b511749f788923ee\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/kernelPageDeletionGuard.js\":\"76044e0bedd41f67\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/liveRuntime.js\":\"4f5d684712c3bf87\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/openExtensionsSettings.js\":\"9947874cf5b27eca\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/overridesCache.js\":\"3845010cd3b5633a\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/pluginIds.js\":\"66c644b89a942806\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/processorRejectionToast.js\":\"8f062519353be6e5\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeActions.js\":\"f4a323323b415dae\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/runtimeContext.js\":\"147ec1c9c124a617\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticAppExtensions.js\":\"932383f378920db7\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/staticDataExtensions.js\":\"2e21ca63e315ba8d\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/toastAppMount.js\":\"bf0536ce73e3ba84\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useOverrides.js\":\"b46ce147d5511ac0\",\"/knowledge-medium/pr-preview/pr-1785/src/extensions/useShortcutSurfaceActivations.js\":\"3666cfb5bcbe16d1\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/discoverToggleTree.js\":\"9cc69ac93d8e5083\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/facet.js\":\"6ad99833bd3fac99\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/resolveAppRuntime.js\":\"5de9f74c3db10851\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/runtimeEvents.js\":\"d037799429e8c728\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/togglable.js\":\"5ba05af5a3b0ef01\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/variantFacet.js\":\"6b0baec8e011fddf\",\"/knowledge-medium/pr-preview/pr-1785/src/facets/verbFacet.js\":\"ac957d0e103ca571\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/block.js\":\"686fe2785b42d041\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/focusedChild.js\":\"659399e8ed0008b1\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/propertySchemas.js\":\"c2cfe3eb9b82fa0b\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/typeRegistry.js\":\"e9aac298b9c21329\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAncestorCrumbs.js\":\"34875f8ed0d7f394\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useAutocompleteListbox.js\":\"263657bb699b41e9\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedSearch.js\":\"e068f00c8037ce83\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useDebouncedValue.js\":\"3d496e346361dd25\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsFocalRender.js\":\"39836ce5b6f088ee\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useIsReadOnly.js\":\"d9bb6c843d88fda6\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMaterializeBacklog.js\":\"89ecca8f2dcfa608\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useMinuteClock.js\":\"384a741cf9179ea1\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePanelLayoutProjection.js\":\"e587c5dd82e95723\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/usePendingInvitations.js\":\"390b38c2659cd37e\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRendererRegistry.js\":\"fa636a64d7cc5eca\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useRetainedFieldRows.js\":\"d1dda1e28c8ee8f7\",\"/knowledge-medium/pr-preview/pr-1785/src/hooks/useWorkspaces.js\":\"bf359b4abd57e90b\",\"/knowledge-medium/pr-preview/pr-1785/src/lib/utils.js\":\"d98627ef7f159157\",\"/knowledge-medium/pr-preview/pr-1785/src/main.js\":\"6c4c57427b97dacd\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/MarkdownImage.js\":\"c34f7e22509e80d6\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/blockSeparators.js\":\"cafa930527066bb5\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/context.js\":\"791299f60fd81aef\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/defaultMarkdownExtension.js\":\"119237684f7a0761\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/extensions.js\":\"86a27b4877ad2a5e\",\"/knowledge-medium/pr-preview/pr-1785/src/markdown/renderMarkdownHtml.js\":\"846b3f00eb7e0331\",\"/knowledge-medium/pr-preview/pr-1785/src/minimal-editor.js\":\"957df9e48bbc487c\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/armedCut.js\":\"6c4ae4137a9edd86\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/captureMediaVerb.js\":\"0f79c365de6b3740\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/clipboard.js\":\"92832ded2b7c22d6\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/decision.js\":\"688bd971809f213c\",\"/knowledge-medium/pr-preview/pr-1785/src/paste/operations.js\":\"4c10e71a94639ae2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/AccountHeaderItem.js\":\"f2f60b700f55cde2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/account-header/index.js\":\"796859ae353d7da7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8ff7a21682f16322\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askAgent.js\":\"d6595febfca0754e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/askedStore.js\":\"bebd055e66341217\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"04c28e33c3ffb2e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/chipState.js\":\"067109b113284202\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/dataExtension.js\":\"46c0117982af5ac5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/index.js\":\"cdebf5fd34ec1457\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a11e46400baa81ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-dispatch-companion/schema.js\":\"0dbc1a41d3cc5f69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/AgentTokensDialog.js\":\"801f19078a001642\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4330b0defb9b5f5f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/addMedia.js\":\"20fc012e56e3c115\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9fd96aa2604137ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/block.js\":\"648eeb77e2cf4b92\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/context.js\":\"2fbad5ba13dd8514\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/displayIds.js\":\"085d39e0dc4a2bae\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/index.js\":\"69c23c8f3f60352b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/outline.js\":\"8f6947f1dd46f789\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/properties.js\":\"6008eabe092182d6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/refs.js\":\"a17a61b5e4274b45\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0591e4b46f4fb734\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/search.js\":\"2b029fae8448fb21\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/shared.js\":\"13ce5c43578dc544\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"03279e39aa4c306a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentViews/text.js\":\"b1551e4afa95f005\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/agentWrites.js\":\"5a338699879f59de\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/authoringCatalog.js\":\"65597e943d7c83cf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/blockRefTargets.js\":\"427d067890fff2be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridge.js\":\"c9ea2013587e52cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/bridgeLoop.js\":\"928f551768b31272\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/changeHistory.js\":\"666e58c4b0388321\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commands.js\":\"85c91d34b6ab15a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/commentsCommands.js\":\"149a3d0ad8622b7e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataExtension.js\":\"fb4b6f70e1def58e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/dataModelGuide.js\":\"ec0dc45b76c852f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/describeRuntime.js\":\"99520796704719df\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/extensionLint.js\":\"0271a2e020a1b1ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/grainAudit.js\":\"3033b9a9c2c9968f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/healthCommand.js\":\"8a6197fa0f44c156\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/index.js\":\"6d8c4d01f3558e58\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/presetIdentity.js\":\"dcce8e0d16b89ffe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5f42e1f5228035fa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/readMedia.js\":\"a80016336441ad82\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/schema.js\":\"a9a52ab555957166\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/serialization.js\":\"fa074c299222ce7a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/targets.js\":\"3d1c9aeca04155fd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/tokens.js\":\"b2970091936572ac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/watchEvents.js\":\"f1f96abdbebb0e9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/workspaceGuard.js\":\"e9496e9099f3a64c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/agent-runtime/writeCommands.js\":\"77f042d3411ae84b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/AliasCollisionToast.js\":\"e04cd946074843e2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/DuplicateNameBanner.js\":\"d9c6940cf6944601\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/collisionMerge.js\":\"6674e2ac89ff7257\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/dataExtension.js\":\"5c2eec6c3110a3ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/index.js\":\"5c4ff2a3eff7cb46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/mergeCollisionAction.js\":\"6c57cb90ec76e678\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/pageStyling.js\":\"d0d64ddfeaf14f81\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/rejectionToast.js\":\"dd0822300f1f8fb5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/alias/syncProcessor.js\":\"9b96938ea8ce603b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/actions.js\":\"f5167fd67ae62b14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/addComment.js\":\"e4b617eb6a8e39a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchor.js\":\"badaafc351f95929\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/anchorState.js\":\"41550639d3088e7f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/commentLinks.js\":\"acf5e39e6c519582\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/confirmThreadDeletion.js\":\"6f33d65593f29ab6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/container.js\":\"ed188edfe82a2a1f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/dataExtension.js\":\"5f95db20df27eb2a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/deleteComment.js\":\"5b44574d072f7e9e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/highlights.js\":\"b9058f48dc03b07c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/index.js\":\"2109a739d9c73494\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/linkedCommentsPill.js\":\"6ca9479b9de9dbb0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/margin.js\":\"7875232ca010640c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/marginSchema.js\":\"aded4b280cd9a6d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/newComment.js\":\"75fcf95cd267e598\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ownThreadPicker.js\":\"322260afe6a3e98f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/placement.js\":\"6b33cb55d4e31429\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/queries.js\":\"a412e73a316b13a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotePosition.js\":\"665bd3fb63750a70\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedIn.js\":\"f3841385169cac15\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/quotedRange.js\":\"80cd3df01672d2a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/rangeRefs.js\":\"408db61b2d5c9767\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readHighlights.js\":\"c94516fd42a98ea6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelection.js\":\"631151ad26a8e8a1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/readSelectionUi.js\":\"32e0c58b341d94b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/reanchor.js\":\"3e08b2a2a50a90ce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/schema.js\":\"997c36a21109c665\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scope.js\":\"d21627be35907067\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/scopeThreads.js\":\"5819d12b55b3d28c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/splitRetarget.js\":\"f934a1b0c89e7d71\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestionCard.js\":\"279306baed51649a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/suggestions.js\":\"1bc84c115fff5a38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaries.js\":\"dde8161fbb743922\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/summaryBatch.js\":\"1672fc37193ad277\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/surface.js\":\"a31ee5e777d3874b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threadNavigation.js\":\"bb12f02177e0a611\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/threads.js\":\"dc1d73199b52ab63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/ui.js\":\"6e58e62e21f2b253\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/annotations/uiStore.js\":\"ab635b128504cc34\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/appIntents.js\":\"83be275743ff0757\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-intents/index.js\":\"90a409dfe19bedc7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/index.js\":\"4ab268e9e67c4c49\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/app-update-prompt/status.js\":\"ad29d06dc8395ade\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7b061456d5895981\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaBlockRenderer.js\":\"225f840a4a9b4dff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9e75265beb238a68\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/MediaUploadReconciler.js\":\"124969472e14a470\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetDownLane.js\":\"cf4383ba2f217ebc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetResolver.js\":\"ed671569c0ae4931\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/assetUpload.js\":\"704e92a3ce4ae65d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/attachmentCleanerIO.js\":\"a9786255d045ab24\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4e8c231e6db7602d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/blobStore.js\":\"847be9c8b753efce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/byteStore.js\":\"cbad9170bc2f25e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanerIO.js\":\"471593d2196323e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/cleanupAttachments.js\":\"1c7be8dd8909ed5d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/dataExtension.js\":\"56fbf36239f9a85a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/downLane.js\":\"ae9f6234878abaca\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/index.js\":\"ac47867f50944210\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/insertImageContribution.js\":\"2cd1b2698c8879ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneArming.js\":\"cf47dbe151a6b126\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/laneLock.js\":\"6fd245dc9dddda31\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaBlock.js\":\"6a072d64ba9ceb38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaCapture.js\":\"5621edc85c1e67d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewers.js\":\"a765b1842e28e836\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/mediaViewersFacet.js\":\"836a17ffe11bfb02\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/pasteCapture.js\":\"0f26100f1b915a21\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/resolver.js\":\"6002a1c8e967c58b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/retryUploadsAction.js\":\"af5a3c2e18167ed9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/storagePaths.js\":\"ea99a18fa0c96b0d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadDrain.js\":\"a19a9bcfb58e81b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadLaneStatus.js\":\"b685716dca7ac69a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadReconcile.js\":\"ed791ba7bcef3293\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadRecovery.js\":\"551caa6d068d86ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/uploadStore.js\":\"ce2bd5bd57f229c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/attachments/useAssetObjectUrl.js\":\"d3fa14fb5691f6a1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"307d07cc7fbe136d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d2162566efc1c9f1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/facet.js\":\"66052677b2c8e05a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/index.js\":\"6dabd2b9d1581139\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks-view/prop.js\":\"a4e849eddf9cad85\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinkFilters.js\":\"bb2421a11d49aec4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fbf1ec383775f715\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/BlockEntry.js\":\"91f7c43320672894\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/LinkedReferences.js\":\"858735d8a8386faa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"33ca3b7bc9b9174d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dailyNoteDefaults.js\":\"577efcd7e29f1512\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/dataExtension.js\":\"2e86160cc3612932\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/edgeExclusions.js\":\"68c4b57ef6317fdc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/filterProperty.js\":\"0636d9d5d38cd09f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/index.js\":\"a2aadb56c3ae3e93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a34a0ebea37407fb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/applies.js\":\"2ec941b0f52127ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/countQuery.js\":\"a0155e4d9834c3fa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f64689384ef48a3b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/index.js\":\"538cb164ba950f87\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e4d6cf307e427a37\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/presentationInvalidation.js\":\"aa88ec6d8ab1ef80\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyEditorOverride.js\":\"1fe28a5ba47c5914\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/propertyFilter.js\":\"9f402c36600761bb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/query.js\":\"f0a1f5f7c21b7384\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/resolveFilter.js\":\"06850e0ef6cafd41\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sourceBatch.js\":\"cec1e3ce3800205d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/sources.js\":\"e9e4755831846947\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useBacklinks.js\":\"38e4cbe6c20435d7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"20eb43d6c8ecedfd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayCelebration.js\":\"5f673e4200482c13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/BirthdayOverlay.js\":\"c0bc472d2482b93b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/gate.js\":\"ecc5eaac9f99f27b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/index.js\":\"f01219c7d035dce8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/birthday/wolfTheme.js\":\"9a42fab3ed81e8d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/BlockDragLayer.js\":\"1d8b2c18c780610f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dragController.js\":\"b9984a892524ee1a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/dropTarget.js\":\"572c021e9beb5b6e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/index.js\":\"26af65b6cea0bef4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-drag/projection.js\":\"73fec551b1cb38ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/BlockMetaCard.js\":\"ab12947f39b0fbd6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-info/index.js\":\"cc7815865d6e8f47\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/AddTagDialog.js\":\"3de0a2d6e4fa3daf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8ceb42e3f5bcff97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/TagNameIssueHint.js\":\"ed17fdaef2f90072\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/addTagAction.js\":\"e62b7672e54f1afa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/appendTag.js\":\"6245098b397036be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/config.js\":\"2c5c4016c0ca1c88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/dataExtension.js\":\"cf02997468890498\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/index.js\":\"85954335579555a0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/block-tagging/propertyEditorOverride.js\":\"ee1b19d65f6b9889\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbList.js\":\"50d8bce0f820971a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9c120035a6ee56e1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/Breadcrumbs.js\":\"87fdb0c2824dccc3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8859e5e89ea603c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"03adc30d6f64b721\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/index.js\":\"bd1e7289d8730de6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4d07bb06ff157162\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/CharacterCountItem.js\":\"753951fe499f2f10\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/ProfilePropertyEditor.js\":\"26c7a8629618abf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/actions.js\":\"f9dbdc6bb72512c3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/blockType.js\":\"532b77334d1ef09a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/charCount.js\":\"a975ee2843def17a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/dataExtension.js\":\"693df5c58c42cd59\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/index.js\":\"4363d8dbe3c9fe96\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/profiles.js\":\"72b7504fba4809b4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/properties.js\":\"292913838a3d9bd4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/character-counter/textCounts.js\":\"faf504224a7b2e0b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/colemak-keybindings/index.js\":\"06f3285e1b075a0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/CommandPalette.js\":\"dbae295f0c8dfbcb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/HeaderItem.js\":\"18d6876b1b26e02f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/context.js\":\"e591181c8ecdce15\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/index.js\":\"7c80c706970e44ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/selection.js\":\"2405cf90b215510d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/toggleStore.js\":\"53a3c371231ace50\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/command-palette/useCommandPaletteActions.js\":\"eab8cc0cad1f32f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/ContributorBadges.js\":\"c09ad9f2b891e3f4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/author.js\":\"df6925a46e58dc2d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/codeMirrorExtensions.js\":\"912d14d5708d4574\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/dataExtension.js\":\"faf5d4d0524c22ec\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/index.js\":\"11a12269c0728991\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/mentionAutocomplete.js\":\"beed7b304501558c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/processor.js\":\"7ece67f665afa340\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/profiles.js\":\"a8c82c929e25d53b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/queries.js\":\"c7686b131357c239\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/contributors/schema.js\":\"3da8c00ea1dbe925\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"327091b5fc82114f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ed62a07ae1b39338\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/index.js\":\"b957139da2db7c39\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7f059bcb4ef7f9d6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cd889eae51c2e116\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/CalendarGrid.js\":\"b50131f35fc3692f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DailyNotePicker.js\":\"774aa4e25c26fa15\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3acff92803b5c814\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateNavDecorator.js\":\"40a7215dd01fb942\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/DateScrubOverlay.js\":\"40b3bb9a612bb9e0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/HeaderItem.js\":\"8b4dd603d1e5cf9c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/ReschedulePicker.js\":\"dfd84f2a5f78da05\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/SpreadDatesDialog.js\":\"12c6a7512910caa4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/actions.js\":\"ad3deb0962a029a5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/blockDateAdapter.js\":\"71455523ff587da5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/calendar.js\":\"74fcade499a3dab6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dailyNotes.js\":\"9f29aa62a001f8d4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dataExtension.js\":\"7b7a7a513e742a9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubActions.js\":\"840ea7ba196ad51b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGesture.js\":\"cc2097ad5d7f8fac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubGestureActions.js\":\"664b1760bd80e06f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4ab50fe49a4cc08d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/deletionGuard.js\":\"6ac12dd94e58d3e8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/dueQuery.js\":\"bdeee13eea71a6d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/index.js\":\"93ed0c9f21ef250e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/landing.js\":\"3c0b4498ad224748\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/localSchema.js\":\"06da44dd4c1e8a62\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/referenceDateAdapter.js\":\"cc23e0b83a948e57\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/rescheduleAction.js\":\"17459fe4c816d6d7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/schema.js\":\"ed8f673a9e021351\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadBlockDates.js\":\"0cc9b004089e4ee1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/spreadDatesAction.js\":\"98ebcb01e0b27c13\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/today.js\":\"4d5389694fabb6f2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cfe70fc5c5182ea7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"647bec42614628a3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/audit.js\":\"019ac6f3addb6755\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditAction.js\":\"28caeeab388961b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/auditRanges.js\":\"73bedc9927cdd0b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/diagnosticsSource.js\":\"1b43dbdc4b4e8fd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/divergenceScan.js\":\"b7cdd6cc5dba16c9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/index.js\":\"c9575926e43ec293\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/propertyChildrenChecks.js\":\"08342c5c6122c9d5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/referencesMirror.js\":\"9dbe3614110a130e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/rowJson.js\":\"f47981c71298ae9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/schedule.js\":\"428e8b5506a5266a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/data-integrity/store.js\":\"30af36b7f2e7a707\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/action.js\":\"d00892b26f5e569e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/index.js\":\"9d6c7ba0c9b8aa55\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-maintenance/plugin.js\":\"3ec21d1f697a9edf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e7e5def61ec6aecc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/actions.js\":\"448c2ceea3af35ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/changeMarker.js\":\"779609ba2ad35611\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/diagnostics.js\":\"ca96361ce19417c1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/fileSystemAccess.js\":\"1915659add4f99cc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/filenames.js\":\"94bd8375324df524\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/index.js\":\"cbc06168ad77c67d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/mirror.js\":\"96b5ff2f8211fd2f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runLock.js\":\"3ff263196f7ad4a8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/runtimeHealth.js\":\"e21b1c1ea812f5c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/schedule.js\":\"1109e78606ab7aff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/db-mirror/store.js\":\"d1c93d14f03af4d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/index.js\":\"b9d6c248e1729046\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/default-themes/themes.js\":\"e4cd9a53a7bf3618\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/facet.js\":\"e6689da0eb554d6e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/diagnostics/useDiagnostics.js\":\"e9d9b9f85907fb88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/dismissals.js\":\"108b1ce1575d8228\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/index.js\":\"ebeb7a36a15317cc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/status.js\":\"6090ce3dedd569ba\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extension-prompts/store.js\":\"9367b0d7fe40e203\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0e212f90bc77a103\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4fba1358883951f5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/actions.js\":\"861c4833f7bdc853\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/config.js\":\"850d3481c917615c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/dataExtension.js\":\"a7f10cca6bbee7d8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/effect.js\":\"6d0b929fa110d3c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/index.js\":\"dc6ba1af99c29bbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9310c86e4aa47a88\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extensions-settings/useToggleTree.js\":\"718f3dffda772a05\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/ExtractTypeDialog.js\":\"2975ad989911b6de\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f55806eb6e26893d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/PropertyShapePicker.js\":\"eff9ad43f6fd8415\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/action.js\":\"84072f2e66cdb569\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/extract-type/index.js\":\"7521f3bb6f63c6e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/FindReplaceDialog.js\":\"4b34ab01e99fd55f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/HeaderItem.js\":\"1a88ebf9dd4acd3b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/dataExtension.js\":\"f6fe46f8c77d31fc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/index.js\":\"04c02c51b6e5dc07\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/search.js\":\"d295664d6ad35956\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/toggleStore.js\":\"540ea15054fdccac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/LocationPropertyEditor.js\":\"4510830506c484c8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/MapView.js\":\"3f2db243c9e5fc76\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/blockTypes.js\":\"78e79928c1c03cf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/codeMirrorExtensions.js\":\"6f071b666c5287ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/createOrFindPlace.js\":\"093e4116dd079999\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/currentLocation.js\":\"f0e0d78e897aa97d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/dataExtension.js\":\"fc7043f91791110d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/geoContentDecorator.js\":\"391ba7946cc2910b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/googlePlacesClient.js\":\"e84d7f157d27e9d2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/index.js\":\"477399d99659870a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/locationsPage.js\":\"5fe23cd483e05468\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/mapViewport.js\":\"6d924456f85dc199\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/pickCurrentLocation.js\":\"ddd3cf03749a3cd2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeAutocomplete.js\":\"8f3d31a6566d3b5d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/placeNameCollision.js\":\"3e5fce8d2d70b9a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/properties.js\":\"7c859f1c630f6c97\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/propertyEditorOverrides.js\":\"5a02f3d1da248c63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/query.js\":\"2c8e7d2a0c416e93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/geo/usePlaceSearch.js\":\"01dceb6d2fed0c33\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1af1e0f4bac67154\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"6ce3bbfd6ccd176c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0b5bf7581318ec1d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/config.js\":\"fba97bdfd9b95f1c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/dataExtension.js\":\"b16bd6551aba0e80\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/facet.js\":\"241539eed472fd84\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/grouping.js\":\"21f204e736b5280e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/index.js\":\"ea602b43299532c5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"46e69bd4021f0d6f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/query.js\":\"426773be372b6019\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/resolveConfig.js\":\"be6f2c94ee1512aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3b264ba0439c9eff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"fb4b52850638ef0a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlDocumentContent.js\":\"1052e47d051ee0e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/HtmlFrame.js\":\"6c4527b1c201afe0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/actions.js\":\"60a0b7ce93888ddf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/blockType.js\":\"a471bfe711b306aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/confirmRunScripts.js\":\"fb47ba86ab7c3b85\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/dataExtension.js\":\"fba3195b3de043d3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameAnnotations.js\":\"fa522679544c0643\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameDocument.js\":\"2213a702434dffad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/frameTheme.js\":\"f6591835337aeecd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/index.js\":\"4e865694b8bf36da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/scriptConsent.js\":\"f4476a51c723125d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/sourceMap.js\":\"0a3421f0b7f4a72a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/html-document/useDocumentScripts.js\":\"bffc7220d53d0f8d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/index.js\":\"be6fb278d6ac5cc8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/record.js\":\"9a45b72b699fcaf3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/recordStore.js\":\"829c9ab24dc7fc70\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/responsiveness.js\":\"6b35f53f4ee557fb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/schedule.js\":\"d38eca7c857576a5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/interaction-metrics/sessionContext.js\":\"84dbd63cb3cb09f9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0078a7ce5c8a8a83\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"18a3f22fcd24c128\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/actions.js\":\"c9bcf78cf287ed56\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/config.js\":\"55ad5c22a77b1d0a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/dataExtension.js\":\"ae125aae1c44a31d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/effect.js\":\"6ae2ff194604e210\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/index.js\":\"cd8b4de910a7c820\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/keyCapture.js\":\"e009d11e933e21a9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/overrideStore.js\":\"28b2ccbaee5cd327\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3e5a69e5272d85e5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/HeaderItem.js\":\"d981844a3c846933\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/LeftSidebar.js\":\"c93febba01fa5bbf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/actions.js\":\"2ff64a8f93e27ee7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/facet.js\":\"df4e0d2c30556ee8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/index.js\":\"43120ddc911ca416\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/shortcuts.js\":\"329f9065cd5abe54\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/left-sidebar/toggleStore.js\":\"c6f3267394c95a3b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/MergePicker.js\":\"f80e5afe6ce2fcf2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/index.js\":\"c873ccac91fff936\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/mergeAction.js\":\"40f2524ec489e69b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/merge-blocks/strategy.js\":\"9dc10b99e2e16c10\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/Button.js\":\"5f76a6fd37a463a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"226b49a073b993a5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/defaultItems.js\":\"56dbca956ebb57d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/facet.js\":\"23403ab97f01431c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-bottom-nav/index.js\":\"96ab77b721e9f9c0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"18f2318483055363\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/actions.js\":\"fa9e9562e575c4c4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d5f8cddaed1d313d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/facet.js\":\"90c44b880aa26dcc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/mobile-keyboard-toolbar/index.js\":\"3608b93a659f49ea\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/MoveDestinationPicker.js\":\"db0105c012d9c9a7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/blockSubtreeMembership.js\":\"13b5fd82fb2a2a24\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/contextMenuItem.js\":\"22c933bdd91d034e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/index.js\":\"f2f62d625464be57\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveAction.js\":\"0fc31cd0d2cf2cac\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/moveBlocks.js\":\"8a25ff875560e708\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/move-blocks/selectionAfterMove.js\":\"059133d5ffd8d624\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/TutorialBanner.js\":\"cac643513de9d651\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/action.js\":\"bc79d226719f1a9c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/bannerDismissal.js\":\"b1a16aa1c47e2808\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/documents/cheatSheet.js\":\"169863ff043f19f8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/index.js\":\"7cb109c2da6d347e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/keys.js\":\"419560e6834fc547\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/landing.js\":\"f9a611665316b987\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/outline.js\":\"aaa210aa53bc3de1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/onboarding/seed.js\":\"54ff2f30217fd400\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3d353ecd00c6a15a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/analyze.js\":\"f1854f3388f7c072\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/diagnosticsSource.js\":\"c1de72ce77048994\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/index.js\":\"d51d3e07cfaf233d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/load.js\":\"d9eca15ce3960360\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/monitorRun.js\":\"3cdd0cc7e3f4b7b5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/schedule.js\":\"3cb5b7862427df63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/series.js\":\"ee5ab5c66ff6d8d0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/store.js\":\"7e224f140ebe18ed\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/trendAction.js\":\"922f53b09548e905\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/perf-monitor/verdict.js\":\"d5ff6350b50a9899\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/clickToEditAction.js\":\"45d6b0428c3d1b45\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/index.js\":\"c59175dc315ecad6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/plain-outliner/interactions.js\":\"ca647dade8e669cc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f862707fa7d491ab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGate.js\":\"61ce208754f84961\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/MigrationGateDialog.js\":\"9924989817fba79b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/action.js\":\"36bc8b1151ce71f6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/index.js\":\"63079a65c9711231\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/localRunMessage.js\":\"2bb827dae00fa890\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/plugin.js\":\"1302238e02c94336\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/progressReport.js\":\"0b44d9a5042d9cf1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/properties-migration/sweepProgress.js\":\"bdb481f21b905ce3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/FieldRowRenderer.js\":\"1266f41ebd9b5ef9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/ValueRowRenderer.js\":\"764d8a9806ab0627\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/actions.js\":\"4883d16920452767\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/autocomplete.js\":\"27e6bc88f97b8703\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/fieldRow.js\":\"7efae8934cf05756\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/index.js\":\"5a3c7d9bd946153b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/referenceWarning.js\":\"08c55fc0c7be853c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueAutocomplete.js\":\"34702be8f4e66640\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/property-rows/valueSchema.js\":\"5c8953f4a4e43108\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/HeaderItem.js\":\"cef54403c094ea5b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/QuickFind.js\":\"e94741d76f8275fe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/index.js\":\"55a76468d7f9324b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/recents.js\":\"009f34b2f0c2612a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/resultItems.js\":\"e2c03514cd2f2ba0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/selection.js\":\"7dcead42fa7624ff\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/quick-find/toggleStore.js\":\"87fb4117c11f5fb5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/HeaderItem.js\":\"8d319645fdb8fb0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1a9cd54834decbf3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/grouping.js\":\"122762f9ec1b0a38\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/index.js\":\"6c80097c07e32d2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/recents/target.js\":\"afb4486c7c73f870\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/codeMirrorExtensions.js\":\"0c1f61d1e7f01f9a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/contentPrefill.js\":\"103e8fdcf8452cce\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/dataExtension.js\":\"cd0a90e6dbfe0179\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/index.js\":\"44f86177de7f59e2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"afe3bc92214d1fe1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/invalidation.js\":\"2587aa350e69937b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/localSchema.js\":\"7e162b470db25fc4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/index.js\":\"f7cb35a1b34e7641\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a9b2bbc9546f0337\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/index.js\":\"068993c2625c3a2b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/referenceNode.js\":\"fa9706f7ffb902bc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4c16758c72880e3c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a72d33fbe35d17be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/index.js\":\"1445fc590bc1aa1e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fd6bc85560ef72f7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"171e21110c48d1b3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/mergeRetargetProcessor.js\":\"7f735a9a6f838c65\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/parseFence.js\":\"a5e78783f4724a93\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceParser.js\":\"5195f96e24d4779e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referenceProjection.js\":\"26fff11d98630acc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/referencesProcessor.js\":\"12a886224904d045\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/renameProcessor.js\":\"b1ce25e52c50838c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/references/spanReplacement.js\":\"e907e881bfad31cd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/htmlToOutline.js\":\"f0fd66a7eb7b8ed2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/index.js\":\"eede538c84efe670\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1cbd6a466f811e1c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/rich-paste/pasteDecision.js\":\"9711ba711b514de0\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/action.js\":\"a894ff87c21722ef\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/blockIds.js\":\"644a53e5dbcc195b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/content.js\":\"2f3bc07452160a11\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/effect.js\":\"edcca1950f64117f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/ids.js\":\"2c5bd7f30a0a41ee\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/import.js\":\"4365ff5f7980643b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/index.js\":\"257ea35ce79ffab5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plan.js\":\"4ed3d245170aef2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/plugin.js\":\"7bf85c5ea73e70c7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/promotion.js\":\"40990eaa20d5a496\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/properties.js\":\"8b3878c0c3aafed7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/references.js\":\"6abe15fa94660362\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/report.js\":\"dae7b9e3abc9bb43\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/roamMemo.js\":\"d4e3d13c8fbaa67d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/runtime.js\":\"c6b6ff4cadf36a8c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/schemaReconciliation.js\":\"abc29e7ff457c256\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/srsMarkers.js\":\"27e2cd38f42faf36\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/todo.js\":\"fcbcb911c45dd629\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/typeCandidates.js\":\"8f046f8f1663ec8c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/roam-import/types.js\":\"21671fef605d59da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/index.js\":\"e8626730e4bff8bf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/search-health/store.js\":\"53aa7c08d3d83278\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/HeaderItem.js\":\"8cf7131e3f97cdc8\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0d3c6eb4db672a1f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/index.js\":\"e55a3ce0b33803b7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/model.js\":\"a919dfe8aeb908e7\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/toggleStore.js\":\"b24315bd09a216d9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/shortcut-help/useKeyInspector.js\":\"161ce70c5e1af315\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8ec2e442a5536b25\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/ShellDecorator.js\":\"e10030d4369adc69\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/actions.js\":\"f2e55b899b193a94\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4066ce5f2373058b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/index.js\":\"816b372ce4760de2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/shell.js\":\"71e9957bdb26d836\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/surface.js\":\"30ee65d75506ba43\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/spatial-navigation/walker.js\":\"8a7c65333a67b62e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/RescheduleToast.js\":\"77d97dca4711b7a4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/dataExtension.js\":\"dcea14d307f5bc8f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/index.js\":\"a94cb32a4fd8f5aa\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/indicator.js\":\"3cf8fc4ea2616dc2\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/moveSrsState.js\":\"0427b368371a5639\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bbc99a6e53faa729\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/scheduler.js\":\"33b655d0f1e98de1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/schema.js\":\"35b30228f46ebf1b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2b4be1b30b4179cb\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/srsClipboard.js\":\"9b92e3323b42e73c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6c85ee722e65560a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5c4c268412d067e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/DeckPicker.js\":\"9bbead38544b15be\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewControls.js\":\"5e533242d7d9511f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1202e04cb242bacf\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/ReviewSession.js\":\"cf3e61843b3ab360\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/actions.js\":\"4806eec3ebb93bf5\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/archive.js\":\"0e060e1ce99e8257\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dataExtension.js\":\"967040e114dedeab\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/deck.js\":\"33faa660d5736647\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/dueQuery.js\":\"611374288e12ff1c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/gradeDecision.js\":\"6db39f7dd3a32cc4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/index.js\":\"df05b3a7c8393166\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/keyHints.js\":\"28de3be763797504\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewCardLayout.js\":\"658c075c4b7109ad\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/reviewProgress.js\":\"27fb2aa1e354fc23\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/schema.js\":\"e4cee7224d6b200f\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/srs-review/useDueCards.js\":\"604e8e3f12a56999\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/index.js\":\"ee03c1ff639ecd9d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/startup-metrics/record.js\":\"eed7fd618bad1c26\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/index.js\":\"6781faca3efcd60c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/persistenceStatus.js\":\"0ea31dcb4d7325fe\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/storage-persistence/requestAction.js\":\"3019043edff53329\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/TypeChipsDecorator.js\":\"1d2ab8bbe2ade2b1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/codeMirrorExtensions.js\":\"10e3a84b1c6a6987\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/index.js\":\"e640b536ea0753af\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/supertags/typeAutocomplete.js\":\"2cc555c88daf86e4\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0518c8864df56f6a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/actions.js\":\"44a68eb0cbe00bf3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/anchor.js\":\"906de40d9725640b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/events.js\":\"4b2d31bbbc979fe9\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/gestureActions.js\":\"9dd1c79331842437\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/index.js\":\"ed1b7596ec45561d\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3fb50d2dc16acb46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/collect.js\":\"e1e7eb7fef16c425\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/index.js\":\"cbd9620210c43652\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/sync-metrics/record.js\":\"c0aede27330728da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/RejectionDialog.js\":\"a441f39f5b73dc7a\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9d462c7e8dedbbf6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/index.js\":\"e08f6979cf915450\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/model.js\":\"42bb25dfbc59d518\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/queueCounts.js\":\"a8f1f0ce39cc37f1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rejectedHelpers.js\":\"b8f3ceede0253666\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/rematerializeAction.js\":\"340adfd58c79f926\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/system-status/useHysteresis.js\":\"1169c8a951b3a732\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/effect.js\":\"a041df4313216c6e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/index.js\":\"b9fe736222f01b46\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/theme-toggle/theme.js\":\"9d9cd1534651a298\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/actions.js\":\"8c6eb5fc9d726941\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/dataExtension.js\":\"13dcf7fd4172881b\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/index.js\":\"818dabf09bec8e51\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/todo/schema.js\":\"278422f35ac65f60\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7f85befab35d5a7c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/actions.js\":\"2461dcd7296ba789\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/defaultItems.js\":\"6651281d66fd9794\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/facet.js\":\"70bd62b563198850\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/holdRecognizer.js\":\"1fc8ff2d2ba66c78\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/touch-selection/index.js\":\"1ae1430baac36e63\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/UpdateIndicator.js\":\"16e85980e1ee6a35\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/index.js\":\"cf7a8f0e2ac41126\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/update-indicator/loadTimes.js\":\"2ce7ef78e045ebb1\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoNotesRenderer.js\":\"fe9b247c5019d852\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoPlayerRenderer.js\":\"c145543e561d89bd\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/VideoTimeStamp.js\":\"276720adc47cf994\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/actions.js\":\"92281804d268776e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/index.js\":\"3244c85fae022a2c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/markdown.js\":\"5b4f0dabe48d3f4e\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/notes.js\":\"14e92c107b9df641\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/registry.js\":\"50040a7739f58b91\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/remark-timestamps.js\":\"e7d0517d27635b0c\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/video-player/view.js\":\"7f6ffe8a253aec68\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/LinkHints.js\":\"a58cb10e4aa595da\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/index.js\":\"6c4fc981a93321f3\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/model.js\":\"fb9e9b097d84dffc\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-link-hints/settings.js\":\"20c745823cdffc96\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/actions.js\":\"437fd6ec78847736\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/index.js\":\"f83a170e991c6615\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/vim-normal-mode/interactions.js\":\"4a3b02d47c4236c6\",\"/knowledge-medium/pr-preview/pr-1785/src/plugins/workspace-header/index.js\":\"3fdba0f3f0dc3136\",\"/knowledge-medium/pr-preview/pr-1785/src/registerServiceWorker.js\":\"90b2f270e65f46d3\",\"/knowledge-medium/pr-preview/pr-1785/src/requestPersistentStorage.js\":\"95ca1eceaf9565f4\",\"/knowledge-medium/pr-preview/pr-1785/src/services/authRequestDeadline.js\":\"3a183affd7a2dd30\",\"/knowledge-medium/pr-preview/pr-1785/src/services/powersync.js\":\"db242e917abbc34a\",\"/knowledge-medium/pr-preview/pr-1785/src/services/supabase.js\":\"18e5a7823f64b0f7\",\"/knowledge-medium/pr-preview/pr-1785/src/services/uploadErrorClassifier.js\":\"7822a27f5ce8670b\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/ActiveContexts.js\":\"8968c4d34e0f9fb7\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/HotkeyReconciler.js\":\"4eefe10bbcc77abf\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/WipeLocalDataDialog.js\":\"2b9babb3db3d7971\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionDispatch.js\":\"23040bf655a0c568\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/actionRefItems.js\":\"a7a925f46057b456\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/applyKeybindingOverrides.js\":\"038264fbd4070b62\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/blockActions.js\":\"cb00bd64f3aa5e8b\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/canonicalizeChord.js\":\"520220f3110c198d\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultContexts.js\":\"cb5e3d7dbfe24424\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/defaultShortcuts.js\":\"510ae03caf797441\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/effectiveActions.js\":\"0e83f53433ca6ea1\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureAction.js\":\"817807736288504c\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/gestureBinding.js\":\"618f2b8155a92d21\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/holdRegistry.js\":\"53f2e7c3fef4d9c6\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingConflicts.js\":\"99d6b468f023eed5\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/keybindingOverrides.js\":\"ee4eb9f9a75c2e03\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/pointerAction.js\":\"bcc1b400ecf4d5a1\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/resolve.js\":\"d1b3e1357fa60829\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/runAction.js\":\"454a040f7ca78c41\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/sequenceMatcher.js\":\"3770e9078e49e41e\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/types.js\":\"f88efdc8202ac5c3\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionContext.js\":\"26b0e7a6659545f7\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/useActionDiscovery.js\":\"1f2b76aa4e0a75de\",\"/knowledge-medium/pr-preview/pr-1785/src/shortcuts/utils.js\":\"d862d05617e87304\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/bootStore.js\":\"8227654a62ad2c22\",\"/knowledge-medium/pr-preview/pr-1785/src/sw/previewDatabases.js\":\"40cfd240e4c1c4da\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/byteTransform.js\":\"88539e8236c8c988\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/attachmentCleaner.js\":\"8436dd1b1db14515\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/attachmentParts.js\":\"2ef249cfe0eb7ac9\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleParts.js\":\"a209df9c7b50494b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/bundleRecord.js\":\"bb3d8b4ddf4c5536\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/manifest.js\":\"73a10c29161c74eb\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/takeBundle.js\":\"a5a2083d553d3a7b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/bundle/verifyBundle.js\":\"0fdf62979f6cbed0\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/cleaningStage.js\":\"925d33e800ea91e6\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionKey.js\":\"ebc2ee6728d573b4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/conversionServer.js\":\"0318bcbc82095336\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flip.js\":\"1fc2e81f373d2c9d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/flipAttempts.js\":\"a5e5820afa1d5ac5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/pages.js\":\"24467cfa5ca17e25\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/preflight.js\":\"9c283882aa54d1b7\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/reseal.js\":\"525f5a959faa53f2\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runConversion.js\":\"284c0baac825803d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/runLock.js\":\"b4e2dbff3b5fd5b6\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealing.js\":\"bded54cccbf5975d\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/sealingStage.js\":\"065a1af773c5dc0f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/stage.js\":\"6e14b7119c50b303\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/conversion/verifyReseal.js\":\"49cd72d69836f6d2\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aad.js\":\"617e5897bf219657\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/aead.js\":\"ec8334e11ad60fc3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base32.js\":\"4ca89af2967767ae\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/base64url.js\":\"9c9fc7937ff5cd27\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/binaryEnvelope.js\":\"df8b5712924de1b8\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/byteAead.js\":\"e98846f87c84664b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/canary.js\":\"1bd8a8ce54315030\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentHash.js\":\"6452c7ce2416ff93\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/contentKey.js\":\"08bcc381fbbb3ec2\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/derivedIdNamespace.js\":\"6077cdf791edc615\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/envelope.js\":\"5c8ce47c044d5b6c\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/hex.js\":\"29b89d366e779a61\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/sha256Hex.js\":\"efa77e76f41213d7\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/crypto/workspaceKey.js\":\"d42bf130f954e880\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/conversionState.js\":\"4a0762ea3587f94a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/createEncryptedWorkspace.js\":\"10d93579bb9bf98b\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/pastedKey.js\":\"b58f1e7a412ac28a\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1218cbcd20a81246\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2d56900c7326b53f\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/keyStore.js\":\"5b3e871da72ffbf3\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/mintWorkspaceKey.js\":\"d3e3b65ab5cca925\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/modePin.js\":\"2aebf04009babeb5\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/openWorkspaceKeys.js\":\"1e0c6b329c538a22\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolveWorkspaceEntry.js\":\"5dafd854572bad12\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/resolver.js\":\"36adbae2776c8c91\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/keys/workspaceAccess.js\":\"6361a9140575ffd4\",\"/knowledge-medium/pr-preview/pr-1785/src/sync/transform.js\":\"c74bdcf97b3bc6c1\",\"/knowledge-medium/pr-preview/pr-1785/src/themeBootDefaults.js\":\"c356925402d22a7f\",\"/knowledge-medium/pr-preview/pr-1785/src/types.js\":\"8e49ca6890d534a2\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/ClientLocalSettings.js\":\"ad0b24d178204862\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/abortableSleep.js\":\"3b5534b45a084803\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/array.js\":\"10839a4472a33ec1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/backlinkAutocomplete.js\":\"819209c03ffd68dc\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockCrumbs.js\":\"bf197098f2767653\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/blockrefAutocomplete.js\":\"8d361160670142ad\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/cadencedIdleJob.js\":\"73cbe26394c2fa60\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/callbackSet.js\":\"b194d14717917fca\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/clientId.js\":\"5086b2ef7094e7f6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirror.js\":\"89c69a2f0342586c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/codemirrorCompletion.js\":\"844621b477d0725d\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/copy.js\":\"976ba053ff215b58\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dailyPage.js\":\"a2bf59ff476cc638\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensics.js\":\"0d45b6e4a99876c0\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dbForensicsHooks.js\":\"dc1bc20df9ab1e58\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/deleteBlockThroughUi.js\":\"ed47dd76f47fe324\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dialogs.js\":\"4d17da75112d9cb8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/dom.js\":\"565b6c092afaedd9\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/downloadBlob.js\":\"915441b5c2717f60\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/exportSqliteDb.js\":\"79645b2486d0d8a7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fileSystemAccess.js\":\"7a63362ff20ced8b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/flipSlide.js\":\"e6dfc2a1713883f8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fnv1a.js\":\"24d6e860936e52da\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/formatBytes.js\":\"c5a4b35dd54e0f6c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/fuzzyRank.js\":\"32f09092e8970c4c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idbKeyedStore.js\":\"0a0a83ec0aee3d1b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/idleCallbackPolyfill.js\":\"721798862f14f6f1\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardAwareScroll.js\":\"bc759eb1558a4cd4\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/keyboardViewport.js\":\"ba87bcf4741ef431\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/lastWorkspace.js\":\"41cc6db589f4dc1e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutColumns.js\":\"4312c13082dea925\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionDom.js\":\"4502832cf6a000e8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/layoutSessionId.js\":\"0127b13c0ad5fa23\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkClickGestures.js\":\"55fafb53939e8ac3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/linkTargetAutocomplete.js\":\"93f9a8e93421c06b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbCorruption.js\":\"a973f2650372ab2f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/localDbRecovery.js\":\"80d418ea45891a76\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/markdownParser.js\":\"6e5aaf3237450089\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/memoize.js\":\"7066838acb44c8ff\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameFieldCommit.js\":\"1ec74c42b1c3f59a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/nameList.js\":\"d1ea7f358b6e4b57\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/navigation.js\":\"6e55f299535bb605\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/omnilinerNamespace.js\":\"9018ca9c2980579a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/opfsPageScan.js\":\"573a220816f323e8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelClearance.js\":\"605e482de13d805e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelHistory.js\":\"abff45a47d96f81a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLanes.js\":\"cceebfaa8c133943\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelLayoutProjection.js\":\"ffd7aeece72b16bd\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelScrollAnchor.js\":\"86fe5d5b72ad27ba\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/panelUrlFlags.js\":\"bf5c080de9e37c5f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/platform.js\":\"9d44e01b7a778019\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/pluralize.js\":\"048e39128dc2297c\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyCreation.js\":\"440726b4b759d94f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyNavigation.js\":\"067d6b535212dcef\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/propertyValueContext.js\":\"1a9e58cabc4be720\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/react.js\":\"b03c921fbfcc3f52\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeDate.js\":\"efc96e76f2126a4f\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/relativeTime.js\":\"24d0a584c7fa731b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/renderScope.js\":\"6194f65e410699a7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/resolvedThenable.js\":\"f7e798070678301a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/routing.js\":\"a2281d4bf4239227\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/safeMode.js\":\"dc3771e8e1baceca\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/scheduleIdle.js\":\"2fe22ab17ad9866a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/screenWakeLock.js\":\"a005badd5fff0701\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/selection.js\":\"fe690302b3665d46\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/softKeyboardGrab.js\":\"9269c6ec7a68f429\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/startupTimeline.js\":\"2a9cb3b1e9e50abd\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/state.js\":\"36c527fd4b359f5b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/string.js\":\"82cc785c4a4c171e\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/surfaceZoom.js\":\"f966808808ec83f3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/time.js\":\"b1b18355f24a11a7\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toast.js\":\"0df988cb9682b505\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/toggleStore.js\":\"ad41944cd3a01a0b\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/untilStopped.js\":\"f329a0d6025c8ef8\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/userActivity.js\":\"4c442650527e3ebc\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewTransition.js\":\"e72a2bb1f7b73219\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/viewport.js\":\"cc033c7e4f7e505a\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/webLock.js\":\"6c44b4e6029a52e5\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceRecovery.js\":\"7c5f17237086e8f3\",\"/knowledge-medium/pr-preview/pr-1785/src/utils/workspaceSnapshotStore.js\":\"207298171f8b24f6\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-compiler-runtime.js\":\"01aef66e4bee20c1\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-client.js\":\"8014f3313f52f84b\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server-edge.js\":\"4f13b7945f3bb0df\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-server.js\":\"f0f8b9724f662e5b\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static-edge.js\":\"c9e0293d45e6fa4f\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-static.js\":\"fd9188e478e1e9bd\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom-test-utils.js\":\"6665310ed403f0c9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-dom.js\":\"e1e5d30889920acd\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react-jsx-runtime.js\":\"1586535fb31df557\",\"/knowledge-medium/pr-preview/pr-1785/src/vendor/react.js\":\"3143e225c0906f57\",\"/knowledge-medium/pr-preview/pr-1785/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1785/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
