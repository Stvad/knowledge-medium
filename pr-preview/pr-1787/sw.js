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
		buildId: "5dd15bbd02d1-1a13a1db",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/\":\"c19ad64da7359dee\",\"/knowledge-medium/pr-preview/pr-1787/index.html\":\"c19ad64da7359dee\",\"/knowledge-medium/pr-preview/pr-1787/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1787/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1787/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1787/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1787/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1787/assets/FacadeVFS-BTlG6mWQ.js\":\"7ec53069f5a10ad4\",\"/knowledge-medium/pr-preview/pr-1787/assets/OPFSCoopSyncVFS-DO2paPH5.js\":\"9616567a6c0fcb1a\",\"/knowledge-medium/pr-preview/pr-1787/assets/OPFSWriteAheadVFS-Bd_6LIvq.js\":\"2436be71db65fd70\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-DnURvDU0.js\":\"b2f2e1b4ddcec7dc\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1787/assets/wa-sqlite-async-H_1qYQ0H.js\":\"40ded0764e1a1545\",\"/knowledge-medium/pr-preview/pr-1787/assets/worker-zHuWW5V9.js\":\"65a6cbad53b7fe18\",\"/knowledge-medium/pr-preview/pr-1787/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1787/chunks/app-B9-Lkc-1.js\":\"01da4c30bdb98c75\",\"/knowledge-medium/pr-preview/pr-1787/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1787/index.js\":\"58233d0a2dbdc91f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1787/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1787/assets/AccessHandlePoolVFS-Dp8_aHFg.js\":\"d194b6b43f361504\",\"/knowledge-medium/pr-preview/pr-1787/assets/IDBBatchAtomicVFS-pskAln_K.js\":\"1cc5c35cc5f0f877\",\"/knowledge-medium/pr-preview/pr-1787/assets/MemoryVFS-Db6vL6ic.js\":\"a3c592ef3b155201\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-DJXfyczS.js\":\"6f84490eac01e043\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-async-_2JV_9Vn.js\":\"0b9c0bc73c9ffeb4\",\"/knowledge-medium/pr-preview/pr-1787/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1787/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1787/chunks/AccessHandlePoolVFS-DEqZBTPN.js\":\"4a28e6678c7c5638\",\"/knowledge-medium/pr-preview/pr-1787/chunks/FacadeVFS-rT6YeyzC.js\":\"8bbc9d4406b5686d\",\"/knowledge-medium/pr-preview/pr-1787/chunks/IDBBatchAtomicVFS-CIQQohzD.js\":\"e7cfdbc13df625f4\",\"/knowledge-medium/pr-preview/pr-1787/chunks/MemoryVFS-BYJeIWur.js\":\"d5a3f24c4f97cd51\",\"/knowledge-medium/pr-preview/pr-1787/chunks/OPFSCoopSyncVFS-CW1jiiwp.js\":\"3a7eb9a44c049345\",\"/knowledge-medium/pr-preview/pr-1787/chunks/OPFSWriteAheadVFS-DnRuD2zV.js\":\"bb72bba5c1afb62c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/Preview-C4fFPJ68.js\":\"41235e8934012a0c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1787/chunks/card-DPVBIDP8.js\":\"9647a1ef55dba5bb\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-6Jzyw5uV.js\":\"0f1803fc9a0390b5\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1787/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1787/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1787/chunks/mc-wa-sqlite-BhMY7baG.js\":\"8995ef400ef36a2a\",\"/knowledge-medium/pr-preview/pr-1787/chunks/mc-wa-sqlite-async-1mGAWSwm.js\":\"915262ea86e17820\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-6nRpvkA8.js\":\"852e63cf59c3b276\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-BZp9tXss.js\":\"ae3401e4ec3a919b\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-BuGn_lPh.js\":\"c17401653dd62e30\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-CsPveREi.js\":\"8e3a461148e26e7b\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-D8hoagLO.js\":\"9c19827c791a3e04\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DF8DtjYD.js\":\"b86328c25cb5680f\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-DjNiKgKX.js\":\"cc1978ddd45fe053\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-Dn_FlgiB.js\":\"e8de0db5673e8f45\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server-legacy.browser.production-BLNjcn1V.js\":\"72b447f16154f41e\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server.browser.production-C1-3VLlc.js\":\"3c5dd997d5c14555\",\"/knowledge-medium/pr-preview/pr-1787/chunks/react-dom-server.edge.production-CmS3ApdH.js\":\"b335117ee1f067d5\",\"/knowledge-medium/pr-preview/pr-1787/chunks/server.browser-DvfwYTQT.js\":\"720f0a4e9a964602\",\"/knowledge-medium/pr-preview/pr-1787/chunks/textarea-BAhQRsEA.js\":\"516c39f200507a0d\",\"/knowledge-medium/pr-preview/pr-1787/chunks/ui-CF0nGQkU.js\":\"dbb90b3a86ae3490\",\"/knowledge-medium/pr-preview/pr-1787/chunks/wa-sqlite-async-CWub23EH.js\":\"4d762b69880bb0f6\",\"/knowledge-medium/pr-preview/pr-1787/chunks/wa-sqlite-zbcnP13q.js\":\"d761773155720821\",\"/knowledge-medium/pr-preview/pr-1787/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1787/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1787/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1787/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1787/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1787/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1787/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1787/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1787/src/App.js\":\"5f7a0dad346b80d4\",\"/knowledge-medium/pr-preview/pr-1787/src/appUpdate.js\":\"74939d795ace3c60\",\"/knowledge-medium/pr-preview/pr-1787/src/appVersion.js\":\"fe41dcdd5ec94e52\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/initialLayout.js\":\"0cfcf42e6be4b95b\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/openWorkspaceData.js\":\"86ca0ca665194854\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/resolveWorkspace.js\":\"0deab2d893a9cddf\",\"/knowledge-medium/pr-preview/pr-1787/src/bootstrap/workspaceBootstrap.js\":\"a80d154db2710189\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockComponent.js\":\"a2529ebeac969436\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockCrumbs.js\":\"33490771d00915c4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockEditor.js\":\"7e918bd7127be93b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockLoadingPlaceholder.js\":\"6f213a466f62eacf\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockProperties.js\":\"edcd16febdda7e91\",\"/knowledge-medium/pr-preview/pr-1787/src/components/BlockSearchPicker.js\":\"a040ce93d3cb73d3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ConfirmBulkDeleteDialog.js\":\"6f48d1ac258823fc\",\"/knowledge-medium/pr-preview/pr-1787/src/components/DividerHandle.js\":\"0a69f24f337db5cc\",\"/knowledge-medium/pr-preview/pr-1787/src/components/DraftEditor.js\":\"2e2b8f6f77cc5659\",\"/knowledge-medium/pr-preview/pr-1787/src/components/GutterPill.js\":\"88e85a071d237d65\",\"/knowledge-medium/pr-preview/pr-1787/src/components/Header.js\":\"489442ca791f5f43\",\"/knowledge-medium/pr-preview/pr-1787/src/components/LazyBlockComponent.js\":\"e9ebb4b45300554c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/Login.js\":\"9f308d5a163576df\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ZoomableSurface.js\":\"435d37e12fedbb33\",\"/knowledge-medium/pr-preview/pr-1787/src/components/editModeKeepalive.js\":\"84a7529a816a2cbd\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyDisplay/PropertyDisplayScope.js\":\"59f26937a6e5547f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"38b7ad1cc8441cda\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/RefPropertyEditor.js\":\"5fea1f1400e525f8\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/RefTargetTypePicker.js\":\"d361caba50a48a99\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/SelectPropertyEditor.js\":\"90db40d160edc8e4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/TypesPropertyEditor.js\":\"8633205a487d45c3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/defaults.js\":\"ec529be0094b68a6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/kernelValuePresets.js\":\"ee047f1e2c909f70\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/selectablePresets.js\":\"a88ca74d695a597a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyEditors/typesPropertyUi.js\":\"589aea8bc2eb0a46\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/AddPropertyForm.js\":\"6377e1bbe69ecd3e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/PropertyPicker.js\":\"e6cc0c52a6ad76f1\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/PropertyRow.js\":\"04992ce86e7736b9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/Rows.js\":\"6734f334733aa7f9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/actions.js\":\"ffce76ab07db43e9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/declarationOnly.js\":\"0b71533d9bebad50\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/layout.js\":\"348f7850601bd8a2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/model.js\":\"abd2390dd91c59f3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/shapeUi.js\":\"d2eeea463e829352\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/shapes.js\":\"9ff74558f4d61c6e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/usePropertyEditingActivation.js\":\"dbc98acb567b63ec\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanel/visibility.js\":\"b41d43c4cb033ea8\",\"/knowledge-medium/pr-preview/pr-1787/src/components/propertyPanelSections.js\":\"728f421828cc838a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockEmbed.js\":\"f6ea9b821f7ac05c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockLink.js\":\"07aa97ac3a6a885e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/BlockRef.js\":\"cbfa194f6ae3d03d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/ReferenceLink.js\":\"78a563302cb3a90c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/cycleGuard.js\":\"ef704ad14e43efc7\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/cycleGuardContext.js\":\"b7ba228f6d92c4a4\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/linkInteraction.js\":\"0d16c998b93e09d6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/referenceLayout.js\":\"27dd7b662009c2e5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/references/useBlockRefAncestors.js\":\"cbd616e5a1e5da48\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockGutter.js\":\"f40e7eff4d5f9c9e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockInfoDialog.js\":\"4f8e5473b40d8360\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BlockTypeBlockRenderer.js\":\"e85cbc8df1084fa2\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/BulletHoverCard.js\":\"634e7d307064416e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/CodeMirrorContentRenderer.js\":\"06970fad374177c9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"046c44d9782510a9\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/ColumnResizeHandles.js\":\"77d158d1d763be98\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bdf6a786db8efb69\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/DefaultBlockRenderer.js\":\"6d0cdf7a0869518b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/LayoutRenderer.js\":\"b00b98878ec84d5f\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/MarkdownContentRenderer.js\":\"703763e36b1d58f0\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/MissingDataRenderer.js\":\"02d25b062f950999\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/PanelRenderer.js\":\"c0f9aacc2929df2c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fbb4d512e09218fa\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/TopLevelRenderer.js\":\"3e97cfd549d821a3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/blockGutterMode.js\":\"854c297dce7cba39\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/blockTitleText.js\":\"5038488aec4cde76\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/fieldCreationKeydown.js\":\"bc1b28f6d6e7f971\",\"/knowledge-medium/pr-preview/pr-1787/src/components/renderer/layoutRootContext.js\":\"9c6a67e2ea21dc30\",\"/knowledge-medium/pr-preview/pr-1787/src/components/typeChip/TypeChip.js\":\"8d46fb5bc547fb67\",\"/knowledge-medium/pr-preview/pr-1787/src/components/typeChip/chipStyle.js\":\"e5c7cbf836f8c980\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/anchored-floating.js\":\"1276e914dfbed462\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/button.js\":\"20535ab07285f206\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/card.js\":\"db81393552b3081e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/checkbox.js\":\"c6d21e11704b8223\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/collapsible.js\":\"da6ac054ee574258\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/command.js\":\"2a3a05da353ea537\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/context-menu.js\":\"0480779760254011\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/dialog.js\":\"6d77e8507ffa13c5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/dropdown-menu.js\":\"c300054d435a9da8\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/floating-listbox.js\":\"a23158cd18d51681\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/index.js\":\"575cce93500aa6c3\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/input.js\":\"bcccc275a105d05a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/kbd.js\":\"3203b2b5bf716a83\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/label.js\":\"7db4e79348155504\",\"/knowledge-medium/pr-preview/pr-1787/src/components/ui/textarea.js\":\"a06b78d5dacfde53\",\"/knowledge-medium/pr-preview/pr-1787/src/components/useEditModeYieldKeepalive.js\":\"f1d02301a9c58a3e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/BootFallback.js\":\"a77e85d454fad053\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/FocusedRowLazyMount.js\":\"4556bcdb9ed9a6e5\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/LazyViewportMount.js\":\"16a5fa3a20ed4f81\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/LocalDbCorruptionFallback.js\":\"038b646a9f8ae9cf\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/error.js\":\"f1c3ec312a9c4e7c\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/lazyMountRegistry.js\":\"dc90d6f30c99d60d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/util/suspense.js\":\"aabd8edfa51a5740\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/CreateWorkspaceDialog.js\":\"034836e89782b844\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/PendingInvitations.js\":\"5ccb7479d9acdb32\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/SyncProgress.js\":\"ed2fb7c90514c18d\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/UnlockProgress.js\":\"8ba1557e2500b790\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceKeyGate.js\":\"c561276b1d8f9c47\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSettingsDialog.js\":\"7caef4a5fdf8a54b\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSwitcher.js\":\"78e51e2fa3189568\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/WorkspaceSyncGate.js\":\"b3403736de34d5af\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/ConversionFlow.js\":\"1da547e311ccf22a\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/ConversionFlowHost.js\":\"222eb3a849cc3696\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/EncryptionSection.js\":\"1fba34c8b2ab84db\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/attachmentPrompts.js\":\"ebfa5cbcd5cda08e\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/bundleFolderPrompts.js\":\"057fb430d9827ff6\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/conversionFlowDeps.js\":\"11ea9335d3187954\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/conversionFlowStore.js\":\"20d7968aef4af749\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/flowUi.js\":\"e37dfbd519189517\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/conversion/useConversionRun.js\":\"36a7f6820b7f82df\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/keyUi.js\":\"330180dc0dc70d88\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/useCloseOnKeyLoss.js\":\"26fb9ab8dc863e23\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/useCloseOnServerE2ee.js\":\"aea99812df31d7df\",\"/knowledge-medium/pr-preview/pr-1787/src/components/workspace/workspaceUnlocked.js\":\"7261fcb41ff39247\",\"/knowledge-medium/pr-preview/pr-1787/src/context/backgroundSubtree.js\":\"d68e4d21fb82607d\",\"/knowledge-medium/pr-preview/pr-1787/src/context/block.js\":\"0d2eed6f23762fe2\",\"/knowledge-medium/pr-preview/pr-1787/src/context/layoutWsContext.js\":\"3c33f188e9d228d0\",\"/knowledge-medium/pr-preview/pr-1787/src/context/propertyDisplay.js\":\"c82fdc7f635c7df2\",\"/knowledge-medium/pr-preview/pr-1787/src/context/repo.js\":\"9f9914beabc1d5d9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/aliasClaim.js\":\"b6af0979d8dfa25c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/aliasSeatNamespace.js\":\"e94aa2a3620b2a27\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/blockData.js\":\"04079fee58f61831\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/blockType.js\":\"b31b6e627e73292c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/changeScope.js\":\"f726e17f5e410dd9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/codecs.js\":\"e5c65d22aea16325\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/derivedData.js\":\"71c0fa59004d3d6b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/errors.js\":\"0ba6942d71efeafd\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/events.js\":\"179e97d26834edd8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/handle.js\":\"0d95e0aea0cfde11\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/index.js\":\"4fb851779eca7736\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/mutator.js\":\"2ae8180511ec3531\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/processor.js\":\"2f0fc6ed627a6508\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/propertySchema.js\":\"942008a68368bcd8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/query.js\":\"d83bb3b1be81e771\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/sameTxProcessor.js\":\"4a12f47caeaeebd1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/schema.js\":\"0d95e0aea0cfde11\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/tx.js\":\"0d95e0aea0cfde11\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/typedBlockQuery.js\":\"13899cd86089bcac\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/user.js\":\"75bf9c1235b28f63\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/valuePresetCore.js\":\"66a8ecaa65225321\",\"/knowledge-medium/pr-preview/pr-1787/src/data/api/valuePresets.js\":\"fe956d394c005d5b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/attachmentCleanerIOVerb.js\":\"8bb568cc870e4a71\",\"/knowledge-medium/pr-preview/pr-1787/src/data/block.js\":\"dddf53d628bd4f65\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockCache.js\":\"b673a28efd653577\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockId.js\":\"86dc38df5499c297\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockLiveness.js\":\"e16e87804bdf0ad5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockMerge.js\":\"8dc1115acf03ee1a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockSchema.js\":\"839947fe4460aec3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/blockTypes.js\":\"78b4d75f52ad5a6f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/clientContext.js\":\"6ca9fd023492cae7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/dbFileSiblings.js\":\"b2a6cfd6f1eef4ab\",\"/knowledge-medium/pr-preview/pr-1787/src/data/definitionSeeds.js\":\"da09cc0899300155\",\"/knowledge-medium/pr-preview/pr-1787/src/data/derivedIds.js\":\"fdc5686bf8eeb369\",\"/knowledge-medium/pr-preview/pr-1787/src/data/drawnSubtree.js\":\"2fca5bc35b9d55e7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/facetBridge.js\":\"d0e66d16de69cfd4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/facets.js\":\"28efeaf1de927765\",\"/knowledge-medium/pr-preview/pr-1787/src/data/globalState.js\":\"8120084ce910fd61\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/aliasClaimRederiveProcessor.js\":\"81279d212e599606\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/ancestorBatch.js\":\"239e459ee907445c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/blockTypeTypeifyProcessor.js\":\"ab23c13d801dfeb7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/clientSchema.js\":\"344f268f7ac12660\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/commitPipeline.js\":\"4db565dffd37725e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/devAssertions.js\":\"9d5b1f7e3ab21e2d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/firstSync.js\":\"190f8131077c465e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/freshInitialLoad.js\":\"9c174716b3ca943f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/graphBackfillClaim.js\":\"807cdd54fc99c85a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/handleStore.js\":\"35bdd85b8b3f719b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/idleMarkerJobs.js\":\"45b70e7ac850492c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/initialDownload.js\":\"e2dc48dd8d020479\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/initializeClientDatabase.js\":\"8ebf97279a3b6385\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/jsonCanonical.js\":\"02bc778debf07e1c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelInvalidation.js\":\"e983ba9dabd0e07a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelProcessors.js\":\"ec49680b71cfa98d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/kernelQueries.js\":\"8e94a32a5f4fdf09\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/mergeTypeMembershipProcessor.js\":\"6bc264b5df6c011e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/normalizeReferencesProcessor.js\":\"1b777595df5588bd\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/poolInstrumentation.js\":\"b27e26100f5e51a3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/processorRunner.js\":\"0c699976676fe7a6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyCellBackfill.js\":\"2903e070af449269\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyChildMint.js\":\"62fa8a4d88bcff0b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyChildrenProcessor.js\":\"470e1ee5fee2b2e1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyDefinitionChangeProcessor.js\":\"28fe6649f4a4bb30\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyDefinitionSynthesis.js\":\"ecd6d5772bea2f4e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertyKeyScan.js\":\"e3b6fb6d7a126fbb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/propertySchemaResolution.js\":\"b2943d9acd82720d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/raiseProtocol.js\":\"ef6b93162d7717ec\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/readBatch.js\":\"eaf227987519b1b4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/refProjection.js\":\"4cea0469da8d8f71\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/referenceTargetLookups.js\":\"0575bc57197792c9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/referenceTargetProcessor.js\":\"0c156a475c06911b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/replayMerge.js\":\"24bd297c4462e50d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/sqlBinds.js\":\"5fad7145a879b77a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5102fd9e0d8f080a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/arrivalProcessors.js\":\"3b15f0577aca7718\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/invalidate.js\":\"de30f042595f77f8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/materialize.js\":\"afc0cc868c6c54a6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/observer.js\":\"87a663480bcaa2d0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/syncObserver/reconcile.js\":\"8082e681854e033a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/timingMetrics.js\":\"989583e4d9c14a60\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/treeQueries.js\":\"8b969c5f77b32844\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/txEngine.js\":\"01ea072344d2a19a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/txSnapshots.js\":\"43a410e9a7555a46\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/typedBlockQuery.js\":\"0412ab3db6536038\",\"/knowledge-medium/pr-preview/pr-1787/src/data/internals/undoManager.js\":\"848dc5600c3fbf23\",\"/knowledge-medium/pr-preview/pr-1787/src/data/invalidation.js\":\"dd748c1944fa55c9\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelDataExtension.js\":\"10c4516eb00651b8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelPage.js\":\"679d38e8ff34863d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/kernelValuePresetCores.js\":\"33cee683a4866290\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbCorruptionSignal.js\":\"ab1d1f7b138ea01f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbStorage.js\":\"72fa2220519be3ef\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localDbVfs.js\":\"93aafc9cf095b8ad\",\"/knowledge-medium/pr-preview/pr-1787/src/data/localSchema.js\":\"17608332cf7cd198\",\"/knowledge-medium/pr-preview/pr-1787/src/data/maintenance.js\":\"6fcfe0353d1671c6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/mergeProperties.js\":\"4fe89872c5859ee6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/metricsConsoleHook.js\":\"a0dbd1ec9d6ca850\",\"/knowledge-medium/pr-preview/pr-1787/src/data/migrationsPage.js\":\"71b36bea30afbf17\",\"/knowledge-medium/pr-preview/pr-1787/src/data/mutators.js\":\"6a6e25e27ed98d1e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/orderKey.js\":\"c8cffe82cae7888f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/orderKeyPlacement.js\":\"210faf68fbcec97c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/outlineSurface.js\":\"d3b4c1431f8bd07e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pendingEditorContent.js\":\"849e42ddac3193e7\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pendingUploadsSql.js\":\"b8ec5b530bbcccf5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/pluginStateExtensions.js\":\"091061b4b088eecf\",\"/knowledge-medium/pr-preview/pr-1787/src/data/powerSyncLogger.js\":\"ea23bd8a8bc9ac93\",\"/knowledge-medium/pr-preview/pr-1787/src/data/projectorRuntime.js\":\"f62823b6a6f9677f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/properties.js\":\"c7f938bd40907cd5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertiesPage.js\":\"4e38ae03d6ca5b6b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyChildren.js\":\"97a484857f3adc5a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionFanout.js\":\"ddc58326c37c385e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionMetadata.js\":\"57256df13c1d22e1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDefinitionRegistry.js\":\"152476c9b05fd699\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyDisplayMode.js\":\"8161fd9535e2aa7a\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertyRowCreation.js\":\"7e969eacbb3e67d3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertySchemaCreation.js\":\"96a8a342f291a941\",\"/knowledge-medium/pr-preview/pr-1787/src/data/propertySeeds.js\":\"0cd9798e2f36a734\",\"/knowledge-medium/pr-preview/pr-1787/src/data/recentsPage.js\":\"f5b98ac7c74eca19\",\"/knowledge-medium/pr-preview/pr-1787/src/data/referenceBlock.js\":\"2da3f606abd6f9f0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/releasePowerSyncConnection.js\":\"3bc8c4568aef4fb2\",\"/knowledge-medium/pr-preview/pr-1787/src/data/repo.js\":\"59adf9e138061b6c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/repoProvider.js\":\"53035aeffadfaaba\",\"/knowledge-medium/pr-preview/pr-1787/src/data/rowProperty.js\":\"65b764ac40d779e3\",\"/knowledge-medium/pr-preview/pr-1787/src/data/searchFilter.js\":\"4a9dff7f33780959\",\"/knowledge-medium/pr-preview/pr-1787/src/data/seedIdentityLedger.js\":\"6b9fa2e7d308b007\",\"/knowledge-medium/pr-preview/pr-1787/src/data/stateBlocks.js\":\"84b49ad78b91d7bb\",\"/knowledge-medium/pr-preview/pr-1787/src/data/structuralEditPolicy.js\":\"ab224f4042483bd0\",\"/knowledge-medium/pr-preview/pr-1787/src/data/subtreeDelete.js\":\"1310a65fefbe4eed\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncStreamLock.js\":\"ddeff182491cc3f1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncedTableSqlRecognizer.js\":\"71cdb196c40bc811\",\"/knowledge-medium/pr-preview/pr-1787/src/data/syncedTableWriteGuard.js\":\"5810972886419e47\",\"/knowledge-medium/pr-preview/pr-1787/src/data/targets.js\":\"843ec6d3f83d3dba\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeColors.js\":\"c3f4d0238bcf76f5\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeDefinitionMetadata.js\":\"e6748fb3cc103082\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeDefinitionRegistry.js\":\"ab3a175366982906\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeExtraction.js\":\"7459e9e2eb24aab4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeInitialValues.js\":\"2b0da51ca68b407e\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typePropertyGroups.js\":\"e8b991f2df1aaa6f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeSeeds.js\":\"2479c16e1a755d8c\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typeTagger.js\":\"d2f2f07b2e5ffdb1\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typedRecords.js\":\"42208539af9a487d\",\"/knowledge-medium/pr-preview/pr-1787/src/data/typesPage.js\":\"b93f18736e26dbd8\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userPrefs.js\":\"8d3f73f38f4b3b41\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userSchemasService.js\":\"6201a673bf3cd93f\",\"/knowledge-medium/pr-preview/pr-1787/src/data/userTypesService.js\":\"2bbcaa6c70d58be4\",\"/knowledge-medium/pr-preview/pr-1787/src/data/valuePresetRegistry.js\":\"9bc1886d486775ad\",\"/knowledge-medium/pr-preview/pr-1787/src/data/visibleChildren.js\":\"6fed368e7760fb00\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceConversion.js\":\"7dd16f3a1f15e183\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceFirstSync.js\":\"47354b07c176af8b\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceIdNamespace.js\":\"25345ab9e4d5ed89\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaceSchema.js\":\"c4caa981ad0ecb05\",\"/knowledge-medium/pr-preview/pr-1787/src/data/workspaces.js\":\"7bac903d900cf306\",\"/knowledge-medium/pr-preview/pr-1787/src/data/writeAheadLog.js\":\"a48afd96e4fa3dc6\",\"/knowledge-medium/pr-preview/pr-1787/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/BlockPasteShellDecorator.js\":\"cf52047a7d6f6578\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/atTrigger.js\":\"018ea548d844ba79\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/autocomplete.js\":\"b175bb3986ff5776\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/codeMirrorExtensions.js\":\"1baf0f79dc377dfb\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/contentFlush.js\":\"cd9612441a7b3092\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/defaultInteractions.js\":\"a209dc7daca47256\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/editSettleSignal.js\":\"80f24f7d07afc2ca\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/insertImage.js\":\"22eb5f4891f6f206\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/referenceCompletionRange.js\":\"0d7a27366a789ee5\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/referenceTargetTypes.js\":\"79c5c8fcf75f723c\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/syntaxContext.js\":\"3fd5f11336b0c3af\",\"/knowledge-medium/pr-preview/pr-1787/src/editor/triggerMatch.js\":\"e6c8d29d8e3eb89e\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/AppRuntimeProvider.js\":\"971a93770b695d30\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/BlockFocusShellDecorator.js\":\"8d5bdfad60affd40\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/ExtensionRenderBoundary.js\":\"885b646547e13eac\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/PanelContentRecovery.js\":\"a6abf211e9de2fc6\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/apiCatalog.js\":\"0555d63e8653a124\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/approveExtensionHere.js\":\"32e73b4f82a4ae60\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/armedCutAppMount.js\":\"1741156cdf9f0f3a\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/batchableKeyedStore.js\":\"ae70da211d3a8e12\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/blockInteraction.js\":\"0399b6189203c4f4\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/blockSelectionAction.js\":\"b06ade539b66c1e9\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/compileExtensionModule.js\":\"dffd64f603094202\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/compiledModuleCache.js\":\"675a6387e066f508\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/continuousGestures.js\":\"9d1130878c32cdfe\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/core.js\":\"79baed04e22490b2\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/defaultRenderers.js\":\"82d695ec4eb3452d\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/definitionFanoutAppMount.js\":\"37b88adc9ff40358\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dialogAppMount.js\":\"4ee6daa137984919\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dynamicExtensionSeeds.js\":\"c195246c46273854\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/dynamicExtensions.js\":\"1174dfc9da0a5cf9\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/exampleExtensions.js\":\"1bee6fb74eff4cd8\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionApprovalStatus.js\":\"116be5ca68eeeb92\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLoadErrorToast.js\":\"7ebc829c77b28394\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLoadErrors.js\":\"513ce1bfbdb36e0b\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionLookup.js\":\"314a65ff34a75e87\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionToggles.js\":\"da441adbee260ee6\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/extensionUtilitiesCss.js\":\"5e3596e1989398b1\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/kernelPageDeletionGuard.js\":\"815dd3602b839117\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/liveRuntime.js\":\"860b141c2c296ccf\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/openExtensionsSettings.js\":\"bf4a60803997b68a\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/overridesCache.js\":\"a901edb8b83cb908\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/pluginIds.js\":\"5716f7ca14279ac8\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/processorRejectionToast.js\":\"e88d0a988725f51f\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/runtimeActions.js\":\"6c041ad743f83669\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/runtimeContext.js\":\"5da9e2941a2cae2a\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/staticAppExtensions.js\":\"2a37e4cd081100b3\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/staticDataExtensions.js\":\"15031485fe19918d\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/toastAppMount.js\":\"e4d75cd7b99564dd\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/useOverrides.js\":\"90cc270a771582af\",\"/knowledge-medium/pr-preview/pr-1787/src/extensions/useShortcutSurfaceActivations.js\":\"c02ec7a0b22710d2\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/discoverToggleTree.js\":\"900eba09d1856037\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/facet.js\":\"c282085485039a58\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/resolveAppRuntime.js\":\"8aed283975f20f24\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/runtimeEvents.js\":\"445fdb3fad5f580e\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/togglable.js\":\"6e1a2e7c85a4640b\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/variantFacet.js\":\"4059ca2d6077d557\",\"/knowledge-medium/pr-preview/pr-1787/src/facets/verbFacet.js\":\"6ca9ef58a7d42f3f\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/block.js\":\"ef81e17a0d32a903\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/focusedChild.js\":\"05b125000fb6e2bf\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/propertySchemas.js\":\"2c1d6fae7142b249\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/typeRegistry.js\":\"b4e84525f466e0f0\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useAncestorCrumbs.js\":\"a545f2e9f749ba5e\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useAutocompleteListbox.js\":\"1728407955f4018c\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useDebouncedSearch.js\":\"75076db2fbeb45e9\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useDebouncedValue.js\":\"9d71691cefbcf821\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useIsFocalRender.js\":\"d23ce10fa640681c\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useIsReadOnly.js\":\"e6212c2dee0720b5\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useMaterializeBacklog.js\":\"b2ff082344e6c83e\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useMinuteClock.js\":\"879db189d3bb8785\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/usePanelLayoutProjection.js\":\"0680b295afe37e4a\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/usePendingInvitations.js\":\"129d81c71e384836\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useRendererRegistry.js\":\"7ed5b64a77dc44df\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useRetainedFieldRows.js\":\"959f14d0a4c49165\",\"/knowledge-medium/pr-preview/pr-1787/src/hooks/useWorkspaces.js\":\"860a08031bba1e4c\",\"/knowledge-medium/pr-preview/pr-1787/src/lib/utils.js\":\"e962841c83fb2433\",\"/knowledge-medium/pr-preview/pr-1787/src/main.js\":\"5a85054eca2687b7\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/MarkdownImage.js\":\"49abdbffa089d713\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/blockSeparators.js\":\"2e4d06bb91c2a4e3\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/context.js\":\"b4c2bc6c0b0ff9c0\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/defaultMarkdownExtension.js\":\"11fec10b6cc3ac47\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/extensions.js\":\"37d1456481df03b0\",\"/knowledge-medium/pr-preview/pr-1787/src/markdown/renderMarkdownHtml.js\":\"b895f1bbf5b68592\",\"/knowledge-medium/pr-preview/pr-1787/src/minimal-editor.js\":\"13238b7ea67469a0\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/armedCut.js\":\"b7de80ec14f2bafb\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/captureMediaVerb.js\":\"b4f235778252db83\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/clipboard.js\":\"2b57c618625dcfdf\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/decision.js\":\"aa8336eb63f72120\",\"/knowledge-medium/pr-preview/pr-1787/src/paste/operations.js\":\"582531ba1d6adf28\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/account-header/AccountHeaderItem.js\":\"8740938e4d3c94d3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/account-header/index.js\":\"e9eff50734465c5d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1e922b3780ffc6e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/askAgent.js\":\"67cc996a271e33b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/askedStore.js\":\"d37c062cabcb207e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"92ef3aaaca307d2a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/chipState.js\":\"95d7764448bb123e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a0a584dc207b994e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/index.js\":\"ad749269b6311a30\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e3ad0bbfc596d413\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-dispatch-companion/schema.js\":\"e4f71b9f2a6dbc0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8b14c011045b2793\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7c0a6657ea4974a2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/addMedia.js\":\"1760c8a02a98f963\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8cb27e6127d94ebb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/block.js\":\"092e48a7df153504\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/context.js\":\"5033f90eeffb5ff1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5060454722ae11ee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/index.js\":\"305672f48c0f1863\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/outline.js\":\"f17f097e069c8bde\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/properties.js\":\"25ff016d9e42abb3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/refs.js\":\"b8de54bb3239b442\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"227a96655ebd401c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/search.js\":\"1102285e7e17fbfb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/shared.js\":\"7c2f6d0ae4a14d22\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9813d637df17030b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentViews/text.js\":\"0eb71b637200fcd8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/agentWrites.js\":\"8a5d720c5ea56c6c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/authoringCatalog.js\":\"5c0c7569c35b5d18\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/blockRefTargets.js\":\"ba0c2f858dbf5f97\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/bridge.js\":\"7896fc99f328cc9f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/bridgeLoop.js\":\"39ecfb6428e9878e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/changeHistory.js\":\"82f98a2018e1bafb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/commands.js\":\"a8149d35eb3b3f90\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/commentsCommands.js\":\"ebb70a7f5016ee14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/dataExtension.js\":\"8d10bee6184c5ed0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/dataModelGuide.js\":\"b16f6c7999b37260\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/describeRuntime.js\":\"3be5de9601f9ae42\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/extensionLint.js\":\"7dff1b24c0da5097\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/grainAudit.js\":\"6440fcf82eeff973\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/healthCommand.js\":\"4dda52df54b836ff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/index.js\":\"6b0cbcf6f70b80f4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/presetIdentity.js\":\"9f382029c108aa82\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"75ae31a054ac1e0a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/readMedia.js\":\"58feee8bc514c719\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/schema.js\":\"198a72b0401c4b0f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/serialization.js\":\"65549fff6539e8f8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/targets.js\":\"57f6bb1e94c35b22\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/tokens.js\":\"50a2778d6910ff97\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/watchEvents.js\":\"f70700a088581623\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/workspaceGuard.js\":\"aac06056d6f26e9e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/agent-runtime/writeCommands.js\":\"19376e15181905fa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/AliasCollisionToast.js\":\"01370c7b761ffb95\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/DuplicateNameBanner.js\":\"198f263fcce9d8ca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/collisionMerge.js\":\"82b0f9a81b47653d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/dataExtension.js\":\"c96841741e9e056f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/index.js\":\"5a9c4f36f52e10d9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/mergeCollisionAction.js\":\"f9e7c5376bca878f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/pageStyling.js\":\"164571d7a900b498\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/rejectionToast.js\":\"354ba91c155c53c8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/alias/syncProcessor.js\":\"0903d3a0a2e97c8c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/actions.js\":\"2d728f0e2d1dc998\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/addComment.js\":\"13fa45697559a61b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/anchor.js\":\"b0e1cb226467fa7b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/anchorState.js\":\"4593f5318fa68d4a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/commentLinks.js\":\"b9b3f41e1555c9b6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/confirmThreadDeletion.js\":\"5f1c914b1318c6da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/container.js\":\"29ce3b005ac00028\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/dataExtension.js\":\"53e1f983febb8923\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/deleteComment.js\":\"c67653c35c195bd6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/highlights.js\":\"3551e68c795573d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/index.js\":\"3ffadb73457a031c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/linkedCommentsPill.js\":\"0fa71c2de87b4173\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/margin.js\":\"98f52c3835cf28b6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/marginSchema.js\":\"e871dfd6928e186d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/newComment.js\":\"73ef6628ad125926\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/ownThreadPicker.js\":\"0f2643282a162dcf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/placement.js\":\"3c541bebfc704cbe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/queries.js\":\"0701dea27cabb6a0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotePosition.js\":\"80094c6c2f36601d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotedIn.js\":\"bba165b87b62c26b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/quotedRange.js\":\"406e0400950084f3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/rangeRefs.js\":\"115f7ea3a3d7fb16\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readHighlights.js\":\"3c565812ddeb4a62\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readSelection.js\":\"f0d20cf7117311e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/readSelectionUi.js\":\"2e25b1216a65ad36\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/reanchor.js\":\"78aec5c348221a7c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/schema.js\":\"f55fd562a54fba57\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/scope.js\":\"12a535b038967ca0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/scopeThreads.js\":\"6791efa4fbdaf277\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/splitRetarget.js\":\"6718be198155e777\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/suggestionCard.js\":\"25c877a2c3edd10d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/suggestions.js\":\"9c4399cc60d47e74\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/summaries.js\":\"a108c90b57abde17\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/summaryBatch.js\":\"4f1c7e5de239a1cc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/surface.js\":\"bd3a98cf6728b4b1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/threadNavigation.js\":\"edcbc50a00810bfc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/threads.js\":\"45f8291c5f21e104\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/ui.js\":\"e10dcbe3606f37fe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/annotations/uiStore.js\":\"05f5bc0586a2bbdd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-intents/appIntents.js\":\"0838b80660682c29\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-intents/index.js\":\"f71311b59cd96139\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-update-prompt/index.js\":\"3248be8feeb83064\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/app-update-prompt/status.js\":\"4f2d9e92ba3c882b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"eb76cf3c1e234627\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaBlockRenderer.js\":\"4a19ed4c5be7b360\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaDownLaneReplicator.js\":\"338eed85e4ec34e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/MediaUploadReconciler.js\":\"8fa8e094b32f8c41\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetDownLane.js\":\"8ac00bda8d848147\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetResolver.js\":\"bf9951d87e31091b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/assetUpload.js\":\"33dd7cfd9550558b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/attachmentCleanerIO.js\":\"f4937d039e27b1fb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/supabaseAuditIO.js\":\"824e2e97e72e3783\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/blobStore.js\":\"67d4716996ac7b1a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/byteStore.js\":\"35c94067e7776f32\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/cleanerIO.js\":\"dbcfe9718642bcfe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/cleanupAttachments.js\":\"77d87090628ac3d4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/dataExtension.js\":\"c9c93ce27553814b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/downLane.js\":\"a78ec9b6c3a9adb8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/index.js\":\"430475be67f0a4cf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/insertImageContribution.js\":\"225263037a601605\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/laneArming.js\":\"ab588dc1b34d4923\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/laneLock.js\":\"7c7b0ff0dce27d9b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaBlock.js\":\"1d166097769beaf3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaCapture.js\":\"0aaabdae59acedb7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaViewers.js\":\"90c7841374677aa1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/mediaViewersFacet.js\":\"6f52a3ff854a57d9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/pasteCapture.js\":\"2b029ddea882c9a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/resolver.js\":\"3fcaaec7a39f1a1d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/retryUploadsAction.js\":\"0496a0295cc0fa43\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/storagePaths.js\":\"aa7e88abdcbdae71\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadDrain.js\":\"78269a9b7e839186\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadLaneStatus.js\":\"52af41a36040d8fb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadReconcile.js\":\"7bf7704bad9ca9d7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadRecovery.js\":\"c7bcc174590230ee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/uploadStore.js\":\"935ac8ff52ec58ad\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/attachments/useAssetObjectUrl.js\":\"2e494c9b94f747ba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2d21deaa7a7290f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6fb9383cbd3fe4d2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/facet.js\":\"71d4aeab308ed79f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/index.js\":\"8437b79db8c55811\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks-view/prop.js\":\"d27bf8aedd392be4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BacklinkFilters.js\":\"538b0cb361006ffd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2e668ac522a682e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/BlockEntry.js\":\"7611e864f2a846d8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/LinkedReferences.js\":\"cbe0fd4e2e07a2bd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"302e562a89acef0d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/dailyNoteDefaults.js\":\"9863a383133e651a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/dataExtension.js\":\"301dfdcf6c13f6e8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/edgeExclusions.js\":\"1b730d0e85f9d0d1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/filterProperty.js\":\"36074530b0643c58\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/index.js\":\"3650bb55ca526c2a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5415aeb9e2c970b7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/applies.js\":\"b052ac4332ec1d1b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/countQuery.js\":\"6914e315ca189de4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/expansionStore.js\":\"dbc0d2effcbef55d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/index.js\":\"1bd5f101912dc34b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f285b3b9dfd64645\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/presentationInvalidation.js\":\"f925cf32ada34cf3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/propertyEditorOverride.js\":\"9136dd79696761d2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/propertyFilter.js\":\"61932be407c401e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/query.js\":\"a91509c26308adb3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/resolveFilter.js\":\"898a10535faff7cc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/sourceBatch.js\":\"c1b534e6fde24e18\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/sources.js\":\"5d21542707a4c612\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/useBacklinks.js\":\"4539dcd3f88a940b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"cf8cad1d73437f98\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/BirthdayCelebration.js\":\"5549f3b60f4bc060\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/BirthdayOverlay.js\":\"cf12417ad352d425\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/gate.js\":\"597ac1472f2ad27a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/index.js\":\"18b15cadef76e221\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/birthday/wolfTheme.js\":\"bd7262c08e396515\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/BlockDragLayer.js\":\"72f5429832e92f54\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/dragController.js\":\"0c4a2f8ee6cd09ce\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/dropTarget.js\":\"53d1861335a4f6cb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/index.js\":\"4f366b52f70854f0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-drag/projection.js\":\"5607360da857f59a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-info/BlockMetaCard.js\":\"37bcda81e7886976\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-info/index.js\":\"a87683a5b615a4d1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/AddTagDialog.js\":\"ae4ee684cd0868e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7744f6d029770c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/TagNameIssueHint.js\":\"cfc95ac41733c423\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/addTagAction.js\":\"d9bfbc8b8e71470b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/appendTag.js\":\"719e9119d5940358\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/config.js\":\"e5c65e2f76e49740\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/dataExtension.js\":\"f83dd8ac9a86002b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/index.js\":\"08a96793beea9416\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/block-tagging/propertyEditorOverride.js\":\"85062a16b308599e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5f625b2ba68b6806\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"383b717cdb8e3f8d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c76b4b983d823e8d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5c2fa1eb3b8b3c44\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b5aace4ad0aef51d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/index.js\":\"d685edece3789ae6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9c7d5698fc16b5b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/CharacterCountItem.js\":\"3e58aee0285ec6c3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8e939004534c7601\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/actions.js\":\"108ac1bbe867e109\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/blockType.js\":\"1b27c6572b92658c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/charCount.js\":\"5724c08a6ed0d9e2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/dataExtension.js\":\"06b6a52c0a3ef896\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/index.js\":\"f6dceabe1b25b140\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/profiles.js\":\"4b65d9ca8476415b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/properties.js\":\"affb8cbc3e0223af\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/character-counter/textCounts.js\":\"c46bb3929fee1223\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/colemak-keybindings/index.js\":\"76ba79212ffc9f30\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/CommandPalette.js\":\"bc08b6b179cf22dc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/HeaderItem.js\":\"37c7d7ebfcaafcc5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/context.js\":\"5461bb06afee1fef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/index.js\":\"d881b4345d179e7d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/selection.js\":\"1e6baaeb85fdb82d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/toggleStore.js\":\"6913f3dddc275f20\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/command-palette/useCommandPaletteActions.js\":\"0f53893cc3d306f2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/ContributorBadges.js\":\"49b89dc8c01bce14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/author.js\":\"cb72a60b7ecdfa61\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/codeMirrorExtensions.js\":\"28a618b4f6f87a32\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/dataExtension.js\":\"4d29bb60105b43dc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/index.js\":\"a4e2380c3e63246f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/mentionAutocomplete.js\":\"c334adb66440dc2d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/processor.js\":\"6a2e3e067ea2a374\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/profiles.js\":\"eea994cbd44c9564\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/queries.js\":\"8adf3ff04581e3f8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/contributors/schema.js\":\"ead9066d2cc7db94\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"58b6a6ca0fb383ec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/followOrigin.js\":\"494179f0186cc624\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/index.js\":\"0aff6f199194b0bb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"17a8fddc0253d6ec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4d204800cf676df3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/CalendarGrid.js\":\"714eb18fb1d46765\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DailyNotePicker.js\":\"517c770c495c0c15\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3ef116836565b04a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateNavDecorator.js\":\"66ccd2ab53ad4162\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/DateScrubOverlay.js\":\"13537103c049378a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/HeaderItem.js\":\"5410c361a076a86f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/ReschedulePicker.js\":\"a306b51b47cae295\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/SpreadDatesDialog.js\":\"fa88694bc3d5c147\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/actions.js\":\"8086b662fe358339\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/blockDateAdapter.js\":\"2a237e42a85f0bf8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/calendar.js\":\"4df7c0454b658a01\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dailyNotes.js\":\"7e7ff29b05628031\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dataExtension.js\":\"798cea352a24308f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubActions.js\":\"2ac54c1489906bf8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubGesture.js\":\"c00522a8e0f592e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fda2e38ba18e3b27\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b9937ae4510d7697\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/deletionGuard.js\":\"3805d49c476eee5d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/dueQuery.js\":\"a9f2e0075298c700\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/index.js\":\"cbb8c88432de6b52\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/landing.js\":\"9d911879ed12a0fc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/localSchema.js\":\"51b4d958c1f633bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/referenceDateAdapter.js\":\"e122b489191131db\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/rescheduleAction.js\":\"a9ba12d1394a8832\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/schema.js\":\"52feb015e99b2114\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/spreadBlockDates.js\":\"1b28eac4ad3fd659\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/spreadDatesAction.js\":\"eb1ebc20e900f73d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/today.js\":\"ef1e1f3c237311b9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ab4096981050e22e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4859f20577cd1eb3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/audit.js\":\"54b451b0d50c730c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/auditAction.js\":\"ce3d6723ee86288a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/auditRanges.js\":\"f3b1ebdc9ea3b5d9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/diagnosticsSource.js\":\"5d23544b88b9fa58\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/divergenceScan.js\":\"2efeb5037af3a545\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/index.js\":\"f1469a1ae4ee6463\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/propertyChildrenChecks.js\":\"eab01429d9b3eccc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/referencesMirror.js\":\"d85f7a0fd286371b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/rowJson.js\":\"edd96ebfb22b7582\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/schedule.js\":\"a47f7118d34bf91d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/data-integrity/store.js\":\"df1eaff40390efab\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/action.js\":\"9c14f4742c1eb0e5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/index.js\":\"d5a105ba384d34c9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-maintenance/plugin.js\":\"cb96bf2a8eb8198b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1ee269d4a39084b3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/actions.js\":\"759cc726228c8e04\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/changeMarker.js\":\"48ceba9e2ada6510\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/diagnostics.js\":\"4eb252eef5a85fc7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/fileSystemAccess.js\":\"ded2c513de2d7f14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/filenames.js\":\"e24869f507a29b81\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/index.js\":\"ec12a86b821fc1b4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/mirror.js\":\"2f219a1046e7f9cc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/runLock.js\":\"a4fd6f1e70725d94\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/runtimeHealth.js\":\"0bacebc82811e854\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/schedule.js\":\"2928888712d7df79\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/db-mirror/store.js\":\"f6500a082101ab68\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/default-themes/index.js\":\"fd1ce4cec9d7a79c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/default-themes/themes.js\":\"62d3a15a0bb08203\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/diagnostics/facet.js\":\"75f965645cd6e989\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/diagnostics/useDiagnostics.js\":\"06de764d5c0552c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/dismissals.js\":\"0478c4d3bb72a531\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/index.js\":\"8cbaf315d28644de\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/status.js\":\"4b88ec08c29abe60\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extension-prompts/store.js\":\"4058a23c1a3ce9ba\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7aee0c7d333f5196\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/ExtensionsSettings.js\":\"100319143af31e1b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/actions.js\":\"61ba8b649fb30304\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/config.js\":\"52d2f9f387d27957\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/dataExtension.js\":\"4fe1a769b14d484f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/effect.js\":\"20deb82c8eea1e62\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/index.js\":\"c4b08dcb667a1978\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2b3e628c44fa5934\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extensions-settings/useToggleTree.js\":\"ad0919d612872331\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/ExtractTypeDialog.js\":\"98b9c44d0788bf64\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f85ff0c66232687f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/PropertyShapePicker.js\":\"3e7788e5dd77bf44\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/action.js\":\"4ec7b4d22395f9a8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/extract-type/index.js\":\"967431a4ae2d44f5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/FindReplaceDialog.js\":\"c2c8b02d87103bc4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/HeaderItem.js\":\"f7e8f19375c8fe2c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/dataExtension.js\":\"561922bb42ff9806\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/index.js\":\"70ce1a81aa9d0a61\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/search.js\":\"6484a9952db46522\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/toggleStore.js\":\"dcf19cf1cf656191\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/LocationPropertyEditor.js\":\"476ceae372be5b9c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/MapView.js\":\"878e92a0124c5caa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/blockTypes.js\":\"a4ed3c8ae79e6598\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/codeMirrorExtensions.js\":\"c54133952af72e84\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/createOrFindPlace.js\":\"9eb1ddfc075a81fe\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/currentLocation.js\":\"82c21a14cb6777e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/dataExtension.js\":\"ed71b274c0cf6b57\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/geoContentDecorator.js\":\"4ca0de71643df7ce\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/googlePlacesClient.js\":\"7d026aed2fcbf936\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/index.js\":\"9775e2d48a9fb2d6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/locationsPage.js\":\"bf781a61e23b2528\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/mapViewport.js\":\"5ef1db292164b03c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/pickCurrentLocation.js\":\"d6b834fde6180825\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/placeAutocomplete.js\":\"875a1c8b29148e6b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/placeNameCollision.js\":\"f179324cbea43204\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/properties.js\":\"9b8a567ae4b80a3f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/propertyEditorOverrides.js\":\"f097ecb2c7d69f66\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/query.js\":\"9390cd3363617899\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/geo/usePlaceSearch.js\":\"59b858c5939f0bb2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9b1db6b2c72db14c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"20ba2a8a67825b63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2bc94a65e1fe749f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/config.js\":\"7b85fb75048fe917\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/dataExtension.js\":\"0c52d4b4a2f643fb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/facet.js\":\"4572427c235926bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/grouping.js\":\"63a1f64c62157711\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/index.js\":\"6dbe186f3482900b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5e170013949e2495\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/query.js\":\"0affa9738fa42989\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/resolveConfig.js\":\"ed6b21dc97bd1dd1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"af162cedf912f587\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9367720b5bc6f55c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/HtmlDocumentContent.js\":\"575c0d26d4d2391c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/HtmlFrame.js\":\"3297c6a303c55bdf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/actions.js\":\"7e4cba372a2fc411\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/blockType.js\":\"17761f0a25b49ba1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/confirmRunScripts.js\":\"eea8b301b9376bf1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/dataExtension.js\":\"518d34acd615f73b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameAnnotations.js\":\"283763edd9e19b8c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameDocument.js\":\"22d973e7c24a7404\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/frameTheme.js\":\"f9b57ef35f2ec98c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/index.js\":\"0db84480eb8b2ca4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/scriptConsent.js\":\"c60819f207b26767\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/sourceMap.js\":\"454601c654908aed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/html-document/useDocumentScripts.js\":\"d0a5aaf37a267655\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/index.js\":\"5fc7bb5eec7fd4e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/record.js\":\"88cc7d2c73991e96\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/recordStore.js\":\"be38990845871562\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/responsiveness.js\":\"d49c8d16111b46d3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/schedule.js\":\"6eb938c0e501abed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/interaction-metrics/sessionContext.js\":\"a8faba3eb6f484ef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b56056bb766d2cac\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3b91fe3b5dcbb0c9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/actions.js\":\"46c0b4ba42d78e51\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/config.js\":\"81830cdbcf002b93\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/dataExtension.js\":\"5a317bd5b2ee03a4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/effect.js\":\"01ff562e07b7de64\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/index.js\":\"3500047385c2452c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/keyCapture.js\":\"c821e8be1cca1bee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/overrideStore.js\":\"345937b6ab21e799\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"427d057dc83eb92a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/HeaderItem.js\":\"c842c39f3989a04a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/LeftSidebar.js\":\"3d518bb6829c153b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/actions.js\":\"d33e6394b7b5d8be\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/facet.js\":\"eb28f8d9a202de16\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/index.js\":\"1ad9f44f016b1941\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/shortcuts.js\":\"de59a144f57235de\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/left-sidebar/toggleStore.js\":\"5c5483549ef025eb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/MergePicker.js\":\"6b32e4650f3b3972\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/index.js\":\"771d65d31d773c3b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/mergeAction.js\":\"0a6e8e4bc8f653e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/merge-blocks/strategy.js\":\"4b8e43e319c73148\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/Button.js\":\"d3798df72bdd8b85\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f100499ff739f665\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f37b5649fc4c8a78\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/facet.js\":\"7fc975fdd08dca35\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-bottom-nav/index.js\":\"fcb0fe7b5f472dd9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"55a9c773c3778ad9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a2f2aa671248d358\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cfa8ca81c318e9ed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7d0d87c896e63c2b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/mobile-keyboard-toolbar/index.js\":\"591efd968fe1924b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e06aa165653ded0e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/blockSubtreeMembership.js\":\"376a47a01575abca\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/contextMenuItem.js\":\"dacc9e740b52ca11\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/index.js\":\"40789b678561509e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/moveAction.js\":\"c1c5f3d26ed059bc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/moveBlocks.js\":\"13fc2e679fed42aa\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/move-blocks/selectionAfterMove.js\":\"11ca2db3f238b6dd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/TutorialBanner.js\":\"7c96acd2c6dfc88c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/action.js\":\"d5b5fe50e10201c2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/bannerDismissal.js\":\"80653269fc8db7e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/documents/cheatSheet.js\":\"d7afe1ca5db09edb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/index.js\":\"e3e5e09701eba016\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/keys.js\":\"abb2083b61af8496\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/landing.js\":\"4b5302550014281e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/outline.js\":\"358a7a1fba6dd02b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/onboarding/seed.js\":\"977c72ae9426700b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/PerfTrendDialog.js\":\"71abf3f6b0313aea\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/analyze.js\":\"7e0a14be7608797d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/diagnosticsSource.js\":\"f1e1ae5956cacfe8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/index.js\":\"7fad6e1bd936527f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/load.js\":\"09114f72458439d1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/monitorRun.js\":\"073156993f6e1349\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/schedule.js\":\"5dcea5d1cb0ed56b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/series.js\":\"71d2624bdd9c5d60\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/store.js\":\"8d8b3702499cabb2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/trendAction.js\":\"b07efc04f5df923d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/perf-monitor/verdict.js\":\"175c9ee4fbf817d7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/clickToEditAction.js\":\"c3868376f0ee224f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/index.js\":\"3755d546b0e146da\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/plain-outliner/interactions.js\":\"d9ee7104b98be787\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b5928a877ef052e9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/MigrationGate.js\":\"2291e50f3f397b95\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/MigrationGateDialog.js\":\"3872ef62e02005eb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/action.js\":\"df73abba6d9f11d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/index.js\":\"db673b7a4ec1d21b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/localRunMessage.js\":\"a27de9d62a290bb6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/plugin.js\":\"ff964b40df4abee0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/progressReport.js\":\"6a104b0b378844eb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/properties-migration/sweepProgress.js\":\"374e7893a8fc91c2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/FieldRowRenderer.js\":\"a23b44381f65b088\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/ValueRowRenderer.js\":\"2330d6df489f7fd3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/actions.js\":\"d6e1ac1415eb4fcd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/autocomplete.js\":\"7a323e69933f1523\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/fieldRow.js\":\"aa0486b96c080c79\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/index.js\":\"25abdd3e449df202\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/referenceWarning.js\":\"01468e38e2c166fb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/valueAutocomplete.js\":\"681927a41900dad1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/property-rows/valueSchema.js\":\"bbfe96672a50cafc\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/HeaderItem.js\":\"9ad74d472b4916c1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/QuickFind.js\":\"9a3a6f6adf4da3a5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/index.js\":\"f29f3ea7c9294283\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/recents.js\":\"15cc1d0326874893\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/resultItems.js\":\"53f61ed171e759a6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/selection.js\":\"375856d050230a50\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/quick-find/toggleStore.js\":\"cc1bd01f6ce95a80\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/HeaderItem.js\":\"95dd08593e5c6eb8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/RecentsPageBlockRenderer.js\":\"828f067e3724cc5d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/grouping.js\":\"aadf4f814674fc03\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/index.js\":\"44b06884600bb3e5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/recents/target.js\":\"e654b8c841a950ff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/codeMirrorExtensions.js\":\"1ba085c8cb13e4ff\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/contentPrefill.js\":\"7ada6e4d3ebc3fed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/dataExtension.js\":\"c8482a43edb39f89\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/index.js\":\"1e019355088be5df\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"42f479f4add20beb\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/invalidation.js\":\"3addbfd3dc846032\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/localSchema.js\":\"ce589a4534899fc4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/blockrefs/index.js\":\"4238b53a3f12cab9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1068150d464eeb85\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/index.js\":\"2c978ee23b251dac\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/referenceNode.js\":\"3e5a3c535804b747\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c798a8ca7843f106\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"918cb4c6650ae1e0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/index.js\":\"11d8190e08c109a6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2e57b426d19dc4df\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8b1f31176ba1ab24\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/mergeRetargetProcessor.js\":\"28801456d532c2a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/parseFence.js\":\"7c5bb1d4367d0ff8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referenceParser.js\":\"324fe0f1c26092d8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referenceProjection.js\":\"0cea08dbc9188c63\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/referencesProcessor.js\":\"4b4bc6495af8a28f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/renameProcessor.js\":\"d814015c1e68fff6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/references/spanReplacement.js\":\"150c83394a5e60e7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/htmlToOutline.js\":\"655c70fb88c75518\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/index.js\":\"4ef15efacea31c32\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/normalizeClipboardDom.js\":\"11b06edc2b35b10e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/rich-paste/pasteDecision.js\":\"4eaaf85ecf1f917f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/action.js\":\"c51c046f1bde662e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/blockIds.js\":\"297f7555203fc486\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/content.js\":\"8ffb58954fef6f59\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/effect.js\":\"b431b86c7962c02d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/ids.js\":\"b0a909332da9807b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/import.js\":\"909db2f36a4a958c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/index.js\":\"68427da6ae677903\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/plan.js\":\"4a7f29330367d5fd\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/plugin.js\":\"4f40bba9c24e0576\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/promotion.js\":\"b9b8ca8c7969d235\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/properties.js\":\"7b974ad9d3fc8bb4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/references.js\":\"8a8377f2bf52c1ed\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/report.js\":\"83440c801b157458\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/roamMemo.js\":\"bb50635d84280b4f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/runtime.js\":\"71af686b0e281742\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/schemaReconciliation.js\":\"514332b66d5cd472\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/srsMarkers.js\":\"c511634ff6089204\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/todo.js\":\"cfbd7648308cf34e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/typeCandidates.js\":\"71a83d11f9f383a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/roam-import/types.js\":\"b1ed58885e1cff84\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/search-health/index.js\":\"5c1df6fa7860d3e5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/search-health/store.js\":\"dc65a6d8c1761ea0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/HeaderItem.js\":\"7813361078cec4f9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ad5c025348ca5812\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/index.js\":\"8e9da62881634ad4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/model.js\":\"bc077b2296dc7388\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/toggleStore.js\":\"ee6411f9647bad51\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/shortcut-help/useKeyInspector.js\":\"f1699110becfdb44\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"da73c4b92abd38e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/ShellDecorator.js\":\"eaf51212b0073150\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/actions.js\":\"aa1e29c300f07237\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/exclusionsFacet.js\":\"11a7b50f68b33d51\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/index.js\":\"6b68adf63906a602\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/shell.js\":\"64ad2ed81a8b3382\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/surface.js\":\"d8fc98091e0483ec\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/spatial-navigation/walker.js\":\"435bc4f449bf7087\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a0905b5c50da6565\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/dataExtension.js\":\"c8f09e90b43c234a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/index.js\":\"963452c04c7ec8ef\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/indicator.js\":\"7a272f77ea4c74ee\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/moveSrsState.js\":\"958de1b7de72fd06\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5eb1e6dc1e1be867\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/scheduler.js\":\"84b54557208ec098\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/schema.js\":\"86a537b9531c444e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"aaba771d8e527674\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/srsClipboard.js\":\"0e8f2ddb0cafcd3d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cc32789c6f6b1fa8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/DailyNoteReviewHint.js\":\"bc432a45e2212878\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/DeckPicker.js\":\"71850246e18eac59\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewControls.js\":\"25395c3a1a13e948\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2f05c1e38413f6ad\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/ReviewSession.js\":\"2ae6265333fcddad\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/actions.js\":\"7b054c6f2d2b13b5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/archive.js\":\"da2eb56c74b28186\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/dataExtension.js\":\"fbabad678f5f572e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/deck.js\":\"e47ee3a85ae52755\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/dueQuery.js\":\"504577c8453cdbc3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/gradeDecision.js\":\"a248117e17e3cd5a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/index.js\":\"bace9eb5f2c156d8\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/keyHints.js\":\"e2c5d650bb6ff804\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/reviewCardLayout.js\":\"5efbee4350b3e0a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/reviewProgress.js\":\"54d260d9ceee9c8c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/schema.js\":\"0bec0d33428f49c7\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/srs-review/useDueCards.js\":\"d067cc2e9fc2d3b2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/startup-metrics/index.js\":\"5367cbe80d515e8d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/startup-metrics/record.js\":\"13d793135e6afa60\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/index.js\":\"740cd361fe408cf1\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/persistenceStatus.js\":\"4aa6e4fe0849ced5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/storage-persistence/requestAction.js\":\"989e4ce67086f393\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/TypeChipsDecorator.js\":\"41c3bd1cd5adaa4d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/codeMirrorExtensions.js\":\"5712d6209b497fac\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/index.js\":\"9ffe82895decb4d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/supertags/typeAutocomplete.js\":\"c60bfcacbaba6804\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4544943403d96a4c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/actions.js\":\"587a3592b62e5ccf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/anchor.js\":\"2b9061cef93d9513\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/events.js\":\"be35e4fb9540bf3b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/gestureActions.js\":\"72b48eb01daa9779\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/index.js\":\"3fc9253afac2d0d3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"ea2d50cd702812bf\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/collect.js\":\"0921cee3bbd19f60\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/index.js\":\"3d973f9a3328687a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/sync-metrics/record.js\":\"ccbdf650a713f31c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/RejectionDialog.js\":\"6ce7382475757e8c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ea5dd763ce824c0e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/index.js\":\"2c63488709b7a5d5\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/model.js\":\"ac58d519bf8c1d3f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/queueCounts.js\":\"53a98311b53f4c8a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/rejectedHelpers.js\":\"db28828dfa7ce42c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/rematerializeAction.js\":\"65427c8ee2b3d47d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/system-status/useHysteresis.js\":\"ccdc5571f16607b6\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/effect.js\":\"21da7c1b69e7751e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/index.js\":\"6ed0882d5096807a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/theme-toggle/theme.js\":\"3f4d2df419b1048c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/actions.js\":\"a3d1012490bce18d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/dataExtension.js\":\"e0a5b14b6c4c415b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/index.js\":\"22a993e1e6a9030a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/todo/schema.js\":\"e61d6d70b493f05e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e9fe061d9752bdc2\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/actions.js\":\"76d7a9f458b09f32\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/defaultItems.js\":\"24b30e25b07f1a43\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/facet.js\":\"e929567c9f145500\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/holdRecognizer.js\":\"4b44de787b7fa893\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/touch-selection/index.js\":\"5a309ded6b063ca0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/UpdateIndicator.js\":\"1bbd2b68d6b2d946\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/index.js\":\"6c27921c9e84763e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/update-indicator/loadTimes.js\":\"92f01738eb7a9c22\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoNotesRenderer.js\":\"04017d24b3c96c40\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoPlayerRenderer.js\":\"0f303b8ac00e27a9\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/VideoTimeStamp.js\":\"2f0f9c29a270b809\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/actions.js\":\"009f2f7aefeb8d8d\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/index.js\":\"fbe98fda74375e3a\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/markdown.js\":\"fc575d15b69d420c\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/notes.js\":\"daf9759e41b2d2f0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/registry.js\":\"c6e06421c0400928\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/remark-timestamps.js\":\"78e69cbe4d53e5e4\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/video-player/view.js\":\"26f8db37b01b2ace\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/LinkHints.js\":\"7b09d4ede1169cf3\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/index.js\":\"8e0682caa853e38f\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/model.js\":\"4851abbf37b50d0b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-link-hints/settings.js\":\"2d971a290c198f4e\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/actions.js\":\"1aabd79ac2fbaf9b\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/index.js\":\"32bb217605d30916\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/vim-normal-mode/interactions.js\":\"baabfcc2fdba1da0\",\"/knowledge-medium/pr-preview/pr-1787/src/plugins/workspace-header/index.js\":\"66740446da02f738\",\"/knowledge-medium/pr-preview/pr-1787/src/registerServiceWorker.js\":\"1856ee18540dd91c\",\"/knowledge-medium/pr-preview/pr-1787/src/requestPersistentStorage.js\":\"8b93e86822774875\",\"/knowledge-medium/pr-preview/pr-1787/src/services/authRequestDeadline.js\":\"64a646aed819254f\",\"/knowledge-medium/pr-preview/pr-1787/src/services/authStorage.js\":\"7dc59e44fc3b1150\",\"/knowledge-medium/pr-preview/pr-1787/src/services/powersync.js\":\"25ee927493f62bbc\",\"/knowledge-medium/pr-preview/pr-1787/src/services/supabase.js\":\"44cdb980c64eb998\",\"/knowledge-medium/pr-preview/pr-1787/src/services/uploadErrorClassifier.js\":\"6d12da296998572d\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/ActiveContexts.js\":\"de69e411ddbacf4c\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/HotkeyReconciler.js\":\"43aa5d7b3dd098ce\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/WipeLocalDataDialog.js\":\"a5120f4112ec1eb3\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/actionDispatch.js\":\"ada3b486d50a2790\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/actionRefItems.js\":\"2f9e6a7212e82826\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/applyKeybindingOverrides.js\":\"d949e748539ea170\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/blockActions.js\":\"82c8f8d75650376c\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/canonicalizeChord.js\":\"b935c5e57253b997\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/defaultContexts.js\":\"5fc66ddc6a460125\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/defaultShortcuts.js\":\"8622748d2f299a8a\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/effectiveActions.js\":\"10f8d959e3df4390\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/gestureAction.js\":\"a73b8f8d8d96be51\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/gestureBinding.js\":\"205e15ef66bca48d\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/holdRegistry.js\":\"2598258647330dbf\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/keybindingConflicts.js\":\"80b1021587e1072e\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/keybindingOverrides.js\":\"0b402ce2a5727fac\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/pointerAction.js\":\"cbef799af0db567d\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/resolve.js\":\"938e426c852a28fe\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/runAction.js\":\"e2441e84858425e2\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/sequenceMatcher.js\":\"18d7d49baae9adbe\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/types.js\":\"46771c13b67fcfbe\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/useActionContext.js\":\"a89ba13577fd0775\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/useActionDiscovery.js\":\"5dd74b847428a2d1\",\"/knowledge-medium/pr-preview/pr-1787/src/shortcuts/utils.js\":\"b7eb8264576dcfc1\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/bootStore.js\":\"ebda42d3b56b356f\",\"/knowledge-medium/pr-preview/pr-1787/src/sw/previewDatabases.js\":\"7746f03b89e2ca64\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/byteTransform.js\":\"d50a4b7b2ca77b32\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/attachmentCleaner.js\":\"b508d68f14e441d8\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/attachmentParts.js\":\"523f9ed428d14795\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/bundleParts.js\":\"8e27dd04949e1afd\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/bundleRecord.js\":\"45c5b57d749d0d6d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/manifest.js\":\"47e6d8df1ebb3def\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/takeBundle.js\":\"cf37f06628fb5098\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/bundle/verifyBundle.js\":\"31a43e65ca1b846b\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/cleaningStage.js\":\"5be6200e17302129\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionKey.js\":\"77d7a1f35a0df97d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/conversionServer.js\":\"1510c4a0226e69c1\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/flip.js\":\"4688e3075b866b38\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/flipAttempts.js\":\"5e4df44e41cb30c2\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/pages.js\":\"1bdb8d568bce15ba\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/preflight.js\":\"438b2c9918f1f897\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/reseal.js\":\"2db3838343333011\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/runConversion.js\":\"e4979befd19b7b7d\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/runLock.js\":\"b4a274d2949af831\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/sealing.js\":\"255ca4043827ecc9\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/sealingStage.js\":\"84d8a104e79183b1\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/stage.js\":\"2f23d9929059fd57\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/conversion/verifyReseal.js\":\"87cd6681c88e6837\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/aad.js\":\"bd10f2a759f27e77\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/aead.js\":\"b34d25d5d9efd5c5\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/base32.js\":\"2ea529b051b3052c\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/base64url.js\":\"b8c8e790bc4c4ebe\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/binaryEnvelope.js\":\"df7347b4dfa7b73a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/byteAead.js\":\"3872d3bc2bd01268\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/canary.js\":\"7d3209d895b7f5aa\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/contentHash.js\":\"c70154a667019427\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/contentKey.js\":\"f5ddc2bc87cfb714\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/derivedIdNamespace.js\":\"f14d00df51adff4f\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/envelope.js\":\"18ae7fac49110f34\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/hex.js\":\"0ebe1d2cb9f3f7af\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/sha256Hex.js\":\"10866d8811c385d6\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/crypto/workspaceKey.js\":\"deae3443cfc1cd8a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/conversionState.js\":\"db67a910ec2deae5\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/createEncryptedWorkspace.js\":\"40538be7bef9eb4a\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/pastedKey.js\":\"db47e4c9ae403448\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b5629986317a60f6\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4e5db55198cb98da\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/keyStore.js\":\"89724b4f2cee664b\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/mintWorkspaceKey.js\":\"1889f409ea1a9bca\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/modePin.js\":\"ce4243ae8ef9bbba\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/openWorkspaceKeys.js\":\"a6d3045cf517e915\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/resolveWorkspaceEntry.js\":\"608d10b0e4c58958\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/resolver.js\":\"9c673e83e55a5241\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/keys/workspaceAccess.js\":\"f47d1635a81765df\",\"/knowledge-medium/pr-preview/pr-1787/src/sync/transform.js\":\"3aad7a85ab87ea47\",\"/knowledge-medium/pr-preview/pr-1787/src/themeBootDefaults.js\":\"4c2ced1d6039a9cd\",\"/knowledge-medium/pr-preview/pr-1787/src/types.js\":\"4c1de2aa0ad5c114\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/ClientLocalSettings.js\":\"56a83e644503e637\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/abortableSleep.js\":\"e1421c1e1677888a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/array.js\":\"2848c193261b0d29\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/backlinkAutocomplete.js\":\"89b8c9272ae25d4f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/blockCrumbs.js\":\"e7ce707588e0df60\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/blockrefAutocomplete.js\":\"2ec2422c0e0e60df\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/cadencedIdleJob.js\":\"76145b127e369a00\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/callbackSet.js\":\"a8c7a5702df4b8ae\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/clientId.js\":\"14539a915d5259a6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/codemirror.js\":\"afb59d78a5212274\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/codemirrorCompletion.js\":\"56588a9a65bab2b0\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/copy.js\":\"73ade54bf220c0d6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dailyPage.js\":\"d6c18b2a5826832a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dbForensics.js\":\"1e4ceded15ee20f4\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dbForensicsHooks.js\":\"b63ec0b2242844b2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/deleteBlockThroughUi.js\":\"1b31063822f262a9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dialogs.js\":\"b0f035a6d22b8804\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/dom.js\":\"6efc18accdcd1ae2\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/downloadBlob.js\":\"3f14edd290f1f3aa\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/exportSqliteDb.js\":\"83e07ab2e852e216\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fileSystemAccess.js\":\"18fb0b1ecc896350\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/flipSlide.js\":\"99369e575c03dc64\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fnv1a.js\":\"c0d75fac8ab061b3\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/formatBytes.js\":\"91cd67e8105a2b19\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/fuzzyRank.js\":\"cd3d72911b948000\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/idbKeyedStore.js\":\"4025a15f08e85711\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/idleCallbackPolyfill.js\":\"a4a5ce56b4f378f3\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/keyboardAwareScroll.js\":\"a74d2ab7d9230210\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/keyboardViewport.js\":\"fa6bd80df11e33e9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/lastWorkspace.js\":\"93921ac50f30b818\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutColumns.js\":\"3f6394dd8736b803\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutSessionDom.js\":\"ddf90eb83b7a2833\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/layoutSessionId.js\":\"8c92d839f5440f5e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/linkClickGestures.js\":\"02a8ead52c3f210e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/linkTargetAutocomplete.js\":\"b98000af6c5e87cf\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/localDbCorruption.js\":\"24020e04c2a5a635\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/localDbRecovery.js\":\"0e97fca95ca64a64\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/markdownParser.js\":\"83b1d5fbb617f284\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/memoize.js\":\"fa1a97f88dc07f23\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/nameFieldCommit.js\":\"d33bcaf2a04a236a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/nameList.js\":\"0ffe0c8ccc7b050b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/navigation.js\":\"a5f641c868a4b7ef\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/omnilinerNamespace.js\":\"2494b5a4bc2db9bc\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/opfsPageScan.js\":\"81af759d68ee68a8\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelClearance.js\":\"f2fd13d01d91724d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelHistory.js\":\"9af2f0cf1e35bb6b\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelLanes.js\":\"94a404200d4cd2a3\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelLayoutProjection.js\":\"0705ef2a46b7f94f\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelScrollAnchor.js\":\"52be527da449beaa\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/panelUrlFlags.js\":\"9484442365423199\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/platform.js\":\"277549fa1c6d7390\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/pluralize.js\":\"4c744b1f554721bd\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyCreation.js\":\"ae8fd50897e50da6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyNavigation.js\":\"f067545e842c2690\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/propertyValueContext.js\":\"4ae8afd757698512\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/react.js\":\"6d0094814ffb5f48\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/relativeDate.js\":\"5468721d0c220679\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/relativeTime.js\":\"0de37a5d7ee1e6ae\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/renderScope.js\":\"9a58719d78e3ebfe\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/resolvedThenable.js\":\"c52ca95c37617b5d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/routing.js\":\"5f4e7fb7d2a8dc07\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/safeMode.js\":\"5533200a091a396e\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/scheduleIdle.js\":\"a72d2824453bf6c0\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/screenWakeLock.js\":\"657b57255cf194dc\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/selection.js\":\"5e3f9e13e53bdb57\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/softKeyboardGrab.js\":\"535d0ad8c18d2858\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/startupTimeline.js\":\"fe3e2765e75f4a8d\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/state.js\":\"c4455bbf236c75e9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/string.js\":\"698ff66f5cbf648a\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/surfaceZoom.js\":\"f3baf6a9ff0ed693\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/time.js\":\"3a30aa02c9d8f3d1\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/toast.js\":\"d68a967dc0c39ddd\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/toggleStore.js\":\"c4c498c447889ca9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/untilStopped.js\":\"7bfe0c051782ffc9\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/userActivity.js\":\"599a7d0a4b6785d7\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/viewTransition.js\":\"21f03cad8f4412fd\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/viewport.js\":\"3c4c08af3009cd61\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/webLock.js\":\"368a91e0ca1af6f4\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/workspaceRecovery.js\":\"52193c9f5d8bdd33\",\"/knowledge-medium/pr-preview/pr-1787/src/utils/workspaceSnapshotStore.js\":\"2b559052b9d650ec\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-compiler-runtime.js\":\"86a657356c28fe53\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-client.js\":\"e029f59e9ebdbd76\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-server-edge.js\":\"efe38babd468e932\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-server.js\":\"bc1e3085b8e63093\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-static-edge.js\":\"ef81017ff5e0bfb4\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-static.js\":\"41b51d47f55d6c89\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom-test-utils.js\":\"c0e33fce7a99fbfc\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-dom.js\":\"a0146d49de445742\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react-jsx-runtime.js\":\"6eb4ff4160de7f95\",\"/knowledge-medium/pr-preview/pr-1787/src/vendor/react.js\":\"e5eb07ec877e11dc\",\"/knowledge-medium/pr-preview/pr-1787/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1787/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1787/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
