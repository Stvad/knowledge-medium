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
		buildId: "d588c08bbfd0-8905280d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/\":\"46cd9867ef7fddba\",\"/knowledge-medium/pr-preview/pr-1788/index.html\":\"46cd9867ef7fddba\",\"/knowledge-medium/pr-preview/pr-1788/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1788/assets/FacadeVFS-ZCRGUJFE.js\":\"df97fb4891d87120\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSCoopSyncVFS-DFvj2ptq.js\":\"e07dc91ded818d1b\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSWriteAheadVFS-CBn5jnWO.js\":\"90d72333506619de\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-VHim_sjG.js\":\"3ee607d1115fdbcf\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-D5y5E6Iu.js\":\"5530d0155c73c11e\",\"/knowledge-medium/pr-preview/pr-1788/assets/worker-CQ3oMEyB.js\":\"fd4e74c127fa613d\",\"/knowledge-medium/pr-preview/pr-1788/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1788/chunks/app-DscBCHmK.js\":\"ca61e55b4295a4ca\",\"/knowledge-medium/pr-preview/pr-1788/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1788/index.js\":\"a3c6d510f4d0fc1f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1788/assets/AccessHandlePoolVFS-BIZFShHd.js\":\"40163fd2584d781c\",\"/knowledge-medium/pr-preview/pr-1788/assets/IDBBatchAtomicVFS-CIfB4ukQ.js\":\"b7a76d7f99c5831b\",\"/knowledge-medium/pr-preview/pr-1788/assets/MemoryVFS-PEM6NHw2.js\":\"5805389859240a11\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-ChWoBi98.js\":\"0f3d89b51a9ad7bc\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-BYnt30z1.js\":\"9f91e98210bd7325\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1788/chunks/AccessHandlePoolVFS-Bah3_Veb.js\":\"17aa89b72223601c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/FacadeVFS-B4cf06P4.js\":\"c3d3b06ddc218bd0\",\"/knowledge-medium/pr-preview/pr-1788/chunks/IDBBatchAtomicVFS-c7lIf3Pi.js\":\"5cc3660b3d1ba514\",\"/knowledge-medium/pr-preview/pr-1788/chunks/MemoryVFS-DUmPXU1s.js\":\"667681b617663cc9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSCoopSyncVFS-ffywz5An.js\":\"553a1279c5058f8a\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSWriteAheadVFS-DLKnH0Bc.js\":\"b125a96c42de32e2\",\"/knowledge-medium/pr-preview/pr-1788/chunks/Preview-BoJrpX2o.js\":\"d299d28b00ef0ad9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/card-BDn5dDxA.js\":\"d09675e679b18662\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-C84SDE-q.js\":\"855295591149e313\",\"/knowledge-medium/pr-preview/pr-1788/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-EWeEnxiQ.js\":\"fb839221759d27ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-async-ClyGc1Gt.js\":\"fb2c0ba9129c2673\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-BzP8j05f.js\":\"0828fb9793cbb492\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-CYRAnz0P.js\":\"112b73d9a09a89c4\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-Cf-83a95.js\":\"ab67eb9b21bf4dfb\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-CzakYFL-.js\":\"368f7fe2d7e1eea3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-D5-pMBXl.js\":\"5a9d8f547b79a342\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DGgaSNul.js\":\"5dbf6f72c7f648cf\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-VFXY1Rsg.js\":\"74ada3a25b020bd3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server-legacy.browser.production-BSwDMjVg.js\":\"4eedfb9e2824f1fb\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.browser.production-Ba0zsCXN.js\":\"5349a11bec93261a\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.edge.production-CMPCZzdi.js\":\"752a657347f7359c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-qjL4cyRW.js\":\"bc40eb56767fcaff\",\"/knowledge-medium/pr-preview/pr-1788/chunks/server.browser-Boiez1oE.js\":\"b10ae2fa0ac7c0ca\",\"/knowledge-medium/pr-preview/pr-1788/chunks/textarea-DmWNuRI4.js\":\"9a21f87637777ec7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/ui-CC4N_HDa.js\":\"7e833541eb9ee7f3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-Cj1mtf1Z.js\":\"f22f4b8886f436e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-async-CKwLWy84.js\":\"b47819fb8f3df2c7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1788/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/src/App.js\":\"c95e13f3222f51ad\",\"/knowledge-medium/pr-preview/pr-1788/src/appUpdate.js\":\"91e3d2ccfd31cc90\",\"/knowledge-medium/pr-preview/pr-1788/src/appVersion.js\":\"3cf47a2f6210aa18\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/initialLayout.js\":\"121b1618f24c723f\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/openWorkspaceData.js\":\"0e77ff8f709ddf3f\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/resolveWorkspace.js\":\"f271e6e8c51de868\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/workspaceBootstrap.js\":\"f0be445c93a889c7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockComponent.js\":\"329e9e0ac1cef862\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockCrumbs.js\":\"e4dc7c3d1279f8a1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockEditor.js\":\"a2a292a9ac59e5c3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockLoadingPlaceholder.js\":\"8cf2d205a2c95a35\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockProperties.js\":\"08d09c2d4982dcd3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockSearchPicker.js\":\"e9cba65712124303\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ConfirmBulkDeleteDialog.js\":\"716acfcfefd99e27\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DividerHandle.js\":\"03eb4ad4c82b1953\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DraftEditor.js\":\"4888ec0ba884fdf5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/GutterPill.js\":\"db2fa47734c56452\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Header.js\":\"327a826a10d04828\",\"/knowledge-medium/pr-preview/pr-1788/src/components/LazyBlockComponent.js\":\"2b6e9c95f03b3df7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Login.js\":\"e13f0a4794014d73\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ZoomableSurface.js\":\"336057a315e4e59b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/editModeKeepalive.js\":\"41e7605a9a19f889\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0e8ef6dbe7aad8c8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a33d7bf4e85ec536\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefPropertyEditor.js\":\"5e20477894456b29\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefTargetTypePicker.js\":\"b5661ff0e9f14c7c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/SelectPropertyEditor.js\":\"009c547f2480bb6d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/TypesPropertyEditor.js\":\"37bc1a01816ca954\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/defaults.js\":\"d09e5fb6142a7b8c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/kernelValuePresets.js\":\"c86e8ce5321aaafe\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/selectablePresets.js\":\"9abcd3bd46fa94aa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/typesPropertyUi.js\":\"4886eab140b032f6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/AddPropertyForm.js\":\"b5124e8b6edda9ca\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyPicker.js\":\"12846197995e11fc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyRow.js\":\"03890ac9aeb428b3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/Rows.js\":\"b001842f856fb08b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/actions.js\":\"ea7734ef4ba5c58f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/declarationOnly.js\":\"7e0fad3f5ee35f98\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/layout.js\":\"5d32ce4a38afd9e5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/model.js\":\"2e7e628ee6fbb855\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapeUi.js\":\"595e9c502b982e9f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapes.js\":\"d125e1e1445bccaf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4f12c32eca2efe3b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/visibility.js\":\"c189b81d40ac63d4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanelSections.js\":\"8ab071423eac79a5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockEmbed.js\":\"afb0d33f24d58af5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockLink.js\":\"42d639a48f69647c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockRef.js\":\"de6bd0632e2ed691\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/ReferenceLink.js\":\"c06fc99255fb66bd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuard.js\":\"b3196a5130318e3f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuardContext.js\":\"3d5705541e1593ba\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/linkInteraction.js\":\"e896fbf6248334bd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/referenceLayout.js\":\"6bc6ffc0789f8d07\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/useBlockRefAncestors.js\":\"1ae22f5a35d872f4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockGutter.js\":\"ee7617e86f8f3c5c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockInfoDialog.js\":\"957348e6fd7501bf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockTypeBlockRenderer.js\":\"8be1101e76913043\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BulletHoverCard.js\":\"3a89642a8c258910\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorContentRenderer.js\":\"1e0f2c53604b6d2a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ed9edd2e6deb1ce3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ColumnResizeHandles.js\":\"8ec1f419412b39b6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d6728d2d7b764fe7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/DefaultBlockRenderer.js\":\"a587a17109fac104\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/LayoutRenderer.js\":\"df5d133bceb5e45a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MarkdownContentRenderer.js\":\"e9973cb4366825c2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MissingDataRenderer.js\":\"4efe16003c64fd8c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PanelRenderer.js\":\"518b5ffcb26b1fab\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PropertySchemaBlockRenderer.js\":\"48e745a4343204cd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/TopLevelRenderer.js\":\"acdcdb01f89afa13\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockGutterMode.js\":\"4e541090ac773e00\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockTitleText.js\":\"f89dfca1420546c1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/fieldCreationKeydown.js\":\"329661324ad7d6ba\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/layoutRootContext.js\":\"eb92c269083bfce2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/TypeChip.js\":\"4ee6844e16094786\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/chipStyle.js\":\"877fe951e47a344c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/anchored-floating.js\":\"cbb16b18cfb6e21f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/button.js\":\"27f6e14602d115b4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/card.js\":\"794b581844ddfb11\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/checkbox.js\":\"5f1c6e1b878b8475\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/collapsible.js\":\"e8e1002ad952ce75\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/command.js\":\"91e3d1c28da9aeea\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/context-menu.js\":\"93dce21ecefccc01\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dialog.js\":\"08348cee2a944f17\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dropdown-menu.js\":\"080db3c710c26ef1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/floating-listbox.js\":\"a76f9dffd3e78bac\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/index.js\":\"45b5b5943f3273a8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/input.js\":\"1d78dcf3f7249afa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/kbd.js\":\"eb0081ef9e6db774\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/label.js\":\"1a231aa5668d0b21\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/textarea.js\":\"7648616cf2eb286b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/useEditModeYieldKeepalive.js\":\"cb2dd057abcaf6d9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/BootFallback.js\":\"88e8f284234582dd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/FocusedRowLazyMount.js\":\"37b6097b353153aa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LazyViewportMount.js\":\"d0190ca05668ae16\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LocalDbCorruptionFallback.js\":\"56b909d9b6b97086\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/error.js\":\"2259a40416c10b56\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/lazyMountRegistry.js\":\"c0e73cc2c72e0318\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/suspense.js\":\"5af8dfeebe8d47af\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/CreateWorkspaceDialog.js\":\"f39010c03e8d2ba3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/PendingInvitations.js\":\"9b2c52cb87312c1e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/SyncProgress.js\":\"d1ef06d6e6accf87\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/UnlockProgress.js\":\"b5b87cab12e1b568\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceKeyGate.js\":\"2cc74ac7c52425d6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSettingsDialog.js\":\"5be8773e377fc486\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSwitcher.js\":\"c6139e06163c783b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSyncGate.js\":\"fbb970258216d241\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlow.js\":\"39e48dbff9873258\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlowHost.js\":\"5000bfcb05ae5f67\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/EncryptionSection.js\":\"d37b1a06abcc4266\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/attachmentPrompts.js\":\"4ad15f042edc53c9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e5261cae31e57537\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowDeps.js\":\"638854e16390b19b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowStore.js\":\"d336ed1beb8adacb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/flowUi.js\":\"33f1d609cb49cdd9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/useConversionRun.js\":\"c4f8a5d89a0945f7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/keyUi.js\":\"48de3eead729f835\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnKeyLoss.js\":\"dafd4d90e56c3773\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnServerE2ee.js\":\"b8c76a5d53a6168f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/workspaceUnlocked.js\":\"50c485c64412aef5\",\"/knowledge-medium/pr-preview/pr-1788/src/context/backgroundSubtree.js\":\"b78d42fd1f6c8fa5\",\"/knowledge-medium/pr-preview/pr-1788/src/context/block.js\":\"1ff01ce219ce4113\",\"/knowledge-medium/pr-preview/pr-1788/src/context/layoutWsContext.js\":\"9bf503ccc9c46e97\",\"/knowledge-medium/pr-preview/pr-1788/src/context/propertyDisplay.js\":\"08d74b9d7ba8d126\",\"/knowledge-medium/pr-preview/pr-1788/src/context/repo.js\":\"83627a883aa6e132\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasClaim.js\":\"3ddae0c89efb2ad5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasSeatNamespace.js\":\"838bd23a8a610345\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockData.js\":\"3fd0a2a74d505e43\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockType.js\":\"92943a393a786c51\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/changeScope.js\":\"6e74acb19c19ffcc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/codecs.js\":\"19409f349a188c5d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/derivedData.js\":\"e830bed58edacfa4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/errors.js\":\"5db676747ed68a19\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/events.js\":\"48a75525717dabf0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/handle.js\":\"bf7ffcccc893ef05\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/index.js\":\"f23f08dad9c478bf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/mutator.js\":\"8fa3a7230db4db55\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/processor.js\":\"c849b1d5cae11c22\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/propertySchema.js\":\"cbc9a9093494b599\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/query.js\":\"47ddd118336b0151\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/sameTxProcessor.js\":\"6de478bdadfc9ee3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/schema.js\":\"bf7ffcccc893ef05\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/tx.js\":\"bf7ffcccc893ef05\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/typedBlockQuery.js\":\"5fe77e6ff00fb48a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/user.js\":\"719a88f287cbb592\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresetCore.js\":\"3e304aa06c559a3b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresets.js\":\"b54f9f2ad3000373\",\"/knowledge-medium/pr-preview/pr-1788/src/data/attachmentCleanerIOVerb.js\":\"31ba0397c8698836\",\"/knowledge-medium/pr-preview/pr-1788/src/data/block.js\":\"5be938bac8d8a467\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockCache.js\":\"d75a4eedc61491d7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockId.js\":\"efe87a537e865aa7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockLiveness.js\":\"aeefbc4eaaa192f2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockMerge.js\":\"808b060af8c91bc5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockSchema.js\":\"8528525cbb706342\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockTypes.js\":\"ab3c13053aba57ff\",\"/knowledge-medium/pr-preview/pr-1788/src/data/clientContext.js\":\"ec52f0ddccf86b56\",\"/knowledge-medium/pr-preview/pr-1788/src/data/dbFileSiblings.js\":\"aa137be58a844f17\",\"/knowledge-medium/pr-preview/pr-1788/src/data/definitionSeeds.js\":\"a11b4d533b8bf517\",\"/knowledge-medium/pr-preview/pr-1788/src/data/derivedIds.js\":\"f90209ac9821d981\",\"/knowledge-medium/pr-preview/pr-1788/src/data/drawnSubtree.js\":\"f579e6f9da1d1fc1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facetBridge.js\":\"d2d181fd6ec57a3a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facets.js\":\"18bee2cc8f546000\",\"/knowledge-medium/pr-preview/pr-1788/src/data/globalState.js\":\"9e416f8c86fc6668\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/aliasClaimRederiveProcessor.js\":\"5c7a18aecf2df5b6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/ancestorBatch.js\":\"09c90523add10962\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/blockTypeTypeifyProcessor.js\":\"ec77e963f147308f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/clientSchema.js\":\"2647458e0e134182\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/commitPipeline.js\":\"bc44b21fca7db295\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/devAssertions.js\":\"be3532c7632dbe1d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/firstSync.js\":\"6e7cb998c6c6614f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/freshInitialLoad.js\":\"4406812aeeb9e9c1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/graphBackfillClaim.js\":\"c0afb022fc14735b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/handleStore.js\":\"55e5fa1c43a1c0a1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/idleMarkerJobs.js\":\"0e4c9077b0da3a35\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initialDownload.js\":\"161fa014c90e0a02\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initializeClientDatabase.js\":\"a7d526f764c4216e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/jsonCanonical.js\":\"b18b49aacf179f10\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelInvalidation.js\":\"66503856ad70dd9e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelProcessors.js\":\"090bd8b614215c36\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelQueries.js\":\"02a56a2bc53ecb5e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/mergeTypeMembershipProcessor.js\":\"f804cfc9493134b3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/normalizeReferencesProcessor.js\":\"ae068f485446df01\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/poolInstrumentation.js\":\"78e1b1cf8f95b704\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/processorRunner.js\":\"f96cd557401162bb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCell.js\":\"30da0ea398305788\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCellBackfill.js\":\"54ef6042cc727b8a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildMint.js\":\"f67706e270b88ad6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildrenProcessor.js\":\"fc397840b8dee0c8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionChangeProcessor.js\":\"fd5ff3492199adb1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionSynthesis.js\":\"ccedf2bbd4c2a467\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyKeyScan.js\":\"817297e300c03a34\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertySchemaResolution.js\":\"8d2b257e0cd455f7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/raiseProtocol.js\":\"9523854c6f25c4e7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/readBatch.js\":\"5e16d1725f0c78ba\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/refProjection.js\":\"80a88035888225c1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetLookups.js\":\"d4ce253cbcbc8598\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetProcessor.js\":\"85119bdf7cf57de9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/replayMerge.js\":\"836183a3ed7d14a9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/sqlBinds.js\":\"82e0f1384d7a17eb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2d05312afe54ce02\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/arrivalProcessors.js\":\"54aec6022c4b22d5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/invalidate.js\":\"274ad1ed637fcb09\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/materialize.js\":\"c30809262efc50b4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/observer.js\":\"8d81e1b92fb0c9c9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/reconcile.js\":\"024879b4cd1691e3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/timingMetrics.js\":\"fe79503539cf4fb2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/treeQueries.js\":\"da34fad2b9787731\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txEngine.js\":\"66755c8c5496470f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txSnapshots.js\":\"55f983c3de6155ec\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/typedBlockQuery.js\":\"4088e74e33679e1a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/undoManager.js\":\"c5c165b2578e340d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/invalidation.js\":\"a4299d758b1c05e3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelDataExtension.js\":\"c4d1c34848736a40\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelPage.js\":\"53a0407fcf67e500\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelValuePresetCores.js\":\"740c081849c5cd11\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbCorruptionSignal.js\":\"d9fdac05e43b4c49\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbStorage.js\":\"99c9edf8cbd0254f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbVfs.js\":\"a1253bc9ec5fed0f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localSchema.js\":\"de868f2d73e670d5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/maintenance.js\":\"f0dabbef9ff3bb51\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mergeProperties.js\":\"47546d3c87e4c080\",\"/knowledge-medium/pr-preview/pr-1788/src/data/metricsConsoleHook.js\":\"ae2ba1031c4dd124\",\"/knowledge-medium/pr-preview/pr-1788/src/data/migrationsPage.js\":\"06767561ece4a40f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mutators.js\":\"c4881284673137c3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKey.js\":\"65e43b912c0adf17\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKeyPlacement.js\":\"4a1bd01669ce8cb1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/outlineSurface.js\":\"313e9b71fcdcac96\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingEditorContent.js\":\"9ef2cfcac4e01a08\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingUploadsSql.js\":\"3d1659241d52d922\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pluginStateExtensions.js\":\"ba55cc1ab56accc3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/powerSyncLogger.js\":\"cce0b6958ed70754\",\"/knowledge-medium/pr-preview/pr-1788/src/data/projectorRuntime.js\":\"9db72205e257bd49\",\"/knowledge-medium/pr-preview/pr-1788/src/data/properties.js\":\"f68d631dd2181fe0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertiesPage.js\":\"c5ecf2b737dea403\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyChildren.js\":\"904385962e9b614f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionFanout.js\":\"9b90169a0244dd85\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionMetadata.js\":\"5c43267cbac6257f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionRegistry.js\":\"d443a633665099fb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDisplayMode.js\":\"b5153b443f40741a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyRowCreation.js\":\"c78f33694389b3b4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySchemaCreation.js\":\"c35075cd4c9d10d5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySeeds.js\":\"607aa1f0e88ec507\",\"/knowledge-medium/pr-preview/pr-1788/src/data/recentsPage.js\":\"8d50acf550ca6449\",\"/knowledge-medium/pr-preview/pr-1788/src/data/referenceBlock.js\":\"714c7849f324cc0d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/releasePowerSyncConnection.js\":\"12e205791a6f2e78\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repo.js\":\"9ef4af2a28ccb5a7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repoProvider.js\":\"1f14225d66329ffd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/rowProperty.js\":\"26db8b6b333e88c2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/searchFilter.js\":\"8d88e0c28dc03f53\",\"/knowledge-medium/pr-preview/pr-1788/src/data/seedIdentityLedger.js\":\"04a10e8700e674d7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/stateBlocks.js\":\"0438ca9899056984\",\"/knowledge-medium/pr-preview/pr-1788/src/data/structuralEditPolicy.js\":\"460eaec5effd7610\",\"/knowledge-medium/pr-preview/pr-1788/src/data/subtreeDelete.js\":\"eb3813081060f29a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncStreamLock.js\":\"40fbb2a1c36da25f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableSqlRecognizer.js\":\"ef166f9f6d661b8a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableWriteGuard.js\":\"e4ee46112f998f60\",\"/knowledge-medium/pr-preview/pr-1788/src/data/targets.js\":\"73ef6852e0783eec\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeColors.js\":\"abd77f2c6f65b1c4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionMetadata.js\":\"92e5ea170aa69788\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionRegistry.js\":\"abc1399827f08d16\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeExtraction.js\":\"ee66d40dfdd0e008\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeInitialValues.js\":\"1e2d7aabadf9cb20\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typePropertyGroups.js\":\"158b297f60f22b76\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeSeeds.js\":\"584ad5bc980debef\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeTagger.js\":\"fc2e689162649bac\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typedRecords.js\":\"becf725195955eb3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typesPage.js\":\"c6af92ca27fd32bd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userPrefs.js\":\"76a159f1c521aca9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userSchemasService.js\":\"1247ebfb9fbc4a9b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userTypesService.js\":\"39f1087bfa6da015\",\"/knowledge-medium/pr-preview/pr-1788/src/data/valuePresetRegistry.js\":\"6931fe1c32da3d3f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/visibleChildren.js\":\"4bb5071e608a20d2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceConversion.js\":\"aea9d0ba33770dc3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceFirstSync.js\":\"ce15e0a327425523\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceIdNamespace.js\":\"88ae57f6ffc83c08\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceSchema.js\":\"ee98edbf9d27a80c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaces.js\":\"62e664d9219ce374\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadLog.js\":\"9057b2610a39af83\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/BlockPasteShellDecorator.js\":\"3868cec0f8e8f655\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/atTrigger.js\":\"e9f45f26b2df9ffa\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/autocomplete.js\":\"cc8322c873d63502\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/codeMirrorExtensions.js\":\"07a7fe3bd31fff5f\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/contentFlush.js\":\"72a43d36bec39902\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/defaultInteractions.js\":\"b797cbd0ec1cd982\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/editSettleSignal.js\":\"730c53ac94fa9609\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/insertImage.js\":\"1c12d7f0a7641902\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceCompletionRange.js\":\"684239db301a3c29\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceTargetTypes.js\":\"b4fa5dbb57d38f2b\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/syntaxContext.js\":\"216e9d727cf7c4c4\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/triggerMatch.js\":\"bfc28ffdc4615fcf\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/AppRuntimeProvider.js\":\"7cb1d82b97bd0014\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/BlockFocusShellDecorator.js\":\"782f2c699cbd41ae\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/ExtensionRenderBoundary.js\":\"8c4c9fed2c77aefc\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/PanelContentRecovery.js\":\"e8d418a15b853240\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/apiCatalog.js\":\"91478c5f452c4444\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/approveExtensionHere.js\":\"ddb0fd3630640a58\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/armedCutAppMount.js\":\"804511991113db61\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/batchableKeyedStore.js\":\"4e053fd8981cfd37\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockInteraction.js\":\"3f828b4eb514288a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockSelectionAction.js\":\"9844b17622685bc7\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compileExtensionModule.js\":\"bdc68883aae13f7c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compiledModuleCache.js\":\"945a6eb6a81a8a20\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/continuousGestures.js\":\"1312e6813ff62b15\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/core.js\":\"1a8e5bc1313a1ea9\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/defaultRenderers.js\":\"9844f653f91a0383\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/definitionFanoutAppMount.js\":\"d36806dd7c541509\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dialogAppMount.js\":\"a53c7dd41736e852\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensionSeeds.js\":\"19749f1c307684a6\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensions.js\":\"c9c8e15db083c422\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/exampleExtensions.js\":\"cff847ff5aff006a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionApprovalStatus.js\":\"e832b75c20f8f1db\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrorToast.js\":\"af0fc70228e303d2\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrors.js\":\"9db1cba6ec4c652c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLookup.js\":\"ea8a858068bb252c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionToggles.js\":\"e9640a3f4d393a73\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionUtilitiesCss.js\":\"c003fd609d76ddad\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/kernelPageDeletionGuard.js\":\"e3eb9a05d1bd7f23\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/liveRuntime.js\":\"54a994b5aeb4060a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/openExtensionsSettings.js\":\"53d90694565fac5c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/overridesCache.js\":\"b2f4714d0e395a6e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/pluginIds.js\":\"5ff25e58887cbc98\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/processorRejectionToast.js\":\"5aecc85797d3ce8a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeActions.js\":\"8eda48c485d4ac69\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeContext.js\":\"f137b0d033a4f4a2\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticAppExtensions.js\":\"642f5e64039fba5a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticDataExtensions.js\":\"6205034ca4c4e71f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/toastAppMount.js\":\"ab43e5c959393fce\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useOverrides.js\":\"493b51fdc3fed21d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useShortcutSurfaceActivations.js\":\"2f8e30642fd15b7e\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/discoverToggleTree.js\":\"0756be0b37a333e2\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/facet.js\":\"798446aa7380d6fb\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/resolveAppRuntime.js\":\"a91954caaba18f59\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/runtimeEvents.js\":\"17f6f0d410f92284\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/togglable.js\":\"32134cfc155edb3d\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/variantFacet.js\":\"bb3b9c94cf248f1a\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/verbFacet.js\":\"073da2d2bdfdf640\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/block.js\":\"f9c7ac06516db962\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/focusedChild.js\":\"bbf0c57bf644357e\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/propertySchemas.js\":\"0ac4bfb043b7eb59\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/typeRegistry.js\":\"e2c0a3afe87639df\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAncestorCrumbs.js\":\"33eb1ae6a9c3ccba\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAutocompleteListbox.js\":\"e1f125ef83da01be\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedSearch.js\":\"3a20354a8dcdb470\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedValue.js\":\"6e2cb98313164d54\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsFocalRender.js\":\"ef09f68f00601c0b\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsReadOnly.js\":\"c6c9bc58a7f25a7f\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMaterializeBacklog.js\":\"249a75cd533207e3\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMinuteClock.js\":\"eb1ae7092f516f5b\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePanelLayoutProjection.js\":\"1ee9b1b244af4722\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePendingInvitations.js\":\"122ac0be73c30b63\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRendererRegistry.js\":\"110f35821560775a\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRetainedFieldRows.js\":\"c65612efa5973b29\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useWorkspaces.js\":\"1c8f6b0590e29dad\",\"/knowledge-medium/pr-preview/pr-1788/src/lib/utils.js\":\"3c2ca45366eb16a6\",\"/knowledge-medium/pr-preview/pr-1788/src/main.js\":\"f65584bf8f5cff2a\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/MarkdownImage.js\":\"904e9a6d87f2f439\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/blockSeparators.js\":\"4d242a709813485f\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/context.js\":\"57adf7ae36522b7f\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/defaultMarkdownExtension.js\":\"42e57487ef10fab9\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/extensions.js\":\"328265d3d2ae17d4\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/renderMarkdownHtml.js\":\"203e5ede13b24333\",\"/knowledge-medium/pr-preview/pr-1788/src/minimal-editor.js\":\"458375e95b682251\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/armedCut.js\":\"825082853a4b006a\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/captureMediaVerb.js\":\"20bcbca087bdd69b\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/clipboard.js\":\"c557985c2e03001f\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/decision.js\":\"30ffc91fe862df1c\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/operations.js\":\"946cd0b593f59960\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/AccountHeaderItem.js\":\"d53c9d08e3777cb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/index.js\":\"b296fff0d8aac664\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fa261e88fca1c075\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askAgent.js\":\"9b94ad6bd0e24fd3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askedStore.js\":\"09235595da2dc186\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"603a7d9cd8a5406c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/chipState.js\":\"0fb0a0ea6209a1f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/dataExtension.js\":\"42811a1681e56c71\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/index.js\":\"b2bffd2166a4a935\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e7421ec609e45ced\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/schema.js\":\"a86d0065d642eeb1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/AgentTokensDialog.js\":\"00320f1299e08f5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ed820d86be94ff4a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/addMedia.js\":\"c8bae5a5e428ae6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6f3169c0b78d504d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/block.js\":\"cc7266a87e2fb828\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/context.js\":\"a1dd976d5cd6955e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/displayIds.js\":\"90f5011051791284\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/index.js\":\"88910053434d8d56\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/outline.js\":\"19172a0e47915851\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/properties.js\":\"22e342403849ffea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/refs.js\":\"c0e54159dcc61bb6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bb3b04918b610345\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/search.js\":\"ed794408056f68e7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/shared.js\":\"df2831a8192b6d5e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4d6a9a0890ff6cb4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/text.js\":\"d1cca5ebc9a4970c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentWrites.js\":\"b2c89a3a14a3210c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/authoringCatalog.js\":\"44b097ac0e57d2b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/blockRefTargets.js\":\"ec3cea391eadef56\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridge.js\":\"4ba95e341a52c8f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridgeLoop.js\":\"871bdf0b04852f10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/changeHistory.js\":\"cdafdb19862f7bd3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commands.js\":\"794148d37e36556d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commentsCommands.js\":\"10e930494dc66645\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataExtension.js\":\"2157a13a642b092b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataModelGuide.js\":\"08aa4b4637bc566d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/describeRuntime.js\":\"cb7544b880f7ad23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/extensionLint.js\":\"e2502293032d2ba9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/grainAudit.js\":\"d43d05db6edb2cab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/healthCommand.js\":\"4bf99425f231b730\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/index.js\":\"42aacde92213d189\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/presetIdentity.js\":\"beffb969aaea7824\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1ba79e8f2afd94e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/readMedia.js\":\"b7ccbdbea3cc34f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/schema.js\":\"8bf7dcefa3081c83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/serialization.js\":\"772ff5bc32aa7403\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/targets.js\":\"6dad437eca5b141e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/tokens.js\":\"3a653af000daa722\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/watchEvents.js\":\"475cbbc06b775d03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/workspaceGuard.js\":\"c706f92b47d8edef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/writeCommands.js\":\"0b5b52066ddcccb3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/AliasCollisionToast.js\":\"f7dc741afe0c856b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/DuplicateNameBanner.js\":\"8bcb2630d9ecae26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/collisionMerge.js\":\"ca8fe01a5030a5fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/dataExtension.js\":\"0fe4d4a9ebc772dd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/index.js\":\"c9b2ecb5ab119421\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/mergeCollisionAction.js\":\"fd8cfbdb86e2a4a0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/pageStyling.js\":\"10b928f1574fd211\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/rejectionToast.js\":\"67fe858c56be449d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/syncProcessor.js\":\"4f39d2fbd907685f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/actions.js\":\"f4136d77d7ff0f57\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/addComment.js\":\"f8a622b86c43145c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchor.js\":\"fa4ce48ffc25a3c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchorState.js\":\"53393bbc0bcd20ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/commentLinks.js\":\"e766af34150f268b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/confirmThreadDeletion.js\":\"2fa65382234ccc59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/container.js\":\"4a3f17513b1bb1d3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/dataExtension.js\":\"5ff0d4fac07b850e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/deleteComment.js\":\"666cabc422bf5ef6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/highlights.js\":\"ef215b152b5343b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/index.js\":\"92080932ce29abd5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/linkedCommentsPill.js\":\"135e2b042bf5450f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/margin.js\":\"17aaa677a1b49922\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/marginSchema.js\":\"d155a69a0fcf61d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/newComment.js\":\"e27670b7f31d45ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ownThreadPicker.js\":\"1feef4280530172f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/placement.js\":\"d827c2d2c68d56f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/queries.js\":\"65cb307463f306ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotePosition.js\":\"84347bdb6e33a38d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedIn.js\":\"0f2923eecb8c9549\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedRange.js\":\"3a05c8d7f86b5b99\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/rangeRefs.js\":\"7c9bb9af08b4d31c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readHighlights.js\":\"7661d90b4c187e98\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelection.js\":\"ffbd1018a4bf10e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelectionUi.js\":\"0f5493d17c0fa5bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/reanchor.js\":\"11cff9933f7c8e6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/schema.js\":\"ff20fc76992b6963\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scope.js\":\"8384c4b0db3d3417\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scopeThreads.js\":\"fae2132a556af084\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/splitRetarget.js\":\"d8dc4b1f3be4fc9c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestionCard.js\":\"c776c9767325ae46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestions.js\":\"062f0b906a9543a6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaries.js\":\"e012c896333e1bb8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaryBatch.js\":\"17f733a2a613db88\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/surface.js\":\"714700f06e8d6df9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threadNavigation.js\":\"3e20c48a1d2b1bab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threads.js\":\"8776722a3f20f9b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ui.js\":\"602b1d667fc823d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/uiStore.js\":\"0eb2bc36af8f4b41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/appIntents.js\":\"cadab41c6f488444\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/index.js\":\"9cf161af46e5ec35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/index.js\":\"6ec32405242afdbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/status.js\":\"2d728f65bf3a9981\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e9d3602c63b1a977\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaBlockRenderer.js\":\"b278bee6719db11d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaDownLaneReplicator.js\":\"497e78285f33af1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaUploadReconciler.js\":\"5fcf870f86a87080\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetDownLane.js\":\"499f0833a879925f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetResolver.js\":\"72e70627d4eaf721\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetUpload.js\":\"57b5256ee26ba7eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/attachmentCleanerIO.js\":\"c98a695671938372\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5a49c4bddf56ecc9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/blobStore.js\":\"ff156cd490ca2d6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/byteStore.js\":\"408ea8d5b6ab4126\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanerIO.js\":\"6086f257c7ae2b06\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanupAttachments.js\":\"5922ec6ead74d004\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/dataExtension.js\":\"6760f534f9d83cee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/downLane.js\":\"5d79a1ff03418ad3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/index.js\":\"04b7a3b949d00773\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/insertImageContribution.js\":\"ad00270773e41bba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneArming.js\":\"347ae14f2cc0d0e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneLock.js\":\"2f6968667e92d894\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaBlock.js\":\"eea679c417babfed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaCapture.js\":\"5e527bdf25634cde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewers.js\":\"0ed0943c2ac2d0c7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewersFacet.js\":\"00c38f0146d9b87f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/pasteCapture.js\":\"bbc9a185caabdcbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/resolver.js\":\"22ab1708e5d0944c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/retryUploadsAction.js\":\"50973e73a8d2eb64\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/storagePaths.js\":\"626790dcb70c131d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadDrain.js\":\"afea465b1f9b50db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadLaneStatus.js\":\"00807fd629567124\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadReconcile.js\":\"6752e0e9a9fe86f1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadRecovery.js\":\"3a70d8ac3c89cd87\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadStore.js\":\"a7fdfc523e1dfda4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/useAssetObjectUrl.js\":\"7c685c46799cf021\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"57807650daf4da7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a71915af61f13c97\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/facet.js\":\"3f308911a8ccab23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/index.js\":\"0a377b507347551a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/prop.js\":\"b0220d3353254871\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinkFilters.js\":\"8795b4fdfc2ff3ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"02eb417c17a6967e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BlockEntry.js\":\"ab45d3d22f154520\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/LinkedReferences.js\":\"564fa5d74dba49f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"35500bd376c38f35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dailyNoteDefaults.js\":\"bc097b0b5433ea81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dataExtension.js\":\"bc728a5d220ab909\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/edgeExclusions.js\":\"156d07d5e16e3399\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/filterProperty.js\":\"80e239e4dc0e734c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/index.js\":\"e40cd2ba0451991f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9323564bea5aee0c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/applies.js\":\"f7b803c694c8d02c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/countQuery.js\":\"ccc2433658d9cb1b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/expansionStore.js\":\"211ae1ee18f33d48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/index.js\":\"94650fe63e9aa8df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"134c6d3d2490c2f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/presentationInvalidation.js\":\"7e7f091fc7431492\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyEditorOverride.js\":\"839c2c10a46f458e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyFilter.js\":\"d1a018e89d4f15bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/query.js\":\"bbd01e69a3da5aed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/resolveFilter.js\":\"e0ca5c5c042bba96\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sourceBatch.js\":\"faec6f3bb557632a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sources.js\":\"c15533c3b5209d68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useBacklinks.js\":\"b81fe102c736d15d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"61e0cb2706a8ede2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayCelebration.js\":\"d662fb96388c14b1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayOverlay.js\":\"92136d423aa96474\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/gate.js\":\"52e7824ba5439139\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/index.js\":\"c275cd2d0228ea9d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/wolfTheme.js\":\"8878122bc5bb3056\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/BlockDragLayer.js\":\"2e9247645814a49f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dragController.js\":\"10b7194b9f3f5473\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dropTarget.js\":\"4e2baafc17ded430\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/index.js\":\"04a7a3ce0b67eee3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/projection.js\":\"e6fddfed10a4ea7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/BlockMetaCard.js\":\"75f64c707dd600d3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/index.js\":\"7f8325cde2e523a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/AddTagDialog.js\":\"3ff7c6587204a81c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f953a2eb13407fb3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/TagNameIssueHint.js\":\"f57e698e30b72b00\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/addTagAction.js\":\"7131837df1d90351\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/appendTag.js\":\"24626d09e0843d9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/config.js\":\"a94bb4184355ff8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/dataExtension.js\":\"d59b3930a87b3d32\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/index.js\":\"daaf96424430152c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/propertyEditorOverride.js\":\"00f384d183ab6358\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1e0ffb97398c6e83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"60b0276b876cd013\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/Breadcrumbs.js\":\"75da14f82c28e65d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"07a98919306bcb9b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"27a21b9c4f50d60c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/index.js\":\"3f9efe15fa3cceab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d5a607bdbdc33142\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/CharacterCountItem.js\":\"2bd9fb46528c7d40\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/ProfilePropertyEditor.js\":\"616126278b5cc1a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/actions.js\":\"ad0dcf0dc900d4e5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/blockType.js\":\"fb8c4e74767ee04d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/charCount.js\":\"6e52c1a75ec35d7d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/dataExtension.js\":\"c148ea15ab5bb1aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/index.js\":\"446978ebf741950b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/profiles.js\":\"c9e6049f76146570\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/properties.js\":\"55b18b0d9835ef60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/textCounts.js\":\"12b399549ddfbc7f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/colemak-keybindings/index.js\":\"d84af80a3f457964\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/CommandPalette.js\":\"b4d5b832f5071e91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/HeaderItem.js\":\"cc25202306975b5e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/context.js\":\"cff6428c3c793a24\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/index.js\":\"204e9f58b7f2ac3f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/selection.js\":\"67759d8c30aa35af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/toggleStore.js\":\"02da276f6e43c797\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/useCommandPaletteActions.js\":\"c02d203970ca6239\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/ContributorBadges.js\":\"356cabfdd1ccaa33\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/author.js\":\"6c2c4fe8e73060f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/codeMirrorExtensions.js\":\"f78347d97f9a2eee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/dataExtension.js\":\"6f5f45fe8547af11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/index.js\":\"334f1a24933ed855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/mentionAutocomplete.js\":\"3a723d2c17a5351b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/processor.js\":\"0293cbd4e3c582c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/profiles.js\":\"0caf03d3ec31f745\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/queries.js\":\"a50aa1ebb9550a34\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/schema.js\":\"bbb0509964069890\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"537bc2bf38016f16\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/followOrigin.js\":\"933ace909b99d00b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/index.js\":\"9929ba05c1025064\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"35488baf6cf7799b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"81335a3e883dfa43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/CalendarGrid.js\":\"aaa44c46b26011fd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DailyNotePicker.js\":\"6d552f739955ae49\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b3627cc992656c7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateNavDecorator.js\":\"9b24c7dcff58b329\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateScrubOverlay.js\":\"9c2d36f9484daac1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/HeaderItem.js\":\"11458398271f3ec1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/ReschedulePicker.js\":\"88824658a117cf2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/SpreadDatesDialog.js\":\"be74860577c6e24f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/actions.js\":\"29fb35ff22cf5a8a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/blockDateAdapter.js\":\"607d41b565c4190d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/calendar.js\":\"2c143975838c75cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dailyNotes.js\":\"b6d2e1262f4575da\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dataExtension.js\":\"00adb00f2165a321\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubActions.js\":\"46d3c050b2d7266d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGesture.js\":\"b92ba79715077cd0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2479495508985804\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3948e7131413e67d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/deletionGuard.js\":\"a76d620c7450cad6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dueQuery.js\":\"ab16264dd8cc073e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/index.js\":\"fa14dd4224cc721d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/landing.js\":\"3fd3806b3b0254dd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/localSchema.js\":\"4bcaae2a2867ce1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/referenceDateAdapter.js\":\"d5b7c20329429ab7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/rescheduleAction.js\":\"72d320e9942275b1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/schema.js\":\"329bcfc8f97e2ac3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadBlockDates.js\":\"90fc0f8857bb4d5d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadDatesAction.js\":\"f37883d11f740fbb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/today.js\":\"9a17dab384fefbf5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e0bb2078b4ca4e46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bd7a11977e776f11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/audit.js\":\"04e84f92f10fb446\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditAction.js\":\"89ffaacbe767c21a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditRanges.js\":\"6c3d240cf0692243\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/diagnosticsSource.js\":\"e5706252eae7f200\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/divergenceScan.js\":\"ee12b756bf0bec46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/index.js\":\"3cc416a87089fc2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ebc6fcf2081fda76\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/referencesMirror.js\":\"8752ad7cb7b16123\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/rowJson.js\":\"e36dc1c4875f29d7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/schedule.js\":\"1a13ab660b43c209\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/store.js\":\"c5be82ffc233cf55\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/action.js\":\"dcb7361bd2faad8c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/index.js\":\"0f9fa5a0741ec86f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/plugin.js\":\"f07376598fcc3ea8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"43ddfb28d6bb31f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/actions.js\":\"d6c6c5bed356b9ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/changeMarker.js\":\"b77a68deeb5843f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/diagnostics.js\":\"2882fb8c5bb2adec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/fileSystemAccess.js\":\"c8b95dfb9577817f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/filenames.js\":\"3894a3403c73ce48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/index.js\":\"2ef5e238ebc8a1a0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/mirror.js\":\"325451b71d3f0d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runLock.js\":\"4ce110c4e20c7c5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runtimeHealth.js\":\"3b7dcaf3c247401d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/schedule.js\":\"ae6c5fb1612cabff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/store.js\":\"b50130e4f9165f0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/index.js\":\"b20db4ac26920566\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/themes.js\":\"73de2a6476169819\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/facet.js\":\"b7b4be8e25f13daa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/useDiagnostics.js\":\"4246edc2606170ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/dismissals.js\":\"2e8d1cd30bd46aab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/index.js\":\"d88b03a68df17983\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/status.js\":\"2613a3d7f4812664\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/store.js\":\"0b45bbde0379dc5e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f0c1427608c60024\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3d6f8e9d9e6e2cb7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/actions.js\":\"61b94411e7e65651\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/config.js\":\"a49f0329a543ceb8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/dataExtension.js\":\"1a35224f2e28cca8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/effect.js\":\"e7de1783c20ba0d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/index.js\":\"020387bad345c53e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5f968fafa03faebf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/useToggleTree.js\":\"552db01af7f96b94\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/ExtractTypeDialog.js\":\"2c1027b3eec32d4f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0167bb83f1b15442\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/PropertyShapePicker.js\":\"6bde4bb3864f7ea0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/action.js\":\"8236ecb0e6b0341b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/index.js\":\"4781beffe369ed88\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/FindReplaceDialog.js\":\"8ad1fc1ac1b1432e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/HeaderItem.js\":\"0bd035f456831830\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/dataExtension.js\":\"49424791b7a13252\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/index.js\":\"b1d7e8948cae88c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/search.js\":\"10e12666beec1cb2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/toggleStore.js\":\"588441d5947ee48a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/LocationPropertyEditor.js\":\"2b3432ee3016de0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/MapView.js\":\"bdceeb030628b2c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/blockTypes.js\":\"9dd2d8d5d04dd663\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/codeMirrorExtensions.js\":\"24d9e1c18ef83be8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/createOrFindPlace.js\":\"9d5e349a99479c44\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/currentLocation.js\":\"975d2a246067db88\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/dataExtension.js\":\"ca52e038703f68ff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/geoContentDecorator.js\":\"a5405325f34c1d7e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/googlePlacesClient.js\":\"9f8b748c9a0d0340\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/index.js\":\"52eae830ddc5b48f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/locationsPage.js\":\"217a7bf4907c6099\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/mapViewport.js\":\"e32869a1a15bd7f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/pickCurrentLocation.js\":\"669b6283ea8db662\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeAutocomplete.js\":\"b63572505c697aad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeNameCollision.js\":\"60698565986c61e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/properties.js\":\"d718f79d1b24ac48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/propertyEditorOverrides.js\":\"bcf1512f606a5d74\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/query.js\":\"9fae9cbd9c98b4c3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/usePlaceSearch.js\":\"68939f67f0b33fbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0b18b13d207a3060\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e987496e6aed1bd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"77ed7c4d47f3bded\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/config.js\":\"132801243f4943d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/dataExtension.js\":\"8a9d44e309bc0486\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/facet.js\":\"9a48fd3601dcb93c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/grouping.js\":\"30573d8a9b111bb8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/index.js\":\"940351be22abe189\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7a9a15307ed46689\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/query.js\":\"fbe1132ce62bae10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/resolveConfig.js\":\"1478c65e863f208e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"137707f8baddc869\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2e3026ac0e8e1307\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlDocumentContent.js\":\"487f7fa20dc38546\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlFrame.js\":\"4178348c8761d03b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/actions.js\":\"4b66464851b2ca52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/blockType.js\":\"850b0349aceff369\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/confirmRunScripts.js\":\"71f3e03ceb6876f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/dataExtension.js\":\"0d120e4ceeb29ad1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameAnnotations.js\":\"d615692d617d5146\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameDocument.js\":\"3bb7fc85b4fc716e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameTheme.js\":\"7178cc726b442f86\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/index.js\":\"7fed4df0ed840c9c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/scriptConsent.js\":\"7e70febabfa111a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/sourceMap.js\":\"9aca2313a10e3b6e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/useDocumentScripts.js\":\"97dfa3a72c8d7e2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/index.js\":\"8372133d3530e08b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/record.js\":\"cb542fff96d1d86d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/recordStore.js\":\"839c1093314f4e00\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/responsiveness.js\":\"33588c9e4250df4c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/schedule.js\":\"fc967b361da2999c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/sessionContext.js\":\"9fef9064fda84cb8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d75310779bd6729f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"59e60d7c2940fbb3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/actions.js\":\"12f673b3a1959187\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/config.js\":\"32c1713dd6c3e868\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/dataExtension.js\":\"4fc1bbef482b7572\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/effect.js\":\"069b8b5899585a83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/index.js\":\"7015af0dceb2bcc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/keyCapture.js\":\"f72b294e7a676a50\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/overrideStore.js\":\"ba24bf04b093a6fb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"17d78fcd57fd75b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/HeaderItem.js\":\"77690df350efbab7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/LeftSidebar.js\":\"70828e675a5b26dd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/actions.js\":\"396845a13909a6b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/facet.js\":\"99eeffe59e26b9ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/index.js\":\"f5db5788cfd03cb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/shortcuts.js\":\"c823a1886adcd56b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/toggleStore.js\":\"fc585d0ad50ffa36\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/MergePicker.js\":\"d638755af40f555d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/index.js\":\"9f3cfc2f2d332a0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/mergeAction.js\":\"b8ff7db8ee424fce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/strategy.js\":\"dd1e905b15ff6e0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/Button.js\":\"27d646a52dbcbbca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"77acaf930475300e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6f74ed27429f9720\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/facet.js\":\"d9c1cd56831602e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/index.js\":\"57e4cd7dd8fc5f93\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a6c09d51d412098c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/actions.js\":\"27030e141ef60fbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ec0f1828afa19be2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/facet.js\":\"45d86b688525d070\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/index.js\":\"d6f2b0ddbcbf7233\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5f2bb4cd2e224738\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/blockSubtreeMembership.js\":\"07700854809d88bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/contextMenuItem.js\":\"13d31d79da719761\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/index.js\":\"d2e7cd04b8eb949b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveAction.js\":\"b715a4c23a6a5b16\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveBlocks.js\":\"b5624910557fee5f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/selectionAfterMove.js\":\"2f746fc66c6644d7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/TutorialBanner.js\":\"25ea160c349f616a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/action.js\":\"72658671c7ea35ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/bannerDismissal.js\":\"afbdf0eefe4767c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/documents/cheatSheet.js\":\"9b2786c47691f557\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/index.js\":\"8d7185f4a8660383\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/keys.js\":\"3f991bc8ad067469\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/landing.js\":\"6fce4ced22b2defe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/outline.js\":\"ad6e08f25b0e20fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/seed.js\":\"a3bbc8c0eb652eb2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c5f733c8dc2d2de0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/analyze.js\":\"ad512de93098c83f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/diagnosticsSource.js\":\"da8b79c0efbc4f27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/index.js\":\"d8e514775c07c7e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/load.js\":\"c301ca591d7ce3c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/monitorRun.js\":\"f2b1470e24658799\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/schedule.js\":\"08baadba2e4026f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/series.js\":\"67147c9413216dec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/store.js\":\"120c07c9d44c3dfa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/trendAction.js\":\"e14e32452bd5eddc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/verdict.js\":\"bffe316346f376b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/clickToEditAction.js\":\"46feb57eb8a1abd9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/index.js\":\"53b4de403dd62e2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/interactions.js\":\"30d5edb39ab4fef6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"045fd0aa4bc363ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGate.js\":\"a0b9c8cf974293f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGateDialog.js\":\"595f4fba34b19bff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/action.js\":\"ce63a49ff3f07d52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/index.js\":\"2e10d03eccda0554\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/localRunMessage.js\":\"3c284bdd8b1036d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/plugin.js\":\"2f1c25b7e3c97a91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/progressReport.js\":\"5cdbac1d6cbf95f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/sweepProgress.js\":\"52cc79d1bae28025\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/FieldRowRenderer.js\":\"05611089d59ca3eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/ValueRowRenderer.js\":\"0af39f6d854b6cb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/actions.js\":\"b2b9e3f4bc8f9a67\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/autocomplete.js\":\"03ab2a0373a96ff6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/fieldRow.js\":\"3f480aa896153b53\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/index.js\":\"ee2331c990ab0bc9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/referenceWarning.js\":\"9b45f1e0865d0b69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueAutocomplete.js\":\"a4c459226e1ec530\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueSchema.js\":\"4b21d066e258b5db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/HeaderItem.js\":\"fc6c15a5a2505683\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/QuickFind.js\":\"7baf28914236e86d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/index.js\":\"b72c0f1d5de8ab28\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/recents.js\":\"c975dc8345ef048c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/resultItems.js\":\"ce47ff301be35911\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/selection.js\":\"3b57a3c9c1fcd934\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/toggleStore.js\":\"5d489ef3f56c0705\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/HeaderItem.js\":\"cb5bc73a95056290\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9394056888b6cfe2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/grouping.js\":\"b9a380fced9bcbd0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/index.js\":\"a2dfc05d945ab68a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/target.js\":\"85f9c495ffdee12c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/codeMirrorExtensions.js\":\"0ba28eb193661c5e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/contentPrefill.js\":\"50e6ded390d462e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/dataExtension.js\":\"7579507ebabe4244\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/index.js\":\"21568b93d6173e9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2bdd7c1fb984694a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/invalidation.js\":\"1a5b3dcd37fc6adc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/localSchema.js\":\"9793fbbc357e1789\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/index.js\":\"cbc00110cb17f373\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5e5fde9d6f50d27a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/index.js\":\"a5e38299a35be017\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/referenceNode.js\":\"f22f1fd48ce56ff6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1a9dc8267d48fa1a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ecc49f198cfeefc7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/index.js\":\"2b2b9d2e7bd45d80\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"6da14e2708e5284c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5f8527677c9259b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/mergeRetargetProcessor.js\":\"d1e95e8c4fd2ebfe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/parseFence.js\":\"757f6cb35c5d3a31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceParser.js\":\"9f358d3ace0547ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceProjection.js\":\"aca827bfae303258\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referencesProcessor.js\":\"0dd5887a39d9ec31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/renameProcessor.js\":\"6b4624f992f7e833\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/spanReplacement.js\":\"d5edabaeb142009c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/htmlToOutline.js\":\"0e866224d72147be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/index.js\":\"b6ccb9122839a020\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7fdd802ff43a9c3a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/pasteDecision.js\":\"9f7ca93019749c77\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/action.js\":\"8cc720c71b41b187\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/blockIds.js\":\"de70b70b1b12270e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/content.js\":\"4dc2c987210983d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/effect.js\":\"c89ba9676dd46ba4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/ids.js\":\"d9069e6353b7ccd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/import.js\":\"756a0a0d8ee9b272\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/index.js\":\"d5a6075270984d22\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plan.js\":\"4e4997dd4be644de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plugin.js\":\"fc53e703aedd4ffd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/promotion.js\":\"4effdd6ffcd53eff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/properties.js\":\"68a76a3e8351a97d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/references.js\":\"17c5cb0e6c8e3c39\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/report.js\":\"b6cd0820beff4ce9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/roamMemo.js\":\"775e470d0139a773\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/runtime.js\":\"bd7ff8c5fc57bd3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/schemaReconciliation.js\":\"cd79d818c99624d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/srsMarkers.js\":\"1ba50299b8c5a828\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/todo.js\":\"f8df408a136a77ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/typeCandidates.js\":\"6c0dabb4a29feb80\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/types.js\":\"50bdd83590c78c85\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/index.js\":\"9b81563669a6bd5c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/store.js\":\"aaf64a9185eb4ec8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/HeaderItem.js\":\"4765e9444826899c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1bd9d1d1a0b7618b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/index.js\":\"9ede9e82672a744b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/model.js\":\"a9d0a84e62ba2b53\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/toggleStore.js\":\"950b89aab41c1c2c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/useKeyInspector.js\":\"9012acc37ca5accb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1177c106d5fe1b7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/ShellDecorator.js\":\"a8a08d0ab223a614\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/actions.js\":\"d9a271e3155db744\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3b9ae055ebdc1b87\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/index.js\":\"fe1a277b6f49e627\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/shell.js\":\"56f8393c93d7a6be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/surface.js\":\"500541c968481f5c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/walker.js\":\"6a91f22a77d562ac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dc33bf7f539f77a6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/dataExtension.js\":\"3329735f1d51fb70\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/index.js\":\"e595d017ad11a014\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/indicator.js\":\"af3987094c7f7d1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/moveSrsState.js\":\"a6d8116df1a99e19\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"43d35f5872d58f83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/scheduler.js\":\"250bff20ed5a3085\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/schema.js\":\"3258548562c8a596\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"320c4a1da82d7e59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsClipboard.js\":\"e2cae209070360b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f79c934d0eeaac53\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DailyNoteReviewHint.js\":\"de5f2d7b9561af67\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DeckPicker.js\":\"01e05a95ab015618\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewControls.js\":\"9ad6482aaeeaf785\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8be2c2bde1337462\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewSession.js\":\"2463415f69599418\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/actions.js\":\"f16f753b47b32601\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/archive.js\":\"78b764d61300ae77\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dataExtension.js\":\"8bd646aeaa17bb84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/deck.js\":\"63950da312e49719\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dueQuery.js\":\"2ccc1819eeff41d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/gradeDecision.js\":\"f30da0b92ca05e1a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/index.js\":\"7c766773424260ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/keyHints.js\":\"15f3c361fa93d475\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewCardLayout.js\":\"6c22bafbc3af9ae5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewProgress.js\":\"4240640243dd0c3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/schema.js\":\"209f1874ae30b482\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/useDueCards.js\":\"82e8c922cbd6988e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/index.js\":\"c66308b473519de8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/record.js\":\"8d645370c2564ba7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/index.js\":\"a8d62e88ce23bcf1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/persistenceStatus.js\":\"03c94dcc3c24a29d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/requestAction.js\":\"a7347e6a7cec522b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/TypeChipsDecorator.js\":\"bcaadc43746f479a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/codeMirrorExtensions.js\":\"d4f162453215d5e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/index.js\":\"f0ea90b5644d44f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/typeAutocomplete.js\":\"f54e580b5dda487e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e0615682470d8ba0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/actions.js\":\"4b908fdbee0bce5f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/anchor.js\":\"f7577998ca64ee83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/events.js\":\"598d789854ebb838\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/gestureActions.js\":\"f7fd794e226d0788\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/index.js\":\"26ff0f8d9873f03a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"83e202063b039230\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/collect.js\":\"4be92e6b3504eaaf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/index.js\":\"cfe1120ead9f9526\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/record.js\":\"56d51f4482ebc467\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/RejectionDialog.js\":\"4d22f70b0e3896c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4cb18c96a481ccd0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/index.js\":\"d64f26c2e863cc6a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/model.js\":\"ff7e0f93b621ca48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/queueCounts.js\":\"6af5dbb1a6548f2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rejectedHelpers.js\":\"accb8a865453af9b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rematerializeAction.js\":\"24632fc2735fb5e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/useHysteresis.js\":\"d6c08f3028658392\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/effect.js\":\"c358535849652b1f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/index.js\":\"c74f9ce4c3562f58\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/theme.js\":\"2270bce915e79457\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/actions.js\":\"99e5cbed97374071\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/dataExtension.js\":\"102c502d58097376\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/index.js\":\"3c52b957b4785073\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/schema.js\":\"5e4fbe54821cac77\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/TouchSelectionLayer.js\":\"68a6a30a0a4be81a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/actions.js\":\"240d6f820b7651df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/defaultItems.js\":\"9f32e6cc0626cd68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/facet.js\":\"b215cdfaa02e91b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/holdRecognizer.js\":\"aebe1380949d7087\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/index.js\":\"81d7d3bddb804429\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/UpdateIndicator.js\":\"0294e851e05cef51\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/index.js\":\"f4b15577373749be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/loadTimes.js\":\"3915fd4d1383fcf1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoNotesRenderer.js\":\"246802e87307e3a0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoPlayerRenderer.js\":\"5653d68dcd41453f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoTimeStamp.js\":\"ff4cc21877fffe3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/actions.js\":\"3ce83f470a83ed11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/index.js\":\"46479814dfee3907\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/markdown.js\":\"0f59d30d7a8f0681\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/notes.js\":\"c06d567e3d307c97\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/registry.js\":\"6f0d4c9cf3996b1a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/remark-timestamps.js\":\"a4bf0ef1b0a27b98\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/view.js\":\"ebcbcf5debed7278\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/LinkHints.js\":\"735fdc852e33f2ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/index.js\":\"a298fbc521e9e5a0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/model.js\":\"9f1b65ac6516739d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/settings.js\":\"7a74e35767896464\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/actions.js\":\"007ea257e36beb98\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/index.js\":\"b7c6faabee2f8b70\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/interactions.js\":\"0dfef9c2a4fed289\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/workspace-header/index.js\":\"603c693998da6d45\",\"/knowledge-medium/pr-preview/pr-1788/src/registerServiceWorker.js\":\"441ed51b267a5c59\",\"/knowledge-medium/pr-preview/pr-1788/src/requestPersistentStorage.js\":\"5dfefeac5ee2a343\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authRequestDeadline.js\":\"3a9a3bf6ec52ea29\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authStorage.js\":\"0ef4b36ab458845b\",\"/knowledge-medium/pr-preview/pr-1788/src/services/powersync.js\":\"c01b5b08548aad6e\",\"/knowledge-medium/pr-preview/pr-1788/src/services/supabase.js\":\"31c4fbca0f9e591a\",\"/knowledge-medium/pr-preview/pr-1788/src/services/uploadErrorClassifier.js\":\"2365efd42606cb74\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/ActiveContexts.js\":\"0ef6e5df0698db8d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/HotkeyReconciler.js\":\"fc7df3e816ff11a0\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/WipeLocalDataDialog.js\":\"2433a84f17e7d542\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionDispatch.js\":\"0e17d77673364447\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionRefItems.js\":\"f3297b4024379acf\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/applyKeybindingOverrides.js\":\"0df60fc8eb2a66fe\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/blockActions.js\":\"c0493983bc4012e5\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/canonicalizeChord.js\":\"8de75c1e954bf19f\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultContexts.js\":\"e207a2be02d51256\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultShortcuts.js\":\"3ab47ac4fd22c48b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/effectiveActions.js\":\"5bfdb0c1960c7d35\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureAction.js\":\"8d97dd9e78dce84b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureBinding.js\":\"1adc1879be0ef454\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/holdRegistry.js\":\"54f9d735eba22165\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingConflicts.js\":\"7c016ab15512bfd1\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingOverrides.js\":\"81006f907b7c804f\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/pointerAction.js\":\"f061b3df807b0d62\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/resolve.js\":\"3b3058dedb27e75a\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/runAction.js\":\"da6ae2bf27d59823\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/sequenceMatcher.js\":\"91b3c80f7c2a1f9c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/types.js\":\"3fc9874ea7b295b2\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionContext.js\":\"9922f8943baa9fa6\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionDiscovery.js\":\"56adc4bf03414405\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/utils.js\":\"7aedc91f07b8e995\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/bootStore.js\":\"e1558771bf1560f9\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/previewDatabases.js\":\"8b59ad76670b3b0f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/byteTransform.js\":\"f07604dbb179c4c4\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/attachmentCleaner.js\":\"36c7d0ce45e64c04\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/attachmentParts.js\":\"19b013c608639035\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleParts.js\":\"d22060b180990dc1\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleRecord.js\":\"4eccf22be404e4a3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/manifest.js\":\"8d09d44464a20c2e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/takeBundle.js\":\"0cc32b2573e7f519\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/verifyBundle.js\":\"53599be672da216f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/cleaningStage.js\":\"ab0711abc3f318bc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionKey.js\":\"4883f43b7b486f58\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionServer.js\":\"c087f822c38e9665\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flip.js\":\"c178e57921ab4721\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flipAttempts.js\":\"5d127684dbd3360e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/pages.js\":\"c2bf7743b143ef5c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/preflight.js\":\"c1d76bb7c802e2b7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/reseal.js\":\"2dea22779de752b1\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runConversion.js\":\"2ac2ae98d8f57a66\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runLock.js\":\"50bd59c5d2abaf4b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealing.js\":\"e95d1617910c68f7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealingStage.js\":\"63d926850e43cef2\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/stage.js\":\"3b9af608898a729a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/verifyReseal.js\":\"a64ed9c82e7505a9\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aad.js\":\"72d58120247a107b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aead.js\":\"399263f18d73921a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base32.js\":\"903b7063234b1f93\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base64url.js\":\"0f267c813a362c67\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/binaryEnvelope.js\":\"0aba4e4c24f575d5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/byteAead.js\":\"08f11d4862ab8f40\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/canary.js\":\"89bc2fd1983ea8ab\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentHash.js\":\"e2b4de38c62daccd\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentKey.js\":\"4464ed669c9b6622\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/derivedIdNamespace.js\":\"0ecb1deee6c50c7b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/envelope.js\":\"7bba5b7e1f5504a6\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/hex.js\":\"4bbd2f232ae3bd2a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/sha256Hex.js\":\"5726c3673465b973\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/workspaceKey.js\":\"1e3040723c5c6598\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/conversionState.js\":\"5edf7025b3abc54b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/createEncryptedWorkspace.js\":\"78bb8979d17f2031\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/pastedKey.js\":\"d6a054c0a1ff815f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8a9b336ae813b36a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4b2475a34460cda8\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/keyStore.js\":\"b3bbd5476d3ce741\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/mintWorkspaceKey.js\":\"a850efebcc42a706\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/modePin.js\":\"4c3fb674f7ae3bdf\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/openWorkspaceKeys.js\":\"779c4f50d7cca5cd\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolveWorkspaceEntry.js\":\"deef86fd9b61b389\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolver.js\":\"6c2fcac7c8d4740c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/workspaceAccess.js\":\"85ec0f1620c8b613\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/transform.js\":\"81c9efc9866ddd01\",\"/knowledge-medium/pr-preview/pr-1788/src/themeBootDefaults.js\":\"477a0f8ab89c0b0f\",\"/knowledge-medium/pr-preview/pr-1788/src/types.js\":\"e6f771ebe8d47604\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/ClientLocalSettings.js\":\"18530e7e1099faa7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/abortableSleep.js\":\"f4f805ed47b58b2e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/array.js\":\"d7e66c7f6bc97d98\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/backlinkAutocomplete.js\":\"e8565dba5b438ef2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockCrumbs.js\":\"6fa81696d200fe37\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockrefAutocomplete.js\":\"72a2c2ffe576af54\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/cadencedIdleJob.js\":\"cbfe6b3380533f87\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/callbackSet.js\":\"266d74ec8ffe17be\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/clientId.js\":\"0832991213614b01\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirror.js\":\"e448d650e9e05f38\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirrorCompletion.js\":\"10dc29e6f5ca99c8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/copy.js\":\"91fdd8cb77ef6bf7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dailyPage.js\":\"a35848e160dfc0b5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensics.js\":\"b1751ea768338204\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensicsHooks.js\":\"f8412113c83dfcc5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/deleteBlockThroughUi.js\":\"c0936724c0d88640\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dialogs.js\":\"6a35a7698780cd1b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dom.js\":\"9c71246e5226b8b1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/downloadBlob.js\":\"726e7ed80aee50d2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/exportSqliteDb.js\":\"4e42b6ce6fdec755\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fileSystemAccess.js\":\"f8da9a37fe6f725f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/flipSlide.js\":\"a28ddae879e4cf6f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fnv1a.js\":\"e10dbb9f73dfdf0b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/formatBytes.js\":\"77694f6119cdad3c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fuzzyRank.js\":\"b340fa1b2dcd1b79\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idbKeyedStore.js\":\"eacf8a268b689153\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idleCallbackPolyfill.js\":\"ba26bf4d024705a0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardAwareScroll.js\":\"41f5d91735b488b7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardViewport.js\":\"5a61041ee9a855af\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/lastWorkspace.js\":\"6e38faefaab577bf\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutColumns.js\":\"f7ca0b2e93b92528\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionDom.js\":\"eb8d3bb930912336\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionId.js\":\"5d34ceb6e8f38380\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkClickGestures.js\":\"9902a75cc022964e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkTargetAutocomplete.js\":\"2165392d9e392818\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbCorruption.js\":\"d942721dbb4a0a7b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbRecovery.js\":\"3cbe845aacf01c9b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/markdownParser.js\":\"250f2361087feff7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/memoize.js\":\"df3e5a18476360b8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameFieldCommit.js\":\"03f18d93e8453c6a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameList.js\":\"502291cb1a7bc0ff\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/navigation.js\":\"c4f90112e86824ae\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/omnilinerNamespace.js\":\"5de77518aacfeff1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/opfsPageScan.js\":\"ef9277c059081a1a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelClearance.js\":\"fa9df44af1918b16\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelHistory.js\":\"050b28c47787ec77\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLanes.js\":\"6702b3e33d49ecc6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLayoutProjection.js\":\"401c1fbfb88f1ad7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelScrollAnchor.js\":\"29ac623d7f9ca6c0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelUrlFlags.js\":\"0756a02ce179b34f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/platform.js\":\"4a8123012faf9727\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/pluralize.js\":\"be2976b6d33e97f1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyCreation.js\":\"f573f2bcafa96a07\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyNavigation.js\":\"76dfe19437e7b9cc\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyValueContext.js\":\"45f68e2377a52289\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/react.js\":\"fa256d90ed8135f5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeDate.js\":\"926ac39921da020f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeTime.js\":\"e8eae6c4259f7077\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/renderScope.js\":\"41991785cd7f1fce\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/resolvedThenable.js\":\"c0c8033856431404\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/routing.js\":\"f6e5c2d164245ef2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/safeMode.js\":\"bc8bb36552f9513c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/scheduleIdle.js\":\"7ee6bc5b9a3e8f4d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/screenWakeLock.js\":\"56a060a1c71eafef\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/selection.js\":\"eda7faf23cd6a05a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/softKeyboardGrab.js\":\"cc3bd0666d3b7547\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/startupTimeline.js\":\"fe3d3b5e712b5978\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/state.js\":\"7e8b98d130731927\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/string.js\":\"4aa737b495523ef0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/surfaceZoom.js\":\"21868b682e4d8c60\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/time.js\":\"77f926dfd0bb8aa6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toast.js\":\"7b2f7380eed2cba2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toggleStore.js\":\"7ce3ce7c8a5165ce\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/untilStopped.js\":\"e6200bd7da17321e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/userActivity.js\":\"149ade64492915e1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewTransition.js\":\"65abbb3b68698328\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewport.js\":\"0b9eebe675ccfef0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/webLock.js\":\"151e20e4b0fc8036\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceRecovery.js\":\"59818810b95ded5b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceSnapshotStore.js\":\"b8c639d469e57270\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-compiler-runtime.js\":\"e6d300276e443ba0\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-client.js\":\"e68e30aa0e6559f7\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server-edge.js\":\"167b8311dd39dd32\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server.js\":\"3d615f0a87319cb4\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static-edge.js\":\"19b2719aee1879cb\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static.js\":\"5bdea7034a750e6d\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-test-utils.js\":\"38cfe8cbc7a074d9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom.js\":\"958dfd37d785e4e4\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-runtime.js\":\"a611d6b8d7de98f2\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react.js\":\"a69e4f70e252a6b2\",\"/knowledge-medium/pr-preview/pr-1788/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
