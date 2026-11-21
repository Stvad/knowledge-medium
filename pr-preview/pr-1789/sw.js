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
		buildId: "1cbb1ce36f96-ff4b2be1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/\":\"15fdab01f2b51ca8\",\"/knowledge-medium/pr-preview/pr-1789/index.html\":\"15fdab01f2b51ca8\",\"/knowledge-medium/pr-preview/pr-1789/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1789/assets/FacadeVFS-d-meU7VW.js\":\"feb96d86bea97ea8\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSCoopSyncVFS-DOCNXPTE.js\":\"27dd6ca5f860d57b\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSWriteAheadVFS-BzKWHlPP.js\":\"463234c5410aba64\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-BMA25nbU.js\":\"354886514429fcb3\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-kPYo55fK.js\":\"9ae83449ab2d0344\",\"/knowledge-medium/pr-preview/pr-1789/assets/worker-Dy_qnQht.js\":\"c59d6a5c9bb1e1d5\",\"/knowledge-medium/pr-preview/pr-1789/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1789/chunks/app-Bq-FUq3r.js\":\"a02356cc5a180972\",\"/knowledge-medium/pr-preview/pr-1789/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1789/index.js\":\"110e829c57d07bc6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1789/assets/AccessHandlePoolVFS-DwPvG84U.js\":\"660b29f9c9177a6b\",\"/knowledge-medium/pr-preview/pr-1789/assets/IDBBatchAtomicVFS-ioIc0pd4.js\":\"036bd21c1ba0e321\",\"/knowledge-medium/pr-preview/pr-1789/assets/MemoryVFS-CpOZQGl3.js\":\"6ccab0d635691d0f\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-C7RFgCwx.js\":\"752467c93608624d\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-B-Ch6wmT.js\":\"7706a6c5b62692f7\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/AccessHandlePoolVFS-B6XU2NiG.js\":\"38ed51d3e09b76ab\",\"/knowledge-medium/pr-preview/pr-1789/chunks/FacadeVFS-DfKxr3_y.js\":\"348c72eb53ebabc9\",\"/knowledge-medium/pr-preview/pr-1789/chunks/IDBBatchAtomicVFS-CFFmbgn4.js\":\"a57cecfda7c531a5\",\"/knowledge-medium/pr-preview/pr-1789/chunks/MemoryVFS-CEMS-Jpc.js\":\"118208cd580375ec\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSCoopSyncVFS-DYkJ3CRy.js\":\"a9a783b207276b6b\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSWriteAheadVFS-CnG4jVdB.js\":\"35eb0602cec093a3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/Preview-Dd32loMt.js\":\"34ba55c4eb3fe923\",\"/knowledge-medium/pr-preview/pr-1789/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/card-D_jljdus.js\":\"8362cef8a82572e2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BQmAIfGw.js\":\"f7e5462279357cfe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-Dz1hn0fU.js\":\"b0ab2be8c64b7c5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-async-D5F0ArBL.js\":\"7eecdd4af4d9e5c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BUzDDTQL.js\":\"c2ec5ea6338fef5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CDLvqtcx.js\":\"33eface0507b6452\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CFgYjOyH.js\":\"fd071b6bb1a661c6\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CpGcIuxY.js\":\"144273acd52b2b73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-D6AZA_sb.js\":\"d1132f718bc723cc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-DH-QsEfb.js\":\"7f7b54b1f6679f0b\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-DpHb7AJU.js\":\"fdb819d8b3748a91\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server-legacy.browser.production-B4vKWmJJ.js\":\"f1ac09589e3bdc0c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.browser.production-D_w3xF8B.js\":\"0f37f3d89c50107a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.edge.production-BmHCD094.js\":\"a4405a2079d3a151\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-pmTEtXqJ.js\":\"d2571523ada63da5\",\"/knowledge-medium/pr-preview/pr-1789/chunks/server.browser-BYEkXxgO.js\":\"d6badd96ff1798fb\",\"/knowledge-medium/pr-preview/pr-1789/chunks/textarea-X6nUxnel.js\":\"96b48814601f25fb\",\"/knowledge-medium/pr-preview/pr-1789/chunks/ui-D5AQdrxz.js\":\"20084f516d671d6a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-DF2ZsgOn.js\":\"25c5909413dd88fe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-async-CSXkvVqY.js\":\"623aad82ffdd3ff2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1789/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/src/App.js\":\"7b36242d9839106e\",\"/knowledge-medium/pr-preview/pr-1789/src/appUpdate.js\":\"02acd22293cf3f01\",\"/knowledge-medium/pr-preview/pr-1789/src/appVersion.js\":\"3c435c5d98a37c91\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/initialLayout.js\":\"89962559da4fe9dd\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/openWorkspaceData.js\":\"14d964e1b92b68d4\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/resolveWorkspace.js\":\"4813909107e85eb3\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/workspaceBootstrap.js\":\"4a69ae871b69c364\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockComponent.js\":\"0d38ef14692537dc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockCrumbs.js\":\"ab357cdea36ddc20\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockEditor.js\":\"551e864b9e146cf0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockLoadingPlaceholder.js\":\"7d29efec89fac598\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockProperties.js\":\"c17527d869f99138\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockSearchPicker.js\":\"b33777d5f2be612f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ConfirmBulkDeleteDialog.js\":\"24fa4201942ea427\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DividerHandle.js\":\"e88c042321f487cc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DraftEditor.js\":\"e7cbc6cc2d393183\",\"/knowledge-medium/pr-preview/pr-1789/src/components/GutterPill.js\":\"4b531bf50bda3f51\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Header.js\":\"69fd439c9162ed7d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/LazyBlockComponent.js\":\"453ceddd855a628c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Login.js\":\"4efd612998090a22\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ZoomableSurface.js\":\"1a454d83bfa9b991\",\"/knowledge-medium/pr-preview/pr-1789/src/components/editModeKeepalive.js\":\"26cdc1d0ba84ac7d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8e48558d307ccd67\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a2c5a44314dfad2b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefPropertyEditor.js\":\"c82504926bdf70ed\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefTargetTypePicker.js\":\"baa45aabeb2e85e5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/SelectPropertyEditor.js\":\"ef65496c6d1c8647\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/TypesPropertyEditor.js\":\"eb13a175234b6069\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/defaults.js\":\"36d70cf1adbef0b8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/kernelValuePresets.js\":\"1f78a24ac4d92b29\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/selectablePresets.js\":\"66b74384b4368c21\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/typesPropertyUi.js\":\"20d60904eebb950c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/AddPropertyForm.js\":\"806d2cdf572f329c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyPicker.js\":\"1aef21629d5dca35\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyRow.js\":\"d888464ae8065e12\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/Rows.js\":\"ba7b38b3640fd6f2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/actions.js\":\"16a783b1853cf8ee\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/declarationOnly.js\":\"c1a0d36ef1377d3f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/layout.js\":\"9e303a1942bebee5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/model.js\":\"7ceb5f506308b3af\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapeUi.js\":\"06150b78db9fe91e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapes.js\":\"16d6f72b01fe352e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9caa49883242629d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/visibility.js\":\"9d7b7dfb8bc2a80f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanelSections.js\":\"15863453b7532f2a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockEmbed.js\":\"7de63a4b1501567b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockLink.js\":\"0b03518c6c7f4403\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockRef.js\":\"5656b67027a42385\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/ReferenceLink.js\":\"9e4e37b8a6869f4e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuard.js\":\"62e3fc291c4cb933\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuardContext.js\":\"801887cfbd8926e6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/linkInteraction.js\":\"5a8abe49ecc189bc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/referenceLayout.js\":\"cc61c1b65cb3dfc0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/useBlockRefAncestors.js\":\"b03273ef87173927\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockGutter.js\":\"11beee419d155ecc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockInfoDialog.js\":\"45b659c5b7dd5fcb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockTypeBlockRenderer.js\":\"3efb4df47184f473\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BulletHoverCard.js\":\"015adb4b63d2edb4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorContentRenderer.js\":\"8f8d9cb62609ffe8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d98b19627c68b22a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ColumnResizeHandles.js\":\"f7df13f95e4bc164\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"8371e4e7ef08b4c7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/DefaultBlockRenderer.js\":\"2e4aecd9b125425b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/LayoutRenderer.js\":\"bdfb0e6068e5aac8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MarkdownContentRenderer.js\":\"4d0c90b9ff342cbd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MissingDataRenderer.js\":\"2492020f684af82f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PanelRenderer.js\":\"89b8ff356991b08d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a1fdce483b8d4974\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/TopLevelRenderer.js\":\"68bd70d89f5b8cd8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockGutterMode.js\":\"b0e5312d5a8a191a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockTitleText.js\":\"967283de794b57e5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/fieldCreationKeydown.js\":\"40032ae4c44e69c0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/layoutRootContext.js\":\"8bcc75ad3df0de22\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/TypeChip.js\":\"6d3a7769c975b720\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/chipStyle.js\":\"0e09ff846d939884\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/anchored-floating.js\":\"7ed2fe0199bfec74\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/button.js\":\"31f6779d7d5be3de\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/card.js\":\"24525c840d27e91b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/checkbox.js\":\"72ca40db8df68a0f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/collapsible.js\":\"390788fc057540d8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/command.js\":\"12219e067d989dd4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/context-menu.js\":\"d0d7d39595f4cc85\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dialog.js\":\"6e7b22079625bd8d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dropdown-menu.js\":\"bb7e5344aeea09dd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/floating-listbox.js\":\"7abc4292c707fb03\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/index.js\":\"07910b3a41566e1c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/input.js\":\"2fdc1aabb580522a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/kbd.js\":\"7bd9f9e0159bad17\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/label.js\":\"f80d228728841a97\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/textarea.js\":\"aaf7f017bea9ec4a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/useEditModeYieldKeepalive.js\":\"30b68b976c7a518e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/BootFallback.js\":\"2baad9b0dd5f0d76\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/FocusedRowLazyMount.js\":\"483535b0a9dc71b9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LazyViewportMount.js\":\"97b46b920f55d647\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LocalDbCorruptionFallback.js\":\"afb2d3668d891937\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/error.js\":\"6ff5fecc10311a28\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/lazyMountRegistry.js\":\"552b50d555639f99\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/suspense.js\":\"b1fc021c5fd46d49\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/CreateWorkspaceDialog.js\":\"66275803dfea6ddc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/PendingInvitations.js\":\"afa08b2cbdd5c471\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/SyncProgress.js\":\"167005924e855073\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/UnlockProgress.js\":\"7095a45c4cf17fee\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceKeyGate.js\":\"2bb380f5de5b633e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSettingsDialog.js\":\"48db37415a08adb6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSwitcher.js\":\"d2c7cb272b91a73a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSyncGate.js\":\"22a2b9b944afe648\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlow.js\":\"8950ebe9cb078ed5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlowHost.js\":\"3a30353bb94c415a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/EncryptionSection.js\":\"c2efa3d91a30552c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/attachmentPrompts.js\":\"f4a92a6c79a2543f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2ec7a6182772c715\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowDeps.js\":\"a555a35f7cc2fc96\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowStore.js\":\"816c77dc5d76a611\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/flowUi.js\":\"8b8619043b22a743\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/useConversionRun.js\":\"a413af0a769e4986\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/keyUi.js\":\"e17d3cecbf491b10\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnKeyLoss.js\":\"20eeb6f81409f280\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnServerE2ee.js\":\"7714698e2e0700d0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/workspaceUnlocked.js\":\"4af5ddddbc032a12\",\"/knowledge-medium/pr-preview/pr-1789/src/context/backgroundSubtree.js\":\"de6175186bfefd73\",\"/knowledge-medium/pr-preview/pr-1789/src/context/block.js\":\"4e969239518fd420\",\"/knowledge-medium/pr-preview/pr-1789/src/context/layoutWsContext.js\":\"5a19ab396cd05981\",\"/knowledge-medium/pr-preview/pr-1789/src/context/propertyDisplay.js\":\"a8c65b98766d4785\",\"/knowledge-medium/pr-preview/pr-1789/src/context/repo.js\":\"32127a52d5146797\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasClaim.js\":\"6d7cc026d6697476\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasSeatNamespace.js\":\"d00bc4919c2852f2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockData.js\":\"3999f5eee601d8fa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockType.js\":\"f544df6287e9b260\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/changeScope.js\":\"cd0a8566fd44f326\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/codecs.js\":\"e0e7c6f6dbb42798\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/derivedData.js\":\"d82bcda058d40e29\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/errors.js\":\"ccdeefac7be1fdc8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/events.js\":\"778120dcf90cc2b4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/handle.js\":\"c84a5e857ae87e81\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/index.js\":\"bddc77f94b60afd9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/mutator.js\":\"b500697db64d6d9e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/processor.js\":\"7056113530d020b0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/propertySchema.js\":\"d853cdee3b0add55\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/query.js\":\"c9ff4657d54fda2d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/sameTxProcessor.js\":\"6657f61d317e2e95\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/schema.js\":\"c84a5e857ae87e81\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/tx.js\":\"c84a5e857ae87e81\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/typedBlockQuery.js\":\"4657bf281907588a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/user.js\":\"bccd2932e7c6a3ce\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresetCore.js\":\"01c667ec6723c30c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresets.js\":\"593baa15390037a9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/attachmentCleanerIOVerb.js\":\"d573c3061520e42b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/block.js\":\"30839f90518c66e0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockCache.js\":\"1713c12759bd8e4d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockId.js\":\"f09548b5d864ded9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockLiveness.js\":\"7972596aa98c98bb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockMerge.js\":\"9f772ae0b710502e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockSchema.js\":\"1f51345af928dcb1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockTypes.js\":\"70df3ed2b6c7814a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/clientContext.js\":\"4ba011a20381ee2b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/dbFileSiblings.js\":\"cd9fa131110ac219\",\"/knowledge-medium/pr-preview/pr-1789/src/data/definitionSeeds.js\":\"a4466d41a2860469\",\"/knowledge-medium/pr-preview/pr-1789/src/data/derivedIds.js\":\"7fe7ad35ba22a24f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/drawnSubtree.js\":\"976912c02544985b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facetBridge.js\":\"24e6126ac5484f19\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facets.js\":\"635609b61528e86e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/globalState.js\":\"286897acd13ab3aa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/aliasClaimRederiveProcessor.js\":\"9ae073c36e17bb1c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/ancestorBatch.js\":\"73f35d9960065aa4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/blockTypeTypeifyProcessor.js\":\"7ac555a25ee0fc6f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/clientSchema.js\":\"3200f0781ea1dd57\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/commitPipeline.js\":\"37795fd7dd913eed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/devAssertions.js\":\"7fd34ba83b459cbc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/firstSync.js\":\"4e96ada2ac7ab318\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/freshInitialLoad.js\":\"7ffb298b2cd3ed74\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/graphBackfillClaim.js\":\"671f075877d177cf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/handleStore.js\":\"ed9acae5a3565b20\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/idleMarkerJobs.js\":\"b9c5e945d06bf42a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initialDownload.js\":\"061252596c7aa36d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initializeClientDatabase.js\":\"a6b6fdc35c597d4f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/jsonCanonical.js\":\"3044f1b249ff72fb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelInvalidation.js\":\"4e7d4ded8ed7516a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelProcessors.js\":\"9c5f0ee11747a7a2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelQueries.js\":\"b4e1ff6e0c4f25e3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/mergeTypeMembershipProcessor.js\":\"bd71b8c9c5d174c6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/normalizeReferencesProcessor.js\":\"aba0d0d651453320\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/poolInstrumentation.js\":\"3c3d2617bd355898\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/processorRunner.js\":\"8594dbf4e3320155\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyCellBackfill.js\":\"7f824bf4c96ec999\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildMint.js\":\"9d721cfbf548cf09\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildrenProcessor.js\":\"8405d0ae461350b5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7e0195396ac9a004\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionSynthesis.js\":\"61c7ff51ba3d5339\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyKeyScan.js\":\"3a09fc406f4d6b50\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertySchemaResolution.js\":\"d3f2c440c057c3fc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/raiseProtocol.js\":\"6a12904e24c3cf6e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/readBatch.js\":\"295482feb58c2f57\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/refProjection.js\":\"80e02afa5651e0b3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetLookups.js\":\"76fe6a6c5e413ed2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetProcessor.js\":\"77b8ee88eb97348f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/replayMerge.js\":\"b114b9acdc6fc825\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/sqlBinds.js\":\"515939802cd712cf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5837a21a225e8df8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/arrivalProcessors.js\":\"c67bfc15cd74730e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/invalidate.js\":\"de825d8b167132f7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/materialize.js\":\"26196574e2295265\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/observer.js\":\"68c75673ce6fdf5f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/reconcile.js\":\"4d5f588c46e09d30\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/timingMetrics.js\":\"ea8fc0ec82368e2a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/treeQueries.js\":\"e080dcf69d687a93\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txEngine.js\":\"94194c37f9c6c4f2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txSnapshots.js\":\"dc6a301094772558\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/typedBlockQuery.js\":\"e510a9cc73fb85ab\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/undoManager.js\":\"1488fd5ed03930c5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/invalidation.js\":\"11049c0fa2173738\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelDataExtension.js\":\"726b2ed59bca6215\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelPage.js\":\"c567f11882563a73\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelValuePresetCores.js\":\"b897a01df1a670d5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbCorruptionSignal.js\":\"346e6d4f28a483cf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbStorage.js\":\"0d4acb943e325633\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbVfs.js\":\"433680592e57b78f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localSchema.js\":\"5a153f11e604e21b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/maintenance.js\":\"f21d4995046f3e0b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mergeProperties.js\":\"3bd8a4c0fb4ea4ff\",\"/knowledge-medium/pr-preview/pr-1789/src/data/metricsConsoleHook.js\":\"b391b6738dba3607\",\"/knowledge-medium/pr-preview/pr-1789/src/data/migrationsPage.js\":\"89a0c87956096d14\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mutators.js\":\"6d5d3d144912e6ca\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKey.js\":\"ae4575280ddb76c3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKeyPlacement.js\":\"14d8c95eb73941de\",\"/knowledge-medium/pr-preview/pr-1789/src/data/outlineSurface.js\":\"2525df4c1ba705fa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingEditorContent.js\":\"a3d4bd14a5d9c5a5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingUploadsSql.js\":\"b8471fa1281eb510\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pluginStateExtensions.js\":\"8658d69dfaeceec4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/powerSyncLogger.js\":\"4dd3f1a54048346c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/projectorRuntime.js\":\"fe0effc548d88568\",\"/knowledge-medium/pr-preview/pr-1789/src/data/properties.js\":\"d3ce5c72fe99ed74\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertiesPage.js\":\"f5dd10d23a1ba23d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyChildren.js\":\"94e9670dda689e8e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionFanout.js\":\"58a9af111eb3e1c6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionMetadata.js\":\"36007e9b6b19c9f3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionRegistry.js\":\"0f0861adc9ca1fd6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDisplayMode.js\":\"26f5b702a43ac5b5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyRowCreation.js\":\"67c39435f58cf6fc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySchemaCreation.js\":\"11fdf31017137b9f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySeeds.js\":\"60926dbeb104b80a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/recentsPage.js\":\"fd04f535e36428de\",\"/knowledge-medium/pr-preview/pr-1789/src/data/referenceBlock.js\":\"70711b394f8d8f6a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/releasePowerSyncConnection.js\":\"a390fecdb740fd14\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repo.js\":\"663449ce0065b5f2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repoProvider.js\":\"bab661e6c3e5705b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/rowProperty.js\":\"c6ed23b29922546e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/searchFilter.js\":\"519e005193d39ff9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/seedIdentityLedger.js\":\"f80391b4a0213336\",\"/knowledge-medium/pr-preview/pr-1789/src/data/stateBlocks.js\":\"64a76cad66bbe039\",\"/knowledge-medium/pr-preview/pr-1789/src/data/structuralEditPolicy.js\":\"73f92a32bbbf3912\",\"/knowledge-medium/pr-preview/pr-1789/src/data/subtreeDelete.js\":\"f9fa8e0e4ec4656e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncStreamLock.js\":\"1c0febab5d3493ee\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableSqlRecognizer.js\":\"8242586b48f67cf4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableWriteGuard.js\":\"f2beb03f6feb718e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/targets.js\":\"0ca5afef4ec34502\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeColors.js\":\"465b69b520813da6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionMetadata.js\":\"6ada256a6aea7fc6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionRegistry.js\":\"ed5e24bc47416028\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeExtraction.js\":\"b261045241d8c282\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeInitialValues.js\":\"c9be945a3c53a6a6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typePropertyGroups.js\":\"404c1483bdc82a57\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeSeeds.js\":\"a7b5cc9a69057b2a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeTagger.js\":\"2b2ea6f60cea8586\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typedRecords.js\":\"6ead14f8acaa0fe7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typesPage.js\":\"4f1bd954b0b145c4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userPrefs.js\":\"d0e8bda83630a62a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userSchemasService.js\":\"43d41d9f9c3c2a74\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userTypesService.js\":\"f00eca145a929ecb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/valuePresetRegistry.js\":\"88e4160ab1302a3c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/visibleChildren.js\":\"681cdd5d621723e5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceConversion.js\":\"0fa819d53bae4401\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceFirstSync.js\":\"bd7a60533a6245f2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceIdNamespace.js\":\"f0c1eb640212036a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceSchema.js\":\"c75c7bd79c9ae523\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaces.js\":\"6290d819114ee7e1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadLog.js\":\"36d35753037031c0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/BlockPasteShellDecorator.js\":\"da6502f381eb48ec\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/atTrigger.js\":\"2df0799513aad2cf\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/autocomplete.js\":\"c5ee422b6d1f5f73\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/codeMirrorExtensions.js\":\"729df61e53b60030\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/contentFlush.js\":\"12c901bd22b7d1c0\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/defaultInteractions.js\":\"9957fac9a4d2dfa6\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/editSettleSignal.js\":\"7c4f8b95f84df362\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/insertImage.js\":\"ccbb1f13891697c5\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceCompletionRange.js\":\"ca355f70001f08cf\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceTargetTypes.js\":\"4024f91a672fb0f5\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/syntaxContext.js\":\"7e376a1fda9ad896\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/triggerMatch.js\":\"c8445c96241dcafb\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/AppRuntimeProvider.js\":\"cb7db37b592d29e2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/BlockFocusShellDecorator.js\":\"1e35a70ec78c9c74\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/ExtensionRenderBoundary.js\":\"21c46247c472afcc\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/PanelContentRecovery.js\":\"521fcc317268fda0\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/apiCatalog.js\":\"a94806c84e61c521\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/approveExtensionHere.js\":\"95a890ffb88aa83d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/armedCutAppMount.js\":\"5ba8d67e075318f7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/batchableKeyedStore.js\":\"e9dad4759d58cd01\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockInteraction.js\":\"c500a4e959cbf6f3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockSelectionAction.js\":\"d0a0bd6f27e8447d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compileExtensionModule.js\":\"0d0f5fee4a12d4e7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compiledModuleCache.js\":\"14b886b9e21661ce\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/continuousGestures.js\":\"d8691572194d7464\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/core.js\":\"f235b69fdb128cea\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/defaultRenderers.js\":\"ee4a86e89f0d845b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/definitionFanoutAppMount.js\":\"fb3184ae3c710011\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dialogAppMount.js\":\"b12bf97f459ea8bf\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensionSeeds.js\":\"3d80f9b66b8aa73f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensions.js\":\"f3b8199b59a2d9a0\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/exampleExtensions.js\":\"65c6ebc7427c9ed9\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionApprovalStatus.js\":\"ad9912cbfd713c73\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrorToast.js\":\"378620753871e902\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrors.js\":\"c737ad4029552eb3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLookup.js\":\"cc36f167f0526bbf\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionToggles.js\":\"e74f4f66441fc1f3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionUtilitiesCss.js\":\"fbdea99e101521d4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/kernelPageDeletionGuard.js\":\"2a3d003e2e1fffce\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/liveRuntime.js\":\"d8d15a4bdc2b2666\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/openExtensionsSettings.js\":\"ee87834c7f0a88e9\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/overridesCache.js\":\"9f97805aa48b8d1a\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/pluginIds.js\":\"0c576d548a6fa659\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/processorRejectionToast.js\":\"9d0cf2198f1e8d29\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeActions.js\":\"6ad3bf2c80cea1e7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeContext.js\":\"d50b94fe5de2cd67\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticAppExtensions.js\":\"49db85ff72e7e5b3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticDataExtensions.js\":\"8173da44e000d3e9\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/toastAppMount.js\":\"36a79db8d2c9da6c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useOverrides.js\":\"591cb5220e14ade9\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useShortcutSurfaceActivations.js\":\"22d057a4b307126d\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/discoverToggleTree.js\":\"879d4db38b315ff1\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/facet.js\":\"bf1d1a6c8d1227eb\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/resolveAppRuntime.js\":\"7a2c2e57d3cbdcfe\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/runtimeEvents.js\":\"95c70f08f26f880d\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/togglable.js\":\"4633ecd7e9c13ceb\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/variantFacet.js\":\"6960d7a1c01ac5f9\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/verbFacet.js\":\"fe9a9399e3c8bcf9\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/block.js\":\"971ee4e4621e0cbb\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/focusedChild.js\":\"b7b1ce3e0e32a196\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/propertySchemas.js\":\"1bfaaaaf4624eff0\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/typeRegistry.js\":\"7d9f851ee26a0846\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAncestorCrumbs.js\":\"ad53c81e57baf033\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAutocompleteListbox.js\":\"c1199e245c29155d\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedSearch.js\":\"e3a1b23c4e658bed\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedValue.js\":\"a40eceae3515fb12\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsFocalRender.js\":\"b50a30ad722b8944\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsReadOnly.js\":\"8d0c2f601149b0be\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMaterializeBacklog.js\":\"f76b3f2c59c3ec2f\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMinuteClock.js\":\"9dd76c784f71ed13\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePanelLayoutProjection.js\":\"7fae24f7839d89bc\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePendingInvitations.js\":\"6c2b9885f758e35e\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRendererRegistry.js\":\"55b9c76ceee3474b\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRetainedFieldRows.js\":\"fcb036d434265f41\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useWorkspaces.js\":\"c374778c25dee046\",\"/knowledge-medium/pr-preview/pr-1789/src/lib/utils.js\":\"d55b04ed65270255\",\"/knowledge-medium/pr-preview/pr-1789/src/main.js\":\"cac5bb24aeb6a51d\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/MarkdownImage.js\":\"644039b930b3e8b5\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/blockSeparators.js\":\"12a9d571cd1cd039\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/context.js\":\"c293ee8d54d31e07\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/defaultMarkdownExtension.js\":\"42e306664c52fd3c\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/extensions.js\":\"33906641c2476b04\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/renderMarkdownHtml.js\":\"854ae0373c1de2ad\",\"/knowledge-medium/pr-preview/pr-1789/src/minimal-editor.js\":\"20b14dc9d5b67a92\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/armedCut.js\":\"909aa7597e31bb0f\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/captureMediaVerb.js\":\"40a2809d0f62f611\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/clipboard.js\":\"9d8045c5a91af37c\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/decision.js\":\"d359273dffafe126\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/operations.js\":\"8c1a15568bc30139\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/AccountHeaderItem.js\":\"5fe16ef9aa64cce2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/index.js\":\"a58eacd7d7c4c044\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7f0d97f28788928e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askAgent.js\":\"3f07d8ac03cad46d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askedStore.js\":\"f4496a3fa946e56d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"55c348808673a580\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/chipState.js\":\"866eb6414ba8f12f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4fdc070c3c51d3d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/index.js\":\"fda77f41ee915df4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5057b2b2a9414760\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/schema.js\":\"a4c1e63f3a9d5cbd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/AgentTokensDialog.js\":\"212dd6a5b404d84c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2ed0ab4820a59f75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/addMedia.js\":\"187daf07b99b1640\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b35516a5d1073a5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/block.js\":\"e5dc74e52c32db6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/context.js\":\"ff17b0426ff500fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a48eaa00f4d01082\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/index.js\":\"0e7d3eca2fcf7186\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/outline.js\":\"fec1fce27a2bc095\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/properties.js\":\"f0ad8d4a383fdeb3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/refs.js\":\"bb1ef3fd542964c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"025e8b95e8928c73\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/search.js\":\"19bd27462bb10e49\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/shared.js\":\"8cfea5ce4779cbfc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d758f0cb17306918\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/text.js\":\"bed78dfcf1bf072c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentWrites.js\":\"8b00cd0061fd63cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/authoringCatalog.js\":\"16ed006d21119ec2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/blockRefTargets.js\":\"0c78484c87650633\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridge.js\":\"32e78e8f2635ad58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridgeLoop.js\":\"32aa4925874a3196\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/changeHistory.js\":\"60f983cca43616f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commands.js\":\"2a8ee6d9a2cd9df2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commentsCommands.js\":\"54c245ac2e1718d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataExtension.js\":\"d02e3f5d8345cff6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataModelGuide.js\":\"44fa58ba76b20e88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/describeRuntime.js\":\"67c205f89807c8c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/extensionLint.js\":\"696d907d3beb5f61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/grainAudit.js\":\"c58d8229289f97dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/healthCommand.js\":\"0b112945dbbaf9cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/index.js\":\"21bc562a5162fe60\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/presetIdentity.js\":\"a9bf4e978918f93f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"bbafcb7e43dbcaf3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/readMedia.js\":\"fa730eeb925c13e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/schema.js\":\"474244e4c82c8b37\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/serialization.js\":\"4ffe2fbb3c56e62e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/targets.js\":\"d46fcba44be096fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/tokens.js\":\"c808042d344bb88c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/watchEvents.js\":\"aa8570f2e07a6ace\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/workspaceGuard.js\":\"255736ab5375cc0b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/writeCommands.js\":\"952ad868ab819012\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/AliasCollisionToast.js\":\"862d2f3524461420\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/DuplicateNameBanner.js\":\"38ea17814d3b3e44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/collisionMerge.js\":\"cbb3c724ec150b8a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/dataExtension.js\":\"7d7e66afd3714f41\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/index.js\":\"4c5ee5a8b17e0f5d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/mergeCollisionAction.js\":\"13a9a0e17d44c900\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/pageStyling.js\":\"9c88e1f671feb8b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/rejectionToast.js\":\"53edf7c3af3214d5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/syncProcessor.js\":\"a26ff092ee018069\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/actions.js\":\"a158accf870645bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/addComment.js\":\"e5a75d1345e615cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchor.js\":\"4688f0333c82c110\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchorState.js\":\"b6042fe8c6195b5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/commentLinks.js\":\"480da220c2e09393\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/confirmThreadDeletion.js\":\"daa16014c84f466a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/container.js\":\"ea85ebe2f47c8137\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/dataExtension.js\":\"804f42fe7db16d2a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/deleteComment.js\":\"5a5a9da2765230fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/highlights.js\":\"d972a92ff300ba6d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/index.js\":\"3e57559506af22fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/linkedCommentsPill.js\":\"a0a3d4d2a136cd53\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/margin.js\":\"36c64d227bdb858f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/marginSchema.js\":\"e456bee76b6089da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/newComment.js\":\"6f55e93efd0aa6f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ownThreadPicker.js\":\"c7a4b9635b57561a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/placement.js\":\"d200b4aff09ab28a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/queries.js\":\"8b97f19ca02d51ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotePosition.js\":\"bd6e99c4bbacb4ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedIn.js\":\"e76fdfbc859c9f3e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedRange.js\":\"5349cf609411d687\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/rangeRefs.js\":\"d19ae75258232156\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readHighlights.js\":\"7777390659bed455\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelection.js\":\"348149a3436d5a69\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelectionUi.js\":\"a7f0cde8f3979873\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/reanchor.js\":\"398a32ef9d950ca7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/schema.js\":\"58e5f6d9b28b6a7f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scope.js\":\"bb042c47c64aa4d8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scopeThreads.js\":\"fcfc3fa1f697c587\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/splitRetarget.js\":\"e0b565cd3b48a0ce\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestionCard.js\":\"1a585b949fcf1adf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestions.js\":\"66e146f955c400d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaries.js\":\"a8e30141c49dcca6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaryBatch.js\":\"41b0b11c00e82c6e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/surface.js\":\"a0a22aa32b4e468e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threadNavigation.js\":\"382b2a7a71c56e1d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threads.js\":\"8e5a0beea3b01a83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ui.js\":\"802e06ec4d8bdcba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/uiStore.js\":\"e3a5abd80176f896\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/appIntents.js\":\"fed5064f11ee6b27\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/index.js\":\"d8f1e97e11ce0140\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/index.js\":\"eaf73de3173b4c6e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/status.js\":\"5cb062898a189c32\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"099b8f921c9ec3af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaBlockRenderer.js\":\"186adecf8ff2d8b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c87121efb8f8823b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaUploadReconciler.js\":\"cbdcae9daecc49c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetDownLane.js\":\"89c243569346788f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetResolver.js\":\"2d89fef1d8b50399\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetUpload.js\":\"7581c59b6e2dec83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/attachmentCleanerIO.js\":\"33d09d6f344cb6db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/supabaseAuditIO.js\":\"63d0bb715e585497\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/blobStore.js\":\"3f9d107aee5a3eaa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/byteStore.js\":\"e1fef03eb53efc18\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanerIO.js\":\"656977589ce401ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanupAttachments.js\":\"d2cea1fc1bcca0f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/dataExtension.js\":\"05466dcb18bd6b64\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/downLane.js\":\"29cf4ab47119db3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/index.js\":\"60182ed2fe3f8fb0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/insertImageContribution.js\":\"7e340cb34e34c552\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneArming.js\":\"385ed4e0fdb6e9a4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneLock.js\":\"ff622ffe1de1e17a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaBlock.js\":\"47fd06dcb5f68674\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaCapture.js\":\"c0b3149665a3d581\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewers.js\":\"700566fe11aa7a89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewersFacet.js\":\"8516bad874c51aa4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/pasteCapture.js\":\"ab1fdf226c76564e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/resolver.js\":\"63ad694aec33b988\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/retryUploadsAction.js\":\"2349135e79ce8e8a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/storagePaths.js\":\"ceb15941ed0f075a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadDrain.js\":\"48fd024c4835291f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadLaneStatus.js\":\"c1f7ed389b1a36de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadReconcile.js\":\"b5b59baec237af31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadRecovery.js\":\"a294910883a8de61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadStore.js\":\"99559987f5099027\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/useAssetObjectUrl.js\":\"8671ad2b0ed64505\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4a842966e9c65085\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7423a0e547ffcf58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/facet.js\":\"4d6a635ec407ce08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/index.js\":\"de0f076bfc2a3d46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/prop.js\":\"a8bf3a5db42453da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinkFilters.js\":\"a6cc7b3555066434\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"232b87a0b06e6c5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BlockEntry.js\":\"2e44a7d208602cd5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/LinkedReferences.js\":\"93d59e0e289f36b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e2742655134f1a84\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dailyNoteDefaults.js\":\"43e28a4f270817ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dataExtension.js\":\"6c41cbd78d7fb1d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/edgeExclusions.js\":\"fc2271f58826a117\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/filterProperty.js\":\"0d6edda9034dde6e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/index.js\":\"c79a4dfed215876e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a8acd0a22cfb50d4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/applies.js\":\"834efc32e9ab4d57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/countQuery.js\":\"c71dace0beeee366\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b2c7f265ce482eba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/index.js\":\"09b999ac5b201d21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a40501c034666d29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/presentationInvalidation.js\":\"45c5b8740f831318\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyEditorOverride.js\":\"d51d10a0aeb03330\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyFilter.js\":\"09c086bb33b8ce97\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/query.js\":\"1768b1af19b07dc5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/resolveFilter.js\":\"1365ef51c835c48e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sourceBatch.js\":\"6ee28f9bd2ef817d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sources.js\":\"9118591cb7603c3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useBacklinks.js\":\"00053968e9866fc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2810ad72cb2f06d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayCelebration.js\":\"d098f20a03c45b5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayOverlay.js\":\"f7f94663c6091a83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/gate.js\":\"ebd1c1b500075a40\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/index.js\":\"d5701c8e7a72da37\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/wolfTheme.js\":\"97b407891eeda8e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/BlockDragLayer.js\":\"abd81404499af39f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dragController.js\":\"10db1f801ba8156d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dropTarget.js\":\"565773231da0e522\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/index.js\":\"be477b28530c70ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/projection.js\":\"3981525034cf4ec0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/BlockMetaCard.js\":\"0c2cc86ae66065c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/index.js\":\"2d8ea94b27d88a9c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/AddTagDialog.js\":\"61a4a13fba3880ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a88edef6d27b8a57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/TagNameIssueHint.js\":\"666f2cce6dfee111\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/addTagAction.js\":\"7fb710e2f8596aaa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/appendTag.js\":\"288e29fe1ee29b22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/config.js\":\"69c54a028624888f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/dataExtension.js\":\"3782f451185939dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/index.js\":\"7eb3691f2a19e704\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/propertyEditorOverride.js\":\"4f3b45cd16c0f983\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3ace478b09030431\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"de64a153818cfd33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3b7504585a81b8a4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b5591f14432d1934\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"264178b1e3608ce4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/index.js\":\"71e31fe40e5aa0f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"70b7e26c3f2f4df0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/CharacterCountItem.js\":\"5c73920977695a4f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/ProfilePropertyEditor.js\":\"213d39f889afeda1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/actions.js\":\"1c6fce0554cd7008\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/blockType.js\":\"ad7e8007f27ad4f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/charCount.js\":\"2bb7a8d60a134c5d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/dataExtension.js\":\"866c17e394c3798b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/index.js\":\"51efd1f1749ca369\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/profiles.js\":\"a20595f52b41fa84\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/properties.js\":\"0218e499bd85eb2b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/textCounts.js\":\"621dc5a38207ed86\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/colemak-keybindings/index.js\":\"27137ae967ae1bba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/CommandPalette.js\":\"03372f4cbdeb1c7a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/HeaderItem.js\":\"e4f7ace4214c9104\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/context.js\":\"8a46a6b2b173c198\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/index.js\":\"743234f077d7bbb1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/selection.js\":\"8df35db31dd2e94f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/toggleStore.js\":\"1736be61ff1f6cd0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/useCommandPaletteActions.js\":\"cdbfddf2dc69aab6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/ContributorBadges.js\":\"6e8e8c463705782f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/author.js\":\"869596fac7d76b9f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/codeMirrorExtensions.js\":\"3b065af215cfe810\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/dataExtension.js\":\"abaf26c39487666c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/index.js\":\"d688f6148f1ce4a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/mentionAutocomplete.js\":\"73ca63c29fa1bead\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/processor.js\":\"be37e93270f1b230\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/profiles.js\":\"46292a3e519feb29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/queries.js\":\"fd003db50a25cd11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/schema.js\":\"3b1efea86d764b11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8ac40b3dbebce32d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8e89fc3ad8709860\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/index.js\":\"fc9f1b112b2d9123\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6b2fcb765224e6a2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cacfa312860f680f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/CalendarGrid.js\":\"9c499b33e1fe7341\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DailyNotePicker.js\":\"e235357a8743bfa3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c972fa475484d4eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateNavDecorator.js\":\"76cfe0e327ba3444\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateScrubOverlay.js\":\"54eed5dec0221338\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/HeaderItem.js\":\"e1804ca7cd954eb0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/ReschedulePicker.js\":\"9b9cc85ed3d1604e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4288b660bdb1c06d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/actions.js\":\"a67dda8c6f255d74\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/blockDateAdapter.js\":\"61e5bc1d6c74047d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/calendar.js\":\"4ae2605c3d2f4745\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dailyNotes.js\":\"5045ca6bbc9d8c36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dataExtension.js\":\"f8ea64881400785c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubActions.js\":\"bdb951406a956732\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGesture.js\":\"516b4e86f40a85d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGestureActions.js\":\"de86e3badc328ee8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0ec83afea33fa24a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/deletionGuard.js\":\"d120e5149393d401\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dueQuery.js\":\"dc816106250b26c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/index.js\":\"e0031af886942161\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/landing.js\":\"8e1b6abb5b99ff0e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/localSchema.js\":\"22d2ec49259b12d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/referenceDateAdapter.js\":\"265191758b88a125\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/rescheduleAction.js\":\"62888af1ab8cacca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/schema.js\":\"319448dbd4b47353\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadBlockDates.js\":\"b366d35c61a4cd91\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadDatesAction.js\":\"4342adddc4251422\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/today.js\":\"cf4d69d81ae1648c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c80a7fc9183103d5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c4d3256bf332ff03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/audit.js\":\"8298ac47f550aee9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditAction.js\":\"ae1ab4ce3f01a359\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditRanges.js\":\"b136d8c651d6f135\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/diagnosticsSource.js\":\"63d60c5db8241c4e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/divergenceScan.js\":\"3c4e412fb79bdeec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/index.js\":\"9114f3c5dd656035\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9302cf93f0b32561\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/referencesMirror.js\":\"5e948c2b90778d99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/rowJson.js\":\"1c7dc96734ae773b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/schedule.js\":\"add7b9d4f6c495db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/store.js\":\"cac1047576bcce82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/action.js\":\"5a5fa8ce7139b94c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/index.js\":\"d59fd82dd13eb97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/plugin.js\":\"663bcb5fd814140f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0021805c7e58a4c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/actions.js\":\"1e06660c6cbc5c66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/changeMarker.js\":\"f43170c8b791e675\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/diagnostics.js\":\"d6d99cea14020a0a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/fileSystemAccess.js\":\"056caea7a969bbf4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/filenames.js\":\"58432444e7dc9859\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/index.js\":\"1cbd690ead8c48a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/mirror.js\":\"83472cbf5731fab0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runLock.js\":\"eaea484e62e624d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runtimeHealth.js\":\"cf46c470b7fc117c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/schedule.js\":\"0c12395e7719b46f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/store.js\":\"bb880b2568250104\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/index.js\":\"a7f059b32e8074e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/themes.js\":\"0a4e0a386492f042\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/facet.js\":\"cae4ccbbba2a1c7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/useDiagnostics.js\":\"43ec18b6c33217ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/dismissals.js\":\"b67e5dd100c83bcb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/index.js\":\"e39292f27ffe0886\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/status.js\":\"fcc74a73f19f9a35\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/store.js\":\"a3c2080edd50f7d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"06935edc78225eb4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e500d812982ad0a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/actions.js\":\"d2300605b2681652\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/config.js\":\"a45ec5a32cbd829c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/dataExtension.js\":\"d32df087b9277e9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/effect.js\":\"529a59c2a154d208\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/index.js\":\"772a997492153a0e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/propertyEditorOverride.js\":\"034bad7b535e7b58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/useToggleTree.js\":\"070be1edcde84e56\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/ExtractTypeDialog.js\":\"b132ef83255a11e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7e53c7a1442dcff8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/PropertyShapePicker.js\":\"c205989e2f90edb9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/action.js\":\"1b2f3cef86cda248\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/index.js\":\"b7a4e71589b5a01c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/FindReplaceDialog.js\":\"6c91aad2b1c5d108\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/HeaderItem.js\":\"b49af1659ab4272e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/dataExtension.js\":\"d715329a4e7bc728\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/index.js\":\"6227bdbfe0f22d34\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/search.js\":\"776324e383d0019c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/toggleStore.js\":\"18b94e4e8f1450b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/LocationPropertyEditor.js\":\"b1cb0194cd5daf71\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/MapView.js\":\"3491cff53286f494\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/blockTypes.js\":\"41d1ae302ea2f8ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/codeMirrorExtensions.js\":\"eb7d97601d18974d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/createOrFindPlace.js\":\"95e2ae16faf9406e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/currentLocation.js\":\"8a4efb89d09957ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/dataExtension.js\":\"c805b43d3c307f6d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/geoContentDecorator.js\":\"049bcffa1bf836c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/googlePlacesClient.js\":\"fad99861041764be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/index.js\":\"22282a53868a7521\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/locationsPage.js\":\"76ae7d844b8355de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/mapViewport.js\":\"3874f8bfe74da424\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/pickCurrentLocation.js\":\"1877225723331b3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeAutocomplete.js\":\"7b5abcb96bc0d0ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeNameCollision.js\":\"4fb22aecfc704647\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/properties.js\":\"dd41aab865680b2f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/propertyEditorOverrides.js\":\"5b1d2513d505c046\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/query.js\":\"a830978f880cf7b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/usePlaceSearch.js\":\"f24dd5fbb5b5b827\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"813029e558e0bfd4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"955b7fada240576c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"620521885099f1a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/config.js\":\"1e5e0760c9edf705\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/dataExtension.js\":\"a68e90a7b7e1e322\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/facet.js\":\"ea6fe0900c0d05fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/grouping.js\":\"d1e9be5d9689ec63\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/index.js\":\"51502a48aad4cb6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fc7b74251df57109\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/query.js\":\"8e46af79aa15ace5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/resolveConfig.js\":\"1733c99dcd692423\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"05787019624610ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3af552216370c3ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlDocumentContent.js\":\"9fb29d6028545e36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlFrame.js\":\"1104bf438937f640\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/actions.js\":\"9f98c1d44835392a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/blockType.js\":\"72257d543252147b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/confirmRunScripts.js\":\"82a7574914825a45\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/dataExtension.js\":\"e0c963dabf7bc8bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameAnnotations.js\":\"f9aa100cc7c8ba11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameDocument.js\":\"e7df0fed99a7411c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameTheme.js\":\"921ccf11f687de99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/index.js\":\"f273e10b5b207a52\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/scriptConsent.js\":\"3a79248a4bc7872e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/sourceMap.js\":\"f51ffd249efd5c2c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/useDocumentScripts.js\":\"56c3f9e4adfb858c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/index.js\":\"68e69a1535603d39\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/record.js\":\"f26473fce07f4b1f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/recordStore.js\":\"90fe0e5e6e62b49f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/responsiveness.js\":\"1d69daac13619892\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/schedule.js\":\"4d98fa04879d2c28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/sessionContext.js\":\"475b272bfe5d826c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1cd89b03f667ae8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8fcab570f38ff0c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/actions.js\":\"75a376699ff5af9a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/config.js\":\"6f23dc9473ad0a86\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/dataExtension.js\":\"48647f63a263de67\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/effect.js\":\"4dc33f0a80eb28fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/index.js\":\"4c5e9cb5d30890d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/keyCapture.js\":\"f20c3d063a50be81\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/overrideStore.js\":\"9559dd923e396681\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0038c8975157a29b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/HeaderItem.js\":\"a4becbff80772e17\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/LeftSidebar.js\":\"82c48eade36deacc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/actions.js\":\"3be8ce82c7306b5d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/facet.js\":\"09ba65a7268d4009\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/index.js\":\"cf8e8f7e5326fe6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/shortcuts.js\":\"5483afbb4c27ac66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/toggleStore.js\":\"2882419f06aaa126\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/MergePicker.js\":\"652a7fd443e83a9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/index.js\":\"07d04f85e1012b68\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/mergeAction.js\":\"a58f895589fb1bfc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/strategy.js\":\"b0f7186c59917805\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/Button.js\":\"c2ee97bbf559015c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"fed4cbdb91eff1b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/defaultItems.js\":\"767286ce0249039b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/facet.js\":\"e522116b2d9212eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/index.js\":\"c6c3b4ee4d90a062\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4c95b99913ffc6e4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d69cbe723cfdc7b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"47cf50f3bc1e7c79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/facet.js\":\"97bfe796a6a24fe1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/index.js\":\"9b86aec3332643e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/MoveDestinationPicker.js\":\"11c03126ce5e611b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4b6ce7cc8b5c9861\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/contextMenuItem.js\":\"3f2c7297d46a1f1e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/index.js\":\"cf26db6e23a2b7f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveAction.js\":\"4ca876daad9202ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveBlocks.js\":\"00d835bc2fb4da81\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/selectionAfterMove.js\":\"359367b9d50bf3a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/TutorialBanner.js\":\"f4ae17980937490c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/action.js\":\"43757b522b7bb0b5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/bannerDismissal.js\":\"4bb9450fdafe6545\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/documents/cheatSheet.js\":\"e23e084f36065620\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/index.js\":\"d68c4694e4630da1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/keys.js\":\"b1b98ec7718b1724\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/landing.js\":\"d56109ea97c8260c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/outline.js\":\"e687e6f8b3a023bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/seed.js\":\"186245a7377c5384\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2275bc0cee4e4700\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/analyze.js\":\"1b99ca4d5b4961f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/diagnosticsSource.js\":\"41961131ed7bb8d4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/index.js\":\"1ce868de14cb6ff3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/load.js\":\"c47a1a45b9ab7185\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/monitorRun.js\":\"3a95038051f45e10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/schedule.js\":\"0a47c3178bb99258\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/series.js\":\"75d60813833fea35\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/store.js\":\"b52c7356f84dda17\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/trendAction.js\":\"742bda46658a05b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/verdict.js\":\"d015700251b7fea1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/clickToEditAction.js\":\"b9e63a844f84fdae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/index.js\":\"ad1aed54e9f722dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/interactions.js\":\"c77dbae93243470d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a3b076a421a959c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGate.js\":\"ddb0f728bc04480c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGateDialog.js\":\"39001385899374e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/action.js\":\"4f18a45d4897d701\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/index.js\":\"6f74d0270d8840fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/localRunMessage.js\":\"77316da6a52aaa31\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/plugin.js\":\"142d5b62feb052f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/progressReport.js\":\"5224172f4f3d4af5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/sweepProgress.js\":\"9fd7d3ca6797e786\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/FieldRowRenderer.js\":\"a8a5c75ad6311118\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/ValueRowRenderer.js\":\"18de8187d73163de\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/actions.js\":\"7056a542833a9523\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/autocomplete.js\":\"44222272d1bd746d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/fieldRow.js\":\"dc9dc2010e197866\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/index.js\":\"b3c1a738505c35cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/referenceWarning.js\":\"872460d502f59853\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueAutocomplete.js\":\"dbee038c7c6a2880\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueSchema.js\":\"ee6e31a003583494\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/HeaderItem.js\":\"4625755ce3444074\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/QuickFind.js\":\"c80ae3b27478ebb0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/index.js\":\"a84c87f5f260dd32\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/recents.js\":\"0c97dc0fa790553a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/resultItems.js\":\"305c122b71ed3515\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/selection.js\":\"3288c15aa6c0b3e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/toggleStore.js\":\"4c9347e2f0b720f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/HeaderItem.js\":\"50921a6bf4960488\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1a1e678fb44966c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/grouping.js\":\"e24ad7f7a47b1243\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/index.js\":\"5b9beacac696cc8d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/target.js\":\"3432fe710f8e3173\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/codeMirrorExtensions.js\":\"966afe1bf45f9038\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/contentPrefill.js\":\"567f7d7f031f9b0e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/dataExtension.js\":\"7a5b4a1ebf301bd9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/index.js\":\"e097bc0285acf979\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5dae1bafe9689a40\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/invalidation.js\":\"488d5310aa2d941c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/localSchema.js\":\"108e5538c4067b92\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/index.js\":\"c006800b2fcc1320\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"aad0a2c058293a4f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/index.js\":\"8ba5aae826ae7294\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/referenceNode.js\":\"010830472f7aae99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/remark-reference-occurrences.js\":\"71c31a87d846f94b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"72e9a58c3f821200\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/index.js\":\"f62e1adbf5f24bc6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1eccefd803ae4e29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9c458c451cf27afe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/mergeRetargetProcessor.js\":\"22c138bc37de688f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/parseFence.js\":\"0b41bcd5e8099cf0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceParser.js\":\"57fac8865b71f08a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceProjection.js\":\"ff77b2f3b42469a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referencesProcessor.js\":\"ab0f5988e9b361da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/renameProcessor.js\":\"0871d8897733c778\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/spanReplacement.js\":\"83ab8e190fce11be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/htmlToOutline.js\":\"d40b8298a7a022f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/index.js\":\"1f238f28699b9784\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9e529362509f8cb4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/pasteDecision.js\":\"43659d9db4c51400\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/action.js\":\"2239786884226bb0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/blockIds.js\":\"755e630283e43ab7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/content.js\":\"7f9a4faf4c7224b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/effect.js\":\"fe484f5765e98319\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/ids.js\":\"adcce68e702a2ca8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/import.js\":\"e890a6c9fe24afd4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/index.js\":\"cc6113e2ed597adb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plan.js\":\"5025cc8b2e01d5bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plugin.js\":\"95064f8a7475f57f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/promotion.js\":\"0113971b809172bc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/properties.js\":\"8058680f8c94af21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/references.js\":\"ae853f8cc610798a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/report.js\":\"10cb74300713734c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/roamMemo.js\":\"9355a340ad62e1e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/runtime.js\":\"46e945719960c5ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/schemaReconciliation.js\":\"6cab7519ad6f9ea7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/srsMarkers.js\":\"45b5289e358ddc36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/todo.js\":\"ad406cea233e5497\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/typeCandidates.js\":\"b7c25b5bb62b0448\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/types.js\":\"d68818f8d86bd6fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/index.js\":\"7bb0b6d05349de5d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/store.js\":\"68ddb51e72d1f935\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/HeaderItem.js\":\"95b0c40402d78aa2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"759c8fa94b8fd26e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/index.js\":\"c58a1f3aff7518f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/model.js\":\"8279decba68347c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/toggleStore.js\":\"d8b7a41532b401fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/useKeyInspector.js\":\"68e1b947a984c5f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bd0b1c7d8299e9b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/ShellDecorator.js\":\"0deca1b38f8d0336\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/actions.js\":\"3dbeb9d4b0c71d4d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fd1bc713b53d54ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/index.js\":\"fe645d285b60de9f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/shell.js\":\"b60f7ddc0d5d34a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/surface.js\":\"e29f452b34c2c7bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/walker.js\":\"6e7149c7dae40afa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a20b7fbb171f1af1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/dataExtension.js\":\"b0be61dee391430d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/index.js\":\"0864fc47d28b2a98\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/indicator.js\":\"39984409359cd1b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/moveSrsState.js\":\"d5584f339f4d128a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9d55e2761d58e8c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/scheduler.js\":\"922d4a2c1655320c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/schema.js\":\"cea42b57a52cca7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"60b2c454967e299d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsClipboard.js\":\"d60ad8700293d30d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f4d8fd93cc9625f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ced22294286f5013\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DeckPicker.js\":\"d5cdb6001ad88ba1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewControls.js\":\"2f14a168b4831e99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8d9edeeaa8b89cf3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewSession.js\":\"ef3b2ecf4e332cea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/actions.js\":\"db8248b0944d26fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/archive.js\":\"faa9a6287ddcc6d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dataExtension.js\":\"bd985b24f6481a16\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/deck.js\":\"58698a4b0999d2f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dueQuery.js\":\"c84c95c88da5b74f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/gradeDecision.js\":\"e10521b09d35b9a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/index.js\":\"afc9914b585ff54a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/keyHints.js\":\"f471759edd465fa6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewCardLayout.js\":\"08faee3f9d8bef80\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewProgress.js\":\"ab0cf4de00d23341\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/schema.js\":\"1f98dd8ea12ab0be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/useDueCards.js\":\"898e207af7f3c618\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/index.js\":\"0665a375e80d869e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/record.js\":\"43465da733e0b9d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/index.js\":\"7b8a224a195840bc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/persistenceStatus.js\":\"684c69b276e06177\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/requestAction.js\":\"4eacfb932273a759\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/TypeChipsDecorator.js\":\"ea01bc3327f7c741\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/codeMirrorExtensions.js\":\"37cab47ddbc5ee3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/index.js\":\"09fb8523e6a36324\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/typeAutocomplete.js\":\"54760a53b1ca3447\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c3d8830be6104622\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/actions.js\":\"77bb7b5b9ee443ea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/anchor.js\":\"ac1f799bd3192e85\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/events.js\":\"7bf379faa7e47f57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/gestureActions.js\":\"69d7a94a023929b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/index.js\":\"e3680d8f19b12385\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a4018e010e55f01f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/collect.js\":\"f1930e7d23e1f2e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/index.js\":\"ec27049eff3e3514\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/record.js\":\"943c60c7a43da6e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/RejectionDialog.js\":\"5af92c9b982813a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/SystemStatusHeaderItem.js\":\"db339b72fa9c0cf1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/index.js\":\"31a6c4ad615c16d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/model.js\":\"bfd6c7a01d737466\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/queueCounts.js\":\"176ae7dd27fc34a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rejectedHelpers.js\":\"cd6814cbc4647309\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rematerializeAction.js\":\"b5019e4830db54bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/useHysteresis.js\":\"cb71e19804f1707c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/effect.js\":\"1ed3b78c32a99771\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/index.js\":\"b096abd098a087ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/theme.js\":\"ff08820d17275420\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/actions.js\":\"85be884b40b3876b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/dataExtension.js\":\"109f4f3f3d6237f1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/index.js\":\"a914ce4a625d64a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/schema.js\":\"31a872ed54ab7e75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f4dfd1ee957f0958\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/actions.js\":\"adfffb5db3e78264\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/defaultItems.js\":\"806783a6ae3032f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/facet.js\":\"d9533ede7075e472\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/holdRecognizer.js\":\"26a42a591d0b46cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/index.js\":\"bc12836a1e09678b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/UpdateIndicator.js\":\"13b09d0a9cb3c41e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/index.js\":\"80c1d5660e335261\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/loadTimes.js\":\"76d57666fcd96021\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoNotesRenderer.js\":\"12ee762505f28227\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoPlayerRenderer.js\":\"4ce434d40a2cadd8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoTimeStamp.js\":\"5b6a48d9716e003e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/actions.js\":\"fd33c0c3d26aec51\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/index.js\":\"ce8fbe1ca4fb8ac4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/markdown.js\":\"bafc4249ea47a34f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/notes.js\":\"b983e032a184795b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/registry.js\":\"dc83eb7b6856e977\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/remark-timestamps.js\":\"487fef28dac87f56\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/view.js\":\"6320e7677cf4b1e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/LinkHints.js\":\"5c9adc6c19430d5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/index.js\":\"05e3fabc1b29307e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/model.js\":\"e2b942dea3b8e04b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/settings.js\":\"bd7fb2d477a3ab69\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/actions.js\":\"77b84fc85ed10505\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/index.js\":\"7d74aeb4017afd12\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/interactions.js\":\"c82aa9a7b450b679\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/workspace-header/index.js\":\"dac67d3a2f3ad392\",\"/knowledge-medium/pr-preview/pr-1789/src/registerServiceWorker.js\":\"7519c0583c91435c\",\"/knowledge-medium/pr-preview/pr-1789/src/requestPersistentStorage.js\":\"da1bd750fb411444\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authRequestDeadline.js\":\"88c712440105cd05\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authStorage.js\":\"a7491db567cec5d7\",\"/knowledge-medium/pr-preview/pr-1789/src/services/powersync.js\":\"8bfd191936a341a6\",\"/knowledge-medium/pr-preview/pr-1789/src/services/supabase.js\":\"1ebaa41b32689e69\",\"/knowledge-medium/pr-preview/pr-1789/src/services/uploadErrorClassifier.js\":\"98048a3c5f536948\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/ActiveContexts.js\":\"e707dc144a0e6204\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/HotkeyReconciler.js\":\"ff08d604cb9c373b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/WipeLocalDataDialog.js\":\"a7d21b05ae2849ae\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionDispatch.js\":\"3a14340c0660e908\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionRefItems.js\":\"366a9fb779f2b865\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/applyKeybindingOverrides.js\":\"f9af64db037a35af\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/blockActions.js\":\"1302aebcbe263f7b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/canonicalizeChord.js\":\"9ea66fe8569dfe4f\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultContexts.js\":\"14f85198479378d9\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultShortcuts.js\":\"515ba4a445c4846b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/effectiveActions.js\":\"1c7d827e38726946\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureAction.js\":\"283dd37485f6ce58\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureBinding.js\":\"5abce2a54434b42a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/holdRegistry.js\":\"0034802b24922cbb\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingConflicts.js\":\"f85845d560ffb170\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingOverrides.js\":\"6df41579ff1785aa\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/pointerAction.js\":\"219c62904da5ed85\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/resolve.js\":\"28c0ee1bcf766e35\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/runAction.js\":\"9697be2eac29b3df\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/sequenceMatcher.js\":\"656a7e85f42fb38e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/types.js\":\"1579068704ede637\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionContext.js\":\"fe69edf1c67dc721\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionDiscovery.js\":\"afdcc7c3c0c7c80b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/utils.js\":\"ebf787848d87bdc5\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/bootStore.js\":\"c8f42236df20ed8f\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/previewDatabases.js\":\"bd162e42816673d2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/byteTransform.js\":\"ade3bae0dd34afec\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/attachmentCleaner.js\":\"a3847edcfa91e218\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/attachmentParts.js\":\"3c7c433f7b3e7809\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleParts.js\":\"9039456ee156e3aa\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleRecord.js\":\"799fc88fa22a6790\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/manifest.js\":\"3a04abcf627e59ea\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/takeBundle.js\":\"e3eaf29a3c2ece4f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/verifyBundle.js\":\"7553e120be2e9361\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/cleaningStage.js\":\"eb4d556ce67101ea\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionKey.js\":\"d0130ef4f98b6b99\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionServer.js\":\"d4fc47e7829e1e16\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flip.js\":\"87317243f1ff6b8e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flipAttempts.js\":\"7ee003426f26dbea\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/pages.js\":\"798a55eddff12a4b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/preflight.js\":\"5cc5239f27a9d4df\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/reseal.js\":\"a3aa16fe3337bd02\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runConversion.js\":\"e419763fb14646f5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runLock.js\":\"cd277a0643bbc5b5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealing.js\":\"159eb6b2c1c5349b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealingStage.js\":\"c802f11d4e1ebb46\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/stage.js\":\"cef581d14c6caec7\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/verifyReseal.js\":\"e5eab6cd247fa3f5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aad.js\":\"bfb381174c863106\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aead.js\":\"17af561355a6dba2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base32.js\":\"29137f6ff553e7e1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base64url.js\":\"d3df37604434e9b9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/binaryEnvelope.js\":\"25df91465a5672c1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/byteAead.js\":\"3b45f5ba5991437d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/canary.js\":\"31f5b7ae65adb3d0\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentHash.js\":\"ec3d54eb9ac49f7d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentKey.js\":\"7a51f94649907a2b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/derivedIdNamespace.js\":\"186671fe8001ac27\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/envelope.js\":\"14340cf84ec0bdce\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/hex.js\":\"23a068f6a774685e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/sha256Hex.js\":\"ffb7c400f4e83040\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/workspaceKey.js\":\"827a891955c6b564\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/conversionState.js\":\"64aa6fb6e9ab2255\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/createEncryptedWorkspace.js\":\"15813583148eba9e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/pastedKey.js\":\"0119cce0cc3667a7\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c8472bd7eb1e5bfc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cf84ba1e3d3bc8ac\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/keyStore.js\":\"c43033c4887b36e3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/mintWorkspaceKey.js\":\"0aba4e1714ecb012\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/modePin.js\":\"87c21ef03925c2d0\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/openWorkspaceKeys.js\":\"2efaa7f30c54f5d4\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolveWorkspaceEntry.js\":\"f6bab89d7ae1eab8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolver.js\":\"0bd9ac2e81a4f04d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/workspaceAccess.js\":\"e106ff62e676984e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/transform.js\":\"19d0c6200c9e5389\",\"/knowledge-medium/pr-preview/pr-1789/src/themeBootDefaults.js\":\"c817b98db56b2e1c\",\"/knowledge-medium/pr-preview/pr-1789/src/types.js\":\"f6bc8aa396be90a2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/ClientLocalSettings.js\":\"b13cf787592ee28d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/abortableSleep.js\":\"b03fc2a4d47b0741\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/array.js\":\"3e67b80d98fd19a8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/backlinkAutocomplete.js\":\"9ac8d254519a28f1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockCrumbs.js\":\"6e7e9f88fa9ca3a9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockrefAutocomplete.js\":\"6c1b7f967689df36\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/cadencedIdleJob.js\":\"1b66c60eac61f921\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/callbackSet.js\":\"06bddb66bb409c0e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/clientId.js\":\"25cf3a858697af75\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirror.js\":\"a8625f7797cdce84\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirrorCompletion.js\":\"2d61c8195e138f24\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/copy.js\":\"c6b9793fcbd3bb44\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dailyPage.js\":\"072b5f9f91dbc8f4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensics.js\":\"e09f0294f61fff72\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensicsHooks.js\":\"df8da091b65748d3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/deleteBlockThroughUi.js\":\"6a6c732741f07b32\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dialogs.js\":\"276cabb86d6da84f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dom.js\":\"e724a97f135c22e2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/downloadBlob.js\":\"525de894c2fb8999\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/exportSqliteDb.js\":\"d0af993b2872c2da\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fileSystemAccess.js\":\"bf2a07dd65b7da84\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/flipSlide.js\":\"494ab359420b362f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fnv1a.js\":\"fe1379ea0ce2f826\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/formatBytes.js\":\"2e25a38bbf939509\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fuzzyRank.js\":\"54f0575e38da81e3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idbKeyedStore.js\":\"642e4f9a3879b105\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idleCallbackPolyfill.js\":\"461f2fa2c9d2111c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardAwareScroll.js\":\"55a1c48e5826af41\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardViewport.js\":\"5bd68d8f9acd94df\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/lastWorkspace.js\":\"96358e19267ffb2a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutColumns.js\":\"91988ca9b7d662e5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionDom.js\":\"408adf29ef776b4a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionId.js\":\"3e3724efabee622c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkClickGestures.js\":\"da77788dbf4e7f06\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkTargetAutocomplete.js\":\"f03a6f0605f58280\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbCorruption.js\":\"774495b1ece7b0c9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbRecovery.js\":\"d060a8d30ea9f6b0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/markdownParser.js\":\"1219652185027ed3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/memoize.js\":\"5bbb123454ba438c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameFieldCommit.js\":\"b190c346a18b72a2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameList.js\":\"df4a73220280fe3f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/navigation.js\":\"2efe35c61bf83e7c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/omnilinerNamespace.js\":\"7c02674aa65a107a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/opfsPageScan.js\":\"2c86a2ca346801eb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelClearance.js\":\"9bd5ddf6d9d337cc\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelHistory.js\":\"39131c9b17cd29ef\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLanes.js\":\"b6f58b8b56135631\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLayoutProjection.js\":\"8a7d5281fcab467f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelScrollAnchor.js\":\"ac533cbff6b2d431\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelUrlFlags.js\":\"9d272bcdb7389ac6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/platform.js\":\"93d3405f9d0b4b10\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/pluralize.js\":\"197b2d5f2c55a7a1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyCreation.js\":\"825de30b33d85374\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyNavigation.js\":\"27c05edba65965ab\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyValueContext.js\":\"c07187b9470d717a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/react.js\":\"5242e73e91aae2d1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeDate.js\":\"9ee51c100dc1bbb7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeTime.js\":\"ce5d904eec83a181\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/renderScope.js\":\"c20108693409d62e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/resolvedThenable.js\":\"8f8589ab77b1783e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/routing.js\":\"c6b90f6f8aa69c23\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/safeMode.js\":\"c67b6add0223f220\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/scheduleIdle.js\":\"039b2c5ae4263b54\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/screenWakeLock.js\":\"ee725154e2dafc4f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/selection.js\":\"954b5c05b3543971\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/softKeyboardGrab.js\":\"a903158a3f36bbac\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/startupTimeline.js\":\"0941fb8248b8b0e4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/state.js\":\"f5ce53ee119a86bf\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/string.js\":\"0a9ef747f364343a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/surfaceZoom.js\":\"a6ede68e76613c78\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/time.js\":\"d2f5e22c5778ff97\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toast.js\":\"34147c582b0789b9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toggleStore.js\":\"eba930d9ad0c1db6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/untilStopped.js\":\"0f4311fceb1bbb0f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/userActivity.js\":\"b30da3cec096079a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewTransition.js\":\"1e6e2aedb6a37545\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewport.js\":\"420c9d41d8ba388b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/webLock.js\":\"64b0a892e01dc155\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceRecovery.js\":\"587fe752a7550627\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceSnapshotStore.js\":\"5a8180aae464ee1e\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-compiler-runtime.js\":\"9d3680e5487d8dfa\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-client.js\":\"c61a06b38b411f13\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server-edge.js\":\"655bc271d79d3a58\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server.js\":\"75a9ab42f243ee74\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static-edge.js\":\"73b4514a8252c0db\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static.js\":\"8c483a10de58c1e7\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-test-utils.js\":\"f785c95987ef322b\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom.js\":\"5f324a33828e8651\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-runtime.js\":\"aa90f5567c1fb2b6\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react.js\":\"39aed7e868de8201\",\"/knowledge-medium/pr-preview/pr-1789/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
