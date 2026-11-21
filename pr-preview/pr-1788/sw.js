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
		buildId: "98469cc5daf9-423c2f3a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/\":\"c0f06265372507d2\",\"/knowledge-medium/pr-preview/pr-1788/index.html\":\"c0f06265372507d2\",\"/knowledge-medium/pr-preview/pr-1788/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1788/assets/FacadeVFS-ZCRGUJFE.js\":\"df97fb4891d87120\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSCoopSyncVFS-DFvj2ptq.js\":\"e07dc91ded818d1b\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSWriteAheadVFS-CBn5jnWO.js\":\"90d72333506619de\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-VHim_sjG.js\":\"3ee607d1115fdbcf\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-D5y5E6Iu.js\":\"5530d0155c73c11e\",\"/knowledge-medium/pr-preview/pr-1788/assets/worker-CQ3oMEyB.js\":\"fd4e74c127fa613d\",\"/knowledge-medium/pr-preview/pr-1788/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1788/chunks/app-CiAN7JVZ.js\":\"775cd38b69249ef5\",\"/knowledge-medium/pr-preview/pr-1788/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1788/index.js\":\"aecb92474807360f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1788/assets/AccessHandlePoolVFS-BIZFShHd.js\":\"40163fd2584d781c\",\"/knowledge-medium/pr-preview/pr-1788/assets/IDBBatchAtomicVFS-CIfB4ukQ.js\":\"b7a76d7f99c5831b\",\"/knowledge-medium/pr-preview/pr-1788/assets/MemoryVFS-PEM6NHw2.js\":\"5805389859240a11\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-ChWoBi98.js\":\"0f3d89b51a9ad7bc\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-BYnt30z1.js\":\"9f91e98210bd7325\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1788/chunks/AccessHandlePoolVFS-BqmaBjjI.js\":\"ddc66d9b86f8d160\",\"/knowledge-medium/pr-preview/pr-1788/chunks/FacadeVFS-CPAim0hr.js\":\"a335e0081bbb8836\",\"/knowledge-medium/pr-preview/pr-1788/chunks/IDBBatchAtomicVFS-CZnr3dpv.js\":\"960d9ee0e810f84e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/MemoryVFS-DSARhLuK.js\":\"fee7b80a201c9c0b\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSCoopSyncVFS-BQBVzLS3.js\":\"a7e9811c46b0670b\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSWriteAheadVFS-C2cJi2OO.js\":\"c1d6d1d84ddb9f1b\",\"/knowledge-medium/pr-preview/pr-1788/chunks/Preview-CDKTlZMR.js\":\"984ca50567b8e1fd\",\"/knowledge-medium/pr-preview/pr-1788/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/card-ClrO9m-n.js\":\"818473e3543967b0\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-YGBYQnYv.js\":\"528dfd697b15ea77\",\"/knowledge-medium/pr-preview/pr-1788/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-EWeEnxiQ.js\":\"fb839221759d27ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-async-ClyGc1Gt.js\":\"fb2c0ba9129c2673\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-BcHKSdbf.js\":\"1e323004d6109ebf\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-Cmfc2D41.js\":\"b0d6b8f674bb6723\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-D8KZYrkt.js\":\"ec92fe98628905bf\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DBbJDHpS.js\":\"88ce3999b6dc856f\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-W37JOopy.js\":\"a7cf1891f5e64923\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server-legacy.browser.production-DRLE8mVd.js\":\"b3bc5eaa976d5c36\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.browser.production-0t56i5Ew.js\":\"ba6d2d2c817e33df\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.edge.production-CiEQSuKG.js\":\"5421ebf990465b5c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-jBn8hK0T.js\":\"c9ed60e1d5641a56\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-uShcsSlp.js\":\"44961d6363abdf9f\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-yPw2bpRW.js\":\"14225eff2119f9a5\",\"/knowledge-medium/pr-preview/pr-1788/chunks/server.browser-C4Z1Uv8d.js\":\"1d2d4956a16ef1b2\",\"/knowledge-medium/pr-preview/pr-1788/chunks/textarea-DA65zPF9.js\":\"4be1a2c9cbbe278c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/ui-Ba9IluDS.js\":\"8792bb0cfde58019\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-Cj1mtf1Z.js\":\"f22f4b8886f436e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-async-CKwLWy84.js\":\"b47819fb8f3df2c7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1788/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/src/App.js\":\"a2162183d729c9e0\",\"/knowledge-medium/pr-preview/pr-1788/src/appUpdate.js\":\"887a5053e2d41e47\",\"/knowledge-medium/pr-preview/pr-1788/src/appVersion.js\":\"c52756c0b0683c38\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/initialLayout.js\":\"c0f70d6fbf4ed06b\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/openWorkspaceData.js\":\"58a54491ee3f1615\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/resolveWorkspace.js\":\"c647ba9be42c8be9\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/workspaceBootstrap.js\":\"eac4b7b6406edf16\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockComponent.js\":\"114ea5eb95099577\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockCrumbs.js\":\"a30a0f6c5cd47e0e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockEditor.js\":\"b824d5cea6d9ada4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockLoadingPlaceholder.js\":\"cf0b631b0a4be93a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockProperties.js\":\"67c13ccab8745feb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockSearchPicker.js\":\"5289b6a0b6205e40\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ConfirmBulkDeleteDialog.js\":\"5387c776271ee9bb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DividerHandle.js\":\"47250fdcaa3bec69\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DraftEditor.js\":\"bf40a691f678f02f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/GutterPill.js\":\"5ca1cb47de528503\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Header.js\":\"b64fe3615e056f6f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/LazyBlockComponent.js\":\"fbf5e3c89d70f81e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Login.js\":\"5d4e22de629d2139\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ZoomableSurface.js\":\"c9509b422127419e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/editModeKeepalive.js\":\"f92c045be1689fbf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5cd11526a8440ceb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5f95e15cd37d291a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefPropertyEditor.js\":\"978f42cf7df7846d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefTargetTypePicker.js\":\"271e44fbae58d870\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/SelectPropertyEditor.js\":\"554371e96435896c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/TypesPropertyEditor.js\":\"8405b0b9afae75eb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/defaults.js\":\"e72d59d599f973a6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/kernelValuePresets.js\":\"825a6a1238558a08\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/selectablePresets.js\":\"d13255e27ed1bf93\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/typesPropertyUi.js\":\"463e99ff473c542f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/AddPropertyForm.js\":\"0bb5516cf5565f52\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyPicker.js\":\"221acede4d36a348\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyRow.js\":\"7e1a092dba8035a5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/Rows.js\":\"4a19e2702a33b720\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/actions.js\":\"e35d299b1d8f995a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/declarationOnly.js\":\"f3853c488b1a6e60\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/layout.js\":\"ef07dff968eb9673\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/model.js\":\"c8c22b73f05e27bc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapeUi.js\":\"0172659a811487e1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapes.js\":\"3a64f2aed512d577\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/usePropertyEditingActivation.js\":\"cebd96916bc3fecf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/visibility.js\":\"c39c0d652b893652\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanelSections.js\":\"314a948e18bece44\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockEmbed.js\":\"063ae4a0e4f1274e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockLink.js\":\"2575a33250aa0a28\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockRef.js\":\"2eb61e22287658f8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/ReferenceLink.js\":\"9e13ddf5c2c5219c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuard.js\":\"e7b1628393870ac3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuardContext.js\":\"073a55addaeb1159\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/linkInteraction.js\":\"d2d1ad15438dbb49\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/referenceLayout.js\":\"2e7fa2d56e0ce8c1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/useBlockRefAncestors.js\":\"bc34d91cad329f01\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockGutter.js\":\"4b57c7a5cb0c2856\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockInfoDialog.js\":\"bd3d0d7148a0da45\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockTypeBlockRenderer.js\":\"e5df5fb39d81e94a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BulletHoverCard.js\":\"0813b634e9655eb1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorContentRenderer.js\":\"954ac380765ad549\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9d2023aeb8a7d80e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ColumnResizeHandles.js\":\"ddbc35ccae892899\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"cb506b0b5dd384c6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/DefaultBlockRenderer.js\":\"fefc98be97fb5e33\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/LayoutRenderer.js\":\"fc079c10019dcee7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MarkdownContentRenderer.js\":\"0875c800c77dd4ba\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MissingDataRenderer.js\":\"04847af1abb7090d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PanelRenderer.js\":\"5bb80a977acd7326\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8d5073a24a3b567d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/TopLevelRenderer.js\":\"6b9d4cea6005ef48\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockGutterMode.js\":\"e3c8b8512d20cc28\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockTitleText.js\":\"5aea0e70cfb304f9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/fieldCreationKeydown.js\":\"117a32d70253d0b9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/layoutRootContext.js\":\"5646da262d6fcf2e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/TypeChip.js\":\"6073390f02091edd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/chipStyle.js\":\"d0a03d4675bfe04a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/anchored-floating.js\":\"38c2dafe085a22c2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/button.js\":\"c98cf32ac7131660\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/card.js\":\"7fa79aae66380024\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/checkbox.js\":\"fe0773cdd32e7d75\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/collapsible.js\":\"e2d41efd91d6ae47\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/command.js\":\"03f25b0d72b57bfe\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/context-menu.js\":\"a8c54da9bb4598de\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dialog.js\":\"056b7f438f1fbc85\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dropdown-menu.js\":\"ba026be7cf5be31e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/floating-listbox.js\":\"ae65e241713687a7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/index.js\":\"0cd7530d6f8c73f5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/input.js\":\"a8fe887037745e42\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/kbd.js\":\"77c14a67a2f3543a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/label.js\":\"b6cebf2cefcd0c2d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/textarea.js\":\"bfc3e38be62f5993\",\"/knowledge-medium/pr-preview/pr-1788/src/components/useEditModeYieldKeepalive.js\":\"7c38698e27ee263e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/BootFallback.js\":\"28760c0513f3c151\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/FocusedRowLazyMount.js\":\"5ac190554e234fff\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LazyViewportMount.js\":\"83a4878b7e285f90\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LocalDbCorruptionFallback.js\":\"0cbef1242ecfaa23\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/error.js\":\"fbf3a4079b53b0f2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/lazyMountRegistry.js\":\"0c876c5725be8041\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/suspense.js\":\"5293b30f0677d1d9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/CreateWorkspaceDialog.js\":\"1e36636ccbbf3df9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/PendingInvitations.js\":\"6e221d13beb2796e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/SyncProgress.js\":\"8e4bf46ad819ff63\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/UnlockProgress.js\":\"18d84d56b4cf39a4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceKeyGate.js\":\"54fa748a846f6767\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSettingsDialog.js\":\"f99c2e4d07a14555\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSwitcher.js\":\"8838f433d94511f3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSyncGate.js\":\"c4c3e2f2279fdb4c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlow.js\":\"9f9e4e80f1078f10\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlowHost.js\":\"30047bdcd0ac005c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/EncryptionSection.js\":\"8e86bd152e98b9e5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/attachmentPrompts.js\":\"49a777682d28b838\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/bundleFolderPrompts.js\":\"84bc54268627ade4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowDeps.js\":\"1e41f944b26fdd45\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowStore.js\":\"aa8f2f06f07ecb56\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/flowUi.js\":\"000959c5e5a21214\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/useConversionRun.js\":\"fabd250a79a4bd5a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/keyUi.js\":\"fc711a0b7119a6c7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnKeyLoss.js\":\"079645d3e4609ed2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnServerE2ee.js\":\"da2812edda5a172b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/workspaceUnlocked.js\":\"898f955866bed40a\",\"/knowledge-medium/pr-preview/pr-1788/src/context/backgroundSubtree.js\":\"571f4ddb5b28960d\",\"/knowledge-medium/pr-preview/pr-1788/src/context/block.js\":\"98a32ac42d589210\",\"/knowledge-medium/pr-preview/pr-1788/src/context/layoutWsContext.js\":\"e7a7b57b81b874b0\",\"/knowledge-medium/pr-preview/pr-1788/src/context/propertyDisplay.js\":\"1981bb0b4d115a0b\",\"/knowledge-medium/pr-preview/pr-1788/src/context/repo.js\":\"191b5c4e023dc05e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasClaim.js\":\"70a04260dc6a1c0e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasSeatNamespace.js\":\"c06f6508db49c439\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockData.js\":\"8c56b72038971573\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockType.js\":\"f563a612dbdc13b6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/changeScope.js\":\"35a365df4aa33fa2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/codecs.js\":\"eea51329af79d0a3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/derivedData.js\":\"b2ae0d648fb20109\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/errors.js\":\"99b9a8cee3fcfc82\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/events.js\":\"9d49fd95c37a1855\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/handle.js\":\"94983b2ffe449cd9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/index.js\":\"d3efbf883f04837e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/mutator.js\":\"4db5c5960ab112a5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/processor.js\":\"10a80df570cfff67\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/propertySchema.js\":\"eff15b406676b0e2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/query.js\":\"1b4d109d34043fe0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/sameTxProcessor.js\":\"86acd2643a6cddbf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/schema.js\":\"94983b2ffe449cd9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/tx.js\":\"94983b2ffe449cd9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/typedBlockQuery.js\":\"6326875718ab71d6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/user.js\":\"32f9293e47bfabf9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresetCore.js\":\"8224f95d378706c6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresets.js\":\"7e175f544b147f21\",\"/knowledge-medium/pr-preview/pr-1788/src/data/attachmentCleanerIOVerb.js\":\"1f0b5408e402a660\",\"/knowledge-medium/pr-preview/pr-1788/src/data/block.js\":\"277600a6a1d1ef71\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockCache.js\":\"5f1c22a04105ea79\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockId.js\":\"5f75accdeee51404\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockLiveness.js\":\"362e6dbb7df8cbab\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockMerge.js\":\"8d6a8efbd3cb8249\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockSchema.js\":\"d68f94ad4ea57e14\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockTypes.js\":\"da77648718c4d698\",\"/knowledge-medium/pr-preview/pr-1788/src/data/clientContext.js\":\"9cd6a4466c395f16\",\"/knowledge-medium/pr-preview/pr-1788/src/data/dbFileSiblings.js\":\"422cebe4bf347098\",\"/knowledge-medium/pr-preview/pr-1788/src/data/definitionSeeds.js\":\"f5964c09e5539f15\",\"/knowledge-medium/pr-preview/pr-1788/src/data/derivedIds.js\":\"7c6fa97cbc991936\",\"/knowledge-medium/pr-preview/pr-1788/src/data/drawnSubtree.js\":\"3ea9caf171fc3838\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facetBridge.js\":\"c44093d440e154a9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facets.js\":\"4c55a926c66875d1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/globalState.js\":\"d4a2fbec52ac4f29\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/aliasClaimRederiveProcessor.js\":\"273796df95697d6c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/ancestorBatch.js\":\"22fe2dee40743a15\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/blockTypeTypeifyProcessor.js\":\"d2ccde9cc70d6ef8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/clientSchema.js\":\"dda4c089a9dd928f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/commitPipeline.js\":\"4846383985d364f0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/devAssertions.js\":\"effc28da5266ecb3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/firstSync.js\":\"05580c03f063377e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/freshInitialLoad.js\":\"2574016613ef1f33\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/graphBackfillClaim.js\":\"6d3833419a4ebafe\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/handleStore.js\":\"0961c89efca54082\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/idleMarkerJobs.js\":\"5e1635394200c9e6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initialDownload.js\":\"d44c1cd70c992fb4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initializeClientDatabase.js\":\"8718f56358fa73a8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/jsonCanonical.js\":\"c78a964c0b3d629a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelInvalidation.js\":\"16fcaabd49dabf29\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelProcessors.js\":\"3661bb2f767dd456\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelQueries.js\":\"142ae8dfcc1af2a6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/mergeTypeMembershipProcessor.js\":\"6f7eb0841a64daaf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/normalizeReferencesProcessor.js\":\"28ccc92d19b8c1c9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/poolInstrumentation.js\":\"34a92383b64e112d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/processorRunner.js\":\"c8e871032750a758\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCellBackfill.js\":\"53a3207e2455aef5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildMint.js\":\"e1baf2f826b30f40\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildrenProcessor.js\":\"b4bfff32fbf1cacc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3cfb997d3808c1fe\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionSynthesis.js\":\"f2df76422a25a1db\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyKeyScan.js\":\"ff13981820b77058\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertySchemaResolution.js\":\"c545089f38acffa4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyValueEdits.js\":\"1062d6cd7fcdff9b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/raiseProtocol.js\":\"4f8e844b52167ecd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/readBatch.js\":\"41801f6e39765189\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/refProjection.js\":\"413a2b3b2605e24a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetLookups.js\":\"7dbc83bbf9a760e6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetProcessor.js\":\"b55aa27f8702cd00\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/replayMerge.js\":\"1c84f8b052a71c6d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/sqlBinds.js\":\"5e1b4421b8593737\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a0bdf60baa837d7b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/arrivalProcessors.js\":\"5fb1a655cdc24812\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/invalidate.js\":\"e2c7bc6a12f69c45\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/materialize.js\":\"06fa9c5ad828fd64\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/observer.js\":\"9a8c800209a353d2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/reconcile.js\":\"1d2f1a3c690cfc6f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/timingMetrics.js\":\"232e9fdc135b7911\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/treeQueries.js\":\"ccb558bc5a4128de\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txEngine.js\":\"7fb6e00986d12455\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txSnapshots.js\":\"5bb3c1c80c8e0c5c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/typedBlockQuery.js\":\"84be32fdb90c5205\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/undoManager.js\":\"a4448c1d20f14143\",\"/knowledge-medium/pr-preview/pr-1788/src/data/invalidation.js\":\"006f58b2006b424e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelDataExtension.js\":\"6307c6123f24a767\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelPage.js\":\"e6779c62f768ccd3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelValuePresetCores.js\":\"1c2602a9cda96432\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbCorruptionSignal.js\":\"dc21c340702a2fc2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbStorage.js\":\"bf6535690b4ac824\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbVfs.js\":\"5291bedc1d1b9881\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localSchema.js\":\"461307fa9fc1b32d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/maintenance.js\":\"2e36ee8ff09cc109\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mergeProperties.js\":\"9f2675262003aeda\",\"/knowledge-medium/pr-preview/pr-1788/src/data/metricsConsoleHook.js\":\"4eccc05906eed6e8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/migrationsPage.js\":\"15e625eada44ba52\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mutators.js\":\"a56947e4b95ad888\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKey.js\":\"3c19f3815d70b3d9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKeyPlacement.js\":\"c67edb29e4274769\",\"/knowledge-medium/pr-preview/pr-1788/src/data/outlineSurface.js\":\"a640e8ab7dcec5d6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingEditorContent.js\":\"56b0fad9e9d71d7e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingUploadsSql.js\":\"4ac2167cdd31e1ce\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pluginStateExtensions.js\":\"a89c07042f6a08e5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/powerSyncLogger.js\":\"4d46865c05e41be4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/projectorRuntime.js\":\"ffe49667e1b728e0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/properties.js\":\"be2eba33698ed167\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertiesPage.js\":\"e692b39c50897200\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyChildren.js\":\"19e36048f81b215b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionFanout.js\":\"7d30195767c82778\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionMetadata.js\":\"68e04f2d9fb3be25\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionRegistry.js\":\"0f8196bd38dfcab5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDisplayMode.js\":\"07ce6bf84b7673db\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyRowCreation.js\":\"83baf702887140d9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySchemaCreation.js\":\"d985e05f3acad1c8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySeeds.js\":\"bcda1011129c3097\",\"/knowledge-medium/pr-preview/pr-1788/src/data/recentsPage.js\":\"ba1a79980eb7416e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/referenceBlock.js\":\"cd2937f5393cb17a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/releasePowerSyncConnection.js\":\"4cbbce9a42db5627\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repo.js\":\"ca016e03a58e389c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repoProvider.js\":\"632353f279015cc8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/rowProperty.js\":\"83cdf27230489cb1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/searchFilter.js\":\"da88bdb08bf971bd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/seedIdentityLedger.js\":\"c3df64b292a29c10\",\"/knowledge-medium/pr-preview/pr-1788/src/data/stateBlocks.js\":\"f4d9a9b5ad0e7295\",\"/knowledge-medium/pr-preview/pr-1788/src/data/structuralEditPolicy.js\":\"b5262a000eba7502\",\"/knowledge-medium/pr-preview/pr-1788/src/data/subtreeDelete.js\":\"b7bd8c870ac46fbb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncStreamLock.js\":\"02652217159b15f8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableSqlRecognizer.js\":\"d99d6114b0b0a4aa\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableWriteGuard.js\":\"f0d77bcc05ec5fc4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/targets.js\":\"dcc7801dcec8afed\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeColors.js\":\"f4f9d4fa41b66626\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionMetadata.js\":\"871c5c640a9e9f59\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionRegistry.js\":\"13df60252f5eb374\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeExtraction.js\":\"beebc6acca45517d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeInitialValues.js\":\"35d62a505c9aa198\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typePropertyGroups.js\":\"dd4fa033901abf2b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeSeeds.js\":\"9c8eba42b67e5d87\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeTagger.js\":\"311f0e6ab1d5d1c5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typedRecords.js\":\"c9d83b9c6718844e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typesPage.js\":\"a5b13ba9f1356d3f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userPrefs.js\":\"9bc9b8f9906c982d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userSchemasService.js\":\"f734f2a3dbebb864\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userTypesService.js\":\"c756e737c6ded5d2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/valuePresetRegistry.js\":\"4a0f1d24e8b79400\",\"/knowledge-medium/pr-preview/pr-1788/src/data/visibleChildren.js\":\"0718467f0a238a60\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceConversion.js\":\"a8b8aedf2f4f5342\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceFirstSync.js\":\"8354a98e7caf9816\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceIdNamespace.js\":\"d7c2464283743954\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceSchema.js\":\"871218acd621fc0f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaces.js\":\"f568a634334d838e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadLog.js\":\"8ae14cf04fee9ea1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/BlockPasteShellDecorator.js\":\"34587317e8c0b2d2\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/atTrigger.js\":\"236b2cfcb7dbe034\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/autocomplete.js\":\"c920d7994a5f6fa3\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/codeMirrorExtensions.js\":\"65d5d2591cbb6dcb\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/contentFlush.js\":\"4a7e20a730aa9bf7\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/defaultInteractions.js\":\"e75ae0585a7718d3\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/editSettleSignal.js\":\"82cf2d55c32e24b0\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/insertImage.js\":\"c04ccb4bf72a16fc\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceCompletionRange.js\":\"231396596e5f6bc2\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceTargetTypes.js\":\"4586f47a90f377c5\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/syntaxContext.js\":\"e6b3a427ab8fcf31\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/triggerMatch.js\":\"ca9a8883d27d21c5\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/AppRuntimeProvider.js\":\"688b02d26a65d037\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/BlockFocusShellDecorator.js\":\"e310334ebbc21de1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/ExtensionRenderBoundary.js\":\"bf9d77ff92d90d45\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/PanelContentRecovery.js\":\"9767fd16a20dbd87\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/apiCatalog.js\":\"559d77f624fcbdd7\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/approveExtensionHere.js\":\"a72933415439169f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/armedCutAppMount.js\":\"f65e4d29b5d8c5a0\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/batchableKeyedStore.js\":\"3ce17bd2c9340998\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockInteraction.js\":\"82a355ee09308306\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockSelectionAction.js\":\"a344f3fd617c61b1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compileExtensionModule.js\":\"1881b6f7b1e28fab\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compiledModuleCache.js\":\"6e112186ba73794e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/continuousGestures.js\":\"81ec58ad08db6385\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/core.js\":\"e6dea7520b8f3583\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/defaultRenderers.js\":\"b25de42685c65954\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/definitionFanoutAppMount.js\":\"09c18372d381cd24\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dialogAppMount.js\":\"747d007fc72e3b91\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensionSeeds.js\":\"5771d2aa688c1103\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensions.js\":\"913600aedd2f06ee\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/exampleExtensions.js\":\"a2d27e5b4a30a072\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionApprovalStatus.js\":\"4edb8a3f977d7ad1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrorToast.js\":\"260ff3603733f0a2\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrors.js\":\"89b7a26e7332c3e9\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLookup.js\":\"301ee2f4a12afa0a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionToggles.js\":\"dbaa1400cf3d82e7\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionUtilitiesCss.js\":\"13e9baa2c31d7a16\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/kernelPageDeletionGuard.js\":\"6f90c82b1270029c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/liveRuntime.js\":\"ed7bbdafeccc6658\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/openExtensionsSettings.js\":\"3c1bb0d78981e795\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/overridesCache.js\":\"2db5ebaddda79831\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/pluginIds.js\":\"5db15fa22e948628\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/processorRejectionToast.js\":\"3e5ec8c56621c85a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeActions.js\":\"a74b46fa78473879\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeContext.js\":\"a7586779ce60db94\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticAppExtensions.js\":\"ed3445128e1bad3f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticDataExtensions.js\":\"2839b2dc4b228f76\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/toastAppMount.js\":\"d5ca2b5bfdd049dd\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useOverrides.js\":\"1315baa0a367e360\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useShortcutSurfaceActivations.js\":\"6dc4b2f696a28c33\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/discoverToggleTree.js\":\"2f6ea8bd02488e8b\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/facet.js\":\"0053643d5337e5f2\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/resolveAppRuntime.js\":\"c58380a86e916c7f\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/runtimeEvents.js\":\"d826e7eff473b464\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/togglable.js\":\"7f165558c7509cbf\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/variantFacet.js\":\"2f59a6f32a516ca8\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/verbFacet.js\":\"762b814bcb82f367\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/block.js\":\"3f17241de54b5b04\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/focusedChild.js\":\"66cb94fd1c56762d\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/propertySchemas.js\":\"0d96cdafdc2dad09\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/typeRegistry.js\":\"810cf1b509cfd236\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAncestorCrumbs.js\":\"98ceb2c638b780c0\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAutocompleteListbox.js\":\"5520885bad114de5\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedSearch.js\":\"27f3a2ab51423624\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedValue.js\":\"d898ecd3ae3f3393\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsFocalRender.js\":\"066b59bffdd7451c\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsReadOnly.js\":\"65d740de1a1f5dca\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMaterializeBacklog.js\":\"49a85daa04eaaa07\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMinuteClock.js\":\"40546a85ad216049\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePanelLayoutProjection.js\":\"f15c542e4a963039\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePendingInvitations.js\":\"4a8c22af32cfd9d1\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRendererRegistry.js\":\"3bba873bca02ea41\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRetainedFieldRows.js\":\"f9b0eddad7554b16\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useWorkspaces.js\":\"b1682fd1414f807e\",\"/knowledge-medium/pr-preview/pr-1788/src/lib/utils.js\":\"21a841e03fe98ac4\",\"/knowledge-medium/pr-preview/pr-1788/src/main.js\":\"89a901d96a6cd752\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/MarkdownImage.js\":\"5b01cd9ffa2a3db2\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/blockSeparators.js\":\"42798e0eb32cb706\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/context.js\":\"a0cd390c9f5175a8\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/defaultMarkdownExtension.js\":\"7d6502cd1ee9664d\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/extensions.js\":\"84559bc95df32be2\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/renderMarkdownHtml.js\":\"52644f8d6259bbc4\",\"/knowledge-medium/pr-preview/pr-1788/src/minimal-editor.js\":\"4fc0b00d4bdbc180\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/armedCut.js\":\"de1251a7a9b1a42d\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/captureMediaVerb.js\":\"aa390462f9725505\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/clipboard.js\":\"f9af3b213cfa93bf\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/decision.js\":\"955a20be654ecc4c\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/operations.js\":\"571a49628e6b5ff5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/AccountHeaderItem.js\":\"2dc8e3210b264e0c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/index.js\":\"67345fab8ef7484a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d5768b9d25fd022a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askAgent.js\":\"b42803e746a8aa83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askedStore.js\":\"947c9698fd745d7f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cc2be7ba2b065ac2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/chipState.js\":\"546c4aa25348db69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ca7851b89babffd4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/index.js\":\"df3159dd2e34dc33\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"022a8778e91a19e7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/schema.js\":\"92b476de70d819bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1177f98f370b22ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/BridgePairingDialog.js\":\"26a1d586b859f6ac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/addMedia.js\":\"f2288381bd07ffc2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/backlinks.js\":\"22dd82dc43db513b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/block.js\":\"cd436cd64ada9b80\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/context.js\":\"ba1a947100c8a810\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d97ead4f73bf6375\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/index.js\":\"392919eb62e9510c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/outline.js\":\"35d87e5c161bd22c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/properties.js\":\"6ac46a372c5a4aa8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/refs.js\":\"6ffed049b9a9366d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a1d93af85101f981\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/search.js\":\"99607c788a23b3a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/shared.js\":\"4038efe6b2998e84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d79c756499e68aae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/text.js\":\"69873fe1e62a8d91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentWrites.js\":\"6be63c12d511d2be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/authoringCatalog.js\":\"73ac815bce642a25\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/blockRefTargets.js\":\"af27be9417c5c2a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridge.js\":\"5798ced996f3c215\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridgeLoop.js\":\"7509ab71a06a639d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/changeHistory.js\":\"2bbeec329c0e9ba5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commands.js\":\"363e1b74fb3ce556\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commentsCommands.js\":\"d609a9a7f9669bc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataExtension.js\":\"3f407953cd9bd9bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataModelGuide.js\":\"4c607d530e9b60ff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/describeRuntime.js\":\"a45c7e64ea4278b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/extensionLint.js\":\"8033dbe0e2c56425\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/grainAudit.js\":\"7eed7c593d868b10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/healthCommand.js\":\"8d4e536b3ff70552\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/index.js\":\"c836500fa35f30ac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/presetIdentity.js\":\"31fc5b83e62b68bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"15daeb632404a2a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/readMedia.js\":\"f2276bb263afd2ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/schema.js\":\"f6b02e66dd868255\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/serialization.js\":\"c92054f523de700a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/targets.js\":\"b4149074eece79d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/tokens.js\":\"174bb13e89bc7a0c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/watchEvents.js\":\"1ac824fa2a297521\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/workspaceGuard.js\":\"15b4dd515504ce96\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/writeCommands.js\":\"360a5af1b1372013\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/AliasCollisionToast.js\":\"318b5b6b5cd97f28\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/DuplicateNameBanner.js\":\"a6427933245be8cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/collisionMerge.js\":\"b2c8f8a1fea10daa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/dataExtension.js\":\"350bf93a520be609\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/index.js\":\"3308c8610037fb6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/mergeCollisionAction.js\":\"4f83e08abe5fe8be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/pageStyling.js\":\"10b602f53445e60c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/rejectionToast.js\":\"4f8c13c2b1e5ff7d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/syncProcessor.js\":\"0b8e061708aae8a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/actions.js\":\"78d442b70d285505\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/addComment.js\":\"1391670814a4002a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchor.js\":\"8a64ff4671581e26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchorState.js\":\"6fcb0cb4131cb390\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/commentLinks.js\":\"344bae6572b87a35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/confirmThreadDeletion.js\":\"c330747dc8f0cd93\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/container.js\":\"95a54740c639a761\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/dataExtension.js\":\"7e04223815e0dde2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/deleteComment.js\":\"3c6cc94925f3b489\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/highlights.js\":\"d7ea511cd2fa7d47\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/index.js\":\"e30b4f0100b3eaf7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/linkedCommentsPill.js\":\"62c51f23c043a089\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/margin.js\":\"9c07ebe19d319fa8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/marginSchema.js\":\"d9f8f038ff7721d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/newComment.js\":\"1d1336426005e97d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ownThreadPicker.js\":\"6390dfbd0456d125\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/placement.js\":\"7f5e9c40de61170e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/queries.js\":\"644206be65d547e4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotePosition.js\":\"f17f3444d770d468\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedIn.js\":\"346982716973f3c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedRange.js\":\"236d6fd2a5e4c9c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/rangeRefs.js\":\"fa204c66626c667b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readHighlights.js\":\"fccaa99bd9d44244\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelection.js\":\"4ecca985478206be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelectionUi.js\":\"0c447d4d12003486\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/reanchor.js\":\"c3f849383b2dea4e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/schema.js\":\"3572b001a272c050\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scope.js\":\"c409309c50233488\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scopeThreads.js\":\"2b62bcaf16526638\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/splitRetarget.js\":\"9634e9cb2c487c75\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestionCard.js\":\"abda20a40e49a5ce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestions.js\":\"10998ac37700087d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaries.js\":\"fa268cf6d0c49986\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaryBatch.js\":\"0f3f78c924cd4541\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/surface.js\":\"d17d34b565282014\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threadNavigation.js\":\"6c991bc9b2d41eac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threads.js\":\"0833c698ba1c3516\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ui.js\":\"b63d843e50c18efe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/uiStore.js\":\"e1630556dc3606cc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/appIntents.js\":\"e57cde7fb509b842\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/index.js\":\"4ca1d5f7337ae0d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/index.js\":\"736e576dcb9cacc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/status.js\":\"db7eee3b089bf31a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8e9d5e06f799ea31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaBlockRenderer.js\":\"1b12754fa7ab2f6a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaDownLaneReplicator.js\":\"30a94d4592123885\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaUploadReconciler.js\":\"ca4a9cda37df3bb9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetDownLane.js\":\"02db2a174f976750\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetResolver.js\":\"1746866f0d2f5af1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetUpload.js\":\"c4d2379fd28a453a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/attachmentCleanerIO.js\":\"bd65c6ab902e41ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cb87513a0dd47843\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/blobStore.js\":\"1ebd0d48ce8b3786\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/byteStore.js\":\"7e0251b267679633\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanerIO.js\":\"66964736e2b001b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanupAttachments.js\":\"63cba5bec3515e6e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/dataExtension.js\":\"7a3b5da59dcb9715\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/downLane.js\":\"28bf344c1cd0977e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/index.js\":\"0a67f67f7a1ccdc6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/insertImageContribution.js\":\"36077aa8646a5c7d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneArming.js\":\"ea788aa093f3aa3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneLock.js\":\"7919c10e0804ff2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaBlock.js\":\"40573222062155d7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaCapture.js\":\"6c3e57a380911701\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewers.js\":\"8ff0e16482d4ac3b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewersFacet.js\":\"c996e4167ec0f115\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/pasteCapture.js\":\"8bb52495a9bd9b31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/resolver.js\":\"42ee5e11c96b830c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/retryUploadsAction.js\":\"12506ac41047d2f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/storagePaths.js\":\"0f8b06ce547a1cfc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadDrain.js\":\"e603655f9391d80c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadLaneStatus.js\":\"f5dbd865ad738a96\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadReconcile.js\":\"c19cc34a4e92d9c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadRecovery.js\":\"3c0e3481f4a017e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadStore.js\":\"a51e1687f0750e19\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/useAssetObjectUrl.js\":\"2911d8e2474e51fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"be134d442e21f879\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksViewSection.js\":\"212213a1165c96ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/facet.js\":\"ccc18113294477a4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/index.js\":\"a1a8ca64f99259f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/prop.js\":\"1d5ea0c7d23ed72e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinkFilters.js\":\"0f8580b3fc56f3aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1c27e3af566d897b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BlockEntry.js\":\"99939a37289adea3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/LinkedReferences.js\":\"e7612e9e87f61db2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"57e1597cf12a5833\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dailyNoteDefaults.js\":\"4e8eae48e4d2c614\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dataExtension.js\":\"3f82d6775d8ae934\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/edgeExclusions.js\":\"56b79d2b0254574a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/filterProperty.js\":\"2405f096d4c084f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/index.js\":\"3be3ee42763042a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7b3cb65bbe783c5a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/applies.js\":\"258eabc7d65f755e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/countQuery.js\":\"93647cc6b1d052a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/expansionStore.js\":\"93b8c80f71d0ce0a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/index.js\":\"65492da630a18b33\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7f0587bca2d6072b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/presentationInvalidation.js\":\"c3eb497ee19e4bef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyEditorOverride.js\":\"1ac188f0c8e85a5c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyFilter.js\":\"e3d967bd277ae119\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/query.js\":\"8906f9e20a529dd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/resolveFilter.js\":\"54a961bcc04617fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sourceBatch.js\":\"02683bd3c4b5c815\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sources.js\":\"35773fd9edd93e97\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useBacklinks.js\":\"762be413b462d547\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4cb5c17cc2c3f35f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayCelebration.js\":\"595e7d4a244663ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayOverlay.js\":\"7c0e8debb7e0d010\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/gate.js\":\"a62d387631368ba8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/index.js\":\"2cc72fea4476a3da\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/wolfTheme.js\":\"0e2083afaf5c153d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/BlockDragLayer.js\":\"0efce63e268b0b38\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dragController.js\":\"733fd41d8f16530b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dropTarget.js\":\"d28280c30281c8f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/index.js\":\"bbf36cabe185244f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/projection.js\":\"b2002349e21af936\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/BlockMetaCard.js\":\"d216fa7229fade35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/index.js\":\"80db37681fbea946\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/AddTagDialog.js\":\"88befc5b4b6fc6a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"aa5b8d46aae90cf7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/TagNameIssueHint.js\":\"ad48f87d3365939d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/addTagAction.js\":\"bfb408a29d755a7a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/appendTag.js\":\"76a03911f0308116\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/config.js\":\"c43da7892a0e282c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/dataExtension.js\":\"64f28a470ac26316\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/index.js\":\"b4a1862d25b875a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/propertyEditorOverride.js\":\"d69b7ab0ce3ea08c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c326b42a25ea4d7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6d03888f5b297d23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/Breadcrumbs.js\":\"88356b122624888e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"cd005a04e8010919\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"163291435b237367\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/index.js\":\"43a9a34ef03d0d4b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7558be2ac109790a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/CharacterCountItem.js\":\"51b9b7917bd06fdd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/ProfilePropertyEditor.js\":\"65f606000fe459e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/actions.js\":\"c41c9cf576ca086a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/blockType.js\":\"81cf0a9145e7a221\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/charCount.js\":\"e7eaab4985ba7460\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/dataExtension.js\":\"188d1cc88ba9593e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/index.js\":\"bda84012c0825025\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/profiles.js\":\"bed4180d98ff1292\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/properties.js\":\"14df4cc712a5d344\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/textCounts.js\":\"1a9ac70f34859dac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/colemak-keybindings/index.js\":\"9211019a17452e64\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/CommandPalette.js\":\"808145d45cc3d6da\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/HeaderItem.js\":\"813c24c5b57df09b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/context.js\":\"8f045c8dddd7d224\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/index.js\":\"19725666883335f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/selection.js\":\"d76f6e1c5e285975\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/toggleStore.js\":\"89b7a34d87db881e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/useCommandPaletteActions.js\":\"6e1f565164f55424\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/ContributorBadges.js\":\"3cb707425a0aac08\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/author.js\":\"43211654c9ae2421\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/codeMirrorExtensions.js\":\"561424d9a022323b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/dataExtension.js\":\"95ccc00445c4ad08\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/index.js\":\"1790f75b00a27dae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/mentionAutocomplete.js\":\"26e1584f06b2416b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/processor.js\":\"1858d298a96f0bae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/profiles.js\":\"afb8580ac5d4789b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/queries.js\":\"aa5bdf9a3536c151\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/schema.js\":\"526ffa0e5143298d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7509f3b65de47171\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f526f9ccac9da4c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/index.js\":\"32f94552fa03817a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d15ad421b2006056\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"79e8ed9c3d9bd436\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/CalendarGrid.js\":\"74b59225cfe21a38\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DailyNotePicker.js\":\"85227a5e728bb86b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"518fbe0f8511dfdf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateNavDecorator.js\":\"c48ca5f3bef196b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateScrubOverlay.js\":\"ead3744daf5ec2a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/HeaderItem.js\":\"030ff3e72ba30fac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/ReschedulePicker.js\":\"9c9e037677b7b91d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0ee77ce54dccc943\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/actions.js\":\"a5416cb72f63ff7a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/blockDateAdapter.js\":\"0059169d59e4c168\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/calendar.js\":\"8a5d9d55ff4c853a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dailyNotes.js\":\"1c187afa561922ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dataExtension.js\":\"65d310fe348722c3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubActions.js\":\"02ca3e42d7a7253f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGesture.js\":\"cadf6c663b1eca47\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGestureActions.js\":\"16d76f92aea9baff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ce60ca2f64b2c152\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/deletionGuard.js\":\"f597742affeff6fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dueQuery.js\":\"0741284db16448a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/index.js\":\"6526faa98316fa60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/landing.js\":\"ac05d0b64a051aca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/localSchema.js\":\"7c1e73056eb2de10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/referenceDateAdapter.js\":\"b932b3fa1a4661c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/rescheduleAction.js\":\"c4525ded665f1c12\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/schema.js\":\"aba689f16544c32e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadBlockDates.js\":\"70e0cee775b98601\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadDatesAction.js\":\"554d94a15365a18c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/today.js\":\"d78def7f70b2867a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2cc63fdca143538b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"180df12d50937cc6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/audit.js\":\"405bd6def95b19ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditAction.js\":\"d1140d889b56447e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditRanges.js\":\"e38994746dca0901\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/diagnosticsSource.js\":\"14c9955d517d8cd6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/divergenceScan.js\":\"622f53f1419037f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/index.js\":\"685dd6b1e0c34a5a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0925eacf19de0f86\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/referencesMirror.js\":\"40b46e226290c9e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/rowJson.js\":\"2b9725bfbf402933\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/schedule.js\":\"197529b8750617be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/store.js\":\"4a766f4bfb5874ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/action.js\":\"9052bed76b92969d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/index.js\":\"02038a2d26751622\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/plugin.js\":\"68488494f695c3be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4fa3bf670822379d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/actions.js\":\"7e2092aedf616026\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/changeMarker.js\":\"5f72961d0017c1d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/diagnostics.js\":\"d9c74dddef9ed3a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/fileSystemAccess.js\":\"9afd33bd1c4fda6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/filenames.js\":\"433efd4c7f5b5d8a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/index.js\":\"954adfe2d405e6d3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/mirror.js\":\"3ebaaecd4e0ec822\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runLock.js\":\"08f857da6b22bb27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runtimeHealth.js\":\"ab469ae181323c5a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/schedule.js\":\"338bf6dc87f8fd0f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/store.js\":\"ad0f226b8a4434fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/index.js\":\"902086edaef4a955\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/themes.js\":\"594b1a66f4bd959e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/facet.js\":\"7e3960a1f448b82d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/useDiagnostics.js\":\"ce02f95d31ff91cf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/dismissals.js\":\"8402592f95128b92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/index.js\":\"bce397c2383f658e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/status.js\":\"6f73f5be18266871\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/store.js\":\"caea0f65ab2ca207\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"66ab551f84616cdc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsSettings.js\":\"67bf38c1bc7e2297\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/actions.js\":\"b9013b9f1fd49eab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/config.js\":\"d3469458b0654091\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/dataExtension.js\":\"7f5b5b08d6e2e675\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/effect.js\":\"5be80f74c982416d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/index.js\":\"b2cbd03b856cb8b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/propertyEditorOverride.js\":\"765823eb47a1143d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/useToggleTree.js\":\"3df7605131ae00cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/ExtractTypeDialog.js\":\"71799972c021af49\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"75468101a360a3de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/PropertyShapePicker.js\":\"f9719e3900f41566\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/action.js\":\"b8104d9b7bee62ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/index.js\":\"2752f8c1f018d780\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/FindReplaceDialog.js\":\"284012704a0531be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/HeaderItem.js\":\"5c481b681efadfa7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/dataExtension.js\":\"cc95130c0c041921\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/index.js\":\"4cf4e8e22eafaa72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/search.js\":\"e484f789ff8b7a6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/toggleStore.js\":\"29501c490229ca6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/LocationPropertyEditor.js\":\"3421d574fd5430b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/MapView.js\":\"c6cf4315890860c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/blockTypes.js\":\"aa5c0aa37cc64555\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/codeMirrorExtensions.js\":\"3b7cdd02b7a7a909\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/createOrFindPlace.js\":\"4c5bad20d232dbe2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/currentLocation.js\":\"b5c0a8714ed57a09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/dataExtension.js\":\"24a683172f08cc9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/geoContentDecorator.js\":\"51c0e2eac1eed600\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/googlePlacesClient.js\":\"4a4a0364158a82aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/index.js\":\"aa10ffc878689cdd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/locationsPage.js\":\"bb58c3f28fb302c3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/mapViewport.js\":\"72851431ffaec771\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/pickCurrentLocation.js\":\"e6b0865074091a85\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeAutocomplete.js\":\"fb9157bd9df5bc6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeNameCollision.js\":\"c7fa24339df4d04a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/properties.js\":\"7caad3112b160503\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/propertyEditorOverrides.js\":\"5af57c45e2e65f66\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/query.js\":\"741b67b9f0c8d65b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/usePlaceSearch.js\":\"ba8b4694b7c99909\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"32622994f8d95be4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"43a17048bd7c76db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3509f1ab4ace77af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/config.js\":\"45c23da09c7b322e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/dataExtension.js\":\"2b58eb40fe8c6993\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/facet.js\":\"4f7cc03df75b7a6a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/grouping.js\":\"239f5434a92c198c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/index.js\":\"02528edbbdde2e02\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6e43fd9611a04d3f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/query.js\":\"24b3ed256f5cc6e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/resolveConfig.js\":\"a65d0500492269d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"71bd48a9f32d3cd5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c54f38e449918d5a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlDocumentContent.js\":\"6ef9317bbaed678d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlFrame.js\":\"5d8cfd539c558933\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/actions.js\":\"a2fee3be1828e9bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/blockType.js\":\"958b4415c9ed8c59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/confirmRunScripts.js\":\"a590f21b0e1f6167\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/dataExtension.js\":\"878eda054a5a5e9c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameAnnotations.js\":\"6ee5c7492c500e14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameDocument.js\":\"a8cd7dba939d7eb6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameTheme.js\":\"48444d9fd0681542\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/index.js\":\"5760d370dde77fab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/scriptConsent.js\":\"17380dd1db782cef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/sourceMap.js\":\"6c92d370eb762f00\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/useDocumentScripts.js\":\"a8fdea5b2061a33e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/index.js\":\"172d80313634d579\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/record.js\":\"905b319d497dc7be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/recordStore.js\":\"74b31e2119d69b52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/responsiveness.js\":\"51d5a972872c0c02\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/schedule.js\":\"fcb8f540d422965f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/sessionContext.js\":\"b9d7df8b5cdd260c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b002deab49e70acd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f9e4d786be99ca24\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/actions.js\":\"43804a7cce174d6a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/config.js\":\"bff1bb10f3e655b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/dataExtension.js\":\"97f81c73c62a3ea8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/effect.js\":\"706a6cf5411d3678\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/index.js\":\"68c225137fecbff0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/keyCapture.js\":\"8d30727a1b184aeb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/overrideStore.js\":\"c25d3e8c8b6e47b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"318aab7085ad1037\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/HeaderItem.js\":\"53e0f897e4d259fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/LeftSidebar.js\":\"bcc45e45bcd758ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/actions.js\":\"1644ae78004d3289\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/facet.js\":\"c1a394bf5d73c654\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/index.js\":\"7cd20f10d5bdd246\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/shortcuts.js\":\"665f297f47ccebd3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/toggleStore.js\":\"dc3d59adfd2e760c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/MergePicker.js\":\"3685ba98e48a642c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/index.js\":\"d3c797f0e6ccb72d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/mergeAction.js\":\"78741036d8f563cf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/strategy.js\":\"7149d9f8f25d4413\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/Button.js\":\"4a67afe99c4c71b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"857ac1dc40733249\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0221ae229df7216d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/facet.js\":\"649142e04ccb1928\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/index.js\":\"c837e0e25d929395\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"11cf6ecaa1301d50\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c8993e6e736ae3e4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a49d451e25986741\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7d0816c5aca6d66a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/index.js\":\"7887f1080a3f9afb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9f253ef9fb2dfdb9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/blockSubtreeMembership.js\":\"521a8b320da9f0e5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/contextMenuItem.js\":\"e5fb405df1f80899\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/index.js\":\"066a43a79eeb05b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveAction.js\":\"d8c11a9c997a8cc6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveBlocks.js\":\"01c665cf9ef9397d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/selectionAfterMove.js\":\"87fdc073999d43aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/TutorialBanner.js\":\"9a6fe8b69cd72c90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/action.js\":\"50ccfe962c109ada\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/bannerDismissal.js\":\"5b0f0ba9e21285cc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/documents/cheatSheet.js\":\"2da2ca175acedd9d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/index.js\":\"21b28884985af6a6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/keys.js\":\"09dce6dbd7701100\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/landing.js\":\"407db2510628cf6a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/outline.js\":\"3e2d6373c937aca1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/seed.js\":\"4cac0b8f2db7abc5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/PerfTrendDialog.js\":\"31cc12ed03f11098\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/analyze.js\":\"9ff649f788346451\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/diagnosticsSource.js\":\"5261ac37e183a97f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/index.js\":\"4308867eac2ed20c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/load.js\":\"403b0fbf2e2a6a60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/monitorRun.js\":\"2ec9c84a5f4be5eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/schedule.js\":\"43dc73ccb13e3b45\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/series.js\":\"cb272ab9d723184e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/store.js\":\"1b599c3f0c18973d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/trendAction.js\":\"3bafdc61ad59cee1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/verdict.js\":\"f1c436571bfbdb91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/clickToEditAction.js\":\"bcfa074b133ed6ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/index.js\":\"f54b737e466f7aec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/interactions.js\":\"3b16f0fefa2330e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b49f61aba4c7d497\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGate.js\":\"0d85ea8e7b73d66e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGateDialog.js\":\"98cd13e45a826ca5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/action.js\":\"5da03b7a902c69f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/index.js\":\"d5c23fe69421c7a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/localRunMessage.js\":\"9f68e984bcb469ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/plugin.js\":\"87288cf0e08c47dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/progressReport.js\":\"d541f1ed9e0cd697\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/sweepProgress.js\":\"7b1dea3c32c1cc9a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/FieldRowRenderer.js\":\"93425515a8d690a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/ValueRowRenderer.js\":\"3cbcc31ddb677e3f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/actions.js\":\"2863c132c0c30fb9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/autocomplete.js\":\"f45cacffbc1c732a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/fieldRow.js\":\"f4489d57d27b50df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/index.js\":\"541b5e7a76982398\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/referenceWarning.js\":\"e6080541ca3c83af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueAutocomplete.js\":\"27ef68aab44509b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueSchema.js\":\"b385495902e4c7ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/HeaderItem.js\":\"036cd3fb186c0dc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/QuickFind.js\":\"ae7934008a8c8f1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/index.js\":\"979c1096df8781b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/recents.js\":\"6a0550a07d322f53\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/resultItems.js\":\"74d8fc9ff1a1290c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/selection.js\":\"d8b655f38378f491\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/toggleStore.js\":\"136f3a7449561736\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/HeaderItem.js\":\"8f9944243e55b8b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4b53ede871cd4e7d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/grouping.js\":\"02612336ebc7a13e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/index.js\":\"f0abe636b6fc44ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/target.js\":\"19e63ef80b47335f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/codeMirrorExtensions.js\":\"bcc910393de2a334\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/contentPrefill.js\":\"0588a15b13a79458\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/dataExtension.js\":\"f104024013b29210\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/index.js\":\"144f225307342cd2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2d430b0802d7cdb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/invalidation.js\":\"03527ed38dd28b33\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/localSchema.js\":\"4642ca0f24266a8f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/index.js\":\"4566497e808a116a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ea4e4ca37bd2523c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/index.js\":\"0b748b727961b0d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/referenceNode.js\":\"688ca36205a37a36\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ac824110c1bc57b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7819a1229de4ca74\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/index.js\":\"8f12015c3c47b672\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c31b822ca44de790\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6f337eb3dc3be867\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/mergeRetargetProcessor.js\":\"56a463b0eb2976e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/parseFence.js\":\"81fb63f6d53eb323\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceParser.js\":\"0a4b3f07eaf5aab4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceProjection.js\":\"705fc3106f185424\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referencesProcessor.js\":\"0187dc54368c6b05\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/renameProcessor.js\":\"990e1fa68f8962ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/spanReplacement.js\":\"d041a196aa411215\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/htmlToOutline.js\":\"07dd2abb758f8c70\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/index.js\":\"4cc587c3067b1ab4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/normalizeClipboardDom.js\":\"90c67e1de404e0d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/pasteDecision.js\":\"7ee5a54c8a78cc6d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/action.js\":\"4c4eed9a5c1a7b78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/blockIds.js\":\"fa0a512e07f6ee7e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/content.js\":\"8f0844e630863bc2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/effect.js\":\"67a8ed8ae6fe453a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/ids.js\":\"c5f1f08c23bf2c5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/import.js\":\"bb40c7f680ca23d7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/index.js\":\"208d264dee7fb1f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plan.js\":\"e3d16b9d48ac035c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plugin.js\":\"c7e5c1d7dc20841e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/promotion.js\":\"f0591eed5329d9e7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/properties.js\":\"cf0a340c08fd814c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/references.js\":\"040e8065b84be0e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/report.js\":\"d852ffa753333552\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/roamMemo.js\":\"36610b7bb8be03f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/runtime.js\":\"6e39075176ecd8d3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/schemaReconciliation.js\":\"593a2c35c880cff7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/srsMarkers.js\":\"0fe4bb34ea8a14de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/todo.js\":\"603f78610820f534\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/typeCandidates.js\":\"72491b99c94a193d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/types.js\":\"23e90468190133cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/index.js\":\"b136a633b59e7eb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/store.js\":\"ee6d73003807ea27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/HeaderItem.js\":\"832325564d8cf428\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a6e206c62905b1ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/index.js\":\"13ac1b9ae62be6b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/model.js\":\"254a2beb52bbc15c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/toggleStore.js\":\"db316e9eb52b0013\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/useKeyInspector.js\":\"8c2de9e2be988b45\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"85da3def355d1e45\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/ShellDecorator.js\":\"2be9aeb3f6182151\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/actions.js\":\"128852faf765136f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/exclusionsFacet.js\":\"000f5269144d7dd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/index.js\":\"8d981ab5f65e372d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/shell.js\":\"cf5708c84dc69834\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/surface.js\":\"a0403f734d71f5ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/walker.js\":\"67de52d7810b8f9c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/RescheduleToast.js\":\"23f40ace0451e326\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/dataExtension.js\":\"82e2a917fe62944f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/index.js\":\"e27ffa5985a17837\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/indicator.js\":\"929814840791d4e4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/moveSrsState.js\":\"f9b7117b6befe0af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0466076dade4ea9c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/scheduler.js\":\"e86774c61c44a708\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/schema.js\":\"16e2d53a07ae45a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"fb506fe2c8db9d01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsClipboard.js\":\"7a4ecb088843fd01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"009a9f96e1a10e8d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DailyNoteReviewHint.js\":\"49370cf20b16a3db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DeckPicker.js\":\"146873499efc835d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewControls.js\":\"539cefa20dbf0afa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6b4247852e923346\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewSession.js\":\"b20186a2e2c9aab1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/actions.js\":\"2e5a433ca6f8dfcd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/archive.js\":\"d30d23a95bea5fd5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dataExtension.js\":\"dd6a7dad9fd8b128\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/deck.js\":\"048309d80910c2d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dueQuery.js\":\"ed2f4fbbeef01b76\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/gradeDecision.js\":\"cb770a827a8b93ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/index.js\":\"59b6cba9f90d5176\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/keyHints.js\":\"63dab6b4379f401f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewCardLayout.js\":\"24ee5450d3a9d950\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewProgress.js\":\"72cebc224f10f14c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/schema.js\":\"db858d6d0fc5f2b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/useDueCards.js\":\"53d43dbe68ec6fdb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/index.js\":\"d0f4b4106f6e8053\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/record.js\":\"fbac06edbd25808a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/index.js\":\"b7b9f9fd41f77899\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/persistenceStatus.js\":\"e1dd776ef67bb81d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/requestAction.js\":\"8c5661e5a474fb6d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/TypeChipsDecorator.js\":\"77f0062e2327363a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/codeMirrorExtensions.js\":\"84f6cd70bf0f3a57\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/index.js\":\"64d67be2ce5422bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/typeAutocomplete.js\":\"37c472b10949844b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"911efc58a25a4fa8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/actions.js\":\"e0b0f11679071fe8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/anchor.js\":\"a73cd3aa54cd644e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/events.js\":\"3984366c6e837512\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/gestureActions.js\":\"c16084cd83216a95\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/index.js\":\"20b939ae16a1062e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"ee2355b24b492f00\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/collect.js\":\"f6d7141e53974a7e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/index.js\":\"e750b0e50bcc2ea6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/record.js\":\"e155001b8a391bb8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/RejectionDialog.js\":\"4db7743725092690\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5db2e279e9bd4437\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/index.js\":\"3faf5efdbf00b241\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/model.js\":\"9a4435eb429c6580\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/queueCounts.js\":\"f1760a4081a92051\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rejectedHelpers.js\":\"ba1cf84fbf3a5aed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rematerializeAction.js\":\"9c298283d26bcc41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/useHysteresis.js\":\"37a60c37f64565f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/effect.js\":\"ef8d6d2d0b7a6f02\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/index.js\":\"2267438220665105\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/theme.js\":\"29f09080d9368ff8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/actions.js\":\"2b4948c94896bf59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/dataExtension.js\":\"e1f4c4f7a3441860\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/index.js\":\"067cf7b06797aec2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/schema.js\":\"deb4be7b9db5230c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bc0e111d5df451dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/actions.js\":\"87495168caf74103\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/defaultItems.js\":\"d7161e2384583b4c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/facet.js\":\"398e8f1a37a52022\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/holdRecognizer.js\":\"4e8c53c2d1fa211e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/index.js\":\"75b4252403dc623b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/UpdateIndicator.js\":\"06522877bdce1bbd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/index.js\":\"32c3307e12c71fb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/loadTimes.js\":\"5308e1bc618e5310\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoNotesRenderer.js\":\"0e86886fa316ebdc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoPlayerRenderer.js\":\"ab4be119c39dd4d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoTimeStamp.js\":\"c0bb5f77a2e6fc01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/actions.js\":\"29d7f2940f2c9327\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/index.js\":\"7d1ab9c09cdfa355\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/markdown.js\":\"7bbdf40b8079020d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/notes.js\":\"6af2a1b064dda4ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/registry.js\":\"3e1f3825bcbc86e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/remark-timestamps.js\":\"a1c79f9e3bde3015\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/view.js\":\"3a3aabc1abe5c7a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/LinkHints.js\":\"b95affd481bcac73\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/index.js\":\"958fc5fcf6b17562\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/model.js\":\"8a469700d14f52cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/settings.js\":\"0476cf46e765ff4e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/actions.js\":\"0d8de070b8a0e4b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/index.js\":\"65964e0c2821bc55\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/interactions.js\":\"049f0cffa28bc557\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/workspace-header/index.js\":\"a57ec10d5c7e27fa\",\"/knowledge-medium/pr-preview/pr-1788/src/registerServiceWorker.js\":\"9e8b258b5d6c2888\",\"/knowledge-medium/pr-preview/pr-1788/src/requestPersistentStorage.js\":\"c8abee0e2cacd0fe\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authRequestDeadline.js\":\"24a30d44551e85d1\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authStorage.js\":\"4b57f4274d23f793\",\"/knowledge-medium/pr-preview/pr-1788/src/services/powersync.js\":\"a132e895a06f3083\",\"/knowledge-medium/pr-preview/pr-1788/src/services/supabase.js\":\"cfd7ac56c255fc41\",\"/knowledge-medium/pr-preview/pr-1788/src/services/uploadErrorClassifier.js\":\"14efb8f9897b8277\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/ActiveContexts.js\":\"bd5b5dc615f1cbc8\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/HotkeyReconciler.js\":\"2c250e2974ab8be1\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/WipeLocalDataDialog.js\":\"bf7fb1e09311d733\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionDispatch.js\":\"d0b2630b2384c36a\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionRefItems.js\":\"ba68ad789d395274\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/applyKeybindingOverrides.js\":\"d7b59396bcbc42ec\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/blockActions.js\":\"cb43dba819dff99e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/canonicalizeChord.js\":\"0448cf14d2278f43\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultContexts.js\":\"75607b5c1d96ff0c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultShortcuts.js\":\"1a707cb7ce4a6a1d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/effectiveActions.js\":\"b9ff7f9bf5842d2b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureAction.js\":\"d00df25d511b9f54\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureBinding.js\":\"95e4630387dceb2c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/holdRegistry.js\":\"81b6406fa5bbce1d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingConflicts.js\":\"e4c126143b1bea41\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingOverrides.js\":\"18f5288247008678\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/pointerAction.js\":\"4db4023f74e5027b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/resolve.js\":\"c1d2e16878e91282\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/runAction.js\":\"d3ba34b9c7f5cede\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/sequenceMatcher.js\":\"87ffc7716c9e204e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/types.js\":\"89d6ed9009b57162\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionContext.js\":\"877961664850eaf6\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionDiscovery.js\":\"2af63374950a82a0\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/utils.js\":\"96f50425570151f9\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/bootStore.js\":\"63a53d025dcae1ce\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/previewDatabases.js\":\"c21c2e4c42677c51\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/byteTransform.js\":\"923a178ca7c7e8d9\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/attachmentCleaner.js\":\"263fe54bf1e3f48f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/attachmentParts.js\":\"3a5e5e4fed4b4082\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleParts.js\":\"e54c920e1271b719\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleRecord.js\":\"8b9abfb5cbf48c51\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/manifest.js\":\"96a56e8304ef4b96\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/takeBundle.js\":\"2055d4e936a5b38f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/verifyBundle.js\":\"1a132f6a7df830a3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/cleaningStage.js\":\"456a79370115d412\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionKey.js\":\"8beaff5a5dd1d7dc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionServer.js\":\"a54d8910a23ebd9a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flip.js\":\"ff0c4feb0c047f30\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flipAttempts.js\":\"27d174a7d9fc1286\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/pages.js\":\"d3d8c5cd9eb744ea\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/preflight.js\":\"0c2cc12c0bf0f5f8\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/reseal.js\":\"0408ce99c47790e5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runConversion.js\":\"be2aa13c212826d3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runLock.js\":\"adeb2b808e0bddd0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealing.js\":\"fabd89f9f8ac93a4\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealingStage.js\":\"2b7730d1df176c6c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/stage.js\":\"9bcf549961312422\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/verifyReseal.js\":\"06189acaa73c110c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aad.js\":\"1a647c71821e4101\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aead.js\":\"5ef7c41c3383fb71\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base32.js\":\"8b34687213b3b070\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base64url.js\":\"50e1873d8f28e707\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/binaryEnvelope.js\":\"5e0e5ae9044964cf\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/byteAead.js\":\"b7be6a2afe721e7a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/canary.js\":\"4e2945f4c0ad5313\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentHash.js\":\"70e3aa73bf79c2ea\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentKey.js\":\"c48a34a4f0859504\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/derivedIdNamespace.js\":\"f47b82e926fc8dd0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/envelope.js\":\"e65a2c62526d0bb8\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/hex.js\":\"d273a1ecf392b227\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/sha256Hex.js\":\"e0d4857861c3deda\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/workspaceKey.js\":\"52fdbafc73a03af5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/conversionState.js\":\"594873a03e95f1ba\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fe0966044f1822cf\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/pastedKey.js\":\"870d070ad1726670\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7cd6bdee8ab50cff\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/upgradeWorkspacePin.js\":\"073ba3a0a1bea97b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/keyStore.js\":\"bf013cf25069d10c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/mintWorkspaceKey.js\":\"62098e25a58a62d7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/modePin.js\":\"2974db1700a48789\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/openWorkspaceKeys.js\":\"91645cdde42c75ed\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolveWorkspaceEntry.js\":\"26d7af75339934fc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolver.js\":\"b1963ea2da1433e5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/workspaceAccess.js\":\"06ef344f17333295\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/transform.js\":\"f16017433ece8a3a\",\"/knowledge-medium/pr-preview/pr-1788/src/themeBootDefaults.js\":\"0fbfb6e3bd53d4a0\",\"/knowledge-medium/pr-preview/pr-1788/src/types.js\":\"5b2d776e4af7945f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/ClientLocalSettings.js\":\"a6c8a7df890acb5b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/abortableSleep.js\":\"0d74585946855e3a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/array.js\":\"d376394ae9e1a602\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/backlinkAutocomplete.js\":\"21fbaee38078bb86\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockCrumbs.js\":\"868e1b1f092cef42\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockrefAutocomplete.js\":\"0f65925c7c39602a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/cadencedIdleJob.js\":\"70597ba661b6153c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/callbackSet.js\":\"595bb9d4985d87c0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/clientId.js\":\"c5dafb441645a621\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirror.js\":\"85fa701fb7bad734\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirrorCompletion.js\":\"74ba15932949a334\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/copy.js\":\"927c0ca204f84c66\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dailyPage.js\":\"5378b4b83bc171d6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensics.js\":\"d47c5465db314ffe\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensicsHooks.js\":\"7c6ba605c712332a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/deleteBlockThroughUi.js\":\"e6b492fdf6c6e6cd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dialogs.js\":\"3c29bf1f20d2d57a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dom.js\":\"6f1df73f8e2d5ed4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/downloadBlob.js\":\"894222ac1e4ce4d0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/exportSqliteDb.js\":\"b8036fcdac5493ad\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fileSystemAccess.js\":\"e9a3fe690439acc6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/flipSlide.js\":\"083706f51f950b8c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fnv1a.js\":\"b505ed9a2f965a74\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/formatBytes.js\":\"7364cc4ee8743dfd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fuzzyRank.js\":\"a668e9fdd2ca8772\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idbKeyedStore.js\":\"3e71fd4b4b762551\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idleCallbackPolyfill.js\":\"6b70535527007908\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardAwareScroll.js\":\"d590d8313cc2212c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardViewport.js\":\"587d44613499376d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/lastWorkspace.js\":\"c1789a261ac1ad53\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutColumns.js\":\"2b7ae8e164740c83\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionDom.js\":\"4b17ee4f2ac0db0c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionId.js\":\"da05dd0be14908cd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkClickGestures.js\":\"157783cf56c9f721\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkTargetAutocomplete.js\":\"ebb27833ac30cb2c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbCorruption.js\":\"d320d1ce2138633c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbRecovery.js\":\"d438fd4d5c99ec12\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/markdownParser.js\":\"8b21db85a20cf419\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/memoize.js\":\"426af7c0f6786320\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameFieldCommit.js\":\"ad3de95bcc9bc166\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameList.js\":\"50c9b864ddab2ef7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/navigation.js\":\"eece35311c0b9cae\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/omnilinerNamespace.js\":\"7606860a645ce859\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/opfsPageScan.js\":\"abdbfd1a86a82398\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelClearance.js\":\"a7db49838f7cc88a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelHistory.js\":\"ee460eeaf332e473\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLanes.js\":\"95284291032e65ae\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLayoutProjection.js\":\"2b0c46a32b724a60\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelScrollAnchor.js\":\"7150ed430d40c7ce\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelUrlFlags.js\":\"77fb2b647f957ca5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/platform.js\":\"4e146156abf9d5d2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/pluralize.js\":\"b89ad02e3403d5b2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyCreation.js\":\"04c75854b540c5f2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyNavigation.js\":\"1f4a712ca2a9ab5d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyValueContext.js\":\"db324a03acb6714c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/react.js\":\"3128daad0d2c6cf8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeDate.js\":\"a8419f465b7c7879\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeTime.js\":\"c4a42d4d5fbc847e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/renderScope.js\":\"f41cb4b55e70796e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/resolvedThenable.js\":\"aa628b8f928fbf22\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/routing.js\":\"f87697d2efc73de5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/safeMode.js\":\"96449bd1cd26f3a4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/scheduleIdle.js\":\"ec8dbaab44ad8698\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/screenWakeLock.js\":\"d276b265fa9d3372\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/selection.js\":\"46a95feb0e27c797\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/softKeyboardGrab.js\":\"444766fe83e20194\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/startupTimeline.js\":\"896da6a0f8fd7ceb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/state.js\":\"fe7119c032b1df27\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/string.js\":\"77d5eca742d8c4e1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/surfaceZoom.js\":\"8d67989fa12c6002\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/time.js\":\"3fd94238e8812178\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toast.js\":\"03c144f85af2e88b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toggleStore.js\":\"4fdb662696f8e5cf\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/untilStopped.js\":\"84359b6a081fba1c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/userActivity.js\":\"27819cabc14f1ea1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewTransition.js\":\"f7f7d1ce88b03474\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewport.js\":\"15d26ad3da5e734a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/webLock.js\":\"1cf75acab266bc70\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceRecovery.js\":\"bed93204c5a2ae17\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceSnapshotStore.js\":\"a3686a5a98f2ce13\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-compiler-runtime.js\":\"2e69f71d860ef351\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-client.js\":\"c535a192d5a3b454\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server-edge.js\":\"01c252682447360e\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server.js\":\"1d922aee649b5c5d\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static-edge.js\":\"6b4cd324eb9fba11\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static.js\":\"cda04ed93b75b635\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-test-utils.js\":\"b1b3b109e737a4da\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom.js\":\"06c81f3489f8b599\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-runtime.js\":\"ff52ba2d4b395dff\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react.js\":\"e1de017dfb29c3eb\",\"/knowledge-medium/pr-preview/pr-1788/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
