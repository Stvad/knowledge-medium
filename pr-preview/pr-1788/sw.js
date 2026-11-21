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
		buildId: "273125054fb9-1eb1de77",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/\":\"f6384b00c56da92b\",\"/knowledge-medium/pr-preview/pr-1788/index.html\":\"f6384b00c56da92b\",\"/knowledge-medium/pr-preview/pr-1788/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1788/assets/FacadeVFS-ZCRGUJFE.js\":\"df97fb4891d87120\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSCoopSyncVFS-DFvj2ptq.js\":\"e07dc91ded818d1b\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSWriteAheadVFS-CBn5jnWO.js\":\"90d72333506619de\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-VHim_sjG.js\":\"3ee607d1115fdbcf\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-D5y5E6Iu.js\":\"5530d0155c73c11e\",\"/knowledge-medium/pr-preview/pr-1788/assets/worker-CQ3oMEyB.js\":\"fd4e74c127fa613d\",\"/knowledge-medium/pr-preview/pr-1788/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1788/chunks/app-Bb2Ep3h3.js\":\"00e2b4827cd76cef\",\"/knowledge-medium/pr-preview/pr-1788/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1788/index.js\":\"7351486f0fea3394\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1788/assets/AccessHandlePoolVFS-BIZFShHd.js\":\"40163fd2584d781c\",\"/knowledge-medium/pr-preview/pr-1788/assets/IDBBatchAtomicVFS-CIfB4ukQ.js\":\"b7a76d7f99c5831b\",\"/knowledge-medium/pr-preview/pr-1788/assets/MemoryVFS-PEM6NHw2.js\":\"5805389859240a11\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-ChWoBi98.js\":\"0f3d89b51a9ad7bc\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-BYnt30z1.js\":\"9f91e98210bd7325\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1788/chunks/AccessHandlePoolVFS-BDkyWhn5.js\":\"24ec82e5d21f4f09\",\"/knowledge-medium/pr-preview/pr-1788/chunks/FacadeVFS-eh3m0mvy.js\":\"4d17a4c443bb7ac0\",\"/knowledge-medium/pr-preview/pr-1788/chunks/IDBBatchAtomicVFS-Dlv1FQir.js\":\"20e080c274cd3551\",\"/knowledge-medium/pr-preview/pr-1788/chunks/MemoryVFS-rBUOMqJ0.js\":\"f80f041656c4602d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSCoopSyncVFS-7KTkcGAH.js\":\"5195c571a1c19ee3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSWriteAheadVFS-SfNfdoiw.js\":\"efbe2885dedd4d56\",\"/knowledge-medium/pr-preview/pr-1788/chunks/Preview-D15KLu1l.js\":\"c62d0b87dd527c57\",\"/knowledge-medium/pr-preview/pr-1788/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/card-D10KVEFH.js\":\"563d94051f6c7fe6\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-CerIprYc.js\":\"205adceb4db6e00c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-EWeEnxiQ.js\":\"fb839221759d27ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-async-ClyGc1Gt.js\":\"fb2c0ba9129c2673\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-BZhI1txZ.js\":\"8e4bf734ac44ed56\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DLmcjGYN.js\":\"3d268ae8679063ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DZnmoGFm.js\":\"f6b66bc2ff708d45\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DhAXF3rF.js\":\"349762e8737cf3a1\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-Dtly8mBG.js\":\"68b83e00a6e93e96\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-QiJnO75D.js\":\"e9df9f02c5358946\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-SbDkz3yt.js\":\"e4f5360278c80c0d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server-legacy.browser.production-BAVrORsg.js\":\"a6889da75aa17bee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.browser.production-BbQJyY6C.js\":\"747407a72ba207ac\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.edge.production-BFOl1jzQ.js\":\"32e9b71dfdecfcca\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-uzsvJ7ue.js\":\"4e6f5c53f479a3e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/server.browser-lTQNWtpM.js\":\"07ea18424cf468c8\",\"/knowledge-medium/pr-preview/pr-1788/chunks/textarea-D6FOlRk2.js\":\"fc1dede96afbe4f3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/ui-B4Amfje6.js\":\"5e34f5ce707e6ec1\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-Cj1mtf1Z.js\":\"f22f4b8886f436e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-async-CKwLWy84.js\":\"b47819fb8f3df2c7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1788/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/src/App.js\":\"c965f455ff63316d\",\"/knowledge-medium/pr-preview/pr-1788/src/appUpdate.js\":\"c7bafe281998591f\",\"/knowledge-medium/pr-preview/pr-1788/src/appVersion.js\":\"349536319502ac00\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/initialLayout.js\":\"c867db8e3852f9ea\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/openWorkspaceData.js\":\"64cf0ed590bfcacd\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/resolveWorkspace.js\":\"d3d1ae21e7a4c570\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/workspaceBootstrap.js\":\"376bf6bdd03de4c5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockComponent.js\":\"e3a3a552552adbaa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockCrumbs.js\":\"2c1e14a1566ec022\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockEditor.js\":\"235442315ae5b54f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockLoadingPlaceholder.js\":\"60c032971ada6e85\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockProperties.js\":\"b8334c1ef5c3f191\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockSearchPicker.js\":\"a6357d9465ba85aa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ConfirmBulkDeleteDialog.js\":\"a7cdc962ac5067ca\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DividerHandle.js\":\"92ca61e671ba41a2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DraftEditor.js\":\"2cdbfbe5836d4d20\",\"/knowledge-medium/pr-preview/pr-1788/src/components/GutterPill.js\":\"94174536d089d5c6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Header.js\":\"d55aec8132d9b404\",\"/knowledge-medium/pr-preview/pr-1788/src/components/LazyBlockComponent.js\":\"8715ce06f789e0e5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Login.js\":\"aa72d2ba446ebc23\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ZoomableSurface.js\":\"54ec30bc00565ade\",\"/knowledge-medium/pr-preview/pr-1788/src/components/editModeKeepalive.js\":\"7b34ba1b21b8af34\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6e23b58e00cfe952\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"44088657328cc58f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefPropertyEditor.js\":\"1b0d65b7ab4d4c62\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefTargetTypePicker.js\":\"2a04b70b24f77edd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/SelectPropertyEditor.js\":\"8a02034ba2af69af\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/TypesPropertyEditor.js\":\"9d4258e4ace2f988\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/defaults.js\":\"db03034cf5563e1b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/kernelValuePresets.js\":\"1736536d99d2e7f1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/selectablePresets.js\":\"c6d2bcc02ea8b701\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/typesPropertyUi.js\":\"da5633e3292222e1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/AddPropertyForm.js\":\"818566352265439d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyPicker.js\":\"65dd0681ae2f554a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyRow.js\":\"36ebde581e1c98ec\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/Rows.js\":\"f73b1f0580b24880\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/actions.js\":\"e279afe67c59071c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/declarationOnly.js\":\"f3b9b259f6388a38\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/layout.js\":\"affdf9e0c08c8af5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/model.js\":\"f83299c16c803acd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapeUi.js\":\"41cb2430510215ca\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapes.js\":\"703b092f6667dfae\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7434d34adab7893d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/visibility.js\":\"c7c2f9b7d3bc4edd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanelSections.js\":\"ae6c987beb8aa844\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockEmbed.js\":\"b8ff5c1f738baaf6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockLink.js\":\"0fa41660a874ebd5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockRef.js\":\"2321ee6a7124bc5e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/ReferenceLink.js\":\"00f2a7b56662b4ef\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuard.js\":\"abf5871dd8822579\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuardContext.js\":\"72d42d52ab04afeb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/linkInteraction.js\":\"d738a399483efbc0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/referenceLayout.js\":\"df31d24b1afc98ee\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/useBlockRefAncestors.js\":\"be4b5be9f2f1bbe3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockGutter.js\":\"bbdb91e098a4b5c7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockInfoDialog.js\":\"df05b3910ee5cd8e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockTypeBlockRenderer.js\":\"903a4cef72b704a4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BulletHoverCard.js\":\"52c4f07cdea7f0f0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorContentRenderer.js\":\"623ad01c4a874231\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"92e1ca20c93393b6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ColumnResizeHandles.js\":\"c0aa0127600c3a95\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"86cfb492c677fc30\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/DefaultBlockRenderer.js\":\"7e2f4f8453aa3037\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/LayoutRenderer.js\":\"20e72cedfb629752\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MarkdownContentRenderer.js\":\"a1f7ce54bbdd6cd4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MissingDataRenderer.js\":\"8a7aa55919de6a16\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PanelRenderer.js\":\"56ec31aee4004854\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PropertySchemaBlockRenderer.js\":\"029b661948d95860\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/TopLevelRenderer.js\":\"3ae3f65ec184931b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockGutterMode.js\":\"91c5f0648dab89ce\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockTitleText.js\":\"8771c28c7d2b58d2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/fieldCreationKeydown.js\":\"1a88479486f36ee4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/layoutRootContext.js\":\"53caf4fa7d0972b1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/TypeChip.js\":\"9f5cd5825e86ffb4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/chipStyle.js\":\"035c80874b8cc80e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/anchored-floating.js\":\"a668e805e3a6c79f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/button.js\":\"abe2105d87b5e2f9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/card.js\":\"383b69ea7c68aa38\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/checkbox.js\":\"a5867bc3939f452e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/collapsible.js\":\"51d2419610454af0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/command.js\":\"6336577bfb19e2e9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/context-menu.js\":\"49229bcf573f266e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dialog.js\":\"edb10b93e7a99b56\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dropdown-menu.js\":\"8c8c95b1d349eab5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/floating-listbox.js\":\"401bb0fca302c0e2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/index.js\":\"e40743424398cf6e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/input.js\":\"a48b47c9f68470ec\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/kbd.js\":\"2a34c309fb26fe34\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/label.js\":\"c841e736129c4218\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/textarea.js\":\"3882d0cbe6af8b4a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/useEditModeYieldKeepalive.js\":\"65e3dd495207acf2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/BootFallback.js\":\"5f32153842b9025f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/FocusedRowLazyMount.js\":\"3169b343155a2774\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LazyViewportMount.js\":\"c9f9a7084fec46ed\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LocalDbCorruptionFallback.js\":\"7b508f70f9887218\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/error.js\":\"30e7291e8b09639c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/lazyMountRegistry.js\":\"e092e64091d74f92\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/suspense.js\":\"68242ba45f6484d3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/CreateWorkspaceDialog.js\":\"55ab8e2ba69d979c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/PendingInvitations.js\":\"2fff07331bef33fb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/SyncProgress.js\":\"0707dbad0da5973e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/UnlockProgress.js\":\"14dbea83565a9a79\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceKeyGate.js\":\"9293e856808826d3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSettingsDialog.js\":\"c8ef371bacaece24\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSwitcher.js\":\"ffc07695a99b199e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSyncGate.js\":\"6b307a2c0eea1469\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlow.js\":\"bbf48dd2a0e10d65\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlowHost.js\":\"a549e19f573dfe8c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/EncryptionSection.js\":\"ff33652f7993df0c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/attachmentPrompts.js\":\"a6866dee19de6389\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a5d7f43c41574625\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowDeps.js\":\"7a7ff1cba6924785\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowStore.js\":\"493ec6aa1f902578\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/flowUi.js\":\"ee09c059712b4548\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/useConversionRun.js\":\"8ed31b5ae76ce8ef\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/keyUi.js\":\"5e7e76fe5a3e0083\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnKeyLoss.js\":\"62bf8eed33907d89\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnServerE2ee.js\":\"953f802c0d6cbd3c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/workspaceUnlocked.js\":\"04ae3cf85d5c4bf6\",\"/knowledge-medium/pr-preview/pr-1788/src/context/backgroundSubtree.js\":\"5fe4e5ee4cb64c27\",\"/knowledge-medium/pr-preview/pr-1788/src/context/block.js\":\"a9127e1493cdcd7b\",\"/knowledge-medium/pr-preview/pr-1788/src/context/layoutWsContext.js\":\"628b2a171ca7c304\",\"/knowledge-medium/pr-preview/pr-1788/src/context/propertyDisplay.js\":\"21c68437cc607cd9\",\"/knowledge-medium/pr-preview/pr-1788/src/context/repo.js\":\"0038c3dae5c03e5b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasClaim.js\":\"167b11f6dc21663b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasSeatNamespace.js\":\"bb4d7e30155c3f3c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockData.js\":\"3de5d6458e0aada2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockType.js\":\"8da3eba866805815\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/changeScope.js\":\"dd7a89ff134fa335\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/codecs.js\":\"03181900f5d1838c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/derivedData.js\":\"eb2a33dbe5ef8898\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/errors.js\":\"3cf9b5c6225035a5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/events.js\":\"d1febac75ba324fe\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/handle.js\":\"488c141a2de4819f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/index.js\":\"5d0f04af0916a7d7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/mutator.js\":\"51b3f1709b1e0131\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/processor.js\":\"16eb134efa3380ae\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/propertySchema.js\":\"0b93fa2f5b60398b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/query.js\":\"7feae71ff6b458c8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/sameTxProcessor.js\":\"88bcd241b542862f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/schema.js\":\"488c141a2de4819f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/tx.js\":\"488c141a2de4819f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/typedBlockQuery.js\":\"ed93061e949342e2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/user.js\":\"32a561fbecf40570\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresetCore.js\":\"ee084a7212bbe116\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresets.js\":\"27b8afe413013e3a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/attachmentCleanerIOVerb.js\":\"b4d7a3693803b553\",\"/knowledge-medium/pr-preview/pr-1788/src/data/block.js\":\"722e78f5e7dc638c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockCache.js\":\"860b3d1aa2f3e0d8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockId.js\":\"716cea7e447f65c0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockLiveness.js\":\"2eea19f66b5ede6a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockMerge.js\":\"2d76db1de349d90b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockSchema.js\":\"f8990e3cd6b1eaca\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockTypes.js\":\"03415804cce6fc67\",\"/knowledge-medium/pr-preview/pr-1788/src/data/clientContext.js\":\"fd2826f787347c51\",\"/knowledge-medium/pr-preview/pr-1788/src/data/dbFileSiblings.js\":\"403290a491314b3b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/definitionSeeds.js\":\"0b42288488eb0fd0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/derivedIds.js\":\"9fa9856b84aa1ff2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/drawnSubtree.js\":\"6574799ffce4a2ff\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facetBridge.js\":\"a2ec11a6fc3c375e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facets.js\":\"f045cb1f19e71831\",\"/knowledge-medium/pr-preview/pr-1788/src/data/globalState.js\":\"5bb08938cc9dbba2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/aliasClaimRederiveProcessor.js\":\"e852d3de70d5d083\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/ancestorBatch.js\":\"9f37253a5d7c664a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/blockTypeTypeifyProcessor.js\":\"8a1a0061e3721d1a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/clientSchema.js\":\"54972af5621880fc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/commitPipeline.js\":\"22d1451a0eb9480b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/devAssertions.js\":\"69cd6123804877f6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/firstSync.js\":\"b1b5b3b8d33520a3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/freshInitialLoad.js\":\"73f994c610906490\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/graphBackfillClaim.js\":\"a83af0c182b741f6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/handleStore.js\":\"bb44c7a29bd7345c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/idleMarkerJobs.js\":\"ab1ce5e5c34c97f7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initialDownload.js\":\"0b0aee97f2d8d8cb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initializeClientDatabase.js\":\"35bf0a8606f4e18c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/jsonCanonical.js\":\"39a266013ebf9094\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelInvalidation.js\":\"e46fe92f5a548ce7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelProcessors.js\":\"e591fb3d4fe88ae7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelQueries.js\":\"6505274c47f7861c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/mergeTypeMembershipProcessor.js\":\"18017da1b68fed4a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/normalizeReferencesProcessor.js\":\"6a9b208a64fe67a6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/poolInstrumentation.js\":\"7c34e1606be719bd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/processorRunner.js\":\"2e3348e3d66e5fdb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCell.js\":\"e692c913c07395d3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCellBackfill.js\":\"4ac11e3b2df2ae5f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildMint.js\":\"f52b17a1fd68193d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildrenProcessor.js\":\"ab5c8bd5e8c0508a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bea9a020413cfc71\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionSynthesis.js\":\"02959fd220b8d643\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyKeyScan.js\":\"d86a4863c34d352f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertySchemaResolution.js\":\"e8b065c6641fc609\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/raiseProtocol.js\":\"05a935fb3eb64fca\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/readBatch.js\":\"59dc5efd10635748\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/refProjection.js\":\"8edff1e156ef9597\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetLookups.js\":\"166d7ada32985a89\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetProcessor.js\":\"db467327ed7f8a6f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/replayMerge.js\":\"ece99b6403aba6c2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/sqlBinds.js\":\"c812b3faf1da9d6b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6c79d3fb68eff6f3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/arrivalProcessors.js\":\"c82ca00a6c1272c9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/invalidate.js\":\"126cd4cf919e45dd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/materialize.js\":\"472961abe7dac952\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/observer.js\":\"8143aed66312bd62\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/reconcile.js\":\"df0f2025d83f8d7d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/timingMetrics.js\":\"6b3b4966221d43fa\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/treeQueries.js\":\"ad76e9bf581e53e9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txEngine.js\":\"42585aea94892373\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txSnapshots.js\":\"156fa2e183d90705\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/typedBlockQuery.js\":\"42d75e1950167bbf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/undoManager.js\":\"752538557191f760\",\"/knowledge-medium/pr-preview/pr-1788/src/data/invalidation.js\":\"d62a18b71a770e58\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelDataExtension.js\":\"5464e1dae6e36513\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelPage.js\":\"fa5cec54a51ea440\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelValuePresetCores.js\":\"3282732e1b3e36c0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbCorruptionSignal.js\":\"2292692e0d4f2b26\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbStorage.js\":\"b04b84307844e6ab\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbVfs.js\":\"700a4d471e43364e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localSchema.js\":\"e389104c862a8764\",\"/knowledge-medium/pr-preview/pr-1788/src/data/maintenance.js\":\"da4e364475406788\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mergeProperties.js\":\"cfae6b901bfdfa08\",\"/knowledge-medium/pr-preview/pr-1788/src/data/metricsConsoleHook.js\":\"c21c8935812a680e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/migrationsPage.js\":\"2872228bc5ba1428\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mutators.js\":\"d65a1b89149c952f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKey.js\":\"a1d2ec87a41e2c82\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKeyPlacement.js\":\"17f98bf21aad55e7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/outlineSurface.js\":\"d331b3a8e86b8a0a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingEditorContent.js\":\"a8697120bdc190c0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingUploadsSql.js\":\"6d573131748395d3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pluginStateExtensions.js\":\"d9f453c6adcc3b48\",\"/knowledge-medium/pr-preview/pr-1788/src/data/powerSyncLogger.js\":\"e34542e16cd1b955\",\"/knowledge-medium/pr-preview/pr-1788/src/data/projectorRuntime.js\":\"3f9b7410c3e9c2a6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/properties.js\":\"fa2ec2b1d4b56ada\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertiesPage.js\":\"cc34eaee8a3e7f5d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyChildren.js\":\"df526845dbf9ffab\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionFanout.js\":\"571f86062ec9c225\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionMetadata.js\":\"884e5ae4083d491e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionRegistry.js\":\"b23d8df0f1f87887\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDisplayMode.js\":\"4aa907bc122476db\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyRowCreation.js\":\"eb3d2061d561c8c5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySchemaCreation.js\":\"0f0176e213ffe9a7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySeeds.js\":\"479ac1ac6a117024\",\"/knowledge-medium/pr-preview/pr-1788/src/data/recentsPage.js\":\"b5266c990a9d17e1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/referenceBlock.js\":\"10e3cce715e9b8ad\",\"/knowledge-medium/pr-preview/pr-1788/src/data/releasePowerSyncConnection.js\":\"a80d5f4341411a3a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repo.js\":\"0b35db951a351afd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repoProvider.js\":\"6a63eddb8c924f91\",\"/knowledge-medium/pr-preview/pr-1788/src/data/rowProperty.js\":\"0ab5e5fe9b98ec61\",\"/knowledge-medium/pr-preview/pr-1788/src/data/searchFilter.js\":\"d649c66d4ee09f2a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/seedIdentityLedger.js\":\"5f3ddc77a9214457\",\"/knowledge-medium/pr-preview/pr-1788/src/data/stateBlocks.js\":\"e0a2b8c7255db8cf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/structuralEditPolicy.js\":\"326e11df953ab43e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/subtreeDelete.js\":\"532eb2865d2b8300\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncStreamLock.js\":\"a2f9700850104218\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableSqlRecognizer.js\":\"c21bc88040509f95\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableWriteGuard.js\":\"dec6d9c08bde3398\",\"/knowledge-medium/pr-preview/pr-1788/src/data/targets.js\":\"67806a9e8d223576\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeColors.js\":\"9e7bdb19d43c4dab\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionMetadata.js\":\"2c1249fa7798e158\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionRegistry.js\":\"194ce18eecc8842d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeExtraction.js\":\"33f2330d5d7104f8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeInitialValues.js\":\"6f30271fa389e757\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typePropertyGroups.js\":\"7c143d0352a98da5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeSeeds.js\":\"793a030f8e1ae559\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeTagger.js\":\"d686861eb9b999be\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typedRecords.js\":\"dfc1a7d3ad10ccad\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typesPage.js\":\"a3e2d5420b385009\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userPrefs.js\":\"4d5095098ee5fef0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userSchemasService.js\":\"0faaad401bd81256\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userTypesService.js\":\"ce1e30ac2f490b60\",\"/knowledge-medium/pr-preview/pr-1788/src/data/valuePresetRegistry.js\":\"93eaec655a74e8a9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/visibleChildren.js\":\"a453f861f79d9486\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceConversion.js\":\"3bcbde7fe628b6ff\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceFirstSync.js\":\"46286cdb94821153\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceIdNamespace.js\":\"5e69628686cdb228\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceSchema.js\":\"932c6036058ea5a3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaces.js\":\"47549cd90e3f809e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadLog.js\":\"27433610debb89ea\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/BlockPasteShellDecorator.js\":\"bd481dbb76186200\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/atTrigger.js\":\"228e7fc45e36e664\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/autocomplete.js\":\"fb648b06ebac0b9a\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/codeMirrorExtensions.js\":\"6d6086b5f1ae7994\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/contentFlush.js\":\"e5d23974398f469e\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/defaultInteractions.js\":\"9754e5108e5611f8\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/editSettleSignal.js\":\"a06c4815f2a5a187\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/insertImage.js\":\"1a9d68ffbb2dd12e\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceCompletionRange.js\":\"9932f1e63564ca82\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceTargetTypes.js\":\"3b909c3b11876aed\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/syntaxContext.js\":\"a7c959028bccecab\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/triggerMatch.js\":\"6690ed75d054980e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/AppRuntimeProvider.js\":\"0ec0c1557d65d240\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/BlockFocusShellDecorator.js\":\"8bae355eab256239\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/ExtensionRenderBoundary.js\":\"7ada96f9223dfb81\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/PanelContentRecovery.js\":\"8c87a3eadc492a29\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/apiCatalog.js\":\"937d6b99c6ae1f9d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/approveExtensionHere.js\":\"45b69e3b35e15e21\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/armedCutAppMount.js\":\"a93c46e983c41cff\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/batchableKeyedStore.js\":\"b945345d538d8e12\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockInteraction.js\":\"ce1049cc656dbac3\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockSelectionAction.js\":\"dc5ae64ad688ff35\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compileExtensionModule.js\":\"a00160726cbb5821\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compiledModuleCache.js\":\"9a646cdd99ce35ab\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/continuousGestures.js\":\"881e1df4a872e278\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/core.js\":\"a907b5355a70bd70\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/defaultRenderers.js\":\"9a6b79fe9cd1268a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/definitionFanoutAppMount.js\":\"49180ac0cea95533\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dialogAppMount.js\":\"85d0a7094b553b77\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensionSeeds.js\":\"9fe4e9db7cbb6f70\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensions.js\":\"9d50e35e8c79ba54\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/exampleExtensions.js\":\"b88bd4bf41899c0d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionApprovalStatus.js\":\"f1067feedbcf3697\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrorToast.js\":\"30ea7e82a5bfd02e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrors.js\":\"a5922ae844999645\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLookup.js\":\"fa5f8d9eb98c6941\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionToggles.js\":\"a4d055b8b9738e69\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionUtilitiesCss.js\":\"b820627185018983\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/kernelPageDeletionGuard.js\":\"fd450ff892fcddf1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/liveRuntime.js\":\"01e712938b4d003a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/openExtensionsSettings.js\":\"340cea8232f5c24b\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/overridesCache.js\":\"688b9692d9e1be2d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/pluginIds.js\":\"f7a53a4aba1c0711\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/processorRejectionToast.js\":\"0889cf4b476339d8\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeActions.js\":\"744d9939a9c35b06\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeContext.js\":\"9bb41c81ce9241c3\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticAppExtensions.js\":\"2424c5acccfc953e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticDataExtensions.js\":\"6d220e905e30021b\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/toastAppMount.js\":\"c66505a97ace784f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useOverrides.js\":\"3ac18077b4cf18cf\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useShortcutSurfaceActivations.js\":\"462bcbba6ecbba37\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/discoverToggleTree.js\":\"430507f91ba98a3a\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/facet.js\":\"398d6daac67ffc89\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/resolveAppRuntime.js\":\"9fec127bf3377122\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/runtimeEvents.js\":\"59fb61ac4c694e09\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/togglable.js\":\"6fb7cd85b45b5f4a\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/variantFacet.js\":\"70078dd7a3319686\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/verbFacet.js\":\"0f0a31bb5f9c647c\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/block.js\":\"9de26775355a7c1e\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/focusedChild.js\":\"55f36993291fda16\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/propertySchemas.js\":\"d81bbee7e87d83a5\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/typeRegistry.js\":\"492dc04b9a636e31\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAncestorCrumbs.js\":\"19b005c9d3abe56b\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAutocompleteListbox.js\":\"f394086f44657540\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedSearch.js\":\"e3ef3f35dce61dce\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedValue.js\":\"c63b6522a3f590cc\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsFocalRender.js\":\"f61ccbb2b2095142\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsReadOnly.js\":\"dff29ca54c5250f6\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMaterializeBacklog.js\":\"6d438a6a98504864\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMinuteClock.js\":\"d923c8138a10a6ba\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePanelLayoutProjection.js\":\"64de0f13a6493ef3\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePendingInvitations.js\":\"d73aff3b3a0ed5fa\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRendererRegistry.js\":\"9e30c2d4e910b400\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRetainedFieldRows.js\":\"ad0f5881f2521060\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useWorkspaces.js\":\"a6c93e87ac7a58e8\",\"/knowledge-medium/pr-preview/pr-1788/src/lib/utils.js\":\"541d061d1e6ba230\",\"/knowledge-medium/pr-preview/pr-1788/src/main.js\":\"2749ff236497d0f2\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/MarkdownImage.js\":\"6ed73bb21b08468c\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/blockSeparators.js\":\"a434cbe6b58f18d9\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/context.js\":\"f589bd08b954d489\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/defaultMarkdownExtension.js\":\"4fc39969a78613b5\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/extensions.js\":\"89793e4aaea1ca90\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/renderMarkdownHtml.js\":\"bc5b018587923a71\",\"/knowledge-medium/pr-preview/pr-1788/src/minimal-editor.js\":\"1fabb17b1a6dc273\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/armedCut.js\":\"f362b6e29c346a87\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/captureMediaVerb.js\":\"ab389f6ce7bc0dc8\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/clipboard.js\":\"1f70f2db36e23719\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/decision.js\":\"b4fc573442eb03f3\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/operations.js\":\"4b77026e2c7a3cba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/AccountHeaderItem.js\":\"f8c6ad7a77b55094\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/index.js\":\"6ea3e542e4f84509\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"903f648de9451fe5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askAgent.js\":\"f8705ddee0896abf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askedStore.js\":\"98fb4b311cd2e545\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"571cc270a21f5d09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/chipState.js\":\"5a7407424e396b8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3b360a05eeb63c25\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/index.js\":\"1b196688b1c94e62\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"02958dd3801d5729\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/schema.js\":\"1437d4702c8e0c20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3da5277614d53088\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7075c1bcc9913acf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/addMedia.js\":\"9c09e7882de2ca06\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6286d4687ce8209b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/block.js\":\"2637bad814355bbd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/context.js\":\"1b8e3546219a7e31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/displayIds.js\":\"6436f50a573f39f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/index.js\":\"e0590e26a42d9372\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/outline.js\":\"7b80c892130b5cf1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/properties.js\":\"f2ae624c98634116\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/refs.js\":\"8008b92b1ceb14f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"40182a743326bcd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/search.js\":\"aeccad06d2ca9305\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/shared.js\":\"f3685075ffb042fb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"76992fcb4fa80fbc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/text.js\":\"dbfee00fc8900711\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentWrites.js\":\"360c14a7c0d5212a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/authoringCatalog.js\":\"1f15802a35ae14cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/blockRefTargets.js\":\"eaebc9774d25b230\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridge.js\":\"50f196474bafce04\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridgeLoop.js\":\"8e8bc7a1a8042bfc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/changeHistory.js\":\"1330e0700e0718e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commands.js\":\"22c2bdd8ece16054\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commentsCommands.js\":\"d0ca6811656220bb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataExtension.js\":\"748b0a809b89f4a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataModelGuide.js\":\"70b851459a816c27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/describeRuntime.js\":\"538c073adec87bd5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/extensionLint.js\":\"2b5c8bd2ad25d0a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/grainAudit.js\":\"a190a609a1bc7be7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/healthCommand.js\":\"d3695873d3a8b2f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/index.js\":\"9c0e0e6679a63511\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/presetIdentity.js\":\"5dc6d685cde85dbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5b54231028152e4a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/readMedia.js\":\"c323b5d7154d9742\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/schema.js\":\"9b7f735240d9b220\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/serialization.js\":\"f2a776025078c12e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/targets.js\":\"561a9d8a54bfc0de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/tokens.js\":\"357189fbdb8c44a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/watchEvents.js\":\"d1a01a355e03df81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/workspaceGuard.js\":\"8722cbf15d2b67c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/writeCommands.js\":\"e88112c2b05bac1b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/AliasCollisionToast.js\":\"cdc4eda90daac958\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/DuplicateNameBanner.js\":\"2067636bdf1ba4ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/collisionMerge.js\":\"380d4d8a8ab09eba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/dataExtension.js\":\"389c600a3495f007\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/index.js\":\"7ecfa9509d1ec39f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/mergeCollisionAction.js\":\"1440f198673d42db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/pageStyling.js\":\"948fc0ca89cfe537\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/rejectionToast.js\":\"72a87667bbe81fe5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/syncProcessor.js\":\"c3da5e495cecaad6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/actions.js\":\"87fedbe0c0dab74a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/addComment.js\":\"09ea2bf21fb1d4d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchor.js\":\"5e187839c1cc8271\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchorState.js\":\"709d6a9bf8b2cbc8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/commentLinks.js\":\"0dbe9bd134478415\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/confirmThreadDeletion.js\":\"5d7a3d96101ebb20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/container.js\":\"8826c868690f8b6d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/dataExtension.js\":\"ec01db00175c4ef3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/deleteComment.js\":\"a7bb5129b5f5c28f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/highlights.js\":\"be45b2c5c2d35240\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/index.js\":\"9fc9ba441aa6d55a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/linkedCommentsPill.js\":\"1d75daf15f4bf3b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/margin.js\":\"4b41cc981eb2f6d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/marginSchema.js\":\"a14c2272ef1a5917\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/newComment.js\":\"4bf8bbbf46f7a883\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ownThreadPicker.js\":\"35300705f06f6448\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/placement.js\":\"80042a5b03520b3f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/queries.js\":\"0c261ffda71b2c83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotePosition.js\":\"f005b6f57d25444c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedIn.js\":\"5c06a806bfe11a18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedRange.js\":\"accd50caf69a4edd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/rangeRefs.js\":\"463f806d9f97a95d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readHighlights.js\":\"f7a1d8ff191d0573\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelection.js\":\"ea70b84bdcdef9f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelectionUi.js\":\"ff1ac8146ce8a33a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/reanchor.js\":\"67d4ff4cd0090fc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/schema.js\":\"97d4689913319424\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scope.js\":\"54a2f05696010d2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scopeThreads.js\":\"cb5536d24f98194b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/splitRetarget.js\":\"a7464671944298f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestionCard.js\":\"d7bd3624d9e2beb7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestions.js\":\"05fe203b1442731a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaries.js\":\"ff379a0f4bcf383e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaryBatch.js\":\"17ce537af95febd1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/surface.js\":\"d4d156c2eddb65e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threadNavigation.js\":\"7a260366c19491bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threads.js\":\"5c6e5ab25959f3a0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ui.js\":\"e203e71e9bf104da\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/uiStore.js\":\"e6aeecb2d273067c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/appIntents.js\":\"17d52424fb7d34c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/index.js\":\"1d6d1441ea3f27fd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/index.js\":\"bc01f467a5c2cc2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/status.js\":\"4f6d9735cf9e05d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0a221f396f474bd0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaBlockRenderer.js\":\"4b8fa195835ad5b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e283628eca9d8658\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaUploadReconciler.js\":\"36c1b1353c1c6622\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetDownLane.js\":\"0c305a8a79d6871e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetResolver.js\":\"179dc12465b4d1d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetUpload.js\":\"c73d7587e5128b7e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/attachmentCleanerIO.js\":\"5b8e38e948527962\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/supabaseAuditIO.js\":\"771a1a13b0af8722\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/blobStore.js\":\"0d97eb4319176d32\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/byteStore.js\":\"8cc4a42c5200dab4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanerIO.js\":\"975fc9b0a2a5b5e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanupAttachments.js\":\"0d9f7d0de92b89e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/dataExtension.js\":\"5914351d64161a65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/downLane.js\":\"1961ca4f24c55bbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/index.js\":\"c6cda9eb85040a69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/insertImageContribution.js\":\"861fe410b3e4e81d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneArming.js\":\"6afa62a2202d23d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneLock.js\":\"7b74113c34e56804\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaBlock.js\":\"4173a2154c0f4ce5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaCapture.js\":\"b092154995d3f33c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewers.js\":\"cc404eb7fc719fd3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewersFacet.js\":\"0577bc3ea8046c90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/pasteCapture.js\":\"160879e31af63ef6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/resolver.js\":\"7589dc340568bd24\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/retryUploadsAction.js\":\"636eb344a3198bdc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/storagePaths.js\":\"dd692f8008739983\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadDrain.js\":\"6008f5baf98b1346\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadLaneStatus.js\":\"a9a1b386660501c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadReconcile.js\":\"93617afca8068ea8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadRecovery.js\":\"b06ec4d7613d01d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadStore.js\":\"bb69a8d6b20181b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/useAssetObjectUrl.js\":\"3699a425776f4d6d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d5bf6e71389c501a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6ffa432d64c407b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/facet.js\":\"d41f3b7c1c48bdc2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/index.js\":\"66669c75345e2577\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/prop.js\":\"298f59309821b0a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinkFilters.js\":\"2dda3d1ded85c27f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1b690d8054ef76d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BlockEntry.js\":\"c4faea7f0a0b5a41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/LinkedReferences.js\":\"123cb9e01b6b8e7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"54a84acf0369d20e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dailyNoteDefaults.js\":\"85c3c9941d577782\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dataExtension.js\":\"59a6df89e7d2a0a7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/edgeExclusions.js\":\"10344e51030ac3cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/filterProperty.js\":\"b347599cd306640a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/index.js\":\"46b9ead3ac88282e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5c81e815815eeff9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/applies.js\":\"f2dd9d2c1f2ef5f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/countQuery.js\":\"e341f6ebde277cb8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/expansionStore.js\":\"55f30794a5dc4095\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/index.js\":\"4cb0bdeac99d0325\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b2bc122249df209e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/presentationInvalidation.js\":\"3fb2c80afc76c7f4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyEditorOverride.js\":\"3e7126671e0fa572\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyFilter.js\":\"890eb8e3a702f092\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/query.js\":\"45c658026172c87b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/resolveFilter.js\":\"7f4c5aaea6d5a66d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sourceBatch.js\":\"1aabe2b5356822f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sources.js\":\"8dca7062fb36d4ac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useBacklinks.js\":\"f8202a6c046e6294\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9aab25a51bdc4894\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayCelebration.js\":\"121262bab54ee2d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayOverlay.js\":\"7086d6621685d68e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/gate.js\":\"7774dae11e665233\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/index.js\":\"be175c4d82d74dfe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/wolfTheme.js\":\"916b49bc86666c08\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/BlockDragLayer.js\":\"252dddaf8c5a96ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dragController.js\":\"9003c2160075f2a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dropTarget.js\":\"5321431daf83cbd2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/index.js\":\"9058106347cbbfcf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/projection.js\":\"93095ecb56561cde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/BlockMetaCard.js\":\"83cb5911a9566c92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/index.js\":\"6a16e918a0c4def0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/AddTagDialog.js\":\"2abc9abed90e0742\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"48f0efef2ae81c09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/TagNameIssueHint.js\":\"3b793ecac4d9fb94\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/addTagAction.js\":\"368d98e23cd58480\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/appendTag.js\":\"af7396e71d18e793\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/config.js\":\"8d60a2a4fb04f9a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/dataExtension.js\":\"3729cbe73fac0587\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/index.js\":\"5a14e587c07fba7f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/propertyEditorOverride.js\":\"cb8ab150211b52cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbList.js\":\"10d5e0dba539f6f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b7858d4775175eca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d5aebb86ad39c063\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"cb20b9298e58a61c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1f34135c0d4050e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/index.js\":\"06a1536e28628947\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7d4fc3705dd4aad8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/CharacterCountItem.js\":\"6b76054e5d0c7eeb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/ProfilePropertyEditor.js\":\"69907ae275590415\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/actions.js\":\"a4663b177693ab40\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/blockType.js\":\"db5d506fa160adcd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/charCount.js\":\"cfe6dadcaebe0217\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/dataExtension.js\":\"74c0daf991874941\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/index.js\":\"debdb9d15ebfdfff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/profiles.js\":\"a47404918388def9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/properties.js\":\"f83d12d9b1b78b8f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/textCounts.js\":\"08ff04f61f750020\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/colemak-keybindings/index.js\":\"b03be8081e150641\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/CommandPalette.js\":\"103dd920d0d5b237\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/HeaderItem.js\":\"ed23fe6c48909bee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/context.js\":\"9579f36679e9732f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/index.js\":\"81aa6c2671ea774a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/selection.js\":\"44b849abc8d29787\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/toggleStore.js\":\"12f7e580f9e9b1e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/useCommandPaletteActions.js\":\"b7b3d275064848e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/ContributorBadges.js\":\"a9af933d8f731b3a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/author.js\":\"6b5e2a59cd01a762\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/codeMirrorExtensions.js\":\"8be785c17c7fc271\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/dataExtension.js\":\"34fd18470603947e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/index.js\":\"ed664e0e7fba21d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/mentionAutocomplete.js\":\"470ffd429d46527f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/processor.js\":\"ffda750ac09953d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/profiles.js\":\"a13c5b5a795bca60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/queries.js\":\"3d66c66caa57d462\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/schema.js\":\"f241b6c1c36aab02\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"75beca7da7db18b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/followOrigin.js\":\"271fee0d22c9b464\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/index.js\":\"f5a7db2237addc55\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"20752eaebcf07e3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6067111904e904be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/CalendarGrid.js\":\"ae5e430c5a6df245\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DailyNotePicker.js\":\"5d8315e130752e7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3aa787cb636b02b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateNavDecorator.js\":\"8d60dcfa83f052ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateScrubOverlay.js\":\"f6c419e39ecd8405\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/HeaderItem.js\":\"991de541f6d38128\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/ReschedulePicker.js\":\"344c1729ebdc960e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a674619a66480905\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/actions.js\":\"6865f191b227fb2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/blockDateAdapter.js\":\"c02c9a5e46065ed8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/calendar.js\":\"798375bbc76644f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dailyNotes.js\":\"235d0afe538098a7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dataExtension.js\":\"fca040496a146e8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubActions.js\":\"a515c86ab1a1125c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGesture.js\":\"764c808c10257384\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a54316c1ec4f63b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubRecognizer.js\":\"62d3fd3bb1f86455\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/deletionGuard.js\":\"9f369a2bc397a627\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dueQuery.js\":\"480d4227d80f8ae8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/index.js\":\"463331704abac5d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/landing.js\":\"ca1fa5dd18d894b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/localSchema.js\":\"c4c03ce041012f65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/referenceDateAdapter.js\":\"9444b935484e02cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/rescheduleAction.js\":\"629baf678c8875b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/schema.js\":\"ca9d4ec35a882054\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadBlockDates.js\":\"b34a7f0895267b83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadDatesAction.js\":\"bc5fc2cfcaeee3f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/today.js\":\"087f9a30c2d0e575\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"70630e5497547362\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5af36cc9a2de0f46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/audit.js\":\"6b3d964e3b850903\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditAction.js\":\"4402e0d93c1b7689\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditRanges.js\":\"566d67f09b3e6fe6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/diagnosticsSource.js\":\"5debbbedeac3d452\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/divergenceScan.js\":\"7cfcff0714ea7777\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/index.js\":\"d59272fa5076b8ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3c5275ca8536a5e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/referencesMirror.js\":\"f73516d9c2f46e2b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/rowJson.js\":\"b882bb6f9d19a350\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/schedule.js\":\"662005b5f5d8ac84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/store.js\":\"d2753cdb30774238\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/action.js\":\"8f2a7f4602edf0aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/index.js\":\"22b39681d3f22679\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/plugin.js\":\"236b50c797bc6549\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0557aa7c650419ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/actions.js\":\"bf6a92276bca0ab6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/changeMarker.js\":\"5307c0c5b268dc04\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/diagnostics.js\":\"c49a89b75c459c0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/fileSystemAccess.js\":\"a4b409bb36f4a47e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/filenames.js\":\"a9f40218096e7138\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/index.js\":\"422376e33754e44e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/mirror.js\":\"6e03bc0bf854aeed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runLock.js\":\"c17dc07e3801352d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runtimeHealth.js\":\"e523c9d5c8403f8f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/schedule.js\":\"48630ab4736f2ec7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/store.js\":\"a9371867102f3afb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/index.js\":\"b668fd9fefcb0c2d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/themes.js\":\"dda2049fdcc3f4be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/facet.js\":\"5a691fd88a45a379\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/useDiagnostics.js\":\"8ed5d4df16c3edae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/dismissals.js\":\"be3e0c35fee515e4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/index.js\":\"86efc192b6188b13\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/status.js\":\"4e6b515ea7ae7221\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/store.js\":\"0741f1064e76ccc5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5a75ba1f5e967f8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9725cde11c4968ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/actions.js\":\"30ca72216a7feaf0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/config.js\":\"641238a6d74c4a6e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/dataExtension.js\":\"562c57264c014d39\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/effect.js\":\"5db4e66fec81ee14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/index.js\":\"7ba3e537ed9f0bf5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/propertyEditorOverride.js\":\"623aae9ced4833c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/useToggleTree.js\":\"62a441e094674f56\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/ExtractTypeDialog.js\":\"0307f0624a177b54\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"85ec79fa2fc77cba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/PropertyShapePicker.js\":\"52d03561cc76c022\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/action.js\":\"0a9f5dd131de74ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/index.js\":\"57ca0fbb12c742b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/FindReplaceDialog.js\":\"a30992ca288f229e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/HeaderItem.js\":\"e1c9df0ac42dc598\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/dataExtension.js\":\"c16e4165de8608d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/index.js\":\"0a17bcbbc114470c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/search.js\":\"a60fd2936e67268b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/toggleStore.js\":\"77d2b2662562a826\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/LocationPropertyEditor.js\":\"d08734ff5efafdce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/MapView.js\":\"45ea83df3dc52751\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/blockTypes.js\":\"87af5ba93a91ae82\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/codeMirrorExtensions.js\":\"040fce979bc2d172\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/createOrFindPlace.js\":\"1b02e37ff97282e4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/currentLocation.js\":\"2140603e24ce0ae7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/dataExtension.js\":\"e58363bc72b76748\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/geoContentDecorator.js\":\"dca7be0effc61f5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/googlePlacesClient.js\":\"4e5e18b97cf2c954\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/index.js\":\"7187d7105d6e053c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/locationsPage.js\":\"0dc07935f206d471\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/mapViewport.js\":\"7a42e8469690882b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/pickCurrentLocation.js\":\"5a74afa16b53a17c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeAutocomplete.js\":\"26cb3cae87f38043\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeNameCollision.js\":\"8c23318744f5a717\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/properties.js\":\"12dac46d1d9da30b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/propertyEditorOverrides.js\":\"202302e39709551c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/query.js\":\"fad7a61caa9f79e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/usePlaceSearch.js\":\"0be514422c29cd69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"23a2909171f41cce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0b0758702f83dfa3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9c87d1d01aeee84a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/config.js\":\"6ef9453fec4aa4b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/dataExtension.js\":\"8009ce6910d12bbb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/facet.js\":\"d170af7b1d12b9b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/grouping.js\":\"8f21c66d250cb3d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/index.js\":\"069383c2adf12d55\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"96905963462268b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/query.js\":\"43274224c653c39a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/resolveConfig.js\":\"7230f9934690e30c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c4f04a58683f5ab6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cab888130c3d2f11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlDocumentContent.js\":\"2084105a45cf14aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlFrame.js\":\"dd21e547213fec1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/actions.js\":\"f6669f6c6bd57f2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/blockType.js\":\"28447229d167d964\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/confirmRunScripts.js\":\"cf0a5755f16fe300\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/dataExtension.js\":\"4fb8530c65d53983\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameAnnotations.js\":\"d3164caa05a592cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameDocument.js\":\"d089110748c29c07\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameTheme.js\":\"d0d7a1f6a2cfdc79\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/index.js\":\"3f758d18a00bf190\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/scriptConsent.js\":\"491e5be876abc403\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/sourceMap.js\":\"101b70b804893f6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/useDocumentScripts.js\":\"c75f6c735bbeebec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/index.js\":\"0a675e13842b7cae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/record.js\":\"e43cff2411c82325\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/recordStore.js\":\"7d3c4307947af52b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/responsiveness.js\":\"1197e5bfe6e87d58\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/schedule.js\":\"d26bbc8911afb947\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/sessionContext.js\":\"72554ba0a41ed36f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5a6b118d72767730\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1cabb62e6a909c1b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/actions.js\":\"49e3ab262bdc94e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/config.js\":\"690da66fad162998\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/dataExtension.js\":\"288607639cf047a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/effect.js\":\"49f8322feed0ca28\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/index.js\":\"67fa7bba7eafecb1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/keyCapture.js\":\"36b7ddcb23d78464\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/overrideStore.js\":\"a9273a1ad557aaa6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d865467c1ba078bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/HeaderItem.js\":\"dbebce5372842f6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/LeftSidebar.js\":\"c084859eb786b907\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/actions.js\":\"b1fcbf8167889ef4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/facet.js\":\"3d850eb1d9979657\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/index.js\":\"f13e38727212df21\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/shortcuts.js\":\"360bdc69747ada68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/toggleStore.js\":\"848b41430256b48e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/MergePicker.js\":\"f85b03de6592492d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/index.js\":\"da826efdf466dcf3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/mergeAction.js\":\"553ab7895e9799f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/strategy.js\":\"5e72b01770bf4d34\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/Button.js\":\"45b701cc39e96e0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5fe4e779366faa2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/defaultItems.js\":\"abf0c7d2a762154b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/facet.js\":\"0aba9170453fdb65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/index.js\":\"21829ddc9bd32e99\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"bd7fda0a7238e014\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/actions.js\":\"feada16f2687a3d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e5012e81dde37895\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/facet.js\":\"48ce4d49a12ca946\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/index.js\":\"0abb35676d6e140a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/MoveDestinationPicker.js\":\"8eb3da8f2f456273\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b11a16daacd92f60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/contextMenuItem.js\":\"b25a6d11441095a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/index.js\":\"b420c23deac12aa9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveAction.js\":\"96ef6866d90aeaf0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveBlocks.js\":\"2e2a74e89033b111\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/selectionAfterMove.js\":\"e90bfcdd1f1a45e4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/TutorialBanner.js\":\"554be89c4a141cd1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/action.js\":\"aa1ac5a6a7a8a506\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/bannerDismissal.js\":\"f405123a0ec742e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/documents/cheatSheet.js\":\"37232465f10e0822\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/index.js\":\"07621b1ed8da8708\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/keys.js\":\"ea4bc70dec03f7b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/landing.js\":\"7f5db15454160a62\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/outline.js\":\"755f8a621d3bec11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/seed.js\":\"541a851bd5eeea0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a603118fa9b059fb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/analyze.js\":\"8ce9b34cead291cc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/diagnosticsSource.js\":\"9c275baa69a69689\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/index.js\":\"a4ecf794bc2bcbed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/load.js\":\"3aa6f4b2b9053300\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/monitorRun.js\":\"bd298e39009a765e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/schedule.js\":\"2552ce9c0aff312f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/series.js\":\"0ff3debec479821a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/store.js\":\"2cd488fe4b44aee5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/trendAction.js\":\"5ded2664cbb3fd86\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/verdict.js\":\"a844a1d6d29c9190\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/clickToEditAction.js\":\"d98c9b00c021ad62\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/index.js\":\"94ea5e9d2deb670f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/interactions.js\":\"a143176e4e75243d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0546a4b10885b03b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGate.js\":\"8c37300c938aec8d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGateDialog.js\":\"fc15195873fa40ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/action.js\":\"4ff62efe0ec58fe6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/index.js\":\"b0f7e2f8a3193657\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/localRunMessage.js\":\"cfe5485caf8a0a32\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/plugin.js\":\"1e76b9c39b424d78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/progressReport.js\":\"bd317ba49d114a99\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/sweepProgress.js\":\"0f334b42ec097f33\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/FieldRowRenderer.js\":\"67f5eb2e944a3e0f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/ValueRowRenderer.js\":\"d76c67e1c0264cda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/actions.js\":\"0d72800756ac812f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/autocomplete.js\":\"65040f0c6ebf0151\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/fieldRow.js\":\"4b5cc6c5eed4d6c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/index.js\":\"93c6c81a3968658c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/referenceWarning.js\":\"acb46430c52fd18f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueAutocomplete.js\":\"5e827c9af74da35b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueSchema.js\":\"687aa72b333e6e9a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/HeaderItem.js\":\"42673811966847e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/QuickFind.js\":\"6b8e0c7d718bad3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/index.js\":\"3e9b43822bcfa395\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/recents.js\":\"36a5caec8012a773\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/resultItems.js\":\"7f3c4fda322a059f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/selection.js\":\"76252b76db1c1220\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/toggleStore.js\":\"cb1f00980ce48631\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/HeaderItem.js\":\"cc633260908c7192\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cd26c27c14896b73\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/grouping.js\":\"b8309ec1353a0e24\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/index.js\":\"cfd7cd304aa9b544\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/target.js\":\"0f6d3b43c1f89059\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/codeMirrorExtensions.js\":\"d58c08f181e54033\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/contentPrefill.js\":\"a234e9dead52dd66\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/dataExtension.js\":\"92e963fad2512978\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/index.js\":\"9eadad048d97ba9d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a6f277bca0d5df1e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/invalidation.js\":\"18a0f374f2c21ed5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/localSchema.js\":\"946065cf28cd3bc7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/index.js\":\"6c54c4e95d37cf3b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e5f90bf37a0ad2b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/index.js\":\"e7ec92c833ec68c7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/referenceNode.js\":\"945f40530d4e81c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d8537d0f7143daa9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"809f07455c310d14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/index.js\":\"c7d2f8e15b108529\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0e31168f95fb20bb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"17fa80c2cc1a660d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/mergeRetargetProcessor.js\":\"85ea80b8e8822646\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/parseFence.js\":\"dcf07e4ff79d77aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceParser.js\":\"78eabb806a931b9f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceProjection.js\":\"1983f3bc63d6d470\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referencesProcessor.js\":\"be29eeb60d26f5fd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/renameProcessor.js\":\"097c0d000f1ffcde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/spanReplacement.js\":\"568409cef15aa2c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/htmlToOutline.js\":\"77ed25563d3abca9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/index.js\":\"d22b54a62b655d7d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/normalizeClipboardDom.js\":\"42864a94c750e99d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/pasteDecision.js\":\"d0fda0348f32af49\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/action.js\":\"06de95b641b287c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/blockIds.js\":\"a585cca766e9f6c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/content.js\":\"d06a337177c676ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/effect.js\":\"4b590b8bd04a74e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/ids.js\":\"2c328f83fde638ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/import.js\":\"ca81761e9d38e2d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/index.js\":\"2ea2b434cf81ca87\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plan.js\":\"1b334dc3409197a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plugin.js\":\"7ee4d2129c252574\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/promotion.js\":\"8a7dcdb860cfce70\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/properties.js\":\"bbe528cf9f7720b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/references.js\":\"19bf5f2980a2d6a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/report.js\":\"3adca0a1f8bd70f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/roamMemo.js\":\"c7ff6545c4995023\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/runtime.js\":\"11dd9af784daf857\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/schemaReconciliation.js\":\"6220dc0a9ed2c868\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/srsMarkers.js\":\"19128a74f5c8ffdc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/todo.js\":\"c66ad23eba96a7d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/typeCandidates.js\":\"a15c6969b73c5c89\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/types.js\":\"8459b8481c5f39cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/index.js\":\"00d14c0fc3c89414\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/store.js\":\"9d1a1546a1d1052f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/HeaderItem.js\":\"7b22b25d409c797d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a9c4e17c8f714a50\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/index.js\":\"5cd7a95977cf62b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/model.js\":\"4edb556a7b9fd920\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/toggleStore.js\":\"eefddccc2d59efaa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/useKeyInspector.js\":\"495befc2a583d19a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e452f76c9bace5b1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/ShellDecorator.js\":\"097e06ff180128ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/actions.js\":\"ea5711525e66a006\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/exclusionsFacet.js\":\"665ec7dfea49d1c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/index.js\":\"3d41613835e3b81c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/shell.js\":\"58391557c835fca2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/surface.js\":\"d3c7a083b464206d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/walker.js\":\"d7c7ab2c938d5875\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4265f34bc9974a2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/dataExtension.js\":\"32216086e51e675e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/index.js\":\"c00082e6d4d5f013\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/indicator.js\":\"02df47e24430e766\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/moveSrsState.js\":\"8e605905ec7ea7c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b7ab77621de3469d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/scheduler.js\":\"f7409c7d87819b30\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/schema.js\":\"568355663758dd67\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d871bd1b1e8d703a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsClipboard.js\":\"1e82016da51e0980\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f6c2c09dd4ccf6b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7ac3ce729b73a8c5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DeckPicker.js\":\"aa0c666fb4cd8f79\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewControls.js\":\"fc35e65b4d64e1df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9efd46a818b7908a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewSession.js\":\"d60753219d4b881b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/actions.js\":\"0f868c0294b828f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/archive.js\":\"4be8204414cba011\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dataExtension.js\":\"e7edf943260f1c9f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/deck.js\":\"c5e6d2dd8b46fa29\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dueQuery.js\":\"095c64323f911ca2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/gradeDecision.js\":\"ffdee75640294800\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/index.js\":\"15634858eb160cee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/keyHints.js\":\"cacf3b5e32d3211b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewCardLayout.js\":\"7d9262b1990d4ab8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewProgress.js\":\"ca2d800c5b2f66dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/schema.js\":\"a3e46bf2a519adf3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/useDueCards.js\":\"60837f65782f8281\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/index.js\":\"0fb27b18f831d1ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/record.js\":\"ab6255f303ed4258\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/index.js\":\"3968e2b003c9a544\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/persistenceStatus.js\":\"ddfddf86f49c68a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/requestAction.js\":\"c2e6b21fe473cb79\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/TypeChipsDecorator.js\":\"4ef821c44ed63415\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/codeMirrorExtensions.js\":\"b20827a07cea046c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/index.js\":\"cbc2f7333c25208e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/typeAutocomplete.js\":\"64cff18981608725\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a364151fc186ca79\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/actions.js\":\"b845de65831ccfeb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/anchor.js\":\"beab66aed796beb2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/events.js\":\"ebf90e2e07f3dae4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/gestureActions.js\":\"2b54150d55076796\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/index.js\":\"b9c890ed97879cb9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f5668597401cc699\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/collect.js\":\"c58fbbcc728cb810\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/index.js\":\"dbaf65b4f973f898\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/record.js\":\"12c757ee46f61789\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/RejectionDialog.js\":\"918b888a09cce4cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6979a2f44a5bc847\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/index.js\":\"d9577eee4e6291c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/model.js\":\"2cdab0d4b2af4c7a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/queueCounts.js\":\"eb8d204092c01b78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rejectedHelpers.js\":\"931683b55d12738c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rematerializeAction.js\":\"7ec8332240875dcb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/useHysteresis.js\":\"2684150917ea4cee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/effect.js\":\"38f69d714b9c372a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/index.js\":\"39c44d04feeb44ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/theme.js\":\"d6cdc60f44776f29\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/actions.js\":\"0b244ee4df0df459\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/dataExtension.js\":\"7aa1398aef1ca241\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/index.js\":\"7de347c41820c97d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/schema.js\":\"b045960fa7fe52a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4846df12f1f77fb6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/actions.js\":\"376b5b8404cbe519\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/defaultItems.js\":\"deaa6da2324386d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/facet.js\":\"cf7ae75f362877a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/holdRecognizer.js\":\"d1125e7d0e0e1196\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/index.js\":\"f8c93d465d71b355\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/UpdateIndicator.js\":\"666f9c9057f48519\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/index.js\":\"20f5a594cd74b300\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/loadTimes.js\":\"a0f1806f64f4b2f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoNotesRenderer.js\":\"2cc3cefc9aa77b02\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoPlayerRenderer.js\":\"683c8f5aa9f60948\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoTimeStamp.js\":\"3fa1b32137347bf1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/actions.js\":\"1c17bfe5efe30e8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/index.js\":\"255a886f89cd108b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/markdown.js\":\"f7f267bf33628df9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/notes.js\":\"05209a1145e38a69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/registry.js\":\"fb513b5d4eadd487\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/remark-timestamps.js\":\"457f4aa2cc53e05d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/view.js\":\"17c6c32e0b9eecc4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/LinkHints.js\":\"dde0c7d2515f85c7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/index.js\":\"2aa000ec30ec27ce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/model.js\":\"8e48edaf9f3a9a68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/settings.js\":\"e1ad77a6cb5c737f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/actions.js\":\"45be090a923a6c48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/index.js\":\"15e37608dacfbf44\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/interactions.js\":\"4fa3d43e57ff2164\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/workspace-header/index.js\":\"f1a92c7f34e1dd80\",\"/knowledge-medium/pr-preview/pr-1788/src/registerServiceWorker.js\":\"b9dbaebef8608c3b\",\"/knowledge-medium/pr-preview/pr-1788/src/requestPersistentStorage.js\":\"420be070b67d0625\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authRequestDeadline.js\":\"62ec1f04c4ccc307\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authStorage.js\":\"9b425f6da6d7f117\",\"/knowledge-medium/pr-preview/pr-1788/src/services/powersync.js\":\"f07df63095d4ca4b\",\"/knowledge-medium/pr-preview/pr-1788/src/services/supabase.js\":\"a1c7264f5f621823\",\"/knowledge-medium/pr-preview/pr-1788/src/services/uploadErrorClassifier.js\":\"04673c943c70abbe\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/ActiveContexts.js\":\"a83218484a7b3e0c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/HotkeyReconciler.js\":\"cd1f287fb25a55d6\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/WipeLocalDataDialog.js\":\"c7e3f2246e97b63e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionDispatch.js\":\"f6957b05159b7112\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionRefItems.js\":\"4ea3ba3977ae7fdc\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/applyKeybindingOverrides.js\":\"2c43ec45200638fc\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/blockActions.js\":\"708d11f12aab11e2\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/canonicalizeChord.js\":\"8f94e821be4a1885\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultContexts.js\":\"d21ba4b4fdf38c65\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultShortcuts.js\":\"859b43e5709ba79d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/effectiveActions.js\":\"c4d0d9e589107941\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureAction.js\":\"222c1a447f42afb8\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureBinding.js\":\"74862335a0bb6c3e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/holdRegistry.js\":\"9de9f70e04b43aef\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingConflicts.js\":\"a0917a2affdd5ed3\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingOverrides.js\":\"d6f47ce6adcf5a3b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/pointerAction.js\":\"2319a665dc8c5ad9\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/resolve.js\":\"318cc7f3ec76e316\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/runAction.js\":\"30980a0c70a02787\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/sequenceMatcher.js\":\"4735ee3a3b104e1c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/types.js\":\"2a45bd552b5a163c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionContext.js\":\"d9be1f5c13e0e320\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionDiscovery.js\":\"22c0611e62528992\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/utils.js\":\"7adc10212b531702\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/bootStore.js\":\"3c1f840d5f9c77b5\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/previewDatabases.js\":\"08f8c31622e4df62\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/byteTransform.js\":\"40970d1c563864d1\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/attachmentCleaner.js\":\"9d64473a4251d46b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/attachmentParts.js\":\"514e3e82bc53fe82\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleParts.js\":\"10be435637666191\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleRecord.js\":\"b22c7ebd6256f27e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/manifest.js\":\"a11cca066af106a9\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/takeBundle.js\":\"f880c555d7141345\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/verifyBundle.js\":\"07bd1c01d1ab240d\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/cleaningStage.js\":\"c831d792bc5eb1f0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionKey.js\":\"c515c5d28181ee2c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionServer.js\":\"902da8b79af294f7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flip.js\":\"ea20d6c62c93924d\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flipAttempts.js\":\"3391f2375dd4cdf7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/pages.js\":\"38a98b4505bc624b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/preflight.js\":\"b1144f1e05872399\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/reseal.js\":\"b2a0d0ac64110a28\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runConversion.js\":\"40bf634dd4883c5a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runLock.js\":\"b3a384faac842d46\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealing.js\":\"a117e70813361fbb\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealingStage.js\":\"d70ae9c493f5bee3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/stage.js\":\"a696571bce9485c5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/verifyReseal.js\":\"ed8312c5f8e55657\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aad.js\":\"9a4aa1cfc01bc8b8\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aead.js\":\"01574b05a69441a6\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base32.js\":\"2a1c5f958b3c65f6\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base64url.js\":\"a6f20d4c49e34886\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/binaryEnvelope.js\":\"94870da4cc8a4c6a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/byteAead.js\":\"a4ab42f001b5c5c3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/canary.js\":\"f033f40e05701b24\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentHash.js\":\"c1eb9eaac6053019\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentKey.js\":\"867ab033feb57be0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/derivedIdNamespace.js\":\"9dbb549809a62459\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/envelope.js\":\"62edc3e9467bde7b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/hex.js\":\"458664df4ad7fdcd\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/sha256Hex.js\":\"3a01ba898c41449c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/workspaceKey.js\":\"2973a44de2432b2b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/conversionState.js\":\"b4c014e263069ddf\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/createEncryptedWorkspace.js\":\"30bc94f9c5d3f45b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/pastedKey.js\":\"9a95715d5a057244\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c434ff3d808088a1\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/upgradeWorkspacePin.js\":\"62fcd886c8cdaa40\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/keyStore.js\":\"894f51063a9d5687\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/mintWorkspaceKey.js\":\"211721077360c89e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/modePin.js\":\"a35a65c21e8dc191\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/openWorkspaceKeys.js\":\"0e55cb92b00fa3ef\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolveWorkspaceEntry.js\":\"ee8a00f73a760b43\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolver.js\":\"3aeef3495e870c0a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/workspaceAccess.js\":\"bc4e5795dafd22e7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/transform.js\":\"ac66f0422764a0cc\",\"/knowledge-medium/pr-preview/pr-1788/src/themeBootDefaults.js\":\"a5e8e48a5d35ce22\",\"/knowledge-medium/pr-preview/pr-1788/src/types.js\":\"94056751e4458925\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/ClientLocalSettings.js\":\"4dbce9c40b0c885b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/abortableSleep.js\":\"50ee577b228802a0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/array.js\":\"8d7085e450d12e1f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/backlinkAutocomplete.js\":\"15a8feed4ff3a5a6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockCrumbs.js\":\"ece70d11b0b44ff8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockrefAutocomplete.js\":\"5f92ff9d60f7bb8a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/cadencedIdleJob.js\":\"0b52f641eb831626\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/callbackSet.js\":\"fc6051144c7e7a85\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/clientId.js\":\"a7b0cf3498aea68b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirror.js\":\"7b7f4bb2b1bff829\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirrorCompletion.js\":\"369ea9b460242611\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/copy.js\":\"6dd49c08413a026a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dailyPage.js\":\"53da7b7be33e23fb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensics.js\":\"02ae6f6d6ce9562f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensicsHooks.js\":\"c45867254cbfbfeb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/deleteBlockThroughUi.js\":\"d2aa81188276c5f5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dialogs.js\":\"66499839e75fa263\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dom.js\":\"4ee3c776d87f8555\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/downloadBlob.js\":\"8ef870d8341a1308\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/exportSqliteDb.js\":\"211ca372edaad7f9\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fileSystemAccess.js\":\"286191b132207ae8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/flipSlide.js\":\"b5510bb540fc23af\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fnv1a.js\":\"5f873f07a5e1cdac\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/formatBytes.js\":\"646a5bd7a4e0a183\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fuzzyRank.js\":\"c580dead2acff9a2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idbKeyedStore.js\":\"8a9d93fa40c171a5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idleCallbackPolyfill.js\":\"a2759cd495c77cc7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardAwareScroll.js\":\"ccd0bbf5dd1c7758\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardViewport.js\":\"003dd5a69a12522e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/lastWorkspace.js\":\"1d1d115df1145a23\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutColumns.js\":\"1ec0786c6868e15f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionDom.js\":\"71a7abaa008e448d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionId.js\":\"0c55e8125872689f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkClickGestures.js\":\"874e159f76ae1492\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkTargetAutocomplete.js\":\"34acc7b2e0978f45\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbCorruption.js\":\"6406bf76ef82ccf9\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbRecovery.js\":\"2844ad2a5d0636c2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/markdownParser.js\":\"8c96aaec525e317c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/memoize.js\":\"4f522e3ae51c4d97\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameFieldCommit.js\":\"9c750aac3fd4a7ed\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameList.js\":\"0e5a342164d6fe43\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/navigation.js\":\"f2f7c02297cb1177\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/omnilinerNamespace.js\":\"fd8e1e1785545b93\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/opfsPageScan.js\":\"868ec8b7a1d4c430\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelClearance.js\":\"742d555a51cf85a7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelHistory.js\":\"ac79b9f247b7bb6d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLanes.js\":\"1514f1c02703d1f0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLayoutProjection.js\":\"23163341617b6f4a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelScrollAnchor.js\":\"1b5dce9d1e616af3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelUrlFlags.js\":\"059c6ccd2cdc24db\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/platform.js\":\"d1f8fe62af9cc000\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/pluralize.js\":\"4e1fd066a58f2dd3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyCreation.js\":\"63e6fe42423e8652\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyNavigation.js\":\"a65eb08fbb13554e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyValueContext.js\":\"69b594fbb64041e1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/react.js\":\"cc328d89002c1ccc\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeDate.js\":\"112fe27a173384a8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeTime.js\":\"1d72564d49485219\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/renderScope.js\":\"77cf5376f18b15c7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/resolvedThenable.js\":\"b8f03e3cf50629ad\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/routing.js\":\"f9bcfcbcf420da89\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/safeMode.js\":\"ee40c662b11743df\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/scheduleIdle.js\":\"1f005893ad7786be\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/screenWakeLock.js\":\"ea6359f29e77467c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/selection.js\":\"418d763656dae424\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/softKeyboardGrab.js\":\"f017d3e3f2ca3e47\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/startupTimeline.js\":\"72b3920059b18a1e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/state.js\":\"cc78c03ecf407b84\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/string.js\":\"594cd21dbed95d11\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/surfaceZoom.js\":\"e531e1ab4ef1e332\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/time.js\":\"48702ca7efc18085\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toast.js\":\"7b1718f6346a6047\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toggleStore.js\":\"a14c1132b6115907\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/untilStopped.js\":\"ece8bf6bcaf1e33e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/userActivity.js\":\"5161cd956a6ace4f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewTransition.js\":\"5bfa045174bdbe1b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewport.js\":\"94ff1f2fd591f91d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/webLock.js\":\"97631f1682595ba7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceRecovery.js\":\"7db171680bd629f5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceSnapshotStore.js\":\"8b256b26e5e916dd\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-compiler-runtime.js\":\"c2afdf4393660c1d\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-client.js\":\"7936d041d61f9ddc\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server-edge.js\":\"43c05b71b2eb03bb\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server.js\":\"f9d9907e62ae4572\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static-edge.js\":\"e73fe146c0f9221f\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static.js\":\"8fd0ffe4203e5245\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-test-utils.js\":\"e2087e4429e6173e\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom.js\":\"9759cd5a3975e5fc\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-runtime.js\":\"65ed236bd58054c4\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react.js\":\"a001f48b9609c9a3\",\"/knowledge-medium/pr-preview/pr-1788/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
