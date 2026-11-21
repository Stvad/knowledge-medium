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
		buildId: "a9c83748235e-2adbd8ef",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/\":\"0d9c7f2c50218500\",\"/knowledge-medium/pr-preview/pr-1788/index.html\":\"0d9c7f2c50218500\",\"/knowledge-medium/pr-preview/pr-1788/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1788/assets/FacadeVFS-ZCRGUJFE.js\":\"df97fb4891d87120\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSCoopSyncVFS-DFvj2ptq.js\":\"e07dc91ded818d1b\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSWriteAheadVFS-CBn5jnWO.js\":\"90d72333506619de\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-VHim_sjG.js\":\"3ee607d1115fdbcf\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-D5y5E6Iu.js\":\"5530d0155c73c11e\",\"/knowledge-medium/pr-preview/pr-1788/assets/worker-CQ3oMEyB.js\":\"fd4e74c127fa613d\",\"/knowledge-medium/pr-preview/pr-1788/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1788/chunks/app-Bh16sD7P.js\":\"fd7ecd7fe570d6fd\",\"/knowledge-medium/pr-preview/pr-1788/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1788/index.js\":\"c7b78bd245ccaa0d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1788/assets/AccessHandlePoolVFS-BIZFShHd.js\":\"40163fd2584d781c\",\"/knowledge-medium/pr-preview/pr-1788/assets/IDBBatchAtomicVFS-CIfB4ukQ.js\":\"b7a76d7f99c5831b\",\"/knowledge-medium/pr-preview/pr-1788/assets/MemoryVFS-PEM6NHw2.js\":\"5805389859240a11\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-ChWoBi98.js\":\"0f3d89b51a9ad7bc\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-BYnt30z1.js\":\"9f91e98210bd7325\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1788/chunks/AccessHandlePoolVFS-DRlAAoTp.js\":\"167006762600eedf\",\"/knowledge-medium/pr-preview/pr-1788/chunks/FacadeVFS-Doa6ak-i.js\":\"3cc9681b20507f21\",\"/knowledge-medium/pr-preview/pr-1788/chunks/IDBBatchAtomicVFS-DWrn9vMy.js\":\"fd5ff32ce7065ec3\",\"/knowledge-medium/pr-preview/pr-1788/chunks/MemoryVFS-C5lezFDM.js\":\"153b89fb869cba28\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSCoopSyncVFS-s9lFTGaE.js\":\"5b4b5c7c5c4c8151\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSWriteAheadVFS-CPEJpUzL.js\":\"a4370571865b01e7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/Preview-DgcI8ynH.js\":\"d3db8c4877827b6d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/card-DmxEE2br.js\":\"eb8b1b1a99e79e74\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-9jb2qQ5x.js\":\"23f1d04f8cd5c9c6\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-EWeEnxiQ.js\":\"fb839221759d27ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-async-ClyGc1Gt.js\":\"fb2c0ba9129c2673\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-7QskfhK8.js\":\"e34944f588ab7e5d\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-Cs0Ok8is.js\":\"3bd3b0f4bc2010d1\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-D1y45c-b.js\":\"945f0910acabd960\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DSq4mA5M.js\":\"b3be2a4387e4530a\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DXMepp4j.js\":\"a09309d2d4557e4c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-K34XQltZ.js\":\"45219aef1f31fc33\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server-legacy.browser.production-DEhkg5uK.js\":\"71586a0e26392fdc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.browser.production-B9MrTzuO.js\":\"0d9428200bf68c55\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.edge.production-D6oPo0mX.js\":\"777aa985fb095399\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-lVHNo0TV.js\":\"a513248a7a2d1e4a\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-zA5cjEdn.js\":\"22be68ae355a0fb9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/server.browser-DNzZSqZH.js\":\"3686ea422680afc4\",\"/knowledge-medium/pr-preview/pr-1788/chunks/textarea-dGp4A79a.js\":\"aefb6d002e893850\",\"/knowledge-medium/pr-preview/pr-1788/chunks/ui-0jC6iFb3.js\":\"442a1408f6cf8e94\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-Cj1mtf1Z.js\":\"f22f4b8886f436e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-async-CKwLWy84.js\":\"b47819fb8f3df2c7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1788/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/src/App.js\":\"a0343093952e2ad4\",\"/knowledge-medium/pr-preview/pr-1788/src/appUpdate.js\":\"7bd25e6805cb088d\",\"/knowledge-medium/pr-preview/pr-1788/src/appVersion.js\":\"c2d773672eea4ee7\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/initialLayout.js\":\"658f12372a2a6b45\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/openWorkspaceData.js\":\"cc4e062199957a05\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/resolveWorkspace.js\":\"4ec1988fe9190605\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/workspaceBootstrap.js\":\"265a0e00c1df4b72\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockComponent.js\":\"758254a61b21d37d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockCrumbs.js\":\"023a707c9ff96021\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockEditor.js\":\"14ef79cae2c1c171\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockLoadingPlaceholder.js\":\"4bb8d4918203115f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockProperties.js\":\"baafabdbbd0718ef\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockSearchPicker.js\":\"0e736a7f5d93f197\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ConfirmBulkDeleteDialog.js\":\"03334842d8b96ac7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DividerHandle.js\":\"f7ab60ede9806f2d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DraftEditor.js\":\"6aa7df14a6b35b70\",\"/knowledge-medium/pr-preview/pr-1788/src/components/GutterPill.js\":\"750e9e6149250a59\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Header.js\":\"65a078ea6c3b2ee1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/LazyBlockComponent.js\":\"eff98fcd2195f3e5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Login.js\":\"644aa143f6332096\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ZoomableSurface.js\":\"21cba32c43f38276\",\"/knowledge-medium/pr-preview/pr-1788/src/components/editModeKeepalive.js\":\"d37660a6780246e6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6e381dfc6a2bb6b4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"275fbb454d7fd9af\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefPropertyEditor.js\":\"fb1338a02e02fdfa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefTargetTypePicker.js\":\"b3a07abab544c72f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/SelectPropertyEditor.js\":\"0623c1ada4ac74c1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/TypesPropertyEditor.js\":\"4c353b23d926405c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/defaults.js\":\"81ee614e35af2e22\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/kernelValuePresets.js\":\"3dc2d7defb61244a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/selectablePresets.js\":\"542a805f03854d38\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/typesPropertyUi.js\":\"f1a983c2f1ca69f0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/AddPropertyForm.js\":\"16eab0c3ff8d942e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyPicker.js\":\"2181e80bece3bcde\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyRow.js\":\"b3f6c7e9410aaf31\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/Rows.js\":\"2ad9a5256f7f5800\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/actions.js\":\"6d7adf6c7f63dee0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/declarationOnly.js\":\"476288035225a0c9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/layout.js\":\"fbf75ae0b6cb92a6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/model.js\":\"f1fce57b9dd75b2c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapeUi.js\":\"c4a9e11054237f49\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapes.js\":\"e76dfc0bc802ee80\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5eeb59cf7627128a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/visibility.js\":\"c796bad5cd42ab04\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanelSections.js\":\"585647687c19140d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockEmbed.js\":\"17d9ddab684ed64f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockLink.js\":\"5af61fc54ec4c331\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockRef.js\":\"5a15e3bca5958482\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/ReferenceLink.js\":\"4f9da3493741ca5b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuard.js\":\"316b67bab43206d7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuardContext.js\":\"c172affb695dd6d4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/linkInteraction.js\":\"14b26d90c1c78198\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/referenceLayout.js\":\"98f48c1989aa42d6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/useBlockRefAncestors.js\":\"36d54e3d37566cf1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockGutter.js\":\"6dbaa4d14b6d3b24\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockInfoDialog.js\":\"f3482130e4904a25\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockTypeBlockRenderer.js\":\"0ae55e105c515dad\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BulletHoverCard.js\":\"67d78c6107dc459c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorContentRenderer.js\":\"62bcc2708f1d51a0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"67a329d04b501ce5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ColumnResizeHandles.js\":\"42230cc62e81e8f2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b35b0ad83bdf3793\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/DefaultBlockRenderer.js\":\"026bd6e8f39f8459\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/LayoutRenderer.js\":\"67075614e1031fa6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MarkdownContentRenderer.js\":\"776fb680a08a954d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MissingDataRenderer.js\":\"ac80276217b5f91a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PanelRenderer.js\":\"8fe55e9a5bf2bf0c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PropertySchemaBlockRenderer.js\":\"91d717b2a39b9724\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/TopLevelRenderer.js\":\"c761f9978aebee24\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockGutterMode.js\":\"965237a3f90eb676\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockTitleText.js\":\"1f66ac59648a4e69\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/fieldCreationKeydown.js\":\"9bcf6b4356541b4c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/layoutRootContext.js\":\"9602536c7442f439\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/TypeChip.js\":\"91b4e3cd022bc6c3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/chipStyle.js\":\"d0804915f5e560ac\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/anchored-floating.js\":\"1b2e5106ff1a2e8d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/button.js\":\"05086c2f33bab97f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/card.js\":\"b4d7994af8172f41\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/checkbox.js\":\"61dbae62590394bc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/collapsible.js\":\"b7eda957a4f9e9ad\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/command.js\":\"7ca584fb771f34fb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/context-menu.js\":\"23bc9b7dc8f794bd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dialog.js\":\"b75d541a7dd345ff\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dropdown-menu.js\":\"6f411f2e656e8ef6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/floating-listbox.js\":\"9fbc1efaf1f0bd80\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/index.js\":\"f3964a134e3a5a19\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/input.js\":\"96b4c10db7165877\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/kbd.js\":\"47db9f9e20365488\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/label.js\":\"2982c0633ac977b6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/textarea.js\":\"f012447c14d85773\",\"/knowledge-medium/pr-preview/pr-1788/src/components/useEditModeYieldKeepalive.js\":\"ab85bf54461afe7e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/BootFallback.js\":\"729cc63b3a2ab319\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/FocusedRowLazyMount.js\":\"23367b6d7211cef7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LazyViewportMount.js\":\"6ae8b628b38053c5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LocalDbCorruptionFallback.js\":\"a627a620fc030529\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/error.js\":\"d15e0b6f879694cb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/lazyMountRegistry.js\":\"4b825dfe0fa779e1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/suspense.js\":\"d91e7e3647a80e03\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/CreateWorkspaceDialog.js\":\"9e208f0f6ab1e012\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/PendingInvitations.js\":\"c539fd884ec4fc1f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/SyncProgress.js\":\"4c599197f08afdd2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/UnlockProgress.js\":\"3f3b705047070f10\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceKeyGate.js\":\"b2fee3b105445872\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSettingsDialog.js\":\"458dc9836762b150\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSwitcher.js\":\"70c0c4aa5d512423\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSyncGate.js\":\"75bf8e0cb4dc3bb3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlow.js\":\"6d699187f88ddbd0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlowHost.js\":\"376d5c5d824e9d2a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/EncryptionSection.js\":\"5732b61cc9043abe\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/attachmentPrompts.js\":\"8649dacfd334a8b7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2c13abd8e339ddf7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowDeps.js\":\"9717dfac56382796\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowStore.js\":\"41a1f7c4b7a248f6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/flowUi.js\":\"048eefb748deb22c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/useConversionRun.js\":\"57cbd7740e1ba3e8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/keyUi.js\":\"f6110f098ff8f451\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnKeyLoss.js\":\"a7d7c9eb7f1eca21\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnServerE2ee.js\":\"ee713c20b99c4675\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/workspaceUnlocked.js\":\"85fcd23c6bfdddd0\",\"/knowledge-medium/pr-preview/pr-1788/src/context/backgroundSubtree.js\":\"cb2446eb51ed1261\",\"/knowledge-medium/pr-preview/pr-1788/src/context/block.js\":\"262ea5f5a651a9df\",\"/knowledge-medium/pr-preview/pr-1788/src/context/layoutWsContext.js\":\"0e6e3b16b2162092\",\"/knowledge-medium/pr-preview/pr-1788/src/context/propertyDisplay.js\":\"faf55de4f649aa18\",\"/knowledge-medium/pr-preview/pr-1788/src/context/repo.js\":\"e51480c5c8a30020\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasClaim.js\":\"1699c11e1c334f5d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasSeatNamespace.js\":\"22aa0de645e63279\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockData.js\":\"2fd9c6e598467b1a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockType.js\":\"61d3c2b3bde520ba\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/changeScope.js\":\"5078bcf86493da1b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/codecs.js\":\"34a33ca7936605ed\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/derivedData.js\":\"0ea5d152224a8804\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/errors.js\":\"55873552dff591c7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/events.js\":\"29b551a3987918fb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/handle.js\":\"7ade744fd380a3ea\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/index.js\":\"d2de546f2e054b99\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/mutator.js\":\"b50cf208b5b559d3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/processor.js\":\"960b6e7720ac87a1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/propertySchema.js\":\"e23426c7f2d95df8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/query.js\":\"3e57d74b89f74652\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/sameTxProcessor.js\":\"3ad7720491c3f176\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/schema.js\":\"7ade744fd380a3ea\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/tx.js\":\"7ade744fd380a3ea\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/typedBlockQuery.js\":\"3a92dbe2219b99e6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/user.js\":\"725b5a2163311c55\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresetCore.js\":\"920607e6738acd18\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresets.js\":\"9d2ba3d4ec86e81c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/attachmentCleanerIOVerb.js\":\"742648e0a2925b69\",\"/knowledge-medium/pr-preview/pr-1788/src/data/block.js\":\"e4636f94aa8ddad9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockCache.js\":\"ade37584693bb49f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockId.js\":\"e04a61e526dec206\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockLiveness.js\":\"cae67314be9dd6c4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockMerge.js\":\"368b8b6bb1dbfa3c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockSchema.js\":\"e89af03c967d8e67\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockTypes.js\":\"0cf99a7f3ee76846\",\"/knowledge-medium/pr-preview/pr-1788/src/data/clientContext.js\":\"e39a301b7b305579\",\"/knowledge-medium/pr-preview/pr-1788/src/data/dbFileSiblings.js\":\"99808d4e4fb9c48c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/definitionSeeds.js\":\"d11ebc67a7e21fde\",\"/knowledge-medium/pr-preview/pr-1788/src/data/derivedIds.js\":\"f2f28b2c3b0c0272\",\"/knowledge-medium/pr-preview/pr-1788/src/data/drawnSubtree.js\":\"2190f0fc044af1a6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facetBridge.js\":\"f2ff849fcc578b7f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facets.js\":\"9772c33c9718209c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/globalState.js\":\"42be9ed5db27bf3a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/aliasClaimRederiveProcessor.js\":\"4b09695372068fd7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/ancestorBatch.js\":\"51ddcfb50a753da4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/blockTypeTypeifyProcessor.js\":\"30f3984287750c6d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/clientSchema.js\":\"8a86d0d895bb449a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/commitPipeline.js\":\"9bbabe957c64f6af\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/devAssertions.js\":\"35ba739ddc1f02c1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/firstSync.js\":\"c9cc367e319bf4bb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/freshInitialLoad.js\":\"548fad286dffeab7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/graphBackfillClaim.js\":\"7f6119a542627433\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/handleStore.js\":\"056de6c894cdabc5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/idleMarkerJobs.js\":\"7c5063fe2a859b48\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initialDownload.js\":\"eebc45f3f4e6d607\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initializeClientDatabase.js\":\"65e0832f9c35c2d5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/jsonCanonical.js\":\"6fcc073a1ef9450d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelInvalidation.js\":\"7ec54e059105eeb2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelProcessors.js\":\"c5f8be4767ed7cf7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelQueries.js\":\"05079fa1ce9e14ed\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/mergeTypeMembershipProcessor.js\":\"ab0f289bc8b945a6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/normalizeReferencesProcessor.js\":\"8dbdceaf643f4a31\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/poolInstrumentation.js\":\"695c019214468858\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/processorRunner.js\":\"1363988782781aba\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCell.js\":\"ec5bf01bde29722e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCellBackfill.js\":\"e31ca995a633b6fb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildMint.js\":\"054f1b5a4b6773bf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildrenProcessor.js\":\"ea9026d12ba27c47\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionChangeProcessor.js\":\"59be0c71c9d128bf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionSynthesis.js\":\"5127461e49b3ce2c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyKeyScan.js\":\"4844d56cf65d3e47\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertySchemaResolution.js\":\"72bc907f83e7c882\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/raiseProtocol.js\":\"f74386f3305707e0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/readBatch.js\":\"52fac1f8bf4d0dbc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/refProjection.js\":\"bb7e775ec55d4e6a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetLookups.js\":\"05932c219c4b9319\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetProcessor.js\":\"9f66d530b2f28131\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/replayMerge.js\":\"933e37f66fb8eef5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/sqlBinds.js\":\"3da0d253e302ee22\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b64e6683deb37798\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/arrivalProcessors.js\":\"86914dfdd8b6c285\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/invalidate.js\":\"11b56a684563a86a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/materialize.js\":\"df129b362ed6d2d8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/observer.js\":\"9a9765d93fd4a299\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/reconcile.js\":\"5cf9f5f999921c13\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/timingMetrics.js\":\"29f365750ef8a41d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/treeQueries.js\":\"22721f6971317af4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txEngine.js\":\"fdb1e914a80f7fa0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txSnapshots.js\":\"670aa11cfd792386\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/typedBlockQuery.js\":\"c10f735bd1ba7cf8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/undoManager.js\":\"19f4659f30990747\",\"/knowledge-medium/pr-preview/pr-1788/src/data/invalidation.js\":\"9d4ca047df2c334a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelDataExtension.js\":\"df47a5d7ac8010a9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelPage.js\":\"9ecf808fb5f5caf5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelValuePresetCores.js\":\"dea6b37a79eefeb2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbCorruptionSignal.js\":\"1f8bbaee507c2c71\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbStorage.js\":\"b01672823678e0e7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbVfs.js\":\"329a365697c273bf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localSchema.js\":\"51ea03999ca2accc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/maintenance.js\":\"399a50b80ad8ef1b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mergeProperties.js\":\"b4243e0704a4a4ca\",\"/knowledge-medium/pr-preview/pr-1788/src/data/metricsConsoleHook.js\":\"9bc283ef2ce19eef\",\"/knowledge-medium/pr-preview/pr-1788/src/data/migrationsPage.js\":\"b122b7e319d6a560\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mutators.js\":\"dbd588a630aa509f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKey.js\":\"5e99c65dd49e0b88\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKeyPlacement.js\":\"41853ad341a33942\",\"/knowledge-medium/pr-preview/pr-1788/src/data/outlineSurface.js\":\"827bca0f92271057\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingEditorContent.js\":\"4760b97322328473\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingUploadsSql.js\":\"ee5b4954a9869b42\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pluginStateExtensions.js\":\"2e25ad15f2cd5a36\",\"/knowledge-medium/pr-preview/pr-1788/src/data/powerSyncLogger.js\":\"b698198c621e8d5b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/projectorRuntime.js\":\"fd7f66052c58b525\",\"/knowledge-medium/pr-preview/pr-1788/src/data/properties.js\":\"d119a24963467d5f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertiesPage.js\":\"3212512d90b75538\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyChildren.js\":\"f3f15512f9622bcb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionFanout.js\":\"31b75bffa177aada\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionMetadata.js\":\"e82c47a508989049\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionRegistry.js\":\"64241b3f1de4886a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDisplayMode.js\":\"808615962a86f3ae\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyRowCreation.js\":\"9cb4991c3e0426f6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySchemaCreation.js\":\"fc901e7218c5796c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySeeds.js\":\"83d0c78c3cfa37f8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/recentsPage.js\":\"748a73d6d791808c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/referenceBlock.js\":\"7c12a84aedc5fe90\",\"/knowledge-medium/pr-preview/pr-1788/src/data/releasePowerSyncConnection.js\":\"5c66ff4ff3e5d6a0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repo.js\":\"3225b3670bfb5949\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repoProvider.js\":\"62359243a049e1c1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/rowProperty.js\":\"736b379b7fe44f44\",\"/knowledge-medium/pr-preview/pr-1788/src/data/searchFilter.js\":\"b2df36c7f0a461d0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/seedIdentityLedger.js\":\"bb74ce54043fb07d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/stateBlocks.js\":\"ecff76320d4bf346\",\"/knowledge-medium/pr-preview/pr-1788/src/data/structuralEditPolicy.js\":\"bd1dbf3b8a2f9029\",\"/knowledge-medium/pr-preview/pr-1788/src/data/subtreeDelete.js\":\"5ef3ec7c45f5b97b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncStreamLock.js\":\"e3d2c15e2462fb6e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableSqlRecognizer.js\":\"03794fdbf281ff97\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableWriteGuard.js\":\"228c6e6bd4a1e394\",\"/knowledge-medium/pr-preview/pr-1788/src/data/targets.js\":\"aea753730328c37f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeColors.js\":\"339b5035b8f6e48e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionMetadata.js\":\"a2570f68ccbbb328\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionRegistry.js\":\"d41f4f1169a7267a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeExtraction.js\":\"420d752f0337e86f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeInitialValues.js\":\"b8db203731cd8f76\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typePropertyGroups.js\":\"b8e653d9c9aef9e6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeSeeds.js\":\"b98c26edd6f88b96\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeTagger.js\":\"bfd58f8e462cd0e3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typedRecords.js\":\"afc201b0095fde42\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typesPage.js\":\"37e40c1ee5e7ccce\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userPrefs.js\":\"423007f8da1e602a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userSchemasService.js\":\"049d0a70a385aa37\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userTypesService.js\":\"1a080a51a35b469b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/valuePresetRegistry.js\":\"396637b4b62d70d8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/visibleChildren.js\":\"e1b77cdf8144c45e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceConversion.js\":\"5249a1c4afe6d52a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceFirstSync.js\":\"84043ad58f76a308\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceIdNamespace.js\":\"a252dbd34a503feb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceSchema.js\":\"8d7f188c52e3621f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaces.js\":\"759b29ba8caaece8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadLog.js\":\"91985e8e05eb1d0a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/BlockPasteShellDecorator.js\":\"828b677e2e72a85d\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/atTrigger.js\":\"d0292ceb9f4f8e31\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/autocomplete.js\":\"312f71b64bf589ff\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/codeMirrorExtensions.js\":\"dd8daaadd271cc38\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/contentFlush.js\":\"db98d4d592ff4332\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/defaultInteractions.js\":\"7dae41dafae36a62\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/editSettleSignal.js\":\"f6fb180bc19efdf1\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/insertImage.js\":\"fffe94a8a670c71b\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceCompletionRange.js\":\"7eed00a2c71245de\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceTargetTypes.js\":\"2932ad5cbbd1ca9e\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/syntaxContext.js\":\"0348a3ccd8e77e7b\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/triggerMatch.js\":\"436966a911af1af3\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/AppRuntimeProvider.js\":\"3bb88e3f24c321e1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/BlockFocusShellDecorator.js\":\"d85e7ae64271b886\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/ExtensionRenderBoundary.js\":\"4a5e5678c3f28793\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/PanelContentRecovery.js\":\"ae63e435cec59458\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/apiCatalog.js\":\"dec954b1b006c547\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/approveExtensionHere.js\":\"7e49d79060ca0b19\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/armedCutAppMount.js\":\"ccd7fa15cb425939\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/batchableKeyedStore.js\":\"41067469c5e36bcf\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockInteraction.js\":\"b8d2cf7a90db178f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockSelectionAction.js\":\"f6b26aa68b48c37c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compileExtensionModule.js\":\"e895a4fc9bc1fddf\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compiledModuleCache.js\":\"6f3a30b301ecbba3\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/continuousGestures.js\":\"586f5dcb44097824\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/core.js\":\"9900150e31f31d15\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/defaultRenderers.js\":\"8b82ff80b4e2d9ec\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/definitionFanoutAppMount.js\":\"590d8ad854154724\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dialogAppMount.js\":\"083e17424f6409fa\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensionSeeds.js\":\"93099a0c478f2388\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensions.js\":\"e2f608c8048c54cc\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/exampleExtensions.js\":\"a0ea0a6ea104b9c1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionApprovalStatus.js\":\"695ddc8c635f905d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrorToast.js\":\"903f50b5f54abd8b\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrors.js\":\"35b493e66422f5cb\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLookup.js\":\"f00831ce62ded1b3\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionToggles.js\":\"44b58d0d2d1ed581\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionUtilitiesCss.js\":\"dac15b018ce66462\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/kernelPageDeletionGuard.js\":\"c6d7389c192977be\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/liveRuntime.js\":\"8a34ee8d4940752d\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/openExtensionsSettings.js\":\"6b789a01b37224d4\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/overridesCache.js\":\"ce4a79b3766112d2\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/pluginIds.js\":\"18c0448d011bea6b\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/processorRejectionToast.js\":\"62887041def4bc38\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeActions.js\":\"0e831849cd62903a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeContext.js\":\"d0a5cc6c3f0dc56b\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticAppExtensions.js\":\"18a855e51ab08d98\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticDataExtensions.js\":\"4abbaa66a44084b5\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/toastAppMount.js\":\"65034a85c35e9878\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useOverrides.js\":\"2110c77d4bb14eb6\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useShortcutSurfaceActivations.js\":\"eea31409598722a7\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/discoverToggleTree.js\":\"70d2a77548e8c25b\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/facet.js\":\"244604041b7c059b\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/resolveAppRuntime.js\":\"9a8e5a2d4840e633\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/runtimeEvents.js\":\"09ee9d82b87e243d\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/togglable.js\":\"6536cc79809956a0\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/variantFacet.js\":\"ab4d448f64a2847d\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/verbFacet.js\":\"aab7db660fc62cbb\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/block.js\":\"3f0f4725ad2c72dc\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/focusedChild.js\":\"4948b05d348845e1\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/propertySchemas.js\":\"674c7e96d54be427\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/typeRegistry.js\":\"9052fb81cc79bf44\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAncestorCrumbs.js\":\"7aa7ed8c795fc4fb\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAutocompleteListbox.js\":\"295f32801f4acafe\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedSearch.js\":\"f1adfaddac4b5054\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedValue.js\":\"e9fbb6debf69429a\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsFocalRender.js\":\"d6250fa0761d2244\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsReadOnly.js\":\"ef419f8b31f6cd27\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMaterializeBacklog.js\":\"2b6d412dbc4d5f5a\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMinuteClock.js\":\"7f23df62fd408207\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePanelLayoutProjection.js\":\"cc61125b5163bae8\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePendingInvitations.js\":\"dcb7175936e42f60\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRendererRegistry.js\":\"6a7483e1d20b4595\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRetainedFieldRows.js\":\"ca113e0c1c46669e\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useWorkspaces.js\":\"42b8586439f99383\",\"/knowledge-medium/pr-preview/pr-1788/src/lib/utils.js\":\"c8a3351dffa57974\",\"/knowledge-medium/pr-preview/pr-1788/src/main.js\":\"5f33706fb9051e59\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/MarkdownImage.js\":\"3196a05cc6453e79\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/blockSeparators.js\":\"5d4ee1cb2ae526e3\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/context.js\":\"a76370d64859d39b\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/defaultMarkdownExtension.js\":\"355028a3e6664293\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/extensions.js\":\"33d9c1e86d6f7489\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/renderMarkdownHtml.js\":\"9583de6cac3ed2bb\",\"/knowledge-medium/pr-preview/pr-1788/src/minimal-editor.js\":\"abe6cac4ad210f8d\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/armedCut.js\":\"7e7d03df91ec9c40\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/captureMediaVerb.js\":\"9d7279d1db0af57e\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/clipboard.js\":\"7d88b9471daa5bbd\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/decision.js\":\"b5467958d974243b\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/operations.js\":\"a1bda5e5dc51d1c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/AccountHeaderItem.js\":\"51576ae8bbf65e91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/index.js\":\"a855bef0d0a05d53\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c3086f896327f025\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askAgent.js\":\"9faf48dcef5084f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askedStore.js\":\"7e053c38d627b93f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"050cc2b66060f549\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/chipState.js\":\"36ad50b05f08a83e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/dataExtension.js\":\"724b02ab8526bb15\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/index.js\":\"641be5984977f8b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"82d342d8456c2706\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/schema.js\":\"d08e7a26aa495958\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/AgentTokensDialog.js\":\"fbfaa1f9b7bd27c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ad94345666264c0a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/addMedia.js\":\"bb5ad1afc960c1c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1b6be22986344d69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/block.js\":\"09f67411a82da02a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/context.js\":\"433b48f3f37b65ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/displayIds.js\":\"17cd0df0aedce884\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/index.js\":\"d76cfd7c5f0f8d83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/outline.js\":\"0aff7f25cf0cc036\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/properties.js\":\"ad18442478a18eda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/refs.js\":\"decfd000b7b0dfa8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"41f6ecd89cb3eea4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/search.js\":\"b78952feb9a4ca4b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/shared.js\":\"62727eba551ace11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e914fcd53ac9e6a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/text.js\":\"f6e26b986e72869e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentWrites.js\":\"e9e5973ab841d387\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/authoringCatalog.js\":\"d6ce9f9a3634e064\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/blockRefTargets.js\":\"6e76cce93340445b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridge.js\":\"21cfea2fd34d569d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridgeLoop.js\":\"56b8caa0a1ed2c55\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/changeHistory.js\":\"426efff4ecde0e2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commands.js\":\"f547f48200ba3f85\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commentsCommands.js\":\"5a7fed3cf5c41932\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataExtension.js\":\"c86825b57e4733c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataModelGuide.js\":\"89fddb714f43e1e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/describeRuntime.js\":\"a654ee50ebfe37e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/extensionLint.js\":\"6c2a41ea646122d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/grainAudit.js\":\"5f293df206612c32\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/healthCommand.js\":\"d760194c8a327b52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/index.js\":\"9c990e737c561c5d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/presetIdentity.js\":\"e0c6cdaeb56e2cf7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"542902dd09e58b96\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/readMedia.js\":\"24704c5202fa965d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/schema.js\":\"13780f4bbf1ab2bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/serialization.js\":\"f61eff2f3a2cc099\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/targets.js\":\"695adb9372d5dce5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/tokens.js\":\"362950e47ee2f319\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/watchEvents.js\":\"846f57565499c392\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/workspaceGuard.js\":\"91cd9eca628384fe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/writeCommands.js\":\"a18c499210c35e5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/AliasCollisionToast.js\":\"b74c4eff4901d9ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/DuplicateNameBanner.js\":\"03fa15ca7cf1827c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/collisionMerge.js\":\"f353a88bbcf834cf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/dataExtension.js\":\"05dbdeb975ecc633\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/index.js\":\"4ea73d8f873efa81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/mergeCollisionAction.js\":\"e8e428a959933e18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/pageStyling.js\":\"69e7dc158ad9b2d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/rejectionToast.js\":\"84153e26510dbe26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/syncProcessor.js\":\"9dc341eaa20519dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/actions.js\":\"d7b10a51eb711c7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/addComment.js\":\"5cfeffc85a22cc04\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchor.js\":\"3fab3d70ba7cd0e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchorState.js\":\"e95b18f30d2c2ccf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/commentLinks.js\":\"f089b5daaf14a56d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/confirmThreadDeletion.js\":\"270da18d0a4cd1b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/container.js\":\"d018e2d355503bfb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/dataExtension.js\":\"1de726ae8e046fe4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/deleteComment.js\":\"e0198111fad63ac6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/highlights.js\":\"b99f96584a2c88aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/index.js\":\"31890a3dc1cf81bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/linkedCommentsPill.js\":\"c16fbfdd607696ac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/margin.js\":\"564350e6d2c10739\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/marginSchema.js\":\"c3396e6e4d71b140\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/newComment.js\":\"ad255a8d855a8e69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ownThreadPicker.js\":\"72f170f4de480f5e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/placement.js\":\"259b3fa0bf2b58e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/queries.js\":\"d4e7f2e7092a918b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotePosition.js\":\"f10c4a84d32111d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedIn.js\":\"706e7768e5b52e04\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedRange.js\":\"570f31e4863bdbc5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/rangeRefs.js\":\"f19b398b7e0f8dd3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readHighlights.js\":\"7e971faf1283beed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelection.js\":\"8e937754b9df5e2d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelectionUi.js\":\"06649d00926089db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/reanchor.js\":\"19d5b67b4d427b01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/schema.js\":\"06dd568fe8e280c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scope.js\":\"77238699babb929a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scopeThreads.js\":\"b1b8f2f35d21564f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/splitRetarget.js\":\"28355309860b3110\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestionCard.js\":\"237ae19279385d61\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestions.js\":\"c77c0d903caa9d89\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaries.js\":\"7b083727e613e7a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaryBatch.js\":\"52fb400dbb45b462\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/surface.js\":\"f1547338f885391d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threadNavigation.js\":\"8583b6528ccaf9ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threads.js\":\"a9f7e2e201724f43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ui.js\":\"1a0ee9f89b59ff3e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/uiStore.js\":\"13caca026a58bdbc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/appIntents.js\":\"2571dbffb380c584\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/index.js\":\"952c9b05154d2e93\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/index.js\":\"0d1bf139d56d4705\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/status.js\":\"7dcdbe73346acb01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c551119dd795da31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaBlockRenderer.js\":\"03869af0f5ba49db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaDownLaneReplicator.js\":\"89ca54e924185675\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaUploadReconciler.js\":\"39b15997826d43af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetDownLane.js\":\"be76255b9997d0c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetResolver.js\":\"cc988030d8d9bc90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetUpload.js\":\"2567d925d2f046a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/attachmentCleanerIO.js\":\"fdd5ae8613485314\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8fc0d25bb3347364\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/blobStore.js\":\"8be29d0a53da529b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/byteStore.js\":\"019c0bd99edd3ed2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanerIO.js\":\"96cee335640e5ecd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanupAttachments.js\":\"19ea8c610ee0c06a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/dataExtension.js\":\"ca1a378ae88ed497\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/downLane.js\":\"f63b457d8aefbb0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/index.js\":\"e173b52eaa18b696\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/insertImageContribution.js\":\"bed78eaa6ad6d808\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneArming.js\":\"03e1bf885a1e7a72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneLock.js\":\"c96a479a25a4ee9f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaBlock.js\":\"dce9fac74ffab286\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaCapture.js\":\"09cdef5190dfaa2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewers.js\":\"2ccaa677c8f854e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewersFacet.js\":\"3b6904e9f0ed5367\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/pasteCapture.js\":\"ada76bd5dc2827e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/resolver.js\":\"a31f2fdcf84a6148\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/retryUploadsAction.js\":\"2c22345f830432be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/storagePaths.js\":\"2accf47f4ec240f1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadDrain.js\":\"dd20985c7261d1d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadLaneStatus.js\":\"48c8962e8952e938\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadReconcile.js\":\"d563b8c9dc13e92c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadRecovery.js\":\"c796f4b3d78f1c18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadStore.js\":\"09505c237fd62bdc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/useAssetObjectUrl.js\":\"f4d311a9b30bfeaa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4b83742b84973722\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b9f6084662155d11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/facet.js\":\"1995414546302bea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/index.js\":\"b6137b391f3e38b1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/prop.js\":\"48d6144fcedc9897\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinkFilters.js\":\"42f8f8851632c14f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"385408be50e1f7b5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BlockEntry.js\":\"7d1d4d600b699f12\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/LinkedReferences.js\":\"41e5e45a547eff84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"52923029e1db65c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dailyNoteDefaults.js\":\"303d858f86f5b9b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dataExtension.js\":\"8d81ba4c30d4df2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/edgeExclusions.js\":\"7ebe776e5ef033c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/filterProperty.js\":\"121a79eacce14951\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/index.js\":\"15a77482224d8c23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"8a495d88a13aa257\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/applies.js\":\"9f7c58ecfcfe265c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/countQuery.js\":\"d1583d74b92fdc6e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/expansionStore.js\":\"24e0ff0b7e6ad1a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/index.js\":\"60867fbc9287cbe7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"151b742287ad442d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/presentationInvalidation.js\":\"b213949d0f7f6061\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyEditorOverride.js\":\"cd7beae87c0dcaa0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyFilter.js\":\"f9ab7f1536770425\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/query.js\":\"a665ca55d04084b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/resolveFilter.js\":\"7185b61461543f9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sourceBatch.js\":\"3195b47103830bea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sources.js\":\"de4fe94e349c55a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useBacklinks.js\":\"328c964b208a90f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c9cdea8fd1acc61f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayCelebration.js\":\"28e22ff15a591da8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayOverlay.js\":\"e25bbc3a26e79e12\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/gate.js\":\"be8d9e8fbf8ced1f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/index.js\":\"2a47d0b315c6a0b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/wolfTheme.js\":\"f0c33bab8b3cb3b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/BlockDragLayer.js\":\"d6c0547b67edc0ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dragController.js\":\"39b2f3656347d437\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dropTarget.js\":\"5f1328d7f34ee68f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/index.js\":\"f84e1df263cb14dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/projection.js\":\"ac201028b8330939\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/BlockMetaCard.js\":\"bbc8afc70ccde50b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/index.js\":\"aa4f374326e28809\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/AddTagDialog.js\":\"bf6d4db546fef2f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"9c0c20a652a3e0ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/TagNameIssueHint.js\":\"a265432fe1424919\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/addTagAction.js\":\"000fb64b3851bf1f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/appendTag.js\":\"fdd03ba9a66ce644\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/config.js\":\"8c65f34c0d6b98d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/dataExtension.js\":\"43cf17f6d7e8151b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/index.js\":\"bd3237e4da275365\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/propertyEditorOverride.js\":\"032cee19dadb1279\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbList.js\":\"fbe74784fd0540aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"aa50ceb1969777d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3497f2e7445c041e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ce6af1cb846bc9fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"799d6b80c299daa1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/index.js\":\"3efcf6f9a74be88c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c22febcf3c673d08\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/CharacterCountItem.js\":\"af13631ecc828f3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fa2dcc19d486e95c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/actions.js\":\"34aaebc03d34ba01\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/blockType.js\":\"b3066a2c5f600aee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/charCount.js\":\"cd5f35ea0e1ee70c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/dataExtension.js\":\"93294273b9cee063\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/index.js\":\"9bea655ddb55b825\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/profiles.js\":\"173e81b901c146d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/properties.js\":\"39dda8505137fa6c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/textCounts.js\":\"29cbd37f460117fd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/colemak-keybindings/index.js\":\"697ee114bb4e4e89\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/CommandPalette.js\":\"27a526b0c21b9b10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/HeaderItem.js\":\"09961c07abc0030f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/context.js\":\"555bd6d8c4e5644c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/index.js\":\"913202423204e803\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/selection.js\":\"0c00e3cc33163781\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/toggleStore.js\":\"19c2168f3792513f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/useCommandPaletteActions.js\":\"4ab6fc7416f13c95\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/ContributorBadges.js\":\"8de22dcbe43e7a8a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/author.js\":\"497ebddd9490164c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/codeMirrorExtensions.js\":\"5c441310b1f81822\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/dataExtension.js\":\"2426d68fbc256060\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/index.js\":\"98c977e8f0344d85\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/mentionAutocomplete.js\":\"3af4ba665a9e4654\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/processor.js\":\"5317ce35fbc8f9e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/profiles.js\":\"246cab932c598a1e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/queries.js\":\"ee428ac6c7295237\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/schema.js\":\"4da9ee66f54e9b4a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"76f1de0a7cdd3266\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/followOrigin.js\":\"250713221fa886e2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/index.js\":\"3b70ea2a78efb802\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3e1c6c0111b7bcd7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"51d57577d5d793c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/CalendarGrid.js\":\"a78a3a7100a4c834\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DailyNotePicker.js\":\"2392c5bab4a01c00\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c706256cab4ef9f4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateNavDecorator.js\":\"d0d76bdac56166e5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateScrubOverlay.js\":\"319ab4dc0bbf79ff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/HeaderItem.js\":\"58696412da2898e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/ReschedulePicker.js\":\"e04d969178175a29\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/SpreadDatesDialog.js\":\"77059113f6ebdc7a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/actions.js\":\"85f7304a384c9671\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/blockDateAdapter.js\":\"1950832a2a868dce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/calendar.js\":\"b61cf250dd814b6a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dailyNotes.js\":\"507fa4920972d22f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dataExtension.js\":\"f47d8f387a1348ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubActions.js\":\"493103cc4ef58649\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGesture.js\":\"d9324b7027ea3fc0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGestureActions.js\":\"de022342d13f507f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubRecognizer.js\":\"20cb125b29f4d2bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/deletionGuard.js\":\"9a04068b2a1d5093\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dueQuery.js\":\"dac68c8b6adaedf5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/index.js\":\"fc517546ef0b5997\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/landing.js\":\"eae2cfcce91cd0a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/localSchema.js\":\"286f74805ff8dca1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/referenceDateAdapter.js\":\"ab3fd006cf4928dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/rescheduleAction.js\":\"d249cd3ce315b977\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/schema.js\":\"8f7fff624447ef06\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadBlockDates.js\":\"a82e59d2f964aa38\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadDatesAction.js\":\"85a774dcc8e0d6f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/today.js\":\"baa410099182b6be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d2d689e05d3b5194\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"fd9fde1cf083d045\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/audit.js\":\"1e9d74517dc83ec1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditAction.js\":\"99b7d4803e3af789\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditRanges.js\":\"d1c6609a2a5e2dc2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/diagnosticsSource.js\":\"62d8e2b45b09dc14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/divergenceScan.js\":\"30a21ec54dd322d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/index.js\":\"7caf6c70bfe9810d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/propertyChildrenChecks.js\":\"de943e78cfd2b1f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/referencesMirror.js\":\"8d5d62b19130201c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/rowJson.js\":\"f1649feb49b71bf5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/schedule.js\":\"d6e7ea2d491b0587\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/store.js\":\"4a21e935d150d2d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/action.js\":\"58f8d7c7c6e7cb32\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/index.js\":\"2df0d952875a137c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/plugin.js\":\"cc8110177527b489\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b695792dc3b81889\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/actions.js\":\"37eccf0a536eb522\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/changeMarker.js\":\"a7d675be31c6c088\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/diagnostics.js\":\"4d9e753e5ea9edc7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/fileSystemAccess.js\":\"c7a54db143198ca0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/filenames.js\":\"9b9dabbb783c07f4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/index.js\":\"ef20aa80d8d610ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/mirror.js\":\"a6beb572d07871bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runLock.js\":\"64bf1c03aa5a35b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runtimeHealth.js\":\"c65b24b1fa3bbcf7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/schedule.js\":\"c467f8077b34cd6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/store.js\":\"5be1d6db7762d216\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/index.js\":\"615a8761c4eef822\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/themes.js\":\"a31560e3926b8540\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/facet.js\":\"9a4f179a88db7bf6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/useDiagnostics.js\":\"35786bcc2ee78aa7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/dismissals.js\":\"4646a69db0fcebbb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/index.js\":\"89015be7a93a385e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/status.js\":\"26b12432e4f6baa2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/store.js\":\"bd16c70bb3dd99fe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a777dba0bd4de969\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3731706c576ab181\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/actions.js\":\"e8dc5a4b96bcd2e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/config.js\":\"ca044719d542ecc4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/dataExtension.js\":\"a02203d2557c2b1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/effect.js\":\"3816ff126bb05287\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/index.js\":\"8bbe68eeac5db579\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/propertyEditorOverride.js\":\"77d3f8555f4b9a6f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/useToggleTree.js\":\"3775a3b2eecf2c03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/ExtractTypeDialog.js\":\"0b69c0ca114adb31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"1df14136ec8026c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/PropertyShapePicker.js\":\"6d6767c3ab741f8c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/action.js\":\"69de37f4c38194c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/index.js\":\"c3fdd8da307d3043\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/FindReplaceDialog.js\":\"44c271d4a8a331eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/HeaderItem.js\":\"750c3c0e079bb0cf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/dataExtension.js\":\"dda46211c3b2b807\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/index.js\":\"cfd11ee48deafff2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/search.js\":\"dc64d2e9a7a8f3a4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/toggleStore.js\":\"88ded751f645ebe6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/LocationPropertyEditor.js\":\"ac4ef8b121910476\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/MapView.js\":\"f570b3750383ec15\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/blockTypes.js\":\"b659c85308387c9d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/codeMirrorExtensions.js\":\"009a071611f20afa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/createOrFindPlace.js\":\"d9208c5455be9bfa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/currentLocation.js\":\"25514602c3b49072\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/dataExtension.js\":\"9d8ea5ecc0353b14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/geoContentDecorator.js\":\"a61f355bb1ff5b18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/googlePlacesClient.js\":\"62cade7b13312aaf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/index.js\":\"bd5c6ff8f783b106\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/locationsPage.js\":\"4c6f324479610855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/mapViewport.js\":\"470f120e16409378\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/pickCurrentLocation.js\":\"4deac50305c96f6f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeAutocomplete.js\":\"470cf8a87c45c885\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeNameCollision.js\":\"c7b3e61b57bc6bc8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/properties.js\":\"c25f919e5ed8b4e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/propertyEditorOverrides.js\":\"4ffd2644d676e400\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/query.js\":\"776a5cdad1b667af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/usePlaceSearch.js\":\"84e486af91de2f7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"be99ecfc0a0c2e72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b600e4655d3f254f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"58a1f2cfd2beb067\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/config.js\":\"a78d22c139cfd106\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/dataExtension.js\":\"82e8f64f68703190\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/facet.js\":\"bcf41a7b698e690d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/grouping.js\":\"fd53fd04e85b3ebd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/index.js\":\"d4475aeba0ce1ac9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"32d3b549e8cdc037\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/query.js\":\"1626fb49b049c530\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/resolveConfig.js\":\"53e265394012af50\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3a251164c964b74f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"13cff94a9b629cfb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlDocumentContent.js\":\"b8fe81b1c95c5f63\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlFrame.js\":\"4697264fdea89518\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/actions.js\":\"473b9ccdc55ba801\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/blockType.js\":\"1192cb3a33659634\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/confirmRunScripts.js\":\"7720d1971a51f0dd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/dataExtension.js\":\"7ee69a262327f3e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameAnnotations.js\":\"77239094e2eac27f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameDocument.js\":\"4197da5ead684f2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameTheme.js\":\"3ddc6a14ba3e7e1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/index.js\":\"d9b521b8c278cfa6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/scriptConsent.js\":\"73b016a24a247f66\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/sourceMap.js\":\"6b0582efb2630585\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/useDocumentScripts.js\":\"0eee605d69734e20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/index.js\":\"34213748f4e73828\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/record.js\":\"91ae22143f36afe5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/recordStore.js\":\"16310dcd95cd61d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/responsiveness.js\":\"63991f95cb7e86d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/schedule.js\":\"989493af8dd2b259\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/sessionContext.js\":\"d78b6c0d01e1c7ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9acf254c6b23f09c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c7f5ffb40d3d5103\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/actions.js\":\"e5581ea381d6ecdd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/config.js\":\"f5249d3e772b17cc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/dataExtension.js\":\"84b8e91fa15210f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/effect.js\":\"ad6745a641fb69cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/index.js\":\"86b9187d01a7ba46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/keyCapture.js\":\"8753795e08f92c95\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/overrideStore.js\":\"00a71962a866c73d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a6a8254331e4ab78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/HeaderItem.js\":\"606f7d8e0b58fb83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/LeftSidebar.js\":\"ab33850ab15707bf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/actions.js\":\"de9c6f4986e1eea7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/facet.js\":\"bb1da159ea1b75a7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/index.js\":\"f458ad28f446a244\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/shortcuts.js\":\"8ea927c1e9c44820\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/toggleStore.js\":\"2476bf5f5b8855dc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/MergePicker.js\":\"989dd0bf30484616\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/index.js\":\"7e714c844a9f053b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/mergeAction.js\":\"c3c61ad8cf889af4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/strategy.js\":\"b33e8cf9613dfc3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/Button.js\":\"5ef68c57953c9a1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a226b2711803d545\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/defaultItems.js\":\"dd956cf2c1a46351\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/facet.js\":\"f758729274c77328\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/index.js\":\"22c7091a165e9cdd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b1f9d130ce08c0bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c05201c32d82eecb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2fea8f12138d1ea9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/facet.js\":\"574480b831eaade6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/index.js\":\"a8ba437bea246dde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ebb8eb3c3ae2c2b1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d9157962b57ea867\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/contextMenuItem.js\":\"6f1b95c8b1365adf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/index.js\":\"2caa927e4c53fa34\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveAction.js\":\"42c01b6ba7a55be8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveBlocks.js\":\"872c669b0c02b9ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/selectionAfterMove.js\":\"a770d0c03d5b4b42\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/TutorialBanner.js\":\"3ad3e80a16d9d5a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/action.js\":\"9d51b8818e356b3b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/bannerDismissal.js\":\"cc10d3cca8bb96a3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/documents/cheatSheet.js\":\"529a48cf999d1d0e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/index.js\":\"dad9d77eea488018\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/keys.js\":\"5d6490d87b8a586f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/landing.js\":\"187a5d0cc06e5a26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/outline.js\":\"26cc9ef77572fe17\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/seed.js\":\"f689cfb82347dad4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/PerfTrendDialog.js\":\"45120fb8697482fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/analyze.js\":\"13f29cf16ecb653c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/diagnosticsSource.js\":\"5de60aa003376199\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/index.js\":\"6c901fb4d8f5eb38\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/load.js\":\"8029d2a7ebe9d6ce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/monitorRun.js\":\"8a95ec06768b1e98\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/schedule.js\":\"43e21930fd872559\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/series.js\":\"ef9e97458c7a6f92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/store.js\":\"3b03606faee47c52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/trendAction.js\":\"9d68be89e4e566ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/verdict.js\":\"60498e23c83cf6d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/clickToEditAction.js\":\"775f885d6a35b8d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/index.js\":\"6ff076d49ff01577\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/interactions.js\":\"84f2883b6e91b731\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9040831712631e9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGate.js\":\"0e57b53cf9cacc81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGateDialog.js\":\"c3044fee10678342\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/action.js\":\"229f8f7b41e4d823\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/index.js\":\"0e21d07ef2d04bbc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/localRunMessage.js\":\"3157044ad876feb3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/plugin.js\":\"8665b0340db81758\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/progressReport.js\":\"878489b2e409a300\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/sweepProgress.js\":\"2986540ba59a689b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/FieldRowRenderer.js\":\"50baf216e851a3ee\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/ValueRowRenderer.js\":\"7d1274b91fe900b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/actions.js\":\"25ae817080f58baf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/autocomplete.js\":\"896d3d20e91597d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/fieldRow.js\":\"1e2b5dda9fc30754\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/index.js\":\"a5475fb3e534bc8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/referenceWarning.js\":\"40ba61ffb75909a6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueAutocomplete.js\":\"78713199de7c47b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueSchema.js\":\"516d5cec8a882147\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/HeaderItem.js\":\"04222a53d46e5af1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/QuickFind.js\":\"616ba9b47e026ffb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/index.js\":\"4773f2f9ea5aa7d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/recents.js\":\"c104c8d995d6bcfd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/resultItems.js\":\"90936f773107abc3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/selection.js\":\"b9fcdc3007df7f48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/toggleStore.js\":\"fa1676adda8fc025\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/HeaderItem.js\":\"ca6cda543e0a1ed5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d7270af4efcae5ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/grouping.js\":\"ebaa64794044b988\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/index.js\":\"c923e38bdc7f51c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/target.js\":\"c65e23bb1105e35c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/codeMirrorExtensions.js\":\"22f4743d320ecc73\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/contentPrefill.js\":\"3bc0ae8ba6bcb4d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/dataExtension.js\":\"b9f66defb8f6f4fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/index.js\":\"bd6b283a33e0d8a2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"82ae6b2fb7a27e80\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/invalidation.js\":\"74f79662c517b74c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/localSchema.js\":\"2cf3d13fd798a361\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/index.js\":\"bbb1991165afc892\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3d16da1c7b969082\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/index.js\":\"f82e75766d929cae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/referenceNode.js\":\"cc1cb16a3f12c227\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d6681a4c76874eac\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f64df42b40ebd998\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/index.js\":\"85e19c6d2ce0ad69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"59f03ae96f8ae67c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6e9a493ea652f400\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/mergeRetargetProcessor.js\":\"09e9ea477109e0d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/parseFence.js\":\"c332f8b3b5e7fd98\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceParser.js\":\"2dadc03f85fe1713\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceProjection.js\":\"d60ad4048a8060aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referencesProcessor.js\":\"3bda704e4c32fccd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/renameProcessor.js\":\"0ca65c34a87e5421\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/spanReplacement.js\":\"dc91f3e3a20b2d7a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/htmlToOutline.js\":\"1c71ba662c69798c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/index.js\":\"0cba758d4b99ebdc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/normalizeClipboardDom.js\":\"94b775bf02bd800a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/pasteDecision.js\":\"022aa6bef759f3f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/action.js\":\"dcdcc5d06eb5a596\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/blockIds.js\":\"fefd0b32d90e86bb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/content.js\":\"d520323ddf72f246\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/effect.js\":\"babed3072e028ae3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/ids.js\":\"0759da90b98b55d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/import.js\":\"1ae937640b52917a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/index.js\":\"158a808b6bc70f10\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plan.js\":\"4efb2e184115b26d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plugin.js\":\"785c194efb7dd893\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/promotion.js\":\"6ac8a1f6a0d21dae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/properties.js\":\"d4fdf1d34a9a4af7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/references.js\":\"06065e1efe336c2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/report.js\":\"e663a5b9b518421e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/roamMemo.js\":\"fb65e2daa072c4e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/runtime.js\":\"162c61e65164ed68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/schemaReconciliation.js\":\"9e7a3e23f3757927\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/srsMarkers.js\":\"21e2a8c9da862893\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/todo.js\":\"4b953e202c2232c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/typeCandidates.js\":\"0b444893dcdf3371\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/types.js\":\"187ed63d867c0c68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/index.js\":\"40271e91c818a40a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/store.js\":\"3d72de8da8b19e04\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/HeaderItem.js\":\"de1dd5a97cdd1dfe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7992efc4bfb451c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/index.js\":\"a8140ab8671f8df0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/model.js\":\"0b365b3fc6cc8f03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/toggleStore.js\":\"0ab84eb811e11a41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/useKeyInspector.js\":\"3f5589e88460f506\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"537a2df27fdacf41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/ShellDecorator.js\":\"8164ee292d09e108\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/actions.js\":\"222089477d78a173\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8cc8ee0db5b538fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/index.js\":\"766408b6cd3c33e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/shell.js\":\"caca4848f77764cc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/surface.js\":\"87f9baeb0f56e588\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/walker.js\":\"bbe076a8e03a201b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e7d516a596498b39\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/dataExtension.js\":\"01cd075231b5738f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/index.js\":\"67dde6bfd4d95053\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/indicator.js\":\"fbdf1cc04370b8cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/moveSrsState.js\":\"097f2f39a7551204\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"aa6ac9183ee864f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/scheduler.js\":\"44cce89fb7b87e92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/schema.js\":\"c3bb9cf4be6933ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d68072c06f7f633a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsClipboard.js\":\"9e892e16101365a5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e6d8f312c2ec65c8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6f15926f78576c23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DeckPicker.js\":\"37b2dc0a044464d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewControls.js\":\"38c32c4facc0bc03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2004294160b4b3ce\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewSession.js\":\"3e6ab3f5620b39ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/actions.js\":\"5a8549ee693f8f4c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/archive.js\":\"fb2195db50fa93f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dataExtension.js\":\"7ae352c205657484\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/deck.js\":\"7b2a1aa2fbad9750\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dueQuery.js\":\"b806439f1d6ed3fe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/gradeDecision.js\":\"c1d39187227e19d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/index.js\":\"8c27837b6ffa8452\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/keyHints.js\":\"fe1bc2d63e0f70d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewCardLayout.js\":\"6c6f5927e8120798\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewProgress.js\":\"e34077709685605a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/schema.js\":\"3df71fd766a492ff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/useDueCards.js\":\"131fe2a8d0076b91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/index.js\":\"139d0eda559da2d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/record.js\":\"42435bc64550dc18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/index.js\":\"b0e3c4f38111c337\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/persistenceStatus.js\":\"4afa3865cae63897\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/requestAction.js\":\"ab9289a3d37aeb73\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/TypeChipsDecorator.js\":\"5faaa3859eede7b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/codeMirrorExtensions.js\":\"b315643356608e1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/index.js\":\"7af85330e31a0af1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/typeAutocomplete.js\":\"88dd25f07eb37519\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9d39f8dac362ea0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/actions.js\":\"120e35c43278fbeb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/anchor.js\":\"6b13ff1be29c4409\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/events.js\":\"054ac4cd8fb49232\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/gestureActions.js\":\"3a0bbb21d69c6e0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/index.js\":\"6593c22fe35a7b5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"89ae32606e6e8694\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/collect.js\":\"d78330825da827ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/index.js\":\"03394ecc6c89448b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/record.js\":\"3a71f585a95e42a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/RejectionDialog.js\":\"47a8227cf4f07c0f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/SystemStatusHeaderItem.js\":\"eb310ab068ab9009\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/index.js\":\"8f5b3892733c50ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/model.js\":\"feceeebc4fdfb6f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/queueCounts.js\":\"9cdaefdf5aedee5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rejectedHelpers.js\":\"0a148372bc3c7799\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rematerializeAction.js\":\"fb14dca00d8119ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/useHysteresis.js\":\"c19b475ce0bde4b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/effect.js\":\"8012d6de350fc923\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/index.js\":\"b4dc7f5f5dd931d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/theme.js\":\"14e0e1f0bed9a1a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/actions.js\":\"75a0f596d7648f93\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/dataExtension.js\":\"9b06fac3c19d9698\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/index.js\":\"0d2fb1537404b24d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/schema.js\":\"0f58fe292de7ec23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6ebd8a71ac95eea9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/actions.js\":\"c80edd0653850a67\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/defaultItems.js\":\"c6fbfed49945dd92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/facet.js\":\"8d8b14b2b7be8572\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/holdRecognizer.js\":\"59f8ed63b248fb92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/index.js\":\"83b21e5dd0da8360\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/UpdateIndicator.js\":\"c7a6a658ef6b9c3e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/index.js\":\"ece83a6c125e28fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/loadTimes.js\":\"d5d561aeaf0a0ad6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoNotesRenderer.js\":\"65c07fb431dbac92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoPlayerRenderer.js\":\"ee3cfa6a6b792442\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoTimeStamp.js\":\"79d5dcd81713f145\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/actions.js\":\"36b6d34ed143a031\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/index.js\":\"8ffeb222944b6d42\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/markdown.js\":\"e54a4c58d23bf381\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/notes.js\":\"431c1abc007bfce7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/registry.js\":\"ce9f39994bf42c43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/remark-timestamps.js\":\"939a16887e40511a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/view.js\":\"182b0529c036bdfd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/LinkHints.js\":\"442f3f2babd4c100\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/index.js\":\"1c5970b8037a849c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/model.js\":\"b77cbf22f41092f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/settings.js\":\"50dbcc0e24c8ecc5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/actions.js\":\"7dc335cacbf33cbb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/index.js\":\"ce388b418fbb33a9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/interactions.js\":\"88f3ee7f4c16934c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/workspace-header/index.js\":\"4259d7a5c3b21dd5\",\"/knowledge-medium/pr-preview/pr-1788/src/registerServiceWorker.js\":\"8de8fa7d2977698d\",\"/knowledge-medium/pr-preview/pr-1788/src/requestPersistentStorage.js\":\"57c181f1d6920d1b\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authRequestDeadline.js\":\"4b8b3d2b09ba74e7\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authStorage.js\":\"afb461b5c1a6f2d0\",\"/knowledge-medium/pr-preview/pr-1788/src/services/powersync.js\":\"d0c394f99e62b614\",\"/knowledge-medium/pr-preview/pr-1788/src/services/supabase.js\":\"ed47b2cf97d449d8\",\"/knowledge-medium/pr-preview/pr-1788/src/services/uploadErrorClassifier.js\":\"af91d346631933f6\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/ActiveContexts.js\":\"39d4716a27edbb02\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/HotkeyReconciler.js\":\"da511565c1b4cd9d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/WipeLocalDataDialog.js\":\"e55f9d8353088bad\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionDispatch.js\":\"9dac8c13d35c3ddc\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionRefItems.js\":\"c0d580aedc219210\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/applyKeybindingOverrides.js\":\"9eea358637b3c38e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/blockActions.js\":\"cce2fa40c47ba5cb\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/canonicalizeChord.js\":\"457d354b1463bff8\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultContexts.js\":\"96b28d3a4244281f\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultShortcuts.js\":\"c83199855d59d068\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/effectiveActions.js\":\"daf8c53364848b1a\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureAction.js\":\"3ba73f6026213238\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureBinding.js\":\"d4725cc46c2511e1\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/holdRegistry.js\":\"dfddd2d09f89a3b1\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingConflicts.js\":\"e67a72103604b070\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingOverrides.js\":\"ee3b123dc244addc\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/pointerAction.js\":\"42a1ee210a45b27e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/resolve.js\":\"9ce209409eaceaeb\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/runAction.js\":\"c1e5150c3a0def8f\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/sequenceMatcher.js\":\"17b10ee3106bdbc2\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/types.js\":\"c632cc8f06a6629e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionContext.js\":\"356a170cca7f2168\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionDiscovery.js\":\"b7ad3df6bfa261a2\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/utils.js\":\"ab41c1c85230a4a5\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/bootStore.js\":\"b4b61731dba50552\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/previewDatabases.js\":\"edc8750181ef5df9\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/byteTransform.js\":\"fcbacd1dabaf56bf\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/attachmentCleaner.js\":\"3bc1b0b20751363f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/attachmentParts.js\":\"613994ad7949f068\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleParts.js\":\"d4fa69869895f480\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleRecord.js\":\"ee1fd9869a93e14f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/manifest.js\":\"e17c0a0e9759846e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/takeBundle.js\":\"3c0b6011585059b4\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/verifyBundle.js\":\"d673a9ce88333528\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/cleaningStage.js\":\"25250043eed6d4b3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionKey.js\":\"eb184d8b4aa9fce9\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionServer.js\":\"4bf46c419dc35829\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flip.js\":\"7a22a5a4aa1bb84b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flipAttempts.js\":\"3b922e1b2d209d42\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/pages.js\":\"1535808825949ddd\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/preflight.js\":\"d846ce7f9a43dd8f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/reseal.js\":\"d0abbd39c7b85043\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runConversion.js\":\"9b371d902fd85579\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runLock.js\":\"6022c86324cfc165\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealing.js\":\"e5f57292c276fd81\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealingStage.js\":\"5b18fe867787ada5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/stage.js\":\"289a25f4cdf8350f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/verifyReseal.js\":\"6a3303d6a7723758\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aad.js\":\"a461e5f898766a6e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aead.js\":\"8d3c1cf558dca5dc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base32.js\":\"ceac253f82af1af8\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base64url.js\":\"b59a803d4db72fc8\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/binaryEnvelope.js\":\"86d666ecedff0be4\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/byteAead.js\":\"f14c5f86e2bb399e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/canary.js\":\"86a64849444a89e7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentHash.js\":\"523296111c09a7c2\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentKey.js\":\"c87199be81ee3ddb\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/derivedIdNamespace.js\":\"565403757d0ecbfb\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/envelope.js\":\"89bc63f076696008\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/hex.js\":\"e2698312d2b2e28c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/sha256Hex.js\":\"8c36a19d57696a28\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/workspaceKey.js\":\"4a786c6432921954\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/conversionState.js\":\"cbe7a943b8b1c263\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bf21b5f2e99c231b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/pastedKey.js\":\"42541ee4e2da32ac\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a2ebe5218970a870\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e0c71b2a6b3f6cae\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/keyStore.js\":\"450fbd06709da81e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/mintWorkspaceKey.js\":\"5db5065ceb7b98fa\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/modePin.js\":\"f9e3f5e31ec86b0e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/openWorkspaceKeys.js\":\"bc664a8eb11c53f6\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolveWorkspaceEntry.js\":\"f1dc739e4b0ac2ed\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolver.js\":\"0f1d06be0f63a201\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/workspaceAccess.js\":\"a16f20715ec8ae5c\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/transform.js\":\"58e3124844619fed\",\"/knowledge-medium/pr-preview/pr-1788/src/themeBootDefaults.js\":\"a56a3028ad7ff816\",\"/knowledge-medium/pr-preview/pr-1788/src/types.js\":\"b12b536f73ec97db\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/ClientLocalSettings.js\":\"af2dd513367aff8c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/abortableSleep.js\":\"6cbbdbe45ac2c113\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/array.js\":\"f61cf2cace2c835f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/backlinkAutocomplete.js\":\"1d1628ada6014366\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockCrumbs.js\":\"c52d359ca6d9af84\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockrefAutocomplete.js\":\"966a237ab27f447c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/cadencedIdleJob.js\":\"b2532441edbe697b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/callbackSet.js\":\"0c316ad29ffb22a1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/clientId.js\":\"942655c4581281ad\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirror.js\":\"23d17ea88dc9cdb6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirrorCompletion.js\":\"beaa5c19542d428f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/copy.js\":\"9ae657f09d782214\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dailyPage.js\":\"7bb31797c285a0e8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensics.js\":\"28169cb77f53220e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensicsHooks.js\":\"a9d6ea8247a47bbd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/deleteBlockThroughUi.js\":\"b9150fdb7f38a390\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dialogs.js\":\"8157cb788a9fef0a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dom.js\":\"72ef6b84def54e71\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/downloadBlob.js\":\"0b4ebac417aae284\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/exportSqliteDb.js\":\"efe2d015c14462e4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fileSystemAccess.js\":\"e92706926950ddf8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/flipSlide.js\":\"5a5873c031f8dfb3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fnv1a.js\":\"50e09e6d20f3d44f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/formatBytes.js\":\"bc03e53486ea0b5e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fuzzyRank.js\":\"59cc71a364e5f0e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idbKeyedStore.js\":\"adaedad53cf1b2ba\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idleCallbackPolyfill.js\":\"136da0c93d42997c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardAwareScroll.js\":\"b88f09cf4adc2776\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardViewport.js\":\"01d9c219e3056bfe\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/lastWorkspace.js\":\"e9a358b0c96d7498\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutColumns.js\":\"0ee43b8c213e3b0e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionDom.js\":\"b80567e638473027\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionId.js\":\"c6cecbc20a4c3d35\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkClickGestures.js\":\"30e47b6a0d4a2956\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkTargetAutocomplete.js\":\"ecdf342e1c23e318\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbCorruption.js\":\"9fed6a30a6af309e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbRecovery.js\":\"a2b46d22fe293229\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/markdownParser.js\":\"844f30bebafa5797\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/memoize.js\":\"cd351d0b96e3ac99\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameFieldCommit.js\":\"285f6132bb92cda7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameList.js\":\"5e485b3fba137b36\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/navigation.js\":\"54577005c7d762c4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/omnilinerNamespace.js\":\"376eba74f282ba85\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/opfsPageScan.js\":\"bad41bc240e81d78\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelClearance.js\":\"5273e5f18f52e937\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelHistory.js\":\"8504e109deee7b5d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLanes.js\":\"e39a75d14cc310bb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLayoutProjection.js\":\"f19b364fc5e17e41\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelScrollAnchor.js\":\"80389f9e73b6747b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelUrlFlags.js\":\"163a495d72733024\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/platform.js\":\"8c8b23e1d1959d5b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/pluralize.js\":\"b2c8d7e687a1d845\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyCreation.js\":\"db7857e7b16d50ac\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyNavigation.js\":\"8cc42b8ca4f5e632\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyValueContext.js\":\"4f7952b99cfe0825\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/react.js\":\"3847b851e3c4a9a8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeDate.js\":\"c7a125301e58861c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeTime.js\":\"556f43dd3f5d4f41\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/renderScope.js\":\"7af1967c9f19f72d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/resolvedThenable.js\":\"5535e8d0b10a2023\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/routing.js\":\"35a7098a6c0a2f03\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/safeMode.js\":\"b48fd9e192782b2f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/scheduleIdle.js\":\"f1beb6248f729cb0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/screenWakeLock.js\":\"88fc711f4a1f1aee\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/selection.js\":\"c56c939d04eabcd5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/softKeyboardGrab.js\":\"6a7e2cfce8bca38c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/startupTimeline.js\":\"2ba751687b039e74\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/state.js\":\"25d8acf8356bbfe3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/string.js\":\"9ca6cf53eeaabf35\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/surfaceZoom.js\":\"a20c14d9c6450bc1\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/time.js\":\"a30fa28b75b51760\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toast.js\":\"b81f7e020a6b6979\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toggleStore.js\":\"abfb7bc98c19c6aa\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/untilStopped.js\":\"26a68d099882dd01\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/userActivity.js\":\"2d0b0a0a3a5009ae\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewTransition.js\":\"fbea721ad8853179\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewport.js\":\"77a6a6a2fb64f105\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/webLock.js\":\"d2ec931ca5f377dc\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceRecovery.js\":\"351f60c546c28075\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceSnapshotStore.js\":\"414c67b57940d1ac\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-compiler-runtime.js\":\"8326d8aacbd5609d\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-client.js\":\"b8be0411bb674b36\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server-edge.js\":\"9a195529f078166f\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server.js\":\"56b7d3b8ef96d88a\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static-edge.js\":\"9bb43382009184a4\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static.js\":\"86830cb23750db36\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-test-utils.js\":\"51cc546eb439d30d\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom.js\":\"ede87dc23f9bd412\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-runtime.js\":\"870de8665275ebfa\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react.js\":\"a8587994e722ceb2\",\"/knowledge-medium/pr-preview/pr-1788/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
