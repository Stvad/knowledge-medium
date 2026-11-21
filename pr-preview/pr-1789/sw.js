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
		buildId: "658828bd23aa-fb9c08d3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/\":\"3341d7a2a0f42472\",\"/knowledge-medium/pr-preview/pr-1789/index.html\":\"3341d7a2a0f42472\",\"/knowledge-medium/pr-preview/pr-1789/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1789/assets/FacadeVFS-d-meU7VW.js\":\"feb96d86bea97ea8\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSCoopSyncVFS-DOCNXPTE.js\":\"27dd6ca5f860d57b\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSWriteAheadVFS-BzKWHlPP.js\":\"463234c5410aba64\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-BMA25nbU.js\":\"354886514429fcb3\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-kPYo55fK.js\":\"9ae83449ab2d0344\",\"/knowledge-medium/pr-preview/pr-1789/assets/worker-Dy_qnQht.js\":\"c59d6a5c9bb1e1d5\",\"/knowledge-medium/pr-preview/pr-1789/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1789/chunks/app-ecsRuifu.js\":\"0bf2c87508bc059d\",\"/knowledge-medium/pr-preview/pr-1789/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1789/index.js\":\"013fb566a2876d51\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1789/assets/AccessHandlePoolVFS-DwPvG84U.js\":\"660b29f9c9177a6b\",\"/knowledge-medium/pr-preview/pr-1789/assets/IDBBatchAtomicVFS-ioIc0pd4.js\":\"036bd21c1ba0e321\",\"/knowledge-medium/pr-preview/pr-1789/assets/MemoryVFS-CpOZQGl3.js\":\"6ccab0d635691d0f\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-C7RFgCwx.js\":\"752467c93608624d\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-B-Ch6wmT.js\":\"7706a6c5b62692f7\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/AccessHandlePoolVFS-AnQYckrD.js\":\"8ea5aaacb1aa84be\",\"/knowledge-medium/pr-preview/pr-1789/chunks/FacadeVFS-DbNmlFz-.js\":\"3f446401a57e49be\",\"/knowledge-medium/pr-preview/pr-1789/chunks/IDBBatchAtomicVFS-osyRWafx.js\":\"9f9ff36a946aa1ab\",\"/knowledge-medium/pr-preview/pr-1789/chunks/MemoryVFS-Bd41xhM2.js\":\"0ecb4c395b03412d\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSCoopSyncVFS-CFj_lzUE.js\":\"e2f8d546497a5871\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSWriteAheadVFS-C_Dq6kQA.js\":\"13b0f980587e2aa2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/Preview-CINaUz_V.js\":\"7646affe0b6117c6\",\"/knowledge-medium/pr-preview/pr-1789/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/card-C3OZMVLp.js\":\"c2cfa09a3accd658\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-CHBfcDv7.js\":\"0d147c4c892a9eca\",\"/knowledge-medium/pr-preview/pr-1789/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-Dz1hn0fU.js\":\"b0ab2be8c64b7c5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-async-D5F0ArBL.js\":\"7eecdd4af4d9e5c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BA7BFwoD.js\":\"7672a794872f8a24\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BLo5hv_p.js\":\"ee12462df20569ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BPObI9Yb.js\":\"5d3976ad16a9e37e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BcnA_gi_.js\":\"697c2d38d7ba8e68\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CVFqvd-K.js\":\"7c7116957bae8d56\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-Chjf1vTy.js\":\"1fdb04aa9a1cfe2a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-DQV25aae.js\":\"d508836812fd3efc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-Dn0n7iG-.js\":\"6a1a26f4e8ca5d95\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server-legacy.browser.production-DqiPwW7k.js\":\"853fc14a02cd2491\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.browser.production-Ljsa9KeM.js\":\"c0069e21744593b3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.edge.production-Bb1qGCHO.js\":\"49c9f1b2b66ab421\",\"/knowledge-medium/pr-preview/pr-1789/chunks/server.browser-CaN2etw-.js\":\"1b86a598d795e9db\",\"/knowledge-medium/pr-preview/pr-1789/chunks/textarea-z3CLHPnx.js\":\"fece84db83974789\",\"/knowledge-medium/pr-preview/pr-1789/chunks/ui-Cb9cW3hb.js\":\"d1111f64782ae953\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-DF2ZsgOn.js\":\"25c5909413dd88fe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-async-CSXkvVqY.js\":\"623aad82ffdd3ff2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1789/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/src/App.js\":\"9e4b60b49b43308a\",\"/knowledge-medium/pr-preview/pr-1789/src/appUpdate.js\":\"663259f27479643c\",\"/knowledge-medium/pr-preview/pr-1789/src/appVersion.js\":\"450b66c2f10c85e1\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/initialLayout.js\":\"c885785788f3ea09\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/openWorkspaceData.js\":\"683e5c1a628ecbde\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/resolveWorkspace.js\":\"82eb479ceb9c3042\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/workspaceBootstrap.js\":\"1b980374251b73e5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockComponent.js\":\"4f57768e35c6ebf7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockCrumbs.js\":\"61b086616c7cd135\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockEditor.js\":\"b731ea27feb779f2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockLoadingPlaceholder.js\":\"b50d017e107c5f6a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockProperties.js\":\"7747b3aae068ae60\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockSearchPicker.js\":\"2815acdcfad5a46d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ConfirmBulkDeleteDialog.js\":\"c49163aae7d5121c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DividerHandle.js\":\"d30a08b702ad53ca\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DraftEditor.js\":\"ff908d53cb36ba57\",\"/knowledge-medium/pr-preview/pr-1789/src/components/GutterPill.js\":\"535de4e773b16b8c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Header.js\":\"169d9ce1141ba4ea\",\"/knowledge-medium/pr-preview/pr-1789/src/components/LazyBlockComponent.js\":\"2fa942005ed39398\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Login.js\":\"25e95dfa7f3d823d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ZoomableSurface.js\":\"b9e1a4c2269345a4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/editModeKeepalive.js\":\"bdd630815e06699d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyDisplay/PropertyDisplayScope.js\":\"14f5b47f2fa05f5b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d3b735538083cc2b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefPropertyEditor.js\":\"5c16f1872389b350\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefTargetTypePicker.js\":\"2f999f79849b6db8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/SelectPropertyEditor.js\":\"9bc73e1ff5d5a9d9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/TypesPropertyEditor.js\":\"9ef9ef97de329efe\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/defaults.js\":\"a0eccf506c81f983\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/kernelValuePresets.js\":\"7af3a8920d12ca19\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/selectablePresets.js\":\"dd29473367f40502\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/typesPropertyUi.js\":\"12522504341cc66e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/AddPropertyForm.js\":\"3189017a3b75ff2c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyPicker.js\":\"0a2e8ba399a23b3b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyRow.js\":\"8c66338dade01f0e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/Rows.js\":\"eb725d32b0c53c72\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/actions.js\":\"effd223cd2524b78\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/declarationOnly.js\":\"393c3b8b5a78f5e7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/layout.js\":\"0167739279493680\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/model.js\":\"527baad02730b82e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapeUi.js\":\"997463108fb4f467\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapes.js\":\"26c199184043c826\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/usePropertyEditingActivation.js\":\"54c89cc02bd2b3b7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/visibility.js\":\"dbf72dbb4935a028\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanelSections.js\":\"4bbe87a075dde07a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockEmbed.js\":\"f9921882a02a27d0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockLink.js\":\"d9d354b8130e9df4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockRef.js\":\"21626537c9b1b2fd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/ReferenceLink.js\":\"f8213076db78ac78\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuard.js\":\"faf68066a8cd2093\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuardContext.js\":\"53a0b0b4429c816f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/linkInteraction.js\":\"3b09ced3b33fb543\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/referenceLayout.js\":\"c8283dab27026f2f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/useBlockRefAncestors.js\":\"48ca7d21b31fdcfc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockGutter.js\":\"6e7f6fdba426c91b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockInfoDialog.js\":\"d6ec01089cb80a1f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockTypeBlockRenderer.js\":\"1087b9c2246034e3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BulletHoverCard.js\":\"d21f64d7d70c1ab7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorContentRenderer.js\":\"f0601dce5f0e9329\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ae66e23288bec4ce\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ColumnResizeHandles.js\":\"50b3bb10446318d5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"fb5f799b4d4f5e9a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/DefaultBlockRenderer.js\":\"8978e8c87b304230\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/LayoutRenderer.js\":\"bda41162516df912\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MarkdownContentRenderer.js\":\"87f174b6eb6e0e82\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MissingDataRenderer.js\":\"6972715346673742\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PanelRenderer.js\":\"c2dd3419ff3eebf7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1f1edf6a9837f2d2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/TopLevelRenderer.js\":\"53e12d05198761d8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockGutterMode.js\":\"ba6da2304d900370\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockTitleText.js\":\"cc68188af3434e7d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/fieldCreationKeydown.js\":\"2993e43c8ee5bda2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/layoutRootContext.js\":\"65cd745cffff2570\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/TypeChip.js\":\"dd47aa1a4866eb42\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/chipStyle.js\":\"a767bdcfe600612e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/anchored-floating.js\":\"3c596cd59ecc0afc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/button.js\":\"beef9ec78640e2fe\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/card.js\":\"16fd573b9632427d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/checkbox.js\":\"5b63452f5472d367\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/collapsible.js\":\"4bd9907ac227e422\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/command.js\":\"0e8098b488a77e45\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/context-menu.js\":\"6f0c4eb563d63d8f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dialog.js\":\"010534911164e280\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dropdown-menu.js\":\"ceda910406b650f8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/floating-listbox.js\":\"b3f860c0495bcdaa\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/index.js\":\"bb953b8a1e86bc8b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/input.js\":\"8775c49987fc4aa6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/kbd.js\":\"d5510a9be0ff590e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/label.js\":\"3eea757f6a688edb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/textarea.js\":\"50d8c43de6e67645\",\"/knowledge-medium/pr-preview/pr-1789/src/components/useEditModeYieldKeepalive.js\":\"75faa53bc7f83daf\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/BootFallback.js\":\"661efb25bec98835\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/FocusedRowLazyMount.js\":\"77f7ceee08723a46\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LazyViewportMount.js\":\"f90efd71d3260d3b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LocalDbCorruptionFallback.js\":\"d038b87074f5c334\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/error.js\":\"b3eb991fc567be2c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/lazyMountRegistry.js\":\"148a381c111da5c5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/suspense.js\":\"fdb89986fbd7f1c0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/CreateWorkspaceDialog.js\":\"98fdf30a8f1615d6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/PendingInvitations.js\":\"6d73d8209fd161f6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/SyncProgress.js\":\"d847aacb470e2c53\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/UnlockProgress.js\":\"442d7575f5484ca0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceKeyGate.js\":\"5e4c897c0689c2d4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSettingsDialog.js\":\"dd507cf652b23f84\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSwitcher.js\":\"abfcdb764771c57f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSyncGate.js\":\"f3f775b9b6db8a20\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlow.js\":\"9910c5d9f24ba36d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlowHost.js\":\"ae605d5914e70e77\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/EncryptionSection.js\":\"6498bde2150ab5e3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/attachmentPrompts.js\":\"73293e2da5b51a4f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c4e3c801cbff0644\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowDeps.js\":\"4a548c6a7652117a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowStore.js\":\"34a8856a27e98e64\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/flowUi.js\":\"57f21abd72203f46\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/useConversionRun.js\":\"2812a96845e4c33a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/keyUi.js\":\"3e4282c996da308d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnKeyLoss.js\":\"50792197f3d5d30e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnServerE2ee.js\":\"38eab127d898fdf5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/workspaceUnlocked.js\":\"49cfcd5b1c9f1d3b\",\"/knowledge-medium/pr-preview/pr-1789/src/context/backgroundSubtree.js\":\"1ef9373f628c6303\",\"/knowledge-medium/pr-preview/pr-1789/src/context/block.js\":\"86d868c531d0b39a\",\"/knowledge-medium/pr-preview/pr-1789/src/context/layoutWsContext.js\":\"85b13d82563f8f2e\",\"/knowledge-medium/pr-preview/pr-1789/src/context/propertyDisplay.js\":\"682575f7c57b0283\",\"/knowledge-medium/pr-preview/pr-1789/src/context/repo.js\":\"01058402375987f0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasClaim.js\":\"3d10c474e48192a8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasSeatNamespace.js\":\"175370a76ca83b87\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockData.js\":\"0c76a900ed0493ff\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockType.js\":\"997df27f993ff73e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/changeScope.js\":\"b0430e956059431b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/codecs.js\":\"e678939c859f7eb9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/derivedData.js\":\"c14abc8b70df7362\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/errors.js\":\"d81fa60938d3ddae\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/events.js\":\"92fafd5ce37597a3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/handle.js\":\"c03a2969f7d1fff1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/index.js\":\"77751949b3941e3e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/mutator.js\":\"5b01703b1cca9ba6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/processor.js\":\"82abb811f0cb954f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/propertySchema.js\":\"b19ad045cba3130d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/query.js\":\"8bd4c986dc4715e2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/sameTxProcessor.js\":\"f7644c8ffa00c07c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/schema.js\":\"c03a2969f7d1fff1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/tx.js\":\"c03a2969f7d1fff1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/typedBlockQuery.js\":\"d951dcf112a9b795\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/user.js\":\"136f8b5dedee232d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresetCore.js\":\"d34134d12e1813ee\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresets.js\":\"45869aef9f537806\",\"/knowledge-medium/pr-preview/pr-1789/src/data/attachmentCleanerIOVerb.js\":\"82cd9ab333498488\",\"/knowledge-medium/pr-preview/pr-1789/src/data/block.js\":\"92e75804da35cbdb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockCache.js\":\"50bd961bf7ea44d6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockId.js\":\"6a7b70a59349c763\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockLiveness.js\":\"3ba67dfba891ea31\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockMerge.js\":\"8c405731224c6855\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockSchema.js\":\"50fc6cb1c8241fe3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockTypes.js\":\"a02aad197a238461\",\"/knowledge-medium/pr-preview/pr-1789/src/data/clientContext.js\":\"c9bc4a9f2bc68dda\",\"/knowledge-medium/pr-preview/pr-1789/src/data/dbFileSiblings.js\":\"527e756a90d2d3dd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/definitionSeeds.js\":\"fe55bf2912372425\",\"/knowledge-medium/pr-preview/pr-1789/src/data/derivedIds.js\":\"4446748b79340b17\",\"/knowledge-medium/pr-preview/pr-1789/src/data/drawnSubtree.js\":\"66227910415ef70a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facetBridge.js\":\"9b537ea99106d2b7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facets.js\":\"647ac52d62b8898f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/globalState.js\":\"1ea800f62369c258\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/aliasClaimRederiveProcessor.js\":\"050afb39befa349b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/ancestorBatch.js\":\"37877e8c7500bc00\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/blockTypeTypeifyProcessor.js\":\"bc58fb3fe735bd9a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/clientSchema.js\":\"70579b58382f015f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/commitPipeline.js\":\"3b59ec1af6cf4527\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/devAssertions.js\":\"f2d4bbd4d0a6d854\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/firstSync.js\":\"f43f1226bb2f46e4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/freshInitialLoad.js\":\"09b456dc53438cb5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/graphBackfillClaim.js\":\"93dd888269a9af33\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/handleStore.js\":\"fcbe9b3a6941d9e0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/idleMarkerJobs.js\":\"45714706f98bea87\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initialDownload.js\":\"7c5fe570fe3e6457\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initializeClientDatabase.js\":\"51023e0f2681d99f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/jsonCanonical.js\":\"3826c31d470b5a99\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelInvalidation.js\":\"7250d37425255428\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelProcessors.js\":\"40f2baec18a6f64e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelQueries.js\":\"b27eb6bc89e422c6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/mergeTypeMembershipProcessor.js\":\"17df8832fc0590e7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/normalizeReferencesProcessor.js\":\"d009e0fb7994fe7b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/poolInstrumentation.js\":\"46120fb2950c8c33\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/processorRunner.js\":\"83f7188da5d4af6d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyCellBackfill.js\":\"21cd2e1ae2fe4af6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildMint.js\":\"2f7d1aa3ddb13cfd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildrenProcessor.js\":\"64d7e23b07c1f9bc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionChangeProcessor.js\":\"23ea83b9135e6ae1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionSynthesis.js\":\"07cb004260848586\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyKeyScan.js\":\"fb38f136aaaa2355\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertySchemaResolution.js\":\"5ba5121ea2a19d03\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/raiseProtocol.js\":\"bf3021ac6badfb3a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/readBatch.js\":\"cb61023875320bcc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/refProjection.js\":\"3bfa6b6cd2ed72d7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetLookups.js\":\"cd96a896d237c459\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetProcessor.js\":\"ab3d339114a27b5f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/replayMerge.js\":\"03222f09ce456ba3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/sqlBinds.js\":\"ff380ab06598713c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"859357d42fd58812\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/arrivalProcessors.js\":\"8d4edee40bfca476\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/invalidate.js\":\"3c79f44e6d909836\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/materialize.js\":\"cf9a516c213254e1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/observer.js\":\"278e5fee76b77687\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/reconcile.js\":\"7a55f5c9a12a8b62\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/timingMetrics.js\":\"2f530e3c3cf9bbca\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/treeQueries.js\":\"3a1615e04b397a02\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txEngine.js\":\"10619834f66079a6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txSnapshots.js\":\"c1f0d7e932879c0c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/typedBlockQuery.js\":\"99d3befb7bdc8cc8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/undoManager.js\":\"2b1c685398e71178\",\"/knowledge-medium/pr-preview/pr-1789/src/data/invalidation.js\":\"830e52e1e0dc0501\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelDataExtension.js\":\"75653f268fde3805\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelPage.js\":\"117242059f666a2a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelValuePresetCores.js\":\"b1ddf6b092a59ed9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbCorruptionSignal.js\":\"1d0d3c84aa9c533d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbStorage.js\":\"8723748fab3fd5ed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbVfs.js\":\"57dd864edcd37240\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localSchema.js\":\"d6b93706bfe6cc7b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/maintenance.js\":\"e747df757bf90b90\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mergeProperties.js\":\"9f68e687f9fc21b1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/metricsConsoleHook.js\":\"72b0055541872674\",\"/knowledge-medium/pr-preview/pr-1789/src/data/migrationsPage.js\":\"5876a655304b52c0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mutators.js\":\"b996fd83fd63a436\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKey.js\":\"00aa3ff7236cf98a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKeyPlacement.js\":\"60a14e5701e25587\",\"/knowledge-medium/pr-preview/pr-1789/src/data/outlineSurface.js\":\"fbdd8755a2faf211\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingEditorContent.js\":\"86b2ed0194b1a414\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingUploadsSql.js\":\"c1c255be54294637\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pluginStateExtensions.js\":\"ecd11db3128e43b5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/powerSyncLogger.js\":\"5401b062df60d97b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/projectorRuntime.js\":\"827b3df2d8775269\",\"/knowledge-medium/pr-preview/pr-1789/src/data/properties.js\":\"e8f98b4fdc3baf5a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertiesPage.js\":\"21a48bcea2169bc5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyChildren.js\":\"efe24dd0ab1523c6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionFanout.js\":\"5099177b2ae2248f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionMetadata.js\":\"f8c29cc35765aff2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionRegistry.js\":\"887b5109a9bfea8e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDisplayMode.js\":\"31ff6a5e1ff58fd3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyRowCreation.js\":\"062316ae78a3e277\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySchemaCreation.js\":\"2e055e62d42a177f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySeeds.js\":\"e9debae8e1cd0cf4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/recentsPage.js\":\"734f39240904e74d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/referenceBlock.js\":\"1f40b32d23708701\",\"/knowledge-medium/pr-preview/pr-1789/src/data/releasePowerSyncConnection.js\":\"7bd2ae2652c316c7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repo.js\":\"3bd34b49b62c0690\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repoProvider.js\":\"7cf7ed1ebffe219c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/rowProperty.js\":\"b93cb1daba5540d7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/searchFilter.js\":\"46574a0a6f495ca1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/seedIdentityLedger.js\":\"af173bb08632804e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/stateBlocks.js\":\"def77e4d296021e4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/structuralEditPolicy.js\":\"ee53d836a5df69f1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/subtreeDelete.js\":\"92af59538631b350\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncStreamLock.js\":\"28c18b35f9b575a6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableSqlRecognizer.js\":\"bbc3ba4541fdc9cc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableWriteGuard.js\":\"0f02da6dafb44f87\",\"/knowledge-medium/pr-preview/pr-1789/src/data/targets.js\":\"39c7bb1423210ba1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeColors.js\":\"fc0fde6158923e57\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionMetadata.js\":\"2245293b2f625526\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionRegistry.js\":\"5b838653e47b7665\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeExtraction.js\":\"ce38c80e7a1e7843\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeInitialValues.js\":\"864f9484dee9edf2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typePropertyGroups.js\":\"fac02be540708561\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeSeeds.js\":\"dae89dfdc96c014f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeTagger.js\":\"cb988ec05da00dba\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typedRecords.js\":\"dbf8a43a4281857a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typesPage.js\":\"2dcfd384b0b031db\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userPrefs.js\":\"615cdb75d2b8e721\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userSchemasService.js\":\"f51b2f09b2bcc3b4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userTypesService.js\":\"255f9044364f9f8b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/valuePresetRegistry.js\":\"e978bcc1b31617cd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/visibleChildren.js\":\"19878ea297174f89\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceConversion.js\":\"fb0f4e7eac66071c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceFirstSync.js\":\"7014142f1b4f874e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceIdNamespace.js\":\"4abbe0abffb0217f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceSchema.js\":\"165414c62ee94bae\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaces.js\":\"90ccef45dc2847ad\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadLog.js\":\"4b1fa5bc0ef54f98\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/BlockPasteShellDecorator.js\":\"44875dba2edd9874\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/atTrigger.js\":\"f76cbe63317bab43\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/autocomplete.js\":\"11ba0ed1e7ae9625\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/codeMirrorExtensions.js\":\"05f81fddd9010f0e\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/contentFlush.js\":\"9a91ec536218672e\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/defaultInteractions.js\":\"ee5b60479470de3c\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/editSettleSignal.js\":\"35022ea10996c28c\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/insertImage.js\":\"8289985af8a0b226\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceCompletionRange.js\":\"02000a9cc48d61ef\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceTargetTypes.js\":\"e1c46447ed5f5c04\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/syntaxContext.js\":\"1ff28a707feaff05\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/triggerMatch.js\":\"697117cc677e6829\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/AppRuntimeProvider.js\":\"7a66c8dc7c5675ef\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/BlockFocusShellDecorator.js\":\"871adb1b8b19eddd\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/ExtensionRenderBoundary.js\":\"a0cca091dd1b02a2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/PanelContentRecovery.js\":\"4c6b073ef2ab6643\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/apiCatalog.js\":\"e89159cf8c6886ba\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/approveExtensionHere.js\":\"abb5730797b99dc6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/armedCutAppMount.js\":\"deb428fa79f1a680\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/batchableKeyedStore.js\":\"45a3205dab5d4430\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockInteraction.js\":\"0cbe99107cd7c0d3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockSelectionAction.js\":\"a86763eccdfc39ba\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compileExtensionModule.js\":\"e535dd1ac9e183eb\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compiledModuleCache.js\":\"eec4dad377bc57f3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/continuousGestures.js\":\"6f52e42671d494d6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/core.js\":\"a6537160b8f55aa4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/defaultRenderers.js\":\"f3402b0c0f7d1ad5\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/definitionFanoutAppMount.js\":\"c763c30ad858a499\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dialogAppMount.js\":\"67e57c7219b8d5f0\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensionSeeds.js\":\"d88c70d73dbae4de\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensions.js\":\"02f4436c218fb2d7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/exampleExtensions.js\":\"70bc9df77dc4eb2f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionApprovalStatus.js\":\"a6a15430cc2a9900\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrorToast.js\":\"c14949158dbd296a\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrors.js\":\"6be8141c3cb15e3c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLookup.js\":\"b6aeb9229df7b181\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionToggles.js\":\"95c8dd3da7c85a58\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionUtilitiesCss.js\":\"6ad092dffb528ae6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/kernelPageDeletionGuard.js\":\"adc0b3fcaf25c430\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/liveRuntime.js\":\"8bc0678d377fe107\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/openExtensionsSettings.js\":\"cae1ba438c965775\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/overridesCache.js\":\"31d9a25b85ea0d02\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/pluginIds.js\":\"d08b4388afb44a95\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/processorRejectionToast.js\":\"879d0e280af018a1\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeActions.js\":\"7fafb3049be925be\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeContext.js\":\"38a4838a423c12f0\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticAppExtensions.js\":\"61b1da53f1cf07cf\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticDataExtensions.js\":\"1831d2d2b5ec4f1f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/toastAppMount.js\":\"91eafde1290856a9\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useOverrides.js\":\"27bbdf43bd372ba6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useShortcutSurfaceActivations.js\":\"9caab4ed4057ee06\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/discoverToggleTree.js\":\"d9250cba246c3fa8\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/facet.js\":\"3deb08fdf8f2d8c3\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/resolveAppRuntime.js\":\"865ae6669a2e441e\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/runtimeEvents.js\":\"3039faeb56000892\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/togglable.js\":\"8cd1256f56f6bd8c\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/variantFacet.js\":\"982638fe7efcf1fb\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/verbFacet.js\":\"fd284ee70cafee97\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/block.js\":\"45ff16e02cd61989\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/focusedChild.js\":\"2a3dfe704e763be3\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/propertySchemas.js\":\"dfe5c300f9e3cc75\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/typeRegistry.js\":\"0eb74093e6c5c07f\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAncestorCrumbs.js\":\"ddb7cc487a03bac6\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAutocompleteListbox.js\":\"f118aca0b4038fa4\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedSearch.js\":\"83e36d152278ef45\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedValue.js\":\"5f9fb08751f6d41c\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsFocalRender.js\":\"3af5d63dd602cc8c\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsReadOnly.js\":\"37f1235f6c458f46\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMaterializeBacklog.js\":\"1aec927f17f40b9c\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMinuteClock.js\":\"cae7ef0a5d16a83b\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePanelLayoutProjection.js\":\"33ebf9fe2ff6e0aa\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePendingInvitations.js\":\"60d7d4259c8806e5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRendererRegistry.js\":\"80a4ca2b3565ea58\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRetainedFieldRows.js\":\"4bee34825ffecae3\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useWorkspaces.js\":\"24eef3587e986c9e\",\"/knowledge-medium/pr-preview/pr-1789/src/lib/utils.js\":\"17ee8b10a476be95\",\"/knowledge-medium/pr-preview/pr-1789/src/main.js\":\"fddf731f195fa166\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/MarkdownImage.js\":\"8a1a1e33f662f5e2\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/blockSeparators.js\":\"121324e5f5b79b1b\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/context.js\":\"dc883ad0b5166b9c\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/defaultMarkdownExtension.js\":\"ece9551ee4758205\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/extensions.js\":\"1fa68dd9498fb7d2\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/renderMarkdownHtml.js\":\"270c2f4e77b0a796\",\"/knowledge-medium/pr-preview/pr-1789/src/minimal-editor.js\":\"fb97026e62bb4327\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/armedCut.js\":\"d1eabcc89a3b4c70\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/captureMediaVerb.js\":\"b8c28b4e6a264036\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/clipboard.js\":\"3564fbe8fe7c1086\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/decision.js\":\"44c5222e35424527\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/operations.js\":\"5786451a2bb92725\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/AccountHeaderItem.js\":\"a69e421d4ed90ae8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/index.js\":\"3ee4347fcb7da9a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ee012ff1d4cd11be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askAgent.js\":\"6ebddb5058d29343\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askedStore.js\":\"64a9cdb17c6ee990\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"005691339bb547d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/chipState.js\":\"5b5e847c6ebe936f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec58ebcdfcce0af4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/index.js\":\"a3f5040efe6397ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"cdb53f62a95f3760\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/schema.js\":\"65f9c6732362065e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a3122577528a2fb6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/BridgePairingDialog.js\":\"97b4e8bd34cb80e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/addMedia.js\":\"89dd04fe6281b9fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/backlinks.js\":\"36935c680b6f4baa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/block.js\":\"e5b080fcfa58dbd8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/context.js\":\"b678f8cdb7c1ba70\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/displayIds.js\":\"27e301386eb9260d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/index.js\":\"026726b5cf707b0a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/outline.js\":\"da9ee9d523a20190\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/properties.js\":\"0bf2382bc147caf0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/refs.js\":\"3aa7fdd8c6e7cefe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7a503d2beeba3578\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/search.js\":\"aa93d77556ed25a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/shared.js\":\"ee769a7c46ab2d6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a191610da05d7280\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/text.js\":\"d43798e22e9432f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentWrites.js\":\"a210d1f9869d17a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/authoringCatalog.js\":\"5e5ca31f6f224331\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/blockRefTargets.js\":\"12a3fdc6c3390971\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridge.js\":\"ae2b738bf9d88ff1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridgeLoop.js\":\"53b092eef55993ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/changeHistory.js\":\"9e9d9233c4c022db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commands.js\":\"3e41b3ce3031e561\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commentsCommands.js\":\"eb0696589f252794\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataExtension.js\":\"54f274e74e607263\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataModelGuide.js\":\"f8955a7d448e85ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/describeRuntime.js\":\"b74a2ccabac8c1c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/extensionLint.js\":\"88f49cf62c86cd48\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/grainAudit.js\":\"b1bbe6c8d17f36a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/healthCommand.js\":\"5100be18824e4c88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/index.js\":\"60eccdddd4d11ff4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/presetIdentity.js\":\"9271d0e486368f1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f8edf13ec68616c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/readMedia.js\":\"60f37b049c91f67b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/schema.js\":\"e0dd29dff5209569\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/serialization.js\":\"73cb98b659bad24c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/targets.js\":\"b560a4a9da85612c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/tokens.js\":\"cbbd8273a7e7bf95\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/watchEvents.js\":\"e1184781d56e3cae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/workspaceGuard.js\":\"0951865339410214\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/writeCommands.js\":\"0d174cb0d0165f97\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/AliasCollisionToast.js\":\"92781e8406d31857\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/DuplicateNameBanner.js\":\"72b97c366b25966e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/collisionMerge.js\":\"373bcd43a7b89291\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/dataExtension.js\":\"bad05c706921d8e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/index.js\":\"d8d0b6b0477e8d9f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/mergeCollisionAction.js\":\"6253de9f729809e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/pageStyling.js\":\"6d58e98e7b47905b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/rejectionToast.js\":\"8adb5e8df8588977\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/syncProcessor.js\":\"7c635a7abe7a7e71\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/actions.js\":\"a2d5c751f153c579\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/addComment.js\":\"fe2a3844c34b7639\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchor.js\":\"6e974b2a04b20ed5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchorState.js\":\"ccee2d66c61a60c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/commentLinks.js\":\"ea27fbf9a853259e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/confirmThreadDeletion.js\":\"362a182942196c1a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/container.js\":\"9d73b9cf58ec2bcf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/dataExtension.js\":\"6a3f0dd69cc296c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/deleteComment.js\":\"e7964201de23da0d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/highlights.js\":\"306b68aac19461a2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/index.js\":\"a40be3ef7830aa04\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/linkedCommentsPill.js\":\"99dd3de61bd32a60\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/margin.js\":\"b7159ce01cf03608\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/marginSchema.js\":\"b32b92f8f18fca31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/newComment.js\":\"af813b547eedf043\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ownThreadPicker.js\":\"db9dfb3d4f9f8ede\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/placement.js\":\"cf2130e1a692eb5d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/queries.js\":\"0ec7461861f219a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotePosition.js\":\"69f5d093c0538c5f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedIn.js\":\"c9c1e4363c04f5e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedRange.js\":\"414534b5f8902569\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/rangeRefs.js\":\"125c1ac035cbee91\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readHighlights.js\":\"24f29c44e67476bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelection.js\":\"28c832db86f5babd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelectionUi.js\":\"7ca87757f4ab7367\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/reanchor.js\":\"0ede4f44703c1337\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/schema.js\":\"11318d287eb92c58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scope.js\":\"ae9a322c84ab8d14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scopeThreads.js\":\"f85c4b7af1531960\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/splitRetarget.js\":\"f507ef41b9fccc3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestionCard.js\":\"4583da639d63fdf7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestions.js\":\"c7e3eb09de1ab53d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaries.js\":\"bd193d54e7ca5cf5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaryBatch.js\":\"6ca84e4057170858\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/surface.js\":\"30ba83f952887988\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threadNavigation.js\":\"2b42ca151df33c32\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threads.js\":\"437923c295c77e1d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ui.js\":\"8215b2bb6580d218\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/uiStore.js\":\"4bb89f0588487158\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/appIntents.js\":\"1c9556e7df11cd30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/index.js\":\"c035d0dd54bbf224\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/index.js\":\"0865b07a3bd4c46c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/status.js\":\"ad31430f4b6a2ff7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cc8d3b2f4cdd476a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaBlockRenderer.js\":\"2e6ec456cdf21d5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaDownLaneReplicator.js\":\"38ca4d3999965f24\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaUploadReconciler.js\":\"d40e8781c6697d7d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetDownLane.js\":\"3f731b6e790166d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetResolver.js\":\"5aedf90988cc4cef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetUpload.js\":\"c3a17318cb9d6e8b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/attachmentCleanerIO.js\":\"e1c578c0b568858c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/supabaseAuditIO.js\":\"828453cf52e8f3a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/blobStore.js\":\"b5670fe98e56950f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/byteStore.js\":\"be15c371d7b17784\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanerIO.js\":\"394a753aa6b960a4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanupAttachments.js\":\"7fbf26d84293de67\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/dataExtension.js\":\"d0f4abd5bf998463\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/downLane.js\":\"22c0aa1bfc790cc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/index.js\":\"10a6f5c582024323\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/insertImageContribution.js\":\"9053a40c31fd601e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneArming.js\":\"d7ec49b8ef0e4c15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneLock.js\":\"8b87fe93c07ce040\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaBlock.js\":\"9a5371ea68f1a5f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaCapture.js\":\"d5ca12f2a746c090\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewers.js\":\"84fcfb754bd77faa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewersFacet.js\":\"74da058b33b79205\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/pasteCapture.js\":\"5dc1582b4dd0c9a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/resolver.js\":\"8ddf4974fa64974f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/retryUploadsAction.js\":\"ee34792451432f88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/storagePaths.js\":\"f396856e5d97b5a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadDrain.js\":\"0ed5c43a9762c941\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadLaneStatus.js\":\"12916bfc86eb7d53\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadReconcile.js\":\"63f59b8c8636937d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadRecovery.js\":\"96e06af567c9cce8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadStore.js\":\"668914bca83c1c89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/useAssetObjectUrl.js\":\"b0b8027121bdc5a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d2d162efe590d523\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksViewSection.js\":\"307a70d03a04e50b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/facet.js\":\"4e3cf2e6db68893b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/index.js\":\"db4cf5b422c2ff13\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/prop.js\":\"528cc5772f493503\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinkFilters.js\":\"52151d69fa12a991\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"01d8cf9bf0bfe23b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BlockEntry.js\":\"0ca1356d0cea141f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/LinkedReferences.js\":\"d5ed2624f9658790\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"962db03109b5c802\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dailyNoteDefaults.js\":\"3b63fd5c2d479e66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dataExtension.js\":\"5196135b6135cbee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/edgeExclusions.js\":\"f0a603a260897b4a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/filterProperty.js\":\"edfedd41be8cf6d8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/index.js\":\"07858819017f2e02\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6c348f146f1a267f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/applies.js\":\"8c8ce8c1559a78d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/countQuery.js\":\"5a4efc5364881cfe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/expansionStore.js\":\"55751611690912ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/index.js\":\"6c4490b5822ca208\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fb0add6e5953b656\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/presentationInvalidation.js\":\"5d478ece053c3fb3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyEditorOverride.js\":\"d831870456ab234b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyFilter.js\":\"b70b2068521aa012\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/query.js\":\"7ff700c25b9793c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/resolveFilter.js\":\"d00fc54503757d1d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sourceBatch.js\":\"1d77085d580e33b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sources.js\":\"07cd6ee2f84228ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useBacklinks.js\":\"069ee3a428041209\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2ff788817c70d2e4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayCelebration.js\":\"836c03ea8f23d731\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayOverlay.js\":\"692dc73bc65b163e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/gate.js\":\"6ead41bdfa5e3316\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/index.js\":\"bb464b26d3dadb13\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/wolfTheme.js\":\"752f8dcd6a464347\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/BlockDragLayer.js\":\"de0c249d63d7b5fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dragController.js\":\"ef7cbf5bb3b48188\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dropTarget.js\":\"142ae14db06a8423\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/index.js\":\"92d1aead8f9451ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/projection.js\":\"5eee8f85926f66aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/BlockMetaCard.js\":\"3eaddee3d4ddc120\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/index.js\":\"f5ca7bb69bb955cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/AddTagDialog.js\":\"275ebb7f7ce87624\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3a21fb490490a9e2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/TagNameIssueHint.js\":\"5aa72e725ac39e70\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/addTagAction.js\":\"21c975010db60ded\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/appendTag.js\":\"5b1ba8d0112155ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/config.js\":\"8d470403b6c508ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/dataExtension.js\":\"406829aaac8454ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/index.js\":\"4e25452571966023\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/propertyEditorOverride.js\":\"43cd0eab356e63c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5eccbee1dfc1eabd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f39ceb6ae4decdf4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f84e73b0da378daf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"342decebb51114c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"00d4c4767c57d109\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/index.js\":\"71984f65976e22e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cea4ecd769e55962\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/CharacterCountItem.js\":\"9616d8baa7ef0005\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/ProfilePropertyEditor.js\":\"330216b19f803761\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/actions.js\":\"0fa91f2cfc6e7db9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/blockType.js\":\"d3101accf75ec81e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/charCount.js\":\"058673e4677e53fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/dataExtension.js\":\"4e7a89df9c4cb193\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/index.js\":\"f081ffb27a732678\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/profiles.js\":\"dae1d95a60fc260e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/properties.js\":\"b7394efa673eb795\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/textCounts.js\":\"b252ba0776094fc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/colemak-keybindings/index.js\":\"fd48783a7eb7e5ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/CommandPalette.js\":\"bf1363e03e696450\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/HeaderItem.js\":\"9f885eccd1e864b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/context.js\":\"4a4a0f961adf9f1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/index.js\":\"e8b75af1edefeeed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/selection.js\":\"f8b657184f56dc9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/toggleStore.js\":\"19a4c5d50b946b4c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/useCommandPaletteActions.js\":\"1a28a47f860b829e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/ContributorBadges.js\":\"a5aa14d3c23ec132\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/author.js\":\"81205775cea30520\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/codeMirrorExtensions.js\":\"727f15e72b5b4395\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/dataExtension.js\":\"9567a19bbe227f7e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/index.js\":\"21692ea8b515c1e2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/mentionAutocomplete.js\":\"d31e930e9c271476\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/processor.js\":\"68c8e1b7c3ccb4b5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/profiles.js\":\"818d335098de9468\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/queries.js\":\"fe089747a398eb84\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/schema.js\":\"e7dcce805e1b144e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b269134fc8f15c08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a720b662a98cb23a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/index.js\":\"044d8ef3496fb349\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b736d26978d3aafc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d64fae76876960c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/CalendarGrid.js\":\"8c5fb5f1278f035e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DailyNotePicker.js\":\"598da94dda332377\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"571346226c93e9dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateNavDecorator.js\":\"d0d35b4681010a2d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateScrubOverlay.js\":\"ceaaae1bc2b6c634\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/HeaderItem.js\":\"6041e541d86b6eed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/ReschedulePicker.js\":\"ce45b515c90eb08f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f11410ce560c310b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/actions.js\":\"1514b82726e60d47\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/blockDateAdapter.js\":\"2aa2f2e3be341679\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/calendar.js\":\"4342a142f1cabc59\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dailyNotes.js\":\"f8754c954730036c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dataExtension.js\":\"e2b0cc5d373d9b80\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubActions.js\":\"85f9c3982e4daefb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGesture.js\":\"c9e0b2e09c4f76a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a86bbbd2e8d4e249\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubRecognizer.js\":\"164d3054f0b4bb3c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/deletionGuard.js\":\"60bfdf2a5160d9b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dueQuery.js\":\"fb7bae4201168997\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/index.js\":\"78d2ff0d76636c01\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/landing.js\":\"992fb6a0f7f509cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/localSchema.js\":\"818007d16262c6f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/referenceDateAdapter.js\":\"74b231f4771270a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/rescheduleAction.js\":\"ce4d87063b632d77\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/schema.js\":\"f488bc46b6451739\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadBlockDates.js\":\"c6e0f57a728647b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadDatesAction.js\":\"c5877e8760186e37\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/today.js\":\"46c0a24774644f03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8ea0130e6eab70c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bd983d0e7f637f90\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/audit.js\":\"0ac1ca50556cedc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditAction.js\":\"ee621317086c36fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditRanges.js\":\"6436add21e30e63d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/diagnosticsSource.js\":\"1771d99292111106\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/divergenceScan.js\":\"0a9ccec858e24af2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/index.js\":\"8c0682b9989172ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1b81c3393fadc0b2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/referencesMirror.js\":\"6e32b3d412da2833\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/rowJson.js\":\"86655f12a355e67a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/schedule.js\":\"511f0cd2193ccb7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/store.js\":\"d733420b7b5e514c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/action.js\":\"4829d27c496ea341\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/index.js\":\"fe7892572f14174e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/plugin.js\":\"47ed4f5a5b653ced\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5a44dead2a6beacb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/actions.js\":\"949bd8eca2b7f58f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/changeMarker.js\":\"7d5a1a2c0ca32a6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/diagnostics.js\":\"81a631e74b1efaca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/fileSystemAccess.js\":\"be9e8f089f405eb8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/filenames.js\":\"47707d9e1356dca3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/index.js\":\"9c1af89150dda027\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/mirror.js\":\"2205be02731c7196\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runLock.js\":\"1e29f5ce13ce111b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runtimeHealth.js\":\"a76cdf7cab25593e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/schedule.js\":\"8a21266a0be583e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/store.js\":\"22a43393e5f365a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/index.js\":\"0370dc4effb775f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/themes.js\":\"261a0c4e92b19f20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/facet.js\":\"36062ddb4ffb2479\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/useDiagnostics.js\":\"97c39f574ed40b98\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/dismissals.js\":\"b4e40877854ce01b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/index.js\":\"476207e7db9bb255\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/status.js\":\"5a23b3ae99198bba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/store.js\":\"82e3908117c629cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c5dd424ea3a4c0d1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b54805b58837d06d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/actions.js\":\"2f3ced74e9431589\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/config.js\":\"59ac6408b1302d33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/dataExtension.js\":\"6a432062a9c8d886\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/effect.js\":\"44603e80dad58d6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/index.js\":\"0ea4a98a5920afa6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/propertyEditorOverride.js\":\"627486118c39cd41\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/useToggleTree.js\":\"4b141f55cc8bc567\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/ExtractTypeDialog.js\":\"87e1965e9d4c1613\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e247a5df1d312926\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/PropertyShapePicker.js\":\"27cd8675e9539c06\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/action.js\":\"3301b2b0bad18207\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/index.js\":\"0afcfbeb2ec58007\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/FindReplaceDialog.js\":\"434a92f179368f9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/HeaderItem.js\":\"b5f0d29f9c2093d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/dataExtension.js\":\"99f5c0e8e1a47ad7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/index.js\":\"dd2584fc4ac8dd38\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/search.js\":\"ef1e854446bad347\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/toggleStore.js\":\"dacef85775d15aff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/LocationPropertyEditor.js\":\"2fa546d09dd60847\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/MapView.js\":\"e38b03bf23cbe689\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/blockTypes.js\":\"ef05aa78c293677f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/codeMirrorExtensions.js\":\"96979d0fd6ab2a7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/createOrFindPlace.js\":\"37d9a2149d19c097\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/currentLocation.js\":\"2a32ee3d2abb85c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/dataExtension.js\":\"0767fd178f8e2287\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/geoContentDecorator.js\":\"ed24449d75a6ade3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/googlePlacesClient.js\":\"215bb7f66b4a2006\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/index.js\":\"8e1632a077ed4dad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/locationsPage.js\":\"44df3fffbddc7944\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/mapViewport.js\":\"6671367fc7527fa9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/pickCurrentLocation.js\":\"b7c07dfcb44c79be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeAutocomplete.js\":\"3242141c80f41b5c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeNameCollision.js\":\"04193303d8a18b2c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/properties.js\":\"74e5cd8ff50ac968\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/propertyEditorOverrides.js\":\"fb28d9b5c1a0c324\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/query.js\":\"c4caa6d7c12888e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/usePlaceSearch.js\":\"2c3438db3919ab7d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a58dac947d732e43\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"62e9d8057b6eabcb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e3b22b8b6cf863e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/config.js\":\"63b0c6dec31fa515\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/dataExtension.js\":\"f746ba9a039a4cda\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/facet.js\":\"41d4fac4a83e7990\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/grouping.js\":\"310c7b0f2870c6c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/index.js\":\"0f0422692f0e2f6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7233527dacfc9a6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/query.js\":\"3c75d3a7572bdd70\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/resolveConfig.js\":\"94470194072ec532\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7c2d4d1783844ed0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"474d0d144089f111\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlDocumentContent.js\":\"a98260e410f0b3ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlFrame.js\":\"b0982370728a0c1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/actions.js\":\"903bfad94d984250\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/blockType.js\":\"1d99e033547ceeb6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/confirmRunScripts.js\":\"087ccab2a39d9963\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/dataExtension.js\":\"c02ec28fc2b278a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameAnnotations.js\":\"242413805b8fae6c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameDocument.js\":\"1a5ecc56d31418ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameTheme.js\":\"a2c05e019071633b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/index.js\":\"fd5d0ccd11729577\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/scriptConsent.js\":\"8e8cd154e5536958\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/sourceMap.js\":\"84a4216b0f6478da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/useDocumentScripts.js\":\"b9b90911da926226\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/index.js\":\"53d36efc82685350\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/record.js\":\"8710957076b725b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/recordStore.js\":\"103b1a4d9a6bc822\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/responsiveness.js\":\"2278aabcfe33d650\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/schedule.js\":\"c8316f05e798351a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/sessionContext.js\":\"352f483a353c48cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fda1b0d60f359338\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c9742282dfe11410\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/actions.js\":\"8bb1bd40bdf61f12\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/config.js\":\"4412068836ed4cdf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/dataExtension.js\":\"025ae57a2ee872b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/effect.js\":\"e6571b0a32b2c63b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/index.js\":\"575fd3f1eb76ffb4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/keyCapture.js\":\"eab59f94a54ed973\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/overrideStore.js\":\"b67a7756498bd225\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"318f3e582e5996e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/HeaderItem.js\":\"d7af50bf085f37b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/LeftSidebar.js\":\"7f3ad2c3a54487ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/actions.js\":\"4d6deb8934e5ee57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/facet.js\":\"7efe1bc44aa1440e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/index.js\":\"ae11c4c80e3d13cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/shortcuts.js\":\"ad678eb37b885cc1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/toggleStore.js\":\"0d336ff6be2111a2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/MergePicker.js\":\"a3159fe3e7c98b53\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/index.js\":\"9bcd737fffc93c2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/mergeAction.js\":\"43dbd61e218857a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/strategy.js\":\"4f369679697d5ddf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/Button.js\":\"603ac3cbbb1ab962\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0f240b2943cadea0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0ceb7110c7d42711\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/facet.js\":\"8b47b7843ec27308\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/index.js\":\"3ae9e667a27baedc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"59003e14003d99a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/actions.js\":\"067165c0e4a89550\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6cf67422fab32f08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/facet.js\":\"04abc71a35d58772\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/index.js\":\"a1195dbe679ce6c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/MoveDestinationPicker.js\":\"32e83614b6a66c1d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/blockSubtreeMembership.js\":\"795b04bcf131966e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/contextMenuItem.js\":\"cd183a1a4b4a4734\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/index.js\":\"be203cfea6e798c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveAction.js\":\"f8383fea2d1bb2f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveBlocks.js\":\"d6e8c1a6ac6ef570\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/selectionAfterMove.js\":\"73583e2343c45c49\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/TutorialBanner.js\":\"01705585a56c6c8e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/action.js\":\"af7e4568028f74f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/bannerDismissal.js\":\"bfe9c1592e647932\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/documents/cheatSheet.js\":\"54d6d1680dd7885b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/index.js\":\"c91b12890cd3e24f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/keys.js\":\"b493823604ea494c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/landing.js\":\"bbeb64a01fc6b07b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/outline.js\":\"af7102376a82bca8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/seed.js\":\"722a9cacc6419b93\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2780b54f4e0b50cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/analyze.js\":\"b46ac750fe0c64ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/diagnosticsSource.js\":\"9aa6b130ae54daf9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/index.js\":\"4a845b1e78bf44f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/load.js\":\"1cbbef3a60fe917a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/monitorRun.js\":\"63f4eb06a3dd47c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/schedule.js\":\"1780fbfaa8f82ba3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/series.js\":\"56cba1fcea61a1ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/store.js\":\"8ba43165f8b59a22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/trendAction.js\":\"916f0e2e8bbcd59e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/verdict.js\":\"90382e4662c4d4e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/clickToEditAction.js\":\"0106a986385b7cbb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/index.js\":\"939f20cb8d996638\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/interactions.js\":\"c4e1bd46e623b8e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"6f3da075b59444be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGate.js\":\"9adfd1a8407406fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGateDialog.js\":\"4c3849f63850ca16\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/action.js\":\"ca3786ea704bc0b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/index.js\":\"83cf41669a27026c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/localRunMessage.js\":\"2a6951d2462b8900\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/plugin.js\":\"0d35f8af7d008364\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/progressReport.js\":\"4069c57d16e88af6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/sweepProgress.js\":\"98d531157a51198d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/FieldRowRenderer.js\":\"7cc1466866188c80\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/ValueRowRenderer.js\":\"64326b3e91b728a2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/actions.js\":\"e8b87fdf88d14724\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/autocomplete.js\":\"06d7212c45599210\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/fieldRow.js\":\"d28ca13f2827fad3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/index.js\":\"df9883ce0294c739\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/referenceWarning.js\":\"bb92ab51e8f76ee1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueAutocomplete.js\":\"a8911423ece313e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueSchema.js\":\"8c4af05574dacbc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/HeaderItem.js\":\"7bf6fa8b9fefe7c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/QuickFind.js\":\"8983b4ef28c54684\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/index.js\":\"fb30d0662c07803f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/recents.js\":\"a8006bf69f682f61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/resultItems.js\":\"3162c4b2c3495f78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/selection.js\":\"b043c856c3148d60\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/toggleStore.js\":\"cd07e870f9d9d943\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/HeaderItem.js\":\"1fbda07d31576798\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/RecentsPageBlockRenderer.js\":\"696333efe1fad798\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/grouping.js\":\"3ac8b39e3c44133b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/index.js\":\"33d3982cf15499df\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/target.js\":\"840b068d06d44a78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/codeMirrorExtensions.js\":\"10348678c9d62bae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/contentPrefill.js\":\"ecd6eb13a07640a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/dataExtension.js\":\"3867ae03e2ba250e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/index.js\":\"3aef9b2315749ab7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6ef8a3444108dc69\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/invalidation.js\":\"b5485e22ffe275dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/localSchema.js\":\"71b1b10cba695199\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/index.js\":\"dba2421f979b2ceb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d369f2bf14d17fc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/index.js\":\"32130d84bf801436\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/referenceNode.js\":\"8f0af7d03d4c9adc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0406e3c8377f72c7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d392d05425f7b828\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/index.js\":\"da63736cfd64bc19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e3c4eba0c3960737\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"4e4b1c79851623f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/mergeRetargetProcessor.js\":\"b8f924fffc240a2c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/parseFence.js\":\"527ee13ed13e1a4e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceParser.js\":\"b31a338d6e11fe47\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceProjection.js\":\"b2ef12f88ed2d9d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referencesProcessor.js\":\"6a485ed520f80d18\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/renameProcessor.js\":\"4f157f7b2de8317a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/spanReplacement.js\":\"fbda6d840248366e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/htmlToOutline.js\":\"7fd9949bf370e7f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/index.js\":\"8b6192938771e14c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7dbbc0bb0688eb71\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/pasteDecision.js\":\"7214462cb51ebb06\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/action.js\":\"9d3bca207dd51e28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/blockIds.js\":\"0210fef8735a83ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/content.js\":\"0884616deb7406e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/effect.js\":\"e933bc50335a5679\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/ids.js\":\"2c3e3edd64748218\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/import.js\":\"8f70e9d581d7f990\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/index.js\":\"898121ca54e9ac0a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plan.js\":\"33b9d90236a173c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plugin.js\":\"b3c1af9e4ffcd621\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/promotion.js\":\"bcc3ef9de65f4a19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/properties.js\":\"fc29ba42f361ba4e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/references.js\":\"529db7e73331834c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/report.js\":\"273adb395b43614d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/roamMemo.js\":\"7b825a7306752845\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/runtime.js\":\"c3f7ef53c6f42423\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/schemaReconciliation.js\":\"8655cfb2b2786fc7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/srsMarkers.js\":\"a247e7a5b95628c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/todo.js\":\"922a21e58e4e4a9d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/typeCandidates.js\":\"ce966e2b536f5a08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/types.js\":\"dbc843762d4a065c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/index.js\":\"54dabf350cd7d89e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/store.js\":\"6c65f5fe6e3e4089\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/HeaderItem.js\":\"4bb4d68af4d17e82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1890967e784e8f64\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/index.js\":\"064ad0a256b1344d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/model.js\":\"fd132d94ffb6b284\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/toggleStore.js\":\"916333c6c798c83c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/useKeyInspector.js\":\"31d42618c17d31d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"593618ca972430cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/ShellDecorator.js\":\"9913ea50b9704539\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/actions.js\":\"1c1fa71872a0cdab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/exclusionsFacet.js\":\"45e526f08f87f80a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/index.js\":\"44fd5f9d67415f67\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/shell.js\":\"3e7ed4bdb60cc508\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/surface.js\":\"31baead2ecf8b224\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/walker.js\":\"98c1cd0b684c5282\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5463d96739bceb50\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/dataExtension.js\":\"7cf081aa0d43dbaa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/index.js\":\"67b519e23e7b1f8d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/indicator.js\":\"ffbbe1de01ab386b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/moveSrsState.js\":\"5b4bbbcbc9dffb19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"fa0b607751f66927\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/scheduler.js\":\"352723542b097f2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/schema.js\":\"ad85b45403ed205d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6d174f33943a96e6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsClipboard.js\":\"d133e08870c37b55\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"01367d826b7ac7c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c1718ab9924d323f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DeckPicker.js\":\"5b83596a2f3ae6c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewControls.js\":\"4a02b4c33d6f2384\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0fbd180f534c846f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewSession.js\":\"395e5e8966d550b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/actions.js\":\"b03e2d745bafbb54\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/archive.js\":\"71fcdb62d4cb32f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dataExtension.js\":\"b9127641908311ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/deck.js\":\"895f1cb36df53833\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dueQuery.js\":\"566443736c0767a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/gradeDecision.js\":\"72f0604970d5d948\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/index.js\":\"510b4a5cfa960ff3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/keyHints.js\":\"47fd0116f75fefbe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewCardLayout.js\":\"595fcc1d96305941\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewProgress.js\":\"98b92b2d788ebea4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/schema.js\":\"a5af32b0dfc5dc0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/useDueCards.js\":\"a7e5cd6866525158\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/index.js\":\"1520be03f9c96f98\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/record.js\":\"2a83340e3405f679\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/index.js\":\"7e91a73e11fff666\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/persistenceStatus.js\":\"c8688b34ac3612aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/requestAction.js\":\"ed438deda6c079bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/TypeChipsDecorator.js\":\"47432b4a16b15d68\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/codeMirrorExtensions.js\":\"60b67957fa958a62\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/index.js\":\"ff3a2957c3c443a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/typeAutocomplete.js\":\"3056efc520dce090\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0e983d0c64c10ada\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/actions.js\":\"0fa2825e3afd79fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/anchor.js\":\"5652e410b565610d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/events.js\":\"11ace23545a3042b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/gestureActions.js\":\"796de16f16954fd6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/index.js\":\"8f6f4fbb224fce4e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3b3d8d2aa3ecbc11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/collect.js\":\"083e39fffcfaabe9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/index.js\":\"63643615f60ec744\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/record.js\":\"915248fbe22050f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/RejectionDialog.js\":\"05d90d47d8441f1f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ba40e4af78c3e7fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/index.js\":\"179743957b223406\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/model.js\":\"92e863fcff1c6618\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/queueCounts.js\":\"e0f21ef6f783abf4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rejectedHelpers.js\":\"df08dea991ed4fa6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rematerializeAction.js\":\"6f13b7803153689d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/useHysteresis.js\":\"e906733464fb06b5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/effect.js\":\"77d313e7c32b9eb4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/index.js\":\"367fddf3c2f8dc3d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/theme.js\":\"7cb25dbd20f7ee76\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/actions.js\":\"61b6899d5732f844\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/dataExtension.js\":\"5f3dc03a4820aef5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/index.js\":\"1dcbae966401c732\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/schema.js\":\"7e3d11cf9bf9dab1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c7040388ccae3094\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/actions.js\":\"d005521f8b6a8ed6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/defaultItems.js\":\"632f6085baab526a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/facet.js\":\"e104082d8b3db0de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/holdRecognizer.js\":\"c384744401e225f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/index.js\":\"ef7d36e58db5f936\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/UpdateIndicator.js\":\"c37b0aecf4356f92\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/index.js\":\"9bd4f85ecb43a5b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/loadTimes.js\":\"3a18baebe18a2326\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoNotesRenderer.js\":\"fc9f4c81a84f8469\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoPlayerRenderer.js\":\"efee656060f00357\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoTimeStamp.js\":\"b430a56c78cd5030\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/actions.js\":\"f76e69cc4a16281a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/index.js\":\"0605abaed0ade57b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/markdown.js\":\"301d62b37e167721\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/notes.js\":\"bfed3d629ce001e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/registry.js\":\"61d8a44981775685\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/remark-timestamps.js\":\"7c3fcda242ff31c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/view.js\":\"7831b45a66943cf1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/LinkHints.js\":\"833e6212d1edc024\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/index.js\":\"3175bd34ab5f042f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/model.js\":\"cb9db2096f41c9de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/settings.js\":\"3aa977272f40e77d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/actions.js\":\"f977c2bb9ba9fc2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/index.js\":\"90558651b5d88f48\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/interactions.js\":\"baa6f922fab3f90d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/workspace-header/index.js\":\"0318403f1a9ef59d\",\"/knowledge-medium/pr-preview/pr-1789/src/registerServiceWorker.js\":\"c2c8f2f3de459cb8\",\"/knowledge-medium/pr-preview/pr-1789/src/requestPersistentStorage.js\":\"38e765fd654b3db9\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authRequestDeadline.js\":\"5f1e1fb1390a558c\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authStorage.js\":\"675562fdfdac10bf\",\"/knowledge-medium/pr-preview/pr-1789/src/services/powersync.js\":\"b3f60a5be1af0ead\",\"/knowledge-medium/pr-preview/pr-1789/src/services/supabase.js\":\"7da83acd67326913\",\"/knowledge-medium/pr-preview/pr-1789/src/services/uploadErrorClassifier.js\":\"cf9fffb2dfc273b6\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/ActiveContexts.js\":\"3a51d729a8caee39\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/HotkeyReconciler.js\":\"3d11f689379d1a6c\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/WipeLocalDataDialog.js\":\"f448ac7a962e5275\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionDispatch.js\":\"e19896466d07d004\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionRefItems.js\":\"4af78353bd707267\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/applyKeybindingOverrides.js\":\"8b039d47d30a7949\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/blockActions.js\":\"d76e4a386bafe999\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/canonicalizeChord.js\":\"d2323734fade9225\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultContexts.js\":\"5bb9bc4013813374\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultShortcuts.js\":\"49151cc5136a2ac7\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/effectiveActions.js\":\"c6990c4166aa7afd\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureAction.js\":\"3fab5b5bec411a61\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureBinding.js\":\"9810d89b28a4acbd\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/holdRegistry.js\":\"dae58c320319fbd5\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingConflicts.js\":\"88218196ac6db221\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingOverrides.js\":\"ac049d9831878952\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/pointerAction.js\":\"3048a6efc1c205c8\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/resolve.js\":\"7a66471226ba5ebf\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/runAction.js\":\"41408d1b0aa5ef51\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/sequenceMatcher.js\":\"5446601b5f3ffe47\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/types.js\":\"635a595de01519d7\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionContext.js\":\"1516cb2291f96c90\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionDiscovery.js\":\"e8064f94ff5013ff\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/utils.js\":\"15a895da1214e6e3\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/bootStore.js\":\"427f2243df842f75\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/previewDatabases.js\":\"94e3ac436fec0e99\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/byteTransform.js\":\"644ac85eda358606\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/attachmentCleaner.js\":\"b5243dba80e36ff4\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/attachmentParts.js\":\"31df1a1ae74fe7bb\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleParts.js\":\"c0a7806956101eed\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleRecord.js\":\"eaf6b3b4c64b64c3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/manifest.js\":\"db82615dd21be8e1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/takeBundle.js\":\"2bc91a1c7bfb6fbc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/verifyBundle.js\":\"a26d4323aa9fc685\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/cleaningStage.js\":\"1ed80f6fd7821532\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionKey.js\":\"69472ecf733118e8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionServer.js\":\"5ac7fa515aaa84b5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flip.js\":\"f286327093f18f75\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flipAttempts.js\":\"85640a2faaeed2ec\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/pages.js\":\"4c5788663b85952e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/preflight.js\":\"ef7164036fd86d83\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/reseal.js\":\"b34273403bc3575b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runConversion.js\":\"0a12202b41099a73\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runLock.js\":\"8cff1d3fd27ec6a1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealing.js\":\"37340fa29ae4f1db\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealingStage.js\":\"63fe28f5d23be997\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/stage.js\":\"cae2dff1087e15e8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/verifyReseal.js\":\"c44a6c5cfc61b6fd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aad.js\":\"42d9ec3bbe998ac3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aead.js\":\"89d5232999a10a95\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base32.js\":\"6b5ee182611d7ab9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base64url.js\":\"882c8b7a113d952f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/binaryEnvelope.js\":\"4797d2f5a9d67fee\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/byteAead.js\":\"f410f275ae6458f7\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/canary.js\":\"b169858c3d21040c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentHash.js\":\"17b361bdcfe3529e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentKey.js\":\"2b0dc3c0b17c7c72\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/derivedIdNamespace.js\":\"92c622ed51d5095b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/envelope.js\":\"07881fb0edb6e5ae\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/hex.js\":\"f46fef071b79a13b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/sha256Hex.js\":\"0547f7d212b1955d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/workspaceKey.js\":\"c9d5131c3916fff6\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/conversionState.js\":\"65ffc82090be3653\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d092da7c052d8fcc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/pastedKey.js\":\"58d1fc3f083d2d41\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"739d175fe01c432f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/upgradeWorkspacePin.js\":\"27790ba155d8d22c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/keyStore.js\":\"353049c34ee4e3be\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/mintWorkspaceKey.js\":\"a6d7deb1e0870f82\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/modePin.js\":\"c08cd0f1dc6ce09c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/openWorkspaceKeys.js\":\"8f378c9c526a5776\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolveWorkspaceEntry.js\":\"d1a3d9f2855c8d20\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolver.js\":\"0fdd382b8b4ef00e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/workspaceAccess.js\":\"04a4e5be75514070\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/transform.js\":\"7e363a5697d5c1e1\",\"/knowledge-medium/pr-preview/pr-1789/src/themeBootDefaults.js\":\"22f823f43f010853\",\"/knowledge-medium/pr-preview/pr-1789/src/types.js\":\"cd4ab9bcc961fa4b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/ClientLocalSettings.js\":\"7338ab4a6b61985a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/abortableSleep.js\":\"bbee418a259ef877\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/array.js\":\"0ebc3c4c82018032\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/backlinkAutocomplete.js\":\"037457a38e08ce41\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockCrumbs.js\":\"3fb3a72688f11cb1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockrefAutocomplete.js\":\"93246f09cd46b366\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/cadencedIdleJob.js\":\"0dee0e663068daa8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/callbackSet.js\":\"68bf03ddbc8f1819\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/clientId.js\":\"699e3133b7264782\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirror.js\":\"c11cefd08c35600d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirrorCompletion.js\":\"27feb4efe202d488\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/copy.js\":\"707836701f6f1f41\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dailyPage.js\":\"eacb133d0f8fd1a5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensics.js\":\"cb0b23c61c1efbc0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensicsHooks.js\":\"5f70ceea4ee66019\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/deleteBlockThroughUi.js\":\"0d6e2aa47fb3eaff\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dialogs.js\":\"39dc3c00c69571b4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dom.js\":\"e79e27eacf047313\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/downloadBlob.js\":\"cafc9866e973e4f0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/exportSqliteDb.js\":\"68088ba223a5be53\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fileSystemAccess.js\":\"eb9ef459e087509a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/flipSlide.js\":\"f316ac076e1fbaa0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fnv1a.js\":\"8fe21cd15b9b1ca8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/formatBytes.js\":\"a07b0e4feda09118\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fuzzyRank.js\":\"4a9bbdf9938c7f2e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idbKeyedStore.js\":\"bba03280954e5e02\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idleCallbackPolyfill.js\":\"42b926ed6302330b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardAwareScroll.js\":\"a353ab1e3d275e99\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardViewport.js\":\"e9528d9c517e3774\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/lastWorkspace.js\":\"4fe57a42fed17434\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutColumns.js\":\"60e0551f71138a8f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionDom.js\":\"1b2b1198e03c5dae\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionId.js\":\"7db853c1097aed34\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkClickGestures.js\":\"f0649664f5895bf0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkTargetAutocomplete.js\":\"45b3642a02284cf2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbCorruption.js\":\"7f02462ff977503f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbRecovery.js\":\"43be09584d848007\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/markdownParser.js\":\"7d3b80b6d2682a8e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/memoize.js\":\"ba71a39d336ae101\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameFieldCommit.js\":\"61c67b89d2876f5d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameList.js\":\"1ec60a8ea6a9e527\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/navigation.js\":\"c9ce4f7f74f49e0e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/omnilinerNamespace.js\":\"e1bed42cf2961841\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/opfsPageScan.js\":\"8a93170a448b4524\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelClearance.js\":\"7078441b58c42516\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelHistory.js\":\"8dce187c79a98f2b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLanes.js\":\"676b3425d4ae51e9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLayoutProjection.js\":\"47acb72846ec4dab\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelScrollAnchor.js\":\"84f32b9f00374143\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelUrlFlags.js\":\"f17b2f1162a8e28c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/platform.js\":\"d48ddd65a90987d5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/pluralize.js\":\"66c97229be6edd48\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyCreation.js\":\"dc7556eb64a16f5c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyNavigation.js\":\"1c3b0c19eebb78c3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyValueContext.js\":\"b38caf059ad5f9b7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/react.js\":\"27832540f59b7ec7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeDate.js\":\"10e5a8298387917b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeTime.js\":\"dc4fd8c36886acbc\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/renderScope.js\":\"9c524a9f1fd72c69\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/resolvedThenable.js\":\"d1ef4fa6fca56574\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/routing.js\":\"b2e2303d4b5c4bf8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/safeMode.js\":\"218eedb559b78576\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/scheduleIdle.js\":\"0eb6bd05684468c3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/screenWakeLock.js\":\"a468d0cbd52f4ca3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/selection.js\":\"44fbb345dd91ffda\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/softKeyboardGrab.js\":\"7616777cbd908f5d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/startupTimeline.js\":\"4829b621d754aee0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/state.js\":\"e25f119266fd5dac\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/string.js\":\"1d10b4375c7601a6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/surfaceZoom.js\":\"b3968f19ff338214\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/time.js\":\"8fa2f26b9a043d12\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toast.js\":\"56abacb377d3bf51\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toggleStore.js\":\"4e0d3e3f20859792\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/untilStopped.js\":\"181805ffcc223f51\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/userActivity.js\":\"1583e7f6c9f3d3be\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewTransition.js\":\"51a90c521c861173\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewport.js\":\"a611374db48296a7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/webLock.js\":\"577cdf2410bdf70f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceRecovery.js\":\"e05de769235cbb11\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceSnapshotStore.js\":\"7d180652cb87bdae\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-compiler-runtime.js\":\"7bcd077a70960288\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-client.js\":\"3eca152e573c683e\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server-edge.js\":\"071f4d9d03aced68\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server.js\":\"d653ebf4abb9e7d8\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static-edge.js\":\"74aa6bbcf43dbaef\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static.js\":\"a45f522216e85590\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-test-utils.js\":\"72a33093c8d10730\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom.js\":\"4a0dc94be00be947\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-runtime.js\":\"e28661721856afbf\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react.js\":\"d21ae1f276778bf6\",\"/knowledge-medium/pr-preview/pr-1789/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
