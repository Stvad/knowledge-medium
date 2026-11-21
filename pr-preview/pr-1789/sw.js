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
		buildId: "74c091fb15c2-c36b5feb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/\":\"8abceacb508b519f\",\"/knowledge-medium/pr-preview/pr-1789/index.html\":\"8abceacb508b519f\",\"/knowledge-medium/pr-preview/pr-1789/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1789/assets/FacadeVFS-d-meU7VW.js\":\"feb96d86bea97ea8\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSCoopSyncVFS-DOCNXPTE.js\":\"27dd6ca5f860d57b\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSWriteAheadVFS-BzKWHlPP.js\":\"463234c5410aba64\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-BMA25nbU.js\":\"354886514429fcb3\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-kPYo55fK.js\":\"9ae83449ab2d0344\",\"/knowledge-medium/pr-preview/pr-1789/assets/worker-Dy_qnQht.js\":\"c59d6a5c9bb1e1d5\",\"/knowledge-medium/pr-preview/pr-1789/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1789/chunks/app-BQSBqYYN.js\":\"8c5c31e405c0903c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1789/index.js\":\"0a7e5b7133d71b84\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1789/assets/AccessHandlePoolVFS-DwPvG84U.js\":\"660b29f9c9177a6b\",\"/knowledge-medium/pr-preview/pr-1789/assets/IDBBatchAtomicVFS-ioIc0pd4.js\":\"036bd21c1ba0e321\",\"/knowledge-medium/pr-preview/pr-1789/assets/MemoryVFS-CpOZQGl3.js\":\"6ccab0d635691d0f\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-C7RFgCwx.js\":\"752467c93608624d\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-B-Ch6wmT.js\":\"7706a6c5b62692f7\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/AccessHandlePoolVFS-DkEWGeIv.js\":\"307803ccaddbaf39\",\"/knowledge-medium/pr-preview/pr-1789/chunks/FacadeVFS-QFCBT0gj.js\":\"482f6e6263d8c3b3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/IDBBatchAtomicVFS-BHe-xKvW.js\":\"497d23f4d0993e88\",\"/knowledge-medium/pr-preview/pr-1789/chunks/MemoryVFS-SrNYjg6j.js\":\"60acd6bbdbeaeb02\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSCoopSyncVFS-2yrmbv91.js\":\"3a02a2a751bd0d06\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSWriteAheadVFS-CZXojeqp.js\":\"48b511828c266190\",\"/knowledge-medium/pr-preview/pr-1789/chunks/Preview-BLsg9nVv.js\":\"ee0000a17a8d2ac3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/card-BRPPmZJb.js\":\"97b3825a20a5d2c2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-cnzZ1b1u.js\":\"9f2aa0be5ca05375\",\"/knowledge-medium/pr-preview/pr-1789/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-Dz1hn0fU.js\":\"b0ab2be8c64b7c5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-async-D5F0ArBL.js\":\"7eecdd4af4d9e5c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-B6zGa7QM.js\":\"420e2a8535c516f2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BfPAAC5q.js\":\"d4750c32f67bd4ce\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CYOukZkQ.js\":\"9bf7aef2a28a58da\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CloY0Hln.js\":\"25979dba1335436d\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-Cm74y1ti.js\":\"d5104801c72982f6\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CzcMJr29.js\":\"28a7fc781a328a77\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-aPgOEwni.js\":\"57c8bbea829a294a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server-legacy.browser.production-D-ShYE0G.js\":\"58195c7e97706508\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.browser.production-DTfjEpaJ.js\":\"a7ddac36e79efcd4\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.edge.production-Bc032KYf.js\":\"328df7d9b73bdb25\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-no7-O__H.js\":\"3ec9ed8d509274c6\",\"/knowledge-medium/pr-preview/pr-1789/chunks/server.browser-DY20wchM.js\":\"0885d002b649d91e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/textarea-CALJXKvI.js\":\"b3528119d6de7d5b\",\"/knowledge-medium/pr-preview/pr-1789/chunks/ui-BEJrhHmY.js\":\"e4667eb1622a72f5\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-DF2ZsgOn.js\":\"25c5909413dd88fe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-async-CSXkvVqY.js\":\"623aad82ffdd3ff2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1789/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/src/App.js\":\"ff7c049db0418a7f\",\"/knowledge-medium/pr-preview/pr-1789/src/appUpdate.js\":\"611a58d80356c3db\",\"/knowledge-medium/pr-preview/pr-1789/src/appVersion.js\":\"c5e044197375cc78\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/initialLayout.js\":\"ccbfa029fd26a66b\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/openWorkspaceData.js\":\"57e57e69c37dec1e\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/resolveWorkspace.js\":\"f6adb6eb51ea485b\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/workspaceBootstrap.js\":\"d4e6b3e1988892e8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockComponent.js\":\"cdf3d5c45045f235\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockCrumbs.js\":\"53c0c33336512221\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockEditor.js\":\"9183cae3ef39b40d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockLoadingPlaceholder.js\":\"413821cb6eed1251\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockProperties.js\":\"79fc538fd7ade150\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockSearchPicker.js\":\"1fa3f11a07b80783\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ConfirmBulkDeleteDialog.js\":\"43e22730194d6768\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DividerHandle.js\":\"100ccd1dd96ee6aa\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DraftEditor.js\":\"bc02a19db6627dbd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/GutterPill.js\":\"91ac4800f95e9860\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Header.js\":\"41a2b243e9749a0d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/LazyBlockComponent.js\":\"14effd99e51249ac\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Login.js\":\"a08604d97474fda7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ZoomableSurface.js\":\"f4d23d9a30d93191\",\"/knowledge-medium/pr-preview/pr-1789/src/components/editModeKeepalive.js\":\"0b7a175f98fb2c2f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6ca8d02b31d9b72a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"74d891184d998085\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefPropertyEditor.js\":\"589f43353beefe71\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefTargetTypePicker.js\":\"db75eb1657798ddb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/SelectPropertyEditor.js\":\"2c1f41d287cb7cce\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/TypesPropertyEditor.js\":\"adaea51c99a01db7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/defaults.js\":\"23bee72c1bed27d4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/kernelValuePresets.js\":\"94a1daa88ebd7228\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/selectablePresets.js\":\"c0816757209fc60a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/typesPropertyUi.js\":\"72f4b0bc44aa641f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/AddPropertyForm.js\":\"ba76725caff801d5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyPicker.js\":\"4a69ff54bbe7e231\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyRow.js\":\"5c4873824a3fab3b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/Rows.js\":\"8126329ac6c08112\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/actions.js\":\"8df7bd3a983273dc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/declarationOnly.js\":\"e1b5315f4a43c4c2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/layout.js\":\"c7be397108e4ef1c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/model.js\":\"f8809b1578640079\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapeUi.js\":\"906d08c6a2ad5d09\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapes.js\":\"2ceef34a7358080f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2f51967ba1279968\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/visibility.js\":\"1045ad3e26c91b97\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanelSections.js\":\"38f1c83100d3937a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockEmbed.js\":\"0717cb5ea115e58a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockLink.js\":\"e93987e85a33fba8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockRef.js\":\"b3f830b74d5f66e7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/ReferenceLink.js\":\"412ccdeb7c389e2d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuard.js\":\"a7ba173d71f7ff85\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuardContext.js\":\"a132b1616068eaa1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/linkInteraction.js\":\"0179ddc99ca202c6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/referenceLayout.js\":\"4b574ea92208be00\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/useBlockRefAncestors.js\":\"b5eaf6354b3fae30\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockGutter.js\":\"db76bfdf464a6632\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockInfoDialog.js\":\"fad14a5e3a413d1c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockTypeBlockRenderer.js\":\"dec092c36dea9d3b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BulletHoverCard.js\":\"6ca742cf5a2aaa0e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorContentRenderer.js\":\"ef01242a6dd1c5a6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7ea84e7ff52a78dd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ColumnResizeHandles.js\":\"6fc85fcf634b979e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"971e3d9894eaeed1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/DefaultBlockRenderer.js\":\"e05fb948350eb1f0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/LayoutRenderer.js\":\"747e90ffbd21bdad\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MarkdownContentRenderer.js\":\"457877dc8215548d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MissingDataRenderer.js\":\"9a7d7408e262e384\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PanelRenderer.js\":\"80a0d2e84bb2f3da\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3a5dbb237b0bfe95\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/TopLevelRenderer.js\":\"8b649822919c950b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockGutterMode.js\":\"cd134f581aaab44a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockTitleText.js\":\"9b1c8c97c22e7622\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/fieldCreationKeydown.js\":\"e4698abcf7b3b2f5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/layoutRootContext.js\":\"0dbac43c7f644b82\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/TypeChip.js\":\"b263674b7ac7cb9f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/chipStyle.js\":\"0f31ef7be5642367\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/anchored-floating.js\":\"0bd7684b4b8a3d5f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/button.js\":\"9d6dd17882e1b154\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/card.js\":\"46dd035d92f6d51f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/checkbox.js\":\"525aa47ea07a3e6f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/collapsible.js\":\"8e7ff1bb9e25db7d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/command.js\":\"2236758e6c7bdbd4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/context-menu.js\":\"96e15b83cc9bf6f8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dialog.js\":\"528545f1d957d785\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dropdown-menu.js\":\"c94704aa699f01e7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/floating-listbox.js\":\"a9b404a1e408c94d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/index.js\":\"7592867de53fde9b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/input.js\":\"df5954ca0b1019ce\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/kbd.js\":\"89a13e209fe21814\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/label.js\":\"4b7eb1ac7413e300\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/textarea.js\":\"3c1931ebbb5f06cf\",\"/knowledge-medium/pr-preview/pr-1789/src/components/useEditModeYieldKeepalive.js\":\"7b27fd83aa05c0f0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/BootFallback.js\":\"eb79e19284b32d7c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/FocusedRowLazyMount.js\":\"1936c48a6c3ba93c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LazyViewportMount.js\":\"a87e4beba9d9b9c5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LocalDbCorruptionFallback.js\":\"95fd04b933f94154\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/error.js\":\"fac004813bd5e9e4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/lazyMountRegistry.js\":\"472de98c9f809eed\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/suspense.js\":\"c4a3e67486865335\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/CreateWorkspaceDialog.js\":\"4ec7f7a96a6a2498\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/PendingInvitations.js\":\"37156f91e51c13ef\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/SyncProgress.js\":\"3132e55aa31741c8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/UnlockProgress.js\":\"b0f7242bf426d33e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceKeyGate.js\":\"e89e77cbd36e509d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSettingsDialog.js\":\"94352e88ec8101af\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSwitcher.js\":\"526448c3059a1774\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSyncGate.js\":\"e72f368679f66cb5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlow.js\":\"9b5e5f9f08f6a090\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlowHost.js\":\"771f6eed02cbeee4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/EncryptionSection.js\":\"d402f93c410b45c3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/attachmentPrompts.js\":\"a8b853e93f8bee70\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/bundleFolderPrompts.js\":\"932b25ea32aa5423\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowDeps.js\":\"e4ab1a6fb50a29ec\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowStore.js\":\"42c4d1fedeffc2ff\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/flowUi.js\":\"6a33f4cb51528360\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/useConversionRun.js\":\"3c1798b6aa2c34f6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/keyUi.js\":\"bd1100b2df6e7d9d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnKeyLoss.js\":\"0d23e1f6286eeb57\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnServerE2ee.js\":\"30e6be65f342ec22\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/workspaceUnlocked.js\":\"4544638d0bdb46e9\",\"/knowledge-medium/pr-preview/pr-1789/src/context/backgroundSubtree.js\":\"3f15c115f7ce4e87\",\"/knowledge-medium/pr-preview/pr-1789/src/context/block.js\":\"7b3377f56f035687\",\"/knowledge-medium/pr-preview/pr-1789/src/context/layoutWsContext.js\":\"6e6bde293afa861b\",\"/knowledge-medium/pr-preview/pr-1789/src/context/propertyDisplay.js\":\"57efc28f04f74da3\",\"/knowledge-medium/pr-preview/pr-1789/src/context/repo.js\":\"62d5a5d60979da33\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasClaim.js\":\"24b125031b78c0ed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasSeatNamespace.js\":\"a35ef71e83721c0c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockData.js\":\"d8e8a7a65ef16102\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockType.js\":\"254a2ace711110d4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/changeScope.js\":\"bee83a7bfde7f9a7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/codecs.js\":\"dd5de14b7e405d8e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/derivedData.js\":\"e19fa3ebafedbbb3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/errors.js\":\"5619c509a8a8fa22\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/events.js\":\"96f01cc6f876e48c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/handle.js\":\"8867befe5cdc0200\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/index.js\":\"f551523800655682\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/mutator.js\":\"eae80c3d61ba9aad\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/processor.js\":\"d5be41f31753a761\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/propertySchema.js\":\"74262dcfce99e453\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/query.js\":\"f047a3b68698833d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/sameTxProcessor.js\":\"2bdd3034f6ef6743\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/schema.js\":\"8867befe5cdc0200\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/tx.js\":\"8867befe5cdc0200\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/typedBlockQuery.js\":\"552b1106866228a6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/user.js\":\"2199a8917045735f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresetCore.js\":\"e082c469f9c24f7f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresets.js\":\"4a47dbb467b6b80e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/attachmentCleanerIOVerb.js\":\"fa12a399c69cd273\",\"/knowledge-medium/pr-preview/pr-1789/src/data/block.js\":\"fa9efd5bb42a9746\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockCache.js\":\"763d2a03a8b9b80a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockId.js\":\"97c885801585eeef\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockLiveness.js\":\"f52eda07b5dd6e42\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockMerge.js\":\"21c8b3479c71cbc1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockSchema.js\":\"d15e4266a4a183d8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockTypes.js\":\"f3b51f4d1a21fdd1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/clientContext.js\":\"bdf24a5d9d929b0f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/dbFileSiblings.js\":\"aac5361df485767f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/definitionSeeds.js\":\"8c4b3dde27c77a19\",\"/knowledge-medium/pr-preview/pr-1789/src/data/derivedIds.js\":\"c4a48c434e9eacc8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/drawnSubtree.js\":\"13f80829279a86c3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facetBridge.js\":\"fcfef3574aa02601\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facets.js\":\"39bdf5c10f913f0a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/globalState.js\":\"184152b918c72018\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/aliasClaimRederiveProcessor.js\":\"143e531e8fdfef59\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/ancestorBatch.js\":\"1da4edc681c05715\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/blockTypeTypeifyProcessor.js\":\"fefac0212a7e3441\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/clientSchema.js\":\"71718fdc312d191e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/commitPipeline.js\":\"730e6ca776337edc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/devAssertions.js\":\"387cee52766e9082\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/firstSync.js\":\"d1f206bb2ee8c725\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/freshInitialLoad.js\":\"d3d2fc8ac709d818\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/graphBackfillClaim.js\":\"f5fce3a3a6821665\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/handleStore.js\":\"75dfbac1c96b4512\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/idleMarkerJobs.js\":\"60cf708cea37805b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initialDownload.js\":\"f330b26bacd556d4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initializeClientDatabase.js\":\"d7e177b6bb1e80db\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/jsonCanonical.js\":\"d74225eff6f423e4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelInvalidation.js\":\"49b5d3eaa741aff4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelProcessors.js\":\"12c01e1dc4cd93c5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelQueries.js\":\"08399a55e77b0d0f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/mergeTypeMembershipProcessor.js\":\"55c1f64f29259dfe\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/normalizeReferencesProcessor.js\":\"f9ab30b2bc0765f1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/poolInstrumentation.js\":\"6e1ca9820e1cc977\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/processorRunner.js\":\"2d79d7f789212e61\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyCellBackfill.js\":\"c3c8abab8e28c0d8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildMint.js\":\"c3b187237f437869\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildrenProcessor.js\":\"2ecbc90d6dff4a17\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionChangeProcessor.js\":\"97f0739420b26261\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionSynthesis.js\":\"4243f6f078f8d4bf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyKeyScan.js\":\"72f33d24bcd5069d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertySchemaResolution.js\":\"8b3850b09616edee\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/raiseProtocol.js\":\"0932d31892aa8bfc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/readBatch.js\":\"5bcb939a0e2536a9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/refProjection.js\":\"a33ee450fab31fd3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetLookups.js\":\"9ba9f6a5906e399b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetProcessor.js\":\"86c439e7a3e2f049\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/replayMerge.js\":\"6307475e42e55583\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/sqlBinds.js\":\"2a0054970d24e914\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fb8c6c9f2b4f73b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/arrivalProcessors.js\":\"2907b3dcaa8577d1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/invalidate.js\":\"f694b478d9417ccd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/materialize.js\":\"73c5514536d4d4dc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/observer.js\":\"2b66ad27b62cb3d9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/reconcile.js\":\"07265a199604a657\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/timingMetrics.js\":\"3907dd483f4f1a5e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/treeQueries.js\":\"b7e24bf5b705a7fa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txEngine.js\":\"e58bc81e27b19b38\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txSnapshots.js\":\"67c765716faa3960\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/typedBlockQuery.js\":\"c731302d79ab572e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/undoManager.js\":\"e7c30638890519ba\",\"/knowledge-medium/pr-preview/pr-1789/src/data/invalidation.js\":\"e2347ccfcee81a83\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelDataExtension.js\":\"53137d44a70173e6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelPage.js\":\"045daecd6a353826\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelValuePresetCores.js\":\"bb995e84c4c972ae\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbCorruptionSignal.js\":\"f3d7d73921b102d9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbStorage.js\":\"002ef64bdf033a38\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbVfs.js\":\"f1fd8beaa6d44ee6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localSchema.js\":\"8498080bebfaf666\",\"/knowledge-medium/pr-preview/pr-1789/src/data/maintenance.js\":\"04008b74ec9cb40f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mergeProperties.js\":\"7dcb9101067888d6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/metricsConsoleHook.js\":\"2502cab62cae2f4f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/migrationsPage.js\":\"5546fbcf9f68ef75\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mutators.js\":\"1897b274749629d5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKey.js\":\"18d6979eaf644c2d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKeyPlacement.js\":\"615cc039ad1da637\",\"/knowledge-medium/pr-preview/pr-1789/src/data/outlineSurface.js\":\"ee30c386dbc81127\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingEditorContent.js\":\"0b91318b2f8663ab\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingUploadsSql.js\":\"52ac080781a3e75f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pluginStateExtensions.js\":\"6f3d2f0095b9cf4b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/powerSyncLogger.js\":\"53f6109a44d5e90a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/projectorRuntime.js\":\"003ba18cf9227050\",\"/knowledge-medium/pr-preview/pr-1789/src/data/properties.js\":\"f58d4d90cb25723e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertiesPage.js\":\"06f322ac8f15b8ba\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyChildren.js\":\"02475778257f8218\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionFanout.js\":\"d0e8dc45c2d7c7b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionMetadata.js\":\"533af653191d41ac\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionRegistry.js\":\"83f438f18a50e945\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDisplayMode.js\":\"cebe378f2fff8e6e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyRowCreation.js\":\"9989585962353d2c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySchemaCreation.js\":\"455d80ced85b43aa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySeeds.js\":\"e3d2a825c2abc95b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/recentsPage.js\":\"06946e60f82426b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/referenceBlock.js\":\"ac76fe764adb38df\",\"/knowledge-medium/pr-preview/pr-1789/src/data/releasePowerSyncConnection.js\":\"a459b4e742063761\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repo.js\":\"7f3cec3c63a89d11\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repoProvider.js\":\"017fb09b9a8765de\",\"/knowledge-medium/pr-preview/pr-1789/src/data/rowProperty.js\":\"fd9673a2678e5463\",\"/knowledge-medium/pr-preview/pr-1789/src/data/searchFilter.js\":\"dd8fb22181d65215\",\"/knowledge-medium/pr-preview/pr-1789/src/data/seedIdentityLedger.js\":\"3ae1d6d4abec0f16\",\"/knowledge-medium/pr-preview/pr-1789/src/data/stateBlocks.js\":\"a931bd4cf8c656c1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/structuralEditPolicy.js\":\"1a96196c4397ec85\",\"/knowledge-medium/pr-preview/pr-1789/src/data/subtreeDelete.js\":\"c636260f10434dbc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncStreamLock.js\":\"430a5bda8f60327b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableSqlRecognizer.js\":\"3accbe8ab2246425\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableWriteGuard.js\":\"2ac3ecae9d6d4bee\",\"/knowledge-medium/pr-preview/pr-1789/src/data/targets.js\":\"ab88d47cf1745699\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeColors.js\":\"fae7755a7f213761\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionMetadata.js\":\"f98490fcdf36f800\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionRegistry.js\":\"2b5ed4c17699a6a7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeExtraction.js\":\"3d16f5e5822080c4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeInitialValues.js\":\"59cceadc0eee9acd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typePropertyGroups.js\":\"9360f8bd4e8ccaf0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeSeeds.js\":\"ff188b0879fac76b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeTagger.js\":\"0f2c90af4c807740\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typedRecords.js\":\"ae2eb071372538a9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typesPage.js\":\"c5be751ec057d383\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userPrefs.js\":\"45ad9926c2bc9787\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userSchemasService.js\":\"0340c90e686d7e4a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userTypesService.js\":\"47e854668d4c4b9b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/valuePresetRegistry.js\":\"37105f54b99e8285\",\"/knowledge-medium/pr-preview/pr-1789/src/data/visibleChildren.js\":\"e3fb3d97bc370830\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceConversion.js\":\"6cc6217785957910\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceFirstSync.js\":\"de4996b95e35294b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceIdNamespace.js\":\"d70d2fc022f842b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceSchema.js\":\"c07f5590adf90dd1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaces.js\":\"8be67a91b44f36f2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadLog.js\":\"bbea7261d2190718\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/BlockPasteShellDecorator.js\":\"aeab22fd8f0ad19c\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/atTrigger.js\":\"4e1451c9221083f4\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/autocomplete.js\":\"aab72b849211ab95\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/codeMirrorExtensions.js\":\"30d63762f40eb6ed\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/contentFlush.js\":\"4ec448c2e86119e6\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/defaultInteractions.js\":\"d108eb1a828334e1\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/editSettleSignal.js\":\"36db136954112e20\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/insertImage.js\":\"00db1bb4b528890d\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceCompletionRange.js\":\"bf8955a70682a7a2\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceTargetTypes.js\":\"0dbd0e8f48c7562c\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/syntaxContext.js\":\"317cbcfeb4f607bc\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/triggerMatch.js\":\"08aa8a49e114964d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/AppRuntimeProvider.js\":\"a0adb72d52394166\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/BlockFocusShellDecorator.js\":\"5a0b446d68e9ece1\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/ExtensionRenderBoundary.js\":\"df34686598c45ef2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/PanelContentRecovery.js\":\"1a16cf22accb1890\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/apiCatalog.js\":\"72b544567c9f47dc\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/approveExtensionHere.js\":\"c7dd1928fe5f7dc6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/armedCutAppMount.js\":\"73d449f178254e99\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/batchableKeyedStore.js\":\"cdbb8ea9d307ccb2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockInteraction.js\":\"a6419723e352da65\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockSelectionAction.js\":\"0356c502d7c747a3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compileExtensionModule.js\":\"a829b9718cd6c309\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compiledModuleCache.js\":\"77155b2f4ba25731\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/continuousGestures.js\":\"e37469f59f3d66ba\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/core.js\":\"c1979ce1d5653604\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/defaultRenderers.js\":\"047d7a5ac5718f6e\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/definitionFanoutAppMount.js\":\"05ac0a2c3b8cb4d4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dialogAppMount.js\":\"316ef2775bcf28b2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensionSeeds.js\":\"fa58cd16b38cd76c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensions.js\":\"20a25410d198bc99\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/exampleExtensions.js\":\"588edd6ee0771dea\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionApprovalStatus.js\":\"c069a5e6c72bdfa4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrorToast.js\":\"c678abb961e25a20\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrors.js\":\"55eddbe3a774c00f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLookup.js\":\"87189aaba30f51b1\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionToggles.js\":\"0089433d6563fa26\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionUtilitiesCss.js\":\"eecbbdf6c55db8b3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/kernelPageDeletionGuard.js\":\"5fd0a2d95aaa6af2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/liveRuntime.js\":\"f6f0b722dea065b4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/openExtensionsSettings.js\":\"8815c50a73fcdb36\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/overridesCache.js\":\"2dc2c3716d7386ed\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/pluginIds.js\":\"f5181f32998f806a\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/processorRejectionToast.js\":\"205caa6a758c740d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeActions.js\":\"43863d2a12a67faf\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeContext.js\":\"58efa9d139a6c7de\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticAppExtensions.js\":\"f2eee2d39eee5bbc\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticDataExtensions.js\":\"0e1e859daa848093\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/toastAppMount.js\":\"af2d1a8226b2038b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useOverrides.js\":\"1d894821a39871ba\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useShortcutSurfaceActivations.js\":\"64621f4626bc1a6a\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/discoverToggleTree.js\":\"02aca92b9203ea4b\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/facet.js\":\"426407207caa30af\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/resolveAppRuntime.js\":\"3bb0746d7bb916d1\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/runtimeEvents.js\":\"3298950d56765611\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/togglable.js\":\"735652116bb97978\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/variantFacet.js\":\"3c3ad94feb0c7fe9\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/verbFacet.js\":\"ed994a3495f38760\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/block.js\":\"5a5a6f6970bbc787\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/focusedChild.js\":\"e92b65805eea704f\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/propertySchemas.js\":\"c85ed982d91b53bb\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/typeRegistry.js\":\"a5235f21b30d44f8\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAncestorCrumbs.js\":\"6394cb2e990c15f4\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAutocompleteListbox.js\":\"deaf4d147c6c4aa6\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedSearch.js\":\"94862ad2ebac93af\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedValue.js\":\"06b22f6447d3723e\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsFocalRender.js\":\"f96732a8c9d251e8\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsReadOnly.js\":\"44ae8daf1a38d0ac\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMaterializeBacklog.js\":\"a4d50ba83e81125e\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMinuteClock.js\":\"56a2f9833b45affe\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePanelLayoutProjection.js\":\"29c26813f5466317\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePendingInvitations.js\":\"cd9aada43a0408b3\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRendererRegistry.js\":\"8b34635654f199a5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRetainedFieldRows.js\":\"1edf20bd15a64ba0\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useWorkspaces.js\":\"810d72ee6001384b\",\"/knowledge-medium/pr-preview/pr-1789/src/lib/utils.js\":\"ec400eb4ee0010ad\",\"/knowledge-medium/pr-preview/pr-1789/src/main.js\":\"31bc79f51788e9f5\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/MarkdownImage.js\":\"d66c0d7e7f515ad7\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/blockSeparators.js\":\"ab636a0e0e6526ec\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/context.js\":\"a723bfabf964e9d1\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/defaultMarkdownExtension.js\":\"cf83083a66287132\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/extensions.js\":\"180140bc226dc3ac\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/renderMarkdownHtml.js\":\"461734b822769832\",\"/knowledge-medium/pr-preview/pr-1789/src/minimal-editor.js\":\"6a7202023c34fa4b\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/armedCut.js\":\"4d88819b40387ebf\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/captureMediaVerb.js\":\"bc24138fd52e1c18\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/clipboard.js\":\"ad44244d16b84479\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/decision.js\":\"565b868e096b2a8f\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/operations.js\":\"34189dd7fe8d3c2b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/AccountHeaderItem.js\":\"24e1ae0ffeb2ccfd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/index.js\":\"07cd59566139313d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"db215afcc5aca505\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askAgent.js\":\"62ea99be850b49c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askedStore.js\":\"a08eac91fdb36f65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"dde2f71f03324fc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/chipState.js\":\"d094dda4135e5323\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/dataExtension.js\":\"da061d9708b1c094\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/index.js\":\"c9d73c73bf869d60\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"39ec0fea0809a8d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/schema.js\":\"48a4aabf78586e39\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a1a99156944c98b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/BridgePairingDialog.js\":\"38f18cdd4cd9d9d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/addMedia.js\":\"afd7e2e469b73d57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/backlinks.js\":\"668255f32c599b85\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/block.js\":\"e82e62d218295685\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/context.js\":\"bc1538174d390430\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/displayIds.js\":\"198d7c8c946c35e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/index.js\":\"d173b7fc0ef532ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/outline.js\":\"26d1369bacf1bb31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/properties.js\":\"873dc6929518949a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/refs.js\":\"c6f0f229e8deaeba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d128beac0cd51610\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/search.js\":\"109f7ab58c6ba967\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/shared.js\":\"ba74f4f4ccc6d52c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0a82b19f17234581\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/text.js\":\"97cbaa8900b91fb9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentWrites.js\":\"48b5a3aff335f62d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/authoringCatalog.js\":\"6b0a06b1b25fb19e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/blockRefTargets.js\":\"f01d43b2ff109dee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridge.js\":\"03a6be2bc75c74d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridgeLoop.js\":\"cb4aed91fa31770a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/changeHistory.js\":\"b56a16ce2c9729be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commands.js\":\"a414d3a6d3651e15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commentsCommands.js\":\"d3b9a894d4479837\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataExtension.js\":\"0400780eaf35d6ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataModelGuide.js\":\"f2eb880d0d5e27c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/describeRuntime.js\":\"af7ef90ffdfcab6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/extensionLint.js\":\"7597ca23258437a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/grainAudit.js\":\"529d41e507233ea5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/healthCommand.js\":\"03a590e334c46b0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/index.js\":\"b0f3c9cf27e751af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/presetIdentity.js\":\"88eba5123226ee68\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b2692d751c3ef429\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/readMedia.js\":\"6e3070e9180adc81\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/schema.js\":\"a7ed99f8ea07adca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/serialization.js\":\"d34d275978a2c1c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/targets.js\":\"63cf10ca21b2f2e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/tokens.js\":\"4a93dcedd7624479\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/watchEvents.js\":\"ccc070b5ed281531\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/workspaceGuard.js\":\"b5861e3553028643\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/writeCommands.js\":\"fcf26aa3251aa8f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/AliasCollisionToast.js\":\"e95fc300b6254dbc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/DuplicateNameBanner.js\":\"9eed5671017ef8e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/collisionMerge.js\":\"01d5bc617100986f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/dataExtension.js\":\"2116043564c1241b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/index.js\":\"7311720106a729cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/mergeCollisionAction.js\":\"98c1d22aa941ca73\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/pageStyling.js\":\"4714fb48d1a9f442\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/rejectionToast.js\":\"c0a86548eb3fa5df\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/syncProcessor.js\":\"0f9cd46f4dd24c1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/actions.js\":\"3c53cc449623a752\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/addComment.js\":\"66f1cd4b9f9c3353\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchor.js\":\"f8bc5fd64b78957a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchorState.js\":\"0aa544dcb6e60191\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/commentLinks.js\":\"7c5a2cc5db1ccfe6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/confirmThreadDeletion.js\":\"ff8b4d6a4b1aa884\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/container.js\":\"82b60c7cfb6a4712\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/dataExtension.js\":\"763b899dfc4f66b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/deleteComment.js\":\"f8b039bdecf02c34\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/highlights.js\":\"cedf5ae4187c162a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/index.js\":\"c77a1d3b4e6ce833\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/linkedCommentsPill.js\":\"b397d54c571b47ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/margin.js\":\"9f0b921f77890433\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/marginSchema.js\":\"c06397742c44074a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/newComment.js\":\"844f54a405be2ea7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ownThreadPicker.js\":\"a825973cd83d948d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/placement.js\":\"047c157f8e17d33c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/queries.js\":\"65757701468903bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotePosition.js\":\"c4fd8cdceb77cc90\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedIn.js\":\"09d50a74916e73b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedRange.js\":\"ec4dc71bdcd23f4e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/rangeRefs.js\":\"0073b9efe937a7f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readHighlights.js\":\"4f347614853dc1e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelection.js\":\"ee2037486c5edc72\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelectionUi.js\":\"10e3991a7b61d042\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/reanchor.js\":\"7ad1217c079d3c84\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/schema.js\":\"ae1133ca1ed4b366\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scope.js\":\"ad084a8a920b0b2c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scopeThreads.js\":\"07b9e12e4547001f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/splitRetarget.js\":\"3a7bc9de6ae5b160\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestionCard.js\":\"776c665ad0cd375c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestions.js\":\"b767ed4e8413af79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaries.js\":\"95a0edbb0e2b8718\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaryBatch.js\":\"8e138d388ff4cc50\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/surface.js\":\"2ec015c3681bdde2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threadNavigation.js\":\"40cc65cec4147cd8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threads.js\":\"d7143a33cffe6a9e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ui.js\":\"17f090b16c8551cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/uiStore.js\":\"4c5c3981b6d9b3b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/appIntents.js\":\"7b7765852fd15ef3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/index.js\":\"32532d58041f700f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/index.js\":\"1305b1d02c4bb760\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/status.js\":\"7803eefca5417d72\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c9705d12e65e1f4b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaBlockRenderer.js\":\"e19c37c51c129765\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaDownLaneReplicator.js\":\"45a82917c2899884\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaUploadReconciler.js\":\"b26fb9a191ad2889\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetDownLane.js\":\"50866d837b3adad0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetResolver.js\":\"2f09e8538d68a9f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetUpload.js\":\"aa83a1f537c72be8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/attachmentCleanerIO.js\":\"04b05b2fed4c6600\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2e2a91d916a86a8b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/blobStore.js\":\"52585d97c32de502\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/byteStore.js\":\"d59780cebf275e2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanerIO.js\":\"13bfe01c427c892c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanupAttachments.js\":\"cf5fc8bdae8194de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/dataExtension.js\":\"f2d91d1022a7ef81\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/downLane.js\":\"bf50bcf006bc284e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/index.js\":\"90ce009efd1ed8db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/insertImageContribution.js\":\"d561beb578315302\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneArming.js\":\"51d17f191998acdf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneLock.js\":\"dd61f1c5c0e65d19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaBlock.js\":\"a25d7c2c1b55b884\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaCapture.js\":\"a2e6f6056861f5e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewers.js\":\"96d1db624c937e8e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewersFacet.js\":\"249f2c5a3fe01ec3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/pasteCapture.js\":\"2db3c83ebedc9bde\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/resolver.js\":\"00ac7673d477bfb5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/retryUploadsAction.js\":\"658d3ad0356114ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/storagePaths.js\":\"a108c1fe7053321e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadDrain.js\":\"319a7283a45f2470\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadLaneStatus.js\":\"8a19909abeb6994b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadReconcile.js\":\"364a86bd6883c7ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadRecovery.js\":\"c29cf13638803edf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadStore.js\":\"0fab5686c59ea4c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/useAssetObjectUrl.js\":\"b6407a8201ea17b2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a0c4c6479ca9ab8c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d2d546c0a8ba73f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/facet.js\":\"25f4dd7314125e13\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/index.js\":\"2cdd4fc648de99da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/prop.js\":\"a047da960b4205e6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinkFilters.js\":\"ce480951db0bd189\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2a24c2dc8f030411\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BlockEntry.js\":\"08c4bbcecd0d9db3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/LinkedReferences.js\":\"cd2fde86299ac13d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"151741043bacaed7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dailyNoteDefaults.js\":\"46157295c1f13ea3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dataExtension.js\":\"0da04cbec9a502c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/edgeExclusions.js\":\"a4242339aa6f85b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/filterProperty.js\":\"53143438b44818aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/index.js\":\"34adf632a7993730\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"07238a9ce8927c1f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/applies.js\":\"71e2805925e0d44b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/countQuery.js\":\"0d8c036524ecf0fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1d622b2cf777794b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/index.js\":\"9d3af2d3da1dc5fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a53e637c6955223c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/presentationInvalidation.js\":\"2fd50f447727454d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyEditorOverride.js\":\"aba35ef090201d99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyFilter.js\":\"dbe143e82d5c4f33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/query.js\":\"d23e0b49dceaaa59\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/resolveFilter.js\":\"022c06e19203244e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sourceBatch.js\":\"595c43a058e1e150\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sources.js\":\"7eeb8b026a6ce7fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useBacklinks.js\":\"929739bced9011cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"be2720f67446d478\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayCelebration.js\":\"8d857f8323a45507\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayOverlay.js\":\"7825fe975e9f4182\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/gate.js\":\"33db67afe59b7970\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/index.js\":\"98fc5d59de2688b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/wolfTheme.js\":\"5f89bb0ac49ee64e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/BlockDragLayer.js\":\"161fdab7ed9782aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dragController.js\":\"51b30a3f662d0b5c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dropTarget.js\":\"bde44c366d5355b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/index.js\":\"1b9d90b168a470b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/projection.js\":\"4c921d859e0b1890\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/BlockMetaCard.js\":\"4a4b5cef8842c306\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/index.js\":\"97d8b0ddbd7d7e7a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/AddTagDialog.js\":\"7cae6f1779b47f7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"9215c4257a3829a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/TagNameIssueHint.js\":\"c7e373ff4833abfe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/addTagAction.js\":\"3667ca8afcc5069d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/appendTag.js\":\"4ea194d757aeffe0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/config.js\":\"12348b73e6e109ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/dataExtension.js\":\"fd02c4f142e189ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/index.js\":\"228933e4fcaae467\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/propertyEditorOverride.js\":\"8d3fb7c8fef4217e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbList.js\":\"89d8abf1fd9f7f02\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2fa08b0a86a5f015\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ad5710a63d7552b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"547a78522d69723c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9c1adf61b2f12774\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/index.js\":\"6eaf9c527ddb75ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f6d1279b84423642\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/CharacterCountItem.js\":\"121451f9a7f59f14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a161b478554474bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/actions.js\":\"b6600040539c6dea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/blockType.js\":\"78740da0238566ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/charCount.js\":\"fded81dfbee4939d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/dataExtension.js\":\"460662103f45e3f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/index.js\":\"e97d4059c96136ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/profiles.js\":\"d08cecb7cef3214a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/properties.js\":\"de15bd1eb0ee8ddf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/textCounts.js\":\"a4baab7988002e75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/colemak-keybindings/index.js\":\"a745a76344ee7e3e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/CommandPalette.js\":\"262ef9ad759c22e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/HeaderItem.js\":\"3abdbe9135f06697\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/context.js\":\"7cc7b60d577299c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/index.js\":\"3f11fed527ab3400\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/selection.js\":\"f1072c77fd24a781\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/toggleStore.js\":\"133fa33443d6f6d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/useCommandPaletteActions.js\":\"4f9e60025808db89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/ContributorBadges.js\":\"8e2551cd521b4493\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/author.js\":\"32f16a1b9b09571b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/codeMirrorExtensions.js\":\"d044eb15690a4006\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/dataExtension.js\":\"9c1538b79800b0cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/index.js\":\"672432a3b3d8b043\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/mentionAutocomplete.js\":\"ca8f3cda30abf82d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/processor.js\":\"6feb6efd21dd32cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/profiles.js\":\"2cf45c40aa29e5c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/queries.js\":\"8eacc0efd88e7dc6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/schema.js\":\"e63a82f2626fe4f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2de9631fadcf140e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f7aaf0e07bcb9cbc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/index.js\":\"5b2abb2e13d56ba2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ccfd3864895d9e3d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5d6f7297624aa97f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/CalendarGrid.js\":\"75664b78c450f7c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DailyNotePicker.js\":\"2040d6c08aab7bcf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e1810311e3220422\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateNavDecorator.js\":\"71b33769cbe555f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateScrubOverlay.js\":\"d19d61e03fbd71e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/HeaderItem.js\":\"f16a3374365f1007\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/ReschedulePicker.js\":\"fef379829a14f298\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/SpreadDatesDialog.js\":\"238772593a2d1b34\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/actions.js\":\"1c14ead5722dce29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/blockDateAdapter.js\":\"0f4356621d2d85f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/calendar.js\":\"87d47a23a75135c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dailyNotes.js\":\"9c4828532a440006\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dataExtension.js\":\"dfcb653f9230eb1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubActions.js\":\"a6b8f163f2027a1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGesture.js\":\"249dfb04ecd5ac17\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c4cb92fd016af792\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ca7c6ee3c2ad7e84\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/deletionGuard.js\":\"f66cd9f809e05060\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dueQuery.js\":\"a3b3c6d55ce9f9d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/index.js\":\"39c886599bbc3428\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/landing.js\":\"aeb3addcd7e76914\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/localSchema.js\":\"77ff8a5afa3e36ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/referenceDateAdapter.js\":\"226bb5bbc562df20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/rescheduleAction.js\":\"6892d1c62325200c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/schema.js\":\"49959aede4d29fbb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadBlockDates.js\":\"f05a3333b04c8bf7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadDatesAction.js\":\"a2e7ecd24990b821\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/today.js\":\"7b52b4d340dcb977\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"96e6857cdd2bd4da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"80751dcc2776e5f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/audit.js\":\"6325f2dd9cfb86fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditAction.js\":\"6a92027ff51d9a91\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditRanges.js\":\"424119a448184351\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/diagnosticsSource.js\":\"b6319c4fd87457b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/divergenceScan.js\":\"ae2b3c86d1a276ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/index.js\":\"b2050e6805da8dd0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/propertyChildrenChecks.js\":\"23da1d14d19636bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/referencesMirror.js\":\"ebb80263b6579730\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/rowJson.js\":\"2458d9234af44354\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/schedule.js\":\"5d04dbf077209165\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/store.js\":\"6e599cf6dd9494a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/action.js\":\"f6fde00858205cf6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/index.js\":\"a04dbf41a1d2ee89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/plugin.js\":\"0eeb55ce8abe9d18\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f4b2b4743230435b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/actions.js\":\"3519786b87d4f484\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/changeMarker.js\":\"b218ef4440d9d8b5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/diagnostics.js\":\"1fb16dd74b3d8cac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/fileSystemAccess.js\":\"1980c4bb5e92be6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/filenames.js\":\"5023614018c4a31a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/index.js\":\"3594cd0602ee8db6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/mirror.js\":\"1bd13b499b7044a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runLock.js\":\"fee8826f2a31a6ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runtimeHealth.js\":\"6d761a8ecefc149c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/schedule.js\":\"b3c77397061ff129\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/store.js\":\"eea9a68635ed5431\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/index.js\":\"33a840cf4d59ccff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/themes.js\":\"8fe3e15f7a2cac06\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/facet.js\":\"090adf7339914e25\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/useDiagnostics.js\":\"e747863da99e96a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/dismissals.js\":\"b9f71f76b928d8e6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/index.js\":\"dd006e7e7fd8bfb8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/status.js\":\"8a4bc2b561744abf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/store.js\":\"43a3654a9bd24f90\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c7a0eac04aeced87\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d8e5de2f27a82dc6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/actions.js\":\"50d1961bb0908d75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/config.js\":\"1576fa31ec6cb190\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/dataExtension.js\":\"5278955ea7ef106a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/effect.js\":\"9fbec9c5fb0970bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/index.js\":\"7e1235694f124190\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1e38b2db8fadfd20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/useToggleTree.js\":\"ff03a11f1bbcbab7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/ExtractTypeDialog.js\":\"e083d2c527ea1038\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9b33585350ba8c15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/PropertyShapePicker.js\":\"72df26b3a6bac33a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/action.js\":\"30c3c01ad6ff4cfa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/index.js\":\"22dcd5313e662fc0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/FindReplaceDialog.js\":\"fdc5706a20424e1d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/HeaderItem.js\":\"db337f8c3f272de4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/dataExtension.js\":\"eb6e2b1c11afa355\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/index.js\":\"65f9e166c434f67b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/search.js\":\"7dcbbd366fb42a68\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/toggleStore.js\":\"e22fd869f4b5988c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/LocationPropertyEditor.js\":\"723ca4d054977495\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/MapView.js\":\"218ba1e986c3e4bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/blockTypes.js\":\"c8752946a0619442\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/codeMirrorExtensions.js\":\"2858cd79e8077449\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/createOrFindPlace.js\":\"c6a104e0851cf9f1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/currentLocation.js\":\"703071bb6f2ab2e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/dataExtension.js\":\"a369e54e3bbb0262\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/geoContentDecorator.js\":\"ec17abb9752aaadb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/googlePlacesClient.js\":\"bc51c7968104020d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/index.js\":\"0618f51ff091c485\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/locationsPage.js\":\"d59e008410936634\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/mapViewport.js\":\"8ab4b1e500fc15e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/pickCurrentLocation.js\":\"0399c810639f6bf6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeAutocomplete.js\":\"d60a36d04f2d4548\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeNameCollision.js\":\"12bed280ba226545\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/properties.js\":\"c752a028a1415e15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/propertyEditorOverrides.js\":\"70a266c380d5a564\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/query.js\":\"c1055f5753e12af4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/usePlaceSearch.js\":\"9220ab59ce72ac3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"152d076e95b4455d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b9a505ca943f880a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"68a2efd369dfe673\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/config.js\":\"820a83694ba4a6c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/dataExtension.js\":\"dec982d92d0a8e09\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/facet.js\":\"d56745f0946efcf8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/grouping.js\":\"b9be480744b2fa8b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/index.js\":\"8c659be49f593e9d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"faca3b486d727336\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/query.js\":\"e784ed781026c050\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/resolveConfig.js\":\"e244bd4ff927210f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9ca0dece5ac3deba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"dc99c06792aa15f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlDocumentContent.js\":\"811cf39176efb845\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlFrame.js\":\"6ba3eb78f03d1455\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/actions.js\":\"45eb8e91ce76930d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/blockType.js\":\"4ef77c7f7f320886\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/confirmRunScripts.js\":\"eab102ffbfec5be4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/dataExtension.js\":\"47dc5a0f6bda69dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameAnnotations.js\":\"e9dc70f7789e60c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameDocument.js\":\"a27e0bb7b0e63a82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameTheme.js\":\"0a627096e0b0df3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/index.js\":\"b7e52445befe6e37\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/scriptConsent.js\":\"695ee6e809260699\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/sourceMap.js\":\"c7effde3fa340e6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/useDocumentScripts.js\":\"ec5220589e4c515f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/index.js\":\"2940bf0a0974d4b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/record.js\":\"8572c8cdf2fc5c99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/recordStore.js\":\"640f7fe669377e68\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/responsiveness.js\":\"74184f345f101236\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/schedule.js\":\"2f689bc03e94d910\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/sessionContext.js\":\"b94945df98f8f60a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"66a70eb25935ac0b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"93b4045ac83385f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/actions.js\":\"cfa583ee8ced9c59\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/config.js\":\"36e0f4c3f883047b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/dataExtension.js\":\"f65e98a3478fbe38\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/effect.js\":\"4be1862a5076195f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/index.js\":\"20fc3aa2c69a32a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/keyCapture.js\":\"1620cccdb8a42917\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/overrideStore.js\":\"43cd8515d195d490\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0b6c584bca27c9fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/HeaderItem.js\":\"bcd0489f740293af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/LeftSidebar.js\":\"d00acac771b35cf7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/actions.js\":\"1f39a0431453d04c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/facet.js\":\"b5ec8ae54a803114\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/index.js\":\"4f74049d2c9c3925\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/shortcuts.js\":\"a8fa236b983b1ad8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/toggleStore.js\":\"f75f06d3981604f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/MergePicker.js\":\"06cb0cd60eb1ed67\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/index.js\":\"8d77d68ec90e8650\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/mergeAction.js\":\"d2a8028907aa60a4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/strategy.js\":\"8c4fb839c81f43ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/Button.js\":\"96d48c7a2452ee4c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1e1b2355ee3c3c0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/defaultItems.js\":\"688370d383c788ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/facet.js\":\"8b1d65da858705cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/index.js\":\"c9311b40c6feebd3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3d19cba4efc75e6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/actions.js\":\"46073b90823fae8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d63ef9e2dee68759\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/facet.js\":\"39cb9841ce151cd6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/index.js\":\"312d688d78dad6c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ea65e48efd10b2bc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a0f8251178718599\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/contextMenuItem.js\":\"13cfd09ba18e8ccb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/index.js\":\"e2e2d7207b2a8a52\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveAction.js\":\"bc103bb2392aee25\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveBlocks.js\":\"7e12aafc0377fc43\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/selectionAfterMove.js\":\"2f97098aa887e370\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/TutorialBanner.js\":\"8ef147e10f129d44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/action.js\":\"278c68d9f0a9f3b2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/bannerDismissal.js\":\"4fede9745f545da7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/documents/cheatSheet.js\":\"66f04ec0c0a917f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/index.js\":\"760ad47ade4e4e37\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/keys.js\":\"4ab701c28cbddd17\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/landing.js\":\"49a39ad2d4f072cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/outline.js\":\"a48048128389eb3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/seed.js\":\"78d8bd2669b0df1e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/PerfTrendDialog.js\":\"83cf700826311c2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/analyze.js\":\"10fe93294289cbb2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/diagnosticsSource.js\":\"e3af32ef01cb3e45\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/index.js\":\"a5e32e646841669b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/load.js\":\"58519c0312782e6d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/monitorRun.js\":\"5ab5a25af561b765\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/schedule.js\":\"12ac2a8628552c4d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/series.js\":\"93bf7b0a245938cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/store.js\":\"4366e3714c872ad1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/trendAction.js\":\"368d66b717146a65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/verdict.js\":\"0671e3867d84681e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/clickToEditAction.js\":\"4804725f6ce86a30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/index.js\":\"a700e798b68172e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/interactions.js\":\"baeac61d24f94318\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"420effb08334b09e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGate.js\":\"205bcb00fe20011e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGateDialog.js\":\"b82c592ce6885258\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/action.js\":\"508902732b4a248f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/index.js\":\"c261aa1a8c23f73c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/localRunMessage.js\":\"8083a6e431d2efcc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/plugin.js\":\"ff1690ea2854bdd7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/progressReport.js\":\"b7d069f433f0b084\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/sweepProgress.js\":\"4ca13e2bc2da2586\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/FieldRowRenderer.js\":\"3bfc6787e3c6cabb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/ValueRowRenderer.js\":\"9dd0e4024f4886f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/actions.js\":\"701cdf4abac58d85\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/autocomplete.js\":\"0a1f9970cd0ff547\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/fieldRow.js\":\"65659a19d86b2bad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/index.js\":\"90a11d35571713bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/referenceWarning.js\":\"67118aed8a3c505b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueAutocomplete.js\":\"da7129f3bc5029c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueSchema.js\":\"30397bfbff0e9288\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/HeaderItem.js\":\"c3d614e7aae9284b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/QuickFind.js\":\"cbfeb3db5411bb20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/index.js\":\"579afa743b722100\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/recents.js\":\"9c94b23460877fec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/resultItems.js\":\"c810c033d4873e96\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/selection.js\":\"77b914e905b18a8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/toggleStore.js\":\"a4013a83131d9974\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/HeaderItem.js\":\"c344e66d551b95b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b6b3eb8a8c4a448a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/grouping.js\":\"d5c47eb48f6fe24e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/index.js\":\"de0b3b3a5867770b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/target.js\":\"75d00fbd809cbf28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/codeMirrorExtensions.js\":\"70926599802c8d27\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/contentPrefill.js\":\"643cadce4a58e987\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/dataExtension.js\":\"8e9c57a674d3e84d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/index.js\":\"d7d1fd0d0240407b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0bb2fd165bd6c6ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/invalidation.js\":\"3a04701d700a54b2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/localSchema.js\":\"e3557adcd1edf5b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/index.js\":\"4c01b63704f2ad0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a31f60c44f687bcd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/index.js\":\"63550c999ff1767e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/referenceNode.js\":\"52c74140704d42c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/remark-reference-occurrences.js\":\"750e0a01ebd0a672\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"370b82d07060c109\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/index.js\":\"45787c9b2d92ec8c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"63e472ce48eb3ef5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bf9d77acde5598ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/mergeRetargetProcessor.js\":\"7e1673110fe3e7eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/parseFence.js\":\"b3658cb70b294ac8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceParser.js\":\"02afbf62000b7435\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceProjection.js\":\"5160d03dfc5a1cd5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referencesProcessor.js\":\"1fa3ad7047cf378e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/renameProcessor.js\":\"470b3fc22c7904ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/spanReplacement.js\":\"06553d3a9165d278\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/htmlToOutline.js\":\"96f9aa56c42044b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/index.js\":\"a31b6eaa37645932\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/normalizeClipboardDom.js\":\"743019d27357ffb4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/pasteDecision.js\":\"993c031f010eeff4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/action.js\":\"2b4260295af7b2dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/blockIds.js\":\"6bc9274ad105036b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/content.js\":\"1839cf1ef22613c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/effect.js\":\"2d394b00efaf29bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/ids.js\":\"a2002705f57ee620\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/import.js\":\"0d54455091cfb867\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/index.js\":\"8bdbedbfa893aaed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plan.js\":\"65fc46eceababb98\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plugin.js\":\"49cf089504d4c2a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/promotion.js\":\"603375c691c26752\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/properties.js\":\"20d1f8528e519abb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/references.js\":\"abf04368d4035e99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/report.js\":\"8b0a32a5c8d5751f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/roamMemo.js\":\"e58596ac97d8ff82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/runtime.js\":\"fa3e832a02a2bcb9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/schemaReconciliation.js\":\"796964857548cdc4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/srsMarkers.js\":\"6ff00a4cb103af15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/todo.js\":\"d94dcead264f7ddf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/typeCandidates.js\":\"65059747f6df1671\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/types.js\":\"5bfcfc595141f4b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/index.js\":\"30d2375e5c4585c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/store.js\":\"f840e26bf900996f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/HeaderItem.js\":\"fe1e1d814d87dd96\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"be46f2077f1a1b69\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/index.js\":\"09e531dcf3d05d1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/model.js\":\"bae1c4a59c82a304\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/toggleStore.js\":\"ebfd509cd36e98a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/useKeyInspector.js\":\"23383fc96cd270e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5f3e6e74f2c51d57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/ShellDecorator.js\":\"8d75486dc374de52\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/actions.js\":\"7138fa33102673f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3f16a7c730ccda03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/index.js\":\"968e1e44202478b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/shell.js\":\"1826af1a684d9b29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/surface.js\":\"3767a40f8ab229ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/walker.js\":\"8b0a23f27fa1b949\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b391e53123d23cc9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/dataExtension.js\":\"1616a883814c8b90\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/index.js\":\"6d30d3efa20a686c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/indicator.js\":\"7845d59e2578a62a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/moveSrsState.js\":\"98f42d321348d705\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d6bc68af0d548f53\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/scheduler.js\":\"dd6a2b3efcf3c5b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/schema.js\":\"346cfc9585c67aa0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e63bb9b96218485b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsClipboard.js\":\"074454e0c677bfc7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"511e9a71597cdd2a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fcd973413c1aa423\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DeckPicker.js\":\"3d9a2f95d52f931d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewControls.js\":\"5416b569f583ec1f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewDeckRenderer.js\":\"51539de4b0274653\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewSession.js\":\"fcef67ccc48e172c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/actions.js\":\"c835cf5475e51460\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/archive.js\":\"f98436bfa6f0225f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dataExtension.js\":\"371a4ea008593923\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/deck.js\":\"b7df8bcccaf3b592\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dueQuery.js\":\"0fa31370493fe367\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/gradeDecision.js\":\"e7a1aafb82220a43\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/index.js\":\"02da57b2e9fad74c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/keyHints.js\":\"04b17aa50b156874\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewCardLayout.js\":\"234787111a7ba574\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewProgress.js\":\"a7195e548ff79de1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/schema.js\":\"2a3d05fcd627b48b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/useDueCards.js\":\"961a3c4972aa7a1d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/index.js\":\"f4fedce95e9f8597\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/record.js\":\"bfab9a908a25b3eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/index.js\":\"fcdd6d3c8f65db0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/persistenceStatus.js\":\"42719a27f8c28ef3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/requestAction.js\":\"c50339bd7d3f54ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/TypeChipsDecorator.js\":\"a6def4349420fb07\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/codeMirrorExtensions.js\":\"5b392fbc11156db0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/index.js\":\"a993a26735131738\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/typeAutocomplete.js\":\"3d6a73d2dc1c07de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"350be03aceba19a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/actions.js\":\"8a3ec4a5381f37d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/anchor.js\":\"1499f711eb85750e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/events.js\":\"dd60392afce6b920\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/gestureActions.js\":\"11923ce2bf40405b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/index.js\":\"381e6463107d570f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"99572babbebe645b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/collect.js\":\"d61e9593e99cb454\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/index.js\":\"16f99667475c14d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/record.js\":\"a4ac45402a4f0368\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/RejectionDialog.js\":\"4e804ae1ec2244c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/SystemStatusHeaderItem.js\":\"dacacc6ff00cdbb6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/index.js\":\"c234b80e90c71a52\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/model.js\":\"63805a8b3eda27bc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/queueCounts.js\":\"77f44fbdbc24ed25\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rejectedHelpers.js\":\"cb9cfaef9d55ce11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rematerializeAction.js\":\"b62f3d5bfd4603eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/useHysteresis.js\":\"12dea86c78bf4764\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/effect.js\":\"dd1dddee77d5c8ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/index.js\":\"83bc94653bd3d0a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/theme.js\":\"b4a1b59f4286bead\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/actions.js\":\"bf8c3f1ffedebd16\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/dataExtension.js\":\"4cb407cca98fc0b5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/index.js\":\"12b44fa05f21cb5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/schema.js\":\"8b1f8214c4837a56\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b4fd9334d73f2526\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/actions.js\":\"9add76a037d060ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/defaultItems.js\":\"437ae16945599d38\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/facet.js\":\"b75f3124a5e7397d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/holdRecognizer.js\":\"5b6a9bd3707b670e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/index.js\":\"82bc582550f45aee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/UpdateIndicator.js\":\"737614efcdc46fd5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/index.js\":\"878879426400556f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/loadTimes.js\":\"a660c3ee0c5a6e35\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoNotesRenderer.js\":\"a74828f3b598893f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoPlayerRenderer.js\":\"46bd418590f9c96e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoTimeStamp.js\":\"eef9e10ee1175e73\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/actions.js\":\"2d2b7917349104e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/index.js\":\"44f5eee244e15659\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/markdown.js\":\"d5431794cbf6751e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/notes.js\":\"6f7a30b4439049ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/registry.js\":\"80388c460f441d5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/remark-timestamps.js\":\"500b61cb070024c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/view.js\":\"b4ec6783810068ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/LinkHints.js\":\"db32767c92eeb83d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/index.js\":\"7706f59117195635\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/model.js\":\"5fc8dbf9f4315fd3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/settings.js\":\"c03eab4b4f15d37d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/actions.js\":\"789c64ea4855b4de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/index.js\":\"6c6156865aed0c48\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/interactions.js\":\"daa3032df0065589\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/workspace-header/index.js\":\"20207c3dbd300768\",\"/knowledge-medium/pr-preview/pr-1789/src/registerServiceWorker.js\":\"65e6e72ec4f7da2e\",\"/knowledge-medium/pr-preview/pr-1789/src/requestPersistentStorage.js\":\"8471cde0fa071c19\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authRequestDeadline.js\":\"edd82ae7afd5fdb4\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authStorage.js\":\"f9847d33e6b41493\",\"/knowledge-medium/pr-preview/pr-1789/src/services/powersync.js\":\"dfa071c130c13989\",\"/knowledge-medium/pr-preview/pr-1789/src/services/supabase.js\":\"d63465ffa6c0f8ab\",\"/knowledge-medium/pr-preview/pr-1789/src/services/uploadErrorClassifier.js\":\"32bdf2d0f48acd3a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/ActiveContexts.js\":\"cda71fa4caaa4542\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/HotkeyReconciler.js\":\"757a5fff06bd3f45\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/WipeLocalDataDialog.js\":\"47896263062238e2\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionDispatch.js\":\"bf0860054b35bef1\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionRefItems.js\":\"2cd37f9441dd806e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/applyKeybindingOverrides.js\":\"a7f684e04cf5b7e8\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/blockActions.js\":\"e9738e5078dbb8be\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/canonicalizeChord.js\":\"420224cf03ec86b3\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultContexts.js\":\"0882e82b5fcb3bd7\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultShortcuts.js\":\"21024bdefd1dc52f\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/effectiveActions.js\":\"8ae211d0c7f24817\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureAction.js\":\"54eceaac0c733210\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureBinding.js\":\"30b0e4e1e4887dde\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/holdRegistry.js\":\"12033c7b37b3c885\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingConflicts.js\":\"9c4db02b7d272390\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingOverrides.js\":\"c83be5bddddd6a4f\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/pointerAction.js\":\"445e9d543f5a39b6\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/resolve.js\":\"09027002d9113178\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/runAction.js\":\"dd6fb7678c49019a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/sequenceMatcher.js\":\"83f46e7b967ec99a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/types.js\":\"a45157052724b29e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionContext.js\":\"3d0054ba9ee2f607\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionDiscovery.js\":\"83b2171daf5fcba6\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/utils.js\":\"a245e20a6fe0e9d6\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/bootStore.js\":\"74bfe99b99069d67\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/previewDatabases.js\":\"ff056763a5fd4a94\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/byteTransform.js\":\"905e0b1097b09436\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/attachmentCleaner.js\":\"8134493987720713\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/attachmentParts.js\":\"089969fd26a7a8b3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleParts.js\":\"1b2eb4fa96a7bb2c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleRecord.js\":\"16245b861281a7e7\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/manifest.js\":\"66260e5cfda4d805\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/takeBundle.js\":\"e23724f0ca041632\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/verifyBundle.js\":\"5cad9d11a194b8cb\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/cleaningStage.js\":\"9229d793dbe907c3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionKey.js\":\"951f8ddeee56a499\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionServer.js\":\"7224e62960e41633\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flip.js\":\"52414010e984622e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flipAttempts.js\":\"2b9db427aadbb71b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/pages.js\":\"3b939ed4008e8dae\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/preflight.js\":\"51d448ca4d7e0fcc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/reseal.js\":\"d13be36081f3d982\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runConversion.js\":\"462b2534d85fe28d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runLock.js\":\"c5f739a85723585c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealing.js\":\"634405a97372cbe6\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealingStage.js\":\"d35c60015bf01e1c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/stage.js\":\"0592a57c96566f7f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/verifyReseal.js\":\"454d10e6f748dba8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aad.js\":\"f27d7f17d08f34dd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aead.js\":\"fe5874e78b289eba\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base32.js\":\"955d1e29abd483d7\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base64url.js\":\"3d021e72171a2f56\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/binaryEnvelope.js\":\"4b512e9963dee945\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/byteAead.js\":\"0116abd1a5bfb165\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/canary.js\":\"064143362aacfd21\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentHash.js\":\"39214a0063a011b2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentKey.js\":\"d1359de7f3091189\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/derivedIdNamespace.js\":\"97104980a8e5399e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/envelope.js\":\"f475f4d06b2796ab\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/hex.js\":\"4591aa76a78cb0ed\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/sha256Hex.js\":\"c9bcc33c54c7bd30\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/workspaceKey.js\":\"26c2167873147fa8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/conversionState.js\":\"7e4e73ebf7c6fffc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4cb6e5ecb0e6d248\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/pastedKey.js\":\"683f2947e32f1591\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1fed503ba0c22699\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/upgradeWorkspacePin.js\":\"85fe75e2200f0783\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/keyStore.js\":\"07fc83aa150e25a8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/mintWorkspaceKey.js\":\"04ccfcbb012efeca\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/modePin.js\":\"1c5d300d6dcf4e62\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/openWorkspaceKeys.js\":\"6d05727c9e52908d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolveWorkspaceEntry.js\":\"b9f755fbe8a78a8c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolver.js\":\"a2e8c821180ed52c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/workspaceAccess.js\":\"302687830066d2ba\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/transform.js\":\"4042681c69270676\",\"/knowledge-medium/pr-preview/pr-1789/src/themeBootDefaults.js\":\"e7aaa0698bd5c5f9\",\"/knowledge-medium/pr-preview/pr-1789/src/types.js\":\"9d3ffa16863424e0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/ClientLocalSettings.js\":\"31aeb002cf3f5d8d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/abortableSleep.js\":\"754d82bd1e5474ed\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/array.js\":\"ddce3170f2df5b17\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/backlinkAutocomplete.js\":\"ae1b5398466e5ce7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockCrumbs.js\":\"d293b71448cca067\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockrefAutocomplete.js\":\"049e1b8e03736dcf\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/cadencedIdleJob.js\":\"fd5740acd05a4343\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/callbackSet.js\":\"269c9e3d5bac5501\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/clientId.js\":\"fa06520870fdf22f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirror.js\":\"695d1c53fbc65bfd\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirrorCompletion.js\":\"2859b1c430665a1c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/copy.js\":\"97adb0ad73eda948\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dailyPage.js\":\"8acd0090398bf18f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensics.js\":\"0b131f4f8d388394\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensicsHooks.js\":\"d9a5249a47bac6b8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/deleteBlockThroughUi.js\":\"6df17ba2c02c53b6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dialogs.js\":\"ac54486a365efd5f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dom.js\":\"06383aa64bd2842f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/downloadBlob.js\":\"b445fe7efb3ed7e2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/exportSqliteDb.js\":\"227cbdc61eba9552\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fileSystemAccess.js\":\"05eb944da56218f0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/flipSlide.js\":\"fa2652e574420e8d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fnv1a.js\":\"7d358dc1388c92c9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/formatBytes.js\":\"3f3e07c16c03c787\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fuzzyRank.js\":\"15259a56956ec6f5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idbKeyedStore.js\":\"e7b5a082d4eddfa4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idleCallbackPolyfill.js\":\"4009f24b34144802\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardAwareScroll.js\":\"79239726cd523118\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardViewport.js\":\"a56b0f870c3888b9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/lastWorkspace.js\":\"f866a3f204ef4f68\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutColumns.js\":\"9620461d31ebbc38\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionDom.js\":\"f9a4072740b73a86\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionId.js\":\"6e77e20658d6a38c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkClickGestures.js\":\"81922d3822dd6448\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkTargetAutocomplete.js\":\"12030e004b120eea\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbCorruption.js\":\"ddde0af4532ff37a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbRecovery.js\":\"556b97de48e693e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/markdownParser.js\":\"12bf3df63b89c4fa\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/memoize.js\":\"ae67a5995273e07e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameFieldCommit.js\":\"3f065714fd3fcdb9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameList.js\":\"826c75248f00fe80\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/navigation.js\":\"cd5cf99499dce266\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/omnilinerNamespace.js\":\"f180df6f922cf762\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/opfsPageScan.js\":\"bf499bd29f80589d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelClearance.js\":\"21224331ce174cc3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelHistory.js\":\"22b1482f3e3b4a3d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLanes.js\":\"ef4830f2c8e8f406\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLayoutProjection.js\":\"edeca34cce40cbdf\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelScrollAnchor.js\":\"beba289d1c55b967\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelUrlFlags.js\":\"ddb8ead4a1bb8f08\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/platform.js\":\"3c37090667ce74bb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/pluralize.js\":\"a0c2993787527eb9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyCreation.js\":\"e2477d111865d393\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyNavigation.js\":\"95accb3a12c4f3b1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyValueContext.js\":\"52412036805449d7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/react.js\":\"307766a53452a5c3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeDate.js\":\"c6e259dfde43ec91\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeTime.js\":\"603071f7f9d11ab8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/renderScope.js\":\"61fb0b67fe55b3bd\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/resolvedThenable.js\":\"2cbc888816e65784\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/routing.js\":\"74081f165bcb53fe\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/safeMode.js\":\"213b9165a887dca8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/scheduleIdle.js\":\"f13c4ba3d8a26149\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/screenWakeLock.js\":\"61c82d0efe058881\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/selection.js\":\"3876600671a82759\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/softKeyboardGrab.js\":\"1eee31d7a6c3beb9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/startupTimeline.js\":\"d90d55bde1774e11\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/state.js\":\"5ac7d632046acd39\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/string.js\":\"67e0ca763c6caa60\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/surfaceZoom.js\":\"b16b45934d01d55d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/time.js\":\"8fbafa74b1286d08\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toast.js\":\"f15e365a7c33466e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toggleStore.js\":\"9e57318237c6cb33\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/untilStopped.js\":\"bcf4315716339564\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/userActivity.js\":\"fc15862ef225f8a5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewTransition.js\":\"69e53544560f9217\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewport.js\":\"2bc38b0eb03a02ea\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/webLock.js\":\"41db91d0ba89ad4b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceRecovery.js\":\"86f9b5c07183bcab\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceSnapshotStore.js\":\"fc6b1fbd99bd69dd\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-compiler-runtime.js\":\"0cff1b9dd06cb38c\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-client.js\":\"d471f5fc2e89e2a4\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server-edge.js\":\"3d4903a63f63a760\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server.js\":\"905b96f5efdb2bb0\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static-edge.js\":\"52633f33bbf6a1df\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static.js\":\"279dcaa2d9398837\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-test-utils.js\":\"e6a2ae7b24f3d180\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom.js\":\"ff37adfbf97ff56b\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-runtime.js\":\"f0553c2b8f04d9ce\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react.js\":\"3fc3a0765b078a8c\",\"/knowledge-medium/pr-preview/pr-1789/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
