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
		buildId: "bea937fb1b56-8bddd351",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/\":\"ed2baf322781a6c8\",\"/knowledge-medium/pr-preview/pr-1789/index.html\":\"ed2baf322781a6c8\",\"/knowledge-medium/pr-preview/pr-1789/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1789/assets/FacadeVFS-d-meU7VW.js\":\"feb96d86bea97ea8\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSCoopSyncVFS-DOCNXPTE.js\":\"27dd6ca5f860d57b\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSWriteAheadVFS-BzKWHlPP.js\":\"463234c5410aba64\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-BMA25nbU.js\":\"354886514429fcb3\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-kPYo55fK.js\":\"9ae83449ab2d0344\",\"/knowledge-medium/pr-preview/pr-1789/assets/worker-Dy_qnQht.js\":\"c59d6a5c9bb1e1d5\",\"/knowledge-medium/pr-preview/pr-1789/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1789/chunks/app-nW5YCSRm.js\":\"2195ca93c15a85b1\",\"/knowledge-medium/pr-preview/pr-1789/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1789/index.js\":\"0d22de377b2984e9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1789/assets/AccessHandlePoolVFS-DwPvG84U.js\":\"660b29f9c9177a6b\",\"/knowledge-medium/pr-preview/pr-1789/assets/IDBBatchAtomicVFS-ioIc0pd4.js\":\"036bd21c1ba0e321\",\"/knowledge-medium/pr-preview/pr-1789/assets/MemoryVFS-CpOZQGl3.js\":\"6ccab0d635691d0f\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-C7RFgCwx.js\":\"752467c93608624d\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-B-Ch6wmT.js\":\"7706a6c5b62692f7\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/AccessHandlePoolVFS-iNBj7com.js\":\"c050974b10852285\",\"/knowledge-medium/pr-preview/pr-1789/chunks/FacadeVFS-Bwpui3SQ.js\":\"93e4cb90a0c98f45\",\"/knowledge-medium/pr-preview/pr-1789/chunks/IDBBatchAtomicVFS-BM70kf6x.js\":\"af6aed3da5162dbf\",\"/knowledge-medium/pr-preview/pr-1789/chunks/MemoryVFS-Bbvrpzlt.js\":\"342bf25eb5b332ac\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSCoopSyncVFS-BYYu_ZCg.js\":\"8cad4f023cf380f4\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSWriteAheadVFS-DhRg4oZH.js\":\"0f15f79982248bd3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/Preview-jIdRsszi.js\":\"5f5b391f69fd5fa2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/card-BvExwv-2.js\":\"cdb71edde671071f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-CLp5ejpa.js\":\"a12b5a1779d48712\",\"/knowledge-medium/pr-preview/pr-1789/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-Dz1hn0fU.js\":\"b0ab2be8c64b7c5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-async-D5F0ArBL.js\":\"7eecdd4af4d9e5c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BRA8_Nhk.js\":\"e77870ae613fa86f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BZ3urFDI.js\":\"96daeb5fe99e24ef\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CTTN1Wme.js\":\"fae16ee46cf83646\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-DAC_d0KV.js\":\"38233f7f6b676d24\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-DGkJbf3v.js\":\"d44a0750d525fadd\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-Da8jzKWe.js\":\"ebb1d5ec07d2711f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-DlmDqGUo.js\":\"b271cb895ec6c5e8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server-legacy.browser.production-Y8thLMAD.js\":\"779a59140e3cb713\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.browser.production-DLn1VIbY.js\":\"564d00556f75761a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.edge.production-iZKNXWH5.js\":\"fac7c1711a7e4538\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-fnkJvWeh.js\":\"2051d1eafc404234\",\"/knowledge-medium/pr-preview/pr-1789/chunks/server.browser-DoRpcQXe.js\":\"0c1b18877df80850\",\"/knowledge-medium/pr-preview/pr-1789/chunks/textarea-CofKviFh.js\":\"546edd0439562f04\",\"/knowledge-medium/pr-preview/pr-1789/chunks/ui-VAAwFkMv.js\":\"23abd10a2ea3a0ce\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-DF2ZsgOn.js\":\"25c5909413dd88fe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-async-CSXkvVqY.js\":\"623aad82ffdd3ff2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1789/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/src/App.js\":\"faced46312d85151\",\"/knowledge-medium/pr-preview/pr-1789/src/appUpdate.js\":\"ad67e4c3e7d0f7c0\",\"/knowledge-medium/pr-preview/pr-1789/src/appVersion.js\":\"4481306a343333ee\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/initialLayout.js\":\"c76317a5ffb5eeaf\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/openWorkspaceData.js\":\"8e372af16f5a017f\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/resolveWorkspace.js\":\"8206bf94bfba6c5d\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/workspaceBootstrap.js\":\"8d0d84e9064f5f5f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockComponent.js\":\"ad073fbfd6ffb2cd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockCrumbs.js\":\"5d4ccf65b161f7d4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockEditor.js\":\"2d8f2be31256e75a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockLoadingPlaceholder.js\":\"ae2ca2d075d92fcb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockProperties.js\":\"60a7f65e716924a2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockSearchPicker.js\":\"868fe69462af727b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ConfirmBulkDeleteDialog.js\":\"ff0d52aac6fe5d77\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DividerHandle.js\":\"93a4606305342e23\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DraftEditor.js\":\"8039279d80e623bd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/GutterPill.js\":\"b219853ce1bd28f3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Header.js\":\"fc2c62f7e7f55dda\",\"/knowledge-medium/pr-preview/pr-1789/src/components/LazyBlockComponent.js\":\"c94f5716950bda52\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Login.js\":\"f7ef9a3d1a437a8c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ZoomableSurface.js\":\"d4618835f81167db\",\"/knowledge-medium/pr-preview/pr-1789/src/components/editModeKeepalive.js\":\"b6ccc697deede685\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fae111e2d319af48\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"be7ce13cb777c2e7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefPropertyEditor.js\":\"becfe66b93b11a3a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefTargetTypePicker.js\":\"771ef82693058efb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/SelectPropertyEditor.js\":\"3cd3a20f64341485\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/TypesPropertyEditor.js\":\"5ce6acdc5efa0f78\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/defaults.js\":\"b325916686f4f449\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/kernelValuePresets.js\":\"21f93c5dccb3a203\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/selectablePresets.js\":\"80726949ff0df8ff\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/typesPropertyUi.js\":\"3173dc92e02e79d8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/AddPropertyForm.js\":\"d2f1b1d033927b7e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyPicker.js\":\"4526136c8026078a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyRow.js\":\"87f5d71e72f5801c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/Rows.js\":\"e189b4f446ba1b07\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/actions.js\":\"ad0eda70304c3d61\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/declarationOnly.js\":\"98fcadb4f9f7f4c1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/layout.js\":\"c7c8895214673f6e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/model.js\":\"58c71156d767b378\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapeUi.js\":\"d1933814365592bc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapes.js\":\"e0953d0dde24d23a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/usePropertyEditingActivation.js\":\"69fffc5933659f32\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/visibility.js\":\"65d0ac9c7e5d56fa\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanelSections.js\":\"207e85594bdc36d5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockEmbed.js\":\"7aa0ffb6de142a7d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockLink.js\":\"d655e0ea8b3f2c25\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockRef.js\":\"cf289fb5b3eab3d5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/ReferenceLink.js\":\"7961e55b61ea27c7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuard.js\":\"1cde96253fb28b23\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuardContext.js\":\"32f7a85b6c4c7f5d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/linkInteraction.js\":\"c9fe12d90cc5f0d0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/referenceLayout.js\":\"17fa38188350ca6e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/useBlockRefAncestors.js\":\"cdc2c4ff107f121c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockGutter.js\":\"f2263ef2940c5338\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockInfoDialog.js\":\"e5678a468b819ac0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockTypeBlockRenderer.js\":\"0b58d28b80bdff5f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BulletHoverCard.js\":\"550a53e62b3608e3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorContentRenderer.js\":\"6557513c5ec496ce\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4ffba739ba5a6eab\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ColumnResizeHandles.js\":\"f34ec6274941d656\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f5e237a8d1e372e1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/DefaultBlockRenderer.js\":\"d201028c0cb11d0f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/LayoutRenderer.js\":\"898605a4399f2d70\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MarkdownContentRenderer.js\":\"d402f4eae594e3f1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MissingDataRenderer.js\":\"aa81a4896679d9ff\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PanelRenderer.js\":\"9d64d1dc4e378e82\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PropertySchemaBlockRenderer.js\":\"34c6bfcb690f5ce7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/TopLevelRenderer.js\":\"7ad787a3a1e81e9a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockGutterMode.js\":\"ef15c26ddb296f3d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockTitleText.js\":\"c3293c539281dfe1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/fieldCreationKeydown.js\":\"d3d7866daed8c693\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/layoutRootContext.js\":\"958547202bb782b9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/TypeChip.js\":\"cb187c68f41d6e75\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/chipStyle.js\":\"4f9b6bf21f962b39\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/anchored-floating.js\":\"8757cfde23a7b6a0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/button.js\":\"755e96a2eea30816\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/card.js\":\"83e4352e6c06fa0c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/checkbox.js\":\"35fdec0de6d2272d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/collapsible.js\":\"60f3b9d847520ff9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/command.js\":\"155ef05d1c353f60\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/context-menu.js\":\"9b4121cf0ce22785\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dialog.js\":\"44f2f22542b8b99c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dropdown-menu.js\":\"824ad33801159507\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/floating-listbox.js\":\"59dfd02614023398\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/index.js\":\"cc1b40964bec8650\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/input.js\":\"5cff41f666ee8deb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/kbd.js\":\"18f204936843cb23\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/label.js\":\"5a10aaa5962b9f7a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/textarea.js\":\"48e3be465370ae48\",\"/knowledge-medium/pr-preview/pr-1789/src/components/useEditModeYieldKeepalive.js\":\"f184d934b7c6dfd6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/BootFallback.js\":\"61f9d27f8ba79d64\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/FocusedRowLazyMount.js\":\"0422aa58e1f2eeba\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LazyViewportMount.js\":\"8c389a2b62b9572a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LocalDbCorruptionFallback.js\":\"63437eca91f4f13a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/error.js\":\"a9be800961746142\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/lazyMountRegistry.js\":\"0371ee6626613661\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/suspense.js\":\"2d928a10d54dc115\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/CreateWorkspaceDialog.js\":\"5789914144749739\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/PendingInvitations.js\":\"03cbb5caae855d87\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/SyncProgress.js\":\"225e61e865ee32b9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/UnlockProgress.js\":\"69313aee6f632c6a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceKeyGate.js\":\"b0a5a30704750d7a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSettingsDialog.js\":\"e54808c762a5d12e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSwitcher.js\":\"fadf3bb4cbffaf29\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSyncGate.js\":\"129bccf1f0b8034c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlow.js\":\"d3fb241fb269420c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlowHost.js\":\"e96d37fc0c5f065a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/EncryptionSection.js\":\"34543f3183a35e07\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/attachmentPrompts.js\":\"7c231f549170772d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4b5764cf47d5fd35\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowDeps.js\":\"e611434dd7c7a497\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowStore.js\":\"72eebbf452bab658\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/flowUi.js\":\"ceae2d6470f48271\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/useConversionRun.js\":\"87fc0659bf4e8d8f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/keyUi.js\":\"94c9987a575c4288\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnKeyLoss.js\":\"bf2e18f2b619f94e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnServerE2ee.js\":\"59494f13f80227e8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/workspaceUnlocked.js\":\"5d26f9bcbf78e075\",\"/knowledge-medium/pr-preview/pr-1789/src/context/backgroundSubtree.js\":\"ca3a8ec978f64790\",\"/knowledge-medium/pr-preview/pr-1789/src/context/block.js\":\"38778e16b62b51e9\",\"/knowledge-medium/pr-preview/pr-1789/src/context/layoutWsContext.js\":\"2c92ad4bebdc6122\",\"/knowledge-medium/pr-preview/pr-1789/src/context/propertyDisplay.js\":\"a9a297e19d2b967c\",\"/knowledge-medium/pr-preview/pr-1789/src/context/repo.js\":\"d9def3b9fb703f2a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasClaim.js\":\"a416879feda37713\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasSeatNamespace.js\":\"b75812a04f770fea\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockData.js\":\"12859f0edd16d4b1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockType.js\":\"995977b085486af5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/changeScope.js\":\"07dd46fad60c0575\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/codecs.js\":\"ac8602e82c0dd479\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/derivedData.js\":\"47e7710dc628e90c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/errors.js\":\"13569056e0cefed4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/events.js\":\"914944ceec966908\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/handle.js\":\"0366aead2a740aed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/index.js\":\"fc4279301d180bdc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/mutator.js\":\"6809b461ddfd82f5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/processor.js\":\"d3a431aba8e706eb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/propertySchema.js\":\"f1d1983b39ae186c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/query.js\":\"4835dec6415e1dda\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/sameTxProcessor.js\":\"5c4741f08c61ad43\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/schema.js\":\"0366aead2a740aed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/tx.js\":\"0366aead2a740aed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/typedBlockQuery.js\":\"d60982f287ee8404\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/user.js\":\"1387ef4de3178c72\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresetCore.js\":\"75fdd837290ab840\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresets.js\":\"08ae29611ceb2598\",\"/knowledge-medium/pr-preview/pr-1789/src/data/attachmentCleanerIOVerb.js\":\"9d14596ae20a3f8a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/block.js\":\"638f44b702f5c8d3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockCache.js\":\"305ecf9efde77cba\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockId.js\":\"2ca1dfbf62f170bb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockLiveness.js\":\"79e49d4cc9ec76b9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockMerge.js\":\"a0466c1753ab11d4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockSchema.js\":\"72e9a1337fc308c0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockTypes.js\":\"6d70c6144e199acc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/clientContext.js\":\"cd6a1c9c4d0ec7e8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/dbFileSiblings.js\":\"223d545a43b63be1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/definitionSeeds.js\":\"c73108dbbf6956cd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/derivedIds.js\":\"850d90e82c897215\",\"/knowledge-medium/pr-preview/pr-1789/src/data/drawnSubtree.js\":\"b619622c1f2335ea\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facetBridge.js\":\"246b73002f0fd98b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facets.js\":\"273a022cbd012699\",\"/knowledge-medium/pr-preview/pr-1789/src/data/globalState.js\":\"9d6a5a72a3218072\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/aliasClaimRederiveProcessor.js\":\"882b68f167d3898b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/ancestorBatch.js\":\"29320069b7b60b6d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/blockTypeTypeifyProcessor.js\":\"ff04a3e23fe0a1c0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/clientSchema.js\":\"9d228475109f739e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/commitPipeline.js\":\"d8888942f2836855\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/devAssertions.js\":\"567c4ef923216a82\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/firstSync.js\":\"369b18ac52798fdc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/freshInitialLoad.js\":\"36c2f04185319d22\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/graphBackfillClaim.js\":\"12b4cf8066b345ff\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/handleStore.js\":\"61e2010c11791625\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/idleMarkerJobs.js\":\"ed2706be5978974b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initialDownload.js\":\"30e0077bc7db852f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initializeClientDatabase.js\":\"f52aab2108b9867a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/jsonCanonical.js\":\"cebf903ea2e6bfe9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelInvalidation.js\":\"d978f973a3e81330\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelProcessors.js\":\"a79b7e331edef7b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelQueries.js\":\"2356dd06d6dedd64\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/mergeTypeMembershipProcessor.js\":\"48b5625e1ef2d623\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/normalizeReferencesProcessor.js\":\"ca439f4298e26ddb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/poolInstrumentation.js\":\"e59e23c6a3b00e4f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/processorRunner.js\":\"9e9d626c93377030\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyCellBackfill.js\":\"704db90b598a7f23\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildMint.js\":\"92394b0c6858be9d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildrenProcessor.js\":\"e98fa552c53065fa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionChangeProcessor.js\":\"93cf0c9f1b629fd7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionSynthesis.js\":\"1ab0e67025a4ae5d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyKeyScan.js\":\"1ba044c68eac6d39\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertySchemaResolution.js\":\"7f6659dfb9c1d40d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/raiseProtocol.js\":\"959d3d1a3318fa6e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/readBatch.js\":\"172bf47906052dbb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/refProjection.js\":\"9a4df33f8fbd29fb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetLookups.js\":\"ca987c779ab8af3c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetProcessor.js\":\"9a6c0427c5586c32\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/replayMerge.js\":\"a41f49e8f63326af\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/sqlBinds.js\":\"e673e13edf7d8d2a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7223ece8f73a6590\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/arrivalProcessors.js\":\"e67028aea2c23d01\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/invalidate.js\":\"a47bdf417e01e00d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/materialize.js\":\"44a218a6b73c3521\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/observer.js\":\"07a49c37409d0bda\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/reconcile.js\":\"381a27d7382ad7c9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/timingMetrics.js\":\"4ac8c19b0424e646\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/treeQueries.js\":\"25355a1f6a6db9ab\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txEngine.js\":\"7d2f4a75673ecb53\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txSnapshots.js\":\"a559d59c61144bc4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/typedBlockQuery.js\":\"657fb470b0c63e69\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/undoManager.js\":\"2b36afdf80a2a2d0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/invalidation.js\":\"38e09483661deeb5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelDataExtension.js\":\"c02dd8a4bd18e5e4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelPage.js\":\"91b509ce03aa9a0e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelValuePresetCores.js\":\"b304d8ec4c4b6e8b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbCorruptionSignal.js\":\"c57d0ac9375299af\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbStorage.js\":\"41be0222381425ee\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbVfs.js\":\"808d9732f278b9d1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localSchema.js\":\"7bb737ed2dbd2d87\",\"/knowledge-medium/pr-preview/pr-1789/src/data/maintenance.js\":\"8ac40c0d7ec05b34\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mergeProperties.js\":\"77a4e6bbd2139526\",\"/knowledge-medium/pr-preview/pr-1789/src/data/metricsConsoleHook.js\":\"4d2a7160ba429ce8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/migrationsPage.js\":\"5d74eabee040a130\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mutators.js\":\"5aca0145040f2990\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKey.js\":\"0b448c74f19ec0f7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKeyPlacement.js\":\"24fcef24dc21ab14\",\"/knowledge-medium/pr-preview/pr-1789/src/data/outlineSurface.js\":\"f82af72378f73cac\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingEditorContent.js\":\"152a1b88242344c8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingUploadsSql.js\":\"a558a7cfdac1a093\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pluginStateExtensions.js\":\"9929dc1091b4c725\",\"/knowledge-medium/pr-preview/pr-1789/src/data/powerSyncLogger.js\":\"6bde088f633dc1c2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/projectorRuntime.js\":\"c963b50c06c4beb0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/properties.js\":\"135e3552d004605c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertiesPage.js\":\"bc6ebba5e92c751c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyChildren.js\":\"b4269adde20e230d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionFanout.js\":\"799c1a60226ba7f5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionMetadata.js\":\"c8c3cf3f6f3c7f14\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionRegistry.js\":\"e601ef1241ea01a0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDisplayMode.js\":\"ea34135853046eac\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyRowCreation.js\":\"539083f4d2156b6d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySchemaCreation.js\":\"c202df49c69a26f1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySeeds.js\":\"8d2cbf1a1ec6f248\",\"/knowledge-medium/pr-preview/pr-1789/src/data/recentsPage.js\":\"043597c0e1f41ede\",\"/knowledge-medium/pr-preview/pr-1789/src/data/referenceBlock.js\":\"4ba711eac0c32f76\",\"/knowledge-medium/pr-preview/pr-1789/src/data/releasePowerSyncConnection.js\":\"4503988b16065fae\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repo.js\":\"f44ec4dd96c77814\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repoProvider.js\":\"281155fce1d6089b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/rowProperty.js\":\"7dfd97e2448d867d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/searchFilter.js\":\"a06ebb118e93ee04\",\"/knowledge-medium/pr-preview/pr-1789/src/data/seedIdentityLedger.js\":\"5f7f2a1996fca6b6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/stateBlocks.js\":\"a514d238f772fccc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/structuralEditPolicy.js\":\"72c543b4124eb4fe\",\"/knowledge-medium/pr-preview/pr-1789/src/data/subtreeDelete.js\":\"93d5a1c4f4d95b4a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncStreamLock.js\":\"d5e2e75a5e61b4c7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableSqlRecognizer.js\":\"42d192140105b540\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableWriteGuard.js\":\"1af4b109dd0104e7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/targets.js\":\"f7abae3a63c99df0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeColors.js\":\"44fb19828842cce6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionMetadata.js\":\"bbc9021eee96f5a4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionRegistry.js\":\"c76391dd234d3eaf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeExtraction.js\":\"d67c50687c52e25a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeInitialValues.js\":\"a6b57da0b58cdf05\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typePropertyGroups.js\":\"9053ea54aed93a5e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeSeeds.js\":\"a43a38f3742832d0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeTagger.js\":\"bda1d496e9d5e4bb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typedRecords.js\":\"264789a923c2486e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typesPage.js\":\"d131791933719a48\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userPrefs.js\":\"20b38fbf5ec297b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userSchemasService.js\":\"4c68a66157561e75\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userTypesService.js\":\"1b7e06812b60a377\",\"/knowledge-medium/pr-preview/pr-1789/src/data/valuePresetRegistry.js\":\"da7e8a64f407b8eb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/visibleChildren.js\":\"d7c785f1e8c33b7d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceConversion.js\":\"0e862ba5107f01c8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceFirstSync.js\":\"c67c5975c6ae0505\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceIdNamespace.js\":\"a979b336dcc53182\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceSchema.js\":\"4409f17154d7b9bf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaces.js\":\"739bb07fe4483347\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadLog.js\":\"48ed8b6397c8f01f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/BlockPasteShellDecorator.js\":\"9d85a3dc5aea533d\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/atTrigger.js\":\"ca5726786bd69e5f\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/autocomplete.js\":\"dea6aa6679effefa\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/codeMirrorExtensions.js\":\"1ad4142bdd69aae9\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/contentFlush.js\":\"aace09bc24ca69c7\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/defaultInteractions.js\":\"7635cfc7551ec9e6\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/editSettleSignal.js\":\"90def5fbe5974492\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/insertImage.js\":\"1b22c79993e9fc31\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceCompletionRange.js\":\"e670427c5c237469\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceTargetTypes.js\":\"0e55c15342506228\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/syntaxContext.js\":\"a0cd2c9a2be9c091\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/triggerMatch.js\":\"eeef16e82fe9e6ce\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/AppRuntimeProvider.js\":\"446e84ddfb894926\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/BlockFocusShellDecorator.js\":\"83546e5e14616652\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/ExtensionRenderBoundary.js\":\"2666fb4a727c4f64\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/PanelContentRecovery.js\":\"ea53f05b8b607ab3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/apiCatalog.js\":\"6a05c1f3b3ad15cf\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/approveExtensionHere.js\":\"2ba54d67f66d0532\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/armedCutAppMount.js\":\"d0c2b20d4832692f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/batchableKeyedStore.js\":\"f495c50716a879f7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockInteraction.js\":\"06d16747cce230a5\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockSelectionAction.js\":\"634b38cfebf5c92d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compileExtensionModule.js\":\"17057c7817e2d720\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compiledModuleCache.js\":\"335bb2f2891a657a\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/continuousGestures.js\":\"e1cab852519d46e7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/core.js\":\"e4a25f88dc96feca\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/defaultRenderers.js\":\"98ec8c53d2363c91\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/definitionFanoutAppMount.js\":\"95de9c9036d04b2c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dialogAppMount.js\":\"8b811bb391bc1367\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensionSeeds.js\":\"ae707b0e59656899\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensions.js\":\"0e3a7aac7c212fae\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/exampleExtensions.js\":\"b9f5f8690b18747d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionApprovalStatus.js\":\"22f9e9fa285f610f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrorToast.js\":\"eadd91ccd2b7e557\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrors.js\":\"04be81787c764326\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLookup.js\":\"e488b440d7b61e62\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionToggles.js\":\"4d5f56b211dd7814\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionUtilitiesCss.js\":\"9ee5054ecc824564\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/kernelPageDeletionGuard.js\":\"e7d695fc362e5d6c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/liveRuntime.js\":\"60c4b59d353a1f5c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/openExtensionsSettings.js\":\"5bdb7e1136f94923\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/overridesCache.js\":\"903f0de0505b79b1\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/pluginIds.js\":\"4e7fcc4655a38f17\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/processorRejectionToast.js\":\"a428449aafe0c868\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeActions.js\":\"b3c7e94a73a3b74b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeContext.js\":\"f2e61df2f82901fb\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticAppExtensions.js\":\"b9c6cc24db985bc3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticDataExtensions.js\":\"7c68d32c2ad9b419\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/toastAppMount.js\":\"a3282d7c8ae4df5a\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useOverrides.js\":\"d64d8e51da87940b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useShortcutSurfaceActivations.js\":\"b566918b74a1fac3\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/discoverToggleTree.js\":\"216f0cd4c483d551\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/facet.js\":\"b9e458f199c7866f\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/resolveAppRuntime.js\":\"1de0df13dcb9f6fd\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/runtimeEvents.js\":\"19ff4ba095c78ed8\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/togglable.js\":\"8b5f23df90d9e136\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/variantFacet.js\":\"12b6850d18eba9e9\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/verbFacet.js\":\"a49980fe2b4376c5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/block.js\":\"998ba65e66ddccd9\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/focusedChild.js\":\"68ac3c48b209a181\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/propertySchemas.js\":\"8b685e5f38675dbf\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/typeRegistry.js\":\"ec7579396f02fe06\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAncestorCrumbs.js\":\"762e5e5835a98f95\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAutocompleteListbox.js\":\"3f510c8ef4306603\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedSearch.js\":\"c2b5cbcc76b5df62\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedValue.js\":\"005134861cca846e\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsFocalRender.js\":\"4eae8c447cca6501\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsReadOnly.js\":\"48e879b890a017ed\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMaterializeBacklog.js\":\"6703f5847f3b46e8\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMinuteClock.js\":\"e1489dec2fc653f8\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePanelLayoutProjection.js\":\"b0c25fed9eddbb02\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePendingInvitations.js\":\"946a13424bb7f6a5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRendererRegistry.js\":\"7f86e17b49ff1780\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRetainedFieldRows.js\":\"3d53ba17636846ea\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useWorkspaces.js\":\"54bedd7fbc68fcdc\",\"/knowledge-medium/pr-preview/pr-1789/src/lib/utils.js\":\"4438087c5467cd50\",\"/knowledge-medium/pr-preview/pr-1789/src/main.js\":\"ee7c33aad81919f5\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/MarkdownImage.js\":\"8a66059f78896b60\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/blockSeparators.js\":\"c4d9d2a0f62d7133\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/context.js\":\"25f3f396dc90dd3f\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/defaultMarkdownExtension.js\":\"f757ae27f7c6f1f7\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/extensions.js\":\"b1a331f6206287ea\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/renderMarkdownHtml.js\":\"f5c3f8b1e061aede\",\"/knowledge-medium/pr-preview/pr-1789/src/minimal-editor.js\":\"8875e71419cdf664\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/armedCut.js\":\"86008bd8f73bb337\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/captureMediaVerb.js\":\"7f5e7a8967cf980d\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/clipboard.js\":\"21c351fb332c1fd7\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/decision.js\":\"85c6ab340b51fb1b\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/operations.js\":\"30d7c62a6258cd7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/AccountHeaderItem.js\":\"6f5408ee6b7e83d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/index.js\":\"3ab53239d1669f08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7803ffe9994cc0a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askAgent.js\":\"40888078fb26dc28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askedStore.js\":\"65d2fce0a069ad7a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"62b70b5565f68848\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/chipState.js\":\"7eeb4e5ab8836567\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/dataExtension.js\":\"45a21e1da95e4138\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/index.js\":\"e4dc9c09a3b8f627\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5c4fd10355133a79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/schema.js\":\"15028d0a03b55f99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cc42157492a0d59b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3048b87aaac4cd9f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/addMedia.js\":\"278a26886c676aae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9f3ed7fa857a5da3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/block.js\":\"b01cf7f167a4febf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/context.js\":\"bce87004ca3a74ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/displayIds.js\":\"98ce59a2bda2a8e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/index.js\":\"e6b422e15880fcee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/outline.js\":\"c4a86ac88f74abb5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/properties.js\":\"d7ded2e10c50f083\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/refs.js\":\"39dd3bae024449ea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fdeae5e4b59c8ee5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/search.js\":\"ebc151b2ea40be77\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/shared.js\":\"575f21e82a4528e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ff68955887eb3857\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/text.js\":\"d3fba68e57cfe14f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentWrites.js\":\"1c504d621df85cb6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/authoringCatalog.js\":\"21995c536994ca66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/blockRefTargets.js\":\"ebfaa06b4c9464b2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridge.js\":\"68bd75d74ed6c7cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridgeLoop.js\":\"021d754ac17a745c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/changeHistory.js\":\"efda21f65209eeba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commands.js\":\"383733bf6050e954\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commentsCommands.js\":\"0d9d87c0a238a9a2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataExtension.js\":\"333c99454a17472e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataModelGuide.js\":\"229fc6ebe3e3ae31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/describeRuntime.js\":\"b5125cf5deb07646\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/extensionLint.js\":\"2885223415cbb77c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/grainAudit.js\":\"b0a4a3d91cc87927\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/healthCommand.js\":\"2f03e4faabc4e71d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/index.js\":\"51aa8ed2953d505e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/presetIdentity.js\":\"84699d30af55df30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"deca18ee7575c65c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/readMedia.js\":\"09d044ff756aaa6c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/schema.js\":\"71e1d366a2300150\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/serialization.js\":\"83b1897e5a6984d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/targets.js\":\"994b41b085b00445\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/tokens.js\":\"faae576188840080\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/watchEvents.js\":\"14ef5acf25c85bfa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/workspaceGuard.js\":\"e360a3efd1b999b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/writeCommands.js\":\"47224bf5a95e1838\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/AliasCollisionToast.js\":\"590022b86f3716f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/DuplicateNameBanner.js\":\"29e820530b90449f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/collisionMerge.js\":\"ff9774161bebe8ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/dataExtension.js\":\"bcfd9a8a6d0922cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/index.js\":\"679197082098c83f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/mergeCollisionAction.js\":\"0dfeed5d9a47a549\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/pageStyling.js\":\"40ca1e810aab81a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/rejectionToast.js\":\"a691e432b0209a62\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/syncProcessor.js\":\"bad0bf4388094672\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/actions.js\":\"8aa97e543fc232a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/addComment.js\":\"9fa9a6d074cb70d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchor.js\":\"5e989531c92bd646\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchorState.js\":\"bd91d194662d3a45\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/commentLinks.js\":\"894086f28d6941e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/confirmThreadDeletion.js\":\"e683630069299659\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/container.js\":\"40c2f84fe4ed5b59\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/dataExtension.js\":\"39d261e0141b6d22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/deleteComment.js\":\"ad404e5ca02c630b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/highlights.js\":\"6deb257e4689110a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/index.js\":\"17957562c3d08055\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/linkedCommentsPill.js\":\"0150eee731223a54\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/margin.js\":\"d3b1da64b624e959\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/marginSchema.js\":\"09cc26346b5a2424\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/newComment.js\":\"b86904b4db3eff22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ownThreadPicker.js\":\"7020021f759a7dc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/placement.js\":\"d2fa381c8cae6a7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/queries.js\":\"0e544876ec18246e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotePosition.js\":\"b18bfed7bcdae742\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedIn.js\":\"44b89f0500a786c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedRange.js\":\"0f2c95f5a19529c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/rangeRefs.js\":\"a59f5727f722849f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readHighlights.js\":\"9b28538d09bedf36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelection.js\":\"0234bfdc30afc4a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelectionUi.js\":\"dd11d3b76eb3cff8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/reanchor.js\":\"f46cc94198d24f59\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/schema.js\":\"a7c2f3f979ae8780\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scope.js\":\"5f9f04cd54521549\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scopeThreads.js\":\"a53b3bac7c37e069\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/splitRetarget.js\":\"186bae393e3f7720\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestionCard.js\":\"3e0dbba112a80fb5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestions.js\":\"c72ec938044c2160\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaries.js\":\"8fa1201eb1cbf26c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaryBatch.js\":\"fb7dcae79ba3eaa9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/surface.js\":\"b3df6446878490d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threadNavigation.js\":\"5415130201c59487\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threads.js\":\"c319f42185d36b78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ui.js\":\"7214ea8852b638cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/uiStore.js\":\"7e8c38d61c617b5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/appIntents.js\":\"bb32b6023be9293d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/index.js\":\"963f6d3718c91702\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/index.js\":\"39533f31a18741b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/status.js\":\"36328afe6221f62c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"45b132da5d97248e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaBlockRenderer.js\":\"9545f8eba20506d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b00990ba9830b9ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaUploadReconciler.js\":\"ed4fd219420e692e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetDownLane.js\":\"ef83d8522b7f55c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetResolver.js\":\"82e5275ae3bb5c23\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetUpload.js\":\"c48f13350339fb79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/attachmentCleanerIO.js\":\"e38bd106f7a5465c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f2dc4e0e98e25e1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/blobStore.js\":\"fd7b6071b54a47ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/byteStore.js\":\"35846e660240fe9c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanerIO.js\":\"6de48d4eca690e0b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanupAttachments.js\":\"1531d03f2683b57d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/dataExtension.js\":\"ad8fd7fbb87e5906\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/downLane.js\":\"d46e0b3ed5083ec6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/index.js\":\"80ac21aee5b828bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/insertImageContribution.js\":\"fcde9bd11fd92365\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneArming.js\":\"04589c8c6507140a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneLock.js\":\"c4f8b18f1e615cde\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaBlock.js\":\"9c916aba3816aeb6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaCapture.js\":\"2cdd5e566b580549\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewers.js\":\"18cf4fa05ab2b223\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewersFacet.js\":\"6e3c56b82f91c317\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/pasteCapture.js\":\"b3c0496854355ed4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/resolver.js\":\"311dcf85bfa5af31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/retryUploadsAction.js\":\"faaa10fe4ecddbfa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/storagePaths.js\":\"fa1885626633850d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadDrain.js\":\"91148584b3bf80ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadLaneStatus.js\":\"7c4b090a9cbe2ae4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadReconcile.js\":\"d4edde634ca0219c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadRecovery.js\":\"3fb1ae11c2a4f786\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadStore.js\":\"73b1edf6fc3e92f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/useAssetObjectUrl.js\":\"a8bc7cb6051ea53d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"905a90312394208d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0ba66e63e01e5cfe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/facet.js\":\"f39527502a938d73\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/index.js\":\"c0c1fd7432858087\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/prop.js\":\"6279640a7652d1ce\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinkFilters.js\":\"a79c6e15fb99adde\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"319056dc243fa27c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BlockEntry.js\":\"ccc38e21f53d84d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/LinkedReferences.js\":\"5d222a78fdd68e3b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"825ddce03092f3ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dailyNoteDefaults.js\":\"78ee7ccea782f720\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dataExtension.js\":\"870f9a984deec27a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/edgeExclusions.js\":\"3303007e6da62e45\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/filterProperty.js\":\"2a4c806b359b35e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/index.js\":\"ba48a9d9cc4338c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"eeb86e441da68829\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/applies.js\":\"345bba643508cf52\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/countQuery.js\":\"f3427a488d434b6c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8306b9c8ce63f54b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/index.js\":\"4bcd0d69df2842ce\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b8bff27b1a521df6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/presentationInvalidation.js\":\"4b89024ef70fe10b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyEditorOverride.js\":\"8e5807ddef02e925\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyFilter.js\":\"9025d9540fbfbd1a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/query.js\":\"c9fcf10142966b28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/resolveFilter.js\":\"fb4d630f249b8022\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sourceBatch.js\":\"70159334d4d08094\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sources.js\":\"729686fe9ebb234c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useBacklinks.js\":\"ec39f31447cfa356\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c3430658c3782403\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayCelebration.js\":\"c37e217f2d17ec26\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayOverlay.js\":\"32f9bfbede7ccc60\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/gate.js\":\"066671132670ab48\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/index.js\":\"6bf55cc5b78c12c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/wolfTheme.js\":\"5949b85e64e4334f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/BlockDragLayer.js\":\"97f7e621038c65c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dragController.js\":\"b38c1a1a01de0831\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dropTarget.js\":\"0e63674d78187a75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/index.js\":\"6d39d84b3b137f20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/projection.js\":\"cd395794a16ef204\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/BlockMetaCard.js\":\"cdf05a2aac018656\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/index.js\":\"523e0fbefd1832af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/AddTagDialog.js\":\"72bafed5c2c958af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8c0afcfbd449129e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/TagNameIssueHint.js\":\"60014b39304bbbda\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/addTagAction.js\":\"cd581d36ce525a82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/appendTag.js\":\"8da6991fcc93003b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/config.js\":\"412d45683d6d8781\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/dataExtension.js\":\"2e085f0a0e54451c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/index.js\":\"efc07ff6cea93785\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/propertyEditorOverride.js\":\"30620e05bfb7e036\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e4faa1afca4f989c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8375819e9cccc33f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f7458e79cfacde3c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"884492a44f8f5ff5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d5286091f15a9584\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/index.js\":\"6bd531f0636684a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b1fecbcdcfee99c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/CharacterCountItem.js\":\"c5d4ace1a97cf6c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/ProfilePropertyEditor.js\":\"07e8dc5a3ae62654\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/actions.js\":\"9d8a4dc6b76f9ed9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/blockType.js\":\"5e90edc4005a9dee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/charCount.js\":\"49f2aa9c7225bd77\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/dataExtension.js\":\"6c6b49a15088fa44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/index.js\":\"0339ebfa9ff1ae97\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/profiles.js\":\"c964a4656179cb8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/properties.js\":\"940457b8a702e931\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/textCounts.js\":\"7ef8193b293bda26\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/colemak-keybindings/index.js\":\"38bc8dbacbda0dcd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/CommandPalette.js\":\"828a8449f359b6e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/HeaderItem.js\":\"29097fc7182b03f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/context.js\":\"829a63040b2cc2a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/index.js\":\"3aca9a7a9419754a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/selection.js\":\"10e216be47a7b749\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/toggleStore.js\":\"c1b7b7bb7644de0b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/useCommandPaletteActions.js\":\"db4da31236e6e473\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/ContributorBadges.js\":\"bbdaa4667db344b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/author.js\":\"d5b9170c76d4f551\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/codeMirrorExtensions.js\":\"7ae31dae5cbe0072\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/dataExtension.js\":\"f530d8dd55749c90\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/index.js\":\"8d71221b4790de6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/mentionAutocomplete.js\":\"66ab859fe3fa79e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/processor.js\":\"7a52b8bd3c4e569b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/profiles.js\":\"f051a65e69476df0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/queries.js\":\"ca3a13de56046108\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/schema.js\":\"d2210fe846fe8a47\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"81f6b293aeaa335a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/followOrigin.js\":\"72d387badfac69f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/index.js\":\"4b9ac2b699e3b5a4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"999b8eada30c2e1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e6be184aa9dc749a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/CalendarGrid.js\":\"f8a9a0fdc12f00d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DailyNotePicker.js\":\"6ecb42bd71cb8775\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"55010e63b1f9a497\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateNavDecorator.js\":\"bcf98ff0346c6096\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateScrubOverlay.js\":\"9308cfa075910fe8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/HeaderItem.js\":\"6fcc22cf58b18c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/ReschedulePicker.js\":\"bab233ff9b1553a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cc5bce27b0f6af75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/actions.js\":\"f30ddb85af6ee046\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/blockDateAdapter.js\":\"39ae19616b06a9cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/calendar.js\":\"8bf99ba1eaaec3f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dailyNotes.js\":\"e0177a7448761510\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dataExtension.js\":\"54f2cc246812cea8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubActions.js\":\"912dc56c1345bae2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGesture.js\":\"76ca349e6bea7872\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c5cadf7ea6284718\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubRecognizer.js\":\"560eaaa46a7276de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/deletionGuard.js\":\"f7e2d735678612eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dueQuery.js\":\"9a7f19bac34629b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/index.js\":\"8053b26c618eed4d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/landing.js\":\"f4c3cdfa2f2ab729\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/localSchema.js\":\"fa242546acc582f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/referenceDateAdapter.js\":\"dbdf325ea67c9dc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/rescheduleAction.js\":\"92d45bda43bbb0d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/schema.js\":\"52a2a4f29bff4dba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadBlockDates.js\":\"c140bf6ba1c29679\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadDatesAction.js\":\"705d518f2bf90311\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/today.js\":\"8b1c4a10e1d293c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"255eba45107ac79a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7f8aca0c5307b640\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/audit.js\":\"cd8854cf05d123fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditAction.js\":\"11dd40591ff0a3c7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditRanges.js\":\"552cf89108165ede\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/diagnosticsSource.js\":\"5bf7ddcae22fc3db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/divergenceScan.js\":\"c2f93f42db0967ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/index.js\":\"8409d5902f33fada\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/propertyChildrenChecks.js\":\"adae319d78bbe4e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/referencesMirror.js\":\"5e0da6682f46a263\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/rowJson.js\":\"87a9b924121ec968\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/schedule.js\":\"4a8cb736c9bece70\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/store.js\":\"349a17b3cebf1ee5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/action.js\":\"9a9315c93cd3935d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/index.js\":\"fc216d08845bd409\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/plugin.js\":\"417ab6bd31512e87\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fa84ea25bbb6d03b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/actions.js\":\"cfb26ee7a9b1e0c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/changeMarker.js\":\"7cc04ebb78b63332\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/diagnostics.js\":\"59689abda1d4e815\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/fileSystemAccess.js\":\"0f1d43d0f8fd0471\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/filenames.js\":\"50b8c2396e04e836\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/index.js\":\"f54c971d77e53f19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/mirror.js\":\"bfff69591d0ce04c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runLock.js\":\"19e609963502d8c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runtimeHealth.js\":\"22a8663c7dd81d14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/schedule.js\":\"a28016a81ceb91c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/store.js\":\"b34b4516c6e218f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/index.js\":\"b3cfd7a0fc465cb3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/themes.js\":\"9133db7429be974b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/facet.js\":\"f5b93c3d2368192a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/useDiagnostics.js\":\"318ebd0e5ab37ec4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/dismissals.js\":\"6845003832d9a894\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/index.js\":\"3fa68fa3c6cc3128\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/status.js\":\"c734350bdb57a23e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/store.js\":\"d00f40f46938d6cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1c2f9db6c1d0ed73\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsSettings.js\":\"59f64d535175244a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/actions.js\":\"2d1ecc3617bbf058\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/config.js\":\"0fd3ec0e72a42cb4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/dataExtension.js\":\"d082728a2cf9241c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/effect.js\":\"9eb1c54de74e06a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/index.js\":\"cc0bef2f52ed0dcd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1af9b36df23797a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/useToggleTree.js\":\"f05128974d1f1bbc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/ExtractTypeDialog.js\":\"8481b9a9ba7c47ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"624833ba4b351e28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/PropertyShapePicker.js\":\"45fb105f8e81718c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/action.js\":\"3d705c7e86621ec4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/index.js\":\"c03a958ed13fb10a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/FindReplaceDialog.js\":\"22ccacc1f3ddc6f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/HeaderItem.js\":\"d381f87399a85c5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/dataExtension.js\":\"5565eb0e44b1c39b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/index.js\":\"6277a965da610329\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/search.js\":\"ac6bc494661ddfff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/toggleStore.js\":\"6007b4dd944cf87d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/LocationPropertyEditor.js\":\"2a052c281565ad1a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/MapView.js\":\"e2b783b8984d119b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/blockTypes.js\":\"901d983f14ab21f1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/codeMirrorExtensions.js\":\"69d5f314788d6c95\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/createOrFindPlace.js\":\"af484d60bdf3e668\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/currentLocation.js\":\"90a8ae6340a4e589\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/dataExtension.js\":\"d74fea8fb4891a0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/geoContentDecorator.js\":\"a067e8863f972167\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/googlePlacesClient.js\":\"1de99af21c5941c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/index.js\":\"f181fff487d3f7fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/locationsPage.js\":\"f9a8f678767869db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/mapViewport.js\":\"d253043c5fcdf9dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/pickCurrentLocation.js\":\"48c45964687de595\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeAutocomplete.js\":\"fabec8f7f2efb594\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeNameCollision.js\":\"ca2c0de220d98d41\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/properties.js\":\"8abb961a4c901a83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/propertyEditorOverrides.js\":\"1561bd4282e90da1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/query.js\":\"a8fc0a9cb5e68b2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/usePlaceSearch.js\":\"d60a0300fb587a0e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"739b78c881ebe933\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c0a68d0ac910a8df\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"eb07609f64405cf8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/config.js\":\"cf1591d09ee1aa57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/dataExtension.js\":\"553b6a4aa2adb767\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/facet.js\":\"631bdb109324005f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/grouping.js\":\"fc791d6aa05dff5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/index.js\":\"6035a1fb0d883a96\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"80f351b2bf74add8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/query.js\":\"de2ef2d5622f973d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/resolveConfig.js\":\"de1c20884081890d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fd446197ecadf957\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"eeb1d68d0d82cab8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlDocumentContent.js\":\"e64879ff9ef64bc1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlFrame.js\":\"a50319f5a5bc3cbf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/actions.js\":\"b9141c64b10cfe1f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/blockType.js\":\"9bab5c45698aa731\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/confirmRunScripts.js\":\"f5d43319fc23cdd8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/dataExtension.js\":\"7d3686d4a56fb534\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameAnnotations.js\":\"0e4fea148ea39875\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameDocument.js\":\"99974671f8c1660f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameTheme.js\":\"5477fe96dd43ee83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/index.js\":\"0a697f8b2c1371e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/scriptConsent.js\":\"85066c49e5c29d58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/sourceMap.js\":\"78950e68d763d9c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/useDocumentScripts.js\":\"8eb69b269b813ce7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/index.js\":\"d4334ebbc03cb3e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/record.js\":\"39f742716a93d14f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/recordStore.js\":\"660ee06bdd832d1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/responsiveness.js\":\"30d07cfa88ce51fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/schedule.js\":\"11cf290ffb953f17\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/sessionContext.js\":\"c5f2d7d86b83176c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1def24fe7d71aeb2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7fd28cecf070d987\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/actions.js\":\"b37d7d3d624373b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/config.js\":\"2b5f63b821502b2f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/dataExtension.js\":\"6bad10b8d7b9f3a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/effect.js\":\"16d93a1775329621\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/index.js\":\"5523eab669d28d7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/keyCapture.js\":\"7a5acd222da12c53\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/overrideStore.js\":\"30807bf782d2f84a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"64e8a9ad00c639a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/HeaderItem.js\":\"a709c7e3adb2405b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/LeftSidebar.js\":\"04f04a5ea4d44418\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/actions.js\":\"408cce00230707b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/facet.js\":\"510567bc9c80ca83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/index.js\":\"c66062293b7feed8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/shortcuts.js\":\"bf1ba0b0a7f38a9f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/toggleStore.js\":\"a4859d7b3b8658d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/MergePicker.js\":\"a5db9df252aaa2df\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/index.js\":\"7c4f05507921fe57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/mergeAction.js\":\"9f717b3fe55907c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/strategy.js\":\"00bf7dadccd30cca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/Button.js\":\"c9de4adec4ec8431\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7282696f71a0804f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8f5b9b64afe77e46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/facet.js\":\"e9aa51d2d7b0607f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/index.js\":\"c4ff5956f6ff35fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a4acc07eed6b8950\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/actions.js\":\"08c90cebbc8de863\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"afcf1c2e0bbc0f9c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e0cf9b6bad861014\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/index.js\":\"5d70de1856aa40ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ba20476811a211fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8450bedf6641db95\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/contextMenuItem.js\":\"5d95313339a52bf8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/index.js\":\"057fcf9b6b997070\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveAction.js\":\"0df66fdb32fad462\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveBlocks.js\":\"51f802e6c4f27e78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/selectionAfterMove.js\":\"dfc60dd7cdf33edb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/TutorialBanner.js\":\"9eb5989fe4b5ced0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/action.js\":\"e7d60f2ae768bc9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/bannerDismissal.js\":\"56a4809ba9b9aef8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/documents/cheatSheet.js\":\"22a5a8d6e965ad86\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/index.js\":\"0273ae3f3e101599\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/keys.js\":\"97a821d7ed6e8a9e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/landing.js\":\"76c41e62db69526b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/outline.js\":\"ba047d1923de6514\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/seed.js\":\"f93faeb067942c9a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/PerfTrendDialog.js\":\"eb334eb39cd5f7fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/analyze.js\":\"a093df202c920b8d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/diagnosticsSource.js\":\"6bc7ee93afa2d93b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/index.js\":\"2b375f18a480c355\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/load.js\":\"2fc16aee3aacc0fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/monitorRun.js\":\"9d59e2d313163e9d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/schedule.js\":\"311b28606454dbdb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/series.js\":\"8b8dbe30ed11ad66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/store.js\":\"4a705f53ff33f775\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/trendAction.js\":\"31bc05f71979a7f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/verdict.js\":\"2fb6f84140e6a742\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/clickToEditAction.js\":\"1aeed5fd4862f3ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/index.js\":\"7ea8c227fe82ac5d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/interactions.js\":\"1bf8d01977505a93\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"35c2e56e609909b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGate.js\":\"8e89ad40666494a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGateDialog.js\":\"522b51d21047825a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/action.js\":\"958502c85e3023bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/index.js\":\"c0b7fc85c0f75385\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/localRunMessage.js\":\"6a03217a920582d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/plugin.js\":\"4b827871e89b6dfc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/progressReport.js\":\"f3606f7a78ad1a86\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/sweepProgress.js\":\"365fc760cf44442a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/FieldRowRenderer.js\":\"a6bde53268f187a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/ValueRowRenderer.js\":\"16805cba3b1ee9dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/actions.js\":\"3523a71b66511988\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/autocomplete.js\":\"1b9a2fdc398bdb89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/fieldRow.js\":\"8b7a292613a637ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/index.js\":\"7657f59192e67c5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/referenceWarning.js\":\"d63ae80270eb9efb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/resolvePropertyValueInlinePresentation.js\":\"5ff04446c86fb1d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueAutocomplete.js\":\"7c69a3090bd97f3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueSchema.js\":\"52b0237ee9033ef1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/HeaderItem.js\":\"a8c604e7ad2e55ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/QuickFind.js\":\"394c30aaa88b447f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/index.js\":\"39f29e9a29126100\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/recents.js\":\"6a9767cb7785df61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/resultItems.js\":\"7129693a0549e1a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/selection.js\":\"1eb2aa277bd08b1f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/toggleStore.js\":\"46fe8e98a096c549\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/HeaderItem.js\":\"a3570152bad7e3b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f9985a2b805382b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/grouping.js\":\"9d3d132f0eea1cea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/index.js\":\"a75f15ca848972ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/target.js\":\"f367991b2ceb2d8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/codeMirrorExtensions.js\":\"8e259008da308aa9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/contentPrefill.js\":\"bf6f01bc7388abc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/dataExtension.js\":\"daa34ca09262bc6d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/index.js\":\"0de15e127c4ffb24\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"035c2ec8485b6d49\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/invalidation.js\":\"798d61928d7a28f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/localSchema.js\":\"346a86bfe1ee86c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/index.js\":\"ff1573183cdf08c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"960b5f7cfbd079dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/index.js\":\"cd0aae4026114594\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/referenceNode.js\":\"0816777a63786e76\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cb93f7a2d3ab10e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fdcd892b6d8e32dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/index.js\":\"f2db8d9dec0a7310\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0394670ddfd81d03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"afd2f9649f3afe4c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/mergeRetargetProcessor.js\":\"79ac35f600bfc771\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/parseFence.js\":\"421d563a0d636593\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceParser.js\":\"aabe30ca8ef05878\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceProjection.js\":\"d1de033cc4ea0d54\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referencesProcessor.js\":\"4d96733213d4e981\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/renameProcessor.js\":\"acd89617c06d581d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/spanReplacement.js\":\"7551c1e84113667f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/htmlToOutline.js\":\"07be5201b49ace5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/index.js\":\"a5dc49b8f7f1f31d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/normalizeClipboardDom.js\":\"74d64bf6049a1ce5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/pasteDecision.js\":\"2dbe1ebecfa4729a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/action.js\":\"7640a99ef53d33c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/blockIds.js\":\"f1be02dafec3139e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/content.js\":\"c664ffdd1380db88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/effect.js\":\"7d5e6d8c09b05123\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/ids.js\":\"4ed07cbed7811071\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/import.js\":\"a2b675f5c7c09f33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/index.js\":\"edecea30a3e411c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plan.js\":\"7c803c43af508701\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plugin.js\":\"3770a6dcfb754ade\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/promotion.js\":\"173d1db9817c7387\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/properties.js\":\"3ae8b7c1555ce2f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/references.js\":\"fb17f2126f9eb862\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/report.js\":\"b46bde1dbb4c80f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/roamMemo.js\":\"fbe52ec506a77fc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/runtime.js\":\"f07cf20768e654bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/schemaReconciliation.js\":\"c05ff8b9a183e556\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/srsMarkers.js\":\"c9b91976e5e1a9e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/todo.js\":\"5b3d701651b30673\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/typeCandidates.js\":\"9fd9c942296139ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/types.js\":\"132de60537e98a44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/index.js\":\"b13c0867325e76ea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/store.js\":\"2eea0692503fbe66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/HeaderItem.js\":\"d10b381ae1ab20ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"806ede1400efda46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/index.js\":\"a1d481807203523c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/model.js\":\"93855908350571ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/toggleStore.js\":\"44331e26d0cf314c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/useKeyInspector.js\":\"d19f75cea7d73dd4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"45a8fe5a4de9a2a2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/ShellDecorator.js\":\"4e4a7f4f34799832\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/actions.js\":\"9b1ec9e0a8aeed61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5aac7047cb3187a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/index.js\":\"13a74880fe7e43d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/shell.js\":\"3d7f1427713dcf31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/surface.js\":\"b3d4944c6d06975e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/walker.js\":\"1362afbe18817dc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a65eaf690181f067\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/dataExtension.js\":\"fc130e83e1941292\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/index.js\":\"28ff223bc6cc398d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/indicator.js\":\"8e3d1562bc8b0d8e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/moveSrsState.js\":\"8b7bacfe24b380f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1946ba99b8760606\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/scheduler.js\":\"9c9e62a57720e1b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/schema.js\":\"ff456efcfb4a8348\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8f3da839ac5dce95\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsClipboard.js\":\"85e952d9ab97b9de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9be508ec9ae5ccf8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2b4eb77cb3e1176c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DeckPicker.js\":\"363c1e619bbc8996\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewControls.js\":\"9a397fe285882f9f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewDeckRenderer.js\":\"93d295d2d4d8c857\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewSession.js\":\"94c367d2055f56e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/actions.js\":\"8ff79165da563ae8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/archive.js\":\"bdbf63a37a5beeb1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dataExtension.js\":\"3c029b60e695fb4a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/deck.js\":\"82a4c1f96d93849f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dueQuery.js\":\"6b5a92539b6e84cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/gradeDecision.js\":\"93edb44c88ee8106\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/index.js\":\"d766d22caf637969\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/keyHints.js\":\"6c1697eaa24d580f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewCardLayout.js\":\"ce92664a1677409e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewProgress.js\":\"45e86b663bb8589c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/schema.js\":\"67bec1a63126e007\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/useDueCards.js\":\"658ff080ff1489c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/index.js\":\"3d1c8baa3ff9046d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/record.js\":\"752b6bfaa12ad47b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/index.js\":\"cd2985137540e3fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/persistenceStatus.js\":\"c503df5451b56dc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/requestAction.js\":\"d7e532364b5c71f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/TypeChipsDecorator.js\":\"b9a5c48991af76b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/codeMirrorExtensions.js\":\"80f6f62b7584ac13\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/index.js\":\"54be1b83282d3ec3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/typeAutocomplete.js\":\"647098d1e65e5c4f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e108ecb58904e3b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/actions.js\":\"08d544f3912db9f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/anchor.js\":\"e7d0f22e5bb81214\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/events.js\":\"ec3aadb13e374a36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/gestureActions.js\":\"a7c71a0be8071a6c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/index.js\":\"50960cb6b1e9c7e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"05efee4e394897ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/collect.js\":\"fc4ccacf0bf4dc10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/index.js\":\"30c11a148f79090d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/record.js\":\"26611102010502e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/RejectionDialog.js\":\"8325aac7270be29f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4a6519d703d917fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/index.js\":\"9d1715aa8ca894ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/model.js\":\"df6640867f34c14a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/queueCounts.js\":\"7abf9e02f897c9b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rejectedHelpers.js\":\"734cfa9deddc6e65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rematerializeAction.js\":\"fb75398c0f27c553\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/useHysteresis.js\":\"037abb6120e41ec0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/effect.js\":\"3798dbee6e0442e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/index.js\":\"932874d33a9d6a11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/theme.js\":\"1ec3c484d8ea8faf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/actions.js\":\"79f4c86ff2347ed9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/dataExtension.js\":\"46957bffde8d2b17\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/index.js\":\"e208f7f1a73d53e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/schema.js\":\"41a3c8e7e05de241\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/TouchSelectionLayer.js\":\"221a97c34e70b050\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/actions.js\":\"564332e426d4152d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/defaultItems.js\":\"1531f2dccbfe5b97\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/facet.js\":\"142f3b144ee354e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/holdRecognizer.js\":\"0063c64b73c25810\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/index.js\":\"fc7be6f1adefec5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/UpdateIndicator.js\":\"cde67c6b288fcfbd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/index.js\":\"beb9637e6000c2f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/loadTimes.js\":\"29fafe33b9841fa4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoNotesRenderer.js\":\"5d306771f0014daf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoPlayerRenderer.js\":\"1676ede43baf9dbd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoTimeStamp.js\":\"367f33f5c98a4634\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/actions.js\":\"2112a148400fbbe0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/index.js\":\"39d23a021cf7afe8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/markdown.js\":\"3310c532fe42c195\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/notes.js\":\"f9cbb93469de6247\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/registry.js\":\"90e17f904382f621\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/remark-timestamps.js\":\"89d6726ff096f93c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/view.js\":\"a33d775bbc7c291f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/LinkHints.js\":\"2e10aabb83447d9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/index.js\":\"233cbfeaecf74378\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/model.js\":\"37364489fa9fe28f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/settings.js\":\"93e7409d5f85636f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/actions.js\":\"1da00f419ed81434\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/index.js\":\"0fe98be19bc24ed4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/interactions.js\":\"fab88e6e6f11b660\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/workspace-header/index.js\":\"cebfefa5d89515e7\",\"/knowledge-medium/pr-preview/pr-1789/src/registerServiceWorker.js\":\"b5a296de86822579\",\"/knowledge-medium/pr-preview/pr-1789/src/requestPersistentStorage.js\":\"74d6210d66dc25ff\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authRequestDeadline.js\":\"4c0c8c030b8bde24\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authStorage.js\":\"07856dcc8140cdae\",\"/knowledge-medium/pr-preview/pr-1789/src/services/powersync.js\":\"d592ec90afcaefa6\",\"/knowledge-medium/pr-preview/pr-1789/src/services/supabase.js\":\"be87c59fa8654726\",\"/knowledge-medium/pr-preview/pr-1789/src/services/uploadErrorClassifier.js\":\"2f2631e225ab1ae5\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/ActiveContexts.js\":\"9203edf81e0601ec\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/HotkeyReconciler.js\":\"681b50e6f2ee0de6\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/WipeLocalDataDialog.js\":\"9d3bc67284361d1b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionDispatch.js\":\"60e8b10f425ac832\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionRefItems.js\":\"499c633b88d71041\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/applyKeybindingOverrides.js\":\"fb2ac14bed307306\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/blockActions.js\":\"f0ce7be500b6a8a3\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/canonicalizeChord.js\":\"26733b08b52564ac\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultContexts.js\":\"f1b6a90a0a5d4366\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultShortcuts.js\":\"fbb3680690251d5c\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/effectiveActions.js\":\"661363d33029ba09\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureAction.js\":\"ff37c785ba94e30a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureBinding.js\":\"803e510fafb30b3c\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/holdRegistry.js\":\"29c04a729c3c7c1f\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingConflicts.js\":\"30a1a0675cdf4e7b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingOverrides.js\":\"6d49db6705b7a476\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/pointerAction.js\":\"939e70cb5deb7ba8\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/resolve.js\":\"12238509dcd14b6c\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/runAction.js\":\"83fc3751f2f2a673\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/sequenceMatcher.js\":\"fd1d7538b2d3092b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/types.js\":\"6158314c9538f6a6\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionContext.js\":\"33296d33ead03f30\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionDiscovery.js\":\"7c7bf640107d4f7a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/utils.js\":\"d3b503bc6cfd883b\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/bootStore.js\":\"0c180f1485c6b052\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/previewDatabases.js\":\"bcb1ef3fbc566527\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/byteTransform.js\":\"1b1cf4b8b411944c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/attachmentCleaner.js\":\"41793b7a92f06613\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/attachmentParts.js\":\"0864224c76fe0bc5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleParts.js\":\"1f0373e26b6ffed0\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleRecord.js\":\"7dea1d3c5135de00\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/manifest.js\":\"748051598a10396e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/takeBundle.js\":\"eb3c815bd8de5c77\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/verifyBundle.js\":\"7dcabb579c88635c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/cleaningStage.js\":\"7cc56241db2c0d94\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionKey.js\":\"1f66fee3eb8a072d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionServer.js\":\"ba5753d562d2e9ef\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flip.js\":\"1a65f4dc24f52e99\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flipAttempts.js\":\"7883a4dccf2d46fd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/pages.js\":\"a6520f515e5f581f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/preflight.js\":\"9b6a1e8136b96231\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/reseal.js\":\"dc9c58de6fb7788f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runConversion.js\":\"82f58b56497caeb1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runLock.js\":\"49de4efe584cf714\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealing.js\":\"8b951acfe36d81a5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealingStage.js\":\"634ea4117f011b43\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/stage.js\":\"9c145d31c931feef\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/verifyReseal.js\":\"d4fb827407e07cbb\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aad.js\":\"7232a6e006455e26\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aead.js\":\"bb701da5e5440ba2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base32.js\":\"a725a56c48afb5e0\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base64url.js\":\"cc338317919f404b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/binaryEnvelope.js\":\"2aa085286892fd52\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/byteAead.js\":\"366588d355d4a0dd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/canary.js\":\"19f1343163511343\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentHash.js\":\"6cbb213b138df64c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentKey.js\":\"6adab513570d38e7\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/derivedIdNamespace.js\":\"a3296b32426241b2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/envelope.js\":\"e77c316abc4ee9ef\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/hex.js\":\"a2b885aaf84f5e9c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/sha256Hex.js\":\"80377aaaac035fda\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/workspaceKey.js\":\"746c6c4d9038f75c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/conversionState.js\":\"b8572a014a3085bd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/createEncryptedWorkspace.js\":\"42391edf85216bf2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/pastedKey.js\":\"529d0b30ed441005\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"292a6138a3dba335\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/upgradeWorkspacePin.js\":\"43a1d25c337d6ac2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/keyStore.js\":\"8c9d3dc1397ddcdc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/mintWorkspaceKey.js\":\"5a0713be349b2350\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/modePin.js\":\"b4f1ccc786379edb\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/openWorkspaceKeys.js\":\"1a65895f14d7e7a4\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolveWorkspaceEntry.js\":\"78edeab3d7483d7f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolver.js\":\"238d2a21d48155c3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/workspaceAccess.js\":\"516620f528c2fd36\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/transform.js\":\"13628e2e02a39594\",\"/knowledge-medium/pr-preview/pr-1789/src/themeBootDefaults.js\":\"ee05ff5a7dcd2e47\",\"/knowledge-medium/pr-preview/pr-1789/src/types.js\":\"90ccccc961da2e01\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/ClientLocalSettings.js\":\"98b9cf667cfc500e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/abortableSleep.js\":\"04e934b2fc77c547\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/array.js\":\"69fb01c379eda089\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/backlinkAutocomplete.js\":\"0cf6e4710a7ad1d6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockCrumbs.js\":\"69c492275310e3c2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockrefAutocomplete.js\":\"3c396722097194ee\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/cadencedIdleJob.js\":\"d3ecd8877e8a007f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/callbackSet.js\":\"852867e063bcf24a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/clientId.js\":\"f4cda0e9d2cb90e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirror.js\":\"94630fa784a60eaa\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirrorCompletion.js\":\"1cdd8ba646b08365\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/copy.js\":\"dc3329d171cfc992\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dailyPage.js\":\"a785332093a159f2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensics.js\":\"563b136aa402e29d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensicsHooks.js\":\"55d8608ca1e28ee3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/deleteBlockThroughUi.js\":\"8b8ab9a8f0b7c3a4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dialogs.js\":\"6346b9789a3d20dc\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dom.js\":\"f759aaeeb7140370\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/downloadBlob.js\":\"34a0d452181f4759\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/exportSqliteDb.js\":\"27e5b16dcd556975\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fileSystemAccess.js\":\"8513c508f2ad76c2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/flipSlide.js\":\"1ef9521d144a4362\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fnv1a.js\":\"8057cb302e5a4fda\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/formatBytes.js\":\"e941920aeba24ce2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fuzzyRank.js\":\"c88e43621741c516\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idbKeyedStore.js\":\"f42180455c2848ce\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idleCallbackPolyfill.js\":\"e682c5f79a9aace2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardAwareScroll.js\":\"6f19937942b65f89\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardViewport.js\":\"a2b9e394723d853e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/lastWorkspace.js\":\"196b08daeb18c3e8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutColumns.js\":\"c948fba23bb4d375\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionDom.js\":\"22c473fc3f6be227\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionId.js\":\"92f00839d3d8787a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkClickGestures.js\":\"34ca359382d6aec5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkTargetAutocomplete.js\":\"653a8c699131e620\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbCorruption.js\":\"9fdf3706f66fcd54\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbRecovery.js\":\"8e027febf3c28449\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/markdownParser.js\":\"eefdf2b056e50b6a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/memoize.js\":\"445d9ebe1822ba75\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameFieldCommit.js\":\"52f8df166609daf3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameList.js\":\"eb2fb9f13497820b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/navigation.js\":\"03f16e96a0a49a6c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/omnilinerNamespace.js\":\"161bd7fbd1269f7d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/opfsPageScan.js\":\"d8d7f93297fc912b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelClearance.js\":\"8a241b950ebfacc3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelHistory.js\":\"6f037c16d840c93e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLanes.js\":\"964b2ef19ef37e7b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLayoutProjection.js\":\"7f4ed647af8c3e2a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelScrollAnchor.js\":\"0ee332599ca37305\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelUrlFlags.js\":\"f2cd7e9582913938\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/platform.js\":\"51c34ca58e7495f7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/pluralize.js\":\"b46fe76e3ed88c3d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyCreation.js\":\"db3ebebdd8c05d9d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyNavigation.js\":\"5777b791e558bf18\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyValueContext.js\":\"5db9a22ad058ebcb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/react.js\":\"c91e72e5801d9557\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeDate.js\":\"53db40c9d82f47b7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeTime.js\":\"a9ebbf14deffd1cb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/renderScope.js\":\"1d9de8bd9d72838f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/resolvedThenable.js\":\"bbd69f9f1b1aafde\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/routing.js\":\"5638e041021bcb4c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/safeMode.js\":\"ed862ec5522a008a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/scheduleIdle.js\":\"40d27e894f0e93f8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/screenWakeLock.js\":\"51a2ad09dc7bdc27\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/selection.js\":\"eacbbdf28d054fc0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/softKeyboardGrab.js\":\"2c03ddd97a3f733f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/startupTimeline.js\":\"bc8be72ecb7ec0d1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/state.js\":\"b5aadd9c985524ab\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/string.js\":\"ce60a3e8b2e3f730\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/surfaceZoom.js\":\"30938ae25ca8e3c6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/time.js\":\"9c71ba326de068d8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toast.js\":\"388b8de6cf3340f7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toggleStore.js\":\"c9a0b3f3f4f1ea27\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/untilStopped.js\":\"6fa7073db8c6b55f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/userActivity.js\":\"17f02e62f0e9810e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewTransition.js\":\"095587d0e77e793b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewport.js\":\"29ae1a89b2c1b748\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/webLock.js\":\"2cefa4863970b02c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceRecovery.js\":\"57b181b30fc765a0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceSnapshotStore.js\":\"ced683242e25d4cc\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-compiler-runtime.js\":\"222acd16c74be9c5\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-client.js\":\"afaff7812a63fa77\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server-edge.js\":\"5a30f340cd9b5bd9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server.js\":\"cf0c84b08e27d1f9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static-edge.js\":\"b287b56b618ea141\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static.js\":\"ac2deeee869a2c60\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-test-utils.js\":\"e2b7962a3aea4a34\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom.js\":\"9fd56c9a63074d80\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-runtime.js\":\"e2583759342140da\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react.js\":\"21bfeccaac662fec\",\"/knowledge-medium/pr-preview/pr-1789/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
