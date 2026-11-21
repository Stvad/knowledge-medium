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
		buildId: "946fb6391b43-c545104f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/\":\"7acbfe25d541e772\",\"/knowledge-medium/pr-preview/pr-1788/index.html\":\"7acbfe25d541e772\",\"/knowledge-medium/pr-preview/pr-1788/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1788/assets/FacadeVFS-ZCRGUJFE.js\":\"df97fb4891d87120\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSCoopSyncVFS-DFvj2ptq.js\":\"e07dc91ded818d1b\",\"/knowledge-medium/pr-preview/pr-1788/assets/OPFSWriteAheadVFS-CBn5jnWO.js\":\"90d72333506619de\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-VHim_sjG.js\":\"3ee607d1115fdbcf\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/assets/wa-sqlite-async-D5y5E6Iu.js\":\"5530d0155c73c11e\",\"/knowledge-medium/pr-preview/pr-1788/assets/worker-CQ3oMEyB.js\":\"fd4e74c127fa613d\",\"/knowledge-medium/pr-preview/pr-1788/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1788/chunks/app-CdvvFxMJ.js\":\"a9b854c538a9de44\",\"/knowledge-medium/pr-preview/pr-1788/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1788/index.js\":\"34e2a1dff298a687\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1788/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1788/assets/AccessHandlePoolVFS-BIZFShHd.js\":\"40163fd2584d781c\",\"/knowledge-medium/pr-preview/pr-1788/assets/IDBBatchAtomicVFS-CIfB4ukQ.js\":\"b7a76d7f99c5831b\",\"/knowledge-medium/pr-preview/pr-1788/assets/MemoryVFS-PEM6NHw2.js\":\"5805389859240a11\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-ChWoBi98.js\":\"0f3d89b51a9ad7bc\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-BYnt30z1.js\":\"9f91e98210bd7325\",\"/knowledge-medium/pr-preview/pr-1788/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1788/chunks/AccessHandlePoolVFS-C-h1Sznz.js\":\"1676680b426a4de1\",\"/knowledge-medium/pr-preview/pr-1788/chunks/FacadeVFS-DyK6h_ym.js\":\"3fa4f0b1718e4d1e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/IDBBatchAtomicVFS-DQt7PtzW.js\":\"03e753d3e773f431\",\"/knowledge-medium/pr-preview/pr-1788/chunks/MemoryVFS-DmKJrDYM.js\":\"5852e339711e4b7c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSCoopSyncVFS-BkrV8rFW.js\":\"f640b13da33eef58\",\"/knowledge-medium/pr-preview/pr-1788/chunks/OPFSWriteAheadVFS-BTkReC5h.js\":\"2928ce8b05501b88\",\"/knowledge-medium/pr-preview/pr-1788/chunks/Preview-CnIu6qZP.js\":\"f08fec963a43f5ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/card-Dp89Qoe1.js\":\"8658966fb3fae1e5\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1788/chunks/dist-CO1Np8uj.js\":\"5bc0b5607a5526b6\",\"/knowledge-medium/pr-preview/pr-1788/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-EWeEnxiQ.js\":\"fb839221759d27ce\",\"/knowledge-medium/pr-preview/pr-1788/chunks/mc-wa-sqlite-async-ClyGc1Gt.js\":\"fb2c0ba9129c2673\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-7ONdcma-.js\":\"4f3f206a94a5f847\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-BSCDaZrp.js\":\"74293a6816d5ee00\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-BUvR_JSG.js\":\"dbe5c713a7341294\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-Bx_m2wW-.js\":\"279fcdd06ef95c11\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DD17iqxG.js\":\"c7ce4d4720f005ef\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DScXGWUf.js\":\"f31f6e6754dcdae6\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DfSTNSDV.js\":\"0244561a97b57584\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-DhqeOmt4.js\":\"90629dc5834f8d1f\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server-legacy.browser.production-CQbFcUft.js\":\"026b9d856bb507f1\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.browser.production-D04PKPmn.js\":\"2b227a4d337ffff6\",\"/knowledge-medium/pr-preview/pr-1788/chunks/react-dom-server.edge.production-B8CrX4Qc.js\":\"13ddbd55f7465298\",\"/knowledge-medium/pr-preview/pr-1788/chunks/server.browser-BDCyQeDr.js\":\"c3162af34a4e909c\",\"/knowledge-medium/pr-preview/pr-1788/chunks/textarea-CyKZ8umM.js\":\"112d5a778c5aaf07\",\"/knowledge-medium/pr-preview/pr-1788/chunks/ui-a2nY-bAt.js\":\"7e9f6b578547c45e\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-Cj1mtf1Z.js\":\"f22f4b8886f436e9\",\"/knowledge-medium/pr-preview/pr-1788/chunks/wa-sqlite-async-CKwLWy84.js\":\"b47819fb8f3df2c7\",\"/knowledge-medium/pr-preview/pr-1788/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1788/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1788/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1788/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1788/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1788/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1788/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1788/src/App.js\":\"a0892a1dd2f66c16\",\"/knowledge-medium/pr-preview/pr-1788/src/appUpdate.js\":\"4003d43bda15d1a8\",\"/knowledge-medium/pr-preview/pr-1788/src/appVersion.js\":\"8f699c4403b15d51\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/initialLayout.js\":\"fbb647e20c20a1ee\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/openWorkspaceData.js\":\"3458a3795be1a06a\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/resolveWorkspace.js\":\"da9fcf6c890ead08\",\"/knowledge-medium/pr-preview/pr-1788/src/bootstrap/workspaceBootstrap.js\":\"37ddfe0c17d7a510\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockComponent.js\":\"47d541034d77fe7b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockCrumbs.js\":\"20710917bd3da9f3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockEditor.js\":\"073e6781db31434a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockLoadingPlaceholder.js\":\"fe68e12eebc55916\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockProperties.js\":\"db31b2dad9d816a3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/BlockSearchPicker.js\":\"1c9d5a310a89d8f7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ConfirmBulkDeleteDialog.js\":\"5527bb7a76ff0b80\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DividerHandle.js\":\"cd63167ba1178a3d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/DraftEditor.js\":\"eb880cc2903a932a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/GutterPill.js\":\"9c95d6fbcc21364c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Header.js\":\"503bac7d52d308f8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/LazyBlockComponent.js\":\"c6a62f63a37a520d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/Login.js\":\"303c8155c8111560\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ZoomableSurface.js\":\"e77c403cea5a0a71\",\"/knowledge-medium/pr-preview/pr-1788/src/components/editModeKeepalive.js\":\"009b3dcf93e8eafb\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b45bf563cae6c54f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"faedd1a4b1a59b67\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefPropertyEditor.js\":\"1526ce1bda6d7bcf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/RefTargetTypePicker.js\":\"d0f297d8207632a0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/SelectPropertyEditor.js\":\"c06323755c683702\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/TypesPropertyEditor.js\":\"36384f4c47b1c0e6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/defaults.js\":\"99b870a01092f43c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/kernelValuePresets.js\":\"4cdfb918f5b782f4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/selectablePresets.js\":\"913d8e3c227bd2ee\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyEditors/typesPropertyUi.js\":\"6870aa1cfc58ba6c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/AddPropertyForm.js\":\"0472ed7927534140\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyPicker.js\":\"5586dd325eba499f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/PropertyRow.js\":\"366a6e8f7699b508\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/Rows.js\":\"a12faae649bc487d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/actions.js\":\"b45e1fc0bf67a674\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/declarationOnly.js\":\"eb982fac831f86e1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/layout.js\":\"d9f0c2fc335c3de0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/model.js\":\"2e29d1e6b0b64a02\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapeUi.js\":\"8ce05396c1214a06\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/shapes.js\":\"31c90674ae8c236f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f5e30fdcc119c303\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanel/visibility.js\":\"fc326b4e819bbd5d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/propertyPanelSections.js\":\"d2ff25f88f138c47\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockEmbed.js\":\"9dfb320a50b5fb92\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockLink.js\":\"ed0ee6d8a80d1e28\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/BlockRef.js\":\"adb94e8e619d40bd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/ReferenceLink.js\":\"5cc4f820d5f2e59d\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuard.js\":\"6cc3e9918b5907d3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/cycleGuardContext.js\":\"f1201b3921ef8587\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/linkInteraction.js\":\"edf3f4909aaff2ab\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/referenceLayout.js\":\"1a50647cff25f0d7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/references/useBlockRefAncestors.js\":\"5d268fbd8b2f34c9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockGutter.js\":\"5f9fef96f080d59b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockInfoDialog.js\":\"2146ac7f3e507ac6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BlockTypeBlockRenderer.js\":\"1866c96e1caab7b7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/BulletHoverCard.js\":\"019f8fd23b226382\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorContentRenderer.js\":\"441c16b3a24dde3a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cf22f02dc75d436e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ColumnResizeHandles.js\":\"1cc083becf9f90c7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"20336d4f8ac48324\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/DefaultBlockRenderer.js\":\"bc7d7e70c2e6ab9f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/LayoutRenderer.js\":\"6be0f0357e621013\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MarkdownContentRenderer.js\":\"b33f99e0196b1b1c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/MissingDataRenderer.js\":\"b6e24f104a89ddd1\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PanelRenderer.js\":\"f05248346bf4c380\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c42420f365e2cec3\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/TopLevelRenderer.js\":\"04ac66cdd3d083c8\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockGutterMode.js\":\"091cb31dd1da4b21\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/blockTitleText.js\":\"406cb9439b3ba046\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/fieldCreationKeydown.js\":\"169d03de8f10f503\",\"/knowledge-medium/pr-preview/pr-1788/src/components/renderer/layoutRootContext.js\":\"09d851e13ab9a33a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/TypeChip.js\":\"18be9150421d0faa\",\"/knowledge-medium/pr-preview/pr-1788/src/components/typeChip/chipStyle.js\":\"2377aa1499d8a62a\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/anchored-floating.js\":\"0a97b39ab2e913ff\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/button.js\":\"938f23c019c9ac2b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/card.js\":\"823980d8ccd04d95\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/checkbox.js\":\"efd86948f47975b2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/collapsible.js\":\"aa8becb5d348465e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/command.js\":\"0e36c796c0e415d4\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/context-menu.js\":\"760e2d3147b6d858\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dialog.js\":\"f05cf2c0e27249ad\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/dropdown-menu.js\":\"283780ccb5cef98f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/floating-listbox.js\":\"d12857e5114c0c38\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/index.js\":\"234b8b52d12fd82f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/input.js\":\"87560731f4f1ed35\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/kbd.js\":\"6e60cabf4bb5c29c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/label.js\":\"b8ec656df4c861fe\",\"/knowledge-medium/pr-preview/pr-1788/src/components/ui/textarea.js\":\"31a4fd813826a6b2\",\"/knowledge-medium/pr-preview/pr-1788/src/components/useEditModeYieldKeepalive.js\":\"d4f37a74f006d110\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/BootFallback.js\":\"b78d39a601d331b5\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/FocusedRowLazyMount.js\":\"ce9f38c1b72b0193\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LazyViewportMount.js\":\"385cf10cfe2cdbf0\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/LocalDbCorruptionFallback.js\":\"276f0d7408d157c7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/error.js\":\"418f7f8340947ccf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/lazyMountRegistry.js\":\"06031e4cf782238f\",\"/knowledge-medium/pr-preview/pr-1788/src/components/util/suspense.js\":\"e704064be1d5c12e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/CreateWorkspaceDialog.js\":\"7da0da818d51859e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/PendingInvitations.js\":\"366a99ae77fb26b9\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/SyncProgress.js\":\"ce0ba169dadbaefd\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/UnlockProgress.js\":\"01282a9fdc8ea5be\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceKeyGate.js\":\"da3d3dc4d6d75f42\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSettingsDialog.js\":\"38585c46987b24f6\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSwitcher.js\":\"e5958f768e2ceefc\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/WorkspaceSyncGate.js\":\"7e09a8e5896dc1ac\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlow.js\":\"456ad77ece76f25e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/ConversionFlowHost.js\":\"52aaccf01950c5ee\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/EncryptionSection.js\":\"4ca30d650eee240e\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/attachmentPrompts.js\":\"9dbb29b91c993c5c\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7cdb07eccaf301c7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowDeps.js\":\"b299dbe487f66f34\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/conversionFlowStore.js\":\"2ea1f1a5a980db7b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/flowUi.js\":\"f46b11042b905baf\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/conversion/useConversionRun.js\":\"d4a5124cb4b87e0b\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/keyUi.js\":\"b855ceae9f9e3d36\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnKeyLoss.js\":\"c38a6fe4ce01b9a7\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/useCloseOnServerE2ee.js\":\"2831d3535ee00530\",\"/knowledge-medium/pr-preview/pr-1788/src/components/workspace/workspaceUnlocked.js\":\"4e3e20529a79b163\",\"/knowledge-medium/pr-preview/pr-1788/src/context/backgroundSubtree.js\":\"1249e3db65e5aecd\",\"/knowledge-medium/pr-preview/pr-1788/src/context/block.js\":\"a73d93a57dd434b9\",\"/knowledge-medium/pr-preview/pr-1788/src/context/layoutWsContext.js\":\"5d994ff08c843fdc\",\"/knowledge-medium/pr-preview/pr-1788/src/context/propertyDisplay.js\":\"e7c0bce0ac20656b\",\"/knowledge-medium/pr-preview/pr-1788/src/context/repo.js\":\"7b5747f3d3c60765\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasClaim.js\":\"c0f12ee546738595\",\"/knowledge-medium/pr-preview/pr-1788/src/data/aliasSeatNamespace.js\":\"c69cc336111a54fa\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockData.js\":\"40814c98669bd7d1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/blockType.js\":\"b4c1e3301c963a9a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/changeScope.js\":\"1da6c0bbff2e6a7d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/codecs.js\":\"ad370ddc28819ef0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/derivedData.js\":\"f062e15354049bcd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/errors.js\":\"59e83c941530a400\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/events.js\":\"f6ccb8150a4ef302\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/handle.js\":\"26df9e713ed7c41a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/index.js\":\"07ef1b550c9f29a1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/mutator.js\":\"f5e52c85a1113371\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/processor.js\":\"0d1252682e3f846a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/propertySchema.js\":\"83076ad48a4d22da\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/query.js\":\"18606a495f5a505f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/sameTxProcessor.js\":\"01c8f3168c1e12dc\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/schema.js\":\"26df9e713ed7c41a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/tx.js\":\"26df9e713ed7c41a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/typedBlockQuery.js\":\"f854634226cd7b65\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/user.js\":\"75cb37f3450d243f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresetCore.js\":\"9678fd1bfc9bf118\",\"/knowledge-medium/pr-preview/pr-1788/src/data/api/valuePresets.js\":\"2a4721932bdd3868\",\"/knowledge-medium/pr-preview/pr-1788/src/data/attachmentCleanerIOVerb.js\":\"252387d3db4c2bf3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/block.js\":\"749c588e51978fec\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockCache.js\":\"f0e41d6f71cf0270\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockId.js\":\"65a7637e9c8a46f1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockLiveness.js\":\"821b1583a195d9c6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockMerge.js\":\"800ca76d9d3e013a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockSchema.js\":\"d1c4c9f4770468ba\",\"/knowledge-medium/pr-preview/pr-1788/src/data/blockTypes.js\":\"28466ac514169dbd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/clientContext.js\":\"36360ba0a6638116\",\"/knowledge-medium/pr-preview/pr-1788/src/data/dbFileSiblings.js\":\"e948989b0c89c00b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/definitionSeeds.js\":\"7a0a1e3920c92fb6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/derivedIds.js\":\"0817212bb5a46485\",\"/knowledge-medium/pr-preview/pr-1788/src/data/drawnSubtree.js\":\"e5862f6aba2c70d6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facetBridge.js\":\"021ddea71fa70ab2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/facets.js\":\"41b89e952cdb5ae4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/globalState.js\":\"403e999856e64b34\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/aliasClaimRederiveProcessor.js\":\"fdf6f71b2f613640\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/ancestorBatch.js\":\"04eabc6a4d8e918f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/blockTypeTypeifyProcessor.js\":\"d464e33d208601fe\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/clientSchema.js\":\"700d5110f9b2c5f6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/commitPipeline.js\":\"1776ba8cb18095c2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/devAssertions.js\":\"11f9721fad2d3426\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/firstSync.js\":\"705b41d9b06030fb\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/freshInitialLoad.js\":\"e1cf2897f91436f2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/graphBackfillClaim.js\":\"e1d461592b321743\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/handleStore.js\":\"28c4f78c85eecad9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/idleMarkerJobs.js\":\"63d0f9343ac218cd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initialDownload.js\":\"fc2e4e5383e79fdd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/initializeClientDatabase.js\":\"c1912ac16fed88d5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/jsonCanonical.js\":\"41ddc0d15e0a2943\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelInvalidation.js\":\"7600077955a9332c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelProcessors.js\":\"97f43a4cc78cac0c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/kernelQueries.js\":\"c48378fde51b35ba\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/mergeTypeMembershipProcessor.js\":\"db0ec170b1397b97\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/normalizeReferencesProcessor.js\":\"938ca06816e1dd98\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/poolInstrumentation.js\":\"89075067a5df68f2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/processorRunner.js\":\"f77c4fc6dd5552e2\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyCellBackfill.js\":\"0e28e347e9118058\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildMint.js\":\"bdb5dadce409758d\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyChildrenProcessor.js\":\"95316139c9738dea\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b45d9256b4cec5ac\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyDefinitionSynthesis.js\":\"fb63f56dd6f41bb6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyKeyScan.js\":\"97d29701ad72dc58\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertySchemaResolution.js\":\"b6649ce2a831769e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/propertyValueEdits.js\":\"27efb962fd8a5865\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/raiseProtocol.js\":\"218fa7567878927a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/readBatch.js\":\"72b4c1faed2f7da3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/refProjection.js\":\"97f6dcede97d0715\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetLookups.js\":\"02adb4bb25d67724\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/referenceTargetProcessor.js\":\"125135e422e9b4ae\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/replayMerge.js\":\"df0a2ed805a02c93\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/sqlBinds.js\":\"d5ec90eb3f82edf6\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d4e295cee25ae17f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/arrivalProcessors.js\":\"dffccbeb9a64e4f9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/invalidate.js\":\"81d8af870a197523\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/materialize.js\":\"7835b84de0397548\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/observer.js\":\"151ccacbe6223070\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/syncObserver/reconcile.js\":\"600f31c93af1af40\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/timingMetrics.js\":\"8697201d0c08608b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/treeQueries.js\":\"685b4582384bd7a9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txEngine.js\":\"a99666eb7e7089bf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/txSnapshots.js\":\"d019bfa06364b310\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/typedBlockQuery.js\":\"47b8f327708296f1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/internals/undoManager.js\":\"6daa13c8dd3a4a38\",\"/knowledge-medium/pr-preview/pr-1788/src/data/invalidation.js\":\"78f767a2f762f362\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelDataExtension.js\":\"602de6c0e396893e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelPage.js\":\"71f50b637ee63a9a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/kernelValuePresetCores.js\":\"0fe14b32341d4eaa\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbCorruptionSignal.js\":\"7c113530a3bd9880\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbStorage.js\":\"f6f81bd0c8b741a1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localDbVfs.js\":\"1e3f1bc2a0056918\",\"/knowledge-medium/pr-preview/pr-1788/src/data/localSchema.js\":\"485fbe9861fedbb7\",\"/knowledge-medium/pr-preview/pr-1788/src/data/maintenance.js\":\"38f194c2da1f8554\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mergeProperties.js\":\"93594e45cdfb7189\",\"/knowledge-medium/pr-preview/pr-1788/src/data/metricsConsoleHook.js\":\"3f7dc582938e53aa\",\"/knowledge-medium/pr-preview/pr-1788/src/data/migrationsPage.js\":\"56cc4283b6c1a911\",\"/knowledge-medium/pr-preview/pr-1788/src/data/mutators.js\":\"6dedc7d7e03d9ae5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKey.js\":\"fc5cba3565914914\",\"/knowledge-medium/pr-preview/pr-1788/src/data/orderKeyPlacement.js\":\"6248a930b4157c6a\",\"/knowledge-medium/pr-preview/pr-1788/src/data/outlineSurface.js\":\"4fdc016473170e98\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingEditorContent.js\":\"c9bb0c3fe4c682cd\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pendingUploadsSql.js\":\"e8aaf16ccd23aade\",\"/knowledge-medium/pr-preview/pr-1788/src/data/pluginStateExtensions.js\":\"e5fc073b5d179113\",\"/knowledge-medium/pr-preview/pr-1788/src/data/powerSyncLogger.js\":\"a4eacdaf7763d8cf\",\"/knowledge-medium/pr-preview/pr-1788/src/data/projectorRuntime.js\":\"b949349543eb160f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/properties.js\":\"da104b01bd192c14\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertiesPage.js\":\"d414b02a9a1fbb1e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyChildren.js\":\"f7dc70f13aa579a4\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionFanout.js\":\"280f7d5482ecbbf8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionMetadata.js\":\"57dc174929424911\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDefinitionRegistry.js\":\"e80efd0adccdcf7e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyDisplayMode.js\":\"39726abe4bf387e8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertyRowCreation.js\":\"e70139b4dd0bd6ec\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySchemaCreation.js\":\"38f71cf18abb137c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/propertySeeds.js\":\"ab27b16e0c173618\",\"/knowledge-medium/pr-preview/pr-1788/src/data/recentsPage.js\":\"76d0b7a3fca78551\",\"/knowledge-medium/pr-preview/pr-1788/src/data/referenceBlock.js\":\"1ed87392121516d1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/releasePowerSyncConnection.js\":\"3194f063868fb5f0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repo.js\":\"e12996f27b29a653\",\"/knowledge-medium/pr-preview/pr-1788/src/data/repoProvider.js\":\"273cfa0300b2ec88\",\"/knowledge-medium/pr-preview/pr-1788/src/data/rowProperty.js\":\"9786cf06232956f1\",\"/knowledge-medium/pr-preview/pr-1788/src/data/searchFilter.js\":\"a7c3e8396b118d61\",\"/knowledge-medium/pr-preview/pr-1788/src/data/seedIdentityLedger.js\":\"00f3d4f7b357b5af\",\"/knowledge-medium/pr-preview/pr-1788/src/data/stateBlocks.js\":\"02b351e39529ed21\",\"/knowledge-medium/pr-preview/pr-1788/src/data/structuralEditPolicy.js\":\"e4174217cc667581\",\"/knowledge-medium/pr-preview/pr-1788/src/data/subtreeDelete.js\":\"b6c5b2b076d8f3ff\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncStreamLock.js\":\"6223e33fe4e989c5\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableSqlRecognizer.js\":\"f6379441dd3c7be9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/syncedTableWriteGuard.js\":\"7f24c964e56a0e87\",\"/knowledge-medium/pr-preview/pr-1788/src/data/targets.js\":\"308c08b6252769b8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeColors.js\":\"2bb3b79e543008f8\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionMetadata.js\":\"ed5fbd2ed8a03c05\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeDefinitionRegistry.js\":\"b14a0a3755e9f45f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeExtraction.js\":\"268c689a5029983f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeInitialValues.js\":\"6d4c87ec4defbf5c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typePropertyGroups.js\":\"b904970ab1c62d4f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeSeeds.js\":\"59f1e3bf2f26657c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typeTagger.js\":\"74dc8d352f96e374\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typedRecords.js\":\"acb70480421181ec\",\"/knowledge-medium/pr-preview/pr-1788/src/data/typesPage.js\":\"4ce7390f41ebd115\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userPrefs.js\":\"470c64b328d26e7e\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userSchemasService.js\":\"26a0ecfa15420431\",\"/knowledge-medium/pr-preview/pr-1788/src/data/userTypesService.js\":\"893508133760d9c9\",\"/knowledge-medium/pr-preview/pr-1788/src/data/valuePresetRegistry.js\":\"c298cfbb8ff06062\",\"/knowledge-medium/pr-preview/pr-1788/src/data/visibleChildren.js\":\"a416160cfbccb45c\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceConversion.js\":\"e87e86e4c394b65f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceFirstSync.js\":\"4d15fd3a82d36059\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceIdNamespace.js\":\"733c0156045d0b0b\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaceSchema.js\":\"b91cadf8782f221f\",\"/knowledge-medium/pr-preview/pr-1788/src/data/workspaces.js\":\"6e20a11819a209b3\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadLog.js\":\"b85a7e8f036a27a0\",\"/knowledge-medium/pr-preview/pr-1788/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/BlockPasteShellDecorator.js\":\"cbda4923925b3c3e\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/atTrigger.js\":\"ff3329182bb6609d\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/autocomplete.js\":\"9e2d4765dde9655b\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/codeMirrorExtensions.js\":\"9cae9c0a7f4c442a\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/contentFlush.js\":\"f20fc772e7b2e7c4\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/defaultInteractions.js\":\"3a57147f57699ca7\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/editSettleSignal.js\":\"8c09d61c469461c4\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/insertImage.js\":\"5c0e450e4b8fd541\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceCompletionRange.js\":\"e1b1ff71e7619e07\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/referenceTargetTypes.js\":\"d8a292eeef30bf79\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/syntaxContext.js\":\"c057ef6e2f6138f6\",\"/knowledge-medium/pr-preview/pr-1788/src/editor/triggerMatch.js\":\"0c30a8b280d5d78a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/AppRuntimeProvider.js\":\"608a8e29b86f7ad5\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/BlockFocusShellDecorator.js\":\"e38b661731375703\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/ExtensionRenderBoundary.js\":\"f7d9f58cc6ba3542\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/PanelContentRecovery.js\":\"aa4b42a4fbc5c4f9\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/apiCatalog.js\":\"b4b218b6740822fa\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/approveExtensionHere.js\":\"ab3adb0b9d1ffbf9\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/armedCutAppMount.js\":\"70f420c6dafc4b28\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/batchableKeyedStore.js\":\"cbbaf6bce9530e60\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockInteraction.js\":\"73e02cc88163e3d4\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/blockSelectionAction.js\":\"dbf24169ac49a083\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compileExtensionModule.js\":\"153c2f20b2ddeca7\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/compiledModuleCache.js\":\"aaa04c19cb71cb1a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/continuousGestures.js\":\"fd7b29c89ce61c00\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/core.js\":\"5781efb3d8f21835\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/defaultRenderers.js\":\"f4e2f7cfb28287ed\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/definitionFanoutAppMount.js\":\"211ac66433952333\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dialogAppMount.js\":\"a07ad61c7786add0\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensionSeeds.js\":\"a9e57114ebc44dc9\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/dynamicExtensions.js\":\"18b14c91aaca84b0\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/exampleExtensions.js\":\"43f6d66cea29bc80\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionApprovalStatus.js\":\"c0d2e8d076dcfde6\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrorToast.js\":\"10ca9939cf33364a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLoadErrors.js\":\"59206a1ecdfe8dda\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionLookup.js\":\"58a0579111f8416e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionToggles.js\":\"0d0eeb5260c15c2c\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/extensionUtilitiesCss.js\":\"e83b11e4f9405832\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/kernelPageDeletionGuard.js\":\"527d865b0117b826\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/liveRuntime.js\":\"87b628008afa9709\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/openExtensionsSettings.js\":\"519be2662d4a9217\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/overridesCache.js\":\"2d9a6cbff3749d13\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/pluginIds.js\":\"c145997e08464e1f\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/processorRejectionToast.js\":\"75eae3b408ae3c7a\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeActions.js\":\"fb7ae23f9588f8b9\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/runtimeContext.js\":\"7d8a3d9813950a2e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticAppExtensions.js\":\"5533bd28bb804a90\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/staticDataExtensions.js\":\"99d34d58c1378f7e\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/toastAppMount.js\":\"885449b087284807\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useOverrides.js\":\"208619d894c66df1\",\"/knowledge-medium/pr-preview/pr-1788/src/extensions/useShortcutSurfaceActivations.js\":\"c9fcec6c5b3a90b1\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/discoverToggleTree.js\":\"873ce0b50d931ecb\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/facet.js\":\"25cb5ef4a628db76\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/resolveAppRuntime.js\":\"e50a5baa527915bd\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/runtimeEvents.js\":\"b288b9b7dea29aff\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/togglable.js\":\"b39d813b052a2f9e\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/variantFacet.js\":\"2d8ce5ae243e2f7c\",\"/knowledge-medium/pr-preview/pr-1788/src/facets/verbFacet.js\":\"cb5d5f94f96d3d2c\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/block.js\":\"9c210ecef7010765\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/focusedChild.js\":\"eb8e25e264ec1718\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/propertySchemas.js\":\"99cefd3bd75d8d8c\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/typeRegistry.js\":\"84c1d15a1068df56\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAncestorCrumbs.js\":\"229a6fec143c640f\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useAutocompleteListbox.js\":\"622c59eeefb98cf6\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedSearch.js\":\"a7e1da4dece43c91\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useDebouncedValue.js\":\"ce2b9997b47188bb\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsFocalRender.js\":\"3e1098a0a349bc49\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useIsReadOnly.js\":\"8d3b0c56cf00e549\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMaterializeBacklog.js\":\"2563827bafb718cc\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useMinuteClock.js\":\"75bf6bb72c936ad9\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePanelLayoutProjection.js\":\"e18836c5d85b484b\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/usePendingInvitations.js\":\"8ebd7ba801c61424\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRendererRegistry.js\":\"59751fbd0cb356a0\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useRetainedFieldRows.js\":\"a7eba58dab67e3bc\",\"/knowledge-medium/pr-preview/pr-1788/src/hooks/useWorkspaces.js\":\"0b192849377639b4\",\"/knowledge-medium/pr-preview/pr-1788/src/lib/utils.js\":\"97eeac6fa7827c40\",\"/knowledge-medium/pr-preview/pr-1788/src/main.js\":\"fbdceac12cdadfeb\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/MarkdownImage.js\":\"ccc111716bf47eaa\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/blockSeparators.js\":\"0f7fdfa41b3db49f\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/context.js\":\"a9a07dfc4929a2b1\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/defaultMarkdownExtension.js\":\"c31b7b8ad43b0a7a\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/extensions.js\":\"d30c7f429c90a81a\",\"/knowledge-medium/pr-preview/pr-1788/src/markdown/renderMarkdownHtml.js\":\"4893ab68929cb47a\",\"/knowledge-medium/pr-preview/pr-1788/src/minimal-editor.js\":\"717293c90295eea9\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/armedCut.js\":\"d5a97632b540d51a\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/captureMediaVerb.js\":\"2544a2cd61e97f5b\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/clipboard.js\":\"b1d8661b5b287ca1\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/decision.js\":\"513f2313c521e638\",\"/knowledge-medium/pr-preview/pr-1788/src/paste/operations.js\":\"ec19e092bfdd5dde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/AccountHeaderItem.js\":\"4ffce0bd475a1029\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/account-header/index.js\":\"4caa3ee0940cbf41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e2e584dca1a8190c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askAgent.js\":\"2d1e5c5e9fbb74d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/askedStore.js\":\"b0f0dab62ec34187\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"68e29a0aef7458df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/chipState.js\":\"8b8adcc09ba5f4ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/dataExtension.js\":\"85a582646d5682b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/index.js\":\"b59a0cb6e2fb02ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8ae410ccade71be0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-dispatch-companion/schema.js\":\"36f727f68786d06f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f5fdbb36ddcb5649\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/BridgePairingDialog.js\":\"56cf2268a8c21101\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/addMedia.js\":\"6fd2c0dc196cf56a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/backlinks.js\":\"461a434d343f41fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/block.js\":\"7e40507bd559e61f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/context.js\":\"9971194e40079bed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a5f74be00d5fb0d8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/index.js\":\"31e24ff3abb3d2a7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/outline.js\":\"7f1243beed3df046\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/properties.js\":\"383a262c22f33278\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/refs.js\":\"caeaf700ea1c8806\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"68039505483e7da2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/search.js\":\"672d5fe6f4677718\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/shared.js\":\"50c35ff1ac417753\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"80bf55c2cbddaf7c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentViews/text.js\":\"3872c87a0820331c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/agentWrites.js\":\"41761dc8392b62d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/authoringCatalog.js\":\"63e4d40dbe26bbe1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/blockRefTargets.js\":\"6356e4c5115cf4db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridge.js\":\"e890bbaa8c633b72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/bridgeLoop.js\":\"bd8c65612636c9b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/changeHistory.js\":\"ef45a469ae259332\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commands.js\":\"573f14d18d100ef0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/commentsCommands.js\":\"b76a1c27921458e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataExtension.js\":\"b7cfcfdaa91afbda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/dataModelGuide.js\":\"c26401dd46f25134\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/describeRuntime.js\":\"45efbb0d7069fb0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/extensionLint.js\":\"5a31b20fe8012f4a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/grainAudit.js\":\"b1f5729ea940a2f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/healthCommand.js\":\"20b69292d932d032\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/index.js\":\"ae3727516670b592\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/presetIdentity.js\":\"74a840cb84052e42\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7e9dbf115c726793\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/readMedia.js\":\"a8e31a91d3f11b3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/schema.js\":\"03471ed9a96dea9f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/serialization.js\":\"6544df3c48078585\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/targets.js\":\"dd64d95230361ad1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/tokens.js\":\"16fe199664dc0cf2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/watchEvents.js\":\"6e65dc0d5aa4149b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/workspaceGuard.js\":\"1f4c2730e6863e23\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/agent-runtime/writeCommands.js\":\"5ab3cbdeda8323d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/AliasCollisionToast.js\":\"a7e78a8b59887286\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/DuplicateNameBanner.js\":\"a568211b213c07e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/collisionMerge.js\":\"bf88e809ede79312\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/dataExtension.js\":\"1a948b70f88bc57f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/index.js\":\"259ab7f70af0f899\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/mergeCollisionAction.js\":\"8861a58f1aa03089\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/pageStyling.js\":\"f4a423f51b036443\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/rejectionToast.js\":\"4307f962a9af95d3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/alias/syncProcessor.js\":\"02f6725373ac49e9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/actions.js\":\"f9eac03b4aff5e24\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/addComment.js\":\"2f42969c5bfddb0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchor.js\":\"596015f159a953c1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/anchorState.js\":\"5ee69f1e130a4d11\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/commentLinks.js\":\"7acd1b6d048c7cde\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/confirmThreadDeletion.js\":\"0fa407534cc44312\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/container.js\":\"72045eb8d3cdc1d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/dataExtension.js\":\"22a19ac13a02f431\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/deleteComment.js\":\"7d978f4f5ac5bc75\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/highlights.js\":\"f0f36dc15aab1c9d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/index.js\":\"ae18312fa93be66b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/linkedCommentsPill.js\":\"5ab6ce060da79e7a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/margin.js\":\"9eb048540904ad37\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/marginSchema.js\":\"31da1aa621485784\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/newComment.js\":\"53170c522f23c57b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ownThreadPicker.js\":\"8835341ced5ea511\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/placement.js\":\"c841ab7fe9d3d69e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/queries.js\":\"9919dce3a0007c40\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotePosition.js\":\"194c2e1ab6db1ecc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedIn.js\":\"62b09700388bacba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/quotedRange.js\":\"12153c6a149e249b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/rangeRefs.js\":\"1988db2a26bee6eb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readHighlights.js\":\"a8f88acf2c1a0e44\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelection.js\":\"5aace005cf8a6052\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/readSelectionUi.js\":\"38739bc82856deda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/reanchor.js\":\"c702000c271f3e3b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/schema.js\":\"aa4a33f1f637c4d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scope.js\":\"5fc683b7c1afb667\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/scopeThreads.js\":\"b7e90c5d1bd7b17e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/splitRetarget.js\":\"80db2d2e44ddc732\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestionCard.js\":\"8e966d57e502fa5f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/suggestions.js\":\"8b95abb99c67a340\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaries.js\":\"00d43559b22e21aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/summaryBatch.js\":\"eb42dcd67f569acf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/surface.js\":\"8116b38f0af11415\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threadNavigation.js\":\"a68e309eb95fd27f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/threads.js\":\"b651bfea0a71b02d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/ui.js\":\"282dc8c1a45a25f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/annotations/uiStore.js\":\"03e65e05a2220a35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/appIntents.js\":\"f390d496ef9776b9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-intents/index.js\":\"717dd2f93bb8824c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/index.js\":\"35c4d79487f8a2dd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/app-update-prompt/status.js\":\"159624d1bb6b2c44\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d1b345152aa1ca12\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaBlockRenderer.js\":\"b1b3049c176acc1f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaDownLaneReplicator.js\":\"99a3e740fb46a1f2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/MediaUploadReconciler.js\":\"c9239c96bc175256\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetDownLane.js\":\"66c558920bfbfc71\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetResolver.js\":\"0d3b3d181e26fc27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/assetUpload.js\":\"71aa77633c68cb9b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/attachmentCleanerIO.js\":\"d7343d5f3f2a3ca4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/supabaseAuditIO.js\":\"df74a9e603a2da66\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/blobStore.js\":\"9c51c704924e6f3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/byteStore.js\":\"6264a3cdabbaef7b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanerIO.js\":\"53d11a9f2dbe977e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/cleanupAttachments.js\":\"fd1cc827b91421e8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/dataExtension.js\":\"13dfde50083c7f03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/downLane.js\":\"d34c7dd57aeff6c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/index.js\":\"af37dd039a081515\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/insertImageContribution.js\":\"3332229d7814d6a4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneArming.js\":\"8981218c28cd357e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/laneLock.js\":\"d5d261f216be3417\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaBlock.js\":\"5db385f5fd7ec97d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaCapture.js\":\"19af52fa7ac8122c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewers.js\":\"f4d6229f617d1748\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/mediaViewersFacet.js\":\"ecc259a75a8d6675\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/pasteCapture.js\":\"90d0e4d54237a7db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/resolver.js\":\"3733a4ee6bddbfd8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/retryUploadsAction.js\":\"74f95114960ac725\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/storagePaths.js\":\"79474c84d582e630\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadDrain.js\":\"5b47039494445ee1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadLaneStatus.js\":\"3d786971a7a35284\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadReconcile.js\":\"3deb9ce822b0379e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadRecovery.js\":\"e7baf4d1a4f93992\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/uploadStore.js\":\"9cc85c4c537f1629\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/attachments/useAssetObjectUrl.js\":\"e6007ff22a963324\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c22baeb951d9bb3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2629c720841d2386\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/facet.js\":\"63aec1699e6fd64e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/index.js\":\"ff568217eb9cd008\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks-view/prop.js\":\"a2f5084edb3544d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinkFilters.js\":\"5336881df0bb2319\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8b55800b6cce6062\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/BlockEntry.js\":\"e8bb06dee8ecd6d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/LinkedReferences.js\":\"6bbe10495ac7c25a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"628710b153c0903e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dailyNoteDefaults.js\":\"c8ec2d3414650d0c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/dataExtension.js\":\"614b059c0c31f9ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/edgeExclusions.js\":\"b4a221ab6095abeb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/filterProperty.js\":\"17bee6b7c8154017\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/index.js\":\"f5f92dbf66191ecd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ca95461e9307dc2a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/applies.js\":\"899e49babe56de16\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/countQuery.js\":\"b220f37f1fcd52d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/expansionStore.js\":\"129e7623daaaba6e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/index.js\":\"edb50b712d1d7cb1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f28175cc5c4d3b90\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/presentationInvalidation.js\":\"8ef120149b26a068\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyEditorOverride.js\":\"1b48db7709dea5bb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/propertyFilter.js\":\"dc99ee487cc19ecd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/query.js\":\"3e3ed029766b6300\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/resolveFilter.js\":\"083eb166c995ec80\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sourceBatch.js\":\"e39f99a3d692147a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/sources.js\":\"7ee9137e98349b8c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useBacklinks.js\":\"981dd44000d46f8a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a50737eedf4a7cca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayCelebration.js\":\"8443faed5b587913\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/BirthdayOverlay.js\":\"a6a9fb14b46fdaad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/gate.js\":\"c3998661e83980ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/index.js\":\"ca289460e63c81c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/birthday/wolfTheme.js\":\"9541ff630579e59d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/BlockDragLayer.js\":\"5ed5dfefdc754f15\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dragController.js\":\"e808a7634f455089\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/dropTarget.js\":\"6aaf1c24021782ed\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/index.js\":\"5a33f2c4a01becbd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-drag/projection.js\":\"4d52a445ce2fd269\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/BlockMetaCard.js\":\"15890a48495c701e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-info/index.js\":\"a3dc7d00241ac7d7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/AddTagDialog.js\":\"b0fa896378210ca4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b1e9bbe00f5d8b34\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/TagNameIssueHint.js\":\"736ef0d74b87dd0f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/addTagAction.js\":\"6d39ded4f97fdb2d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/appendTag.js\":\"0a564b49299a6592\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/config.js\":\"2cb08f78cbb2d9ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/dataExtension.js\":\"ee9dd753ab6ad340\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/index.js\":\"0684ee8c48744990\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/block-tagging/propertyEditorOverride.js\":\"03be65a6aa0578b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbList.js\":\"adb6e9324c8339de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"02ac856c4a36a462\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4febc48f14f79a18\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6aba5f02cef572f5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ebf40ad1f9a32a46\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/index.js\":\"37c830ec2cb7c06a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6a1bf88431ac0e8f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/CharacterCountItem.js\":\"6422528b01eb121f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/ProfilePropertyEditor.js\":\"83eba535f350fb03\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/actions.js\":\"1c4edcf7d4f91e82\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/blockType.js\":\"5e43298f238571e7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/charCount.js\":\"71825db7d02d9972\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/dataExtension.js\":\"90a55e35f0c08786\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/index.js\":\"64cf1e92ce872167\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/profiles.js\":\"52c8efa2dfe46c3c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/properties.js\":\"2ecc0d074048a109\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/character-counter/textCounts.js\":\"7dc6abbbbfbc74ae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/colemak-keybindings/index.js\":\"ca19f666d4074081\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/CommandPalette.js\":\"185be3a1b94d466a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/HeaderItem.js\":\"d08e988b62e5d7c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/context.js\":\"74c25ddadef0f1f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/index.js\":\"65d6c30ec091d922\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/selection.js\":\"e23e80590163f00c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/toggleStore.js\":\"4279fdac0cccf89a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/command-palette/useCommandPaletteActions.js\":\"a0eb73e2e0bfc8c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/ContributorBadges.js\":\"d9ed27d82591763d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/author.js\":\"7fcadf1909fe154b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/codeMirrorExtensions.js\":\"5104e935893a2a3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/dataExtension.js\":\"48dd6130f2d3f814\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/index.js\":\"445536a02e7ff257\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/mentionAutocomplete.js\":\"83ea3432088803d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/processor.js\":\"8ff8e6a79248b0bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/profiles.js\":\"aeaa9d7894c31fd7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/queries.js\":\"9fbabddc1adb3faa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/contributors/schema.js\":\"d801c7f16b250773\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bc9ea779276f279b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b7a50ace8ff21719\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/index.js\":\"fe0b1b937b63b729\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6cc270a0f6ea4dfb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"df08c2efc0676d1b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/CalendarGrid.js\":\"1e7f10c7b49a04ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DailyNotePicker.js\":\"b313c60acba4a51c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f3ec83a7a105a4d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateNavDecorator.js\":\"a0bced8611f900e0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/DateScrubOverlay.js\":\"8ce326f3c0560dc8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/HeaderItem.js\":\"96edf147a1b41f0a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/ReschedulePicker.js\":\"fb0aabf7c6f6336e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0a0af29986e7c06b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/actions.js\":\"32838c2adec61613\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/blockDateAdapter.js\":\"93ce4f96429c51d7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/calendar.js\":\"7104a22a7f3f73c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dailyNotes.js\":\"40f14e5df8c67af9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dataExtension.js\":\"39923be0da0f25c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubActions.js\":\"daee4ef9d21142a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGesture.js\":\"3a95b8de224757d9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubGestureActions.js\":\"226d5dcf6ff9ae3e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dateScrubRecognizer.js\":\"91fd9c55974eec6f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/deletionGuard.js\":\"94b53057a74d5734\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/dueQuery.js\":\"ad58db53db6d6992\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/index.js\":\"a8c4fe43fe484e5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/landing.js\":\"acf1ae8709be737a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/localSchema.js\":\"4154df99fd7d3fe7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/referenceDateAdapter.js\":\"f93f3e86ddfbf871\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/rescheduleAction.js\":\"bc185ff24ae75144\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/schema.js\":\"98a0914e35c87213\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadBlockDates.js\":\"3bc402c0b3b5ab78\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/spreadDatesAction.js\":\"7c2642ec8a81762d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/today.js\":\"a2081e090798747e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2e57daa9db5d30d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4ffa9a130fd3c280\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/audit.js\":\"e59265638ea4a1de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditAction.js\":\"06d6b82b8eee4b1c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/auditRanges.js\":\"9ead2fa05134b1df\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/diagnosticsSource.js\":\"8239499c956d9e57\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/divergenceScan.js\":\"7140bdd18a0774b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/index.js\":\"244abf84d8ae95bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b74b1890b83661dd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/referencesMirror.js\":\"b12a7ddc30ca5f15\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/rowJson.js\":\"6c344451daec0e21\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/schedule.js\":\"ce1b056da9ede6f1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/data-integrity/store.js\":\"780a7a3e05b83d6e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/action.js\":\"4feb7a617d223fae\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/index.js\":\"3503a8081288f181\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-maintenance/plugin.js\":\"b66dc02a54d32837\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b686dc8c3c0d38a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/actions.js\":\"c3fd41eeb48ae964\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/changeMarker.js\":\"3efb6c12b44d6d59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/diagnostics.js\":\"15fc58e720e3f26a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/fileSystemAccess.js\":\"0be054a204ba1d82\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/filenames.js\":\"e726ee93f1f1affb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/index.js\":\"93cc177818b6f8e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/mirror.js\":\"6d4605957a8d1439\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runLock.js\":\"c2d2cb6518df7679\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/runtimeHealth.js\":\"a3617a733a40d549\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/schedule.js\":\"d6a577d403a26833\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/db-mirror/store.js\":\"42c049f63789ef09\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/index.js\":\"9978183ac484a5ec\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/default-themes/themes.js\":\"6332344ee6b9906d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/facet.js\":\"1301508747596c21\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/diagnostics/useDiagnostics.js\":\"17cd2936f846a1fe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/dismissals.js\":\"0d57a4cbaa97759e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/index.js\":\"0cc1ce506ddc06ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/status.js\":\"bc978f33b0d23cf1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extension-prompts/store.js\":\"9a74b67d6d80598a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7fb44914215d75cc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2c0081f6f4101e26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/actions.js\":\"ad813274ccb0cfcb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/config.js\":\"5d558f14f471e343\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/dataExtension.js\":\"1e82856b0927ad5e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/effect.js\":\"bc9726ca8a5996c4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/index.js\":\"8bc2b14d79209074\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/propertyEditorOverride.js\":\"b92d9ae8893e30e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extensions-settings/useToggleTree.js\":\"46df4548d3c3803a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/ExtractTypeDialog.js\":\"ec534177449e3320\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"79e111a7d7f17b4e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/PropertyShapePicker.js\":\"ba533943dd48763d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/action.js\":\"57bc42289ea9c2e5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/extract-type/index.js\":\"af7f0ca8eda1e43b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/FindReplaceDialog.js\":\"a9c45631a8ee7880\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/HeaderItem.js\":\"52642e87c7a64329\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/dataExtension.js\":\"9fc72601d00cbb3f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/index.js\":\"ae44b8c4103c7f81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/search.js\":\"684f88778a15c7c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/toggleStore.js\":\"03c66050e9f70654\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/LocationPropertyEditor.js\":\"e7e579b1a9916d91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/MapView.js\":\"fe0ec61194e7f9f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/blockTypes.js\":\"185f355e4b7c1a3e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/codeMirrorExtensions.js\":\"5be7db1acfd2d083\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/createOrFindPlace.js\":\"c90116b33429a651\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/currentLocation.js\":\"af2e6f99a9230ed2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/dataExtension.js\":\"3dc33f69c0d95e52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/geoContentDecorator.js\":\"57545a1082745b41\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/googlePlacesClient.js\":\"3bff82a438f9b7ff\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/index.js\":\"95b6d4cc540176a8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/locationsPage.js\":\"8f0faf0d67bb3c0b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/mapViewport.js\":\"0571256abac4e9e1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/pickCurrentLocation.js\":\"896783462fd144d6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeAutocomplete.js\":\"6c1dcc193d87509f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/placeNameCollision.js\":\"7826409d2e3ea66e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/properties.js\":\"7f4a5ee7423e495c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/propertyEditorOverrides.js\":\"84a2e9f8385ad139\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/query.js\":\"bf491d35f0a55904\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/geo/usePlaceSearch.js\":\"b8bff9205d718615\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"181d58131bb0f393\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"14c291067ece306e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7931ab2d4eb435b6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/config.js\":\"101340407ea9662d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/dataExtension.js\":\"50afff8fab9c92d5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/facet.js\":\"d631c1ce435a6150\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/grouping.js\":\"cc20eec1f5d3b748\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/index.js\":\"e1a79a1a5276fe54\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2034b2739be5ef72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/query.js\":\"7c340dc8e12e2583\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/resolveConfig.js\":\"7cb8f1a912c227d1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1f3725e4c2ebc1f3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4dfa1788608cf033\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlDocumentContent.js\":\"aa5d629da9636974\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/HtmlFrame.js\":\"59470e188e7c593e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/actions.js\":\"48e5330f47289a8a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/blockType.js\":\"a246115069332df2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/confirmRunScripts.js\":\"cfb1fe1316920063\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/dataExtension.js\":\"da3b253441fb91af\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameAnnotations.js\":\"c7cb9fd8d5e05d26\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameDocument.js\":\"1cb20681c8f7ade6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/frameTheme.js\":\"8f888c95cc2fbf2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/index.js\":\"b06c4579ac4673fb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/scriptConsent.js\":\"023bf6768a80d530\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/sourceMap.js\":\"2cb8dc57bf455150\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/html-document/useDocumentScripts.js\":\"671e355d8e1766f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/index.js\":\"845c5c214b39e094\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/record.js\":\"a051389c8cd49095\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/recordStore.js\":\"0e220150748b5b5b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/responsiveness.js\":\"06d5c67cf965a38d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/schedule.js\":\"a17b4808c6bd9b60\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/interaction-metrics/sessionContext.js\":\"c84678867e574a8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"181e61faa6553970\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"06ab1ea4f3b4881c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/actions.js\":\"20d72e6999622cd2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/config.js\":\"0bf248ed9d60f20a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/dataExtension.js\":\"6dad9815f85675b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/effect.js\":\"dc3a4668d9291c4c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/index.js\":\"955237204cbf9ddd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/keyCapture.js\":\"6453d366a3b6dc3b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/overrideStore.js\":\"6edf4d127b7592d2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dbdb3368083908f0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/HeaderItem.js\":\"206dd00b2312c348\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/LeftSidebar.js\":\"d8ac0e8ae1e1027a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/actions.js\":\"c4bc91f5a6cd5941\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/facet.js\":\"8132c31fe3207336\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/index.js\":\"24b27728180d46ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/shortcuts.js\":\"73c4570f67cd090b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/left-sidebar/toggleStore.js\":\"1442e206b6f8511b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/MergePicker.js\":\"fd1dc625c6417411\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/index.js\":\"3fbb297c0a6a7295\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/mergeAction.js\":\"35c96b7ca8ce2bfd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/merge-blocks/strategy.js\":\"00189ef1f05612cd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/Button.js\":\"d03d71d80b8fa2f1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"22adaeb39e9979de\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9b91ed3a9a6dc301\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/facet.js\":\"415b0dff5f31670b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-bottom-nav/index.js\":\"b78e52c7f76ea678\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0f33f77c3b5e324a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/actions.js\":\"b991c76d8f919157\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"af0f4dd9aaeabda7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2eba47d84ea7705b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/mobile-keyboard-toolbar/index.js\":\"c81e323c1fed46d4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9c0dd507409c0d9b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2feb5b2c7c3b5d2f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/contextMenuItem.js\":\"4bb2d5b5f3e33d3a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/index.js\":\"00fff8fdc1275123\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveAction.js\":\"f49f323b3f13ddcb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/moveBlocks.js\":\"90af9b78805ac8e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/move-blocks/selectionAfterMove.js\":\"3023a93d2c00dcf6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/TutorialBanner.js\":\"54f8210762fe9f6b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/action.js\":\"a23c2297151e82bb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/bannerDismissal.js\":\"37b0300f138ed5f6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/documents/cheatSheet.js\":\"64d081a988187f13\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/index.js\":\"b10d321225b45deb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/keys.js\":\"de9f036bbe054811\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/landing.js\":\"2e98b184a78f93cb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/outline.js\":\"fc141322e42a23ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/onboarding/seed.js\":\"f040da655a094feb\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6629012f3ac8de3a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/analyze.js\":\"7332f3ff9d3bad51\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/diagnosticsSource.js\":\"2629ab87bec9f8b3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/index.js\":\"7b83367dce1824fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/load.js\":\"113b5647641a0984\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/monitorRun.js\":\"e35297ba8e2eee31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/schedule.js\":\"91ecfacf6af87621\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/series.js\":\"1451b0042f10809e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/store.js\":\"5a25af6b643326c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/trendAction.js\":\"f465005d0b2134aa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/perf-monitor/verdict.js\":\"cfbe4fc6092f855d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/clickToEditAction.js\":\"31f0b04f50902d81\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/index.js\":\"b6122f506a0d04ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/plain-outliner/interactions.js\":\"866efc89904dfc20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c37c8a260f0943c7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGate.js\":\"b30b4f2c03befd51\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/MigrationGateDialog.js\":\"23fca05cdf2b723f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/action.js\":\"e1d5e7ddb40a1e59\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/index.js\":\"eecc34f0bcc9789b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/localRunMessage.js\":\"9eba8a1be32a2047\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/plugin.js\":\"1b9e6790c00df78c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/progressReport.js\":\"5aade49ff5bdf8ca\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/properties-migration/sweepProgress.js\":\"0f16de7c5f996db3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/FieldRowRenderer.js\":\"9bc406634ff3eb97\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/ValueRowRenderer.js\":\"31b2ea8b34ac2722\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/actions.js\":\"0ca0172c01d948a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/autocomplete.js\":\"1226e7ed9c122019\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/fieldRow.js\":\"be109d598a9ce99f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/index.js\":\"6fac11e32629e286\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/referenceWarning.js\":\"df5125d6f55cf570\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueAutocomplete.js\":\"836778be63d0b4a1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/property-rows/valueSchema.js\":\"15ecbf1032245ca5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/HeaderItem.js\":\"198f2e4e2bc73b72\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/QuickFind.js\":\"1bd05992fbb482fc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/index.js\":\"4ddb82d2cfcc3501\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/recents.js\":\"7d8e691c7f7a826a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/resultItems.js\":\"088ae5f4f99b689d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/selection.js\":\"722c4421f8c88f52\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/quick-find/toggleStore.js\":\"48f805bbb22730b8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/HeaderItem.js\":\"ceb28a6b226e027c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1004c02c8880c555\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/grouping.js\":\"e15095560d5b3fe3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/index.js\":\"d14d91fa025c8bbe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/recents/target.js\":\"32a1b9a4d967d4ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/codeMirrorExtensions.js\":\"e6357e4281c6719c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/contentPrefill.js\":\"ec1ace7af88e2801\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/dataExtension.js\":\"7dc6ffb14f0d4070\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/index.js\":\"5a7464082babde40\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bcf4539cab9218e7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/invalidation.js\":\"a9ae03506f978379\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/localSchema.js\":\"2df1258dc94aceab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/index.js\":\"ec328d8b7518fedc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b8e0c72748408b77\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/index.js\":\"bf4ee14420ddf7db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/referenceNode.js\":\"786d19b3c61676f4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c1889fbb4e3aa7ba\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6d5ddcc35625a50b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/index.js\":\"4798c76c08d8936b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fa11ae0614995e2c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6b79851aefe58adf\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/mergeRetargetProcessor.js\":\"3ce9728e2df37875\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/parseFence.js\":\"9fd765399a65a226\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceParser.js\":\"2d3c10a1145eb5c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referenceProjection.js\":\"066082aa9d8df782\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/referencesProcessor.js\":\"59e330f1f32e4f62\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/renameProcessor.js\":\"6db3659c22bbc0be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/references/spanReplacement.js\":\"b02bb298dc28add9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/htmlToOutline.js\":\"1660813bccc56e8b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/index.js\":\"47377504ed97d336\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5b685b8c09ca5e2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/rich-paste/pasteDecision.js\":\"f2e304a125d106b4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/action.js\":\"4564895bb27fd532\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/blockIds.js\":\"c685999cbfb1826e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/content.js\":\"2985ceff282ae32d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/effect.js\":\"3cd9b7cde00f3182\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/ids.js\":\"513100721c8f49e6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/import.js\":\"e7817189285769ea\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/index.js\":\"fc333ec3b26e0b2e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plan.js\":\"690c109dcdeb6f4b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/plugin.js\":\"862cca6528a9acb1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/promotion.js\":\"b01c0802e48e3a25\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/properties.js\":\"6c034e3e943aa514\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/references.js\":\"5fdce3a6f47b0562\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/report.js\":\"5cbb209cb4326667\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/roamMemo.js\":\"39bf4b45b6a4da4b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/runtime.js\":\"acf2a5194ad4d691\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/schemaReconciliation.js\":\"eea1118f89422652\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/srsMarkers.js\":\"68d31567baea1d8d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/todo.js\":\"37142c812b237c1d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/typeCandidates.js\":\"77d08f08182f715c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/roam-import/types.js\":\"24cb26f59b98ecb2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/index.js\":\"762184e01015c81a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/search-health/store.js\":\"e7da262642b1bee1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/HeaderItem.js\":\"ae263e6386e58a83\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b98769d5e6240df1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/index.js\":\"e919ae5d51ad8937\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/model.js\":\"d52743f3e87483f7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/toggleStore.js\":\"2ec012eb9c6fdc69\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/shortcut-help/useKeyInspector.js\":\"384bd2e3b2ab79db\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a5d0159c0ac3736a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/ShellDecorator.js\":\"8134c884220110b7\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/actions.js\":\"e62e2366da611f65\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2d9b3af8c8c4b3ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/index.js\":\"7a8d5cf00d4e5bb1\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/shell.js\":\"527ea9f5654334fa\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/surface.js\":\"572dde4c652cdc3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/spatial-navigation/walker.js\":\"d9cdf38e71361c48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/RescheduleToast.js\":\"612bcba4bdd0e9c2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/dataExtension.js\":\"5f7d8aadaedc7f0d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/index.js\":\"b18df4fc27e32543\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/indicator.js\":\"cca7fca7ea7ff945\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/moveSrsState.js\":\"6f7b0e5ae382e142\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b9b826792ac3b9a0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/scheduler.js\":\"0dd025bc5b3e94bc\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/schema.js\":\"89b578bdaedd06f9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cf8052864c448789\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/srsClipboard.js\":\"cf8a06a3373b51e3\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9b9856a47d71ce68\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1b3d1d90f4c2c8ef\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/DeckPicker.js\":\"f3cd80ab76132eb9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewControls.js\":\"f512cf44bacfa39d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ffc81c602ccf2151\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/ReviewSession.js\":\"e9b4332db00a39be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/actions.js\":\"53d3b62da064468f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/archive.js\":\"a149bc8778d0eb4a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dataExtension.js\":\"dce1f0f8d37fae35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/deck.js\":\"7b3c9fbe21164e48\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/dueQuery.js\":\"e978cbc262fe87bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/gradeDecision.js\":\"f325105d92e4818c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/index.js\":\"097bbe59e17c6d3d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/keyHints.js\":\"1bd60b5dc522f48b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewCardLayout.js\":\"6385619444523f27\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/reviewProgress.js\":\"46e083ca282c5e31\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/schema.js\":\"c161629db99ce84b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/srs-review/useDueCards.js\":\"61042e426b9d01bd\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/index.js\":\"a79229ebdb1a2ba5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/startup-metrics/record.js\":\"f2662eb1e111bc87\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/index.js\":\"fd275a0341c59584\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/persistenceStatus.js\":\"c89a46efc2b16cda\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/storage-persistence/requestAction.js\":\"b65be377be41dd02\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/TypeChipsDecorator.js\":\"76ae8f76444b05b2\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/codeMirrorExtensions.js\":\"78218b4da3284463\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/index.js\":\"06bc689478a27ef9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/supertags/typeAutocomplete.js\":\"3d83d670527611f8\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"83c61d01249a29c0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/actions.js\":\"7b6c9ee1920faf86\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/anchor.js\":\"ec4045b05f291bc5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/events.js\":\"6cff02589e9fe162\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/gestureActions.js\":\"778e18fe0db885c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/index.js\":\"15b57c42d95c5d20\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9c1c7bca288f249b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/collect.js\":\"615c0f4c60119719\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/index.js\":\"6e89d4c71a89153b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/sync-metrics/record.js\":\"7f924e7143ab1861\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/RejectionDialog.js\":\"ca88aa1449eb1e84\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4a15fa3115cdc42a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/index.js\":\"5889d532f15502be\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/model.js\":\"367f3b9f39a51d71\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/queueCounts.js\":\"db51edad361fff43\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rejectedHelpers.js\":\"6f6df8651214d86a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/rematerializeAction.js\":\"a0c0f7424525364e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/system-status/useHysteresis.js\":\"c5cd5298141bb0ab\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/effect.js\":\"ea4f7871e214ab14\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/index.js\":\"e1c3d911779d1492\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/theme-toggle/theme.js\":\"1dbf93a766535b4b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/actions.js\":\"3b969f75de601ef4\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/dataExtension.js\":\"db10c21111ef553b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/index.js\":\"87e35bd24a6a11fe\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/todo/schema.js\":\"f43602390d8a773b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/TouchSelectionLayer.js\":\"22629075d69670b0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/actions.js\":\"ef9bcb8ada2c3c3e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/defaultItems.js\":\"9947114d088f45c9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/facet.js\":\"70232b62069a1078\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/holdRecognizer.js\":\"1806719a54cbe283\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/touch-selection/index.js\":\"5cf0ef6a131a2b91\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/UpdateIndicator.js\":\"5dbd331bb004acc9\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/index.js\":\"974a3267595be955\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/update-indicator/loadTimes.js\":\"557e0361bab25e92\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoNotesRenderer.js\":\"739a444281828f87\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoPlayerRenderer.js\":\"6542d036feaba9c6\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/VideoTimeStamp.js\":\"72b8cfb5fef00a35\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/actions.js\":\"051122e78ebf734c\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/index.js\":\"293abeb42547fe9b\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/markdown.js\":\"9020cdcf41a16f9a\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/notes.js\":\"31bdf8aa97b8550e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/registry.js\":\"18072580dd714a19\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/remark-timestamps.js\":\"b63f63be2738949d\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/video-player/view.js\":\"d07697d448a7fd8f\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/LinkHints.js\":\"785e5b5d4667e0ad\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/index.js\":\"1ae4ca38ff006a0e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/model.js\":\"ab9a090f07c2f582\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-link-hints/settings.js\":\"d04f867cc8d29ca0\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/actions.js\":\"d60707fcb4366c9e\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/index.js\":\"89b17c6c3aed3fe5\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/vim-normal-mode/interactions.js\":\"5ffce4b0f37bb189\",\"/knowledge-medium/pr-preview/pr-1788/src/plugins/workspace-header/index.js\":\"424fd46b8dddb32b\",\"/knowledge-medium/pr-preview/pr-1788/src/registerServiceWorker.js\":\"ec95efd5ae8423e1\",\"/knowledge-medium/pr-preview/pr-1788/src/requestPersistentStorage.js\":\"70e1efb02a2f517f\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authRequestDeadline.js\":\"7f1e491cd0659025\",\"/knowledge-medium/pr-preview/pr-1788/src/services/authStorage.js\":\"db9537cc003917fb\",\"/knowledge-medium/pr-preview/pr-1788/src/services/powersync.js\":\"0ea76562c681bff6\",\"/knowledge-medium/pr-preview/pr-1788/src/services/supabase.js\":\"ee3683641ecf8619\",\"/knowledge-medium/pr-preview/pr-1788/src/services/uploadErrorClassifier.js\":\"fcd5be4e83d67112\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/ActiveContexts.js\":\"fb6ab7c475994537\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/HotkeyReconciler.js\":\"9bf586d25e6eeb40\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/WipeLocalDataDialog.js\":\"1441ebe73fc60781\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionDispatch.js\":\"2a66a8c3bfeeda6d\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/actionRefItems.js\":\"f52a2f42eb953254\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/applyKeybindingOverrides.js\":\"aa5d2fa3536de002\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/blockActions.js\":\"26dca091d5264395\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/canonicalizeChord.js\":\"bee250f9bc80bdac\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultContexts.js\":\"52d562840ada276c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/defaultShortcuts.js\":\"9e2d17c2dd914afb\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/effectiveActions.js\":\"934b06eda561d65e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureAction.js\":\"495e52470b82ece7\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/gestureBinding.js\":\"ea852fa8e888a0b7\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/holdRegistry.js\":\"74975c82f43c9192\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingConflicts.js\":\"f24aab8b8443264b\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/keybindingOverrides.js\":\"c0a3228967ab22a6\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/pointerAction.js\":\"cf6a98f3643db25e\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/resolve.js\":\"337b46c8ed0fc47a\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/runAction.js\":\"5e7c743bac41b10a\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/sequenceMatcher.js\":\"ca84909dbad577e9\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/types.js\":\"a18ad1ac122c27b1\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionContext.js\":\"af1b6dc730af7243\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/useActionDiscovery.js\":\"fa26d76ff803571c\",\"/knowledge-medium/pr-preview/pr-1788/src/shortcuts/utils.js\":\"b2ff095707c04591\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/bootStore.js\":\"acfaa98500c57ec0\",\"/knowledge-medium/pr-preview/pr-1788/src/sw/previewDatabases.js\":\"e9867709805f9bbc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/byteTransform.js\":\"c1752410576334e5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/attachmentCleaner.js\":\"1d3177c7601c247f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/attachmentParts.js\":\"dec22439b26b5fbc\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleParts.js\":\"1ee306134452895f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/bundleRecord.js\":\"5f33fb5cc316c334\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/manifest.js\":\"e065bb80476433c2\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/takeBundle.js\":\"294fe168617a0d88\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/bundle/verifyBundle.js\":\"4fbf35b67dc01c17\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/cleaningStage.js\":\"f2faba4aafcf1e77\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionKey.js\":\"fd0f1241157d6b5b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/conversionServer.js\":\"a525034832a857a3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flip.js\":\"12344cabd8cbfe0b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/flipAttempts.js\":\"c65a2028b3db8ba1\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/pages.js\":\"711bd9f985ba38a3\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/preflight.js\":\"2a333100b5d62dbb\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/reseal.js\":\"a260a83c48a6319f\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runConversion.js\":\"268ffe235f603b42\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/runLock.js\":\"eac5cd3955a34996\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealing.js\":\"b75cb996a74e4408\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/sealingStage.js\":\"6d36019398984d05\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/stage.js\":\"66318ba1d0936a8e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/conversion/verifyReseal.js\":\"34c81bdcc8e38e20\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aad.js\":\"776c0bf6e4ec2111\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/aead.js\":\"5995ebffc6357e72\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base32.js\":\"5bb671cad8927f45\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/base64url.js\":\"4eebf9293c72d1f5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/binaryEnvelope.js\":\"2de8ab01732e26f0\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/byteAead.js\":\"72f7224b10a71331\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/canary.js\":\"34a2b33bad886438\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentHash.js\":\"b00c4e0a58bc0043\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/contentKey.js\":\"e76c6ca23a313649\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/derivedIdNamespace.js\":\"9c69d407b87bd792\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/envelope.js\":\"f1ccea3c6e3231cb\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/hex.js\":\"b4d4791ec2e16b81\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/sha256Hex.js\":\"9ced1d1fa527b86a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/crypto/workspaceKey.js\":\"9b0b5568afc8f83e\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/conversionState.js\":\"db3b8e4d28994568\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fb39b9ff235f03e6\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/pastedKey.js\":\"1fa35e02047deb04\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"be25cf7570a2e2b9\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/flows/upgradeWorkspacePin.js\":\"01af361a16be20c7\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/keyStore.js\":\"1b99e711eae813f5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/mintWorkspaceKey.js\":\"b2a012a4b715fcf5\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/modePin.js\":\"59b42d8d958c7c0a\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/openWorkspaceKeys.js\":\"e0047d81c67b1261\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolveWorkspaceEntry.js\":\"36c540dff4dfe64b\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/resolver.js\":\"393a7fa19a60627d\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/keys/workspaceAccess.js\":\"c518589c3f479250\",\"/knowledge-medium/pr-preview/pr-1788/src/sync/transform.js\":\"c18eb1e14457377b\",\"/knowledge-medium/pr-preview/pr-1788/src/themeBootDefaults.js\":\"efcf5eae7a0a5481\",\"/knowledge-medium/pr-preview/pr-1788/src/types.js\":\"c1a75b817aab6e1d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/ClientLocalSettings.js\":\"36c78e4e34eccf09\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/abortableSleep.js\":\"a7f2440580ea43e7\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/array.js\":\"430861107a74eba4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/backlinkAutocomplete.js\":\"7c87e5ac83df75b9\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockCrumbs.js\":\"03c3f594cc22f608\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/blockrefAutocomplete.js\":\"f358540b24833d33\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/cadencedIdleJob.js\":\"4bfa72f639d561aa\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/callbackSet.js\":\"bfdf35c61207e17d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/clientId.js\":\"348adb537ebb5359\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirror.js\":\"1f467c010822c173\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/codemirrorCompletion.js\":\"4f085e9cc5742939\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/copy.js\":\"4ea1e26e9ba3341b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dailyPage.js\":\"ed333977232a63cf\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensics.js\":\"09359d8e7fb6994c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dbForensicsHooks.js\":\"03bdf554840b32d5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/deleteBlockThroughUi.js\":\"68dc3b6151322fe2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dialogs.js\":\"7bca1f10791db197\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/dom.js\":\"c38c15f06025d260\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/downloadBlob.js\":\"3962a9460699eea4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/exportSqliteDb.js\":\"42e47d7f80aabbfd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fileSystemAccess.js\":\"1fdf141dac97656f\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/flipSlide.js\":\"28b6bdc0f63c9fbe\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fnv1a.js\":\"ac477163a7eaf125\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/formatBytes.js\":\"bb5ae680ed2b150a\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/fuzzyRank.js\":\"ef1c7f7beb4401cc\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idbKeyedStore.js\":\"daa3344f71bd26d0\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/idleCallbackPolyfill.js\":\"914a077d74c6bccd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardAwareScroll.js\":\"450ab096272190d2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/keyboardViewport.js\":\"be170a0bb78d2bfa\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/lastWorkspace.js\":\"6c22a942e5aad930\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutColumns.js\":\"8006712a133cf4f6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionDom.js\":\"d63f66ec5915390d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/layoutSessionId.js\":\"4966cb4ef7f69885\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkClickGestures.js\":\"0a3597b118baf40e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/linkTargetAutocomplete.js\":\"7e3cb7ef04c7a594\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbCorruption.js\":\"96e1da64cd91ae00\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/localDbRecovery.js\":\"435214677d38a4af\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/markdownParser.js\":\"f43ba2fba1c40e8c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/memoize.js\":\"d73423bfb9374801\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameFieldCommit.js\":\"ac2a1991ca771e23\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/nameList.js\":\"f565e0c1ab35b251\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/navigation.js\":\"3d87b9fcba76d0a2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/omnilinerNamespace.js\":\"c0241c71bafd8256\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/opfsPageScan.js\":\"aaa51e0f4dc4a8bd\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelClearance.js\":\"35319d9a682ec169\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelHistory.js\":\"3447f715d0406590\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLanes.js\":\"e0dde3b042c71d36\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelLayoutProjection.js\":\"acdfe2f1e866bd33\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelScrollAnchor.js\":\"ec3724b4ab808866\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/panelUrlFlags.js\":\"c01890b494d568d3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/platform.js\":\"7c99353c7d848197\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/pluralize.js\":\"4ec16beda27824f5\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyCreation.js\":\"46784e5b0c075354\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyNavigation.js\":\"9f1f6de39b008ba4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/propertyValueContext.js\":\"ad24b9d63ae7d8b8\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/react.js\":\"b327b7d83e277691\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeDate.js\":\"4d45e52b7a4178e3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/relativeTime.js\":\"b4136abd31e6dc38\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/renderScope.js\":\"471bad4bbb12d6cc\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/resolvedThenable.js\":\"cfd2761acc37fe12\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/routing.js\":\"481feaa2c5b62b19\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/safeMode.js\":\"9518f7588c9d735b\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/scheduleIdle.js\":\"d8e9a2d12b6c3bd2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/screenWakeLock.js\":\"1053a4afc27bab84\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/selection.js\":\"189f74378984bf7c\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/softKeyboardGrab.js\":\"91a3ae3a66b3bf20\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/startupTimeline.js\":\"ef42ced68c6c9768\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/state.js\":\"5112e14b8758c0b4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/string.js\":\"744481cae8e2c24e\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/surfaceZoom.js\":\"9ef3fa6cbb0bf2a4\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/time.js\":\"8e280db5363a47b2\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toast.js\":\"9e5cfe32d2666f67\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/toggleStore.js\":\"72329c75592d26ed\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/untilStopped.js\":\"74d10da9cf790baa\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/userActivity.js\":\"d3544803792343e3\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewTransition.js\":\"c0bf50b37c04fd0d\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/viewport.js\":\"45def5577b5a8d65\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/webLock.js\":\"73bd57a2ba696fcb\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceRecovery.js\":\"7070bc52dba53e28\",\"/knowledge-medium/pr-preview/pr-1788/src/utils/workspaceSnapshotStore.js\":\"c3fa9442deb9894f\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-compiler-runtime.js\":\"db171d7962e48c69\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-client.js\":\"7a647585671d3a87\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server-edge.js\":\"12dabe6493e5d0e5\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-server.js\":\"b8c1f1751b3321da\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static-edge.js\":\"d6f657c1f31cbe3e\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-static.js\":\"1b0174496a0834c2\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom-test-utils.js\":\"924ad43807a4dcb3\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-dom.js\":\"b98b3817e83f5ec7\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react-jsx-runtime.js\":\"36513327aace2d19\",\"/knowledge-medium/pr-preview/pr-1788/src/vendor/react.js\":\"aba33f9eff9a75d8\",\"/knowledge-medium/pr-preview/pr-1788/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1788/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
