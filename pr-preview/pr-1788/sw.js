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
		buildId: "66d20ca73965-cb7f00b5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/\":\"9879b1c6c1a02784\",\"/knowledge-medium/pr-preview/pr-1788/index.html\":\"9879b1c6c1a02784\",\"/knowledge-medium/pr-preview/pr-1788/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1788/assets/FacadeVFS-ZCRGUJFE.js\":\"df97fb4891d87120\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSCoopSyncVFS-DFvj2ptq.js\":\"e07dc91ded818d1b\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSWriteAheadVFS-CBn5jnWO.js\":\"90d72333506619de\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-VHim_sjG.js\":\"3ee607d1115fdbcf\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-D5y5E6Iu.js\":\"5530d0155c73c11e\",\"/knowledge-medium/pr-preview/pr-1788/assets/worker-CQ3oMEyB.js\":\"fd4e74c127fa613d\",\"/knowledge-medium/pr-preview/pr-1788/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1788/chunks/app-BcMqEN88.js\":\"6fb9b7a037915f77\",\"/knowledge-medium/pr-preview/pr-1788/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1788/index.js\":\"1f5961bafe7bc80e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1788/assets/AccessHandlePoolVFS-BIZFShHd.js\":\"40163fd2584d781c\",\"/knowledge-medium/pr-preview/pr-1788/assets/IDBBatchAtomicVFS-CIfB4ukQ.js\":\"b7a76d7f99c5831b\",\"/knowledge-medium/pr-preview/pr-1788/assets/MemoryVFS-PEM6NHw2.js\":\"5805389859240a11\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-ChWoBi98.js\":\"0f3d89b51a9ad7bc\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-BYnt30z1.js\":\"9f91e98210bd7325\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1788/chunks/AccessHandlePoolVFS-DZUOE3wp.js\":\"1c135e7c12501c2d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/FacadeVFS-BLNgvjXP.js\":\"9313c392fd6882be\",\"/knowledge-medium/pr-preview/pr-1788/chunks/IDBBatchAtomicVFS-DBiwojrI.js\":\"95d46b1ed0e6a04c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/MemoryVFS-C_qIi08E.js\":\"6e5d4c2ec1ac0054\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSCoopSyncVFS-MwIKQcKl.js\":\"a736ec0eb68fddd0\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSWriteAheadVFS-c2HrWEnq.js\":\"1e685499926955ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/Preview-Da16PZLU.js\":\"5b107b56b891ccc7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/card-gwER3jwN.js\":\"db8740bd5f9e44f8\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-nYxsTYOX.js\":\"7e376f07d6eab403\",\"/knowledge-medium/pr-preview/pr-1788/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-EWeEnxiQ.js\":\"fb839221759d27ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-async-ClyGc1Gt.js\":\"fb2c0ba9129c2673\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-BDys17v4.js\":\"cf80a9ddcf0d994c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-C2oHKHlt.js\":\"150471eb31912b5c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-CAYVAakP.js\":\"be034a30db18788e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-D5BXGpe3.js\":\"77d8844f4839b3d3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-G6_YOJpO.js\":\"2ad3c2bf32a296d2\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-JtVfzIiQ.js\":\"8fdc0158d973d522\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-UXufdwws.js\":\"3f0b230a19d02c8b\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server-legacy.browser.production-DzK4Ig_6.js\":\"56a3cb9034b8b233\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.browser.production-CKLnNko1.js\":\"2ba482eaecc0e35d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.edge.production-CUnNsWSJ.js\":\"cb2731ba7080ebdd\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-jGWEmhdQ.js\":\"ff315f512a00a6ac\",\"/knowledge-medium/pr-preview/pr-1788/chunks/server.browser-BJg7ZSnX.js\":\"d2a0d00e8db6c329\",\"/knowledge-medium/pr-preview/pr-1788/chunks/textarea-CmlTNF0N.js\":\"2b6825292b2026fc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/ui-CwGRvYqe.js\":\"3a27b4c48e57ac0d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-Cj1mtf1Z.js\":\"f22f4b8886f436e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-async-CKwLWy84.js\":\"b47819fb8f3df2c7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1788/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/src/App.js\":\"3bcb12eefe45cd42\",\"/knowledge-medium/pr-preview/pr-1788/src/appUpdate.js\":\"50ab17cae4aee0d0\",\"/knowledge-medium/pr-preview/pr-1788/src/appVersion.js\":\"8a5d4bad4a1fd2c6\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/initialLayout.js\":\"69404ec2db41b225\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/openWorkspaceData.js\":\"dfec7857fe8274fe\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/resolveWorkspace.js\":\"e1add18430c2991b\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/workspaceBootstrap.js\":\"f2b8afcdba2348bc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockComponent.js\":\"92900a597455fbd1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockCrumbs.js\":\"64a77ea1b2f50e7c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockEditor.js\":\"edc732d7b4b33791\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockLoadingPlaceholder.js\":\"56fe961b3cef9e33\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockProperties.js\":\"b07b32403f114ea1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockSearchPicker.js\":\"e3c359c11838eaf4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ConfirmBulkDeleteDialog.js\":\"07f88817b801a251\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DividerHandle.js\":\"7ffc54a94cd10b43\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DraftEditor.js\":\"64f8510f77db1b46\",\"/knowledge-medium/pr-preview/pr-1788/src/components/GutterPill.js\":\"600ec35f2dc51e33\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Header.js\":\"477947aeedaa517d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/LazyBlockComponent.js\":\"3a1926884027c9a4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Login.js\":\"eae9bb29a2267485\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ZoomableSurface.js\":\"ca51a23fc62295ec\",\"/knowledge-medium/pr-preview/pr-1788/src/components/editModeKeepalive.js\":\"b7056f771922120c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0348168ba0bb6bf9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"31358b1fdfccbb0c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefPropertyEditor.js\":\"b9aeb6ae034e52e8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefTargetTypePicker.js\":\"1ee6f38a32205dba\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/SelectPropertyEditor.js\":\"c2535eb5d2d93757\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/TypesPropertyEditor.js\":\"bac3f273ae7ee59a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/defaults.js\":\"6bcd90e05922a170\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/kernelValuePresets.js\":\"82934354cbfb2c13\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/selectablePresets.js\":\"9ff759a82259b389\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/typesPropertyUi.js\":\"f97d406704b02a11\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/AddPropertyForm.js\":\"7580067ba9c93a5b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyPicker.js\":\"2151b502ebad4381\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyRow.js\":\"76fcdc2599ddc667\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/Rows.js\":\"35f782a66687a7d0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/actions.js\":\"9049a624ab29a1b2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/declarationOnly.js\":\"38d4bdb6e66ce1c5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/layout.js\":\"bd7d2299b5faedd6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/model.js\":\"18fb205fbc8cd06b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapeUi.js\":\"4c27da26ff3ec38a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapes.js\":\"ce3fb48ff0f83aca\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a074d866bc06df5a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/visibility.js\":\"de2462b01361752e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanelSections.js\":\"2ae3e21be54c7645\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockEmbed.js\":\"26180c3df19cd41b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockLink.js\":\"ad37f45e15629840\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockRef.js\":\"f5b1dde2a7717a3c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/ReferenceLink.js\":\"cbdadba37a7fe783\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuard.js\":\"e84cc2519b25465c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuardContext.js\":\"37403c3061858b7f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/linkInteraction.js\":\"abadf7a99f4605ab\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/referenceLayout.js\":\"21062c42d7c602ed\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/useBlockRefAncestors.js\":\"6302ceee8a79a165\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockGutter.js\":\"8ef9227659000f99\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockInfoDialog.js\":\"33ff2c837a3e44ee\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockTypeBlockRenderer.js\":\"56499db0502423d1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BulletHoverCard.js\":\"f087adf967c22235\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorContentRenderer.js\":\"e9048b860a55e0d3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"083027645fb770dc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ColumnResizeHandles.js\":\"b79f5e7f301eade1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f158917417e7d535\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/DefaultBlockRenderer.js\":\"663f49d2fb9914c9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/LayoutRenderer.js\":\"ed1a92a86b7bd69e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MarkdownContentRenderer.js\":\"7621bd541036a0bc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MissingDataRenderer.js\":\"c7992ca5a372b132\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PanelRenderer.js\":\"6d1896da289049ee\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f54e5df29832cede\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/TopLevelRenderer.js\":\"75e547324f77dc34\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockGutterMode.js\":\"dbc3b9478d8c8049\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockTitleText.js\":\"4f8373ae8457e89c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/fieldCreationKeydown.js\":\"c166bea213f1f5a9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/layoutRootContext.js\":\"86dd8ea1080834a0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/TypeChip.js\":\"7f93b8b62effcaaf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/chipStyle.js\":\"76578ea2138be9d9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/anchored-floating.js\":\"68bf8fc733f3fe3d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/button.js\":\"19bc63e19ba698a1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/card.js\":\"3106df979f34d744\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/checkbox.js\":\"09a9694322971413\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/collapsible.js\":\"3faaa26b9b99b093\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/command.js\":\"06ef1bafb615820c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/context-menu.js\":\"af03f2204e98371d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dialog.js\":\"8f24bd7ca59579f2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dropdown-menu.js\":\"f4b1e3fa9893ef77\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/floating-listbox.js\":\"76fb766b0610b16e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/index.js\":\"87e503ea555952fd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/input.js\":\"8da96afd981779b4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/kbd.js\":\"e1c92180b34cd962\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/label.js\":\"99e324c562026023\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/textarea.js\":\"c758577940042300\",\"/knowledge-medium/pr-preview/pr-1788/src/components/useEditModeYieldKeepalive.js\":\"36314c0f6f0a41d1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/BootFallback.js\":\"f2b5431650b896a3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/FocusedRowLazyMount.js\":\"c2f932f285d80702\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LazyViewportMount.js\":\"b336434b6a173ae8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LocalDbCorruptionFallback.js\":\"d04185ae74b808d4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/error.js\":\"9ef630230b3a13a9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/lazyMountRegistry.js\":\"54714e61f11f6007\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/suspense.js\":\"f3ae5b80dc5bb714\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/CreateWorkspaceDialog.js\":\"a6a2b9121847d3a9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/PendingInvitations.js\":\"5e42adb094b933f9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/SyncProgress.js\":\"9385b02252857288\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/UnlockProgress.js\":\"e5a25bf918fe3c91\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceKeyGate.js\":\"5e2bcd0c1a938167\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSettingsDialog.js\":\"80588327cc36f277\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSwitcher.js\":\"3e90cbe36829b46b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSyncGate.js\":\"5cd5d66071c932b1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlow.js\":\"b52738ef4c64a8b6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlowHost.js\":\"fdf821e5146066c9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/EncryptionSection.js\":\"4832524fe4a01b40\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/attachmentPrompts.js\":\"8abd04411a01d0db\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9358ff8554a874dc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowDeps.js\":\"bce8543a9f18375b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowStore.js\":\"d7e6f6c0f89231a7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/flowUi.js\":\"d4644da0b6bb95f2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/useConversionRun.js\":\"e259e02a2929bfa2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/keyUi.js\":\"dba0a2b25ab5c340\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnKeyLoss.js\":\"7a243b0c8cd900f2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnServerE2ee.js\":\"b478d3fb71ca66b7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/workspaceUnlocked.js\":\"71049b52fdab7f38\",\"/knowledge-medium/pr-preview/pr-1788/src/context/backgroundSubtree.js\":\"56825618205e5f0c\",\"/knowledge-medium/pr-preview/pr-1788/src/context/block.js\":\"e92d78ec4b8550e4\",\"/knowledge-medium/pr-preview/pr-1788/src/context/layoutWsContext.js\":\"ca3eebf3b9169ea0\",\"/knowledge-medium/pr-preview/pr-1788/src/context/propertyDisplay.js\":\"f2763f2cabc7fa2a\",\"/knowledge-medium/pr-preview/pr-1788/src/context/repo.js\":\"f8921ea74be9b5ca\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasClaim.js\":\"312eaac3f38073f1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasSeatNamespace.js\":\"d87d33dd94eff4c9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockData.js\":\"36b8fe1577b53842\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockType.js\":\"59a7d3f8dabfcb7f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/changeScope.js\":\"071edf715229ab01\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/codecs.js\":\"a5ad8afa843ef0cf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/derivedData.js\":\"542636a80d785747\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/errors.js\":\"ed5cdeaa9f7ee630\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/events.js\":\"93144b03c98f9de2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/handle.js\":\"763a272453446fa2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/index.js\":\"49038205174d0142\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/mutator.js\":\"05327719a58e1424\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/processor.js\":\"b8eb9ac6bcc0e675\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/propertySchema.js\":\"8256a6a80e0e276d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/query.js\":\"927530d1314affb3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/sameTxProcessor.js\":\"0f077d3a83544de9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/schema.js\":\"763a272453446fa2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/tx.js\":\"763a272453446fa2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/typedBlockQuery.js\":\"2595aacb3f9696f0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/user.js\":\"d2c475e812115774\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresetCore.js\":\"2925d701e2d01193\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresets.js\":\"a4c0f2f6cf346f13\",\"/knowledge-medium/pr-preview/pr-1788/src/data/attachmentCleanerIOVerb.js\":\"4dea782ecc0e361e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/block.js\":\"293e4be686925b8a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockCache.js\":\"01cb933f083c2950\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockId.js\":\"602b2d948f2ba018\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockLiveness.js\":\"23eb380d20ab070e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockMerge.js\":\"5be54819621330a8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockSchema.js\":\"f82294b085ccec61\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockTypes.js\":\"61220412650c03c8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/clientContext.js\":\"d4f82f05f1041b69\",\"/knowledge-medium/pr-preview/pr-1788/src/data/dbFileSiblings.js\":\"55893494597993a3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/definitionSeeds.js\":\"87510b1898a77f1c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/derivedIds.js\":\"59c83dafbdd2ea55\",\"/knowledge-medium/pr-preview/pr-1788/src/data/drawnSubtree.js\":\"0a07d8557102185c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facetBridge.js\":\"65b6345701212944\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facets.js\":\"d281c675a642fad0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/globalState.js\":\"ffa037faf3827fe8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/aliasClaimRederiveProcessor.js\":\"d48ea47561203ed5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/ancestorBatch.js\":\"2ecd91ca87cf5b49\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/blockTypeTypeifyProcessor.js\":\"1ce58e07a356515f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/clientSchema.js\":\"1b21682a24bfbd3f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/commitPipeline.js\":\"57c472b113112549\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/devAssertions.js\":\"b3b3765c14ce10cb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/firstSync.js\":\"16297d5b8facd62b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/freshInitialLoad.js\":\"ddf23656a03bc706\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/graphBackfillClaim.js\":\"9efcff1f5cac8b09\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/handleStore.js\":\"19f5193bd84b3c88\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/idleMarkerJobs.js\":\"1abadc960d0fb30f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initialDownload.js\":\"b99dc4055e9eae4e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initializeClientDatabase.js\":\"7a4d085bf25bc9b0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/jsonCanonical.js\":\"b603ee59925e377f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelInvalidation.js\":\"abb9fd38d2f15731\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelProcessors.js\":\"2f422f86014fe1d0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelQueries.js\":\"763bf6b5b7b494a1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/mergeTypeMembershipProcessor.js\":\"0f2842ca39319b22\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/normalizeReferencesProcessor.js\":\"526e59f9d6cffab7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/poolInstrumentation.js\":\"f256983829be5c63\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/processorRunner.js\":\"6dd09fc85f63b510\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCellBackfill.js\":\"d9d05500f7133621\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildMint.js\":\"3a3a9ede36f9c3b6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildrenProcessor.js\":\"19ea51acd5c89b17\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionChangeProcessor.js\":\"63298cc46382d301\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionSynthesis.js\":\"77fcaf1686ece393\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyKeyScan.js\":\"acc77cbe59619f48\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertySchemaResolution.js\":\"3836bd53bee9db0f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyValueEdits.js\":\"b85ef7602b774cc3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/raiseProtocol.js\":\"925c1c3fda127833\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/readBatch.js\":\"74b207b7d09fb62b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/refProjection.js\":\"d10e5dec58812999\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetLookups.js\":\"828b7212d9c7787a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetProcessor.js\":\"34c1627504bf1828\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/replayMerge.js\":\"60a7056417e2e413\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/sqlBinds.js\":\"3004e72a530ab117\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"44c98b0170f1e363\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/arrivalProcessors.js\":\"1bf05a61af14c81e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/invalidate.js\":\"a783e8610875fe3e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/materialize.js\":\"26a62dc021214387\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/observer.js\":\"049b7ae8ea76ecd9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/reconcile.js\":\"eae90a829f4012f3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/timingMetrics.js\":\"b14c0c101ad7dcac\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/treeQueries.js\":\"168e02ea5ef4f3db\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txEngine.js\":\"2b1e29567fec7c09\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txSnapshots.js\":\"40d28fa9c23553c9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/typedBlockQuery.js\":\"f1b640edd52899a8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/undoManager.js\":\"175343628a0ad11d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/invalidation.js\":\"add7f19d9614d213\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelDataExtension.js\":\"fba39d7f8b43eb76\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelPage.js\":\"f84f1ca5b8cba027\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelValuePresetCores.js\":\"337b5f4b10315d7f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbCorruptionSignal.js\":\"c4c2072d896af4c5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbStorage.js\":\"bba7ce8e0fd7680d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbVfs.js\":\"8f180a8dde472c48\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localSchema.js\":\"1880177ad10bf681\",\"/knowledge-medium/pr-preview/pr-1788/src/data/maintenance.js\":\"9b0546b14ce09e34\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mergeProperties.js\":\"14f2355b81688501\",\"/knowledge-medium/pr-preview/pr-1788/src/data/metricsConsoleHook.js\":\"984499ad54f2f78e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/migrationsPage.js\":\"654128f34610a0c4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mutators.js\":\"b46ece1afdd00104\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKey.js\":\"1527402297118dcd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKeyPlacement.js\":\"e2011a3762d76ff0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/outlineSurface.js\":\"f37a96f48537ddef\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingEditorContent.js\":\"546060cb36e06329\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingUploadsSql.js\":\"8ed1df74d50407ae\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pluginStateExtensions.js\":\"2985a9127118c0bc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/powerSyncLogger.js\":\"a177866cf60daab5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/projectorRuntime.js\":\"d5d9028aa0e73b3c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/properties.js\":\"7b44b317374fce7c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertiesPage.js\":\"cd2607e22a1c8fd7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyChildren.js\":\"05e07fc76c4b09bb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionFanout.js\":\"eddf917bafa05831\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionMetadata.js\":\"76c8c4df817c0c87\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionRegistry.js\":\"8743013964be5597\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDisplayMode.js\":\"774d70c43b96a420\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyRowCreation.js\":\"2777f0e1c5ec1877\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySchemaCreation.js\":\"3b90c626c5d1f309\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySeeds.js\":\"a3111872eb202a8d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/recentsPage.js\":\"22fc4cad8e93cee3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/referenceBlock.js\":\"7be2a79145370603\",\"/knowledge-medium/pr-preview/pr-1788/src/data/releasePowerSyncConnection.js\":\"86177a50c9c37822\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repo.js\":\"74ed1b9654625330\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repoProvider.js\":\"800f2df110dac8ad\",\"/knowledge-medium/pr-preview/pr-1788/src/data/rowProperty.js\":\"49b4fb4b8a395f46\",\"/knowledge-medium/pr-preview/pr-1788/src/data/searchFilter.js\":\"651347144fcbcec5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/seedIdentityLedger.js\":\"58301a16e2fbbb0c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/stateBlocks.js\":\"8c3d0a2c52a018ad\",\"/knowledge-medium/pr-preview/pr-1788/src/data/structuralEditPolicy.js\":\"a8d0b534e5471082\",\"/knowledge-medium/pr-preview/pr-1788/src/data/subtreeDelete.js\":\"5f5a62fc6d202b59\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncStreamLock.js\":\"8abda3dab118a75f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableSqlRecognizer.js\":\"a3653cbbfc0e0eca\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableWriteGuard.js\":\"5cb95307bad5245c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/targets.js\":\"9c027762bfdd2021\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeColors.js\":\"89b3b1ae3a441ea2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionMetadata.js\":\"98095ac8832ca61b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionRegistry.js\":\"a0fce20da8640f9a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeExtraction.js\":\"d09c03d268b5194d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeInitialValues.js\":\"87c163e6d08031b7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typePropertyGroups.js\":\"4bb62161efad7ba7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeSeeds.js\":\"175b0473260abec4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeTagger.js\":\"768f905f8c804f40\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typedRecords.js\":\"3b9e23b630c96ce9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typesPage.js\":\"2bece5cf8e983f4f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userPrefs.js\":\"68b9721e7c77805a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userSchemasService.js\":\"616cfa30029c4074\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userTypesService.js\":\"41717f0082d242f8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/valuePresetRegistry.js\":\"0c60c7ad7629870f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/visibleChildren.js\":\"34cce399902d43c5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceConversion.js\":\"61c0983966303e31\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceFirstSync.js\":\"355d74e37d0ef68f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceIdNamespace.js\":\"695fa4bdccaa1f77\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceSchema.js\":\"2e1c3bb80fc45557\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaces.js\":\"eedd1ab92f753948\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadLog.js\":\"ccc3636fd34ee5b9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/BlockPasteShellDecorator.js\":\"dab9abcddd265059\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/atTrigger.js\":\"c359db72f62bd9a4\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/autocomplete.js\":\"5c96cb578f036ce0\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/codeMirrorExtensions.js\":\"795838078a0fa7cf\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/contentFlush.js\":\"9766b4402d248ca3\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/defaultInteractions.js\":\"fe4919c99b175c56\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/editSettleSignal.js\":\"9f144d29332c58dd\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/insertImage.js\":\"7c885878646e14c7\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceCompletionRange.js\":\"c83f432b1a8bafb0\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceTargetTypes.js\":\"1f39a7b6eb84ca3f\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/syntaxContext.js\":\"cd39f30162831170\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/triggerMatch.js\":\"8aa1e187bf4951da\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/AppRuntimeProvider.js\":\"8c49559314ecb39f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/BlockFocusShellDecorator.js\":\"ae7ed01227b7f207\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/ExtensionRenderBoundary.js\":\"ef874f03a39bfc1f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/PanelContentRecovery.js\":\"df6e33b0a4b94aea\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/apiCatalog.js\":\"8753a2e71ae272eb\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/approveExtensionHere.js\":\"23b50f18a6b3960a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/armedCutAppMount.js\":\"b3b0bf6ac3000ab6\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/batchableKeyedStore.js\":\"711fb06adf73921b\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockInteraction.js\":\"aeeff7ab1b8b600e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockSelectionAction.js\":\"6aeff3b9f9d8785a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compileExtensionModule.js\":\"eaf7e3a4b5ceb0df\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compiledModuleCache.js\":\"43461eb64d671a14\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/continuousGestures.js\":\"998b08718c2ebfcb\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/core.js\":\"407d592292cc04fe\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/defaultRenderers.js\":\"91728597a9d88efc\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/definitionFanoutAppMount.js\":\"5a65439cbece2de6\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dialogAppMount.js\":\"71d68ac93f11f913\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensionSeeds.js\":\"39fafb8a3ba075a1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensions.js\":\"02da1f510f7dc070\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/exampleExtensions.js\":\"a54230527b64b5fd\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionApprovalStatus.js\":\"5b8625a85ec3049d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrorToast.js\":\"00d48aa65e0e0248\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrors.js\":\"a9458a8e0dc66e08\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLookup.js\":\"4d386bca1ee84500\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionToggles.js\":\"5b99a0033ba340c4\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionUtilitiesCss.js\":\"09ba849ccf861365\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/kernelPageDeletionGuard.js\":\"47b68682923eb849\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/liveRuntime.js\":\"07a1b8b567363634\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/openExtensionsSettings.js\":\"110bb3b7bbb1a53c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/overridesCache.js\":\"fe708b829e95d995\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/pluginIds.js\":\"389031db57813201\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/processorRejectionToast.js\":\"85665e1bbfe26b0a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeActions.js\":\"b891c3acbae4c051\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeContext.js\":\"e67d1020e230435d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticAppExtensions.js\":\"2cf823e062e67606\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticDataExtensions.js\":\"14e628b01752e497\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/toastAppMount.js\":\"cd212822d084fa65\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useOverrides.js\":\"d0929f33e60b0d07\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useShortcutSurfaceActivations.js\":\"3430af795c28850e\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/discoverToggleTree.js\":\"4efc54455d4eaf98\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/facet.js\":\"5bf4b0eba8939af5\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/resolveAppRuntime.js\":\"3b9cbeba7a914518\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/runtimeEvents.js\":\"4dcd714a08d8e19c\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/togglable.js\":\"b61d485263eae102\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/variantFacet.js\":\"ceda29c77b5b135e\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/verbFacet.js\":\"db8f2c34e35e3f46\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/block.js\":\"5aacdbe86738da78\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/focusedChild.js\":\"4ad19169263dc380\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/propertySchemas.js\":\"c984df35d3b15632\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/typeRegistry.js\":\"95b3e95e3f34203b\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAncestorCrumbs.js\":\"5f071d11ed20cfb8\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAutocompleteListbox.js\":\"4081cba2c5e397e5\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedSearch.js\":\"f8cf6c4af7ed6078\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedValue.js\":\"c3aead5433a3f0ea\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsFocalRender.js\":\"32d9123dd001536b\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsReadOnly.js\":\"9d95b11734b2ddea\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMaterializeBacklog.js\":\"5be85823e11cce38\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMinuteClock.js\":\"9e7441d3c50a01bf\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePanelLayoutProjection.js\":\"1373ca15d8b85a02\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePendingInvitations.js\":\"d1dd8b6c743367e3\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRendererRegistry.js\":\"ae372fcb2ede1b04\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRetainedFieldRows.js\":\"03b85bceb674f278\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useWorkspaces.js\":\"7104fd4f918df68e\",\"/knowledge-medium/pr-preview/pr-1788/src/lib/utils.js\":\"5b3f8cedde48e3d8\",\"/knowledge-medium/pr-preview/pr-1788/src/main.js\":\"82d25e8c799877b1\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/MarkdownImage.js\":\"3a7a23c92ebc4512\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/blockSeparators.js\":\"473104b88a7aec7c\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/context.js\":\"580f6c3520e47416\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/defaultMarkdownExtension.js\":\"f2d0366ff9e60adb\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/extensions.js\":\"b2c8556471eccff9\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/renderMarkdownHtml.js\":\"a935db0df677cfaa\",\"/knowledge-medium/pr-preview/pr-1788/src/minimal-editor.js\":\"40f06ff75b7bd8a9\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/armedCut.js\":\"b5ba7ebab35c8b9f\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/captureMediaVerb.js\":\"2cb49a261c5602e7\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/clipboard.js\":\"132888c1aaf280fb\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/decision.js\":\"4ef8c0a3e9581fcb\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/operations.js\":\"fbd01abe6657f408\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/AccountHeaderItem.js\":\"6e8a45032871ebcf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/index.js\":\"2eac55c033ef8ec5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"465c420fc8090e7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askAgent.js\":\"b6ca1aae0dfb5b44\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askedStore.js\":\"353457f8a3740a4c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"58661f0b00759e4f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/chipState.js\":\"2ba4094f6c6c607f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/dataExtension.js\":\"789193d35a7b14b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/index.js\":\"bbc13f80dbeec7a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"441bcdd491bfdfa4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/schema.js\":\"8151f3d5343139f1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b775bcdad5ceed87\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6729c58c4b35dad3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/addMedia.js\":\"f5da8cdb68dda23a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3ab3350b8e095671\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/block.js\":\"1075a38bba04bbe2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/context.js\":\"fd5b1f2e77417557\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3650418828067a2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/index.js\":\"9c90a7433ede409a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/outline.js\":\"fb110111afcf9411\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/properties.js\":\"91016525d0a58d35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/refs.js\":\"a2a20c5b513def3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7b029f48728d6749\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/search.js\":\"d46003b1951231ac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/shared.js\":\"50474315a423d45d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"24a27c50b33cb46a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/text.js\":\"b9f4eebb5574f604\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentWrites.js\":\"5b9a038dc63711c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/authoringCatalog.js\":\"bb0fb25a33d95f90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/blockRefTargets.js\":\"65f8247a75529f23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridge.js\":\"9726dec3cce88937\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridgeLoop.js\":\"4917875bb6c589e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/changeHistory.js\":\"7b0b28e2f8340cee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commands.js\":\"a449384b48c98351\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commentsCommands.js\":\"65fba0932965e382\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataExtension.js\":\"c6431a981989e1df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataModelGuide.js\":\"6945a275e049bfa8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/describeRuntime.js\":\"bfa180aceb222370\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/extensionLint.js\":\"4d5626ce8ca73939\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/grainAudit.js\":\"f6c17b00840ae252\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/healthCommand.js\":\"da9a32c757da76a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/index.js\":\"3730e1d26fa963e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/presetIdentity.js\":\"267ac9b9afadb093\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"35bc46711e2f82d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/readMedia.js\":\"b73d291bbb11cbc1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/schema.js\":\"b4c3cba28f52ce27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/serialization.js\":\"0f77bcaa27d1612d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/targets.js\":\"00fbf44ae1c26fbc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/tokens.js\":\"0f31b2f7d16c4675\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/watchEvents.js\":\"3706889df42fb8f4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/workspaceGuard.js\":\"49cd2f3fec864fea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/writeCommands.js\":\"cb0b443fd9bcb14a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/AliasCollisionToast.js\":\"913ac02887bd7daf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/DuplicateNameBanner.js\":\"a4344f467f997fe3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/collisionMerge.js\":\"f891e7c11c9d2b9a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/dataExtension.js\":\"04c43e23a044f702\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/index.js\":\"5f0f7db7bb8c10c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/mergeCollisionAction.js\":\"34232bba85aed5c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/pageStyling.js\":\"1cd46c3c5134e7a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/rejectionToast.js\":\"d43a3a8346f1a547\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/syncProcessor.js\":\"611affaf1da375e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/actions.js\":\"ffacb80b752b9b13\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/addComment.js\":\"3916edf8f11f9dd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchor.js\":\"dc2a9208b9a3b0a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchorState.js\":\"eed817062fd18d8e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/commentLinks.js\":\"b1a242f060621369\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/confirmThreadDeletion.js\":\"fd437c95c2cae50c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/container.js\":\"11c1fe94e7982410\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/dataExtension.js\":\"60db51d3c0d4097e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/deleteComment.js\":\"c655adf7886fa82c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/highlights.js\":\"af667392b22d1d26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/index.js\":\"c1d722314a1b4499\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/linkedCommentsPill.js\":\"0549348d81b57f9a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/margin.js\":\"d66a9d9ebc056105\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/marginSchema.js\":\"9ef43119968734e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/newComment.js\":\"ff4f565e87bdbad9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ownThreadPicker.js\":\"bf0fc70592a6e144\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/placement.js\":\"0684167cc682d418\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/queries.js\":\"81df926be6651300\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotePosition.js\":\"43aff09558665ab0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedIn.js\":\"961dd784f0a458b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedRange.js\":\"156e652f9259bbeb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/rangeRefs.js\":\"5e487c59400b78fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readHighlights.js\":\"9bb7500dfe880839\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelection.js\":\"7b38816b77e561e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelectionUi.js\":\"ec94173f5c02b838\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/reanchor.js\":\"e8da68e0ef7cd853\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/schema.js\":\"4972e29503788424\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scope.js\":\"1e78f359c045b93c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scopeThreads.js\":\"783b31e637a34fe6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/splitRetarget.js\":\"f7ca5283ab970221\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestionCard.js\":\"e7337fd5d55f6ad2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestions.js\":\"05c41718898bce01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaries.js\":\"0fe1401026f38972\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaryBatch.js\":\"b21611a0f57ec7ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/surface.js\":\"967e66875073a990\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threadNavigation.js\":\"350cb21d502bd70c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threads.js\":\"66f6d3083240eec1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ui.js\":\"a2ee7695fc582dbd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/uiStore.js\":\"40ddf6a82c2ed524\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/appIntents.js\":\"2ab39f7d71c2a02b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/index.js\":\"809d15910da3f556\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/index.js\":\"0636fcbd0302265a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/status.js\":\"4d46eb1eb896703c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4e5a878004d97812\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaBlockRenderer.js\":\"08039884a217145c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f6d42fcb38918a95\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaUploadReconciler.js\":\"9bccfc7d2ffc2f1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetDownLane.js\":\"7b4e401090dd022b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetResolver.js\":\"80ed7e1858f62d40\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetUpload.js\":\"f8ab11f2a9610735\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/attachmentCleanerIO.js\":\"b368fbf175836c54\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2022b0efdd05ce6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/blobStore.js\":\"23cea481267ba5ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/byteStore.js\":\"f08a6f3256375132\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanerIO.js\":\"185e1892e94cb8d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanupAttachments.js\":\"71cf01202e033457\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/dataExtension.js\":\"e0df9108cd7ca3a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/downLane.js\":\"21340d3a2f0c186c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/index.js\":\"0a573d8bfe2949c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/insertImageContribution.js\":\"70cf63f72d6621c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneArming.js\":\"a227dd032f45ab9d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneLock.js\":\"53947add33601e0a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaBlock.js\":\"e370a690c0b6889c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaCapture.js\":\"27c2d3efa2a80efd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewers.js\":\"b7445023d9729a53\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewersFacet.js\":\"366c0e46a073caaa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/pasteCapture.js\":\"927a64428616da41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/resolver.js\":\"df2df8836e1d86cf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/retryUploadsAction.js\":\"e1ed8af3d06513b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/storagePaths.js\":\"524fa2f90818cad2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadDrain.js\":\"ca40c2de1f8c0141\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadLaneStatus.js\":\"f138d0028dfffca8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadReconcile.js\":\"a39d64c3702866db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadRecovery.js\":\"486b5d9c0e3312be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadStore.js\":\"c3ddd66a04036bf0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/useAssetObjectUrl.js\":\"f4442e337f7fb6e5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c9e212f9a953d955\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f8ca7d722e9c6fc5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/facet.js\":\"1c9cbad0a9bddb90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/index.js\":\"23000e9cb135461c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/prop.js\":\"4867baa4b6846332\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinkFilters.js\":\"7b631d2b596ab492\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"698ed74dda17310d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BlockEntry.js\":\"d5c9c5e7dfbf9ffb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/LinkedReferences.js\":\"7a209485252fe326\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c53ba0fc2c652e74\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dailyNoteDefaults.js\":\"278c65b145f8a431\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dataExtension.js\":\"e41632c5f1ab7964\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/edgeExclusions.js\":\"60cb51c2eb6ab5f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/filterProperty.js\":\"dd5657e6067ada5a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/index.js\":\"642351c755a206a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"110ce2870227c264\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/applies.js\":\"865be46dfbc5862e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/countQuery.js\":\"de739281592c2778\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9810a92c151fce42\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/index.js\":\"591e964de384aa61\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3fa3e508c29f9f00\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/presentationInvalidation.js\":\"4c828b4c87febc46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyEditorOverride.js\":\"1e3f7faf24bbdc84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyFilter.js\":\"f3bdc97a8afbb68b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/query.js\":\"f63852af86c29a6f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/resolveFilter.js\":\"e3266d7b3f6f5753\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sourceBatch.js\":\"379ef0bd02bc8609\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sources.js\":\"93759e1694cd0a88\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useBacklinks.js\":\"bb093a8eec9486c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1a244d869f4d8418\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayCelebration.js\":\"b178ec892d897b75\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayOverlay.js\":\"a56626a87c56db64\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/gate.js\":\"ed2b6fd1a79fd0f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/index.js\":\"bce0f2e49224deec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/wolfTheme.js\":\"42a7b8b598ac2f56\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/BlockDragLayer.js\":\"774d44ab951d7f43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dragController.js\":\"adf3cd91dc733029\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dropTarget.js\":\"3ecebffdc0c2813f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/index.js\":\"69e0bde85989309c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/projection.js\":\"b2a2447dbbb88fe1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/BlockMetaCard.js\":\"e26f66c613e51c75\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/index.js\":\"a23f58ca1100c13e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/AddTagDialog.js\":\"9086a3a24aea7b57\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ceda634165e56747\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/TagNameIssueHint.js\":\"fdea3b243a57b606\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/addTagAction.js\":\"7b75f5ad6d8f887a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/appendTag.js\":\"87f656ed1468ccdf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/config.js\":\"f4afaee00644313d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/dataExtension.js\":\"e18cb61a12085ec0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/index.js\":\"a492ae532e842e75\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/propertyEditorOverride.js\":\"3f68849cc2ad5a29\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b43ad26cfb4d03db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fb2d670d48d4535e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6a058efc2df98ed1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fbdd504b303876ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"73b453b1dabe5663\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/index.js\":\"04f216a0108a1914\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"93fce2e413264f9a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/CharacterCountItem.js\":\"af446a4261f27399\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5ac97f79947434ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/actions.js\":\"15afc74cf98f0333\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/blockType.js\":\"632ba376c7398740\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/charCount.js\":\"908691401a711cb6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/dataExtension.js\":\"66fac4a9821d3447\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/index.js\":\"46c5bf86dbd541f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/profiles.js\":\"0f808978c2c1904a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/properties.js\":\"c977de5fa19ba010\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/textCounts.js\":\"ed171e1c79b73012\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/colemak-keybindings/index.js\":\"165bdf078bc5323d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/CommandPalette.js\":\"77f85690d1928f65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/HeaderItem.js\":\"d655f63c9e54e391\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/context.js\":\"0f23628b664a1133\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/index.js\":\"b43becad7062d09d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/selection.js\":\"d44cbd4870cc75e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/toggleStore.js\":\"f83dbfbb071932f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/useCommandPaletteActions.js\":\"810795bfb5ea8e9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/ContributorBadges.js\":\"08c7fafb1c37549e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/author.js\":\"7947d44b1f8ff07b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/codeMirrorExtensions.js\":\"0a9b49c22269fd7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/dataExtension.js\":\"e43f6ac4f8186fca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/index.js\":\"fc1037afbea7e3a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/mentionAutocomplete.js\":\"b20fd8de3da5ba67\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/processor.js\":\"72bf922cc6139b6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/profiles.js\":\"1f20e1f5765b8822\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/queries.js\":\"d2e3e47a98775e59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/schema.js\":\"6784c3d5d24e4daf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c78b96bf49185dac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f3e3495fb0658bc9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/index.js\":\"79239182d16d80e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d1ec37f188a0027d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"89a21c41bdc2cbbc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/CalendarGrid.js\":\"b7b8b98b5299dfbf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DailyNotePicker.js\":\"f040dbffccfc9a03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ef21d0eff67e08f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateNavDecorator.js\":\"14dec00dd9352f73\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateScrubOverlay.js\":\"42b291a46ddcea84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/HeaderItem.js\":\"8c6b482cc8c13c77\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/ReschedulePicker.js\":\"d10a2005d8c50bbc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/SpreadDatesDialog.js\":\"95f209231875dd1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/actions.js\":\"ce235697650289a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/blockDateAdapter.js\":\"763488351ed968ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/calendar.js\":\"e4db3442d604e4f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dailyNotes.js\":\"0cecfd989923945d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dataExtension.js\":\"3895ead7bb3a5601\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubActions.js\":\"fbf55520f63ae34f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGesture.js\":\"da9fb0e4a437e6a7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGestureActions.js\":\"28ad241d5cc1bee9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4acae9bc1b8282e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/deletionGuard.js\":\"f1bc6b92466bf4b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dueQuery.js\":\"8f3c1e3405f8c4bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/index.js\":\"6838b366a9d7f69c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/landing.js\":\"64e374e70eb67e45\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/localSchema.js\":\"8d045e1e65e9ce78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/referenceDateAdapter.js\":\"72721597a164df59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/rescheduleAction.js\":\"df706f00abbd219e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/schema.js\":\"06678557d6a61ac3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadBlockDates.js\":\"704ca8588092b9c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadDatesAction.js\":\"9dcac3ce030925cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/today.js\":\"57af57df00aaf152\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"05161f581585ee8c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"db2cf1ebbf34c13d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/audit.js\":\"45a09d8613f4ff35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditAction.js\":\"c65309a9d94e47c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditRanges.js\":\"f4405bc01a927228\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/diagnosticsSource.js\":\"088d064ba706115d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/divergenceScan.js\":\"9d4112499db79555\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/index.js\":\"f7d0ff22f8bccc7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9435102feeecba1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/referencesMirror.js\":\"94ff4574a5b86fbe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/rowJson.js\":\"ceca026a164285ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/schedule.js\":\"6659e12f241b5656\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/store.js\":\"b7b9febef9424b78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/action.js\":\"06ba1e188cf8253b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/index.js\":\"a956afb6ee2c7a2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/plugin.js\":\"2857b5cc1d7b5fb0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"7c27b86365e0f46f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/actions.js\":\"726bf6a5bf9677c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/changeMarker.js\":\"53074d9327c74b96\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/diagnostics.js\":\"64ccf7a12b767959\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/fileSystemAccess.js\":\"1e98b1aac4e7a91b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/filenames.js\":\"c616eb1042d0d594\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/index.js\":\"1164c63f699a1864\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/mirror.js\":\"d2bd9b24e45f44da\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runLock.js\":\"432f4134e99a5aca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runtimeHealth.js\":\"c61e3c8705be64f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/schedule.js\":\"1c2edac5960bb0eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/store.js\":\"211c6ee7b8171d10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/index.js\":\"5f443059aec7b8df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/themes.js\":\"4521b8845d18297d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/facet.js\":\"26c4422f077cb9d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/useDiagnostics.js\":\"14cfc1a58a2d181b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/dismissals.js\":\"1de86da8e1cff687\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/index.js\":\"deb8268c4511a9ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/status.js\":\"f179a01c23161a0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/store.js\":\"eefa7e195690b8e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"456bbf608f697ed9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a6fb64b364263812\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/actions.js\":\"ab53ea82e04e723b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/config.js\":\"7704f5819ef2c2b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/dataExtension.js\":\"24423b28f63abc09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/effect.js\":\"4d611fdbd02312b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/index.js\":\"238fdd35d93dc794\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3f166c29ff67912e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/useToggleTree.js\":\"27eda0082bcd4b0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/ExtractTypeDialog.js\":\"6761e93c489a0644\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"02679eda3e4122de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/PropertyShapePicker.js\":\"226f893191e2d3fe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/action.js\":\"6ca27d16f769a82f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/index.js\":\"0aaebfcbc7f102ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/FindReplaceDialog.js\":\"057ba336c4cde1f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/HeaderItem.js\":\"378942b402338a42\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/dataExtension.js\":\"8ca75b73932714d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/index.js\":\"b4337bca188a17e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/search.js\":\"cf6fa3ff5bea655a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/toggleStore.js\":\"dd983a4ca49fe47c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/LocationPropertyEditor.js\":\"b9a3e8b5aedaa05e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/MapView.js\":\"6af57af5bd0d2635\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/blockTypes.js\":\"eebf0d2ffafb1a09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/codeMirrorExtensions.js\":\"2b9c44119c35aece\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/createOrFindPlace.js\":\"a7728b1b47f012a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/currentLocation.js\":\"ef97aafd0f312543\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/dataExtension.js\":\"3bdb7aa00c6e20b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/geoContentDecorator.js\":\"60fb695ef34df250\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/googlePlacesClient.js\":\"3a47715d057c5b4a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/index.js\":\"1bcd23404249be61\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/locationsPage.js\":\"8c5364e2fd93b9c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/mapViewport.js\":\"601f19d1ea666a89\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/pickCurrentLocation.js\":\"7dd5a88d7fc037de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeAutocomplete.js\":\"9adaa61107f92dda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeNameCollision.js\":\"21df90fb923fb259\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/properties.js\":\"632e8b8c479bc191\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/propertyEditorOverrides.js\":\"6ef2ed9e9a1e2f18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/query.js\":\"4b5b869073f61682\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/usePlaceSearch.js\":\"2d4a56441168b240\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"95883685e961a29a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2a6351cda6584fbb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4730b855bb43bfdd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/config.js\":\"f069b55818cc5bd4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/dataExtension.js\":\"c61f283c04720d68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/facet.js\":\"29638e354ee0f265\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/grouping.js\":\"4534e0453f8656e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/index.js\":\"da70b365d7d4633e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b7cd85e98fc3a113\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/query.js\":\"d3a10a86f80ebe3e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/resolveConfig.js\":\"bce6c1907b22c909\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1e1dc466b8e3853d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a9bee8f940f97782\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlDocumentContent.js\":\"274ffe8e6a9bb7d3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlFrame.js\":\"a7b56da44ab62d0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/actions.js\":\"64f3f1f964b94e9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/blockType.js\":\"fe5c213a5da829e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/confirmRunScripts.js\":\"5f809fc4ac6cf326\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/dataExtension.js\":\"aa3046d2436ecd85\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameAnnotations.js\":\"e7dffa8097aa231e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameDocument.js\":\"549092654a55b010\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameTheme.js\":\"e699ed1a7d45b671\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/index.js\":\"15fac124352edd20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/scriptConsent.js\":\"87f37a2ec1393f36\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/sourceMap.js\":\"bb9bdcd384b12af7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/useDocumentScripts.js\":\"4cb58d56e07d0b28\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/index.js\":\"e6e53e2a493f2ea4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/record.js\":\"f6922b0c22d49a47\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/recordStore.js\":\"a0f602bbd35cf735\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/responsiveness.js\":\"aa34e9cba0649c60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/schedule.js\":\"0a8acd210feb86ff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/sessionContext.js\":\"c182c6b833e49978\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"caab9c0398c2866d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"51097d98e6170daf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/actions.js\":\"dc4642016de0a774\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/config.js\":\"8dc09206e0118ff9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/dataExtension.js\":\"aacfd619e3488e77\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/effect.js\":\"398be4f2bafb08e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/index.js\":\"e4eca62f737591f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/keyCapture.js\":\"16c90346748690ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/overrideStore.js\":\"d867b10563c342a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0755d94d9ab9710e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/HeaderItem.js\":\"3029db8cb10bcf99\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/LeftSidebar.js\":\"ebbcb17e6c0ce1d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/actions.js\":\"d24ee5c701b20f7d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/facet.js\":\"a64374a9c703d0e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/index.js\":\"9116b5e74c41e648\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/shortcuts.js\":\"2154e8a6520ef12f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/toggleStore.js\":\"73d0995fb807c7c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/MergePicker.js\":\"50f7e6462b409a15\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/index.js\":\"72ddd28408445521\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/mergeAction.js\":\"f8ece5b3d15c91ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/strategy.js\":\"e1ce3a01da3b1653\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/Button.js\":\"1892df67bb323777\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1a02852d4089d560\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/defaultItems.js\":\"71f7664af2e54091\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/facet.js\":\"a5fa61f1f71af663\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/index.js\":\"f2170e96b80799b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"381b20d1081794cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0b7d623f7595e151\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a0ee425f92ed3613\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c37c7770803bb889\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/index.js\":\"14320d47a65b845b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/MoveDestinationPicker.js\":\"656c0ae5d95bfac0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/blockSubtreeMembership.js\":\"bff42db79003f7df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/contextMenuItem.js\":\"50149c85bed70df5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/index.js\":\"cc57dccec96bc545\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveAction.js\":\"b2e5fcc4fd61490d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveBlocks.js\":\"3b7534c9f0fe33b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/selectionAfterMove.js\":\"3c0d355cffc76e72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/TutorialBanner.js\":\"9904cfb3cda2e647\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/action.js\":\"cd72f9849818adcd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/bannerDismissal.js\":\"694b47d259137afc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/documents/cheatSheet.js\":\"4b87fd0a2f5f71f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/index.js\":\"6332028bdbce8da2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/keys.js\":\"45f6dcec42272769\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/landing.js\":\"d58ec653431a02fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/outline.js\":\"9cfc330d8ba19472\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/seed.js\":\"4612b5fe39883410\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ca2117451e7bcfa5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/analyze.js\":\"17e165e77e975a2b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/diagnosticsSource.js\":\"7d25577b0815b09e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/index.js\":\"0d49968d49144ede\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/load.js\":\"b62785cac5c4c656\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/monitorRun.js\":\"a9de80374de954d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/schedule.js\":\"f46bd1ac68eb07ce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/series.js\":\"10f77a9caaeb8483\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/store.js\":\"32ebc758af9faba6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/trendAction.js\":\"5740e8c2d20012bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/verdict.js\":\"ff24db1330b7090e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/clickToEditAction.js\":\"69398e8fb3b22e82\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/index.js\":\"ee4693dd6de47381\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/interactions.js\":\"055af8876bea5417\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1792e9a7830bb096\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGate.js\":\"4bbf0ec869f9af8c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGateDialog.js\":\"bb773e7fbd4715a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/action.js\":\"cd1df24d17b90651\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/index.js\":\"85a86eb85ad28e12\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/localRunMessage.js\":\"9421d7a037790f13\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/plugin.js\":\"a2877576a295a4b1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/progressReport.js\":\"d3a0a89196e19850\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/sweepProgress.js\":\"1855eebcda0f8fbb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/FieldRowRenderer.js\":\"4bc7e74faa373e4c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/ValueRowRenderer.js\":\"963ddea748459813\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/actions.js\":\"02a59c45ec382d3a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/autocomplete.js\":\"ad038066e36b4a45\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/fieldRow.js\":\"ba77d6ace303c0ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/index.js\":\"6e7156672331af30\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/referenceWarning.js\":\"acc6ddb450a3cefa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueAutocomplete.js\":\"76a1a920c44047c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueSchema.js\":\"e97b69fa3c38c06c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/HeaderItem.js\":\"2428f6bd7fbad89b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/QuickFind.js\":\"a1648157e8593211\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/index.js\":\"cf3c3727d6bb0a70\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/recents.js\":\"fb35d38ece39da76\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/resultItems.js\":\"64ecadac0f00b8dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/selection.js\":\"701a545e2bd243e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/toggleStore.js\":\"9f6fe3d9c18fa365\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/HeaderItem.js\":\"864fd9e525678b90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8c9ae2b52d71a99b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/grouping.js\":\"2db572beaf6980f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/index.js\":\"7cd39b94f0a241b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/target.js\":\"c705d81531d1f493\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/codeMirrorExtensions.js\":\"828c0ecbf402d9ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/contentPrefill.js\":\"f778376ff501f559\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/dataExtension.js\":\"1a67e34d929430b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/index.js\":\"ad74cd6c17a269b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d511a6b2fa53b301\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/invalidation.js\":\"adcfec72e073abea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/localSchema.js\":\"55329a119cf3787f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/index.js\":\"2f37de3362dbc8f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"30e10db0459f0eaf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/index.js\":\"c1d8f063fda2fe40\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/referenceNode.js\":\"2c4016422b8513b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/remark-reference-occurrences.js\":\"123cc28d416e9bcd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"782030373ec46864\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/index.js\":\"a956b3bc60abd82c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"66ce3163c0a6f0eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"74d028db29e98943\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/mergeRetargetProcessor.js\":\"2180b5fa23f26bff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/parseFence.js\":\"1e5d8e26eb6ed7ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceParser.js\":\"b8c3a622da610826\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceProjection.js\":\"9e6dbe59f0af2a13\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referencesProcessor.js\":\"32eef20a4c58ef55\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/renameProcessor.js\":\"9855ad3895224cdb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/spanReplacement.js\":\"6eb2301ef96c8823\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/htmlToOutline.js\":\"90b7a6c3f719aace\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/index.js\":\"35240e641792586e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3b7dc09cc2ff3856\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/pasteDecision.js\":\"11f7a7b6a8e55dec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/action.js\":\"953579a470c915a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/blockIds.js\":\"948103bdc3b7a910\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/content.js\":\"9c783720923d1a49\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/effect.js\":\"a3ac5ef786a9cad0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/ids.js\":\"cc1271b5891cc315\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/import.js\":\"22547c6501bca0d0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/index.js\":\"abd7a8010c29468f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plan.js\":\"d7db5793a321758a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plugin.js\":\"7ca6a0b3f3bedfd5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/promotion.js\":\"790f0788f63793d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/properties.js\":\"dee46e812e1a168f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/references.js\":\"347e7760ea7b5abe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/report.js\":\"f28a2730b89efe8e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/roamMemo.js\":\"c161578ea3a67fd2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/runtime.js\":\"cc0b9ed32db11b16\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/schemaReconciliation.js\":\"be10785c9a8b0fa0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/srsMarkers.js\":\"994552814fffbe0f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/todo.js\":\"dedfb0dd8467a128\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/typeCandidates.js\":\"e79a5d9d1e37df41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/types.js\":\"8294fd72ce66d113\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/index.js\":\"958f51f738ac9cb7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/store.js\":\"6d9a6066a49c0198\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/HeaderItem.js\":\"4097e4e9426fa69d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2d2ab8d148f67fc4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/index.js\":\"cf110a4d2978123a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/model.js\":\"52cfbc5319b1ce73\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/toggleStore.js\":\"d881d06d8fecfc0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/useKeyInspector.js\":\"cd28f6fb912cc572\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"48be767f1fab7f1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/ShellDecorator.js\":\"41e950c8cb00122a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/actions.js\":\"bc903c83172ccc67\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bbdaeda9a7cc4b33\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/index.js\":\"332a00a921119ebf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/shell.js\":\"7d201ba25710d50c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/surface.js\":\"b916dd3aa97c40ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/walker.js\":\"f00249055919a42e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c61c6a1cd5819cde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/dataExtension.js\":\"81244aa611c0c946\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/index.js\":\"dcc7871225e4f667\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/indicator.js\":\"7ab584f3dbd8847d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/moveSrsState.js\":\"7ecc085f22245a95\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"726b41ab71ea90f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/scheduler.js\":\"a6d52549631f4671\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/schema.js\":\"88a5f2d9ee6aaaa3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4c43add8c6ac8fd0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsClipboard.js\":\"db42b5e751c36f10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6e983a454fc18173\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DailyNoteReviewHint.js\":\"46020408c02b807f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DeckPicker.js\":\"0193f49329d0f50a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewControls.js\":\"c643a294286b29cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1db87317b27a8c4d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewSession.js\":\"371e7c1e143de4ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/actions.js\":\"00ee272d07ae8d88\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/archive.js\":\"0da671f6f188ed43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dataExtension.js\":\"43b64937553c2519\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/deck.js\":\"f8e88f0e9844fda1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dueQuery.js\":\"9f24498cae5f92ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/gradeDecision.js\":\"43344eb1ab31e30b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/index.js\":\"9d93b3508f47613e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/keyHints.js\":\"544b7047c5e781dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewCardLayout.js\":\"7e20786901069b20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewProgress.js\":\"68a5d4aeba032c98\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/schema.js\":\"272ef6f0cd9b015e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/useDueCards.js\":\"134c9143a554950d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/index.js\":\"119823a724040c43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/record.js\":\"4cda60e743666857\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/index.js\":\"1432a04dde0dc48e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/persistenceStatus.js\":\"b52d173020ea4cc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/requestAction.js\":\"4aa484251a18337d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/TypeChipsDecorator.js\":\"b6b2d9f3ea5fd43c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/codeMirrorExtensions.js\":\"1840490606e8fcdf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/index.js\":\"81a038011495951d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/typeAutocomplete.js\":\"915092848e5ecb80\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5571c17614c10b01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/actions.js\":\"3b756d853ea692a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/anchor.js\":\"05dd0ceb1e220b10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/events.js\":\"90fe2baadf57cbda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/gestureActions.js\":\"a5fadfb9007b2ee6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/index.js\":\"c660da8f388d5d6f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"596637a87df861e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/collect.js\":\"c8e91bfa993ef6f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/index.js\":\"77ac95167d9137d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/record.js\":\"c276898487670ddd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/RejectionDialog.js\":\"e99034027d4ddc2c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b52d2aa242c93d1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/index.js\":\"46d8efb1dba34b09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/model.js\":\"3dee1c29c5b6437a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/queueCounts.js\":\"ecbca8f933b7b99d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rejectedHelpers.js\":\"c33de3ebc0f46069\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rematerializeAction.js\":\"67ce013172695333\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/useHysteresis.js\":\"d1b91204ae956d76\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/effect.js\":\"83330715b40df3b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/index.js\":\"b065052ef059d351\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/theme.js\":\"5a31f3c7e34c32f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/actions.js\":\"ecc19241e4df2f81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/dataExtension.js\":\"5c5cea8c3f90a99b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/index.js\":\"3fb685e9461aa4c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/schema.js\":\"99cc4c12baef98a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/TouchSelectionLayer.js\":\"70ab01a0cc6479b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/actions.js\":\"0ae86006c2e2d518\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/defaultItems.js\":\"7e9d5f6d9c27cca0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/facet.js\":\"f1fb033d81998761\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/holdRecognizer.js\":\"700243ef57fe613d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/index.js\":\"ca1f75c106a81815\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/UpdateIndicator.js\":\"e7fd5c2dfdeef1f4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/index.js\":\"1a36cbd8db2b839e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/loadTimes.js\":\"5997d6ed9566440d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoNotesRenderer.js\":\"f60821a9d9fe7f68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoPlayerRenderer.js\":\"542e41c74b6a3ea7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoTimeStamp.js\":\"a35b212c4878eccd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/actions.js\":\"5c58569d7627dfed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/index.js\":\"c77fa040c06feabe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/markdown.js\":\"c607b1471c0697b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/notes.js\":\"16b37093792021b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/registry.js\":\"349183524f11fba1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/remark-timestamps.js\":\"2d77680a18c3a0b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/view.js\":\"b15c1d96369067ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/LinkHints.js\":\"d9b588a327ec66d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/index.js\":\"ecb863686c358f07\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/model.js\":\"9f9b33ee0fd523ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/settings.js\":\"e9b0fc2ca024a531\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/actions.js\":\"0b74f0377187ec04\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/index.js\":\"5f22736a3430ad36\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/interactions.js\":\"0fda8e13addf72bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/workspace-header/index.js\":\"05f689510bd39634\",\"/knowledge-medium/pr-preview/pr-1788/src/registerServiceWorker.js\":\"b2b0ea2b53a0ff1b\",\"/knowledge-medium/pr-preview/pr-1788/src/requestPersistentStorage.js\":\"f189e036abf56e88\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authRequestDeadline.js\":\"162af92fc6933eeb\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authStorage.js\":\"f547a09f7faa5750\",\"/knowledge-medium/pr-preview/pr-1788/src/services/powersync.js\":\"948dbe52e37d9ffa\",\"/knowledge-medium/pr-preview/pr-1788/src/services/supabase.js\":\"2326113c0592fbf6\",\"/knowledge-medium/pr-preview/pr-1788/src/services/uploadErrorClassifier.js\":\"98c15457a8de0952\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/ActiveContexts.js\":\"c3f43dfa4141d80b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/HotkeyReconciler.js\":\"9f7bf9f7ef23e699\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/WipeLocalDataDialog.js\":\"bb45a35a83dcf04f\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionDispatch.js\":\"895a53f2ee6badac\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionRefItems.js\":\"51f56fc9bc5578fc\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/applyKeybindingOverrides.js\":\"d06c7d063056ee70\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/blockActions.js\":\"ebcb32ec2900ed43\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/canonicalizeChord.js\":\"24d6955240639d84\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultContexts.js\":\"36035efda44f8598\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultShortcuts.js\":\"6b32ab7350b1569d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/effectiveActions.js\":\"a42f227e4496e6d5\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureAction.js\":\"36ea3d61f0d5d9b8\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureBinding.js\":\"78fb5064ecfcf342\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/holdRegistry.js\":\"e149ebe2bfcc9658\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingConflicts.js\":\"0913a1cc2dd67310\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingOverrides.js\":\"0832dacf0ae0fdc7\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/pointerAction.js\":\"599c9691bcbea262\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/resolve.js\":\"35334898861c8280\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/runAction.js\":\"e94e0429a622f7c5\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/sequenceMatcher.js\":\"fb0cf916779953b1\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/types.js\":\"16666ee6b71b2b03\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionContext.js\":\"7fc5dad450a27f97\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionDiscovery.js\":\"3065935e4c696d94\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/utils.js\":\"4e5e2f57e8bccbe7\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/bootStore.js\":\"cc7c961f05077695\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/previewDatabases.js\":\"70699202ba505fd0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/byteTransform.js\":\"ecfb369a89473b67\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/attachmentCleaner.js\":\"45bc40a55cc2318e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/attachmentParts.js\":\"a251098cdbd7643e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleParts.js\":\"d53b6c3b952641fe\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleRecord.js\":\"451ef04c783b947b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/manifest.js\":\"c142188af4f0d116\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/takeBundle.js\":\"98eefc8ea0a229f4\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/verifyBundle.js\":\"938fb472afdcdd8d\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/cleaningStage.js\":\"776953703fc475b6\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionKey.js\":\"cd63d1651909c6be\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionServer.js\":\"d6626fa74659ba05\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flip.js\":\"b1634dc42e397f4e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flipAttempts.js\":\"d9c1da7790e05f19\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/pages.js\":\"450ad20e4885b287\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/preflight.js\":\"54c4925b9fdea4ac\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/reseal.js\":\"ae3cab2f928cc858\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runConversion.js\":\"4f116ed7032e45f3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runLock.js\":\"4b4b523ca496d6bc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealing.js\":\"b4de8aa06d3fefbd\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealingStage.js\":\"9e0c7a517c4c6e16\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/stage.js\":\"269aa6cf7902dd6e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/verifyReseal.js\":\"6cfc04eafcc3f823\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aad.js\":\"aa74d53ecbd0f8b2\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aead.js\":\"5b20465230182cad\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base32.js\":\"239424905265a49a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base64url.js\":\"618d210005a5135a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/binaryEnvelope.js\":\"6b01a455ad7903c2\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/byteAead.js\":\"c7bc87be95191afc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/canary.js\":\"b6c4c1a496664b28\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentHash.js\":\"d4d336e99431e1d7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentKey.js\":\"2b807a750968fe8d\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/derivedIdNamespace.js\":\"761231b2549cbefe\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/envelope.js\":\"9888d58d67c942c7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/hex.js\":\"ce14ad07b21aad01\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/sha256Hex.js\":\"078cf5c187df3652\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/workspaceKey.js\":\"bf89bb6108864edf\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/conversionState.js\":\"770640d4e52cc3bc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/createEncryptedWorkspace.js\":\"62956b83ed8e198a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/pastedKey.js\":\"55db8bedb89f6f51\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1ef8d98b849ef069\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d58b51929d523958\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/keyStore.js\":\"1c61830abb972f1e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/mintWorkspaceKey.js\":\"161ac09599a0067d\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/modePin.js\":\"414c7d9f0676d02b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/openWorkspaceKeys.js\":\"190eae1eba74837f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolveWorkspaceEntry.js\":\"979b80945d4e7f5c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolver.js\":\"d3e0a6091b69799a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/workspaceAccess.js\":\"97ed90b1160620f0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/transform.js\":\"8d1ab87e86dccd2d\",\"/knowledge-medium/pr-preview/pr-1788/src/themeBootDefaults.js\":\"cf9ccd278faca90e\",\"/knowledge-medium/pr-preview/pr-1788/src/types.js\":\"65db1b6eddc6502d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/ClientLocalSettings.js\":\"725aebf48afdec1f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/abortableSleep.js\":\"773a4294b1072a9c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/array.js\":\"545fd504fc5571e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/backlinkAutocomplete.js\":\"d0c9468b4c40a8a2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockCrumbs.js\":\"720eb5e1f62ac5a5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockrefAutocomplete.js\":\"1e4b2742451a3b48\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/cadencedIdleJob.js\":\"7cb0d461402377f8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/callbackSet.js\":\"f314954710f11dbc\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/clientId.js\":\"b614364a795a333c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirror.js\":\"e12e504f6703a829\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirrorCompletion.js\":\"5134ba44a536ccad\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/copy.js\":\"89e59e5d60489a9b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dailyPage.js\":\"002c43c6fb114c59\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensics.js\":\"fb9e7349ab5120f7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensicsHooks.js\":\"fe35afe1b2675537\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/deleteBlockThroughUi.js\":\"629dc169bfe8cb3e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dialogs.js\":\"c59a5067352b1676\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dom.js\":\"c8dfce20a16d8df5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/downloadBlob.js\":\"2d53f464dba5e610\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/exportSqliteDb.js\":\"2ed42747ced9c1a5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fileSystemAccess.js\":\"b357cf34f427301b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/flipSlide.js\":\"468d8b174b1cd440\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fnv1a.js\":\"88ce276375fdae0e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/formatBytes.js\":\"748ddabf4a0a4e90\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fuzzyRank.js\":\"4b13c46f9f107c28\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idbKeyedStore.js\":\"bcc056aeb60ea8f9\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idleCallbackPolyfill.js\":\"a59113d2f3873163\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardAwareScroll.js\":\"13fcdc3b49a46a92\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardViewport.js\":\"a8892bcd304755d5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/lastWorkspace.js\":\"6580aa08a1e0ec6b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutColumns.js\":\"5642fcfabcfe9028\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionDom.js\":\"4d38d62c4a6a15bb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionId.js\":\"b3aadf2216e55893\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkClickGestures.js\":\"58f8cb5140dbefa7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkTargetAutocomplete.js\":\"09bc3b3ff825a154\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbCorruption.js\":\"be82753cec0864c3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbRecovery.js\":\"41fa0e7181c69ce3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/markdownParser.js\":\"c8d479c520ab0b26\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/memoize.js\":\"54a51d12c60ef07c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameFieldCommit.js\":\"c89775c4603af7fa\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameList.js\":\"6eeabc5ce079c877\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/navigation.js\":\"f8afa4e21cde618e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/omnilinerNamespace.js\":\"5cbaa7150e72833f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/opfsPageScan.js\":\"289f96826f664705\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelClearance.js\":\"339cdb19dd886ca9\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelHistory.js\":\"ed7112107b453f69\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLanes.js\":\"636e578f6f912c6b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLayoutProjection.js\":\"bf8f42e40e81acd2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelScrollAnchor.js\":\"da0f603a8c48b84e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelUrlFlags.js\":\"3bdc9a3fe083a5ef\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/platform.js\":\"8642442eb5af8561\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/pluralize.js\":\"af55c6f1f1cd577a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyCreation.js\":\"ef001e9107b64046\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyNavigation.js\":\"92dd617b941afb1a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyValueContext.js\":\"abccab6f72fa37ce\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/react.js\":\"b9739912cb4ca313\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeDate.js\":\"3c6390433784e887\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeTime.js\":\"4e6f393b8e221bb9\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/renderScope.js\":\"b43012039134095c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/resolvedThenable.js\":\"ad6c7f1b2e899da3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/routing.js\":\"749f5e60b5953a40\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/safeMode.js\":\"9223d54d057b1765\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/scheduleIdle.js\":\"1b15dacfc3df6e7e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/screenWakeLock.js\":\"b7d0cc549d0926c0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/selection.js\":\"062b79ffa99625b6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/softKeyboardGrab.js\":\"dff5d73cf3bc13a5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/startupTimeline.js\":\"a31a079bee7c94d0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/state.js\":\"6da425870dfd9cdb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/string.js\":\"67fda15f055854b1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/surfaceZoom.js\":\"d39a0a9d4cae48c1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/time.js\":\"69613d0b429c72cb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toast.js\":\"ac9f6a225d2c2327\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toggleStore.js\":\"ba115817c18c24e7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/untilStopped.js\":\"6824846f62d621b8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/userActivity.js\":\"20033cbb1be89e41\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewTransition.js\":\"6fb395128276e3be\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewport.js\":\"b10b41f374377165\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/webLock.js\":\"35699211db18604a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceRecovery.js\":\"459ad255dad5df9a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceSnapshotStore.js\":\"a1cac017fd624a85\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-compiler-runtime.js\":\"6393cf576ae33440\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-client.js\":\"5c6e88d082bea638\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server-edge.js\":\"4b886799946e172c\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server.js\":\"262aad360d05e4bd\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static-edge.js\":\"5ae6f53f93c4416c\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static.js\":\"147faa587f26d6ad\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-test-utils.js\":\"83244abe1b902cf9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom.js\":\"f6cd23a81104f5ad\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-runtime.js\":\"9ce552d35fd67a64\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react.js\":\"8215c4d1edaa680d\",\"/knowledge-medium/pr-preview/pr-1788/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
