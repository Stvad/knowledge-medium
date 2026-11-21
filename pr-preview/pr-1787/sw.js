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
		buildId: "86183dbf0366-d29cf1b1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/\":\"52c620731828372d\",\"/knowledge-medium/pr-preview/pr-1787/index.html\":\"52c620731828372d\",\"/knowledge-medium/pr-preview/pr-1787/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1787/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1787/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1787/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1787/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1787/assets/FacadeVFS-BTlG6mWQ.js\":\"7ec53069f5a10ad4\",\"/knowledge-medium/pr-preview/pr-1787/assets/OPFSCoopSyncVFS-DO2paPH5.js\":\"9616567a6c0fcb1a\",\"/knowledge-medium/pr-preview/pr-1787/assets/OPFSWriteAheadVFS-Bd_6LIvq.js\":\"2436be71db65fd70\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-DnURvDU0.js\":\"b2f2e1b4ddcec7dc\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-async-H_1qYQ0H.js\":\"40ded0764e1a1545\",\"/knowledge-medium/pr-preview/pr-1787/assets/worker-zHuWW5V9.js\":\"65a6cbad53b7fe18\",\"/knowledge-medium/pr-preview/pr-1787/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1787/chunks/app-4yNOVopP.js\":\"9773c65ca40131ce\",\"/knowledge-medium/pr-preview/pr-1787/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1787/index.js\":\"2820f4b91449a327\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1787/assets/AccessHandlePoolVFS-Dp8_aHFg.js\":\"d194b6b43f361504\",\"/knowledge-medium/pr-preview/pr-1787/assets/IDBBatchAtomicVFS-pskAln_K.js\":\"1cc5c35cc5f0f877\",\"/knowledge-medium/pr-preview/pr-1787/assets/MemoryVFS-Db6vL6ic.js\":\"a3c592ef3b155201\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-DJXfyczS.js\":\"6f84490eac01e043\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-async-_2JV_9Vn.js\":\"0b9c0bc73c9ffeb4\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1787/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1787/chunks/AccessHandlePoolVFS-C9eAV8ZF.js\":\"294bb64de4d63f7c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/FacadeVFS-B8ESr4_p.js\":\"b5581faca4fce3bb\",\"/knowledge-medium/pr-preview/pr-1787/chunks/IDBBatchAtomicVFS-DGKG6uTG.js\":\"ed195f26d4e1adbd\",\"/knowledge-medium/pr-preview/pr-1787/chunks/MemoryVFS-BUdxfIV3.js\":\"048cc5136c559218\",\"/knowledge-medium/pr-preview/pr-1787/chunks/OPFSCoopSyncVFS-DU_DZynx.js\":\"ce750e0da3206674\",\"/knowledge-medium/pr-preview/pr-1787/chunks/OPFSWriteAheadVFS-aN7FCfqV.js\":\"0d988e7fcd3897cd\",\"/knowledge-medium/pr-preview/pr-1787/chunks/Preview-DhZB4z55.js\":\"c12d2dc8ac4d273b\",\"/knowledge-medium/pr-preview/pr-1787/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/card-1RR0ZyX9.js\":\"ef232abcbb61d4c4\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-cbyZd-nw.js\":\"81517118dedde117\",\"/knowledge-medium/pr-preview/pr-1787/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1787/chunks/mc-wa-sqlite-BhMY7baG.js\":\"8995ef400ef36a2a\",\"/knowledge-medium/pr-preview/pr-1787/chunks/mc-wa-sqlite-async-1mGAWSwm.js\":\"915262ea86e17820\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-B0PPWRRt.js\":\"1dc75bee49ec7a5c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-BC-qCYk3.js\":\"f8f8a6b4ba0cd756\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-CB0Ttm9v.js\":\"f273ddecb32724d8\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DPPTOn_e.js\":\"2ca9b641f6c2412e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DSO3i55o.js\":\"62dd4c6f9ae37600\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DTDLVqos.js\":\"f17e3bf2a045519e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DsT3g_f6.js\":\"d9ee0afde768eceb\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-Wzf7Lz5S.js\":\"7bd7e2b7b24bf7b0\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server-legacy.browser.production-oyHkts5r.js\":\"272f700380c06629\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server.browser.production-BS7GdBVU.js\":\"79bad163643a8ffc\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server.edge.production-CwcNy-x5.js\":\"3a9973e9d752d1da\",\"/knowledge-medium/pr-preview/pr-1787/chunks/server.browser-CxgfWHEk.js\":\"6be33de36cef0044\",\"/knowledge-medium/pr-preview/pr-1787/chunks/textarea-D9V7JyBy.js\":\"df4ee4dfc912cae4\",\"/knowledge-medium/pr-preview/pr-1787/chunks/ui-MMFiw6WL.js\":\"dc2df28d3d99ee7e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/wa-sqlite-async-CWub23EH.js\":\"4d762b69880bb0f6\",\"/knowledge-medium/pr-preview/pr-1787/chunks/wa-sqlite-zbcnP13q.js\":\"d761773155720821\",\"/knowledge-medium/pr-preview/pr-1787/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1787/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1787/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1787/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1787/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1787/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1787/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1787/src/App.js\":\"c80530956eddcc22\",\"/knowledge-medium/pr-preview/pr-1787/src/appUpdate.js\":\"c68894eaa9124a3c\",\"/knowledge-medium/pr-preview/pr-1787/src/appVersion.js\":\"a552e57e590c9c85\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/initialLayout.js\":\"47f8215cab484f12\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/openWorkspaceData.js\":\"835ce2fcacb42def\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/resolveWorkspace.js\":\"92ce0231132216cf\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/workspaceBootstrap.js\":\"280e5229461daaf6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockComponent.js\":\"c6a0750fc20a4187\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockCrumbs.js\":\"2195f7f81ea49a7c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockEditor.js\":\"f18f4295861cc3c4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockLoadingPlaceholder.js\":\"9577df7c6d9d23ee\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockProperties.js\":\"02df292815abc99d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockSearchPicker.js\":\"c54ebedc3cce2b5a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ConfirmBulkDeleteDialog.js\":\"855d5fc814c34cd1\",\"/knowledge-medium/pr-preview/pr-1787/src/components/DividerHandle.js\":\"9e9a5fa0ef6b72b7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/DraftEditor.js\":\"dde39d63fbadea65\",\"/knowledge-medium/pr-preview/pr-1787/src/components/GutterPill.js\":\"1f373fd763b76f6d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/Header.js\":\"330b2153c829e95e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/LazyBlockComponent.js\":\"1931c8f3fa32a349\",\"/knowledge-medium/pr-preview/pr-1787/src/components/Login.js\":\"7df3711493a1b72a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ZoomableSurface.js\":\"9d4baf29525a80be\",\"/knowledge-medium/pr-preview/pr-1787/src/components/editModeKeepalive.js\":\"afa57e7c87003114\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyDisplay/PropertyDisplayScope.js\":\"61b15c78b21ed1d5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"04934b4c36af9aee\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/RefPropertyEditor.js\":\"fc26b9f15b67e99d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/RefTargetTypePicker.js\":\"8de4d888f6d61212\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/SelectPropertyEditor.js\":\"49e5aae1b14feabd\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/TypesPropertyEditor.js\":\"885f10434845044e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/defaults.js\":\"35d39fc68a9d19f7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/kernelValuePresets.js\":\"2287c77b08c91ddd\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/selectablePresets.js\":\"ddc6a3cd004e0270\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/typesPropertyUi.js\":\"736fcc2df27bf530\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/AddPropertyForm.js\":\"d1dcf6fa19937eb6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/PropertyPicker.js\":\"71432f996e07a79f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/PropertyRow.js\":\"bb25ec88dacda3eb\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/Rows.js\":\"776d623b78b0d72d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/actions.js\":\"e61e63cf7ac844f4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/declarationOnly.js\":\"0fe59c91a8f308b6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/layout.js\":\"81810c075da5fdee\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/model.js\":\"057667e058363525\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/shapeUi.js\":\"dcc39dbc27901f16\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/shapes.js\":\"91ccd67d231875d5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/usePropertyEditingActivation.js\":\"174ae4f26db26f6f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/visibility.js\":\"e8ef9f96db182989\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanelSections.js\":\"78c515592c84a89c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockEmbed.js\":\"ee834e3697ef165f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockLink.js\":\"6f42065da136ee34\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockRef.js\":\"b1dcc9dc65be3a74\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/ReferenceLink.js\":\"2ed53ea88fa93282\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/cycleGuard.js\":\"d7fb985abab898e6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/cycleGuardContext.js\":\"45024fd2ed9f3034\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/linkInteraction.js\":\"c53c3cb498226edb\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/referenceLayout.js\":\"1d17876179c7fab2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/useBlockRefAncestors.js\":\"d359ff467aa78c73\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockGutter.js\":\"913c3c77471b5996\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockInfoDialog.js\":\"caa4d2edf67d1f47\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockTypeBlockRenderer.js\":\"59f695d4efe24f3a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BulletHoverCard.js\":\"f19fd30b207503de\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/CodeMirrorContentRenderer.js\":\"21a971b55d45e6ef\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f290d99125a46ae8\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/ColumnResizeHandles.js\":\"3c4396d5e9f0e8f3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4728bbae43aff8e5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/DefaultBlockRenderer.js\":\"026a9e31bb0433b6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/LayoutRenderer.js\":\"ad0d5e9be3f4edb3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/MarkdownContentRenderer.js\":\"477b80987c109f60\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/MissingDataRenderer.js\":\"38aad86b1f38a95c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/PanelRenderer.js\":\"09943722e3b4b735\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0b921efb5cb6b49b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/TopLevelRenderer.js\":\"ad554b37c4746521\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/blockGutterMode.js\":\"b9d535e068dc588a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/blockTitleText.js\":\"c4d61e8ffd3074dc\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/fieldCreationKeydown.js\":\"8f347f5eb1f96428\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/layoutRootContext.js\":\"9402b1c82df32770\",\"/knowledge-medium/pr-preview/pr-1787/src/components/typeChip/TypeChip.js\":\"fad015a677d6012c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/typeChip/chipStyle.js\":\"55bf0dc23e3109c0\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/anchored-floating.js\":\"33cec4a73e86077d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/button.js\":\"0e4041481e6c8e31\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/card.js\":\"3f4c00c24840f0e2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/checkbox.js\":\"a254c91c5aae7e96\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/collapsible.js\":\"4577bcefc5c8f53e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/command.js\":\"4bc8bf73e37f7291\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/context-menu.js\":\"022454cb34989387\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/dialog.js\":\"411f637b54709071\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/dropdown-menu.js\":\"205df937feb4a2f2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/floating-listbox.js\":\"34d62252adb01db7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/index.js\":\"ccd2b0a9a145f3a8\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/input.js\":\"376489022fe59502\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/kbd.js\":\"d490b4357313bdd9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/label.js\":\"b4e94fbe2e02d91a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/textarea.js\":\"28275da4e1b1a682\",\"/knowledge-medium/pr-preview/pr-1787/src/components/useEditModeYieldKeepalive.js\":\"742d233e0109300d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/BootFallback.js\":\"db5924c296358289\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/FocusedRowLazyMount.js\":\"f61a08e8e67758d3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/LazyViewportMount.js\":\"1df850123a0dab58\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/LocalDbCorruptionFallback.js\":\"ae5c50daeb83797d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/error.js\":\"fa79942547de8ab6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/lazyMountRegistry.js\":\"cd9fc03aa62976f2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/suspense.js\":\"ecd66418dc320887\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/CreateWorkspaceDialog.js\":\"905314a6a2ef9455\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/PendingInvitations.js\":\"68973ca2011039f2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/SyncProgress.js\":\"6d33f1f14e9a1829\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/UnlockProgress.js\":\"acd553ca35793838\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceKeyGate.js\":\"d1db57323a3da92d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSettingsDialog.js\":\"f9ffa8cba9a3e416\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSwitcher.js\":\"7caffe75d7223128\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSyncGate.js\":\"2bcde4222e32381f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/ConversionFlow.js\":\"4fd71cbb626fe968\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/ConversionFlowHost.js\":\"b2e5b222c5fd8e69\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/EncryptionSection.js\":\"9cef900a2c9bdd7b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/attachmentPrompts.js\":\"51c2e65de9960e76\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/bundleFolderPrompts.js\":\"cef501ed97313b69\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/conversionFlowDeps.js\":\"a11a6f23d1a6b94f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/conversionFlowStore.js\":\"342f5be8cd89b2e2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/flowUi.js\":\"b5c8d61d425e82dd\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/useConversionRun.js\":\"454335ff8b7ebf12\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/keyUi.js\":\"96c39875a7abe3c5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/useCloseOnKeyLoss.js\":\"c883056145ab0b5e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/useCloseOnServerE2ee.js\":\"c53b5c07ee90f3ce\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/workspaceUnlocked.js\":\"211c514b7dc1860d\",\"/knowledge-medium/pr-preview/pr-1787/src/context/backgroundSubtree.js\":\"277ced36af8c29e9\",\"/knowledge-medium/pr-preview/pr-1787/src/context/block.js\":\"4b77ebf5acd2c4ab\",\"/knowledge-medium/pr-preview/pr-1787/src/context/layoutWsContext.js\":\"147202521b5de56e\",\"/knowledge-medium/pr-preview/pr-1787/src/context/propertyDisplay.js\":\"20b538f56b2a7b3e\",\"/knowledge-medium/pr-preview/pr-1787/src/context/repo.js\":\"890f76993a99f540\",\"/knowledge-medium/pr-preview/pr-1787/src/data/aliasClaim.js\":\"33eded203ba256a4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/aliasSeatNamespace.js\":\"7a5666fc00038b65\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/blockData.js\":\"525a90e51b0be01b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/blockType.js\":\"12ed01ab4e446999\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/changeScope.js\":\"2bbf2d80b632607d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/codecs.js\":\"9d823d78ca6d202d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/derivedData.js\":\"41f0de641689529b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/errors.js\":\"9d0cbfbbf8284d6a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/events.js\":\"63c164cdd6752f5b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/handle.js\":\"7205182b9f73d4bf\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/index.js\":\"d3481938b4f86437\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/mutator.js\":\"6df8aac6e0d8f2bb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/processor.js\":\"f1149a59a609ad5a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/propertySchema.js\":\"d00c840d89942c63\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/query.js\":\"ba41ce460cba07ff\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/sameTxProcessor.js\":\"2fa124bc0e1c6b7b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/schema.js\":\"7205182b9f73d4bf\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/tx.js\":\"7205182b9f73d4bf\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/typedBlockQuery.js\":\"94b8fffdf2f0fa13\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/user.js\":\"38b43accc8235d0c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/valuePresetCore.js\":\"e7670f0ec762bca9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/valuePresets.js\":\"8bd9baf5df32dab5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/attachmentCleanerIOVerb.js\":\"68364193da6bc297\",\"/knowledge-medium/pr-preview/pr-1787/src/data/block.js\":\"8f6e0918b7ad742f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockCache.js\":\"a9072787f7216eeb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockId.js\":\"81d8609d7aaac574\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockLiveness.js\":\"45fc135656197f04\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockMerge.js\":\"74e7906aebae2b18\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockSchema.js\":\"e9c213947ed2fb1b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockTypes.js\":\"85725474c22fc0c5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/clientContext.js\":\"50d29715c59de7e3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/dbFileSiblings.js\":\"1d4d93c6ba34e6ba\",\"/knowledge-medium/pr-preview/pr-1787/src/data/definitionSeeds.js\":\"edc65d4dbb1ad6b8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/derivedIds.js\":\"ab4fb5e4ba183f21\",\"/knowledge-medium/pr-preview/pr-1787/src/data/drawnSubtree.js\":\"d8c1a76054f75a12\",\"/knowledge-medium/pr-preview/pr-1787/src/data/facetBridge.js\":\"f4843b0ebee4e46b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/facets.js\":\"e70e56a64f0c8b27\",\"/knowledge-medium/pr-preview/pr-1787/src/data/globalState.js\":\"418551e784fd5757\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/aliasClaimRederiveProcessor.js\":\"f9fd8bbe19f7865a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/ancestorBatch.js\":\"157c2ff31c4075c5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/blockTypeTypeifyProcessor.js\":\"c2f4bf269b9bb194\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/clientSchema.js\":\"af4ed485374b84ed\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/commitPipeline.js\":\"b56e5aa96f1147b9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/devAssertions.js\":\"0b97d2c30d739ce6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/firstSync.js\":\"13faccb1a0d6c7ee\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/freshInitialLoad.js\":\"47da80f333d0d0da\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/graphBackfillClaim.js\":\"c3e6f1397932e482\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/handleStore.js\":\"187b3e515531758c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/idleMarkerJobs.js\":\"c91f4defb5bf0360\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/initialDownload.js\":\"a47511db4c46fac7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/initializeClientDatabase.js\":\"ebcefbdd8ffc521c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/jsonCanonical.js\":\"c22a0b513fb26cd0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelInvalidation.js\":\"534add34620fe4f3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelProcessors.js\":\"85e3def354ee8918\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelQueries.js\":\"66f51aaba1007180\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/mergeTypeMembershipProcessor.js\":\"091fd878b86b353d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/normalizeReferencesProcessor.js\":\"0c833f474eecfec1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/poolInstrumentation.js\":\"8ba1bd65b53a60a7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/processorRunner.js\":\"06f790e93f16cd90\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyCellBackfill.js\":\"2f34f9177329dd44\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyChildMint.js\":\"9682794071c9646b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyChildrenProcessor.js\":\"01fb85c061fda19d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyDefinitionChangeProcessor.js\":\"abb890faf981d30c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyDefinitionSynthesis.js\":\"3cabb1b0f7df45db\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyKeyScan.js\":\"6674b2a7efd04d0e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertySchemaResolution.js\":\"cab24a4025a4d5b9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/raiseProtocol.js\":\"842ad30897b37c0c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/readBatch.js\":\"11f09c7e56fe6011\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/refProjection.js\":\"c76640e68815fccc\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/referenceTargetLookups.js\":\"5287c41a03be26a5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/referenceTargetProcessor.js\":\"21bde45cd655ede3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/replayMerge.js\":\"21b97c0432dc8b76\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/sqlBinds.js\":\"0df9ccb7b81f249b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fd717fcac597a93e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/arrivalProcessors.js\":\"2b02120859327ac6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/invalidate.js\":\"e5261b2bc27533fe\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/materialize.js\":\"f1878187acb1b24f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/observer.js\":\"80c0ce8995c6b486\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/reconcile.js\":\"4c456d688eca8821\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/timingMetrics.js\":\"5f38ac56602a15b9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/treeQueries.js\":\"2572430947461554\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/txEngine.js\":\"c95501817b62f827\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/txSnapshots.js\":\"75ea61a0928c3ba7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/typedBlockQuery.js\":\"679878a967601a6b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/undoManager.js\":\"809edc441bace24e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/invalidation.js\":\"7e905b2a56c8fae8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelDataExtension.js\":\"0dc4aa1773b9aa59\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelPage.js\":\"bdebf4f1630af580\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelValuePresetCores.js\":\"70004cb2ab8cd3a6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbCorruptionSignal.js\":\"8729ea0310f694c3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbStorage.js\":\"d52fef2f3482d2e3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbVfs.js\":\"5ad3223953f1ae9f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localSchema.js\":\"82f45db484e120ca\",\"/knowledge-medium/pr-preview/pr-1787/src/data/maintenance.js\":\"ddb5997df954229e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/mergeProperties.js\":\"e71908cac2d2dd05\",\"/knowledge-medium/pr-preview/pr-1787/src/data/metricsConsoleHook.js\":\"1c1cd721dee6b18d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/migrationsPage.js\":\"16d167a5aca08e7f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/mutators.js\":\"6e1bf46e1326f7a6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/orderKey.js\":\"0360a3e9bf0c68d5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/orderKeyPlacement.js\":\"c303c1f492879abb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/outlineSurface.js\":\"4e0a6180cc2b700d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pendingEditorContent.js\":\"d280e63ada193cd0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pendingUploadsSql.js\":\"07a16ddc61bfad6a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pluginStateExtensions.js\":\"bc9dab52a85f8eed\",\"/knowledge-medium/pr-preview/pr-1787/src/data/powerSyncLogger.js\":\"b3cb66c95cd7e599\",\"/knowledge-medium/pr-preview/pr-1787/src/data/projectorRuntime.js\":\"621934623f49c22d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/properties.js\":\"c2edabaaff50d094\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertiesPage.js\":\"613d625c3883d33b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyChildren.js\":\"88d0a8b019ba9d28\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionFanout.js\":\"15bc6fe31f6f7dfb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionMetadata.js\":\"7f1d6a0184845d0a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionRegistry.js\":\"7a2db8faf92b7cfa\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDisplayMode.js\":\"a8e3b3c371de10b3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyRowCreation.js\":\"f49acade7b925c9a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertySchemaCreation.js\":\"5d1b70dc5c7ec9ef\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertySeeds.js\":\"d8f7058539046783\",\"/knowledge-medium/pr-preview/pr-1787/src/data/recentsPage.js\":\"6276b4d103f0fbb6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/referenceBlock.js\":\"307cba4303d731b6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/releasePowerSyncConnection.js\":\"b4ce649ed84b35f8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/repo.js\":\"e767fd50a6fe230b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/repoProvider.js\":\"a24ba1e86ca467d2\",\"/knowledge-medium/pr-preview/pr-1787/src/data/rowProperty.js\":\"4a2ba382c5d5bbcb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/searchFilter.js\":\"88b30af26db8f659\",\"/knowledge-medium/pr-preview/pr-1787/src/data/seedIdentityLedger.js\":\"884aa3c94505475e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/stateBlocks.js\":\"b0fc07cd60310f91\",\"/knowledge-medium/pr-preview/pr-1787/src/data/structuralEditPolicy.js\":\"343f78c802a8d77c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/subtreeDelete.js\":\"0c653816c5c12fff\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncStreamLock.js\":\"954db54b58344767\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncedTableSqlRecognizer.js\":\"addbdbcedf66f312\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncedTableWriteGuard.js\":\"f8a642f2ecf84319\",\"/knowledge-medium/pr-preview/pr-1787/src/data/targets.js\":\"5d8be4a19de47790\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeColors.js\":\"7c3da1ccb9506888\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeDefinitionMetadata.js\":\"bd7728792425c882\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeDefinitionRegistry.js\":\"685444988eb12829\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeExtraction.js\":\"048d2fc5d8d45d99\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeInitialValues.js\":\"3b1f764e031d8332\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typePropertyGroups.js\":\"bd263f336ac3957d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeSeeds.js\":\"96c9606f0c8edf46\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeTagger.js\":\"296338d5799c98a4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typedRecords.js\":\"5adc152eea61592a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typesPage.js\":\"c7fc86ed7187b447\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userPrefs.js\":\"0ad1303439b29443\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userSchemasService.js\":\"b9ae89e39bc1143a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userTypesService.js\":\"9e9364fe346b4d59\",\"/knowledge-medium/pr-preview/pr-1787/src/data/valuePresetRegistry.js\":\"dd6d06410d503937\",\"/knowledge-medium/pr-preview/pr-1787/src/data/visibleChildren.js\":\"c52c5cd8e6907e06\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceConversion.js\":\"6465bb1d727bbe87\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceFirstSync.js\":\"55641ac67993b2f7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceIdNamespace.js\":\"72c35492fedadaf3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceSchema.js\":\"0c2665b18fa2e7fe\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaces.js\":\"33d92a435cfb8e19\",\"/knowledge-medium/pr-preview/pr-1787/src/data/writeAheadLog.js\":\"f8f90f5d30021804\",\"/knowledge-medium/pr-preview/pr-1787/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/BlockPasteShellDecorator.js\":\"0d65828af795f562\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/atTrigger.js\":\"46bbcd145506c8f4\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/autocomplete.js\":\"08d6d5ed53e4f9ce\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/codeMirrorExtensions.js\":\"9b68e9b8767d0223\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/contentFlush.js\":\"4e17f97bfc2c0aba\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/defaultInteractions.js\":\"00ed3a1b48032060\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/editSettleSignal.js\":\"a1cfd2d7c8ed55a1\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/insertImage.js\":\"eb277edb8567e5e7\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/referenceCompletionRange.js\":\"8d9996aaad281f24\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/referenceTargetTypes.js\":\"70aaffe1b677c259\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/syntaxContext.js\":\"feb514d285942361\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/triggerMatch.js\":\"790cdd4ee7113f9c\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/AppRuntimeProvider.js\":\"ad3781373f66df4b\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/BlockFocusShellDecorator.js\":\"15feea9cec32a32b\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/ExtensionRenderBoundary.js\":\"700de1ffc79f1f5f\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/PanelContentRecovery.js\":\"217cd09ca407df32\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/apiCatalog.js\":\"03f88ccd7f1fed9e\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/approveExtensionHere.js\":\"28a14331254fbcb3\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/armedCutAppMount.js\":\"9833e1144e3d19f4\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/batchableKeyedStore.js\":\"b41098fc5e5b577a\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/blockInteraction.js\":\"6b60ae553c03ff73\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/blockSelectionAction.js\":\"d6cdcaa009f33f7d\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/compileExtensionModule.js\":\"d74a3a48647c7101\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/compiledModuleCache.js\":\"b251b6f8e7879f7e\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/continuousGestures.js\":\"bc90636dfc01e112\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/core.js\":\"9ffc2d5cb85be8d2\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/defaultRenderers.js\":\"17838e3af89926ea\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/definitionFanoutAppMount.js\":\"a6925c871fc65798\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dialogAppMount.js\":\"5e9b8794683ef333\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dynamicExtensionSeeds.js\":\"214b58255b25d865\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dynamicExtensions.js\":\"39c93b2fdf0b2c5a\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/exampleExtensions.js\":\"1c28bd5c043f034e\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionApprovalStatus.js\":\"d23e04067b02a010\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLoadErrorToast.js\":\"4be750345e9d8eed\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLoadErrors.js\":\"a1b89779c7bb1b84\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLookup.js\":\"b444b407a41acd03\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionToggles.js\":\"87d3162a036d3dbe\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionUtilitiesCss.js\":\"d19ea07f8a02a026\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/kernelPageDeletionGuard.js\":\"108662f5e1cb8e1e\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/liveRuntime.js\":\"0777da752886d851\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/openExtensionsSettings.js\":\"7eb9874454ba21c7\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/overridesCache.js\":\"eef92c85f94ac680\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/pluginIds.js\":\"81b59ce0a626f2d0\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/processorRejectionToast.js\":\"8465f73c14a0e8db\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/runtimeActions.js\":\"76453e3d0ef914e3\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/runtimeContext.js\":\"1713725c6afcd566\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/staticAppExtensions.js\":\"8b8f41efde04f248\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/staticDataExtensions.js\":\"cb8408031f24eb96\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/toastAppMount.js\":\"a0712a7aad795b73\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/useOverrides.js\":\"82438bbd7a923888\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/useShortcutSurfaceActivations.js\":\"12be96a19f614f4c\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/discoverToggleTree.js\":\"1928b5a97f8143a7\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/facet.js\":\"029508084d1acbcb\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/resolveAppRuntime.js\":\"041046032612dccc\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/runtimeEvents.js\":\"5ac8e6ac9fdf72fe\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/togglable.js\":\"60dc2b936cb31262\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/variantFacet.js\":\"832755b56fc74c8b\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/verbFacet.js\":\"f98d8663871f7293\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/block.js\":\"fbb0400193b9ae18\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/focusedChild.js\":\"ff478abba2bf6caf\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/propertySchemas.js\":\"1010f1705fcffe47\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/typeRegistry.js\":\"ced3154f1eccb175\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useAncestorCrumbs.js\":\"64878b076929b21a\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useAutocompleteListbox.js\":\"4b055c1ae6c994f9\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useDebouncedSearch.js\":\"efc485947d476f6f\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useDebouncedValue.js\":\"53f67112c8d8a190\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useIsFocalRender.js\":\"09f49f9cc1d68a3b\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useIsReadOnly.js\":\"928048552acfcfc6\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useMaterializeBacklog.js\":\"7c68ea4bd2f9f576\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useMinuteClock.js\":\"5c75f781960bfe5d\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/usePanelLayoutProjection.js\":\"7128a86929a25514\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/usePendingInvitations.js\":\"5f27feb8428e2b2b\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useRendererRegistry.js\":\"b00f2ff6a20a8afc\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useRetainedFieldRows.js\":\"d6b108660ce0b821\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useWorkspaces.js\":\"5517d553872f39cd\",\"/knowledge-medium/pr-preview/pr-1787/src/lib/utils.js\":\"49b1bf5061e7ca08\",\"/knowledge-medium/pr-preview/pr-1787/src/main.js\":\"c755e73954d1f4b6\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/MarkdownImage.js\":\"3ad3e4acac4dbb59\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/blockSeparators.js\":\"760533508d815a2a\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/context.js\":\"81ab486dd75f8e01\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/defaultMarkdownExtension.js\":\"afe596fcafbfb478\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/extensions.js\":\"6f164b1fc7009368\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/renderMarkdownHtml.js\":\"0088e19d54ef562c\",\"/knowledge-medium/pr-preview/pr-1787/src/minimal-editor.js\":\"e10006a11b0f4db9\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/armedCut.js\":\"f13ccea3924e4d76\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/captureMediaVerb.js\":\"b1d1bc5fc24432b1\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/clipboard.js\":\"1059856050ad0594\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/decision.js\":\"789b697d9a4897da\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/operations.js\":\"87b7cafc4e107f20\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/account-header/AccountHeaderItem.js\":\"dcd93782b25af00f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/account-header/index.js\":\"565d1165c624caf4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"62fd89352d233939\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/askAgent.js\":\"ffb49de45288ac22\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/askedStore.js\":\"e5dafcbb279c279f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b3f10f9f2d4e555d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/chipState.js\":\"f64ad41c6a605923\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/dataExtension.js\":\"eb0c2a59bfe8215a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/index.js\":\"ad50acb089cfb4a4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c4ea594b87470cc7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/schema.js\":\"dc646bf40e6047fc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/AgentTokensDialog.js\":\"657a3f90191b2863\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a15790b097cca6c4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/addMedia.js\":\"c677d31bf18e8610\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/backlinks.js\":\"82e0ae6377cf2934\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/block.js\":\"26a257fbf993c6e3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/context.js\":\"f6e1139c50c34691\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/displayIds.js\":\"993cf8892ea5591b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/index.js\":\"0d5f6a2327476dbb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/outline.js\":\"b555d19ad85db0ce\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/properties.js\":\"5a56b7f924ac5d7f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/refs.js\":\"1406c668f7f7b683\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"190c4332f0406846\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/search.js\":\"957442e8ec22ad02\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/shared.js\":\"c9ef94faf2d864b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3692a02c1267ea90\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/text.js\":\"9b3e8860b544151b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentWrites.js\":\"0c24267993fa1017\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/authoringCatalog.js\":\"f382e44faa63ee6c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/blockRefTargets.js\":\"6c3efc2429ba34b0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/bridge.js\":\"0a420140cec88959\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/bridgeLoop.js\":\"60a3d597060c823b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/changeHistory.js\":\"d82fb352aaf6285f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/commands.js\":\"c31d2355bfd8f3d9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/commentsCommands.js\":\"47aa34cf4bb9d891\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/dataExtension.js\":\"9de4a543e6557e23\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/dataModelGuide.js\":\"e7dd289774660a36\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/describeRuntime.js\":\"d26c8b73d9edd2e3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/extensionLint.js\":\"754c2bbd07812b92\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/grainAudit.js\":\"1865d338386e25e5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/healthCommand.js\":\"70b399518c005efc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/index.js\":\"cebbea575a4fde1e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/presetIdentity.js\":\"115efb6ca7b76dcf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5fc4b2179aa0196c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/readMedia.js\":\"7e0d5f91affe5450\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/schema.js\":\"c2e663e308de69c8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/serialization.js\":\"c3d9f925b1281445\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/targets.js\":\"52e06c428b8d835d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/tokens.js\":\"d33a4f617b6941b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/watchEvents.js\":\"3c5b3f3ccad07488\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/workspaceGuard.js\":\"557e51205a2ce7fd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/writeCommands.js\":\"dcf29c8fb839747f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/AliasCollisionToast.js\":\"f971d3dc4a732092\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/DuplicateNameBanner.js\":\"cb6d46247d902dc0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/collisionMerge.js\":\"6fa4a13860f84b07\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/dataExtension.js\":\"c43e442b74d14aa4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/index.js\":\"839c03550bb6fc85\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/mergeCollisionAction.js\":\"4e7c61fd3eeb30dc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/pageStyling.js\":\"61b71ac41d458b4e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/rejectionToast.js\":\"eb6de66b2814e478\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/syncProcessor.js\":\"9a3803748bbddc63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/actions.js\":\"ba63fa6577ed1e4f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/addComment.js\":\"4b8453dd2ee77ae5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/anchor.js\":\"ca01863f4b81937a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/anchorState.js\":\"81617a642512881a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/commentLinks.js\":\"124099ae3bdb89da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/confirmThreadDeletion.js\":\"8e1c2f94322d3d56\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/container.js\":\"ee8e088ff0c18bdc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/dataExtension.js\":\"360d548ff4765546\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/deleteComment.js\":\"62584fcef750978a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/highlights.js\":\"a21add771fc2d1d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/index.js\":\"760b218ae4283516\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/linkedCommentsPill.js\":\"f584ce2056e2dc65\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/margin.js\":\"51a861217980bca0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/marginSchema.js\":\"d295179e9d158fe8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/newComment.js\":\"e15dbc2988503714\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/ownThreadPicker.js\":\"e1a3a104bcde30b1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/placement.js\":\"f189f3a93e620b4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/queries.js\":\"ceebb40f30ac0efe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotePosition.js\":\"5e9dfaeb30c7da0d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotedIn.js\":\"0019bce11bd6e5bd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotedRange.js\":\"bccf8b9281199b80\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/rangeRefs.js\":\"60e1f4fb9b2d01fd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readHighlights.js\":\"d072b49b46279f30\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readSelection.js\":\"daf331da0933bb93\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readSelectionUi.js\":\"8bd3e585c4eee066\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/reanchor.js\":\"9e5b7ec976e050d3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/schema.js\":\"06ee7b5cfa9f3a2c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/scope.js\":\"73574340f45221d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/scopeThreads.js\":\"7836459974ef9e27\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/splitRetarget.js\":\"53d6ac6c34f47ab1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/suggestionCard.js\":\"2bee4b576ca79f7a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/suggestions.js\":\"642b248134cd6f6d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/summaries.js\":\"93f694d0870c0e65\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/summaryBatch.js\":\"7dc0000275c71458\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/surface.js\":\"4ee97b823ff7027b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/threadNavigation.js\":\"daac1debc0cc128c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/threads.js\":\"3c6b0b230cc9c176\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/ui.js\":\"dd9955c8c7778eaa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/uiStore.js\":\"ae4dbe0e5e118670\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-intents/appIntents.js\":\"452906ae0b6c953b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-intents/index.js\":\"00345685c830d7c4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-update-prompt/index.js\":\"42bc262b984761f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-update-prompt/status.js\":\"28173ff280d11e53\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"09241aaa5672f787\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaBlockRenderer.js\":\"85d6208eca10cb25\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4fdf4919299dada8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaUploadReconciler.js\":\"22ecdd123fb12cb7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetDownLane.js\":\"6ba6292f3594b50d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetResolver.js\":\"dfc204aa5f616a60\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetUpload.js\":\"6fcfc425b3b9fd77\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/attachmentCleanerIO.js\":\"bf234d4299cd2bfc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/supabaseAuditIO.js\":\"241c884eefd521f4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/blobStore.js\":\"ff022df1e3297e96\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/byteStore.js\":\"5c1cfba6e57aeded\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/cleanerIO.js\":\"6e848491ca6c8942\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/cleanupAttachments.js\":\"eb789545b1cf348b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/dataExtension.js\":\"c174b4722d67b6e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/downLane.js\":\"d0c68abc2a1a95a5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/index.js\":\"3bb750479c38d91f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/insertImageContribution.js\":\"3d1ebeb71d87bbf7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/laneArming.js\":\"c4b2cf1932635d2c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/laneLock.js\":\"06569f9886a5d12a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaBlock.js\":\"26bdaf533a8845a1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaCapture.js\":\"27a41f2873b3f015\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaViewers.js\":\"9e66b185b9756eca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaViewersFacet.js\":\"be2eb9f7313ae5f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/pasteCapture.js\":\"49486dfc78ff5743\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/resolver.js\":\"4fa74b315ab87549\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/retryUploadsAction.js\":\"194d773ebc48f962\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/storagePaths.js\":\"e0ddc0944efedff4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadDrain.js\":\"7b6cb991c6f662e6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadLaneStatus.js\":\"cef7721c7c1b3a95\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadReconcile.js\":\"4d480823e6492b1f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadRecovery.js\":\"62ae3fb9cae384a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadStore.js\":\"9a5623d8b7d1435d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/useAssetObjectUrl.js\":\"45e4421f3b9a003c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6ba9e9ec0c0f9b80\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/BacklinksViewSection.js\":\"21ed2b4bee891a23\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/facet.js\":\"698b7f7714099a61\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/index.js\":\"fae7b870a7f9f13c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/prop.js\":\"8bbea57c5cd71e88\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BacklinkFilters.js\":\"5fcf8638dab76f41\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9c8b4291f2b1622a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BlockEntry.js\":\"46007143904a0749\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/LinkedReferences.js\":\"cbce22549e80461d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3384ab78df73b47c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/dailyNoteDefaults.js\":\"4330a864ef7c5b09\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/dataExtension.js\":\"3a73e36b5b0c3625\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/edgeExclusions.js\":\"ce08db54e0f259e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/filterProperty.js\":\"3e4feef4530e358f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/index.js\":\"93d6893e2f862e7c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ac1df5c8fa818e4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/applies.js\":\"2ba09d89c0d3aff3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/countQuery.js\":\"001a7cdf0e320c76\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/expansionStore.js\":\"49aa83a11d62d3a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/index.js\":\"e93f643bd68f973a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4af8c2485efd3809\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/presentationInvalidation.js\":\"c53a0af5240a206f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/propertyEditorOverride.js\":\"5188319ecf64004b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/propertyFilter.js\":\"5937cc186a72a82b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/query.js\":\"f6bd3dbf674e7c7c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/resolveFilter.js\":\"cd32709021bdcc5a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/sourceBatch.js\":\"6a0eb42200536a96\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/sources.js\":\"40b485ba282e1943\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/useBacklinks.js\":\"4448dc52c478631c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7033a0f83017e4de\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/BirthdayCelebration.js\":\"84c608037040985a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/BirthdayOverlay.js\":\"256d2511d5385758\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/gate.js\":\"5a0ae7ffc055f9c9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/index.js\":\"6fd1bb76ef1b7522\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/wolfTheme.js\":\"7116da5f2bc734de\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/BlockDragLayer.js\":\"53393b33e6e7e32c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/dragController.js\":\"6bf94f0cb6fbb1b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/dropTarget.js\":\"7de8d1cd55e8cc4b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/index.js\":\"4af89f7984d64d4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/projection.js\":\"602e0b4adb21c983\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-info/BlockMetaCard.js\":\"2dbfbd558b048b28\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-info/index.js\":\"347f2cfabbdd2466\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/AddTagDialog.js\":\"eebcf2bfdf22bbcb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1580c3627863fc90\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/TagNameIssueHint.js\":\"52ee005b7f5b4429\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/addTagAction.js\":\"60706213c54d16a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/appendTag.js\":\"5b3c24338d8682f9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/config.js\":\"d80715a6297478d6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/dataExtension.js\":\"f8587e9f9f6bf1a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/index.js\":\"810b317db0e3229c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/propertyEditorOverride.js\":\"680d32476adc7e58\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/BreadcrumbList.js\":\"525b1c8add748e2f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3930782d802652a2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5826217ddec0c82c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8dbc5f15b589056e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1f84a21535768313\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/index.js\":\"85766c912911cde3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"38a96e8db90bff48\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/CharacterCountItem.js\":\"0d191e8b808c6cbb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/ProfilePropertyEditor.js\":\"96f14d938edfea2d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/actions.js\":\"49acbfa67e764d74\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/blockType.js\":\"c6683c1fb328fad8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/charCount.js\":\"997950242133087d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/dataExtension.js\":\"312a15cd8fe40807\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/index.js\":\"ec7cce137d2d99c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/profiles.js\":\"c4befeeaa2daa103\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/properties.js\":\"e1b9b25030fc9aa0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/textCounts.js\":\"6cd466b69c094237\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/colemak-keybindings/index.js\":\"4f63742fb8506200\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/CommandPalette.js\":\"1f12938ac0add65f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/HeaderItem.js\":\"275226ac24e7397b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/context.js\":\"dc0e7aeb8c9e1797\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/index.js\":\"238882db8b46754f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/selection.js\":\"0cf985e8a3f07937\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/toggleStore.js\":\"5e9bb48076b7f1c6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/useCommandPaletteActions.js\":\"b231ec0b244effb1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/ContributorBadges.js\":\"e4bd901425825aba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/author.js\":\"db9002c75dcc63d1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/codeMirrorExtensions.js\":\"5a632514baa188c7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/dataExtension.js\":\"7f902aac8e389e89\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/index.js\":\"7b8b1df8f70b3ac8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/mentionAutocomplete.js\":\"08859878fd6fb656\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/processor.js\":\"d17e3c52121b4854\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/profiles.js\":\"7f6544a9a14044a5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/queries.js\":\"f4c5a85e7ee49bfb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/schema.js\":\"9be2172a809e61fe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c44dc966f66f9fd5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e3a758965eb61e02\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/index.js\":\"02041a21b004ca53\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"654da97277194cce\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f96bd2c41102e46c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/CalendarGrid.js\":\"62a623481583a097\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DailyNotePicker.js\":\"92f55cf46ee40216\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"01ee7dffd2ac7ab8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateNavDecorator.js\":\"bfcca3584b761941\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateScrubOverlay.js\":\"7a6bdd0175da88d9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/HeaderItem.js\":\"2896fa39d6e020bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/ReschedulePicker.js\":\"ee7b0bd0c60ff132\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/SpreadDatesDialog.js\":\"98ef13767d8af7a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/actions.js\":\"ced7db82437776d6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/blockDateAdapter.js\":\"a518b0ea40d087a7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/calendar.js\":\"7dec438081336585\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dailyNotes.js\":\"f7a2b11fc677b561\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dataExtension.js\":\"dede918202fbb217\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubActions.js\":\"a75e7537b7d282f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubGesture.js\":\"4f6cdac21a284aab\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubGestureActions.js\":\"20a7a17d639b3bc7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubRecognizer.js\":\"379d7ca59951564f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/deletionGuard.js\":\"55dcccc228b8c862\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dueQuery.js\":\"069b951ad98aa362\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/index.js\":\"c83e98793f2c0e41\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/landing.js\":\"c00d92bfb1897684\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/localSchema.js\":\"7fcb3aa5b06da8ff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/referenceDateAdapter.js\":\"235c15eb75214db5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/rescheduleAction.js\":\"bbad5db0fd29bf77\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/schema.js\":\"4ceb6b58559d033f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/spreadBlockDates.js\":\"319df28555964530\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/spreadDatesAction.js\":\"cca06391b69bd682\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/today.js\":\"21d9063b929d2981\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ee00a9818b3cb121\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8d6d864dae3d66d6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/audit.js\":\"c0bdf1946b58b82f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/auditAction.js\":\"83ce662645224f9d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/auditRanges.js\":\"7b22a4589082d726\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/diagnosticsSource.js\":\"92bb3e05673bf1e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/divergenceScan.js\":\"c1cbf079091350c2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/index.js\":\"b6352a8db6ccb1a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/propertyChildrenChecks.js\":\"49c071089a0f7c7d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/referencesMirror.js\":\"b088d73128e5daeb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/rowJson.js\":\"e2c8ef07fdd45df2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/schedule.js\":\"d3528ad6897a83ef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/store.js\":\"6f648378cc312617\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/action.js\":\"270330ed0180a0c4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/index.js\":\"fcff5d46e849da5a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/plugin.js\":\"579a47e73c4c1281\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d7aaccdbf763e61b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/actions.js\":\"d14a0783c72868e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/changeMarker.js\":\"15e655b71fad92b8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/diagnostics.js\":\"ca2e350804057d83\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/fileSystemAccess.js\":\"159e17911a1fa061\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/filenames.js\":\"5e9d2b0765d91f5a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/index.js\":\"a6d03c970eafd7af\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/mirror.js\":\"d535c87de1bd302a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/runLock.js\":\"b856f107bc1a5655\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/runtimeHealth.js\":\"29d3735be51bbdf1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/schedule.js\":\"35f9741a6f805de9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/store.js\":\"c8a5b73ae664657a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/default-themes/index.js\":\"4a40a6439d4a8606\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/default-themes/themes.js\":\"26aa8913374db379\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/diagnostics/facet.js\":\"1ffb1557499b5be8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/diagnostics/useDiagnostics.js\":\"f4065ff34b6f7761\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/dismissals.js\":\"28cd0c0a50779c57\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/index.js\":\"7ba1f43443aea6a8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/status.js\":\"232e78f6d5782469\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/store.js\":\"d4bb23398a07ab54\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f974e505f13a9b35\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e24f56e8b3fb7828\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/actions.js\":\"303e79578588119d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/config.js\":\"75469bacd9b3eff5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/dataExtension.js\":\"1361e72a32b6ccdc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/effect.js\":\"2a5b27f5853e960b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/index.js\":\"c414a5dc009b054a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/propertyEditorOverride.js\":\"e8f14454d6f5ada0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/useToggleTree.js\":\"ea43cbae801c0656\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/ExtractTypeDialog.js\":\"8a204828c330ca1b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e3783d00ae88842a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/PropertyShapePicker.js\":\"753ef642238ef140\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/action.js\":\"3d946409bc248954\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/index.js\":\"319ba6f950f72201\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/FindReplaceDialog.js\":\"42008742babb7f95\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/HeaderItem.js\":\"f30e89d89cc30b9d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/dataExtension.js\":\"82ff77717927c05e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/index.js\":\"ec849d1e29b08937\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/search.js\":\"ee9db5e5168f0bdd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/toggleStore.js\":\"a49b39ffb6c880c0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/LocationPropertyEditor.js\":\"8f09801a25e1cc39\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/MapView.js\":\"f513ee04655cfe76\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/blockTypes.js\":\"77e3d251483a797b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/codeMirrorExtensions.js\":\"474f02e3a691022f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/createOrFindPlace.js\":\"288be08e0fc704ef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/currentLocation.js\":\"40d1f555cbc37bb2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/dataExtension.js\":\"de175ebecd9a5bb1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/geoContentDecorator.js\":\"6a670da8dfc69c7b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/googlePlacesClient.js\":\"85e2232446869af9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/index.js\":\"e3473075433ea4c4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/locationsPage.js\":\"3145c51cc055d7b6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/mapViewport.js\":\"daf4f76d02514589\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/pickCurrentLocation.js\":\"14ba2fc655a48a02\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/placeAutocomplete.js\":\"9f3e021861f32de0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/placeNameCollision.js\":\"d55c9953b74296f8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/properties.js\":\"b8d1147f75f9f477\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/propertyEditorOverrides.js\":\"31850ed32eb56ebe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/query.js\":\"7355484bacdb0e22\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/usePlaceSearch.js\":\"58f2f93ee7fac6bb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7056ae3de5efcc39\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2942c81b04056161\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0259af774e83966e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/config.js\":\"1bd543836d8e6749\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/dataExtension.js\":\"5c2b779e365541d6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/facet.js\":\"41ed6959c945cf79\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/grouping.js\":\"81e4c98106b86ebd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/index.js\":\"6d0cfe9dfa3c136e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1d79cbe6facad4a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/query.js\":\"44bade6426a8a7f9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/resolveConfig.js\":\"c61d197695cbf9c7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9888149e3698622e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6963b781e2f13d4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/HtmlDocumentContent.js\":\"4e7eee6b7511edf1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/HtmlFrame.js\":\"78c3edf8aeda5ff5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/actions.js\":\"8349d12849a1c370\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/blockType.js\":\"b42dd053da6639aa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/confirmRunScripts.js\":\"be19149ba0220707\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/dataExtension.js\":\"9160bb7d43a1570d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameAnnotations.js\":\"2ec9a6f09f669874\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameDocument.js\":\"4d9e29396de4715c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameTheme.js\":\"f4a93723f34e7537\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/index.js\":\"666c0553fe7f9c9f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/scriptConsent.js\":\"854a80560c7b7cf6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/sourceMap.js\":\"847122e83160b670\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/useDocumentScripts.js\":\"241edfc26b32778c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/index.js\":\"171726089a1e38af\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/record.js\":\"8f71d21fd3f02ae6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/recordStore.js\":\"237693e6d80cacfe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/responsiveness.js\":\"75ace6440bcb1f09\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/schedule.js\":\"e59a043682c9d195\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/sessionContext.js\":\"0c85b8b8b7491f93\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"01ed2d8030de8b63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2653d903c95ddae5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/actions.js\":\"f142d9dbbd0eadbe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/config.js\":\"1b3daa29735d76e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/dataExtension.js\":\"5cab722f9c4baf82\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/effect.js\":\"62a22aae74ec1bba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/index.js\":\"a95d708ef82f6daf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/keyCapture.js\":\"afab3ffe89e62e1a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/overrideStore.js\":\"154f1aaee3230e82\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"070ede71c6c75841\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/HeaderItem.js\":\"8823710431fb16a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/LeftSidebar.js\":\"2410ef87e5626d8f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/actions.js\":\"bc09b1ee27298c6e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/facet.js\":\"b8da18e9779e3357\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/index.js\":\"7434da007e3cdc44\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/shortcuts.js\":\"f273313912117de7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/toggleStore.js\":\"7bf3042f2a0c1433\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/MergePicker.js\":\"dff7a1efd98cf629\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/index.js\":\"47d4db3c78de7539\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/mergeAction.js\":\"a94988b256915ea0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/strategy.js\":\"0f64ba10d278193b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/Button.js\":\"df2d7edd1a97ed44\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"994355e15bdd421a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/defaultItems.js\":\"904e626cf056fe21\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/facet.js\":\"bd60797c8541f4f6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/index.js\":\"9529b1ee30c6e86d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1ef84a59642de7e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8adf361c948de320\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6c70efbfe35d2afe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/facet.js\":\"067034a0b2ac1981\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/index.js\":\"6acd44a7f8bc71ab\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/MoveDestinationPicker.js\":\"724ed13c6cb51942\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0d254b0511c32a98\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/contextMenuItem.js\":\"ee1737c08ec7a1cd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/index.js\":\"a943f3a2634dacd5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/moveAction.js\":\"0fe3d815d0685d0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/moveBlocks.js\":\"28c679065f712c58\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/selectionAfterMove.js\":\"0d731c8ee9a817dd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/TutorialBanner.js\":\"9faec13b94149ef3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/action.js\":\"84212af15199704a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/bannerDismissal.js\":\"48d2054fd8da0852\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/documents/cheatSheet.js\":\"ed5f8239107bbbcc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/index.js\":\"fe14715b0737f6f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/keys.js\":\"aafa60022445aea3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/landing.js\":\"10a57c3c7471e67f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/outline.js\":\"2ed987bf3ee27ae5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/seed.js\":\"37e2ac6c9011fe4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/PerfTrendDialog.js\":\"51a2d31bfd6d5b0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/analyze.js\":\"e13d3b58be9d922e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/diagnosticsSource.js\":\"c6ead46f406d696c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/index.js\":\"d07da142fa58efbb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/load.js\":\"0d272872b2d5dfef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/monitorRun.js\":\"d101dd651f35bebc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/schedule.js\":\"2a2960d53a5af216\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/series.js\":\"a0966c5c1149c950\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/store.js\":\"f9304892431bf1f9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/trendAction.js\":\"5b71637de125944e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/verdict.js\":\"c6f3a837543d8b50\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/clickToEditAction.js\":\"e2ce5d155de45816\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/index.js\":\"2a988ef9206d94be\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/interactions.js\":\"9e8267c893919c92\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8171404bc6b491ba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/MigrationGate.js\":\"3c9fb0bd2138801c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/MigrationGateDialog.js\":\"646728fb92960546\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/action.js\":\"b439a45a777f16b3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/index.js\":\"ea19fb1efc0ce83b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/localRunMessage.js\":\"07f6a5aff08f470b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/plugin.js\":\"f344b7fc424204b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/progressReport.js\":\"ee269387c5ee8159\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/sweepProgress.js\":\"b5bd512dd03b4561\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/FieldRowRenderer.js\":\"0754655a346a8ef5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/ValueRowRenderer.js\":\"822ada2d9da498f4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/actions.js\":\"b806bbf787771eb5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/autocomplete.js\":\"178bb4aef0c2aa8a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/fieldRow.js\":\"a3bc3c348e8f2175\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/index.js\":\"2b9ea2e7903d3de5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/referenceWarning.js\":\"7aea96d13d57602f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/valueAutocomplete.js\":\"b01db7361eadb396\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/valueSchema.js\":\"900f5369fb9c4dd4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/HeaderItem.js\":\"717d1e5398b3d14b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/QuickFind.js\":\"756f05d51e6f992b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/index.js\":\"46f46596e0532c10\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/recents.js\":\"76b74ec73017b897\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/resultItems.js\":\"7d04839f670b0789\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/selection.js\":\"cae569af6b860554\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/toggleStore.js\":\"d84e1110429fbe9d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/HeaderItem.js\":\"9294cb783550e285\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e483dc5f0d0af362\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/grouping.js\":\"4eee4bd7316153ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/index.js\":\"ea41a8ab21c44bc0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/target.js\":\"ed82cf4e5014ca17\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/codeMirrorExtensions.js\":\"d93f319de55edc35\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/contentPrefill.js\":\"7731ad6fe4663f26\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/dataExtension.js\":\"79ae6753fe763000\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/index.js\":\"0e668838d9937aed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"fbc6424bf5401efe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/invalidation.js\":\"913ce9d1b834eceb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/localSchema.js\":\"a46e3d7b38fe9b98\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/blockrefs/index.js\":\"6c5b83e95de37661\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"88053dea4ce47f2a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/index.js\":\"35fa6817d1493625\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/referenceNode.js\":\"b757b2f29344910c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/remark-reference-occurrences.js\":\"484a0c34df9aa8fb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"28d571edc21fa079\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/index.js\":\"ff78fb38197f104f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"75b0c6ea3e78226b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6f60f4fe271708dd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/mergeRetargetProcessor.js\":\"e50f2b31b692f6f1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/parseFence.js\":\"a14bf6e64a36e895\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referenceParser.js\":\"275e2b5c12991213\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referenceProjection.js\":\"c4ed5015555d14bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referencesProcessor.js\":\"770824b56bf5e7d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/renameProcessor.js\":\"1671e15f29bc09a4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/spanReplacement.js\":\"d51d7c31551e3850\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/htmlToOutline.js\":\"4471e6617cb368aa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/index.js\":\"011165e4da6e0af1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/normalizeClipboardDom.js\":\"325cc1c683aa51dc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/pasteDecision.js\":\"6db97cf3d17cf595\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/action.js\":\"6c1068c6956356a7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/blockIds.js\":\"629b2db46b8436bb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/content.js\":\"712f9a2cfc182285\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/effect.js\":\"283e6411b6db15ee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/ids.js\":\"d7f579b399333a1a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/import.js\":\"b590c74f63976808\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/index.js\":\"d5fe4199242b6a5f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/plan.js\":\"2e1e345a4e3d1a34\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/plugin.js\":\"85480e4350e4393e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/promotion.js\":\"43f4ad28a974bd00\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/properties.js\":\"d44549f029c0b973\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/references.js\":\"c9291d53cf539514\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/report.js\":\"decacf710849af0e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/roamMemo.js\":\"c1e3da17d652c381\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/runtime.js\":\"1676d4a2e06ab8f1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/schemaReconciliation.js\":\"e87461e8d00fce5c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/srsMarkers.js\":\"ae09439a3ae8d7ac\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/todo.js\":\"1419e8e8fde5348f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/typeCandidates.js\":\"f7977c40fff09b3d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/types.js\":\"cc8574ec2222b1d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/search-health/index.js\":\"97606b3724ef4d5d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/search-health/store.js\":\"8349fab79deca48a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/HeaderItem.js\":\"015494e6f59c0984\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e5e8f1a156353f22\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/index.js\":\"9105825145d20150\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/model.js\":\"07455817997f71e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/toggleStore.js\":\"9479d56a55f39bea\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/useKeyInspector.js\":\"eb7db09fc7ba56db\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"de4f526f68887abf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/ShellDecorator.js\":\"49b8126e9cd5612f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/actions.js\":\"90f5b6b61a481b65\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5ed04cad55e4b523\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/index.js\":\"1447680b6ddc0d5e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/shell.js\":\"57abcb3403b5e2f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/surface.js\":\"8b05d51b5964efef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/walker.js\":\"b147ced90466fe74\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7b69d5ad410a5c6a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/dataExtension.js\":\"366cc15ea6d7cead\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/index.js\":\"c8556e75e5cfde15\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/indicator.js\":\"642a5436c5024355\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/moveSrsState.js\":\"492326b3b976e1cd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0ebd3ce7067364e5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/scheduler.js\":\"ceb0c8b3079d0028\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/schema.js\":\"d07f317ff8745da3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0c3bdf36f5507895\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/srsClipboard.js\":\"f02feb0d59fb1b5f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d674d10f97ae8631\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3dc7fb70c7bace85\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/DeckPicker.js\":\"05a7a1451a0cb7d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewControls.js\":\"0ad5398cb551c70e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewDeckRenderer.js\":\"92f46fb86b2e22ea\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewSession.js\":\"1ed36ae4339c22da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/actions.js\":\"215eb10c4e0dfa5b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/archive.js\":\"8ebf14e6c28f458b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/dataExtension.js\":\"6cdc1ec6438977e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/deck.js\":\"fe886a9839a05d61\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/dueQuery.js\":\"393d25888508c22e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/gradeDecision.js\":\"287af65651df0ba5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/index.js\":\"b8c9a3ef30de0006\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/keyHints.js\":\"e77d7df0e49b1527\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/reviewCardLayout.js\":\"30807220f6208864\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/reviewProgress.js\":\"575c405427320a1c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/schema.js\":\"4d449b4934e84df2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/useDueCards.js\":\"811e7aa41bda19c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/startup-metrics/index.js\":\"1240cab8d5a0a4b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/startup-metrics/record.js\":\"26a749434c2894e3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/index.js\":\"639b7a139f85e122\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/persistenceStatus.js\":\"153ead7d56487e63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/requestAction.js\":\"c69662b76f0f8f4a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/TypeChipsDecorator.js\":\"5acecbe93e7eb26c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/codeMirrorExtensions.js\":\"7f5f96dc5b9e052a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/index.js\":\"d1a4a2d66589c548\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/typeAutocomplete.js\":\"6c52b1dd744d87c6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a536aec94f1e5ed2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/actions.js\":\"5550b0474f2ec85a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/anchor.js\":\"a14ce96602859f71\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/events.js\":\"36bb4fd2376883e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/gestureActions.js\":\"a5f44894ef1c852b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/index.js\":\"6cc96bf5796e365c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c0232a92473aee6f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/collect.js\":\"8072c15be1080a09\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/index.js\":\"a75e85a3cf92e469\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/record.js\":\"549b1d97057445a3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/RejectionDialog.js\":\"0e8c2aa616276b57\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/SystemStatusHeaderItem.js\":\"06d9d24e0f730425\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/index.js\":\"485e754146da26c9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/model.js\":\"53963a0d5342e7f4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/queueCounts.js\":\"48c6938133e34e44\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/rejectedHelpers.js\":\"08b2cd3b34d9ea01\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/rematerializeAction.js\":\"2970241960c0f920\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/useHysteresis.js\":\"ef328e67f901e9da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/effect.js\":\"bc92c5bb85c32fae\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/index.js\":\"63e5ebb2b5dc52cf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/theme.js\":\"4406adef56c758c8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/actions.js\":\"2c13d7216b3de4f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/dataExtension.js\":\"063750dccda22e24\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/index.js\":\"97015771b73d5d21\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/schema.js\":\"bea2beabd7267e82\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e6059e1a7944b2ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/actions.js\":\"a3e9b7029a92d1a7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/defaultItems.js\":\"fbd900d4b240c33e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/facet.js\":\"a687c8e855535ed3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/holdRecognizer.js\":\"ed6d23ba2dda38c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/index.js\":\"c0b443800db24cf1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/UpdateIndicator.js\":\"17cb281abed2074b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/index.js\":\"5060129f21640e27\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/loadTimes.js\":\"8edbd99d6a915d69\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoNotesRenderer.js\":\"f19405bef68deb12\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoPlayerRenderer.js\":\"884ae0d01223c0f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoTimeStamp.js\":\"c3d475b9b6b4130e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/actions.js\":\"4dc6d7fa150eccec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/index.js\":\"f8336e3ad9934c54\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/markdown.js\":\"c168f33933cc9da1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/notes.js\":\"ec4f1cd90ea6e8f7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/registry.js\":\"7176103b1812dd1b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/remark-timestamps.js\":\"a12cb676b660810e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/view.js\":\"7dddc2893d80832a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/LinkHints.js\":\"b3601240607fb48e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/index.js\":\"5dd0253fc3b6bd3e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/model.js\":\"5bc364fd652aff67\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/settings.js\":\"ed7326c7b896c425\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/actions.js\":\"9b946b9df7f652f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/index.js\":\"54c9a790479016dd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/interactions.js\":\"e5e4887d87a3546d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/workspace-header/index.js\":\"6293213824e56718\",\"/knowledge-medium/pr-preview/pr-1787/src/registerServiceWorker.js\":\"4cc50e86093af4b2\",\"/knowledge-medium/pr-preview/pr-1787/src/requestPersistentStorage.js\":\"e17161930969eaf6\",\"/knowledge-medium/pr-preview/pr-1787/src/services/authRequestDeadline.js\":\"0062266afbccaf65\",\"/knowledge-medium/pr-preview/pr-1787/src/services/authStorage.js\":\"4d89c559b37c6ea2\",\"/knowledge-medium/pr-preview/pr-1787/src/services/powersync.js\":\"f49886a732dcf7cc\",\"/knowledge-medium/pr-preview/pr-1787/src/services/supabase.js\":\"50372cee6e702ab5\",\"/knowledge-medium/pr-preview/pr-1787/src/services/uploadErrorClassifier.js\":\"001f2ffd31ab535b\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/ActiveContexts.js\":\"08be319f731b2d56\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/HotkeyReconciler.js\":\"1323c1ac25b6cbea\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/WipeLocalDataDialog.js\":\"de6bffb0e36569d5\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/actionDispatch.js\":\"e83993918876c014\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/actionRefItems.js\":\"98cd47475c74a8dc\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/applyKeybindingOverrides.js\":\"9fb6411c31ec4ecc\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/blockActions.js\":\"0f7b79afae35a95a\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/canonicalizeChord.js\":\"b16260ae6bf590cf\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/defaultContexts.js\":\"da0afeabd0b44529\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/defaultShortcuts.js\":\"86a077b63426144a\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/effectiveActions.js\":\"0b20aa38c15fbd2b\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/gestureAction.js\":\"5915daf9cef8b10c\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/gestureBinding.js\":\"0c4a18cb6ad5bd3a\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/holdRegistry.js\":\"471edf5c93645274\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/keybindingConflicts.js\":\"3e25cb6a25513e7a\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/keybindingOverrides.js\":\"20de877d3fa03504\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/pointerAction.js\":\"155f254b2c90687b\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/resolve.js\":\"0a52d70c35cbb024\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/runAction.js\":\"0c045cfc7bb5b293\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/sequenceMatcher.js\":\"ec12f4bdc67815c0\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/types.js\":\"e07879d142a4bfdc\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/useActionContext.js\":\"0e75ddc25fb14222\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/useActionDiscovery.js\":\"3ceddc27f58a4837\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/utils.js\":\"26531d19cb2a2550\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/bootStore.js\":\"4719fc3df5203dd7\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/previewDatabases.js\":\"0153240c987c611d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/byteTransform.js\":\"77e00b41608af6c5\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/attachmentCleaner.js\":\"cd42c757eb864ff0\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/attachmentParts.js\":\"ec984813ccc6991a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/bundleParts.js\":\"0045865e7c0d87bd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/bundleRecord.js\":\"c19ac6822cec7b79\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/manifest.js\":\"74f44bf843b9a0ee\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/takeBundle.js\":\"2b06957b23c93fb1\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/verifyBundle.js\":\"0f88ec59e226c44e\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/cleaningStage.js\":\"77972940d7dca790\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionKey.js\":\"6d1212957214b97d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionServer.js\":\"74f258ddf4830ac4\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/flip.js\":\"930419be4e2238a0\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/flipAttempts.js\":\"8fa2fef846cb4592\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/pages.js\":\"cf31452cae87f8ef\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/preflight.js\":\"fc1c7761bb1e1243\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/reseal.js\":\"705e316ca8c3d333\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/runConversion.js\":\"58f4d1bf2c9551ee\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/runLock.js\":\"71a10e6565991b4a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/sealing.js\":\"38e7530f25b5e018\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/sealingStage.js\":\"c56786ade956d57a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/stage.js\":\"2008702bef4c5e80\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/verifyReseal.js\":\"e6bcb35e6c54e016\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/aad.js\":\"c224b1c2cf9dff1b\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/aead.js\":\"f6c887cdfc1dfdc2\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/base32.js\":\"c5437fc7b9ba2f62\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/base64url.js\":\"c16d2888f806bb08\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/binaryEnvelope.js\":\"64ce9839174d7cf0\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/byteAead.js\":\"d46c576be0219ed2\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/canary.js\":\"c85688b5e00df35a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/contentHash.js\":\"f6eeec7c8fa8fefd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/contentKey.js\":\"b0c9ffb7bc964490\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/derivedIdNamespace.js\":\"8f1bd6887c2ad4f4\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/envelope.js\":\"6dc42f46832e0078\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/hex.js\":\"db94e81e3c3d12b0\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/sha256Hex.js\":\"6bbbf09ac7f17935\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/workspaceKey.js\":\"ce4b53c70e3b3e03\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/conversionState.js\":\"912be32257707784\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/createEncryptedWorkspace.js\":\"676139ce4d1dbc69\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/pastedKey.js\":\"0c1434e052cf8d85\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9b520f8e326db47f\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d02c76ba3c536dff\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/keyStore.js\":\"4c64005f22eae3de\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/mintWorkspaceKey.js\":\"2c8cd4b637fbeb6f\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/modePin.js\":\"3dfd8e2717686d5c\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/openWorkspaceKeys.js\":\"f2f7c7e3729475f8\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/resolveWorkspaceEntry.js\":\"c4ffe00460012bfe\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/resolver.js\":\"0e970e37924f141d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/workspaceAccess.js\":\"cc52ea5e67059803\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/transform.js\":\"17c471c730122038\",\"/knowledge-medium/pr-preview/pr-1787/src/themeBootDefaults.js\":\"3becd88a6a484cd3\",\"/knowledge-medium/pr-preview/pr-1787/src/types.js\":\"baf23fb602e5d88e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/ClientLocalSettings.js\":\"3da66f3ad3f704e1\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/abortableSleep.js\":\"dfee920ccbd88b9e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/array.js\":\"f21d249ad9ec651d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/backlinkAutocomplete.js\":\"9401562858466575\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/blockCrumbs.js\":\"10a0440699c0dccb\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/blockrefAutocomplete.js\":\"966cd567879cdabe\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/cadencedIdleJob.js\":\"6137d05a49e28d37\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/callbackSet.js\":\"bdead82715a49843\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/clientId.js\":\"da47e077e17447a8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/codemirror.js\":\"5d6e577e76ada4b9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/codemirrorCompletion.js\":\"d6eab5d8b3878609\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/copy.js\":\"b4eb0da7d9e0c615\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dailyPage.js\":\"485ac3776fb62ec9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dbForensics.js\":\"a3254872fe53a3d6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dbForensicsHooks.js\":\"f1932f12f3c1f719\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/deleteBlockThroughUi.js\":\"fb35b7526570c288\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dialogs.js\":\"7be0b5fc30ec4f62\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dom.js\":\"e6d7da4c16bfca08\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/downloadBlob.js\":\"0a94de763b87acd4\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/exportSqliteDb.js\":\"5cba9907b85bc32e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fileSystemAccess.js\":\"4a9dfe0d74d6d5f2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/flipSlide.js\":\"4445959758bca6a3\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fnv1a.js\":\"68f41354b0c5420b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/formatBytes.js\":\"ebe9f0968690f275\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fuzzyRank.js\":\"031e0926b3db6e7c\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/idbKeyedStore.js\":\"21f10b64e2967586\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/idleCallbackPolyfill.js\":\"2fbbe59c2ee80c37\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/keyboardAwareScroll.js\":\"f4f1160e6490b83d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/keyboardViewport.js\":\"e87927373a77e34b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/lastWorkspace.js\":\"dae335adc78499ec\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutColumns.js\":\"5afce2eedc9d3d9a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutSessionDom.js\":\"4fb521956d60d35a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutSessionId.js\":\"dc024c3064fb3dcf\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/linkClickGestures.js\":\"9c08d64a182961e2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/linkTargetAutocomplete.js\":\"93eb7baa42db8223\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/localDbCorruption.js\":\"7d51f1c545546c55\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/localDbRecovery.js\":\"85808ba5871abd7e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/markdownParser.js\":\"713c593e10b5255a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/memoize.js\":\"132b252077f12d0b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/nameFieldCommit.js\":\"a9a26f0aa3c869b8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/nameList.js\":\"33fb8684801d0937\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/navigation.js\":\"a57cd4dc6c8fe02a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/omnilinerNamespace.js\":\"de0919a80edecf5b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/opfsPageScan.js\":\"48d075af01fe829d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelClearance.js\":\"bc6f3b774f9c9b21\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelHistory.js\":\"ca0e549405aa3e8d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelLanes.js\":\"56244bc237db0dd8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelLayoutProjection.js\":\"ca9eb4852de9eabd\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelScrollAnchor.js\":\"7e6d08d2102148b2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelUrlFlags.js\":\"8e5b08edc42ac150\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/platform.js\":\"a9a324e720616e14\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/pluralize.js\":\"e825957901c7dbd8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyCreation.js\":\"1e83167b4492baca\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyNavigation.js\":\"9c4c715ba234f1e6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyValueContext.js\":\"f465474b9b950526\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/react.js\":\"cacc991d0ec9f128\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/relativeDate.js\":\"696b118bf9d5cb47\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/relativeTime.js\":\"2fd5432837b45915\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/renderScope.js\":\"a450a8a93f0de9b3\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/resolvedThenable.js\":\"3f4890375303636f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/routing.js\":\"0c7d46832d399ed0\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/safeMode.js\":\"4183dc2ef17ad24a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/scheduleIdle.js\":\"12b87f886ee17619\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/screenWakeLock.js\":\"d82c3d042db492b7\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/selection.js\":\"e186fcfdc12ee0e8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/softKeyboardGrab.js\":\"86acd40832424b77\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/startupTimeline.js\":\"f4959236b29ae17d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/state.js\":\"52cabffb4db5ca99\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/string.js\":\"a683e2f3346849bc\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/surfaceZoom.js\":\"308023aae8af3c71\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/time.js\":\"d22e864a02ea7c36\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/toast.js\":\"182b6f5c8ecf06c1\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/toggleStore.js\":\"0e8f3b8c23e264e1\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/untilStopped.js\":\"356dbbb1f9c46636\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/userActivity.js\":\"57b4e2cfaf49b911\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/viewTransition.js\":\"0be1998f4759c0bf\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/viewport.js\":\"2f28096d28bc0272\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/webLock.js\":\"c538400e91063d8d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/workspaceRecovery.js\":\"71860e50c5aa7b3b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/workspaceSnapshotStore.js\":\"46c79f5acf99c0ed\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-compiler-runtime.js\":\"8fdf84a601c6efd3\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-client.js\":\"d11a5f67e521afe5\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-server-edge.js\":\"8427b89f752fa3c8\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-server.js\":\"f036f0bb106bfa3a\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-static-edge.js\":\"484e7a555bee3326\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-static.js\":\"037558f625a633f1\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-test-utils.js\":\"98782cf28b6b1e09\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom.js\":\"2e265329d336d855\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-jsx-runtime.js\":\"a02d132751df5ac4\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react.js\":\"478566d6c910f52f\",\"/knowledge-medium/pr-preview/pr-1787/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1787/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1787/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
