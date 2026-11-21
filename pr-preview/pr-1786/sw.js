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
		buildId: "57bd0f51bba2-1fbc4e3f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1786/\":\"792a3a0f210c035a\",\"/knowledge-medium/pr-preview/pr-1786/index.html\":\"792a3a0f210c035a\",\"/knowledge-medium/pr-preview/pr-1786/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1786/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1786/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1786/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1786/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1786/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1786/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1786/assets/FacadeVFS-CVjEv_DJ.js\":\"9abf5ed8a25920a5\",\"/knowledge-medium/pr-preview/pr-1786/assets/OPFSCoopSyncVFS-CYU_SoYK.js\":\"c211cf17b2bb3289\",\"/knowledge-medium/pr-preview/pr-1786/assets/OPFSWriteAheadVFS-CGqW52x_.js\":\"adbbed5c367e7c53\",\"/knowledge-medium/pr-preview/pr-1786/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1786/assets/wa-sqlite-TCg5sEwe.js\":\"fd2fb5b1869ebda9\",\"/knowledge-medium/pr-preview/pr-1786/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1786/assets/wa-sqlite-async-CoGZ6Get.js\":\"ae0ebd326671e907\",\"/knowledge-medium/pr-preview/pr-1786/assets/worker-DZcaR64b.js\":\"f64d683598023358\",\"/knowledge-medium/pr-preview/pr-1786/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1786/chunks/app-CHudv01q.js\":\"35dcf1112212804f\",\"/knowledge-medium/pr-preview/pr-1786/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1786/index.js\":\"06d406fdd1441918\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1786/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1786/assets/AccessHandlePoolVFS-CrYNf2oM.js\":\"6dc29e3091362c3e\",\"/knowledge-medium/pr-preview/pr-1786/assets/IDBBatchAtomicVFS-DqkObT0x.js\":\"8256b5514e30de75\",\"/knowledge-medium/pr-preview/pr-1786/assets/MemoryVFS-CU33Jgo6.js\":\"187cf21c86333347\",\"/knowledge-medium/pr-preview/pr-1786/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1786/assets/mc-wa-sqlite-DGOvLVRQ.js\":\"e62272b6767651d4\",\"/knowledge-medium/pr-preview/pr-1786/assets/mc-wa-sqlite-async-C88oPEDO.js\":\"dd07ee38decb60c7\",\"/knowledge-medium/pr-preview/pr-1786/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1786/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1786/chunks/AccessHandlePoolVFS-BAylJxkL.js\":\"c3c5cf90f87564ad\",\"/knowledge-medium/pr-preview/pr-1786/chunks/FacadeVFS-B8NVuHsp.js\":\"91db58ba60a786d2\",\"/knowledge-medium/pr-preview/pr-1786/chunks/IDBBatchAtomicVFS-DsiQbUFT.js\":\"4e04bdfe76162023\",\"/knowledge-medium/pr-preview/pr-1786/chunks/MemoryVFS-BlFRw7Qm.js\":\"19ba8c958f74049f\",\"/knowledge-medium/pr-preview/pr-1786/chunks/OPFSCoopSyncVFS-PPIoZ4pz.js\":\"221d85db9615a95e\",\"/knowledge-medium/pr-preview/pr-1786/chunks/OPFSWriteAheadVFS-CuM7wFET.js\":\"8296795c52cbba17\",\"/knowledge-medium/pr-preview/pr-1786/chunks/Preview-DBFTkdrN.js\":\"d524d49c0ae3a277\",\"/knowledge-medium/pr-preview/pr-1786/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1786/chunks/card-Br4Eb_yY.js\":\"b23e7b9e1e5a9f6e\",\"/knowledge-medium/pr-preview/pr-1786/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1786/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1786/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1786/chunks/dist-Dksg-En3.js\":\"2b74cb7891db6cde\",\"/knowledge-medium/pr-preview/pr-1786/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1786/chunks/mc-wa-sqlite-BA-8TsxE.js\":\"79c984f4d723c881\",\"/knowledge-medium/pr-preview/pr-1786/chunks/mc-wa-sqlite-async-CqhCPxip.js\":\"ba5fbca287580312\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-8rw5LgMI.js\":\"ff38ac789f093c14\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-BV9erK6l.js\":\"7b2197d09c9bc66b\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-BVacmEGI.js\":\"2463104118855ca9\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-BwiJnX5S.js\":\"15e84bbeddc6a98b\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-CvP5p2Nq.js\":\"e3dd4a9cb3b2798e\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-CxDHP8Om.js\":\"f0ec40e3567f6e26\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-CzG2onfT.js\":\"77160a70079dee8b\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-DqiTaf4D.js\":\"5c03384f64f4395e\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-dom-server-legacy.browser.production-CFmj8ok5.js\":\"6ddaec68aba25bf1\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-dom-server.browser.production-HBVKalrx.js\":\"74c92d210eaf3ee0\",\"/knowledge-medium/pr-preview/pr-1786/chunks/react-dom-server.edge.production-C7xzWu03.js\":\"5e20a809282f8223\",\"/knowledge-medium/pr-preview/pr-1786/chunks/server.browser-IitQVkOr.js\":\"6f4f01d401364675\",\"/knowledge-medium/pr-preview/pr-1786/chunks/textarea-BITV5yZd.js\":\"3f3fc3ab02ee19b6\",\"/knowledge-medium/pr-preview/pr-1786/chunks/ui-DpXTN8g6.js\":\"5f9a70173ec977d2\",\"/knowledge-medium/pr-preview/pr-1786/chunks/wa-sqlite-DFDkZlDy.js\":\"c7158ed54bec8cb3\",\"/knowledge-medium/pr-preview/pr-1786/chunks/wa-sqlite-async-DpA6Xi12.js\":\"dd5f0067ad5ffbdf\",\"/knowledge-medium/pr-preview/pr-1786/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1786/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1786/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1786/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1786/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1786/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1786/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1786/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1786/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1786/src/App.js\":\"5d46cd94d17d9615\",\"/knowledge-medium/pr-preview/pr-1786/src/appUpdate.js\":\"5683b7f6178a77d1\",\"/knowledge-medium/pr-preview/pr-1786/src/appVersion.js\":\"fbad6ff04409f875\",\"/knowledge-medium/pr-preview/pr-1786/src/bootstrap/initialLayout.js\":\"2ea044997c441c54\",\"/knowledge-medium/pr-preview/pr-1786/src/bootstrap/openWorkspaceData.js\":\"4e4cc7cbf031ed91\",\"/knowledge-medium/pr-preview/pr-1786/src/bootstrap/resolveWorkspace.js\":\"083e236622edd281\",\"/knowledge-medium/pr-preview/pr-1786/src/bootstrap/workspaceBootstrap.js\":\"647d90bde7bc011f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/BlockComponent.js\":\"55ba87df2d23084a\",\"/knowledge-medium/pr-preview/pr-1786/src/components/BlockCrumbs.js\":\"4aa75928075a168b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/BlockEditor.js\":\"e5fb19d829fd483d\",\"/knowledge-medium/pr-preview/pr-1786/src/components/BlockLoadingPlaceholder.js\":\"6f0289c66615a776\",\"/knowledge-medium/pr-preview/pr-1786/src/components/BlockProperties.js\":\"d9e74c7caf0c0682\",\"/knowledge-medium/pr-preview/pr-1786/src/components/BlockSearchPicker.js\":\"63d039a8a6bc4e99\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ConfirmBulkDeleteDialog.js\":\"a799a5f5db27d9a3\",\"/knowledge-medium/pr-preview/pr-1786/src/components/DividerHandle.js\":\"322a655ece71508b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/DraftEditor.js\":\"406c302ca30f7fac\",\"/knowledge-medium/pr-preview/pr-1786/src/components/GutterPill.js\":\"13e68af71c24c22b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/Header.js\":\"34d399cf66031f1b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/LazyBlockComponent.js\":\"c21a6349837a6eb8\",\"/knowledge-medium/pr-preview/pr-1786/src/components/Login.js\":\"05185ca77e40f83f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ZoomableSurface.js\":\"be3bc2c340e9aefc\",\"/knowledge-medium/pr-preview/pr-1786/src/components/editModeKeepalive.js\":\"dba8002d9a29bedf\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyDisplay/PropertyDisplayScope.js\":\"58c2b715289311b3\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7ee95209f37218e6\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/RefPropertyEditor.js\":\"fd931c141116ec64\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/RefTargetTypePicker.js\":\"ff956dd560d9ec62\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/SelectPropertyEditor.js\":\"b15a652f5e2d4c74\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/TypesPropertyEditor.js\":\"fc89fbb240aef16e\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/defaults.js\":\"c72bb8a182ec2419\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/kernelValuePresets.js\":\"671a0277b2d17943\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/selectablePresets.js\":\"f33cefcdb4c1e911\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyEditors/typesPropertyUi.js\":\"1fad96cc79927e0b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/AddPropertyForm.js\":\"61313ce705e6ba6b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/PropertyPicker.js\":\"cae3c6d7c9308ca8\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/PropertyRow.js\":\"226c526bb059eb39\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/Rows.js\":\"c0174548010f3d7f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/actions.js\":\"6959d029add5a869\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/declarationOnly.js\":\"b17825fdb9bb7c1c\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/layout.js\":\"cf3a68d1cfc16e2c\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/model.js\":\"555867a08ff13b1f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/shapeUi.js\":\"bfe9cb4b72fe854f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/shapes.js\":\"8c1aab0aa6647a52\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c3daf5cf8c1a81dc\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanel/visibility.js\":\"ebbe6d8df1d61eb5\",\"/knowledge-medium/pr-preview/pr-1786/src/components/propertyPanelSections.js\":\"02c2d7b033cede9d\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/BlockEmbed.js\":\"74e769799361ef74\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/BlockLink.js\":\"d51d63834d02f080\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/BlockRef.js\":\"4b8ded4be355441c\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/ReferenceLink.js\":\"ca8e6a209992d8c5\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/cycleGuard.js\":\"5756df130665565e\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/cycleGuardContext.js\":\"9b2693ec21c07c9f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/linkInteraction.js\":\"d5e9489bfd67b49f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/referenceLayout.js\":\"dde7751f104e90e8\",\"/knowledge-medium/pr-preview/pr-1786/src/components/references/useBlockRefAncestors.js\":\"7bbb7f9fe6c662ab\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/BlockGutter.js\":\"734765ec319653c2\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/BlockInfoDialog.js\":\"5b1dfcee1fcc4a5a\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/BlockTypeBlockRenderer.js\":\"2820f5a6e7c69b89\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/BulletHoverCard.js\":\"16fcd2ad374a8f95\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/CodeMirrorContentRenderer.js\":\"3f9a46d494dbe9a6\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"74c612bb0aaf5d77\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/ColumnResizeHandles.js\":\"32eb5f312c1c88f8\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4feda0aed2cc64f3\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/DefaultBlockRenderer.js\":\"54f0f804d7d689a3\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/LayoutRenderer.js\":\"b8066f25fcc3ef24\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/MarkdownContentRenderer.js\":\"465adf062b8c521e\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/MissingDataRenderer.js\":\"17737c4cfe0bfe97\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/PanelRenderer.js\":\"2dccbedacb3e2171\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4c0877bd68a73cbe\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/TopLevelRenderer.js\":\"2d5041607ede9632\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/blockGutterMode.js\":\"38a160ae204f8eae\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/blockTitleText.js\":\"33ffa7d739d8a312\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/fieldCreationKeydown.js\":\"8c1ab6dee3ee76f2\",\"/knowledge-medium/pr-preview/pr-1786/src/components/renderer/layoutRootContext.js\":\"84e7dab6a627dc8c\",\"/knowledge-medium/pr-preview/pr-1786/src/components/typeChip/TypeChip.js\":\"8fbda4f7540d5558\",\"/knowledge-medium/pr-preview/pr-1786/src/components/typeChip/chipStyle.js\":\"88ae78ffff15d5f6\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/anchored-floating.js\":\"4f4292113886d0b0\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/button.js\":\"01105c8da36cc158\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/card.js\":\"46679a6e1e9f5297\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/checkbox.js\":\"5293bd3aae1cea11\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/collapsible.js\":\"4275ad2ce4504be7\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/command.js\":\"d6bc838600c07a4b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/context-menu.js\":\"60e02cc0d49164fd\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/dialog.js\":\"f00c5518de2c99a1\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/dropdown-menu.js\":\"4118dcf355f80b11\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/floating-listbox.js\":\"9b71589ed787c0af\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/index.js\":\"4cc9a50a8eafb55f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/input.js\":\"a7da0537632e9419\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/kbd.js\":\"512d6b29fdecc54f\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/label.js\":\"ba53f3960c78a48e\",\"/knowledge-medium/pr-preview/pr-1786/src/components/ui/textarea.js\":\"9c4bf61edea9dc81\",\"/knowledge-medium/pr-preview/pr-1786/src/components/useEditModeYieldKeepalive.js\":\"7d20c2097e03d79b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/BootFallback.js\":\"bbeebcdbb5371fda\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/FocusedRowLazyMount.js\":\"c99826552f18e40e\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/LazyViewportMount.js\":\"1510556d34460e7b\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/LocalDbCorruptionFallback.js\":\"96d891aded5032d8\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/error.js\":\"451a9c4b438cca99\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/lazyMountRegistry.js\":\"613d6fc3eb456eba\",\"/knowledge-medium/pr-preview/pr-1786/src/components/util/suspense.js\":\"dd45503a76ce60f3\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/CreateWorkspaceDialog.js\":\"80f67cc0bb29ac65\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/PendingInvitations.js\":\"b4609453782e043d\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/SyncProgress.js\":\"2baef4d849896d46\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/UnlockProgress.js\":\"bea38e1fc83f1100\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/WorkspaceKeyGate.js\":\"e7d67c2c0d27bf15\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/WorkspaceSettingsDialog.js\":\"43988323ffd1a72d\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/WorkspaceSwitcher.js\":\"9d320f0607d35daa\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/WorkspaceSyncGate.js\":\"61ab397112f241fb\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/ConversionFlow.js\":\"5175bd8f651d2894\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/ConversionFlowHost.js\":\"c588b76a0dd7eb00\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/EncryptionSection.js\":\"1421ea5f27f7814e\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/attachmentPrompts.js\":\"91cb0dd01e28e4ab\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e477733ce8023a12\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/conversionFlowDeps.js\":\"d9f208a05d4c9526\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/conversionFlowStore.js\":\"450b11f26c8b0160\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/flowUi.js\":\"e222c50ea73ffd49\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/conversion/useConversionRun.js\":\"5911cdc8a54336d8\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/keyUi.js\":\"d60a3a0fb087d655\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/useCloseOnKeyLoss.js\":\"c58d68d4d47a6f27\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/useCloseOnServerE2ee.js\":\"cd48cff42d2b8458\",\"/knowledge-medium/pr-preview/pr-1786/src/components/workspace/workspaceUnlocked.js\":\"c49faf96136d6735\",\"/knowledge-medium/pr-preview/pr-1786/src/context/backgroundSubtree.js\":\"34aacaea8ac6c704\",\"/knowledge-medium/pr-preview/pr-1786/src/context/block.js\":\"4bbb7708442cd45c\",\"/knowledge-medium/pr-preview/pr-1786/src/context/layoutWsContext.js\":\"e8b0ba45430f65c9\",\"/knowledge-medium/pr-preview/pr-1786/src/context/propertyDisplay.js\":\"6a431622fed31b98\",\"/knowledge-medium/pr-preview/pr-1786/src/context/repo.js\":\"b28d8523b569e137\",\"/knowledge-medium/pr-preview/pr-1786/src/data/aliasClaim.js\":\"1b65fd725108c96f\",\"/knowledge-medium/pr-preview/pr-1786/src/data/aliasSeatNamespace.js\":\"026215edab486339\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/blockData.js\":\"73e747c88c7e453e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/blockType.js\":\"1a1cde89a5943eb3\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/changeScope.js\":\"627ebe0b3076965c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/codecs.js\":\"d3982b459f3471fd\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/derivedData.js\":\"0198519d027a73a2\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/errors.js\":\"c16d720fcf818912\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/events.js\":\"7fb5044c10c1af2e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/handle.js\":\"6ec1690b0368c438\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/index.js\":\"d019cb4c96aa0c93\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/mutator.js\":\"2426639f5c038cb0\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/processor.js\":\"a91999ce79446277\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/propertySchema.js\":\"dee168a20348e927\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/query.js\":\"b731d29d38de646e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/sameTxProcessor.js\":\"d88abd2197c08b43\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/schema.js\":\"6ec1690b0368c438\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/tx.js\":\"6ec1690b0368c438\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/typedBlockQuery.js\":\"3dc5858b662bc73c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/user.js\":\"5981540eb35adc63\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/valuePresetCore.js\":\"b046a20de1014663\",\"/knowledge-medium/pr-preview/pr-1786/src/data/api/valuePresets.js\":\"aced45674cb44026\",\"/knowledge-medium/pr-preview/pr-1786/src/data/attachmentCleanerIOVerb.js\":\"bb9929a03ecbec21\",\"/knowledge-medium/pr-preview/pr-1786/src/data/block.js\":\"6eb229348512a5a9\",\"/knowledge-medium/pr-preview/pr-1786/src/data/blockCache.js\":\"8b44418cd3c9dee9\",\"/knowledge-medium/pr-preview/pr-1786/src/data/blockId.js\":\"5b2a31efdfee53ef\",\"/knowledge-medium/pr-preview/pr-1786/src/data/blockLiveness.js\":\"dc663ce7b74b8caf\",\"/knowledge-medium/pr-preview/pr-1786/src/data/blockMerge.js\":\"f8a78bd6b14b61fd\",\"/knowledge-medium/pr-preview/pr-1786/src/data/blockSchema.js\":\"e70a707215288c62\",\"/knowledge-medium/pr-preview/pr-1786/src/data/blockTypes.js\":\"9ea0a902218e9dc2\",\"/knowledge-medium/pr-preview/pr-1786/src/data/clientContext.js\":\"9a405ac360ee034b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/dbFileSiblings.js\":\"7bc3867b19c8caea\",\"/knowledge-medium/pr-preview/pr-1786/src/data/definitionSeeds.js\":\"e60f56521d691034\",\"/knowledge-medium/pr-preview/pr-1786/src/data/derivedIds.js\":\"0022d9c53307530a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/drawnSubtree.js\":\"5ff244d5bdc82176\",\"/knowledge-medium/pr-preview/pr-1786/src/data/facetBridge.js\":\"d43fa80b05b2b4eb\",\"/knowledge-medium/pr-preview/pr-1786/src/data/facets.js\":\"b407ad2df63a582c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/globalState.js\":\"90b5a00f3bf2c62b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/aliasClaimRederiveProcessor.js\":\"40f65b8bc05666f9\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/ancestorBatch.js\":\"05d21d477d63580e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/blockTypeTypeifyProcessor.js\":\"873d47a0ceb4ca5c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/clientSchema.js\":\"8a397c6670799a2c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/commitPipeline.js\":\"6939643763e9c121\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/devAssertions.js\":\"fb2cf4e9b3396792\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/firstSync.js\":\"bd426579ce3deb8e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/freshInitialLoad.js\":\"58ae7c71c86db7e9\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/graphBackfillClaim.js\":\"8ed758cacc32f052\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/handleStore.js\":\"71adde74240ef8eb\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/idleMarkerJobs.js\":\"64a141b13cf61adb\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/initialDownload.js\":\"beac46f9bc488179\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/initializeClientDatabase.js\":\"9d4ade2c562019fd\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/jsonCanonical.js\":\"863d684315271c36\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/kernelInvalidation.js\":\"0afe8d551047a708\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/kernelProcessors.js\":\"4a682f6ae6b7e883\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/kernelQueries.js\":\"c660a1b277b459b6\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/mergeTypeMembershipProcessor.js\":\"d18359263621be02\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/normalizeReferencesProcessor.js\":\"a4493d0cb4f4ce26\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/poolInstrumentation.js\":\"a1a3edb08828c35b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/processorRunner.js\":\"264f94a2a6d7e933\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertyCellBackfill.js\":\"33bed7c960687550\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertyChildMint.js\":\"e03684c958b7c4c5\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertyChildrenProcessor.js\":\"152d4d13e11e4ac1\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cfb819719756085b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertyDefinitionSynthesis.js\":\"5783075bb931bfaa\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertyKeyScan.js\":\"e9b30421e0e1b139\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/propertySchemaResolution.js\":\"227526b5ff2fad7a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/raiseProtocol.js\":\"917fc35148badd3b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/readBatch.js\":\"66ef47d07413d5c3\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/refProjection.js\":\"3521828efc7c32bc\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/referenceTargetLookups.js\":\"806134f4d16f7ce4\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/referenceTargetProcessor.js\":\"ad2f4c6914eb0c53\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/replayMerge.js\":\"a95f740fd3e07678\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/sqlBinds.js\":\"92e83db700950462\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8ec978873e9376ca\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/syncObserver/arrivalProcessors.js\":\"fc8179f282887bc0\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/syncObserver/invalidate.js\":\"ed956176a9be374c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/syncObserver/materialize.js\":\"a3cce90ec4947ec4\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/syncObserver/observer.js\":\"dc2332e287e4b829\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/syncObserver/reconcile.js\":\"92e268fbe26ced3a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/timingMetrics.js\":\"ae5f3ed3c1381c54\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/treeQueries.js\":\"bf445ef6b6071d65\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/txEngine.js\":\"90c28a8630fc2c2f\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/txSnapshots.js\":\"1efa5e2a7da9af54\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/typedBlockQuery.js\":\"eec37560626ca7bb\",\"/knowledge-medium/pr-preview/pr-1786/src/data/internals/undoManager.js\":\"627da5c51eaf3644\",\"/knowledge-medium/pr-preview/pr-1786/src/data/invalidation.js\":\"4e23eee1adfad92d\",\"/knowledge-medium/pr-preview/pr-1786/src/data/kernelDataExtension.js\":\"179987587fb973aa\",\"/knowledge-medium/pr-preview/pr-1786/src/data/kernelPage.js\":\"ebc60c461f5034c8\",\"/knowledge-medium/pr-preview/pr-1786/src/data/kernelValuePresetCores.js\":\"1ed1ed2a106d0873\",\"/knowledge-medium/pr-preview/pr-1786/src/data/localDbCorruptionSignal.js\":\"73cf7bb94df4b132\",\"/knowledge-medium/pr-preview/pr-1786/src/data/localDbStorage.js\":\"d94d1cea2aab8fe0\",\"/knowledge-medium/pr-preview/pr-1786/src/data/localDbVfs.js\":\"a737b825aea1a99c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/localSchema.js\":\"462ab4fe4533aa0a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/maintenance.js\":\"dddeb41f87c2c0ba\",\"/knowledge-medium/pr-preview/pr-1786/src/data/mergeProperties.js\":\"2201d4068ef39119\",\"/knowledge-medium/pr-preview/pr-1786/src/data/metricsConsoleHook.js\":\"bd1ab5c095f90af3\",\"/knowledge-medium/pr-preview/pr-1786/src/data/migrationsPage.js\":\"abbf36772811d026\",\"/knowledge-medium/pr-preview/pr-1786/src/data/mutators.js\":\"b4345cdb7ddd0fac\",\"/knowledge-medium/pr-preview/pr-1786/src/data/orderKey.js\":\"d2b9022e21ef7f65\",\"/knowledge-medium/pr-preview/pr-1786/src/data/orderKeyPlacement.js\":\"52358da1c1b451cc\",\"/knowledge-medium/pr-preview/pr-1786/src/data/outlineSurface.js\":\"5f4a5bf5dffff76b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/pendingEditorContent.js\":\"92a7050ecdd65ba3\",\"/knowledge-medium/pr-preview/pr-1786/src/data/pendingUploadsSql.js\":\"4488063515818524\",\"/knowledge-medium/pr-preview/pr-1786/src/data/pluginStateExtensions.js\":\"3226604e92e1d732\",\"/knowledge-medium/pr-preview/pr-1786/src/data/powerSyncLogger.js\":\"6bcbba1822ac5e36\",\"/knowledge-medium/pr-preview/pr-1786/src/data/projectorRuntime.js\":\"c6fc97fc50a34b57\",\"/knowledge-medium/pr-preview/pr-1786/src/data/properties.js\":\"12183f0fa77419aa\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertiesPage.js\":\"6615e6e70fa0635d\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertyChildren.js\":\"22d7d38e109fc592\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertyDefinitionFanout.js\":\"1b311eb9f87e5243\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertyDefinitionMetadata.js\":\"b5dc7a4da4cf4015\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertyDefinitionRegistry.js\":\"35bcf4e83d291740\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertyDisplayMode.js\":\"6c8bce72e62926a4\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertyRowCreation.js\":\"d4f1f407b8fb87d5\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertySchemaCreation.js\":\"61bf80f0a6934354\",\"/knowledge-medium/pr-preview/pr-1786/src/data/propertySeeds.js\":\"56d1284008a78dd1\",\"/knowledge-medium/pr-preview/pr-1786/src/data/recentsPage.js\":\"b190acf22f23e38e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/referenceBlock.js\":\"c65c5437fa297455\",\"/knowledge-medium/pr-preview/pr-1786/src/data/releasePowerSyncConnection.js\":\"8e7c012b3480117d\",\"/knowledge-medium/pr-preview/pr-1786/src/data/repo.js\":\"96e080331f607c4a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/repoProvider.js\":\"c9a96bf21646062a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/rowProperty.js\":\"ed8e1eb1a65a9fdf\",\"/knowledge-medium/pr-preview/pr-1786/src/data/searchFilter.js\":\"29d2a478c3b9aad5\",\"/knowledge-medium/pr-preview/pr-1786/src/data/seedIdentityLedger.js\":\"cb228405c50a52c1\",\"/knowledge-medium/pr-preview/pr-1786/src/data/stateBlocks.js\":\"32012ae3c0082b58\",\"/knowledge-medium/pr-preview/pr-1786/src/data/structuralEditPolicy.js\":\"58a0b5e9e6189192\",\"/knowledge-medium/pr-preview/pr-1786/src/data/subtreeDelete.js\":\"59091a60b76f825d\",\"/knowledge-medium/pr-preview/pr-1786/src/data/syncStreamLock.js\":\"3a6d278294ec5c7f\",\"/knowledge-medium/pr-preview/pr-1786/src/data/syncedTableSqlRecognizer.js\":\"ad2d24c346288728\",\"/knowledge-medium/pr-preview/pr-1786/src/data/syncedTableWriteGuard.js\":\"5ebf772452a2815a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/targets.js\":\"fa0ebd4660f21d92\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeColors.js\":\"7feff9f0602a8f44\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeDefinitionMetadata.js\":\"16c63b7331655fa3\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeDefinitionRegistry.js\":\"82e6fc4a6f0d630d\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeExtraction.js\":\"297cd1aca6160d18\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeInitialValues.js\":\"aa352214265d1f66\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typePropertyGroups.js\":\"783e2efed092dce4\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeSeeds.js\":\"b822b3b37c5a615c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typeTagger.js\":\"ede29beede96d8d6\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typedRecords.js\":\"2a8cde28a527b665\",\"/knowledge-medium/pr-preview/pr-1786/src/data/typesPage.js\":\"f879bedf9099e580\",\"/knowledge-medium/pr-preview/pr-1786/src/data/userPrefs.js\":\"94aaf8775ef3f185\",\"/knowledge-medium/pr-preview/pr-1786/src/data/userSchemasService.js\":\"cf3f1ee23b4e660c\",\"/knowledge-medium/pr-preview/pr-1786/src/data/userTypesService.js\":\"e11a9e42ca2e658b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/valuePresetRegistry.js\":\"0c7ffae075286f7b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/visibleChildren.js\":\"4bb0347b48b0d186\",\"/knowledge-medium/pr-preview/pr-1786/src/data/workspaceConversion.js\":\"01c5ae01f84e23f5\",\"/knowledge-medium/pr-preview/pr-1786/src/data/workspaceFirstSync.js\":\"74f51441c5b662a3\",\"/knowledge-medium/pr-preview/pr-1786/src/data/workspaceIdNamespace.js\":\"a351f71c2000502a\",\"/knowledge-medium/pr-preview/pr-1786/src/data/workspaceSchema.js\":\"90f12ab23d60514b\",\"/knowledge-medium/pr-preview/pr-1786/src/data/workspaces.js\":\"63605ef6420a9977\",\"/knowledge-medium/pr-preview/pr-1786/src/data/writeAheadLog.js\":\"7008e0a3096a848e\",\"/knowledge-medium/pr-preview/pr-1786/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/BlockPasteShellDecorator.js\":\"634f1eb63949b077\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/atTrigger.js\":\"8e28d0c16c5ece05\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/autocomplete.js\":\"0a9b32b6369555e9\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/codeMirrorExtensions.js\":\"358f1e9de76224d2\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/contentFlush.js\":\"7d17052039978f08\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/defaultInteractions.js\":\"97202e37dc032975\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/editSettleSignal.js\":\"ac4f7eaeaa9e449a\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/insertImage.js\":\"a6c8e33662b89c6f\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/referenceCompletionRange.js\":\"09f94b65c415c7f5\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/referenceTargetTypes.js\":\"4d4715f7ae33b408\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/syntaxContext.js\":\"1eb298611ce50cdf\",\"/knowledge-medium/pr-preview/pr-1786/src/editor/triggerMatch.js\":\"befce71ac5aed350\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/AppRuntimeProvider.js\":\"815b3962688103fb\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/BlockFocusShellDecorator.js\":\"94eee282833a89d9\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/ExtensionRenderBoundary.js\":\"a119a3cb23cdd002\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/PanelContentRecovery.js\":\"52abdf42fda79874\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/apiCatalog.js\":\"836daef2f3bf93a8\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/approveExtensionHere.js\":\"a86003f0b27cd646\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/armedCutAppMount.js\":\"c63dec0b712d92e7\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/batchableKeyedStore.js\":\"541beac1417e0de0\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/blockInteraction.js\":\"acef22aa5168f34d\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/blockSelectionAction.js\":\"8ae4a39bacfcaffb\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/compileExtensionModule.js\":\"76c9a6c198275bd9\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/compiledModuleCache.js\":\"d98c04288bc049c5\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/continuousGestures.js\":\"6e6cc92fd7d0ba2a\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/core.js\":\"efa9f6cf9103c6ae\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/defaultRenderers.js\":\"a4ed8a5414582a3d\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/definitionFanoutAppMount.js\":\"304e97f178e2146a\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/dialogAppMount.js\":\"9dc8c066c766ec0e\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/dynamicExtensionSeeds.js\":\"0d5fda98afe135f6\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/dynamicExtensions.js\":\"119855901afcd2f2\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/exampleExtensions.js\":\"af326462b51ccfde\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/extensionApprovalStatus.js\":\"d368aa97f6a1af0d\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/extensionLoadErrorToast.js\":\"0a3492f4a73f9a81\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/extensionLoadErrors.js\":\"d521ef3081f79c5d\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/extensionLookup.js\":\"9cec81fd1e25208b\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/extensionToggles.js\":\"ad38038579d70e05\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/extensionUtilitiesCss.js\":\"05be00d248a51870\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/kernelPageDeletionGuard.js\":\"7592ee6992f43682\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/liveRuntime.js\":\"5df90dfa24c4a8e0\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/openExtensionsSettings.js\":\"05f667c123cf8e26\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/overridesCache.js\":\"21dcca814a65ea75\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/pluginIds.js\":\"d708b76eddc8b47d\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/processorRejectionToast.js\":\"f4ee573dad70900a\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/runtimeActions.js\":\"52e86842f809416a\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/runtimeContext.js\":\"f7df15cea02e5c48\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/staticAppExtensions.js\":\"7402cb099ad2ff63\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/staticDataExtensions.js\":\"f2cc3c0c2126818e\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/toastAppMount.js\":\"0c8b4931fbf838ed\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/useOverrides.js\":\"60d9645ee256aa73\",\"/knowledge-medium/pr-preview/pr-1786/src/extensions/useShortcutSurfaceActivations.js\":\"3cceba2c6f13e0c1\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/discoverToggleTree.js\":\"67840f0979bff84b\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/facet.js\":\"973dba9ae9ee3855\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/resolveAppRuntime.js\":\"8b0aef7a9cc1e25f\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/runtimeEvents.js\":\"ed9652e97566d2e4\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/togglable.js\":\"10fabd59baec20dc\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/variantFacet.js\":\"b764ae172d46e28d\",\"/knowledge-medium/pr-preview/pr-1786/src/facets/verbFacet.js\":\"859d437fa25ebe6d\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/block.js\":\"4344c209728869f5\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/focusedChild.js\":\"40c154120f405220\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/propertySchemas.js\":\"be597e98106641f8\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/typeRegistry.js\":\"db968ff3e82353a1\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useAncestorCrumbs.js\":\"b5b7b1036dd8ac5d\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useAutocompleteListbox.js\":\"834c6c104dbfe884\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useDebouncedSearch.js\":\"d209569e18a40c2d\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useDebouncedValue.js\":\"a88076d353578bc5\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useIsFocalRender.js\":\"7e6853c801ef1af7\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useIsReadOnly.js\":\"4d2202a611483bfd\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useMaterializeBacklog.js\":\"535012666e13c582\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useMinuteClock.js\":\"0128e84f16d56e9a\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/usePanelLayoutProjection.js\":\"3b35ef01a2dde8af\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/usePendingInvitations.js\":\"2c090da8ad28a784\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useRendererRegistry.js\":\"9f5cb7dba31cd91e\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useRetainedFieldRows.js\":\"e8152f2a77986856\",\"/knowledge-medium/pr-preview/pr-1786/src/hooks/useWorkspaces.js\":\"d827f8409cb29c75\",\"/knowledge-medium/pr-preview/pr-1786/src/lib/utils.js\":\"355e8feed6b7fd31\",\"/knowledge-medium/pr-preview/pr-1786/src/main.js\":\"98c65d6e58d13c84\",\"/knowledge-medium/pr-preview/pr-1786/src/markdown/MarkdownImage.js\":\"f539c25b30e619f4\",\"/knowledge-medium/pr-preview/pr-1786/src/markdown/blockSeparators.js\":\"022927ef60907cae\",\"/knowledge-medium/pr-preview/pr-1786/src/markdown/context.js\":\"3911affb8df8ca4a\",\"/knowledge-medium/pr-preview/pr-1786/src/markdown/defaultMarkdownExtension.js\":\"42b792840f418f44\",\"/knowledge-medium/pr-preview/pr-1786/src/markdown/extensions.js\":\"014d6163219e46b0\",\"/knowledge-medium/pr-preview/pr-1786/src/markdown/renderMarkdownHtml.js\":\"dd6209aa55119dae\",\"/knowledge-medium/pr-preview/pr-1786/src/minimal-editor.js\":\"26649b0e6c7e6e89\",\"/knowledge-medium/pr-preview/pr-1786/src/paste/armedCut.js\":\"75e59299ea386600\",\"/knowledge-medium/pr-preview/pr-1786/src/paste/captureMediaVerb.js\":\"d2728056bb8d71f9\",\"/knowledge-medium/pr-preview/pr-1786/src/paste/clipboard.js\":\"963f709e3eab894b\",\"/knowledge-medium/pr-preview/pr-1786/src/paste/decision.js\":\"1a4ee50b1ac65c0a\",\"/knowledge-medium/pr-preview/pr-1786/src/paste/operations.js\":\"9ca3403af9535215\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/account-header/AccountHeaderItem.js\":\"7cf1ba72aa26d19e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/account-header/index.js\":\"3c81712702229a59\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"52a9c26f607d4525\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/askAgent.js\":\"d2393f3b50474649\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/askedStore.js\":\"ec0b2b6f5838b0a5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a37997e0480b0823\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/chipState.js\":\"f08b44087f2096f7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0b5a213fb2b73739\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/index.js\":\"4395615385becbb3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1c3a3e689b11e3f8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-dispatch-companion/schema.js\":\"df1d24f00f2a8a68\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c97269e8df823c44\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a6fffcf2b621b1b0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/addMedia.js\":\"a8d351a39a6bc5c4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d67ccb772447a867\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/block.js\":\"df79128a3357b16e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/context.js\":\"7216c03cd93e9eaa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a03f0ba017472e9c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/index.js\":\"c42656eba9b9dfe1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/outline.js\":\"a2d5d1de3d0b25a9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/properties.js\":\"62d9c40f1bc8e45b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/refs.js\":\"8a62eb5a10c11ad9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2da34396844462f1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/search.js\":\"137823b8cad6c931\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/shared.js\":\"d20eecaa2a866865\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4edb9cf154182f12\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentViews/text.js\":\"c09f18132e22b940\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/agentWrites.js\":\"6c67c99357453f33\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/authoringCatalog.js\":\"0e1ba630d2077701\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/blockRefTargets.js\":\"099af8ef90fc5cc6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/bridge.js\":\"49e2be1f351b56aa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/bridgeLoop.js\":\"9abc8ba13340c394\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/changeHistory.js\":\"25dbb2860e6a0546\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/commands.js\":\"1f9ecbdf4d9dc78c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/commentsCommands.js\":\"542ae350c6010c52\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/dataExtension.js\":\"0822df0d1f646bc0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/dataModelGuide.js\":\"c3097a2115671f8f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/describeRuntime.js\":\"775064cd3035b0aa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/extensionLint.js\":\"00b1872bb5f19c94\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/grainAudit.js\":\"27517d12823e20e3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/healthCommand.js\":\"284800c9e2390640\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/index.js\":\"5c56253e3fa117d7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/presetIdentity.js\":\"6c0e4252c5193f71\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"faf4c13ce0f730ae\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/readMedia.js\":\"b6f974a9f290a381\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/schema.js\":\"dcaf5f00533c4b1c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/serialization.js\":\"80dccfc62c341d25\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/targets.js\":\"6bb7f665886fec91\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/tokens.js\":\"8f67e5d42839a875\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/watchEvents.js\":\"616e0e6ed0cf006a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/workspaceGuard.js\":\"ac811aea286875da\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/agent-runtime/writeCommands.js\":\"383b56fa2b234ab9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/AliasCollisionToast.js\":\"5e9cf169ad353b53\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/DuplicateNameBanner.js\":\"4cd394e88a7e08c4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/collisionMerge.js\":\"ad0d5072ab5a7a6f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/dataExtension.js\":\"970bcb199547e6d2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/index.js\":\"e84ec88d30ea6fc6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/mergeCollisionAction.js\":\"08d53e6c269c12e6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/pageStyling.js\":\"5cecf47b501445aa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/rejectionToast.js\":\"97f94d087852ea8f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/alias/syncProcessor.js\":\"e9b43a809cf5b6de\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/actions.js\":\"22e0b487d42d7d68\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/addComment.js\":\"68b316d2bf28d1c0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/anchor.js\":\"b4c9eb9962bcffbc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/anchorState.js\":\"9c0ff1ba3707bd95\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/commentLinks.js\":\"793b34e5328eab75\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/confirmThreadDeletion.js\":\"0b52f1fb1adaf684\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/container.js\":\"74187b4181e7e4e4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/dataExtension.js\":\"8a1f7d7b3b456b32\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/deleteComment.js\":\"dabc38ea10911d24\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/highlights.js\":\"82c4a2a19867ce9a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/index.js\":\"0229188129d26527\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/linkedCommentsPill.js\":\"0661ccc48882d87f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/margin.js\":\"b21b40b3fc53ce7a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/marginSchema.js\":\"00855e092eaecdd3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/newComment.js\":\"4579f0a4fc766c53\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/ownThreadPicker.js\":\"ef1b5634e0ef6f7b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/placement.js\":\"aeaa0d357e00a693\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/queries.js\":\"1bc14954018ade9a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/quotePosition.js\":\"ba764b065402be4e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/quotedIn.js\":\"387de6dc657d0bb6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/quotedRange.js\":\"a37abb745e9546b8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/rangeRefs.js\":\"f7cd62ba0a99424a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/readHighlights.js\":\"86d5a7661a6a6c50\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/readSelection.js\":\"cd71d8f924f1d2c6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/readSelectionUi.js\":\"33fbb9e62a2bcb3b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/reanchor.js\":\"198bfbf6676f601a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/schema.js\":\"d433659b1894214f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/scope.js\":\"58b27554f1363663\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/scopeThreads.js\":\"b6dad4e706f49002\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/splitRetarget.js\":\"068ea987b8ca6e8f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/suggestionCard.js\":\"fb2fb9d0d28cb795\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/suggestions.js\":\"75ffd6b6a246b837\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/summaries.js\":\"d35a7a1deb22aec1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/summaryBatch.js\":\"02a5faf6db1f3031\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/surface.js\":\"eba2de68fef32c72\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/threadNavigation.js\":\"5ad6e43c0f1c1185\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/threads.js\":\"87966bbfa070a65b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/ui.js\":\"ae25232a780ce24e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/annotations/uiStore.js\":\"fd78e6cc38a8688c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/app-intents/appIntents.js\":\"8a33e37a2b9dafa5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/app-intents/index.js\":\"2c186908384048f8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/app-update-prompt/index.js\":\"40642ddf3e28486f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/app-update-prompt/status.js\":\"6e1eaa0adea6880b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fa36c0ebcd9a9d94\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/MediaBlockRenderer.js\":\"d6ce638eaae98609\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7c95a019448b56f3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/MediaUploadReconciler.js\":\"b7ab2551607a3ba3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/assetDownLane.js\":\"120be26769b78db6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/assetResolver.js\":\"b43d1e49ee1593e0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/assetUpload.js\":\"633ba49885cba09c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/attachmentCleanerIO.js\":\"f82746a92fac7c0b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/audit/supabaseAuditIO.js\":\"154421253a488b71\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/blobStore.js\":\"80c692dffa2c873a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/byteStore.js\":\"688f12a342fb5be0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/cleanerIO.js\":\"d87b1a61c3391dc3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/cleanupAttachments.js\":\"f6f6bc04c4b09795\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/dataExtension.js\":\"833eaa7aba3d0ea1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/downLane.js\":\"fb7098e78a3775ea\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/index.js\":\"9365bee3a10f0e54\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/insertImageContribution.js\":\"64f28f1e6530098d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/laneArming.js\":\"eb15b36e12a064da\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/laneLock.js\":\"5c2235bb8325bd68\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/mediaBlock.js\":\"dfaf0876f007c381\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/mediaCapture.js\":\"d7dd9d6cc2306e72\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/mediaViewers.js\":\"84235f0c8fd78477\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/mediaViewersFacet.js\":\"11f107f433333daf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/pasteCapture.js\":\"c738483dd0498590\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/resolver.js\":\"5bcd7dfa00c3cc42\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/retryUploadsAction.js\":\"bae35b4f6a57faab\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/storagePaths.js\":\"40a87e67760fe162\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/uploadDrain.js\":\"466fd8e83a7eebfd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/uploadLaneStatus.js\":\"9c20c0d723099420\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/uploadReconcile.js\":\"a15c982046c04cb6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/uploadRecovery.js\":\"25b9ea73ccb42923\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/uploadStore.js\":\"9d127288c9b688ad\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/attachments/useAssetObjectUrl.js\":\"a5df9f2f37b93be3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a7660f9e0a35c0b3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7bc82c07c5465a47\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks-view/facet.js\":\"66c9a8b3f7ab1e42\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks-view/index.js\":\"c05c39cb5f2fa578\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks-view/prop.js\":\"d814c2908ff12e5f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/BacklinkFilters.js\":\"3c1e729025366d6a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"05544adaa595cb7a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/BlockEntry.js\":\"8e49724c84437f75\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/LinkedReferences.js\":\"4f2f842052c565ae\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9aa8a191a0c5faf6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/dailyNoteDefaults.js\":\"236e791b7dc98515\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/dataExtension.js\":\"45defd636645566a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/edgeExclusions.js\":\"50a812250f437408\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/filterProperty.js\":\"056993f19ec58c43\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/index.js\":\"b4600ed383b8b4ac\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bc07afd9d9158dc8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/inline-counts/applies.js\":\"926c39ef07931003\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/inline-counts/countQuery.js\":\"8bca578d999122fa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/inline-counts/expansionStore.js\":\"34b5ba931b2bb6b1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/inline-counts/index.js\":\"1637b1f580611005\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d38022bbe050ca49\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/presentationInvalidation.js\":\"fb90d26db16f162f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/propertyEditorOverride.js\":\"d8c7b10609a69c8b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/propertyFilter.js\":\"63658a7c9cdefec6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/query.js\":\"584aa3680ffadfa5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/resolveFilter.js\":\"5a16367ceaa5d7d5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/sourceBatch.js\":\"6e7ad2ac5ef55f4d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/sources.js\":\"abc37b3d7c9c29a9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/useBacklinks.js\":\"907da31123466493\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0c826ecd4b66459d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/birthday/BirthdayCelebration.js\":\"a8bffe0c70a5631a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/birthday/BirthdayOverlay.js\":\"0d66f6dff656fcdc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/birthday/gate.js\":\"8b8d68aeb493ad7a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/birthday/index.js\":\"bb8b4b73d08df5dc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/birthday/wolfTheme.js\":\"319b7b28ee39cf98\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-drag/BlockDragLayer.js\":\"18141ed72de0e7cf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-drag/dragController.js\":\"4934ca4a8b608f83\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-drag/dropTarget.js\":\"03ff1322d582975e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-drag/index.js\":\"d09f7547bed81304\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-drag/projection.js\":\"585e891b6da9d024\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-info/BlockMetaCard.js\":\"2c92d1205b6c2ce1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-info/index.js\":\"fa44a99e40d9c060\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/AddTagDialog.js\":\"48d14a2857ff0cde\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"60b7fa8627711137\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/TagNameIssueHint.js\":\"4ca8f2e85b7e585c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/addTagAction.js\":\"d70a2e0ed6ead42c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/appendTag.js\":\"888762612e998ebc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/config.js\":\"8f343a9c2c17da2a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/dataExtension.js\":\"cf09f129debd0a8c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/index.js\":\"10e538696f9abe28\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/block-tagging/propertyEditorOverride.js\":\"1776090e0d504a0c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/BreadcrumbList.js\":\"05b46a8d5ae4e914\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5b2ec2667817ae18\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fffa85fbcae1d354\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"db33d86ea82f03ff\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"97f0c9e868173fcb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/index.js\":\"ef2f0f8f118768a1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1164eab57075e298\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/CharacterCountItem.js\":\"cc84cd5075d26a2a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3aa57c3fb7464504\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/actions.js\":\"bec780ccd636856b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/blockType.js\":\"25813c5456b52c63\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/charCount.js\":\"900522c085fb8078\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/dataExtension.js\":\"ab635e7449258452\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/index.js\":\"d324ecb4a3c63f5e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/profiles.js\":\"bea6c466e6277bd9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/properties.js\":\"ef9b02314d58d38a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/character-counter/textCounts.js\":\"39b11042600ef29d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/colemak-keybindings/index.js\":\"1cbfe652ad64390d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/CommandPalette.js\":\"21d56a9b6ad34cd9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/HeaderItem.js\":\"3f596aea0b27f5c8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/context.js\":\"df57ba43e85e9f7f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/index.js\":\"6364b0cc5b360fb8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/selection.js\":\"edddddd28109b22b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/toggleStore.js\":\"714db11b02a25590\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/command-palette/useCommandPaletteActions.js\":\"a1e0d28231fd22de\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/ContributorBadges.js\":\"854372fc1699446c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/author.js\":\"4e756fb8361e26d2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/codeMirrorExtensions.js\":\"f8c0fc10b015e6a5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/dataExtension.js\":\"21e7a9846289ea67\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/index.js\":\"e01e0e7f82d14e46\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/mentionAutocomplete.js\":\"314b14d952df646c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/processor.js\":\"3ebcce54c0900846\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/profiles.js\":\"ee9dc5b5b6418077\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/queries.js\":\"90389fd8c3a5a7bc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/contributors/schema.js\":\"f20549117301083e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7a90f7566a3aacfd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e0b31b21a103dc9a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/cursor-follows-scroll/index.js\":\"062feb5d8f18837c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c129064a3f6ec698\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5e7b433336f76b6c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/CalendarGrid.js\":\"7045ff0ad4f60606\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/DailyNotePicker.js\":\"bc9eb8c8937c9a19\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"56508b54b6484f3f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/DateNavDecorator.js\":\"4e819055a0212cc2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/DateScrubOverlay.js\":\"034782416081b742\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/HeaderItem.js\":\"47bb09f7beee586d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/ReschedulePicker.js\":\"24c4434f5356c33f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f57217595c06c949\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/actions.js\":\"fe8596e22cd57dcc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/blockDateAdapter.js\":\"1cefa0e15718dd01\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/calendar.js\":\"5130444985f6359c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dailyNotes.js\":\"0967888ba954f7f9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dataExtension.js\":\"247e37af062b496e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dateScrubActions.js\":\"491bbdf9b0eced73\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dateScrubGesture.js\":\"caa341ae29098759\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c34a9c18cd4d2c15\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0112a21ddcbc75ff\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/deletionGuard.js\":\"6010868ce632bff0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/dueQuery.js\":\"79c2b3c0a31aa57d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/index.js\":\"b9a13718a24745ea\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/landing.js\":\"543742499205df85\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/localSchema.js\":\"c029517832eb2dbd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/referenceDateAdapter.js\":\"9e2cde9f6848491b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/rescheduleAction.js\":\"86e23200fab87d74\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/schema.js\":\"8d8b8295b80a5783\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/spreadBlockDates.js\":\"254595c80af1dc29\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/spreadDatesAction.js\":\"baf7dfe173d4e246\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/today.js\":\"1d8d2b8dd581da3d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"599d6c1e3cfeb340\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"cbba29d6ade50e78\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/audit.js\":\"59c9beeb750cdaf8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/auditAction.js\":\"6c85ad231abd5865\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/auditRanges.js\":\"aa7b4d53964cfa20\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/diagnosticsSource.js\":\"446a8a4bd30ca483\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/divergenceScan.js\":\"dbc51a9e62dfa8ec\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/index.js\":\"f51fc635eb8b4fc4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/propertyChildrenChecks.js\":\"777a79982074cfb9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/referencesMirror.js\":\"536b79c6a56da260\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/rowJson.js\":\"6f2cb44706226c2b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/schedule.js\":\"4e9fc63b5eaf129b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/data-integrity/store.js\":\"9baaaed34268fe31\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-maintenance/action.js\":\"0ed0135ef4806dd9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-maintenance/index.js\":\"41347df273772fc5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-maintenance/plugin.js\":\"35fe296f775be8f5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bb605932dc0a1308\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/actions.js\":\"597a392c3272ce8c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/changeMarker.js\":\"9d325551db5c2fae\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/diagnostics.js\":\"e5130bbc8e3a4a35\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/fileSystemAccess.js\":\"ba86e087bddbe888\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/filenames.js\":\"cd48b0fd745813f7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/index.js\":\"5013ab15f07d2b63\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/mirror.js\":\"2bae1900a12f7f4f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/runLock.js\":\"da900089880ec617\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/runtimeHealth.js\":\"965402743d4b4e37\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/schedule.js\":\"1ea3cf13df3f830b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/db-mirror/store.js\":\"d469bfe885a72eea\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/default-themes/index.js\":\"20bfe907c4d5ccc8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/default-themes/themes.js\":\"fb907f0d25f6c05b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/diagnostics/facet.js\":\"550f817bba4f1bf3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/diagnostics/useDiagnostics.js\":\"056cafca20e38dbf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extension-prompts/dismissals.js\":\"7c9c0eadf9674554\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extension-prompts/index.js\":\"790de55d792cac9f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extension-prompts/status.js\":\"562e09f44f8043cf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extension-prompts/store.js\":\"3f617b4c5631b63d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7eade66be81c7bc0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9946b63c5ea706e1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/actions.js\":\"bba527ae2a175d9f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/config.js\":\"0fb3db50c1e74c96\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/dataExtension.js\":\"90f1ad274958bd29\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/effect.js\":\"78e645fdbb1ba7fb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/index.js\":\"e22994f33f2f2616\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/propertyEditorOverride.js\":\"dd6eaf1c0e4b205c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extensions-settings/useToggleTree.js\":\"35acab67e4981a3b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extract-type/ExtractTypeDialog.js\":\"aeae3ad179cf9301\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"17c3e54f855a7a8e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extract-type/PropertyShapePicker.js\":\"4b8969a431d969df\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extract-type/action.js\":\"a9e2348483597ef7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/extract-type/index.js\":\"db6ab6d0a8fe37fc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/FindReplaceDialog.js\":\"0869317df85ebfd3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/HeaderItem.js\":\"f491085c17fbc21a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/dataExtension.js\":\"17808da7cf4a0f35\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/index.js\":\"961e70af6283b226\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/search.js\":\"b5f910e10d7abeeb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/toggleStore.js\":\"3269a6f20ff95c1b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/LocationPropertyEditor.js\":\"068db94fd88a6f44\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/MapView.js\":\"0af09ccc74c17051\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/blockTypes.js\":\"d8dfeedd5a1b6f19\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/codeMirrorExtensions.js\":\"6ece8ccf9ad2bc73\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/createOrFindPlace.js\":\"b1cc57adb09d7c8c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/currentLocation.js\":\"546c8e8825d8e29c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/dataExtension.js\":\"c499588fdfd64562\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/geoContentDecorator.js\":\"775df1fc2dd8c8d2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/googlePlacesClient.js\":\"d903b7353a1292c5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/index.js\":\"206ba19cface34f4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/locationsPage.js\":\"a990fab4b91271ee\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/mapViewport.js\":\"6de379f8f72b53ca\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/pickCurrentLocation.js\":\"d5a4119ee7c85b46\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/placeAutocomplete.js\":\"22567428e71bead8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/placeNameCollision.js\":\"417a6620220a714b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/properties.js\":\"f21bd5be1fa51a2f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/propertyEditorOverrides.js\":\"423642ca023979f8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/query.js\":\"27ff114261871a44\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/geo/usePlaceSearch.js\":\"d78ce8e3ae676c8d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f5e2dd2d06a87cbd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9079f2624a9a9c82\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e27cd82855ff5afd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/config.js\":\"de55742137ceb386\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/dataExtension.js\":\"7a0d53e13b67a295\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/facet.js\":\"ee331f1eb8abd0d9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/grouping.js\":\"233a4be94dd12298\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/index.js\":\"4789846b2051f103\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"afb4a0c9e5190819\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/query.js\":\"8b302ca71c344514\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/resolveConfig.js\":\"d02993c8485bf4d7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8b5c64552c73b25d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e41e45146a2036cf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/HtmlDocumentContent.js\":\"d276fea395467187\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/HtmlFrame.js\":\"10494e439cefce40\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/actions.js\":\"9c716e6b2f334e67\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/blockType.js\":\"ae7d21d35315991b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/confirmRunScripts.js\":\"10dc1e88e650d231\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/dataExtension.js\":\"a95e3b69017f152b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/frameAnnotations.js\":\"9516d778f6ddf3d5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/frameDocument.js\":\"393a9b7e186d8e0b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/frameTheme.js\":\"6ebe3b38078580b5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/index.js\":\"84356679fdb405b5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/scriptConsent.js\":\"06b90135a8dc50cf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/sourceMap.js\":\"d6633a42b5931855\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/html-document/useDocumentScripts.js\":\"8ed9ffc31c383e41\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/interaction-metrics/index.js\":\"a4cbfb1e8e77ae4d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/interaction-metrics/record.js\":\"9797146a1c1d78fa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/interaction-metrics/recordStore.js\":\"f2bf1368ce48001c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/interaction-metrics/responsiveness.js\":\"e2ea6b977b492ef8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/interaction-metrics/schedule.js\":\"c3bf6b4759bb7220\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/interaction-metrics/sessionContext.js\":\"1cf5fd3eb6bd3a2e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6298605968e0ddbf\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9b5a8ad173198570\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/actions.js\":\"a1f1d59fc0c8cd92\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/config.js\":\"2451a75d084b7173\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/dataExtension.js\":\"3a0ad3e0811aff7c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/effect.js\":\"ac55dce12655803b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/index.js\":\"da3101d361201ecc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/keyCapture.js\":\"04548ea6c535edee\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/overrideStore.js\":\"229c35d56992d7ff\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5f986b256d041ec0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/HeaderItem.js\":\"801f95a8927e82ee\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/LeftSidebar.js\":\"319407c87cd8d7ad\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/actions.js\":\"16c564f30a5f7df9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/facet.js\":\"7a4228d900ee57f8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/index.js\":\"b392ac30886f6180\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/shortcuts.js\":\"b86a9b400d93f0b8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/left-sidebar/toggleStore.js\":\"13863f068d8d38c2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/merge-blocks/MergePicker.js\":\"8fee906effd93d47\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/merge-blocks/index.js\":\"6f01ff266f42e4d7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/merge-blocks/mergeAction.js\":\"721e5f04278fd511\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/merge-blocks/strategy.js\":\"1e0bfc9409a143ed\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-bottom-nav/Button.js\":\"3f9f9337c75ee70c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"091f4d051cc91a7d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-bottom-nav/defaultItems.js\":\"eea82344670ebc33\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-bottom-nav/facet.js\":\"a78a0185bba627ca\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-bottom-nav/index.js\":\"151a18b172ed8539\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9704a76d4ae1fdfa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2d14ae3bc7d0691c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cefff3f4401f09ac\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-keyboard-toolbar/facet.js\":\"20a9064e879a952b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/mobile-keyboard-toolbar/index.js\":\"071b9859bc78b823\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7e175a83ab160ae8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5fdb37e49793682b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/contextMenuItem.js\":\"9e18fceff9a70300\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/index.js\":\"d786d45a3c601e49\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/moveAction.js\":\"fa1147530fd48b24\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/moveBlocks.js\":\"4f276c37d7fb274d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/move-blocks/selectionAfterMove.js\":\"1c419a4c76bb3ceb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/TutorialBanner.js\":\"2e63ab4fa868ea05\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/action.js\":\"631314cb7958a15e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/bannerDismissal.js\":\"0c091ccd6e56cfb0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/documents/cheatSheet.js\":\"95c8195a07919003\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/index.js\":\"12401d0d85ebc315\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/keys.js\":\"8e19a552bd15698d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/landing.js\":\"69849ee99e3bf0c7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/outline.js\":\"1a69bcd4edda9503\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/onboarding/seed.js\":\"d7a45bef2ea6ecec\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/PerfTrendDialog.js\":\"34787db5f1b3c16d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/analyze.js\":\"c72ffb67de602cc0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/diagnosticsSource.js\":\"f7ca610017757853\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/index.js\":\"206491b8b640b8d2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/load.js\":\"17d7b7925afc02b8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/monitorRun.js\":\"d08effa0422f873e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/schedule.js\":\"8855b67f9d34ac30\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/series.js\":\"345c7c857f29fd0e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/store.js\":\"6944ddd3979f8aac\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/trendAction.js\":\"9015bca10d51b217\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/perf-monitor/verdict.js\":\"1cec30020e967dda\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/plain-outliner/clickToEditAction.js\":\"c9116b45835ab0e3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/plain-outliner/index.js\":\"b4a0e825fd2e4515\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/plain-outliner/interactions.js\":\"3d2d3497ff512a44\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d0ed72e23fb52513\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/MigrationGate.js\":\"d26d663c7d354d0e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/MigrationGateDialog.js\":\"4b6154306c154c86\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/action.js\":\"322d783d846b2ba6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/index.js\":\"28e3224139ac7bdb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/localRunMessage.js\":\"6daae8395fbe280e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/plugin.js\":\"ad0d2b2c5a5662cd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/progressReport.js\":\"bb4aa28209c46e31\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/properties-migration/sweepProgress.js\":\"c004fcfd119c46e1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/FieldRowRenderer.js\":\"4a6dee3a6d349c97\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/ValueRowRenderer.js\":\"bc8b77596f139822\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/actions.js\":\"7f2dd311efc5c148\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/autocomplete.js\":\"51e27c039d059017\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/fieldRow.js\":\"4ba7fe6fe230c1a8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/index.js\":\"2d3407bbfc969a2f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/referenceWarning.js\":\"fb5fd1c4f0c5ee23\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/valueAutocomplete.js\":\"b103de35ab1aa863\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/property-rows/valueSchema.js\":\"6b99550dc5fb8cc9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/HeaderItem.js\":\"1a02f9d7dec5f333\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/QuickFind.js\":\"959f9fbbe1ec69b3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/index.js\":\"2c433beee78266f1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/recents.js\":\"51730c65ba68891f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/resultItems.js\":\"b821c0836000dd60\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/selection.js\":\"e28522f09a27ba69\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/quick-find/toggleStore.js\":\"c43254388c1eea2f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/recents/HeaderItem.js\":\"fc1d2b6148bc399a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e2715b80f56b5b49\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/recents/grouping.js\":\"34fb0e4de9c19d48\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/recents/index.js\":\"675263dc813e1a19\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/recents/target.js\":\"caf4aa8436691a08\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/codeMirrorExtensions.js\":\"889d5ca59448e545\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/contentPrefill.js\":\"dfdd47cb9dd78608\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/dataExtension.js\":\"cd66846ffa4ed954\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/index.js\":\"43533a19b1db2cf1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"780afdf3490b7413\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/invalidation.js\":\"22090448167b2d01\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/localSchema.js\":\"4c0131648d7f2bbc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/blockrefs/index.js\":\"c956ec9592bcebd5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6f721ec0bea6ca15\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/index.js\":\"869a82865c5f92f4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/referenceNode.js\":\"6ad2a03ec6256b63\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/remark-reference-occurrences.js\":\"84bd2f76eaec0469\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"622939ce6193f5b3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/wikilinks/index.js\":\"f59751e3fe73e113\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c25c8f06af09bb01\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d343c4fd72bb7508\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/mergeRetargetProcessor.js\":\"097ee17f9a9552c1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/parseFence.js\":\"dbc9b047a230b92f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/referenceParser.js\":\"4318872fc5bc72ad\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/referenceProjection.js\":\"ffa13bb37f0c3c56\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/referencesProcessor.js\":\"73fa3a29563761b8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/renameProcessor.js\":\"b4507370eb8078ec\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/references/spanReplacement.js\":\"c25757a729545ce7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/rich-paste/htmlToOutline.js\":\"7d37b224f73466a0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/rich-paste/index.js\":\"a22cfdafe0db7316\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0d910009b144b7a0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/rich-paste/pasteDecision.js\":\"262a37d98c70ad8b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/action.js\":\"b8073411062eda20\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/blockIds.js\":\"cc446c6783bbeffe\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/content.js\":\"8cf67ff287e34d35\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/effect.js\":\"ab0a13dc4753dc26\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/ids.js\":\"5da4a0dec7f2b3b2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/import.js\":\"e3bac0352f932e4b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/index.js\":\"9e363b1a11bcab8d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/plan.js\":\"fa04055a6bf3979a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/plugin.js\":\"7bb03db4c1171bf1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/promotion.js\":\"ce09143f3d22c6c1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/properties.js\":\"950a84cd6130df05\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/references.js\":\"0169b902fbbb790c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/report.js\":\"57a5ef736d74a96f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/roamMemo.js\":\"7392fc8579558fba\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/runtime.js\":\"18c46cabfc277a58\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/schemaReconciliation.js\":\"c683a4b943dae70e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/srsMarkers.js\":\"015457536c8addfe\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/todo.js\":\"570dc5426febba70\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/typeCandidates.js\":\"d02f5ed159d2d41a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/roam-import/types.js\":\"1180e8e64a985641\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/search-health/index.js\":\"78dbdf5edc92cebb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/search-health/store.js\":\"5b909bf10692f3f4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/shortcut-help/HeaderItem.js\":\"bef4be597373058a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5d95c50c0819f785\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/shortcut-help/index.js\":\"3e0fd85438ecacbc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/shortcut-help/model.js\":\"0ff0dbd013b81f08\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/shortcut-help/toggleStore.js\":\"e96c5b2252a10e57\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/shortcut-help/useKeyInspector.js\":\"e2c265eb1207833f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"34372a8b9e910e6c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/ShellDecorator.js\":\"8bfa980178fc122d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/actions.js\":\"7a05d3343a7783b1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/exclusionsFacet.js\":\"32e4011fe9b14414\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/index.js\":\"e6774ba223f1bcb0\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/shell.js\":\"811e6e60da9a3980\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/surface.js\":\"0718473be6b1a0f1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/spatial-navigation/walker.js\":\"b3e8feb5ec712fe8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/RescheduleToast.js\":\"92f1b440109eeab2\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/dataExtension.js\":\"473b1d99e3ea94a8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/index.js\":\"cea5b4303acd6f86\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/indicator.js\":\"9aa08fed5f9462f7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/moveSrsState.js\":\"3a72accf580a09b5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1029327100cb42c6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/scheduler.js\":\"978bc1ad0cebd3e8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/schema.js\":\"dd516885a5cc5fbd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9bf0b41d5b2014df\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/srsClipboard.js\":\"6349fe72768f5ce6\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1c4b50d2b66d9218\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/DailyNoteReviewHint.js\":\"bb6a42f71d399594\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/DeckPicker.js\":\"44ef3d1a66fda651\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/ReviewControls.js\":\"c4ee6d1839c8d46e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7c6f3709f297f9d4\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/ReviewSession.js\":\"82a06e9238613080\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/actions.js\":\"e7378153b241b572\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/archive.js\":\"46ce6b145651f532\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/dataExtension.js\":\"b93af6c105fd716d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/deck.js\":\"089c000d12a340ca\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/dueQuery.js\":\"53edfdb126670abc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/gradeDecision.js\":\"3a4bf73e137e675d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/index.js\":\"5e37f64d2095ab64\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/keyHints.js\":\"89b039a38410a4ae\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/reviewCardLayout.js\":\"e0d5ada4a31a2c6b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/reviewProgress.js\":\"e562ac6680da54b3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/schema.js\":\"cb6acffc6545d6ce\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/srs-review/useDueCards.js\":\"ae84efbea5e38ecd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/startup-metrics/index.js\":\"a60d239fd25c4998\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/startup-metrics/record.js\":\"3b9af1f32b6e8b8d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/storage-persistence/index.js\":\"43b3d1d503bb2e2e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/storage-persistence/persistenceStatus.js\":\"f719fe1a4b0dfab3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/storage-persistence/requestAction.js\":\"e287a4a6eb987cfa\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/supertags/TypeChipsDecorator.js\":\"4472844dabf8626c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/supertags/codeMirrorExtensions.js\":\"46eb89c2d4b5550e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/supertags/index.js\":\"5bf1ecae80ca666e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/supertags/typeAutocomplete.js\":\"a87e01ed481c5892\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"74cf272e6172e129\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/actions.js\":\"798c525e8623b5d5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/anchor.js\":\"e8e88caccae1879d\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/events.js\":\"e77a7f35700466d1\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/gestureActions.js\":\"63aa5c03b00d20fc\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/index.js\":\"3381a129a8e4bcc8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"ab3b17f944da7f65\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/sync-metrics/collect.js\":\"1fac4b95b6c6ee51\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/sync-metrics/index.js\":\"f1025ac714b2dd27\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/sync-metrics/record.js\":\"826d26cca6896d78\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/RejectionDialog.js\":\"cf2e15ec0c6c99b5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/SystemStatusHeaderItem.js\":\"71cd19e55f12b9ba\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/index.js\":\"34ad0087fdd32370\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/model.js\":\"1f5798432815f0a7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/queueCounts.js\":\"34dd59ec42167919\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/rejectedHelpers.js\":\"9740df63ee90249b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/rematerializeAction.js\":\"ffaea177442905af\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/system-status/useHysteresis.js\":\"31dfc9722a2361be\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/theme-toggle/effect.js\":\"4bc75580b8f41fe5\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/theme-toggle/index.js\":\"fd6c59145c01630e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/theme-toggle/theme.js\":\"f431f5a48079ee6e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/todo/actions.js\":\"5f1c0b7073e94e01\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/todo/dataExtension.js\":\"ef9416124dd65b96\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/todo/index.js\":\"ba7c9ce2cca4c339\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/todo/schema.js\":\"416236429d00441a\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/touch-selection/TouchSelectionLayer.js\":\"827aa3ea2fc0f570\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/touch-selection/actions.js\":\"b21179782d74ea50\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/touch-selection/defaultItems.js\":\"26329906edb337dd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/touch-selection/facet.js\":\"e76c352edd6077eb\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/touch-selection/holdRecognizer.js\":\"f0454ceb2d15c3cd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/touch-selection/index.js\":\"ba528fcf82fc66e8\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/update-indicator/UpdateIndicator.js\":\"56d2189eb2a6d89b\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/update-indicator/index.js\":\"50cf47fd0fed145c\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/update-indicator/loadTimes.js\":\"b4cbef70326d2173\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/VideoNotesRenderer.js\":\"a0e426b82baa82f3\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/VideoPlayerRenderer.js\":\"eb5ac37cd1f90863\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/VideoTimeStamp.js\":\"d9f089bd04bdc303\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/actions.js\":\"5e1f71f55525e0bd\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/index.js\":\"93d3fa8afef3ec20\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/markdown.js\":\"45b57d62d93caaae\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/notes.js\":\"c72963b583829333\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/registry.js\":\"092367a27bb7d16e\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/remark-timestamps.js\":\"b7504b2fcfff29d9\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/video-player/view.js\":\"dd2dcae30fa53281\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-link-hints/LinkHints.js\":\"5121dd35002712b7\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-link-hints/index.js\":\"e3503dd1ccbe4575\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-link-hints/model.js\":\"edfb92d6efb0b89f\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-link-hints/settings.js\":\"e8c946154395a743\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-normal-mode/actions.js\":\"e36e0ca7a8e4cb78\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-normal-mode/index.js\":\"7368a21dfc7fcaee\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/vim-normal-mode/interactions.js\":\"1cdeb071c1421448\",\"/knowledge-medium/pr-preview/pr-1786/src/plugins/workspace-header/index.js\":\"0220a63078197070\",\"/knowledge-medium/pr-preview/pr-1786/src/registerServiceWorker.js\":\"a8f77af726d27e32\",\"/knowledge-medium/pr-preview/pr-1786/src/requestPersistentStorage.js\":\"783bb3dc0939af55\",\"/knowledge-medium/pr-preview/pr-1786/src/services/authRequestDeadline.js\":\"027b1a10d2dfbec6\",\"/knowledge-medium/pr-preview/pr-1786/src/services/authStorage.js\":\"434038ffd303dc0c\",\"/knowledge-medium/pr-preview/pr-1786/src/services/powersync.js\":\"6f58244ece94aec3\",\"/knowledge-medium/pr-preview/pr-1786/src/services/supabase.js\":\"411abcb5eb9ff9eb\",\"/knowledge-medium/pr-preview/pr-1786/src/services/uploadErrorClassifier.js\":\"ba8c97140d1b57f3\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/ActiveContexts.js\":\"0e6c7690894801fd\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/HotkeyReconciler.js\":\"d11c84470a51e2d7\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/WipeLocalDataDialog.js\":\"77acf89e093dd1cc\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/actionDispatch.js\":\"5c92fbdb908158d9\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/actionRefItems.js\":\"0045446e6642d815\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/applyKeybindingOverrides.js\":\"f9dd7e8533cc5a90\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/blockActions.js\":\"4a180402b71f11d6\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/canonicalizeChord.js\":\"b55397ebd4f6cc72\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/defaultContexts.js\":\"c33b51026e029677\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/defaultShortcuts.js\":\"266622a98df05a8c\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/effectiveActions.js\":\"4c5f692affe67dc7\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/gestureAction.js\":\"e6c2603873815039\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/gestureBinding.js\":\"d8ca5d4b7ab0ab8c\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/holdRegistry.js\":\"a00df1774cfead6a\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/keybindingConflicts.js\":\"a0520fec5e91ea11\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/keybindingOverrides.js\":\"4647a1202002fb6f\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/pointerAction.js\":\"6b7e6c973cb2fb5c\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/resolve.js\":\"90c8eb638a467619\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/runAction.js\":\"5937e85f7f9bde31\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/sequenceMatcher.js\":\"77d82d9d68bec7cb\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/types.js\":\"c3b146917a17fbef\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/useActionContext.js\":\"998992ec337e8a39\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/useActionDiscovery.js\":\"2c169b717a0f3e9b\",\"/knowledge-medium/pr-preview/pr-1786/src/shortcuts/utils.js\":\"1374d6c6d6d4afb6\",\"/knowledge-medium/pr-preview/pr-1786/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1786/src/sw/bootStore.js\":\"1606e8203849e3ed\",\"/knowledge-medium/pr-preview/pr-1786/src/sw/previewDatabases.js\":\"aff7cbbdc8e66a8a\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/byteTransform.js\":\"5372f53b3c905c5b\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/attachmentCleaner.js\":\"069b30309e5a5139\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/bundle/attachmentParts.js\":\"246d7a5a9bb0dcfa\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/bundle/bundleParts.js\":\"5c84013a295f90eb\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/bundle/bundleRecord.js\":\"33b62a7318550708\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/bundle/manifest.js\":\"4a5293ca7567a4a7\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/bundle/takeBundle.js\":\"5104433964b80868\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/bundle/verifyBundle.js\":\"b038e6f6d225b83e\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/cleaningStage.js\":\"98ec6dede8818ad2\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/conversionKey.js\":\"448dccab31c19c83\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/conversionServer.js\":\"6c5e4e400b83e998\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/flip.js\":\"b1cb4b0ccc0c750a\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/flipAttempts.js\":\"a1839fc42ba3a6cd\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/pages.js\":\"c83fbb07d96f9368\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/preflight.js\":\"386ec60c3e1c3ba8\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/reseal.js\":\"f2b1ecacb04eba0c\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/runConversion.js\":\"85c5ddc969e86cb5\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/runLock.js\":\"1d1532d682e5f42b\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/sealing.js\":\"3f4be9e0b956a90a\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/sealingStage.js\":\"29e18fa499d4bda0\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/stage.js\":\"6849af2e52c28d59\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/conversion/verifyReseal.js\":\"1c795aca2c1f701d\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/aad.js\":\"98b75d1846182001\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/aead.js\":\"2f2343d5363a0e03\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/base32.js\":\"ae31b941b25a3b3f\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/base64url.js\":\"9f52ebfdc35ab232\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/binaryEnvelope.js\":\"5d905d408f29f956\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/byteAead.js\":\"ac2fac9b70521430\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/canary.js\":\"d829d04a20ae5bb6\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/contentHash.js\":\"796b5b360a902088\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/contentKey.js\":\"551bb5d1403bb45b\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/derivedIdNamespace.js\":\"2cc0ad34ae58293f\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/envelope.js\":\"cdfc491f81aabd8f\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/hex.js\":\"7daff92014c835ae\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/sha256Hex.js\":\"968b5d45528c7ef2\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/crypto/workspaceKey.js\":\"2f2366b004a7632f\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/conversionState.js\":\"ee36e4bc730be4fc\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c8e97a14756d8196\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/flows/pastedKey.js\":\"9d98d0dc02c811a7\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c64cbc8c045d8d4f\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a17d6216ef755307\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/keyStore.js\":\"1a51f79a97e8891f\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/mintWorkspaceKey.js\":\"8a525205694661a2\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/modePin.js\":\"dbc1e6cfc33e77af\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/openWorkspaceKeys.js\":\"b4fc95514e04095e\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/resolveWorkspaceEntry.js\":\"9ce5c63c0e8eacfd\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/resolver.js\":\"7ba89f3ef02909c8\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/keys/workspaceAccess.js\":\"d74d511d84d76965\",\"/knowledge-medium/pr-preview/pr-1786/src/sync/transform.js\":\"55e8f9e7f73329d4\",\"/knowledge-medium/pr-preview/pr-1786/src/themeBootDefaults.js\":\"de49da6029cb7ac2\",\"/knowledge-medium/pr-preview/pr-1786/src/types.js\":\"0e7289a2ed2f3bde\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/ClientLocalSettings.js\":\"e3c3b02e20b28be5\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/abortableSleep.js\":\"49186aec8ec231dc\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/array.js\":\"352e1ff7b041aeeb\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/backlinkAutocomplete.js\":\"33ef087c1b014bf5\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/blockCrumbs.js\":\"a1f95523e86d90fc\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/blockrefAutocomplete.js\":\"4de0f7f2ed1675c9\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/cadencedIdleJob.js\":\"9f0da284d229d5db\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/callbackSet.js\":\"545693ed04f284d0\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/clientId.js\":\"c817a7de1b48fa07\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/codemirror.js\":\"c7ab430e244ce875\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/codemirrorCompletion.js\":\"c43b9e1ce243660c\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/copy.js\":\"3cd3484d937cab10\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/dailyPage.js\":\"05988faf79a2209b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/dbForensics.js\":\"fd3a9788085e94f0\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/dbForensicsHooks.js\":\"be3f851138ac71cb\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/deleteBlockThroughUi.js\":\"d3949d7dd2c08f80\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/dialogs.js\":\"fe71266c894f10bd\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/dom.js\":\"fa3eebd9c99a6a8c\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/downloadBlob.js\":\"7428d88299629f05\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/exportSqliteDb.js\":\"c72b1e8e0f50d13b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/fileSystemAccess.js\":\"87f4302457dd81d9\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/flipSlide.js\":\"9817b60110ea41b5\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/fnv1a.js\":\"66d5d490da1bec50\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/formatBytes.js\":\"96a820a6266a191a\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/fuzzyRank.js\":\"8dbc46b686fb164b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/idbKeyedStore.js\":\"e17fded465749916\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/idleCallbackPolyfill.js\":\"22afa0015f209be0\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/keyboardAwareScroll.js\":\"7258b94e23ef8cdf\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/keyboardViewport.js\":\"1132c318fd8c9826\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/lastWorkspace.js\":\"927c67712ea0f03f\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/layoutColumns.js\":\"9b3bcc276ecde671\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/layoutSessionDom.js\":\"a4e3f6a323c83089\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/layoutSessionId.js\":\"f2bd52c39cbc1bf9\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/linkClickGestures.js\":\"fa730e8718af3e74\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/linkTargetAutocomplete.js\":\"c6a43edcdbbbfe8c\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/localDbCorruption.js\":\"bd8b0f1f311bf566\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/localDbRecovery.js\":\"98a2d4348be08e3a\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/markdownParser.js\":\"f050bef5ef87c75b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/memoize.js\":\"c3c42ba01a90eaa3\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/nameFieldCommit.js\":\"35b2b5423dec0390\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/nameList.js\":\"c4ea4b1d39352b16\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/navigation.js\":\"34ff58df0cd64fc5\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/omnilinerNamespace.js\":\"9a79895d5cf516de\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/opfsPageScan.js\":\"5b0a98bb35f6493b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/panelClearance.js\":\"98c76938bc154131\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/panelHistory.js\":\"5f6d161efad36643\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/panelLanes.js\":\"8a08af96b2957cd0\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/panelLayoutProjection.js\":\"1f2e9b0125d9f41c\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/panelScrollAnchor.js\":\"5f10eacdd630b1e3\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/panelUrlFlags.js\":\"5efcecb662a30a8a\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/platform.js\":\"5b49b9f556e09af0\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/pluralize.js\":\"aa0acbe773e96f40\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/propertyCreation.js\":\"1a5789ee98dc5a71\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/propertyNavigation.js\":\"db38a680db29658b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/propertyValueContext.js\":\"a6981068dd5d4e66\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/react.js\":\"fcb2a3c4ea48027d\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/relativeDate.js\":\"9d99c52aac278532\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/relativeTime.js\":\"71d532ed5f435a03\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/renderScope.js\":\"4d4af9f55b52858b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/resolvedThenable.js\":\"0771cd35613ca1dd\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/routing.js\":\"eed7a4763ad3a38b\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/safeMode.js\":\"9c30e090136f47ec\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/scheduleIdle.js\":\"51851e97aca2e981\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/screenWakeLock.js\":\"ca7149043aca6a44\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/selection.js\":\"da68e888c13cff6a\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/softKeyboardGrab.js\":\"f505ce31cda63660\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/startupTimeline.js\":\"448a7f7b075aec98\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/state.js\":\"7deebd728568cbbc\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/string.js\":\"36c1f81c9605de22\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/surfaceZoom.js\":\"060607347284ce42\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/time.js\":\"dd428f5a4d9ec964\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/toast.js\":\"5fe537e9700a8d8f\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/toggleStore.js\":\"25d4d686b18f69ab\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/untilStopped.js\":\"285a5989c23ff1c9\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/userActivity.js\":\"a7fe3307ea86146d\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/viewTransition.js\":\"b0fc22914094536a\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/viewport.js\":\"86d773ccaac65f44\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/webLock.js\":\"25ab937aa163c9e3\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/workspaceRecovery.js\":\"014ff7a98df5f8b4\",\"/knowledge-medium/pr-preview/pr-1786/src/utils/workspaceSnapshotStore.js\":\"4dda413243eb6715\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-compiler-runtime.js\":\"904e5c68e35fad03\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom-client.js\":\"963faa16ac0593ba\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom-server-edge.js\":\"8bb8343c07571999\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom-server.js\":\"b158fe622bfa9247\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom-static-edge.js\":\"405773f6b4bd4e13\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom-static.js\":\"4e31c54c65055833\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom-test-utils.js\":\"13dc75b0ecbc86d6\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-dom.js\":\"684a882e247aeba1\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react-jsx-runtime.js\":\"ce4b3f76000d867d\",\"/knowledge-medium/pr-preview/pr-1786/src/vendor/react.js\":\"6405a466b8f7af43\",\"/knowledge-medium/pr-preview/pr-1786/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1786/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1786/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
