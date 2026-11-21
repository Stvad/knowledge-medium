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
		buildId: "bad42cd512f6-6a460f22",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/\":\"a9db6e5b86afe602\",\"/knowledge-medium/pr-preview/pr-1787/index.html\":\"a9db6e5b86afe602\",\"/knowledge-medium/pr-preview/pr-1787/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1787/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1787/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1787/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1787/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1787/assets/FacadeVFS-BTlG6mWQ.js\":\"7ec53069f5a10ad4\",\"/knowledge-medium/pr-preview/pr-1787/assets/OPFSCoopSyncVFS-DO2paPH5.js\":\"9616567a6c0fcb1a\",\"/knowledge-medium/pr-preview/pr-1787/assets/OPFSWriteAheadVFS-Bd_6LIvq.js\":\"2436be71db65fd70\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-DnURvDU0.js\":\"b2f2e1b4ddcec7dc\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-async-H_1qYQ0H.js\":\"40ded0764e1a1545\",\"/knowledge-medium/pr-preview/pr-1787/assets/worker-zHuWW5V9.js\":\"65a6cbad53b7fe18\",\"/knowledge-medium/pr-preview/pr-1787/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1787/chunks/app-qNTgWuXT.js\":\"45eb53ebf7a26d06\",\"/knowledge-medium/pr-preview/pr-1787/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1787/index.js\":\"b7e7197e1799644b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1787/assets/AccessHandlePoolVFS-Dp8_aHFg.js\":\"d194b6b43f361504\",\"/knowledge-medium/pr-preview/pr-1787/assets/IDBBatchAtomicVFS-pskAln_K.js\":\"1cc5c35cc5f0f877\",\"/knowledge-medium/pr-preview/pr-1787/assets/MemoryVFS-Db6vL6ic.js\":\"a3c592ef3b155201\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-DJXfyczS.js\":\"6f84490eac01e043\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-async-_2JV_9Vn.js\":\"0b9c0bc73c9ffeb4\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1787/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1787/chunks/AccessHandlePoolVFS-DxK-S-W8.js\":\"1bbe6b9dbca19ad4\",\"/knowledge-medium/pr-preview/pr-1787/chunks/FacadeVFS-S_fkQf2f.js\":\"d9760d500a7f514c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/IDBBatchAtomicVFS-mJMIeohc.js\":\"6315c4a47565a602\",\"/knowledge-medium/pr-preview/pr-1787/chunks/MemoryVFS-By45pnps.js\":\"c93af485810693c0\",\"/knowledge-medium/pr-preview/pr-1787/chunks/OPFSCoopSyncVFS-OAJldPRg.js\":\"de97c6bbe9388ab4\",\"/knowledge-medium/pr-preview/pr-1787/chunks/OPFSWriteAheadVFS-D4aiikyE.js\":\"ebfab43c31b18085\",\"/knowledge-medium/pr-preview/pr-1787/chunks/Preview-CVfNAl-6.js\":\"c28eed49a9ab0aac\",\"/knowledge-medium/pr-preview/pr-1787/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/card-NVq-3N4u.js\":\"3c13bf68fb004c14\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-CG7SwBgv.js\":\"c68836fa46b96c80\",\"/knowledge-medium/pr-preview/pr-1787/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1787/chunks/mc-wa-sqlite-BhMY7baG.js\":\"8995ef400ef36a2a\",\"/knowledge-medium/pr-preview/pr-1787/chunks/mc-wa-sqlite-async-1mGAWSwm.js\":\"915262ea86e17820\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-5gzP5OO7.js\":\"13ba6377e83ea835\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-B7UhRGVi.js\":\"b602ceb37a527b1b\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-BG9qZ47l.js\":\"a3c031661776402a\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-B_zCnlf7.js\":\"80dcd466af2aa3ec\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-CDtrDPXR.js\":\"1565506d3b418737\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-D2GVKlc-.js\":\"5d6288725577e352\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DzIPWXkC.js\":\"b3751a31ebe1385d\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server-legacy.browser.production-DO02oZfb.js\":\"42850395a4b16cb1\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server.browser.production-Pmc9DLOs.js\":\"1fc7ffaf9bc5680f\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server.edge.production-rp2j-BQq.js\":\"0351a5a4889fa43f\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-zRiBiXti.js\":\"501069d3f2fc46f2\",\"/knowledge-medium/pr-preview/pr-1787/chunks/server.browser-BT1h0mbJ.js\":\"d2077dd957717af5\",\"/knowledge-medium/pr-preview/pr-1787/chunks/textarea-BQyB4cCU.js\":\"6b9d8be37c316f44\",\"/knowledge-medium/pr-preview/pr-1787/chunks/ui-B2B1FKgV.js\":\"e8afbf918e774f95\",\"/knowledge-medium/pr-preview/pr-1787/chunks/wa-sqlite-async-CWub23EH.js\":\"4d762b69880bb0f6\",\"/knowledge-medium/pr-preview/pr-1787/chunks/wa-sqlite-zbcnP13q.js\":\"d761773155720821\",\"/knowledge-medium/pr-preview/pr-1787/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1787/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1787/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1787/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1787/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1787/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1787/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1787/src/App.js\":\"f4f948fe6ba7e22f\",\"/knowledge-medium/pr-preview/pr-1787/src/appUpdate.js\":\"5bdad3ec0285b170\",\"/knowledge-medium/pr-preview/pr-1787/src/appVersion.js\":\"4f452702dafcc6ca\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/initialLayout.js\":\"e9f3cfa695c04081\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/openWorkspaceData.js\":\"1b9832350170a175\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/resolveWorkspace.js\":\"d28f26e1a75b4e60\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/workspaceBootstrap.js\":\"19564537cd6399ff\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockComponent.js\":\"518fabff7ba4ed6f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockCrumbs.js\":\"1b6c3739a9e73b2e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockEditor.js\":\"f59019d19ba49a60\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockLoadingPlaceholder.js\":\"31c4caa40d15ac2e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockProperties.js\":\"9136fb14822f8925\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockSearchPicker.js\":\"7fc256bc2332fba2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ConfirmBulkDeleteDialog.js\":\"4b2e649d40e72b44\",\"/knowledge-medium/pr-preview/pr-1787/src/components/DividerHandle.js\":\"6afbc8d2bd834367\",\"/knowledge-medium/pr-preview/pr-1787/src/components/DraftEditor.js\":\"38b81147c541d89f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/GutterPill.js\":\"d0a7f572d26c098b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/Header.js\":\"d95b60241f983cf1\",\"/knowledge-medium/pr-preview/pr-1787/src/components/LazyBlockComponent.js\":\"4caa05939d1d3208\",\"/knowledge-medium/pr-preview/pr-1787/src/components/Login.js\":\"59e42552f7094b65\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ZoomableSurface.js\":\"598dffb6db75bfa9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/editModeKeepalive.js\":\"19c90c38dc985017\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6784b5f3af40cce2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3b6d944b3bdf8831\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/RefPropertyEditor.js\":\"413fca60b193cb36\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/RefTargetTypePicker.js\":\"d4a81a277d5935f8\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/SelectPropertyEditor.js\":\"6c81fafa7f02d298\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/TypesPropertyEditor.js\":\"a5b97a01b9074adc\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/defaults.js\":\"e53811200e04af39\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/kernelValuePresets.js\":\"c45b07ea455f99c9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/selectablePresets.js\":\"994c53c7a8bfe8d7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/typesPropertyUi.js\":\"79b1963fc42a9dc7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/AddPropertyForm.js\":\"07de8ca934cd8e05\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/PropertyPicker.js\":\"ce1dc5453fa65b54\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/PropertyRow.js\":\"c541b02be2ae1f35\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/Rows.js\":\"6620ab950352fc78\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/actions.js\":\"4edc774566fecbb2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/declarationOnly.js\":\"3838ce1e30513644\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/layout.js\":\"3955a238ac166e94\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/model.js\":\"f0a9050b186f7747\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/shapeUi.js\":\"d86227c4b158193a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/shapes.js\":\"2820e9ce252565ba\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/usePropertyEditingActivation.js\":\"35aab425f866a89b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/visibility.js\":\"33c76ab2874a6661\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanelSections.js\":\"76850590e57692bd\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockEmbed.js\":\"2d037bdcb643c278\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockLink.js\":\"231134c32821df92\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockRef.js\":\"75a73613aaee5402\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/ReferenceLink.js\":\"341c3a5e4315b302\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/cycleGuard.js\":\"02024eb9d316d107\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/cycleGuardContext.js\":\"a7d867a2f1cd2e28\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/linkInteraction.js\":\"d3f2a4ab5deba15e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/referenceLayout.js\":\"429e40e5e40d0c25\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/useBlockRefAncestors.js\":\"d691cf8e060d6610\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockGutter.js\":\"16afab4e37a9cc78\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockInfoDialog.js\":\"f95326e5535a0262\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockTypeBlockRenderer.js\":\"e11dc97beb24971c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BulletHoverCard.js\":\"97b42213d6231a63\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/CodeMirrorContentRenderer.js\":\"deb1a48d26c213fc\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"63bf24548c5da82e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/ColumnResizeHandles.js\":\"61f583af423c715d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e010761f1e121b64\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/DefaultBlockRenderer.js\":\"4dea2c7108f10de3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/LayoutRenderer.js\":\"03092fe22c7deb27\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/MarkdownContentRenderer.js\":\"8e7bb521da47c03f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/MissingDataRenderer.js\":\"77cf9a8ba267046d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/PanelRenderer.js\":\"04af92de3481df3b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/PropertySchemaBlockRenderer.js\":\"af0fbc2faa538eb4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/TopLevelRenderer.js\":\"a9682e1e2c9124b5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/blockGutterMode.js\":\"eb4d87afd79c50f1\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/blockTitleText.js\":\"e64063ed9d81f31f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/fieldCreationKeydown.js\":\"bb771780c1dc1a0b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/layoutRootContext.js\":\"1d49af985554964a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/typeChip/TypeChip.js\":\"750ab1c650fab1fc\",\"/knowledge-medium/pr-preview/pr-1787/src/components/typeChip/chipStyle.js\":\"1918b81e6802f5f3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/anchored-floating.js\":\"a4aaa35b43fcbd4f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/button.js\":\"e69f4e65c392eef9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/card.js\":\"580c9bbd90ffdd24\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/checkbox.js\":\"2de6b75a887e453e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/collapsible.js\":\"b90a03b8d978ee90\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/command.js\":\"42585bd1958622a7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/context-menu.js\":\"e303f2c9308fb45f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/dialog.js\":\"87641ec84f1b6db9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/dropdown-menu.js\":\"9ea40e17ff1ba750\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/floating-listbox.js\":\"94f68fc9397eed99\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/index.js\":\"80084f3fb6484721\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/input.js\":\"751e845f40e03ec3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/kbd.js\":\"526b406f41569774\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/label.js\":\"4ef8e6b8baa3e3bf\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/textarea.js\":\"c8b751db3577f9bf\",\"/knowledge-medium/pr-preview/pr-1787/src/components/useEditModeYieldKeepalive.js\":\"4d68a5864f33d767\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/BootFallback.js\":\"93e24b15f090e2c9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/FocusedRowLazyMount.js\":\"4a7020e92d874b11\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/LazyViewportMount.js\":\"af89d0f380fe4444\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/LocalDbCorruptionFallback.js\":\"c09154dd56fad961\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/error.js\":\"1195d6c778f94789\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/lazyMountRegistry.js\":\"2f767372122cb00f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/suspense.js\":\"6d07d4503a3c4c3d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/CreateWorkspaceDialog.js\":\"e102ebe6a29a4595\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/PendingInvitations.js\":\"f9523552633eaa64\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/SyncProgress.js\":\"071cdb96ab089dea\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/UnlockProgress.js\":\"15548369765c5779\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceKeyGate.js\":\"176e13191b75aa7a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSettingsDialog.js\":\"d9d3f6f787d234ae\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSwitcher.js\":\"9a0f0977ea3fef49\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSyncGate.js\":\"07a8817dfb75f222\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/ConversionFlow.js\":\"2e5c2bbbfac09392\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/ConversionFlowHost.js\":\"ea5b8cbd88f72f84\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/EncryptionSection.js\":\"2824643a3b178a40\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/attachmentPrompts.js\":\"4408a4decb1702ae\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c809f09c2a799df2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/conversionFlowDeps.js\":\"ab4d44244f44ecb6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/conversionFlowStore.js\":\"c7edffb437d5a5c1\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/flowUi.js\":\"604485896bb34deb\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/useConversionRun.js\":\"eb1d260e97131b9b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/keyUi.js\":\"de169ccf61660add\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/useCloseOnKeyLoss.js\":\"b3176f046fe4fec4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/useCloseOnServerE2ee.js\":\"7ea212961ed9f3c5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/workspaceUnlocked.js\":\"54e6def02e2c4e8a\",\"/knowledge-medium/pr-preview/pr-1787/src/context/backgroundSubtree.js\":\"b5d2a12e7567478c\",\"/knowledge-medium/pr-preview/pr-1787/src/context/block.js\":\"40052cc34fca049b\",\"/knowledge-medium/pr-preview/pr-1787/src/context/layoutWsContext.js\":\"241888de375aa4f5\",\"/knowledge-medium/pr-preview/pr-1787/src/context/propertyDisplay.js\":\"f3164c3b346c3856\",\"/knowledge-medium/pr-preview/pr-1787/src/context/repo.js\":\"c8475bd40bb13e31\",\"/knowledge-medium/pr-preview/pr-1787/src/data/aliasClaim.js\":\"7e10291a99509cad\",\"/knowledge-medium/pr-preview/pr-1787/src/data/aliasSeatNamespace.js\":\"f54a6afd1321ac45\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/blockData.js\":\"095bfc93e184435d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/blockType.js\":\"5bc7a7bfd1a5f83a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/changeScope.js\":\"f9beb407e08c5756\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/codecs.js\":\"9132c35cc8b1b53c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/derivedData.js\":\"83db3661e6119a4a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/errors.js\":\"547d8a5296b8dae5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/events.js\":\"4f7b97432566f9da\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/handle.js\":\"6610460c75d34725\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/index.js\":\"2d1549b8b7e694ce\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/mutator.js\":\"db6a27ed7a0f8cc5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/processor.js\":\"59ad29132a675522\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/propertySchema.js\":\"6901675349608c6d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/query.js\":\"19dfdf645f5003fd\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/sameTxProcessor.js\":\"f2e9fe537f79c96f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/schema.js\":\"6610460c75d34725\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/tx.js\":\"6610460c75d34725\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/typedBlockQuery.js\":\"5566f3db62ee4d13\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/user.js\":\"c839745905ad7f42\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/valuePresetCore.js\":\"9d4a6a0dd8657f05\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/valuePresets.js\":\"0a1ec1399c72b037\",\"/knowledge-medium/pr-preview/pr-1787/src/data/attachmentCleanerIOVerb.js\":\"1c8fa4a734d7529f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/block.js\":\"c5db9edacc0b29c8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockCache.js\":\"afebc815af1f6c41\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockId.js\":\"5ab0da7e71de4c64\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockLiveness.js\":\"a6542aa93e3e6ee9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockMerge.js\":\"7f75e9ced44c6136\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockSchema.js\":\"3f385100f3fadec0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockTypes.js\":\"9c841a46b129c368\",\"/knowledge-medium/pr-preview/pr-1787/src/data/clientContext.js\":\"0eac2e93dafb95eb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/dbFileSiblings.js\":\"29dd10f92746d814\",\"/knowledge-medium/pr-preview/pr-1787/src/data/definitionSeeds.js\":\"3304b8a30284dad0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/derivedIds.js\":\"d85a5fe75dd370c2\",\"/knowledge-medium/pr-preview/pr-1787/src/data/drawnSubtree.js\":\"0eca50a0d9e9ee9c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/facetBridge.js\":\"706b1df245eead9b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/facets.js\":\"74a96b18989041be\",\"/knowledge-medium/pr-preview/pr-1787/src/data/globalState.js\":\"4437a1346910f8be\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/aliasClaimRederiveProcessor.js\":\"f9b0248df0fc24fa\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/ancestorBatch.js\":\"dcdbf0e46ea119ee\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/blockTypeTypeifyProcessor.js\":\"c86cd354c1ede983\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/clientSchema.js\":\"4cff7a0ae817c9d5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/commitPipeline.js\":\"a9a0912686c706fc\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/devAssertions.js\":\"6f60de131744edc0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/firstSync.js\":\"abba09619582a68e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/freshInitialLoad.js\":\"f00f7c29fa213c18\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/graphBackfillClaim.js\":\"aebb0e7f045c526d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/handleStore.js\":\"8460b1ea99040810\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/idleMarkerJobs.js\":\"b0a8f07f717ff7a9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/initialDownload.js\":\"564abee6c15a1420\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/initializeClientDatabase.js\":\"401848920491c6a9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/jsonCanonical.js\":\"8f321605ec51c4a7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelInvalidation.js\":\"e2a9d257be830b54\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelProcessors.js\":\"f4d6b5259a81a9aa\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelQueries.js\":\"92e4647e9c35fab3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/mergeTypeMembershipProcessor.js\":\"6dbd717bbc1ac0fd\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/normalizeReferencesProcessor.js\":\"46719de517948590\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/poolInstrumentation.js\":\"f4a536f28295176f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/processorRunner.js\":\"e26419a3ed0db394\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyCellBackfill.js\":\"7d8036e7eb490fe3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyChildMint.js\":\"b6a6d60959c65880\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyChildrenProcessor.js\":\"005f063613625d0d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyDefinitionChangeProcessor.js\":\"df0ef6679fd82a8c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyDefinitionSynthesis.js\":\"ebab5c4c941371fe\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyKeyScan.js\":\"beab2d2b73b2961f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertySchemaResolution.js\":\"e2382f5ebddc2c11\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/raiseProtocol.js\":\"34c758989aa38c8e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/readBatch.js\":\"b84af0050996ce25\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/refProjection.js\":\"82d4ba2366f610c0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/referenceTargetLookups.js\":\"412d4a1de1c30c59\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/referenceTargetProcessor.js\":\"f072046ce1c48709\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/replayMerge.js\":\"9bd7de9e7dd8a0f5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/sqlBinds.js\":\"da6fb0f255988570\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a12804a0c32fcfea\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/arrivalProcessors.js\":\"8a076e235e8fa2b8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/invalidate.js\":\"cce66a9abae47299\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/materialize.js\":\"0f2f2f7a5af8f049\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/observer.js\":\"a719d16cf61a2f69\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/reconcile.js\":\"78ca691735cd9978\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/timingMetrics.js\":\"744126b7ccebcb8f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/treeQueries.js\":\"ad31daa8e4a5f1eb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/txEngine.js\":\"31177a58e871f206\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/txSnapshots.js\":\"5824dc491d9ed9fc\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/typedBlockQuery.js\":\"ef3202c75336de7f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/undoManager.js\":\"b6e5edb0695434b1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/invalidation.js\":\"6ee2d75e86a566a1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelDataExtension.js\":\"942e5476e01d2bcf\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelPage.js\":\"d73ff494211066eb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelValuePresetCores.js\":\"907b04c14be98a1b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbCorruptionSignal.js\":\"f473fbcde51ff85c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbStorage.js\":\"64ad4e6ac1f9b700\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbVfs.js\":\"e025eb399252105b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localSchema.js\":\"2306edb2730622e2\",\"/knowledge-medium/pr-preview/pr-1787/src/data/maintenance.js\":\"23e59bcb008e1ede\",\"/knowledge-medium/pr-preview/pr-1787/src/data/mergeProperties.js\":\"5d6a69a627e494ab\",\"/knowledge-medium/pr-preview/pr-1787/src/data/metricsConsoleHook.js\":\"e06450c3ce6a0328\",\"/knowledge-medium/pr-preview/pr-1787/src/data/migrationsPage.js\":\"d7cf0d6a8db325c2\",\"/knowledge-medium/pr-preview/pr-1787/src/data/mutators.js\":\"ae13cbcc2e36ef0a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/orderKey.js\":\"6530eb40bbd60676\",\"/knowledge-medium/pr-preview/pr-1787/src/data/orderKeyPlacement.js\":\"eb55976158617fe7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/outlineSurface.js\":\"a3ad1808bf6dac88\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pendingEditorContent.js\":\"89c5556478bcae35\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pendingUploadsSql.js\":\"4e203f89b6034768\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pluginStateExtensions.js\":\"e7b6e2c7f47162d0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/powerSyncLogger.js\":\"f3cc701b1d0c0a70\",\"/knowledge-medium/pr-preview/pr-1787/src/data/projectorRuntime.js\":\"c8f2dfd87d9e2893\",\"/knowledge-medium/pr-preview/pr-1787/src/data/properties.js\":\"e162c3d9fb1886df\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertiesPage.js\":\"0f14cb17fe9f882d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyChildren.js\":\"c168891e2aa6d349\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionFanout.js\":\"2da9980a8d9ef086\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionMetadata.js\":\"4406f52bf8af96aa\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionRegistry.js\":\"e033f7d14b815c98\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDisplayMode.js\":\"53c423e334409e1f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyRowCreation.js\":\"90bd8d504c07d6aa\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertySchemaCreation.js\":\"9aeb9a926400f26c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertySeeds.js\":\"bf2829b9367f5e29\",\"/knowledge-medium/pr-preview/pr-1787/src/data/recentsPage.js\":\"0a55a92b819f8758\",\"/knowledge-medium/pr-preview/pr-1787/src/data/referenceBlock.js\":\"c59ab763063ca23f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/releasePowerSyncConnection.js\":\"7052ecafe1cdfa80\",\"/knowledge-medium/pr-preview/pr-1787/src/data/repo.js\":\"ffd0efe7378179db\",\"/knowledge-medium/pr-preview/pr-1787/src/data/repoProvider.js\":\"27b225258d7461fb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/rowProperty.js\":\"cd8d4d588b4979e0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/searchFilter.js\":\"d74ab8dc49d01a1d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/seedIdentityLedger.js\":\"75f50c500300b6ff\",\"/knowledge-medium/pr-preview/pr-1787/src/data/stateBlocks.js\":\"b8c34b78f60c8e7f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/structuralEditPolicy.js\":\"1549f592b02520ef\",\"/knowledge-medium/pr-preview/pr-1787/src/data/subtreeDelete.js\":\"421f0d09f122f2d0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncStreamLock.js\":\"5fcdf5d1d75022e7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncedTableSqlRecognizer.js\":\"c63a83f150379ea7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncedTableWriteGuard.js\":\"0098b61cfd45390c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/targets.js\":\"17986de32b8c96a9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeColors.js\":\"8fb5a5c51fbaa4bc\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeDefinitionMetadata.js\":\"85a8f2727537cf84\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeDefinitionRegistry.js\":\"a877a4d571cc1789\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeExtraction.js\":\"6976ff956707abd4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeInitialValues.js\":\"3ef825f4f64af56f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typePropertyGroups.js\":\"81ebea636e59387a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeSeeds.js\":\"ad833faee983a7c7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeTagger.js\":\"98082ac11bc5378e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typedRecords.js\":\"795ea996b48a3971\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typesPage.js\":\"e44c3c25b53f2754\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userPrefs.js\":\"0cfbba1299ec6b15\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userSchemasService.js\":\"c0e5544c64060401\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userTypesService.js\":\"1b54d1cb2a257e8c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/valuePresetRegistry.js\":\"daaafe7948f526bb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/visibleChildren.js\":\"e81bd092f9885d9f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceConversion.js\":\"9e800c5d3d507a33\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceFirstSync.js\":\"370c1d0987a4922d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceIdNamespace.js\":\"45fe2be4f7e5af6d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceSchema.js\":\"ba457dff9e56f27e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaces.js\":\"434f47fc3ffdb293\",\"/knowledge-medium/pr-preview/pr-1787/src/data/writeAheadLog.js\":\"70c78c69e277a2c3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/BlockPasteShellDecorator.js\":\"f4ecf38fb3ae93d9\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/atTrigger.js\":\"2f64a72fcbd6adae\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/autocomplete.js\":\"68069c79d3ca48ab\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/codeMirrorExtensions.js\":\"4be4d76619972b1e\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/contentFlush.js\":\"d71588de8242d5bc\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/defaultInteractions.js\":\"5970e12c6cf82cea\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/editSettleSignal.js\":\"f7ad1b51ad4fb6e8\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/insertImage.js\":\"af64f5951fcbdbab\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/referenceCompletionRange.js\":\"b88fc41dddbfaff2\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/referenceTargetTypes.js\":\"db21fbfa53dab991\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/syntaxContext.js\":\"bbde10836dda0c7a\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/triggerMatch.js\":\"0c2d10ea98203302\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/AppRuntimeProvider.js\":\"51a27fbad5451d3d\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/BlockFocusShellDecorator.js\":\"056b2ab1af896ccc\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/ExtensionRenderBoundary.js\":\"4041d68bebc16654\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/PanelContentRecovery.js\":\"b22384fb8f9e87fb\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/apiCatalog.js\":\"dfad4691f029c498\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/approveExtensionHere.js\":\"9aacf93df53b910c\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/armedCutAppMount.js\":\"710176501680ac96\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/batchableKeyedStore.js\":\"7cc45403e491ff6c\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/blockInteraction.js\":\"3f290d51c681519e\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/blockSelectionAction.js\":\"095f8720d5706746\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/compileExtensionModule.js\":\"05d2aaccbf773299\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/compiledModuleCache.js\":\"f593e3157ed9fbd8\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/continuousGestures.js\":\"4b75e41fcf8a4288\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/core.js\":\"a5792ca18af48ca8\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/defaultRenderers.js\":\"94ef928d7a622355\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/definitionFanoutAppMount.js\":\"997a8b473da641dd\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dialogAppMount.js\":\"da161c05c6163b2f\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dynamicExtensionSeeds.js\":\"c28f813350fba504\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dynamicExtensions.js\":\"7800c7ecd1492438\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/exampleExtensions.js\":\"502140a8f3bba51f\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionApprovalStatus.js\":\"442a1a1806d39773\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLoadErrorToast.js\":\"3313bdc817071f56\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLoadErrors.js\":\"366ce33c28cfa2a4\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLookup.js\":\"f085db921afaa907\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionToggles.js\":\"09e5304231e47fcb\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionUtilitiesCss.js\":\"3c7886ef9d490b2b\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/kernelPageDeletionGuard.js\":\"93d83d57f846f36b\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/liveRuntime.js\":\"b67fb0ddde9cd7ec\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/openExtensionsSettings.js\":\"4b20f694f551efb4\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/overridesCache.js\":\"dfe4a5eb512143ee\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/pluginIds.js\":\"421315d9e6bb04b2\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/processorRejectionToast.js\":\"8603adc8cbb40025\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/runtimeActions.js\":\"d361fbe5bc7841f2\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/runtimeContext.js\":\"2805a7542cf77cbd\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/staticAppExtensions.js\":\"bd731442d4218670\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/staticDataExtensions.js\":\"96344364085ea123\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/toastAppMount.js\":\"10915ad16d175e64\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/useOverrides.js\":\"a6169188bef47b1b\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/useShortcutSurfaceActivations.js\":\"d34fb8a02262d41c\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/discoverToggleTree.js\":\"59c6938d41df8f7b\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/facet.js\":\"2fd3de10ec28235c\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/resolveAppRuntime.js\":\"dcc98f1ae8ad3201\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/runtimeEvents.js\":\"f55d8769a6566311\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/togglable.js\":\"79d093c09ee02701\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/variantFacet.js\":\"d3f881514e65a7c2\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/verbFacet.js\":\"e09c946da23e5dcb\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/block.js\":\"4580e0db254cacf1\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/focusedChild.js\":\"0dd74b1d594415ba\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/propertySchemas.js\":\"878f5e9e512c9432\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/typeRegistry.js\":\"f2029fb39fb697ca\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useAncestorCrumbs.js\":\"373de5a860cffc73\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useAutocompleteListbox.js\":\"2f67788f41ad79a4\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useDebouncedSearch.js\":\"bd0fbe1982742e89\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useDebouncedValue.js\":\"e29c50c8667c637b\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useIsFocalRender.js\":\"431e2360da460f08\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useIsReadOnly.js\":\"bf4d0630728b4a6e\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useMaterializeBacklog.js\":\"88bc70bac171e815\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useMinuteClock.js\":\"caa0f7cb23489241\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/usePanelLayoutProjection.js\":\"645a29ac3f93f952\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/usePendingInvitations.js\":\"a2919b6edfc057c8\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useRendererRegistry.js\":\"bbb6c9ef2c38406e\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useRetainedFieldRows.js\":\"bf31d17bac5f7afa\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useWorkspaces.js\":\"4fa9896f60ea3d3e\",\"/knowledge-medium/pr-preview/pr-1787/src/lib/utils.js\":\"5d01e166b07bb364\",\"/knowledge-medium/pr-preview/pr-1787/src/main.js\":\"f4beb3af7abf2088\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/MarkdownImage.js\":\"fc1b01f17d938cf3\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/blockSeparators.js\":\"e055ea64561755de\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/context.js\":\"eab2666653baf3fa\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/defaultMarkdownExtension.js\":\"2cfd9a4068bf0970\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/extensions.js\":\"af5d541ca1672adc\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/renderMarkdownHtml.js\":\"63601ccc38fb5843\",\"/knowledge-medium/pr-preview/pr-1787/src/minimal-editor.js\":\"7d850c24b7affba5\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/armedCut.js\":\"aae823f070e55c10\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/captureMediaVerb.js\":\"cea212e566e71638\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/clipboard.js\":\"f57e2c69ad9fb968\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/decision.js\":\"6bf0f8f624d6b94e\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/operations.js\":\"8837326a733bf9e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/account-header/AccountHeaderItem.js\":\"67880a2cf059ff83\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/account-header/index.js\":\"5a75b73970d581c6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2305276c44b77da4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/askAgent.js\":\"dbb958c0c733ee2a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/askedStore.js\":\"b5b9bd553c1ea483\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fa83f95ae0ffdf93\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/chipState.js\":\"ffc6c307a273e38e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/dataExtension.js\":\"84cf2538c5214059\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/index.js\":\"ee610bda34682b3d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a9c8c3f7cd851ed7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/schema.js\":\"94d096b4c9e8b8f2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a7e29c5822e32c99\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f4a6acf3f1e3aace\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/addMedia.js\":\"2aee1dc90b37e615\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0334ba77eb684548\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/block.js\":\"5ee010817d75fcaa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/context.js\":\"1ed426c78a3fe715\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/displayIds.js\":\"423ac3c723ffc8bc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/index.js\":\"6f42a698bd54693a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/outline.js\":\"7913927ec76f9850\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/properties.js\":\"bd96330bf99595bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/refs.js\":\"54943ddb81db6ab1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8b83618379b7d418\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/search.js\":\"ba805fdfe9903bfa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/shared.js\":\"f1ca01ee4da0bbda\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"99c7b86ba713ae3f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/text.js\":\"1cf37a17ad3bb87f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentWrites.js\":\"45e8ff401961a3e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/authoringCatalog.js\":\"6b79256358dbb39a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/blockRefTargets.js\":\"d3dba935d1b9683a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/bridge.js\":\"5e7ae39d8018d56a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/bridgeLoop.js\":\"974da64ccbbca1b0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/changeHistory.js\":\"7c615f307c877d2f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/commands.js\":\"5ed99d432cd3eb2f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/commentsCommands.js\":\"380a10c6cc7b5289\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/dataExtension.js\":\"4bd9d18454bca728\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/dataModelGuide.js\":\"b07a14168d0afe76\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/describeRuntime.js\":\"f59ccb1f108a5fa2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/extensionLint.js\":\"7b76f100e74f3217\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/grainAudit.js\":\"dd3ccb5c0b8d27d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/healthCommand.js\":\"dee58a100d091db6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/index.js\":\"fb2657841c01fb83\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/presetIdentity.js\":\"6f9580b3cc7fe2f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"19addfba67dbc44f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/readMedia.js\":\"54fa42f7e69ff32f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/schema.js\":\"719afd094c5f4bca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/serialization.js\":\"39ca949f06ac9a3c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/targets.js\":\"56f3462251ca8485\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/tokens.js\":\"8619ae65c3658585\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/watchEvents.js\":\"b16f41689f461fe2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/workspaceGuard.js\":\"c023497d506ec4ff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/writeCommands.js\":\"9f8930b2a75de8f3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/AliasCollisionToast.js\":\"980a29ff0495237c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/DuplicateNameBanner.js\":\"c83939764723d3ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/collisionMerge.js\":\"0e98a27f404aa896\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/dataExtension.js\":\"061bb2165b6f51e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/index.js\":\"478bae641a5d6e00\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/mergeCollisionAction.js\":\"66dc81d22d535117\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/pageStyling.js\":\"9c015823c814009a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/rejectionToast.js\":\"789ec894c6d02c52\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/syncProcessor.js\":\"c7350ab4010326ba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/actions.js\":\"d5e566e90168e91c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/addComment.js\":\"9315310ece769c83\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/anchor.js\":\"ff5fecfa622104a6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/anchorState.js\":\"3074b70b9fd03bb1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/commentLinks.js\":\"0e28197056138be8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/confirmThreadDeletion.js\":\"ac39d36bc2c3d731\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/container.js\":\"c34a1c850aae58ff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/dataExtension.js\":\"1fae0d506ed65722\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/deleteComment.js\":\"5e66aff855d1f24b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/highlights.js\":\"cb2a2538a9ff4681\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/index.js\":\"4da071488fe8b803\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/linkedCommentsPill.js\":\"6f9eb495ef9f4521\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/margin.js\":\"54abed970cf544ae\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/marginSchema.js\":\"238045f07efb2e12\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/newComment.js\":\"228b25deb1b87d50\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/ownThreadPicker.js\":\"ce1f7648bede4461\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/placement.js\":\"d406b69daf321291\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/queries.js\":\"685c1545419ad326\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotePosition.js\":\"5d3eee57fb35d289\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotedIn.js\":\"de2e80f0d8190a2d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotedRange.js\":\"68b119d16a10c4d0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/rangeRefs.js\":\"811117ec129348bc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readHighlights.js\":\"d7cce1bed62753b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readSelection.js\":\"5f31e3202c704a27\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readSelectionUi.js\":\"86fe5e313b27a60a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/reanchor.js\":\"6fc719225f067fe5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/schema.js\":\"2b755020dad16d00\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/scope.js\":\"179429fab2b5ed42\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/scopeThreads.js\":\"4a6f0640d139484d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/splitRetarget.js\":\"1ca9c22597480784\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/suggestionCard.js\":\"ec02af5f299f6cea\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/suggestions.js\":\"89e0e4590396572e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/summaries.js\":\"b7ed86a20e38f536\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/summaryBatch.js\":\"e19433421e28a2b6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/surface.js\":\"ee4abe68c6f7afcc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/threadNavigation.js\":\"efa7cabb2679f887\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/threads.js\":\"daa0f9263ef40b3e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/ui.js\":\"3c78eebf890eeff2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/uiStore.js\":\"3426c9f360959c8c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-intents/appIntents.js\":\"08db895262960dd3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-intents/index.js\":\"a2892c0a2288fefd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-update-prompt/index.js\":\"1979ac8558ac077a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-update-prompt/status.js\":\"14a5a8fe7730004f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0ee41f4bd9a5ec5a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaBlockRenderer.js\":\"9aa8ec9b752b8f84\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9b5a93f49229036e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaUploadReconciler.js\":\"400d8aba82c4d29c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetDownLane.js\":\"baf291347bc98f15\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetResolver.js\":\"f3e2f8590ffc7e7e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetUpload.js\":\"3143ca25a05c7275\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/attachmentCleanerIO.js\":\"a47405b39da7832a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6d30a863dc95b10e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/blobStore.js\":\"95936813552895af\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/byteStore.js\":\"dae3a5a3d08781f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/cleanerIO.js\":\"6302cee82967f610\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/cleanupAttachments.js\":\"86f37d0cb552c2b0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/dataExtension.js\":\"ce71190d93ccab38\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/downLane.js\":\"9da1f41cc5194e11\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/index.js\":\"8fe1fa498ae057aa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/insertImageContribution.js\":\"393cac84c1d2f703\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/laneArming.js\":\"b4cda9e1581d6f4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/laneLock.js\":\"ae8691e61dd2c021\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaBlock.js\":\"0de67047df5ab9da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaCapture.js\":\"9ab49fb065cb4320\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaViewers.js\":\"f770131f3ad45897\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaViewersFacet.js\":\"40c169878364d7d0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/pasteCapture.js\":\"f9492d7bc77928ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/resolver.js\":\"176c3b13430122a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/retryUploadsAction.js\":\"1c3909ad197d46a2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/storagePaths.js\":\"6eccdf80938365f9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadDrain.js\":\"9384dc5540a1dd49\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadLaneStatus.js\":\"6505f96b59da6d00\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadReconcile.js\":\"6a3858d86bca348c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadRecovery.js\":\"cbd689c0f0c91fca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadStore.js\":\"47e22b7b1a3eb76b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/useAssetObjectUrl.js\":\"30f7842fb00f11d2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e6dadd0a3c1ec488\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2b64b86cae3c4e80\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/facet.js\":\"decbca1d12eff19f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/index.js\":\"82d5ed54c258b203\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/prop.js\":\"a542ca8120c2fee3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BacklinkFilters.js\":\"98453e5c3e5bae8e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bfbed5f03bd2d494\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BlockEntry.js\":\"16421cc31ae92ab9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/LinkedReferences.js\":\"49ba5b62c6481b9c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"68c223f71cc85275\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/dailyNoteDefaults.js\":\"afe2732544aa449d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/dataExtension.js\":\"8f8bedb712b31625\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/edgeExclusions.js\":\"2c4f9aa6cf5dc36c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/filterProperty.js\":\"989c84a71337ff31\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/index.js\":\"2fb1452b4425e6bd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f2a40fa23b143ccd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/applies.js\":\"ac9f99287bf363ac\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/countQuery.js\":\"e5fae62ef6f76035\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/expansionStore.js\":\"756c18e2ea617bc7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/index.js\":\"840d2aa33dc86f3d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d2caf0b7e01666d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/presentationInvalidation.js\":\"65b0d0551790c4d1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/propertyEditorOverride.js\":\"02f4d2ebc8784dc9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/propertyFilter.js\":\"5a5dbbf596451d37\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/query.js\":\"9305d2e4b6da12b3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/resolveFilter.js\":\"92788ae2b53d877c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/sourceBatch.js\":\"a55f6693654444b3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/sources.js\":\"f69508fa4e5086c0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/useBacklinks.js\":\"368fdd75e9db8b01\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1a169f63f35fd225\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/BirthdayCelebration.js\":\"007ab0f3138a0b59\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/BirthdayOverlay.js\":\"d84fee0246d5bcc4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/gate.js\":\"63687844e1896c48\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/index.js\":\"c5445be6e4bd3b8a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/wolfTheme.js\":\"4ea9322a9492d778\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/BlockDragLayer.js\":\"c1aa9777656ef8bb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/dragController.js\":\"19dcab72c6f651db\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/dropTarget.js\":\"a32e33e55d19edb1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/index.js\":\"6d8beec85a2278d1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/projection.js\":\"195fc4959978ea9b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-info/BlockMetaCard.js\":\"b9e3a8adabca3b7c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-info/index.js\":\"71b1b98f5e03618f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/AddTagDialog.js\":\"30be3dcddc38e3da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8e297b3547268fee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/TagNameIssueHint.js\":\"e185dcdf04746534\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/addTagAction.js\":\"3b432b905e658a51\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/appendTag.js\":\"ac239c41fcb7a671\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/config.js\":\"5903cc9b69f0fda1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/dataExtension.js\":\"c7356753dfc1c65e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/index.js\":\"74e61b997835f487\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/propertyEditorOverride.js\":\"bec9e475dd49ada8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/BreadcrumbList.js\":\"748b03e5bda734a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"66f9f88a249e00ad\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8330b47f126bd83f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3248ed4fb2e4fdb8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a7308b4f4def2d82\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/index.js\":\"7428e787dfeabf99\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"19c3ebab750e6c90\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/CharacterCountItem.js\":\"151d4c87c84bbe7a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4214834a54799ce7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/actions.js\":\"d0cd566c3dd175de\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/blockType.js\":\"f5213b63752c25b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/charCount.js\":\"7bf4fcf73c43555c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/dataExtension.js\":\"2717a8e4192bd6fe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/index.js\":\"ddd656669dd0d189\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/profiles.js\":\"70d001f31b340a10\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/properties.js\":\"662a731a665853ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/textCounts.js\":\"7a8963a1aa01574e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/colemak-keybindings/index.js\":\"177d2bf418b23e6e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/CommandPalette.js\":\"60655ce38878b085\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/HeaderItem.js\":\"f547437396f6cca1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/context.js\":\"32f1674ab84fb39b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/index.js\":\"343b11cd1c2cfb46\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/selection.js\":\"5d68fd216534129e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/toggleStore.js\":\"4451cea68b14580a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/useCommandPaletteActions.js\":\"89d860290eff7ecd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/ContributorBadges.js\":\"4177f5fdcafb3535\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/author.js\":\"2e05be8425ab591f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/codeMirrorExtensions.js\":\"67bc63ee7ad255f0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/dataExtension.js\":\"34d7503ab9aefb3b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/index.js\":\"5dd3fd7ca46a6247\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/mentionAutocomplete.js\":\"73494f58f7c4a529\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/processor.js\":\"6110908007b28d41\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/profiles.js\":\"33de1b771a0dc5c6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/queries.js\":\"f3ed3a3d0eabde46\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/schema.js\":\"0c899fab620d0336\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9c86acab45acbc9c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/followOrigin.js\":\"75a243647c327a0b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/index.js\":\"fa2f148a4f592de2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"07eb9924b3958590\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"20b4e2628847697d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/CalendarGrid.js\":\"61c7579d6d58c8ce\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DailyNotePicker.js\":\"c5019a503bec7ebf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9ccae5311130ed3a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateNavDecorator.js\":\"5871219cea22944a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateScrubOverlay.js\":\"6a054d92c3b3e92d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/HeaderItem.js\":\"096a9d0b64a91205\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/ReschedulePicker.js\":\"3afac310880f934b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5e1624f0ae3846a2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/actions.js\":\"1e6cdd06e30a1736\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/blockDateAdapter.js\":\"2a7b91bf52380d79\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/calendar.js\":\"fb8af3b2919a4f6b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dailyNotes.js\":\"57ec6309ef6cf459\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dataExtension.js\":\"bbe90724e6506be9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubActions.js\":\"01c0ae4291d94f76\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubGesture.js\":\"b79655b594e42bdb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5c2ec04ec0bc0bba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b6cb4d12a7ae0699\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/deletionGuard.js\":\"aba3c665583c392a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dueQuery.js\":\"cba0c6961d7376be\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/index.js\":\"84ea6e4961f73fb6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/landing.js\":\"059926eee2f6546b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/localSchema.js\":\"37377158453f0e69\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/referenceDateAdapter.js\":\"bc48a463ea53745b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/rescheduleAction.js\":\"5b4822318bf89fbc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/schema.js\":\"9f2bbfa88e580668\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/spreadBlockDates.js\":\"d836a341209848f1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/spreadDatesAction.js\":\"1d5fa58f7dee0d64\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/today.js\":\"c21b7ba975bd519e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bfbe16e3690699fc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6b521c68e7eef1e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/audit.js\":\"79bd615cda6fe860\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/auditAction.js\":\"9549ba9dc0c4c444\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/auditRanges.js\":\"25fee43ceed7a200\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/diagnosticsSource.js\":\"05782fa4cb4532ee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/divergenceScan.js\":\"2db427e38d2f6968\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/index.js\":\"e5f961afb4c35069\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d407999f0f179c69\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/referencesMirror.js\":\"675ab31a66dba8a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/rowJson.js\":\"0312401b0abce091\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/schedule.js\":\"41b85bfe934350a6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/store.js\":\"e2a1e76ed6fad8bd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/action.js\":\"bf8fc37d6999eb0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/index.js\":\"165ef13badba4196\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/plugin.js\":\"1db5e1ce84021cb5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8ecf67ade837a858\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/actions.js\":\"93203e24a0e5a321\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/changeMarker.js\":\"1a0637acde84551c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/diagnostics.js\":\"fd2b3423ab6b1291\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/fileSystemAccess.js\":\"2b3cb546edc4ed4b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/filenames.js\":\"03a2e2cf8fa79c3f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/index.js\":\"e3f2d9e29ef58ebe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/mirror.js\":\"24d922464af2f7dd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/runLock.js\":\"24d81cd7878e2951\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/runtimeHealth.js\":\"dfb5770d63a37f4d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/schedule.js\":\"db4d5240e3435125\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/store.js\":\"209c2df3c9cd2872\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/default-themes/index.js\":\"34c26939cc939268\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/default-themes/themes.js\":\"48111bdd9281d747\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/diagnostics/facet.js\":\"50eba6f8ce636c7e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/diagnostics/useDiagnostics.js\":\"4df0687cc107179c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/dismissals.js\":\"3eb32515840f7388\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/index.js\":\"bd1f10392206961d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/status.js\":\"8ef955e90bb3531e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/store.js\":\"7a0790f83f159db3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4f47f1ff2bca350b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5fad57308c22ed8d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/actions.js\":\"1e3903cad0dce9d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/config.js\":\"c88d76098ab40ccd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/dataExtension.js\":\"b2cf9c704396951d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/effect.js\":\"6b8d695496afc2d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/index.js\":\"a5a2daf2f009c76b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5bdbc6ddf55e848a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/useToggleTree.js\":\"92da7e06b0a4f7c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/ExtractTypeDialog.js\":\"b13941a250510662\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6a364f67b2af7882\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/PropertyShapePicker.js\":\"e112a2a56969742e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/action.js\":\"56fa61aebb6da0ba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/index.js\":\"b5ea37a6470b3a6c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/FindReplaceDialog.js\":\"3b30d903f98f5d4b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/HeaderItem.js\":\"202e9423b6038ad2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/dataExtension.js\":\"7c11e814ba4553ae\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/index.js\":\"0828c760a62877a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/search.js\":\"83f2c73b2398754a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/toggleStore.js\":\"1e07c11a0cd89d46\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/LocationPropertyEditor.js\":\"56663a0c66650c13\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/MapView.js\":\"192cfd72defc592a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/blockTypes.js\":\"ad1961badd02c0f0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/codeMirrorExtensions.js\":\"c5ca27a6e6795cbe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/createOrFindPlace.js\":\"f6691cac4bb98287\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/currentLocation.js\":\"6e2938755a0d2a7c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/dataExtension.js\":\"788cb8b2e77f75fa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/geoContentDecorator.js\":\"ac76684ac0966d46\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/googlePlacesClient.js\":\"622232a5065ec354\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/index.js\":\"db9760865052d3ec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/locationsPage.js\":\"3fd7396af15854e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/mapViewport.js\":\"027c5f8579e83d01\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/pickCurrentLocation.js\":\"d85603722b8d9817\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/placeAutocomplete.js\":\"af880c2b5ab78043\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/placeNameCollision.js\":\"157883cf6666287d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/properties.js\":\"29cf052af5e9f8c6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/propertyEditorOverrides.js\":\"59242a2c84eb25a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/query.js\":\"8f57c495fa0fabf5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/usePlaceSearch.js\":\"c0db6a67b34f9c81\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7154bf24b01e9812\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b9fcc27b4eb3f90b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1bc22e53c7c9bd36\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/config.js\":\"41b4edbe9a7e49b2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/dataExtension.js\":\"283b5956aa7022d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/facet.js\":\"5e0a19d560aa93a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/grouping.js\":\"776ca33602e86596\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/index.js\":\"6b2f6bd83bdf081b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"867d58fb91557e16\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/query.js\":\"7572430c74f96481\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/resolveConfig.js\":\"e559eb02cc656b5c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bb7347f702cd659e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8bab1e6bf76e0248\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/HtmlDocumentContent.js\":\"21e4512b185d1736\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/HtmlFrame.js\":\"8413099948621b7c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/actions.js\":\"fd4da1f40051ee0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/blockType.js\":\"3c37942ea861a5d7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/confirmRunScripts.js\":\"964f208f0e3e90ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/dataExtension.js\":\"58bc5b9cfcb8b29f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameAnnotations.js\":\"76a5272df01da00b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameDocument.js\":\"1a3398f28b381fbd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameTheme.js\":\"6aa7dbb09d218905\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/index.js\":\"53c44b910523def1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/scriptConsent.js\":\"ebc0882d5951e82c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/sourceMap.js\":\"9a430609de85903d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/useDocumentScripts.js\":\"cc7ae828b6a9eee6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/index.js\":\"5e2a5cd1165fc58a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/record.js\":\"f66d4fb406ffe775\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/recordStore.js\":\"d39eb6e84bff85f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/responsiveness.js\":\"2ad4c4f17f3b00a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/schedule.js\":\"1259fd2fd8cfa574\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/sessionContext.js\":\"8a5e40a6289349af\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7826f8267870c0c0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"269aaa3f334bbf67\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/actions.js\":\"9f225f775afd6cd7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/config.js\":\"09ca5556dbab0da7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/dataExtension.js\":\"abe47959e97db1d7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/effect.js\":\"a96dd77511e1b269\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/index.js\":\"24ecedb2790f6bd0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/keyCapture.js\":\"1f2a19af6187f2c6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/overrideStore.js\":\"3a71adaff833371b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"460cee1120b925fc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/HeaderItem.js\":\"ad637fa719323871\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/LeftSidebar.js\":\"8e2e14d8b483039c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/actions.js\":\"df0edd14b35d474d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/facet.js\":\"342719011474545c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/index.js\":\"6a7aef7fa04a5bd7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/shortcuts.js\":\"78918978b0731dec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/toggleStore.js\":\"92a06271fcf6bbd7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/MergePicker.js\":\"f9317213cea3f3b1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/index.js\":\"0da953eb8a48f97c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/mergeAction.js\":\"521886ef9de949bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/strategy.js\":\"63eaf56ef648a17a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/Button.js\":\"81a8e629f8396376\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"332c69d3917fe904\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2afa7564cb995ebe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/facet.js\":\"81b6980b157a74b3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/index.js\":\"ecfc972638bfe266\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5bd6dca4ee03ee18\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4e441a3d3a4e72dc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6c443a97f35e100b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/facet.js\":\"934670e9aa28824f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/index.js\":\"9e1f0478b5d58e4e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/MoveDestinationPicker.js\":\"88c94db98d672d0c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c03d42c221df72df\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/contextMenuItem.js\":\"f74e95dad358c536\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/index.js\":\"e1a37f83b7a3971d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/moveAction.js\":\"a3e95eb0cbdc8a6b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/moveBlocks.js\":\"c1366dfe0094784f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/selectionAfterMove.js\":\"68dc29a7a97f475b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/TutorialBanner.js\":\"3a676f7f823ad84b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/action.js\":\"585da0c4c92a2046\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/bannerDismissal.js\":\"df15a0f6ae543599\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/documents/cheatSheet.js\":\"dfb3a8f5fa7c46ed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/index.js\":\"5402a56e0d8bcbb9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/keys.js\":\"da32967c7d5330eb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/landing.js\":\"b6fbcf432dcfef24\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/outline.js\":\"438b84f21c5fb2e5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/seed.js\":\"744a52ec5d93af16\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f90a7691a814b773\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/analyze.js\":\"67fd94f985fa5cae\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/diagnosticsSource.js\":\"9509be91ff41f346\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/index.js\":\"f02b7af439b0114b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/load.js\":\"62e2bf5a6007032b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/monitorRun.js\":\"d56f16f15352d340\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/schedule.js\":\"feb543ee91d80e43\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/series.js\":\"e8f7d04716597d2c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/store.js\":\"03db4980fafedd68\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/trendAction.js\":\"3cb45d7a62885a5e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/verdict.js\":\"e5fde09998cdec98\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/clickToEditAction.js\":\"a3807f2745235376\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/index.js\":\"57bd98b02034eb0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/interactions.js\":\"d58cf876508a9516\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0c66fb11bff01b4a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/MigrationGate.js\":\"67659fdd2f46f877\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/MigrationGateDialog.js\":\"53c0884b90f3efbb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/action.js\":\"7c219ca6bbbed7fd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/index.js\":\"5d0f68141882d384\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/localRunMessage.js\":\"4f6678550352b4d8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/plugin.js\":\"e267ae80b305bc1a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/progressReport.js\":\"852da2c0814ba896\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/sweepProgress.js\":\"3b5acd67203d0c48\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/FieldRowRenderer.js\":\"33b113393e244346\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/ValueRowRenderer.js\":\"c0101a3d66b37d66\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/actions.js\":\"ebcb0069359dea5b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/autocomplete.js\":\"74d63420b62ba5e3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/fieldRow.js\":\"065ee4bfe29e25ee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/index.js\":\"abdb2391641910de\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/referenceWarning.js\":\"296d4559e1f25cb5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/valueAutocomplete.js\":\"aa9e324d52f5e9d2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/valueSchema.js\":\"d68f69feb853cfbe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/HeaderItem.js\":\"c0cc588a8a8d8c78\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/QuickFind.js\":\"06404bd8bfa22cca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/index.js\":\"f58013414dfd2c63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/recents.js\":\"8c7c3effa985ec8d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/resultItems.js\":\"126c4e19195e7fb3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/selection.js\":\"06fce99ab75c973e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/toggleStore.js\":\"29b324820f76bfb4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/HeaderItem.js\":\"5514ddb2f6c11060\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/RecentsPageBlockRenderer.js\":\"628a6104027ba385\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/grouping.js\":\"2dbec2db56dffd7b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/index.js\":\"dbd1156754f84fa2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/target.js\":\"788b15f459cc4b80\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/codeMirrorExtensions.js\":\"f48c88f078daa55b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/contentPrefill.js\":\"b06d0b5f520b03ae\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/dataExtension.js\":\"833f6c74e80ebea5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/index.js\":\"f005bd6fb83b9055\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"46d1c71c1d576315\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/invalidation.js\":\"ebd066bc7f18a413\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/localSchema.js\":\"49f4758953e1edec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/blockrefs/index.js\":\"f843252b002781f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ce1f59e371870901\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/index.js\":\"86cd446cb21ee880\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/referenceNode.js\":\"2e6c7b288ec89dad\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6ce3ee6e2c0f0c43\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"543fe7a242802f0f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/index.js\":\"6c2c5c5ac5c29f43\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fb3032c25c76fac1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2467f3156bb97813\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/mergeRetargetProcessor.js\":\"60cb6cb9c9825eff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/parseFence.js\":\"6edf552a6c630620\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referenceParser.js\":\"5888c64d5342302d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referenceProjection.js\":\"b34ff1dedeb37dae\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referencesProcessor.js\":\"06538e94351bffd9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/renameProcessor.js\":\"7eed9bd18bfc30b3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/spanReplacement.js\":\"141a48f9b9be961c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/htmlToOutline.js\":\"e445dc02160d484c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/index.js\":\"fadf140251fe6231\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ac2fbf6d95acce39\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/pasteDecision.js\":\"c09720cf3e0a783b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/action.js\":\"6751c0f8ce6064bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/blockIds.js\":\"84196575ac11501a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/content.js\":\"cb3cff8e41ed20f0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/effect.js\":\"69fb1fe01e8ca510\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/ids.js\":\"1fc84a62ef1f55fa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/import.js\":\"a0c058d8edb302c3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/index.js\":\"681f542f1f9d055e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/plan.js\":\"77bc4f4b3f92ae5e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/plugin.js\":\"72b2c02293ac1b7b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/promotion.js\":\"fcd5045a577e1fe3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/properties.js\":\"8e42217eee6a21eb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/references.js\":\"f1357b5869179945\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/report.js\":\"00dd15e700ae27cc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/roamMemo.js\":\"8d8ea4bba7233233\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/runtime.js\":\"160add74ff9d051a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/schemaReconciliation.js\":\"0b57bc0c074aed43\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/srsMarkers.js\":\"f34c754507537d3c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/todo.js\":\"6e69d10430b1e5e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/typeCandidates.js\":\"4843aead3fad3a83\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/types.js\":\"cc9d20540937526d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/search-health/index.js\":\"973f973ec8f43ff3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/search-health/store.js\":\"1abb8ffd87c6492b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/HeaderItem.js\":\"7aeeecd5d5076bec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4b841a05172be4a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/index.js\":\"a90f384e59c120c9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/model.js\":\"ec543e87668c5526\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/toggleStore.js\":\"2511f920f86d0c51\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/useKeyInspector.js\":\"403292e16b2668b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"21610105cda52702\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/ShellDecorator.js\":\"e7e7b101c38252ab\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/actions.js\":\"1f16802cf4a292b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3a2c27081fab6333\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/index.js\":\"97e889e2c7122759\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/shell.js\":\"5ef17c1c1289f8f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/surface.js\":\"3447c2947cec3e3c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/walker.js\":\"443806a297c5addf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/RescheduleToast.js\":\"94c1121f1e7449cb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/dataExtension.js\":\"2c2ee27396524b40\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/index.js\":\"db590f6acbcceb2d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/indicator.js\":\"f023d68bd972d263\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/moveSrsState.js\":\"05488b6dbbba8de9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"af3ae7a997f0ddc0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/scheduler.js\":\"03ca26df99eb299c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/schema.js\":\"89ae088c397a3f78\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8e034a604acf7806\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/srsClipboard.js\":\"5342344270899a9f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"87876972e7df763b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/DailyNoteReviewHint.js\":\"635b872f8119d634\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/DeckPicker.js\":\"49a3843dcac77707\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewControls.js\":\"10917d2e97607467\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0663094c6efe643f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewSession.js\":\"f9e7129f1aa3e35b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/actions.js\":\"3bb8c1b0c4cd395d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/archive.js\":\"65c17bce466ab775\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/dataExtension.js\":\"805e51a197b293a2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/deck.js\":\"282cc3a3ed21d236\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/dueQuery.js\":\"3cf5446f92a19270\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/gradeDecision.js\":\"4a6556a1f7fac2cf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/index.js\":\"4fdebb4dcf7a04d8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/keyHints.js\":\"9725759f2eecacbb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/reviewCardLayout.js\":\"92c8d7dc251007b5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/reviewProgress.js\":\"af6aad198ca8f8f3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/schema.js\":\"640ad9d5c19830bb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/useDueCards.js\":\"428b59864b15beb9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/startup-metrics/index.js\":\"6f696b06b7eccad1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/startup-metrics/record.js\":\"96b91c265ef41441\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/index.js\":\"d5e0a6a67b5d370e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/persistenceStatus.js\":\"4a033197bb8e2f25\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/requestAction.js\":\"3a5b58ac0ee654b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/TypeChipsDecorator.js\":\"38df0f5d1f283305\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/codeMirrorExtensions.js\":\"13366ba23d924a9c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/index.js\":\"cabfa05440c6b28b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/typeAutocomplete.js\":\"8b61ecf1e72da519\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"131c6d8d4dac573d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/actions.js\":\"d37d0737fbe04794\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/anchor.js\":\"77aa9219494b9d63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/events.js\":\"08eefa8f0e973e02\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/gestureActions.js\":\"32d66d770a5c4059\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/index.js\":\"d9ee29a2aed6e25f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"04d61295d582d56d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/collect.js\":\"9333271ce87779a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/index.js\":\"2f69a9138dea3fca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/record.js\":\"8b4ffb8915a41594\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/RejectionDialog.js\":\"5f225a9017a9758e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f8a92ed8fb95a4f1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/index.js\":\"e706535b8399039e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/model.js\":\"a7d0c68366f10687\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/queueCounts.js\":\"032070f3e409e8d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/rejectedHelpers.js\":\"89b19240d36cf4df\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/rematerializeAction.js\":\"44459ba23d10ffa0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/useHysteresis.js\":\"81aa51cc0c136f8a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/effect.js\":\"b3dd8ffdc576988a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/index.js\":\"8cfcc9122dd6e8a7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/theme.js\":\"bf4a54d2adda9e2c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/actions.js\":\"22f339c3095924c8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/dataExtension.js\":\"4fdf0df37ea2c927\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/index.js\":\"1980e98ab34856d0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/schema.js\":\"830b56d34699382b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c0a21dbd7e776492\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/actions.js\":\"8efddc9132038307\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/defaultItems.js\":\"66655b0bb4051c5e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/facet.js\":\"7ce72cb7426d6efc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/holdRecognizer.js\":\"78a72fce7444c35b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/index.js\":\"0714a8f1e1ae08fd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/UpdateIndicator.js\":\"bb79f768eb0ea213\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/index.js\":\"78a0dbd86a0fd840\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/loadTimes.js\":\"947e596f052e6a0d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoNotesRenderer.js\":\"0235d96c7983aca8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoPlayerRenderer.js\":\"0d66a96af58164ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoTimeStamp.js\":\"02a65b495c353ef8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/actions.js\":\"c261c367ee9994c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/index.js\":\"d0050c3a448b54a6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/markdown.js\":\"c3bd0ea5a2b0b311\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/notes.js\":\"c13596233efc4ffe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/registry.js\":\"11f6c75a989b54f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/remark-timestamps.js\":\"e83d86bb44f74a35\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/view.js\":\"167057aeb9f232e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/LinkHints.js\":\"d85f12cc6d6c35aa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/index.js\":\"abf6b245488c9f68\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/model.js\":\"053985316e65c311\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/settings.js\":\"f1f5055575dcd7ab\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/actions.js\":\"d3d3fece93c804c9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/index.js\":\"29eea682ebaf0100\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/interactions.js\":\"66692394fff67828\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/workspace-header/index.js\":\"dd1209a907766f52\",\"/knowledge-medium/pr-preview/pr-1787/src/registerServiceWorker.js\":\"d806dade8dbe5249\",\"/knowledge-medium/pr-preview/pr-1787/src/requestPersistentStorage.js\":\"219ac73f1a1fcefb\",\"/knowledge-medium/pr-preview/pr-1787/src/services/authRequestDeadline.js\":\"8a1714f64e273359\",\"/knowledge-medium/pr-preview/pr-1787/src/services/authStorage.js\":\"65f02b8193228c8b\",\"/knowledge-medium/pr-preview/pr-1787/src/services/powersync.js\":\"6b705cebe41fb5b4\",\"/knowledge-medium/pr-preview/pr-1787/src/services/supabase.js\":\"ec31a623da1921fc\",\"/knowledge-medium/pr-preview/pr-1787/src/services/uploadErrorClassifier.js\":\"73660d063b1a5c10\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/ActiveContexts.js\":\"1be872abe42e93f5\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/HotkeyReconciler.js\":\"1dff6b17dbc2ae0e\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/WipeLocalDataDialog.js\":\"3b75702bb6575f02\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/actionDispatch.js\":\"37d9fbd6f0b4d9fc\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/actionRefItems.js\":\"e9ffe03e50f6a83e\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/applyKeybindingOverrides.js\":\"f3ac500bf9bb2cdd\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/blockActions.js\":\"c2267a7166b75f1e\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/canonicalizeChord.js\":\"aeecbf501be67b55\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/defaultContexts.js\":\"8f1c50c1c30548f1\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/defaultShortcuts.js\":\"77137bdac7a31a80\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/effectiveActions.js\":\"727be0565ba4d39d\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/gestureAction.js\":\"bb70a69853d8df4d\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/gestureBinding.js\":\"7d362e303b366f87\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/holdRegistry.js\":\"71e6441ea1131987\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/keybindingConflicts.js\":\"626e92e958ca40b0\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/keybindingOverrides.js\":\"e81ef146efc8a759\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/pointerAction.js\":\"ea863095c8402d14\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/resolve.js\":\"769861e8169a7148\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/runAction.js\":\"833d1ca73bc31835\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/sequenceMatcher.js\":\"14176f17c448bcaa\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/types.js\":\"188b859d0b605e72\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/useActionContext.js\":\"5ea4acb3b706c9d1\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/useActionDiscovery.js\":\"5947b9644d636a73\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/utils.js\":\"574a1ddbbf3ec5be\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/bootStore.js\":\"c68da868bf2e39c4\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/previewDatabases.js\":\"273638cdb41e5665\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/byteTransform.js\":\"52bb9b8260d319b3\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/attachmentCleaner.js\":\"0f8104b28c2bcfd6\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/attachmentParts.js\":\"7853eb74f86b6c78\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/bundleParts.js\":\"e961de100d0f0b23\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/bundleRecord.js\":\"5c8c1cd1ced4b6d0\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/manifest.js\":\"ec139a9fa3a52d47\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/takeBundle.js\":\"7035cdf818c53fa5\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/verifyBundle.js\":\"5b73b22de6746af6\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/cleaningStage.js\":\"b6629ecbd6f9812a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionKey.js\":\"f2f48ffb080fbd8f\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionServer.js\":\"0f488121761d52dd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/flip.js\":\"e36ac3e66a2bfdc4\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/flipAttempts.js\":\"99f2e402cc878515\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/pages.js\":\"5f3ed3a5acf37457\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/preflight.js\":\"3ac2896eb2a3ea4c\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/reseal.js\":\"7113ab974391a666\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/runConversion.js\":\"47c352ac348b58c6\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/runLock.js\":\"e9e064f35addbb16\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/sealing.js\":\"7d11a5aba2bd7596\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/sealingStage.js\":\"dfab7780b41275e5\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/stage.js\":\"22bf36ad5438c64a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/verifyReseal.js\":\"c94746828fb459c4\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/aad.js\":\"8fffcc91f58957a2\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/aead.js\":\"f9c84bb95895c86e\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/base32.js\":\"2f67a12be82779ba\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/base64url.js\":\"288f2539ea90377b\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/binaryEnvelope.js\":\"18213b3bc2b93df0\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/byteAead.js\":\"3fc8b5ef97e49c80\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/canary.js\":\"719e375f87d7c18d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/contentHash.js\":\"1d51a9545d1dd91c\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/contentKey.js\":\"9ffc876f3141a736\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/derivedIdNamespace.js\":\"38c90126203263c5\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/envelope.js\":\"911a5c96c581dfc1\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/hex.js\":\"0cc9e53cecd4bd02\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/sha256Hex.js\":\"27b5ba2ca40d0d78\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/workspaceKey.js\":\"ce7dbfb286275905\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/conversionState.js\":\"7cee58a2906d4903\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/createEncryptedWorkspace.js\":\"afc30152095403dd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/pastedKey.js\":\"6c79976721ae00f7\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c203f0a9d09755bd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c21b6ec5967c1573\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/keyStore.js\":\"9d7ddee1a9686921\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/mintWorkspaceKey.js\":\"48ee5c4274b42b12\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/modePin.js\":\"0573fc1b3d0cf35c\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/openWorkspaceKeys.js\":\"e9d123746ff856bd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/resolveWorkspaceEntry.js\":\"829540dfc16ae8b6\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/resolver.js\":\"f9f6e8da4a39ea2d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/workspaceAccess.js\":\"5484691198990ee3\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/transform.js\":\"30bfa0ba945e13c0\",\"/knowledge-medium/pr-preview/pr-1787/src/themeBootDefaults.js\":\"e392ca8e9e8879a2\",\"/knowledge-medium/pr-preview/pr-1787/src/types.js\":\"a27d6ecd4efba8f5\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/ClientLocalSettings.js\":\"b24321d3aebf2c4a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/abortableSleep.js\":\"312d596e478b8ab6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/array.js\":\"43abe1e2e7731fea\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/backlinkAutocomplete.js\":\"01bd03f7c074105b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/blockCrumbs.js\":\"886c1bcd60c00312\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/blockrefAutocomplete.js\":\"04bab10ecbded66f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/cadencedIdleJob.js\":\"f834bf3a268f7589\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/callbackSet.js\":\"b3c3cd75a4c30772\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/clientId.js\":\"5ff0ce12af25898f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/codemirror.js\":\"0cf909fdcb96b00c\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/codemirrorCompletion.js\":\"38535af79d327b36\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/copy.js\":\"13ae8fcab8f09658\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dailyPage.js\":\"3168750e83014be7\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dbForensics.js\":\"143c62974cdaa301\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dbForensicsHooks.js\":\"964bd2376ec96930\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/deleteBlockThroughUi.js\":\"4f2f2587e864cd64\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dialogs.js\":\"642fc82886b08009\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dom.js\":\"85583f483b238560\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/downloadBlob.js\":\"0a8dfd3fa817bf6e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/exportSqliteDb.js\":\"9feae640ef42beee\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fileSystemAccess.js\":\"98d2a7b625e51b3c\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/flipSlide.js\":\"8ea09c724f5f9b0c\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fnv1a.js\":\"7dd89ea91447ec56\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/formatBytes.js\":\"438b372f63fe646a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fuzzyRank.js\":\"0e5aa99acf00db78\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/idbKeyedStore.js\":\"813d63eed31721f4\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/idleCallbackPolyfill.js\":\"8a2b92caa0ef3f89\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/keyboardAwareScroll.js\":\"f697a3aec48aaff4\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/keyboardViewport.js\":\"4c10b84abfacd6be\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/lastWorkspace.js\":\"2a72a5d1b9316cf8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutColumns.js\":\"10456e1bcc1be219\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutSessionDom.js\":\"f2921556f566b613\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutSessionId.js\":\"9619f369f9a90fb3\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/linkClickGestures.js\":\"b3668e9b55afafff\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/linkTargetAutocomplete.js\":\"7c3bc8740b601cb8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/localDbCorruption.js\":\"d6165404aa2983a6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/localDbRecovery.js\":\"16adc899d8a56b6f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/markdownParser.js\":\"1334901533797be0\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/memoize.js\":\"a32147b29858b622\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/nameFieldCommit.js\":\"1d0252abe9d30fbc\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/nameList.js\":\"1a87eb11bcc13a15\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/navigation.js\":\"df2b31c6895e2caf\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/omnilinerNamespace.js\":\"85ee2215842fa20e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/opfsPageScan.js\":\"15403deeded54c73\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelClearance.js\":\"217460668f7ce98e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelHistory.js\":\"02d49a4600748680\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelLanes.js\":\"861643106665658c\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelLayoutProjection.js\":\"8f5ecbc7e6dc81d2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelScrollAnchor.js\":\"ae5971cceacc9956\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelUrlFlags.js\":\"393d4185fffa36a8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/platform.js\":\"a141eb35cb357834\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/pluralize.js\":\"d43be119904585d0\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyCreation.js\":\"eb063617f11c87ef\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyNavigation.js\":\"a9347fe7611571dc\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyValueContext.js\":\"b06156ef966d9ea8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/react.js\":\"fc39cc81bb9ca1e4\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/relativeDate.js\":\"4ac416f689ca5f9e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/relativeTime.js\":\"5f24f2e3b78bddb2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/renderScope.js\":\"404584eb5154e356\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/resolvedThenable.js\":\"03c5e0d6f29b9084\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/routing.js\":\"4b00de0d9b4eecd5\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/safeMode.js\":\"027b8350f6009f64\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/scheduleIdle.js\":\"deaeb5c46536f99f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/screenWakeLock.js\":\"28f26670792a5eab\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/selection.js\":\"c7e60bff369dac4e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/softKeyboardGrab.js\":\"eb61a4f5689db20a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/startupTimeline.js\":\"84a92de5061c5809\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/state.js\":\"be5dc07ad3754783\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/string.js\":\"c956957ed481bc61\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/surfaceZoom.js\":\"517c455bae06d57b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/time.js\":\"9bd3a8f9af6d35e1\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/toast.js\":\"dee5fd55e98bebfc\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/toggleStore.js\":\"db2ccf107139f324\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/untilStopped.js\":\"bbc57216e8c6761f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/userActivity.js\":\"b964ccee046ebe6c\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/viewTransition.js\":\"9eca33a3b042a697\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/viewport.js\":\"8c6ef9bed97739fa\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/webLock.js\":\"73b8624e1939145d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/workspaceRecovery.js\":\"93a956ad0fdeb38e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/workspaceSnapshotStore.js\":\"80fd03d7167f3a45\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-compiler-runtime.js\":\"f75f74ca7f0b8051\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-client.js\":\"ce74f983f584eabb\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-server-edge.js\":\"5c2a854cc1967ce3\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-server.js\":\"bb0afc01b04e36ac\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-static-edge.js\":\"f321bc76945f14b6\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-static.js\":\"936500275d9e31b5\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-test-utils.js\":\"e6faa263bc7e31a9\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom.js\":\"09aeeac720cc94a7\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-jsx-runtime.js\":\"8680085970e920dc\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react.js\":\"abdc2a6fc78992f1\",\"/knowledge-medium/pr-preview/pr-1787/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1787/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1787/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
