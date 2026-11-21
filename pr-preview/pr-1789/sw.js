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
		buildId: "834b980733e9-30ef7636",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/\":\"98530b015f2908ce\",\"/knowledge-medium/pr-preview/pr-1789/index.html\":\"98530b015f2908ce\",\"/knowledge-medium/pr-preview/pr-1789/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1789/assets/FacadeVFS-d-meU7VW.js\":\"feb96d86bea97ea8\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSCoopSyncVFS-DOCNXPTE.js\":\"27dd6ca5f860d57b\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSWriteAheadVFS-BzKWHlPP.js\":\"463234c5410aba64\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-BMA25nbU.js\":\"354886514429fcb3\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-kPYo55fK.js\":\"9ae83449ab2d0344\",\"/knowledge-medium/pr-preview/pr-1789/assets/worker-Dy_qnQht.js\":\"c59d6a5c9bb1e1d5\",\"/knowledge-medium/pr-preview/pr-1789/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1789/chunks/app-D_aF9Y98.js\":\"ebaa2f637259efdc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1789/index.js\":\"74762352ab180529\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1789/assets/AccessHandlePoolVFS-DwPvG84U.js\":\"660b29f9c9177a6b\",\"/knowledge-medium/pr-preview/pr-1789/assets/IDBBatchAtomicVFS-ioIc0pd4.js\":\"036bd21c1ba0e321\",\"/knowledge-medium/pr-preview/pr-1789/assets/MemoryVFS-CpOZQGl3.js\":\"6ccab0d635691d0f\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-C7RFgCwx.js\":\"752467c93608624d\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-B-Ch6wmT.js\":\"7706a6c5b62692f7\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/AccessHandlePoolVFS-DNNnlGfm.js\":\"f3a31fe2e8ff8050\",\"/knowledge-medium/pr-preview/pr-1789/chunks/FacadeVFS-oqJLHsU7.js\":\"5c6a2a286a993401\",\"/knowledge-medium/pr-preview/pr-1789/chunks/IDBBatchAtomicVFS--Vvkdsyw.js\":\"26b083fd9937e2f3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/MemoryVFS-BX-NpvAS.js\":\"196d0e8e93229a5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSCoopSyncVFS-CFS9QSX0.js\":\"bf0a85e5949c7923\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSWriteAheadVFS-D8O2Lg66.js\":\"562b71040c76c0b3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/Preview-Ct8yJGJK.js\":\"1288db19642b17a9\",\"/knowledge-medium/pr-preview/pr-1789/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/card-DAWplN-i.js\":\"3c91278a8d14a0c7\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-DKuvb82H.js\":\"5675489df085948f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-Dz1hn0fU.js\":\"b0ab2be8c64b7c5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-async-D5F0ArBL.js\":\"7eecdd4af4d9e5c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-75JbVeWp.js\":\"6c6d8b04e564f98f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BgpQpVbv.js\":\"0bc2c8119354a7fa\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-Bz6nW-tf.js\":\"e9c1fb5c0400f440\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CB0GPT5A.js\":\"fd01b5ca9987b402\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-Cmndiwjt.js\":\"c7fce5d12fb68abd\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CsVM1kkj.js\":\"60227498c48294d9\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server-legacy.browser.production-ChX5IEKr.js\":\"d1caabc8185b0d34\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.browser.production-Bta-2tDw.js\":\"4dbc5f6221e338d3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.edge.production-BwGmbTdb.js\":\"938a86a0d58f9a7f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-jDt2femn.js\":\"5c8ddc7f90d9eb6b\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-l-rgJvIA.js\":\"7a2f0dace0aa0559\",\"/knowledge-medium/pr-preview/pr-1789/chunks/server.browser-WVJ-u_s3.js\":\"541190ad8607f1d4\",\"/knowledge-medium/pr-preview/pr-1789/chunks/textarea-BV_2Ztot.js\":\"befac23776d3f62a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/ui-DZAsPaGe.js\":\"83197a3bf7390394\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-DF2ZsgOn.js\":\"25c5909413dd88fe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-async-CSXkvVqY.js\":\"623aad82ffdd3ff2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1789/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/src/App.js\":\"9d287537a0bf631c\",\"/knowledge-medium/pr-preview/pr-1789/src/appUpdate.js\":\"64769f74736f6c5c\",\"/knowledge-medium/pr-preview/pr-1789/src/appVersion.js\":\"a6a127b18417df3c\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/initialLayout.js\":\"2bfa716555c0903c\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/openWorkspaceData.js\":\"66eaa8c110cfbebc\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/resolveWorkspace.js\":\"c1cd577d229214fa\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/workspaceBootstrap.js\":\"d89f1bf68786eb20\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockComponent.js\":\"4d5d19ebb89049d1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockCrumbs.js\":\"65c8cd80df5bc41e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockEditor.js\":\"8c02079a573a8bc5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockLoadingPlaceholder.js\":\"1a1b13ff51d09f5b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockProperties.js\":\"3f1bfad8c0c322df\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockSearchPicker.js\":\"1b1138801d159901\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ConfirmBulkDeleteDialog.js\":\"c1e8f9040371c43a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DividerHandle.js\":\"4366ddb4c2d79b5c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DraftEditor.js\":\"99494a7dc90f011f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/GutterPill.js\":\"2c25b0356713db90\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Header.js\":\"cfa5453c064d5048\",\"/knowledge-medium/pr-preview/pr-1789/src/components/LazyBlockComponent.js\":\"9f8c99babcb2d91a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Login.js\":\"e089ccbbfb85e4d9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ZoomableSurface.js\":\"0a01b71d33e355e3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/editModeKeepalive.js\":\"a25d2974556d7b34\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyDisplay/PropertyDisplayScope.js\":\"25656aa3a7152310\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1935edfe5282de7f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefPropertyEditor.js\":\"d877a40589ca7d10\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefTargetTypePicker.js\":\"ae5260bafe7e5ba3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/SelectPropertyEditor.js\":\"c158218714fadf48\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/TypesPropertyEditor.js\":\"f4dd09f134807ba5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/defaults.js\":\"fed54753c2696ebe\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/kernelValuePresets.js\":\"d4fff7fe09fa23f3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/selectablePresets.js\":\"178787baf6444a6f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/typesPropertyUi.js\":\"a51fe68d1422b1be\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/AddPropertyForm.js\":\"1b919868faedf1ed\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyPicker.js\":\"29bdac17bf656b15\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyRow.js\":\"be80a937678a25b1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/Rows.js\":\"9c9058fd6c18c13c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/actions.js\":\"4d57d33a608e0c3d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/declarationOnly.js\":\"2af2319217fb8aaf\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/layout.js\":\"f0bb1938d22c045f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/model.js\":\"d59ba79c6c0f9c7b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapeUi.js\":\"a72dafcab20bec86\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapes.js\":\"7f2f60837c6ca884\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c8fd84f87e23c904\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/visibility.js\":\"a1b650c403b9a72b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanelSections.js\":\"bfecca15f307929f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockEmbed.js\":\"c8d0d66ef0fe77f5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockLink.js\":\"53dca77887fda67e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockRef.js\":\"967e478f94ebc15c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/ReferenceLink.js\":\"76659666408704e2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuard.js\":\"5373cc9d7734c4a7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuardContext.js\":\"fc595110eb28749e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/linkInteraction.js\":\"331b2c58939c84ee\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/referenceLayout.js\":\"518fe2a538352b16\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/useBlockRefAncestors.js\":\"d7508901e0bbf0a6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockGutter.js\":\"ff7006ac7369d52d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockInfoDialog.js\":\"1a25ec9db89c4845\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockTypeBlockRenderer.js\":\"4fa5cfbe0ec8d247\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BulletHoverCard.js\":\"8d241e1059b90bbe\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorContentRenderer.js\":\"64c51730b264e59f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"92bd985e6e5d53ec\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ColumnResizeHandles.js\":\"4f5526d0276ba59e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b1123e8fbb653d5c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/DefaultBlockRenderer.js\":\"6d732b2fc75e4a32\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/LayoutRenderer.js\":\"c18b62fcb2c135d6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MarkdownContentRenderer.js\":\"a089c4b57e762849\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MissingDataRenderer.js\":\"66e5ea7f696cbd3d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PanelRenderer.js\":\"b386636568bcf0f9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ee16ae23d799f43c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/TopLevelRenderer.js\":\"6a573633ad80ea61\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockGutterMode.js\":\"e06dda2d769d7424\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockTitleText.js\":\"4ee5bb958381edc6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/fieldCreationKeydown.js\":\"4f5bcce6b9142b4a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/layoutRootContext.js\":\"c7399b30dfd92975\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/TypeChip.js\":\"896e2b7f42f421f6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/chipStyle.js\":\"86c86e99157d96c4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/anchored-floating.js\":\"7b1ee490a1947cd8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/button.js\":\"0ca9fc8f54d2301f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/card.js\":\"4702188f6489ccb1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/checkbox.js\":\"59a96c50bad9a3f6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/collapsible.js\":\"2963b65561d63927\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/command.js\":\"d7e1d730160b7469\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/context-menu.js\":\"af843a9eb19514ea\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dialog.js\":\"253e4b81f2da049a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dropdown-menu.js\":\"0b327db7f7555ed7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/floating-listbox.js\":\"8b2f94c84c4702b9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/index.js\":\"47cc8ae37cff3dad\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/input.js\":\"eed58f346f0c9640\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/kbd.js\":\"323ea7b2276c4105\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/label.js\":\"20f86af53722cdaf\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/textarea.js\":\"3e192dee1104aa27\",\"/knowledge-medium/pr-preview/pr-1789/src/components/useEditModeYieldKeepalive.js\":\"972bb1d9be533261\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/BootFallback.js\":\"4aa2396597c4ec93\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/FocusedRowLazyMount.js\":\"0aa1f0e6f499a3c5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LazyViewportMount.js\":\"d85c14b0d4d0b086\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LocalDbCorruptionFallback.js\":\"e328789504cfeacb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/error.js\":\"3cacb7246d2d1678\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/lazyMountRegistry.js\":\"75b92342a290d20f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/suspense.js\":\"0e8e51e987ecc060\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/CreateWorkspaceDialog.js\":\"c44c44798af92636\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/PendingInvitations.js\":\"7de88ded452e322e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/SyncProgress.js\":\"b0465e9ecac5a281\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/UnlockProgress.js\":\"d1498d48013dd223\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceKeyGate.js\":\"42d1c90a6a8c4d05\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSettingsDialog.js\":\"ac77b58092a04ace\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSwitcher.js\":\"1e9467b2215e44f3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSyncGate.js\":\"fb6fe031216e5801\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlow.js\":\"8aca5d5a0c8fce3d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlowHost.js\":\"63856f9416293408\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/EncryptionSection.js\":\"b232313d7bb6b00b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/attachmentPrompts.js\":\"bfd4e6fadca85924\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d5d7a02bd0cd6ea1\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowDeps.js\":\"b15541e1fc3bbb2e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowStore.js\":\"f1fdebf69aaf23f3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/flowUi.js\":\"0c5a1e17a9b1f598\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/useConversionRun.js\":\"9bc592fe59d68b7a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/keyUi.js\":\"a76f27ca5d69a683\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnKeyLoss.js\":\"d316754c7482d331\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnServerE2ee.js\":\"ebb346e1d680488a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/workspaceUnlocked.js\":\"d711343e176e7ba0\",\"/knowledge-medium/pr-preview/pr-1789/src/context/backgroundSubtree.js\":\"f49ae4260e0d711c\",\"/knowledge-medium/pr-preview/pr-1789/src/context/block.js\":\"ab06c59f940c8df6\",\"/knowledge-medium/pr-preview/pr-1789/src/context/layoutWsContext.js\":\"c3795d9b7781c823\",\"/knowledge-medium/pr-preview/pr-1789/src/context/propertyDisplay.js\":\"bf5ade137c51d453\",\"/knowledge-medium/pr-preview/pr-1789/src/context/repo.js\":\"5dbd589f7ec556ed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasClaim.js\":\"a3c152964c085258\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasSeatNamespace.js\":\"ebe83b2c5bf64ace\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockData.js\":\"05f14e2270bd0454\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockType.js\":\"31c65836aa9cc347\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/changeScope.js\":\"dd67fbaf209923d1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/codecs.js\":\"95bf59a35b5505b3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/derivedData.js\":\"022126c3f4c56299\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/errors.js\":\"59d4745066f7b0b0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/events.js\":\"a3662ec0d08f6179\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/handle.js\":\"8e366f23f5d1d360\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/index.js\":\"b40a4852dbd71184\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/mutator.js\":\"073ef5e3eef9f7a9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/processor.js\":\"39791d7cce646818\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/propertySchema.js\":\"6073fdc19f52c116\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/query.js\":\"a37ab27902da0d2a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/sameTxProcessor.js\":\"5d0972808e7662e8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/schema.js\":\"8e366f23f5d1d360\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/tx.js\":\"8e366f23f5d1d360\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/typedBlockQuery.js\":\"8b0b3279fcbbce5c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/user.js\":\"eec588aab3ee4f60\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresetCore.js\":\"ff0debbdc5637316\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresets.js\":\"fd87315cc47b5134\",\"/knowledge-medium/pr-preview/pr-1789/src/data/attachmentCleanerIOVerb.js\":\"28c70b7e2133a44f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/block.js\":\"df77d6d25f0d5104\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockCache.js\":\"4e8cd9e6184cd324\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockId.js\":\"369f526915f24c1a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockLiveness.js\":\"d62908cc98584ab9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockMerge.js\":\"c10cc0b95d5949f9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockSchema.js\":\"537999cb41943a7e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockTypes.js\":\"e30fb1e00220d24e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/clientContext.js\":\"ea0c56ce4e532e66\",\"/knowledge-medium/pr-preview/pr-1789/src/data/dbFileSiblings.js\":\"9e0f02c6a7758f49\",\"/knowledge-medium/pr-preview/pr-1789/src/data/definitionSeeds.js\":\"1682f17e80c6eb5f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/derivedIds.js\":\"f1bd042c40a700d0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/drawnSubtree.js\":\"ccb0975080e31584\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facetBridge.js\":\"586412f901bcb0c0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facets.js\":\"5807cc5a4781e635\",\"/knowledge-medium/pr-preview/pr-1789/src/data/globalState.js\":\"2538f734ddb34dd2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/aliasClaimRederiveProcessor.js\":\"9629da13b9435569\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/ancestorBatch.js\":\"0b142bad8db8afc7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/blockTypeTypeifyProcessor.js\":\"e2260564b7174922\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/clientSchema.js\":\"bfd1c33ee3b94871\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/commitPipeline.js\":\"a5e9fe977cb26d67\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/devAssertions.js\":\"86a8cbf1227d78e4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/firstSync.js\":\"d58019a19c0d2759\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/freshInitialLoad.js\":\"afd53f6c1b20f19f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/graphBackfillClaim.js\":\"1782a1d52750876e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/handleStore.js\":\"0cde2421a8907d14\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/idleMarkerJobs.js\":\"5727fae6203d3c35\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initialDownload.js\":\"726102ad5b6a42e8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initializeClientDatabase.js\":\"16a2d27e67a23168\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/jsonCanonical.js\":\"d4f04e62762f9116\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelInvalidation.js\":\"2969790dddee8ba3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelProcessors.js\":\"9778e12ef48409f0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelQueries.js\":\"6c38b5f5a69f89a4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/mergeTypeMembershipProcessor.js\":\"51263b4e1c68cb29\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/normalizeReferencesProcessor.js\":\"bb2cae4909bc9df3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/poolInstrumentation.js\":\"cd06d2b3ffbfcfd1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/processorRunner.js\":\"9704408aecc1fb70\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyCellBackfill.js\":\"e68734911a85741e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildMint.js\":\"e43b5d0b5e4523c6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildrenProcessor.js\":\"3e70d4e4e8723632\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f0fd90e78963b75a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionSynthesis.js\":\"545000bc8bea7f44\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyKeyScan.js\":\"82b819eeec5e55fa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertySchemaResolution.js\":\"51ddcb431ba8edc5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/raiseProtocol.js\":\"2c295f9d35f82b10\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/readBatch.js\":\"f6178824a04d63b5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/refProjection.js\":\"97bb7802fe2e21ff\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetLookups.js\":\"740affd7c8c54668\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetProcessor.js\":\"920b459b269e5c00\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/replayMerge.js\":\"1f59bac74e296abe\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/sqlBinds.js\":\"d9bb11f912363719\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9cc1fa5030873927\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/arrivalProcessors.js\":\"de29ab74d461632c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/invalidate.js\":\"e90d7fd9ee05af87\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/materialize.js\":\"3f0fc288cbe6e9f4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/observer.js\":\"e81bf5712aac4e27\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/reconcile.js\":\"a3372554e40d9b9b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/timingMetrics.js\":\"f6550d03c8036a69\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/treeQueries.js\":\"6163fb2e4894d584\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txEngine.js\":\"567211c0641cb845\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txSnapshots.js\":\"a0b3fcbf8a12d042\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/typedBlockQuery.js\":\"1f8edb23bd1086da\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/undoManager.js\":\"46cf093f78d33e5d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/invalidation.js\":\"217593ddf0126478\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelDataExtension.js\":\"4dfe179229401504\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelPage.js\":\"0f7ac7a3c8e075d4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelValuePresetCores.js\":\"97dadf09349403ff\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbCorruptionSignal.js\":\"b64afbe7928a127d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbStorage.js\":\"4ab61479b6165389\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbVfs.js\":\"8116fdc18beb677c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localSchema.js\":\"36ddddf44ab08a6e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/maintenance.js\":\"12715b94bb5ee133\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mergeProperties.js\":\"8ed5a4701dcfe500\",\"/knowledge-medium/pr-preview/pr-1789/src/data/metricsConsoleHook.js\":\"108c367bdcd39750\",\"/knowledge-medium/pr-preview/pr-1789/src/data/migrationsPage.js\":\"0817c4f166082ceb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mutators.js\":\"6f69cc83435c0fa4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKey.js\":\"e61a92f30a4b4c33\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKeyPlacement.js\":\"22564646a1634691\",\"/knowledge-medium/pr-preview/pr-1789/src/data/outlineSurface.js\":\"ac7ef84edf5c592f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingEditorContent.js\":\"ce672a11955ba801\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingUploadsSql.js\":\"9f0ee43b84c5bb36\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pluginStateExtensions.js\":\"040a00cdf4a4c231\",\"/knowledge-medium/pr-preview/pr-1789/src/data/powerSyncLogger.js\":\"d70845c6e7f1f3ed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/projectorRuntime.js\":\"8f08487fb5e7e28e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/properties.js\":\"1f4cc15ebd9b6bf3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertiesPage.js\":\"80fb4e955d1e22ab\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyChildren.js\":\"570a50a100cff551\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionFanout.js\":\"43fd5b37e096dedc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionMetadata.js\":\"b72835178456e137\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionRegistry.js\":\"d479a7499aa16a15\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDisplayMode.js\":\"3660b31cc4a997c5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyRowCreation.js\":\"7347746c0968d006\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySchemaCreation.js\":\"634e91c9d65406e1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySeeds.js\":\"3a9abfd7ba36600e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/recentsPage.js\":\"5393ff8aa99a0f94\",\"/knowledge-medium/pr-preview/pr-1789/src/data/referenceBlock.js\":\"6333b351e1701a37\",\"/knowledge-medium/pr-preview/pr-1789/src/data/releasePowerSyncConnection.js\":\"7604dbc8c31754dc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repo.js\":\"14f5e4ca40122f2d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repoProvider.js\":\"f5c4c8575990cf48\",\"/knowledge-medium/pr-preview/pr-1789/src/data/rowProperty.js\":\"6123f04d78a9a0dd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/searchFilter.js\":\"18f766abdec7ccf0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/seedIdentityLedger.js\":\"d5d92e3cae294277\",\"/knowledge-medium/pr-preview/pr-1789/src/data/stateBlocks.js\":\"93a8ea3b9722177e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/structuralEditPolicy.js\":\"98b3499bbbe94848\",\"/knowledge-medium/pr-preview/pr-1789/src/data/subtreeDelete.js\":\"e54f20340a9067c1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncStreamLock.js\":\"82bab55cbe39e0a1\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableSqlRecognizer.js\":\"122c10a817b417a2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableWriteGuard.js\":\"9ab87cabc5f64c2c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/targets.js\":\"43568ff9f8b97282\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeColors.js\":\"18b38ee0f3ec1a55\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionMetadata.js\":\"55228641ab10b525\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionRegistry.js\":\"0948e1b424392d24\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeExtraction.js\":\"de55ea8b00bfbabe\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeInitialValues.js\":\"37bf93b6b8c94b03\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typePropertyGroups.js\":\"5322939651e1db75\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeSeeds.js\":\"1ebd625fd4f5aae6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeTagger.js\":\"fcc0d9ec3afef9fb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typedRecords.js\":\"6154e5b79fedcc3f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typesPage.js\":\"8546d9d8768db73c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userPrefs.js\":\"c8007bb414326091\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userSchemasService.js\":\"6c54277155ff2f67\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userTypesService.js\":\"7b1c22502d6b035b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/valuePresetRegistry.js\":\"7b95febb761c5af0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/visibleChildren.js\":\"9b9dfab1855508ae\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceConversion.js\":\"3b7a527f77bdd7b2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceFirstSync.js\":\"b870662606648b3f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceIdNamespace.js\":\"823ced66cff8bca4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceSchema.js\":\"18fb173aa844fb8c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaces.js\":\"a97abd21f7ccc263\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadLog.js\":\"999b6f7df6ed18bc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/BlockPasteShellDecorator.js\":\"a020abe0777899fe\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/atTrigger.js\":\"9db338d6d5083ad3\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/autocomplete.js\":\"6dbe993ea0ed5c18\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/codeMirrorExtensions.js\":\"6a671d0556ca3f57\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/contentFlush.js\":\"ac956e8712b026f9\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/defaultInteractions.js\":\"c515fe6d95046ddd\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/editSettleSignal.js\":\"919ed5fea5c0b960\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/insertImage.js\":\"6369a027e1a55b40\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceCompletionRange.js\":\"eb4ddfe8939d17a8\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceTargetTypes.js\":\"1be5c65e5a82dbb0\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/syntaxContext.js\":\"4f3114ea7da3af68\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/triggerMatch.js\":\"38a290dd9b5a6a0d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/AppRuntimeProvider.js\":\"bfdadf782c400c8e\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/BlockFocusShellDecorator.js\":\"c0f25a5869239886\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/ExtensionRenderBoundary.js\":\"b4567712d0c8da26\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/PanelContentRecovery.js\":\"db26360a6c571d69\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/apiCatalog.js\":\"934a2e16a68c3721\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/approveExtensionHere.js\":\"7a5eeb362bfa2c9f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/armedCutAppMount.js\":\"ebf35bcb0b4d42ec\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/batchableKeyedStore.js\":\"6e856c46ec0abe5e\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockInteraction.js\":\"7551d6e9feb15b89\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockSelectionAction.js\":\"2de721e8cd399922\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compileExtensionModule.js\":\"d0e5c9e688096593\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compiledModuleCache.js\":\"bd2c143b234db5a7\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/continuousGestures.js\":\"b30a9ea6f88fdb6c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/core.js\":\"bec3ea3aca1d7e77\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/defaultRenderers.js\":\"3e92df8eb92b200e\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/definitionFanoutAppMount.js\":\"4a9d6ff73e14ffef\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dialogAppMount.js\":\"6a98d9dc95748a17\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensionSeeds.js\":\"e572358b6a9ba99b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensions.js\":\"3f2abc991ed4c682\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/exampleExtensions.js\":\"2416d330a18febdd\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionApprovalStatus.js\":\"6df34441be80b06c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrorToast.js\":\"8179908bc6a9d750\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrors.js\":\"ae7354920dcaf1ac\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLookup.js\":\"500840c3e5c11b02\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionToggles.js\":\"db6a743280febc0a\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionUtilitiesCss.js\":\"1cc704db4a1d0482\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/kernelPageDeletionGuard.js\":\"c99321aa29cb2700\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/liveRuntime.js\":\"48044cdc205510bd\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/openExtensionsSettings.js\":\"480138c46a63b150\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/overridesCache.js\":\"8bc91839952ec4e6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/pluginIds.js\":\"2d90e27dfc414ce3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/processorRejectionToast.js\":\"b2354e05bb557143\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeActions.js\":\"18ee1438cae3a295\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeContext.js\":\"368b603b0a714427\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticAppExtensions.js\":\"977466c6962f4bff\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticDataExtensions.js\":\"4fa8bd34dee8803b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/toastAppMount.js\":\"46dd564c1723b63d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useOverrides.js\":\"b4a68712cc86e769\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useShortcutSurfaceActivations.js\":\"6459fc8f6f8e93df\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/discoverToggleTree.js\":\"01041216d20e6551\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/facet.js\":\"251b5f2e10ec5165\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/resolveAppRuntime.js\":\"e4fd94dc2f2e937b\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/runtimeEvents.js\":\"5da16a4f6097fe52\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/togglable.js\":\"8fa653ad690c6d92\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/variantFacet.js\":\"75d2b57b0408264e\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/verbFacet.js\":\"be7225934d36bd19\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/block.js\":\"1cc684c038fdf151\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/focusedChild.js\":\"32bad1e0db48d073\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/propertySchemas.js\":\"58eb0754d8b54822\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/typeRegistry.js\":\"d9c56a53f6bbceed\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAncestorCrumbs.js\":\"61e4aac9da8077c5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAutocompleteListbox.js\":\"23b7cf00c10d4263\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedSearch.js\":\"2433b475bd2fe317\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedValue.js\":\"c23212f35d95500f\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsFocalRender.js\":\"3cb57513ec6781f9\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsReadOnly.js\":\"236521e7bfcdc441\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMaterializeBacklog.js\":\"49dc3fe33fb11969\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMinuteClock.js\":\"a868708edf03b3e5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePanelLayoutProjection.js\":\"fc4eb2eccfd020c7\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePendingInvitations.js\":\"3e08db99e3e575e1\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRendererRegistry.js\":\"98754164c7ab2587\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRetainedFieldRows.js\":\"7b347cc4dbe8c591\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useWorkspaces.js\":\"c9091313656285a4\",\"/knowledge-medium/pr-preview/pr-1789/src/lib/utils.js\":\"1d470c13afa22f3b\",\"/knowledge-medium/pr-preview/pr-1789/src/main.js\":\"3fc4197f33c0ae5b\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/MarkdownImage.js\":\"f1e51f39e56ed0ab\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/blockSeparators.js\":\"2b24db78cc9816f5\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/context.js\":\"1c7a21fe967aa77b\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/defaultMarkdownExtension.js\":\"b06bd98e85e25069\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/extensions.js\":\"dbf495aa70abd20f\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/renderMarkdownHtml.js\":\"af4118a35dbea0f6\",\"/knowledge-medium/pr-preview/pr-1789/src/minimal-editor.js\":\"ff92195e4629eeab\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/armedCut.js\":\"6f8cbf2af7b384e9\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/captureMediaVerb.js\":\"f43075401e06da61\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/clipboard.js\":\"b4c5131b9a64563b\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/decision.js\":\"eb954f8a77908140\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/operations.js\":\"d4c170507dc440b2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/AccountHeaderItem.js\":\"58140659abef67e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/index.js\":\"e8b53c9a10edf005\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"027a7ef5baaacc1e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askAgent.js\":\"a6def2117d54cf38\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askedStore.js\":\"f5e5e1ef12ef57c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f2729e61b7e69bf6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/chipState.js\":\"8cc18d3ea12d3cb9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b3f08f56060f591a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/index.js\":\"7dff9d0ba05031ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e3de095f1bfa69a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/schema.js\":\"ec57ca45bbdbe55d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/AgentTokensDialog.js\":\"917799d7c3697b46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7f57315ff40fdf83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/addMedia.js\":\"bea7e109e35c9993\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/backlinks.js\":\"03d1790e4aee779a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/block.js\":\"3cd7b86c785b18db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/context.js\":\"e5dbdcd3cbbdbf40\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0199100846e5f879\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/index.js\":\"722eb10efc2df1e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/outline.js\":\"7837e9d87113556b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/properties.js\":\"d0e121f4d5db9d19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/refs.js\":\"77fd5619c11dbf71\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"71845016f0021f7d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/search.js\":\"ce0722ff49de0fa6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/shared.js\":\"aa569fccdc51b875\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f8a9a9a07c8c1fcf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/text.js\":\"d606320a8cb1848d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentWrites.js\":\"676b466fe6cc7a01\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/authoringCatalog.js\":\"38beb72ed43b00ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/blockRefTargets.js\":\"b3de5c9b63d8b1f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridge.js\":\"87d224dce11a9cbb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridgeLoop.js\":\"2a729aaf1fb9fc8c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/changeHistory.js\":\"cfb4d78986cb24c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commands.js\":\"4ebc96fafa6ff50e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commentsCommands.js\":\"74b64d4dd69b5ae0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataExtension.js\":\"26f72a5f48ff1279\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataModelGuide.js\":\"c785e1c62f0e81b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/describeRuntime.js\":\"e3472cd69d83d47b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/extensionLint.js\":\"fae6002fbcbae36c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/grainAudit.js\":\"076df36b95f11dbd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/healthCommand.js\":\"779435ea23e62c09\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/index.js\":\"4ed34cddff652cb9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/presetIdentity.js\":\"e571a8750e5fa9ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0b29a1534aa42afe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/readMedia.js\":\"4e5dfed71666e6f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/schema.js\":\"8a010d423499e498\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/serialization.js\":\"ce1ba8d4dac5b4fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/targets.js\":\"0247239c62e19511\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/tokens.js\":\"724b27ce00e79efd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/watchEvents.js\":\"7f85ed6440280ffc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/workspaceGuard.js\":\"bde543092dd317d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/writeCommands.js\":\"bb0b2dad715e5c42\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/AliasCollisionToast.js\":\"b643d01eda6f9bf0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/DuplicateNameBanner.js\":\"4e5165bb887ecfe3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/collisionMerge.js\":\"dad00e09fdee12fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/dataExtension.js\":\"c216baf1fe468388\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/index.js\":\"2957b5381b306005\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/mergeCollisionAction.js\":\"fab3969c15d129cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/pageStyling.js\":\"5834932334a61276\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/rejectionToast.js\":\"fc84c7b0b3c604ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/syncProcessor.js\":\"3b68624a9885b2e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/actions.js\":\"ef989f037dde0742\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/addComment.js\":\"741cf26f7a62478b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchor.js\":\"eda5cf3803547231\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchorState.js\":\"a87ab5dbb13b9bfe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/commentLinks.js\":\"82d50fc34557e50a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/confirmThreadDeletion.js\":\"de11a204857bb74f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/container.js\":\"27877460fc7dd035\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/dataExtension.js\":\"219f293d1e2d8822\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/deleteComment.js\":\"62d16b15b5853b36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/highlights.js\":\"997f279ad81a1817\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/index.js\":\"b25470d0e424c0a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/linkedCommentsPill.js\":\"e13f003d173185fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/margin.js\":\"0c26ef124cdabae0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/marginSchema.js\":\"9a24fa5292df9ccc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/newComment.js\":\"98d51deef484d726\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ownThreadPicker.js\":\"d6ef14b77b9d44eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/placement.js\":\"0380d69780d6d3df\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/queries.js\":\"a105dde350bead15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotePosition.js\":\"67ed7943f8d35e01\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedIn.js\":\"1e5b5006e4492ae3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedRange.js\":\"bcd204419674555b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/rangeRefs.js\":\"d7c6fa4e996043ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readHighlights.js\":\"ecdc6045d794dcf4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelection.js\":\"0be1dd84a7b01bd1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelectionUi.js\":\"9bc6b579b153adc7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/reanchor.js\":\"a8b23cbf0bf8764b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/schema.js\":\"01956494e6c9a5c1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scope.js\":\"cf40731676dfe962\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scopeThreads.js\":\"9a8caa174fcc3847\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/splitRetarget.js\":\"f0d71405d08a91aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestionCard.js\":\"9a89502469ac527c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestions.js\":\"b163605ae45f5ce2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaries.js\":\"4cca7ebafd962455\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaryBatch.js\":\"0e737168ba4a36ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/surface.js\":\"dd50b56f946c95a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threadNavigation.js\":\"617beb39558b237e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threads.js\":\"c457a2d924bb19fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ui.js\":\"a472ad50de3c5ab3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/uiStore.js\":\"543340acab7e7486\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/appIntents.js\":\"af751769ed2fde58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/index.js\":\"3b3219011f2a2fc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/index.js\":\"2fd5e303d44ddbeb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/status.js\":\"d6d042b8ca95d8a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"214014540ad1da36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaBlockRenderer.js\":\"4fdbb003bf51634b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4ad50e500b21a152\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaUploadReconciler.js\":\"a6b735628a8cb542\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetDownLane.js\":\"44e7b36ebb748c4d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetResolver.js\":\"d94976e2ba697dd1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetUpload.js\":\"0b296b6093e10e00\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/attachmentCleanerIO.js\":\"7bf52c731646484e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8ab051165f1f5539\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/blobStore.js\":\"0cab7e5e349df03a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/byteStore.js\":\"9924a765afee45f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanerIO.js\":\"8ba382e2ca066585\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanupAttachments.js\":\"2de5bba05f87f393\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/dataExtension.js\":\"d46840ba63ea6b7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/downLane.js\":\"317242c3605f592b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/index.js\":\"99520f389d5ab18c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/insertImageContribution.js\":\"1d5549f2cc7f0f86\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneArming.js\":\"42d04353dda52528\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneLock.js\":\"569b249b30b3a238\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaBlock.js\":\"47aecf1fdd8f0d79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaCapture.js\":\"c74bdb044a903895\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewers.js\":\"f332b62a6b09c1b5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewersFacet.js\":\"97cd305342d34f1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/pasteCapture.js\":\"3c071653a7b13cb8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/resolver.js\":\"3c4e448cebd693a8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/retryUploadsAction.js\":\"b4fa15404af882b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/storagePaths.js\":\"743ba392c0824017\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadDrain.js\":\"f06711c8dd0c9747\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadLaneStatus.js\":\"cc2c04d532006599\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadReconcile.js\":\"785e626be17935b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadRecovery.js\":\"fc5f54092e229ee6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadStore.js\":\"70ae279f2e44be2f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/useAssetObjectUrl.js\":\"cd40764350e7b69f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ec698c6951ed30cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c82d5133f8980433\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/facet.js\":\"ec90281fd2a7b2af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/index.js\":\"6e90f66ec5c95e25\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/prop.js\":\"1ea6e21fdc971ebf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinkFilters.js\":\"d4a98ba5c5090dda\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"540ca18c51f07a88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BlockEntry.js\":\"93839657ed05f9d5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/LinkedReferences.js\":\"64622323c1f2cd61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"752fc0e4df66e5e2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dailyNoteDefaults.js\":\"68bd30201f2d60eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dataExtension.js\":\"e4fbdfaf9b144c9d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/edgeExclusions.js\":\"fc9677386ca5282d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/filterProperty.js\":\"00a474c5bebe3c50\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/index.js\":\"4b5b9192920b2cf7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"54dea9ef7e0caed8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/applies.js\":\"94681bc183681739\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/countQuery.js\":\"ae0c065d0ce0307e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/expansionStore.js\":\"75817e0ce1c996a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/index.js\":\"f716485ec1b6249b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"748611cfcbe32c30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/presentationInvalidation.js\":\"30e0fe9e558a2afa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyEditorOverride.js\":\"d80687354c96966d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyFilter.js\":\"d17826c2aa855b10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/query.js\":\"94749363359f685f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/resolveFilter.js\":\"0aefc83781df6786\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sourceBatch.js\":\"c39044f779c26c0e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sources.js\":\"9ea110a6ff0a9f9d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useBacklinks.js\":\"7b9a0677137d7928\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f1a4873c9ee60439\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayCelebration.js\":\"ae5182597c89792a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayOverlay.js\":\"745d9bc1689ef518\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/gate.js\":\"d9cce57edf11a4dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/index.js\":\"7c6637dc6bc8969c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/wolfTheme.js\":\"e34dd6915c7712bf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/BlockDragLayer.js\":\"3b6bec37bf659636\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dragController.js\":\"350d73757b5d733b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dropTarget.js\":\"c82d4918f5eb1c64\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/index.js\":\"33e40b0d1dc4b225\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/projection.js\":\"d830f5ccec9cfe7d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/BlockMetaCard.js\":\"24d716be568c6ade\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/index.js\":\"a1d9a36c3c9aa016\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/AddTagDialog.js\":\"39f0028f93e24d27\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5b034221d9cb45e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/TagNameIssueHint.js\":\"5b4b01e2b9db6860\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/addTagAction.js\":\"5ce996fffe7d3ba0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/appendTag.js\":\"26422dd12ee1d18c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/config.js\":\"a1aa0c15558d0948\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/dataExtension.js\":\"f3665f80f95a3a25\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/index.js\":\"f1deeccff6b06bf4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/propertyEditorOverride.js\":\"d57cd9c03c78657e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0bf519a2a0348cf8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"36d5b1e9eb19a107\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9ecff348ad0713cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c23ace9427e29d2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fc15e6e3455f7b66\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/index.js\":\"77815566fd791973\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4d3c9e43ffe5f5ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/CharacterCountItem.js\":\"bbb6ffd542ec226d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/ProfilePropertyEditor.js\":\"16abc326b7d739d6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/actions.js\":\"bb001b0666d8f4fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/blockType.js\":\"b6a4abcad214fd8c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/charCount.js\":\"636bc813f64ceb9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/dataExtension.js\":\"40393e35683d6907\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/index.js\":\"8173c7e866d98ab4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/profiles.js\":\"6b730bab1853338a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/properties.js\":\"b30990cdc02676ba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/textCounts.js\":\"d4c8d3e08c7943c7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/colemak-keybindings/index.js\":\"a6d7f068dab3ee21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/CommandPalette.js\":\"ec03eb32aec13299\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/HeaderItem.js\":\"b43d74d21061648f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/context.js\":\"e07cc7ba041cd0d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/index.js\":\"3c48b9082f7918a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/selection.js\":\"1256c4a5cfe5ece0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/toggleStore.js\":\"3b642fc8ab8c9581\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/useCommandPaletteActions.js\":\"82de4deecb31545b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/ContributorBadges.js\":\"52595aa4492cc1b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/author.js\":\"495ed4ce6e12f3ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/codeMirrorExtensions.js\":\"b25268279a061d86\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/dataExtension.js\":\"f0e1d7b2dfa8d059\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/index.js\":\"2a3b093309a619cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/mentionAutocomplete.js\":\"741e434cd138e79f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/processor.js\":\"28acedf61cdce4fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/profiles.js\":\"6cf7740e153def43\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/queries.js\":\"7416793c29f60414\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/schema.js\":\"ae2a1622634ad8e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5ac1099e97b59fe8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1d1e5455cdee0762\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/index.js\":\"682f8f0bfe0b2ed8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d1bb8c576385a346\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"afde253a83c3a151\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/CalendarGrid.js\":\"132535cb3b38275f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DailyNotePicker.js\":\"9dc67115f03e0927\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ba8b5554e2e03a6e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateNavDecorator.js\":\"e1e9fd5a1e0211dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateScrubOverlay.js\":\"0300dcc5a9c60474\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/HeaderItem.js\":\"5cd5206b55b83236\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/ReschedulePicker.js\":\"19bb5c05dd0afc24\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/SpreadDatesDialog.js\":\"69d4050c90713c10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/actions.js\":\"130770f70f260409\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/blockDateAdapter.js\":\"e3b1fc7beb74c224\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/calendar.js\":\"dc93b88362b172cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dailyNotes.js\":\"fbcbe2d09d10ae45\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dataExtension.js\":\"32bd60147d7469ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubActions.js\":\"382f3d93389dec55\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGesture.js\":\"4ccc5dc1da4a5ade\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGestureActions.js\":\"59a77bccb667e1cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubRecognizer.js\":\"34be072032dde7b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/deletionGuard.js\":\"f0c1a050751c15a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dueQuery.js\":\"e33a8b772830b384\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/index.js\":\"6a47fafef46bd278\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/landing.js\":\"aa414082613a3687\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/localSchema.js\":\"193f1a074fd19e95\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/referenceDateAdapter.js\":\"a03ba3c89201ad99\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/rescheduleAction.js\":\"a91bf9286b13f99b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/schema.js\":\"a235cbc7eeb4d188\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadBlockDates.js\":\"bf3fe362fc02afb0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadDatesAction.js\":\"f4123faae8423d56\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/today.js\":\"1f3100e7b4baaa80\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"82f572cbc0e371e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"af3e64538d865813\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/audit.js\":\"a565523e58469d33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditAction.js\":\"bd1e17f39787aa4d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditRanges.js\":\"99bd800a25da18c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/diagnosticsSource.js\":\"6cc4f2673c806d20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/divergenceScan.js\":\"6855fc98bba3c789\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/index.js\":\"b92af6a6d226167e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ccbefe48146c89a4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/referencesMirror.js\":\"1b4513abbdb1d6ea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/rowJson.js\":\"f22db0fb805131ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/schedule.js\":\"9b4229de74d04046\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/store.js\":\"e196ac4682667c7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/action.js\":\"5732c45745307bef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/index.js\":\"3be8d71dbde5221b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/plugin.js\":\"a7ae08a208217f13\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c2e365e08f2953ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/actions.js\":\"5fdf63317f36f701\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/changeMarker.js\":\"d6bb26534a229a42\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/diagnostics.js\":\"590abfd561fe00ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/fileSystemAccess.js\":\"3df8994dfea61740\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/filenames.js\":\"b2bb01b3b596098e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/index.js\":\"d4cfeedfea767660\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/mirror.js\":\"dad4e0d58c89c7bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runLock.js\":\"799af9ad9ff9a79c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runtimeHealth.js\":\"481a25fe62878e78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/schedule.js\":\"8fbada37ce01c1cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/store.js\":\"f51fba75f112d1f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/index.js\":\"3726284bb7a0f7c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/themes.js\":\"130f5674b1a66782\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/facet.js\":\"3539c757907221c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/useDiagnostics.js\":\"fd044090a3f81492\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/dismissals.js\":\"3094b946feadc248\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/index.js\":\"81abedb4e578e4d5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/status.js\":\"f7aca6247879ca69\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/store.js\":\"4c5e33b0c9f17877\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"40d8b6dc1f62fbf9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0e908d528df893ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/actions.js\":\"01bcb847f4e8c471\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/config.js\":\"fceb62e789bc8ae0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/dataExtension.js\":\"42e0a7977fb170f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/effect.js\":\"55990b7c6e025873\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/index.js\":\"d3f233839229d77a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/propertyEditorOverride.js\":\"144d9665b7505ad3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/useToggleTree.js\":\"114467b943151e54\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/ExtractTypeDialog.js\":\"61f075e6e6005ba3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"24f2f126c6ab47d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/PropertyShapePicker.js\":\"f0b2c57e0237a342\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/action.js\":\"56dcaffebae3f87b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/index.js\":\"4b743d5277ba1532\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/FindReplaceDialog.js\":\"1f0080f20d103e12\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/HeaderItem.js\":\"b4a1603c13d2a1b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/dataExtension.js\":\"87af24caf8ea8ddb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/index.js\":\"233c44413bea4bf1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/search.js\":\"13f08208cc924021\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/toggleStore.js\":\"8fb421b59a7ece64\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/LocationPropertyEditor.js\":\"df59eb7f8bc0ad03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/MapView.js\":\"1bb40843e5ea1e44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/blockTypes.js\":\"f11c06feb86c0234\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/codeMirrorExtensions.js\":\"7028cd73a1993f88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/createOrFindPlace.js\":\"832adcfdc948b81a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/currentLocation.js\":\"1a2542f84924d5a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/dataExtension.js\":\"785a25ed364f412f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/geoContentDecorator.js\":\"63880523dd4af74a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/googlePlacesClient.js\":\"1094bafbd260ee25\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/index.js\":\"79f10ac1a0698e0b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/locationsPage.js\":\"ddd2a5d1296c3a77\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/mapViewport.js\":\"68e6e9953d27f64c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/pickCurrentLocation.js\":\"f4ee660c8626c54a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeAutocomplete.js\":\"9131f07e93442f1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeNameCollision.js\":\"07c0927ef9137331\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/properties.js\":\"1e7c95b62757f660\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/propertyEditorOverrides.js\":\"27973a1298a1d4a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/query.js\":\"54ae8d0963c3f8fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/usePlaceSearch.js\":\"b375c8878b9b8719\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6f9583beb0757322\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"59841e93db669505\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"039b8673e40be06d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/config.js\":\"8a51ffcd072e4cbe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/dataExtension.js\":\"5adc4432052603ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/facet.js\":\"d2ff8826205c773a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/grouping.js\":\"68a268455eab9d8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/index.js\":\"240d020fa4aa2404\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"18d420a1746f4d8a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/query.js\":\"af5e0087a588038d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/resolveConfig.js\":\"a9c132312d9f68a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"57148663f2decf46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c6cfa6abc8490686\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlDocumentContent.js\":\"0dc7824afc91bcfd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlFrame.js\":\"17f1555b559883b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/actions.js\":\"7aed32989c4a4da0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/blockType.js\":\"4e4c5a0c590f70b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/confirmRunScripts.js\":\"a097f63bbe48c502\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/dataExtension.js\":\"6bf7c8f2cd7e8608\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameAnnotations.js\":\"1ef9713d618706dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameDocument.js\":\"67f48ee8173d6315\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameTheme.js\":\"81d6f25d88a844f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/index.js\":\"31d8483e4ea61408\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/scriptConsent.js\":\"44e65cc3c7640661\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/sourceMap.js\":\"c0b805b959568621\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/useDocumentScripts.js\":\"710c515cd3f343cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/index.js\":\"120d365381d881d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/record.js\":\"afaac12bebbf6820\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/recordStore.js\":\"a6639497e8fe694b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/responsiveness.js\":\"7d1c515f2eb147b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/schedule.js\":\"5ba40517b44a565c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/sessionContext.js\":\"5f1c5bcc3f8aeaa6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d10b11e3ed14c67f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"16893e5d0747f3db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/actions.js\":\"e111d537f6da1f93\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/config.js\":\"9b582f3c3b2c605f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/dataExtension.js\":\"1f4cfee382515ca5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/effect.js\":\"d7d35b5342552ded\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/index.js\":\"0d269428e82efa7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/keyCapture.js\":\"43416eaec064b772\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/overrideStore.js\":\"50243edd1919825e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"40acfadb129b3659\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/HeaderItem.js\":\"8d746aad1acc337a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/LeftSidebar.js\":\"488014336a476930\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/actions.js\":\"94a352f227c6a608\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/facet.js\":\"d7230246eb7b41ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/index.js\":\"a4598d3870008421\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/shortcuts.js\":\"5c8143df83ffcd57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/toggleStore.js\":\"360e082c79385654\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/MergePicker.js\":\"51e0ea572dd83f10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/index.js\":\"858020036e4c12bc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/mergeAction.js\":\"79677455d02a6c92\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/strategy.js\":\"2c6f8822174be0d1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/Button.js\":\"b66f82af1e8af24c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a52aac98d1440fcc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a81814afabcb392c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/facet.js\":\"255113c94a31ebbd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/index.js\":\"da02c9b0324ccc03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d998e99de2267c19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0fd08f343ae72713\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3503e4b8dc28b055\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b243785ef588d775\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/index.js\":\"677d7ff407b14a35\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ef2ed7585d61633f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1a2b776d4482d185\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/contextMenuItem.js\":\"534210e90a360478\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/index.js\":\"29f8bfc5f3ec2082\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveAction.js\":\"bd1786654ff69751\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveBlocks.js\":\"aea2697688b1093e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/selectionAfterMove.js\":\"a16c73c946981b54\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/TutorialBanner.js\":\"ae8f29a57857bdbd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/action.js\":\"2f83cb6167952db1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/bannerDismissal.js\":\"aed486c8a083c38e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/documents/cheatSheet.js\":\"449948cc6f055e57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/index.js\":\"22b95cb0cf26ab3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/keys.js\":\"e4990d872c4abaef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/landing.js\":\"c9e77f7d7b048e29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/outline.js\":\"64a64e6543bb6652\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/seed.js\":\"cc8eec6ff6176769\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f05a85a1966e53cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/analyze.js\":\"38486bbfc280eb44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/diagnosticsSource.js\":\"94b051974f3ec81a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/index.js\":\"07f80068cd44dca2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/load.js\":\"b3f455a8022b20c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/monitorRun.js\":\"97bbd623a9dd586a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/schedule.js\":\"b57b234750c297f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/series.js\":\"3ff4bc1cf33e5b10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/store.js\":\"9c30fb28d4d6f24e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/trendAction.js\":\"dccba8523677d1e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/verdict.js\":\"d2b7f55b21f75524\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/clickToEditAction.js\":\"00f0fb7e34261fe0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/index.js\":\"84145c7506b867b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/interactions.js\":\"53ff7fa8b32787ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"85ddc5865f79b7c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGate.js\":\"35fd743d49daf04b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGateDialog.js\":\"ee65fc2481393dc7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/action.js\":\"c4696106229c8488\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/index.js\":\"8ce8b83ff281e503\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/localRunMessage.js\":\"1cada80561f15a63\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/plugin.js\":\"f39a011d7ecdad15\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/progressReport.js\":\"989223e0764f1fce\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/sweepProgress.js\":\"8a3786be760fd328\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/FieldRowRenderer.js\":\"92d8ade894a09f32\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/ValueRowRenderer.js\":\"31dddf6442f9a061\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/actions.js\":\"0cc16e98e68b792c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/autocomplete.js\":\"7e90cd4a037bc103\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/fieldRow.js\":\"a4720884c37878f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/index.js\":\"3b84f982b4a30248\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/referenceWarning.js\":\"cee0141625bcda88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueAutocomplete.js\":\"4e1c9fab64c9330e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueSchema.js\":\"6a32631dfe0796d4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/HeaderItem.js\":\"b904b9c0cb7438d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/QuickFind.js\":\"88f66928b0b86943\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/index.js\":\"2a44b189ff6ef1c9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/recents.js\":\"a4d4b95ba6a60d22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/resultItems.js\":\"606562772706b88f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/selection.js\":\"728765b742767d1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/toggleStore.js\":\"b002e5aec929d0cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/HeaderItem.js\":\"8d0ae8ac08fc03f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dd04bf6a03f4059c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/grouping.js\":\"1c673d78849ec59f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/index.js\":\"d99d85ef6edfe542\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/target.js\":\"967e2135ee152c5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/codeMirrorExtensions.js\":\"fd954ceabcbcbad3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/contentPrefill.js\":\"cab0d11a150cc482\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/dataExtension.js\":\"8a9c08ddf6857a58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/index.js\":\"e3572301e4a7f760\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d8261f69db7fe6c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/invalidation.js\":\"a67e5310cf98746c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/localSchema.js\":\"708fb57d283b4d28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/index.js\":\"b3e9ec75ea60a617\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"435e1677be07e429\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/index.js\":\"7ed66e6382733c4d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/referenceNode.js\":\"69d95bed12ee9fe5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/remark-reference-occurrences.js\":\"42eb23335fb59079\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c5b6fc08e120bcc9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/index.js\":\"4af4eb442b58af09\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"27d5ab91a631840e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5438bf3082c557c6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/mergeRetargetProcessor.js\":\"b4bec62813b64220\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/parseFence.js\":\"cbf7454c63753e7d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceParser.js\":\"b74cba61bf29cca9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceProjection.js\":\"4c3d9fcca83133c4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referencesProcessor.js\":\"7e95fac568361195\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/renameProcessor.js\":\"b72896a251430a8e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/spanReplacement.js\":\"77e9853e1f791a1c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/htmlToOutline.js\":\"0562c369ba3697ef\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/index.js\":\"6dff32d54c9d294d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ecdce61091f1edcd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/pasteDecision.js\":\"378ddb397aa373af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/action.js\":\"bbb31e123e814d85\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/blockIds.js\":\"048670e089ecef96\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/content.js\":\"298bbd2493459897\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/effect.js\":\"b8cce096f3ce2b8a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/ids.js\":\"e02297b17fb2af7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/import.js\":\"dd8f6c9fc4d5d992\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/index.js\":\"ff6b402527410b08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plan.js\":\"5deb14dbd040e277\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plugin.js\":\"c12129fed4198b1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/promotion.js\":\"4a76d358904efb77\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/properties.js\":\"3d28f28ece1af00e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/references.js\":\"3ed3230dc0e25a04\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/report.js\":\"6748fb0b898fadc8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/roamMemo.js\":\"af9eec8db0dc5847\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/runtime.js\":\"9f1f17f3073874d8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/schemaReconciliation.js\":\"72c38fefc1757701\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/srsMarkers.js\":\"b99b48521b3f0256\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/todo.js\":\"df407734b4369dbf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/typeCandidates.js\":\"28f3486294d257bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/types.js\":\"1f7fe4aab42efefd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/index.js\":\"c2a212720dd05f5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/store.js\":\"11693972c563dd03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/HeaderItem.js\":\"5fd7db85888167d1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f9d9bf54124615a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/index.js\":\"c66058cc01791040\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/model.js\":\"5a01052a4763fd3d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/toggleStore.js\":\"3a688bab24642772\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/useKeyInspector.js\":\"3f8786c2d32241b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bd7947dabedeb061\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/ShellDecorator.js\":\"9b44cab54630fa67\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/actions.js\":\"fccccb00c0b449d4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/exclusionsFacet.js\":\"249791cb003d9747\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/index.js\":\"c12116b36de7379c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/shell.js\":\"455f82ce9b14c52d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/surface.js\":\"159de7b97bcf8d19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/walker.js\":\"97d9a284acddb071\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/RescheduleToast.js\":\"52854453a460f6f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/dataExtension.js\":\"d72015ad1f6c9cf1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/index.js\":\"a1c9f05f746abb8b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/indicator.js\":\"36f9af5e20dfa6d5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/moveSrsState.js\":\"0781af2ad1ffc25c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f595d85452ac4a41\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/scheduler.js\":\"57aec44282ad6654\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/schema.js\":\"a0707347a81c1ae0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"086c7bf6848d7296\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsClipboard.js\":\"2f95720e4625536e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d8a15c5df9ee940b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DailyNoteReviewHint.js\":\"96b4b93677a3bb4c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DeckPicker.js\":\"5395c3a096dc7ee4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewControls.js\":\"adc1606915908bca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewDeckRenderer.js\":\"01e283719a6deabd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewSession.js\":\"b9c30da313541541\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/actions.js\":\"0f3be8b4de303f47\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/archive.js\":\"0d26dba2ffb5bdcd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dataExtension.js\":\"a58a9605dd2c7e60\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/deck.js\":\"fbb01dd3f8408b24\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dueQuery.js\":\"154ba44a2eee5da8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/gradeDecision.js\":\"9c0a815eae0e81e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/index.js\":\"53e7712f7f7f0594\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/keyHints.js\":\"3832e44308a7cd69\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewCardLayout.js\":\"d974a44a106e0f26\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewProgress.js\":\"88ffeb5b898ab367\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/schema.js\":\"31209317aa9d19e2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/useDueCards.js\":\"287226a768de2a7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/index.js\":\"33b25c179044233a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/record.js\":\"622430e11be4ef79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/index.js\":\"f3187f563560798c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/persistenceStatus.js\":\"cac84417b2df1a52\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/requestAction.js\":\"eaa7baa4099996ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/TypeChipsDecorator.js\":\"8873383a7d56c643\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/codeMirrorExtensions.js\":\"6b0d3e9196ecaac7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/index.js\":\"dbdc4620335887b1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/typeAutocomplete.js\":\"cf8ccaaf4e929948\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0312e9c65e5d67d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/actions.js\":\"160356617a0f784b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/anchor.js\":\"e0a0e9520230560d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/events.js\":\"65215ac2e4c454c7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/gestureActions.js\":\"31203b11b71ddd11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/index.js\":\"b5dc3c74511af7e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"31aa376ae613b544\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/collect.js\":\"eb60ec6a6cccd14a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/index.js\":\"dfa9afa3f8da4be1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/record.js\":\"86569bbbb0db50d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/RejectionDialog.js\":\"5f8a6f9ce9eca7f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/SystemStatusHeaderItem.js\":\"90cefb4657906a0b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/index.js\":\"357a35fd1baebab7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/model.js\":\"2eb72cd7ba55c6d2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/queueCounts.js\":\"04d6d41ae11d0d56\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rejectedHelpers.js\":\"2147bff965255139\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rematerializeAction.js\":\"fd6bc6f18feb7a20\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/useHysteresis.js\":\"281625f82da86aa9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/effect.js\":\"e630ec5cb5112e8e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/index.js\":\"c20db235ebaa8aa8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/theme.js\":\"c8bcb8aa228cbd18\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/actions.js\":\"a7327cba146dac35\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/dataExtension.js\":\"7624a20d980ff5d4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/index.js\":\"c745dbd2334f2928\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/schema.js\":\"d7de18c8cfadb84f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3f7f8c5dc49ebdf7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/actions.js\":\"1135fa9063f08ab7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/defaultItems.js\":\"9b8500fc1e22ec56\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/facet.js\":\"48994042c59944d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/holdRecognizer.js\":\"547d3db315c145a6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/index.js\":\"a81950ee8088385d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/UpdateIndicator.js\":\"f331e825e846584f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/index.js\":\"9ffecac3a3a91b6d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/loadTimes.js\":\"95413f762f7e71e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoNotesRenderer.js\":\"fbfcb05a297cfc8e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoPlayerRenderer.js\":\"c3126683d8e8d020\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoTimeStamp.js\":\"3489ff3d247cdce1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/actions.js\":\"6f19ea795e6ccb5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/index.js\":\"b63ec4fd1c9752ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/markdown.js\":\"917a4a2c777b864a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/notes.js\":\"34fc3b1536d63ad6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/registry.js\":\"94dd4b5a1f50875a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/remark-timestamps.js\":\"be595663a1a55696\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/view.js\":\"85e418aa7f5bd920\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/LinkHints.js\":\"f71b022a80cce349\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/index.js\":\"0917c3f44fdc319f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/model.js\":\"daec89650186dbea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/settings.js\":\"0e04000ab63a2e3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/actions.js\":\"a04171c8725dc5cd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/index.js\":\"7424b4edbf08f203\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/interactions.js\":\"4622bec58ee5c878\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/workspace-header/index.js\":\"4f811e75335eb6a8\",\"/knowledge-medium/pr-preview/pr-1789/src/registerServiceWorker.js\":\"4ceb92414584fdca\",\"/knowledge-medium/pr-preview/pr-1789/src/requestPersistentStorage.js\":\"dff92de3c41445f8\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authRequestDeadline.js\":\"c1387ab9aab7f9c3\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authStorage.js\":\"8e65a0ac2e60bad4\",\"/knowledge-medium/pr-preview/pr-1789/src/services/powersync.js\":\"14ebd022d632281a\",\"/knowledge-medium/pr-preview/pr-1789/src/services/supabase.js\":\"425083199b5d2a99\",\"/knowledge-medium/pr-preview/pr-1789/src/services/uploadErrorClassifier.js\":\"f5962e271aad2c83\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/ActiveContexts.js\":\"86fb1580400e5179\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/HotkeyReconciler.js\":\"23125a5774a74540\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/WipeLocalDataDialog.js\":\"2d9c93775697c077\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionDispatch.js\":\"28990c9d761757aa\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionRefItems.js\":\"08796c7a44f756b3\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/applyKeybindingOverrides.js\":\"db6f22435c32c9f1\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/blockActions.js\":\"12455bef00adb613\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/canonicalizeChord.js\":\"8f54c1748ab8f95e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultContexts.js\":\"7bfd2ce512648bb4\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultShortcuts.js\":\"e2eebeeccf168fdc\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/effectiveActions.js\":\"4999dc46fbc61bca\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureAction.js\":\"95400bb5c771dae0\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureBinding.js\":\"481b4650406c4fd3\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/holdRegistry.js\":\"9dca66443956300a\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingConflicts.js\":\"948d41965a4610c4\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingOverrides.js\":\"54453dfb4e7b7539\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/pointerAction.js\":\"de861336569ec74e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/resolve.js\":\"c235f1a412228b9b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/runAction.js\":\"09ff1de9cf1c6124\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/sequenceMatcher.js\":\"5ac479d72a0135e5\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/types.js\":\"a536141639336695\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionContext.js\":\"9981d1640e30122e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionDiscovery.js\":\"bd341df03e0d23e9\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/utils.js\":\"94af2117f5d8b4f8\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/bootStore.js\":\"0a85d3329dc6a73e\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/previewDatabases.js\":\"ad093b1a7b7b1205\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/byteTransform.js\":\"2f75e643d151ecca\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/attachmentCleaner.js\":\"598a3ddd496be736\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/attachmentParts.js\":\"01c7642d9b780827\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleParts.js\":\"e3717962ea14971a\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleRecord.js\":\"6123254ecbb746de\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/manifest.js\":\"52f49f830a5e8db6\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/takeBundle.js\":\"bc58cfd890ac3dd0\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/verifyBundle.js\":\"f3b7327874f557bd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/cleaningStage.js\":\"e35bbe5fa3f58213\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionKey.js\":\"45e0f8daf5b9ed75\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionServer.js\":\"e39d087dd0ea0f4e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flip.js\":\"c6a21e60e808b803\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flipAttempts.js\":\"1f818635ed47bb79\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/pages.js\":\"00eef1bc69dc4265\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/preflight.js\":\"cbbaba0e2857fc8d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/reseal.js\":\"7d1c1fa70f0fce1a\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runConversion.js\":\"95783323f917fe98\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runLock.js\":\"5b2b31f0358c4776\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealing.js\":\"b4a7eae168af0974\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealingStage.js\":\"351e6062183783cc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/stage.js\":\"c59530fde87803a1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/verifyReseal.js\":\"d233f34cc93f613d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aad.js\":\"f1d81cbb7e5da5e2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aead.js\":\"3066da45b7915867\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base32.js\":\"dbc1b45aeb9184a9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base64url.js\":\"831f748680c8877b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/binaryEnvelope.js\":\"b526dec050a6d3f6\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/byteAead.js\":\"e4e6bc6b2737d24b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/canary.js\":\"fbd2069dcbe30feb\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentHash.js\":\"5e64ff537784836c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentKey.js\":\"30ec357172e1dfcd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/derivedIdNamespace.js\":\"704c7da71bbc24d3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/envelope.js\":\"99d9e714ed2e34cd\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/hex.js\":\"3703e3cb2ce6552a\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/sha256Hex.js\":\"be1457ca64af93c1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/workspaceKey.js\":\"a669df89376de5a2\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/conversionState.js\":\"65f86ec71e230fc6\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/createEncryptedWorkspace.js\":\"37fb4c5496a26e62\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/pastedKey.js\":\"4758f96ebf3cdfae\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"282803fbf0e172b8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/upgradeWorkspacePin.js\":\"08b7fe9e053cc2ce\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/keyStore.js\":\"29226738d5a92b42\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/mintWorkspaceKey.js\":\"25ba26b65375560d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/modePin.js\":\"a39a28c5bd757492\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/openWorkspaceKeys.js\":\"1505197780fdc4c3\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolveWorkspaceEntry.js\":\"f103d377dff629a4\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolver.js\":\"3492d48a7c8e019c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/workspaceAccess.js\":\"c3b3a45b21409d88\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/transform.js\":\"2cced9cb6b897990\",\"/knowledge-medium/pr-preview/pr-1789/src/themeBootDefaults.js\":\"38edc40b3d4b1e8f\",\"/knowledge-medium/pr-preview/pr-1789/src/types.js\":\"dc81aea7167eaa3a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/ClientLocalSettings.js\":\"72651b200e426d46\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/abortableSleep.js\":\"cd3455a87362d53d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/array.js\":\"25433bff7f6b5872\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/backlinkAutocomplete.js\":\"5b8cd9ae0be1a7ed\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockCrumbs.js\":\"da7549e4d6230957\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockrefAutocomplete.js\":\"63f50db6d45909ea\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/cadencedIdleJob.js\":\"bbcaa7d162f541c5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/callbackSet.js\":\"ab41196ffe9fc866\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/clientId.js\":\"fe7832ca33c0a672\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirror.js\":\"e88d0d81d6bd2406\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirrorCompletion.js\":\"7208fbf237a3dbd7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/copy.js\":\"98a4dfc216548b05\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dailyPage.js\":\"d892c16c25f56c68\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensics.js\":\"4eb65c431503ec34\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensicsHooks.js\":\"fc2e07562eee40e8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/deleteBlockThroughUi.js\":\"bd2ea7c246b1e527\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dialogs.js\":\"f2ff11f40cc831f9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dom.js\":\"6fdb39a4e797279a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/downloadBlob.js\":\"2ded785bba1c37e1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/exportSqliteDb.js\":\"d7051729413ed3ba\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fileSystemAccess.js\":\"e981f01e9787d3a7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/flipSlide.js\":\"9fc55254b5e25612\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fnv1a.js\":\"fac0a42afeabe1e4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/formatBytes.js\":\"0181aa3c7822ea6d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fuzzyRank.js\":\"2781b90bf56f372a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idbKeyedStore.js\":\"1ece1cd7107ada44\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idleCallbackPolyfill.js\":\"4316a84339166dcb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardAwareScroll.js\":\"8b0177babc45d189\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardViewport.js\":\"62508b4227fc4a94\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/lastWorkspace.js\":\"1f35b1ab53413b5d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutColumns.js\":\"c708592ef3c0d660\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionDom.js\":\"2e9f75214dd77e67\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionId.js\":\"b04b4a79b7f49593\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkClickGestures.js\":\"543a8f47eb7395f2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkTargetAutocomplete.js\":\"8bbce66eaf5ecaa6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbCorruption.js\":\"0dd5bf75f6b785af\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbRecovery.js\":\"c3c8e6e48e6fa696\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/markdownParser.js\":\"e5fef7229746d1f7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/memoize.js\":\"2eca62fb72b06c9c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameFieldCommit.js\":\"86c830f7ebe959fd\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameList.js\":\"6d1cafb2ffe8a204\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/navigation.js\":\"3f3dd2959a641526\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/omnilinerNamespace.js\":\"67e27418cfbfc12f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/opfsPageScan.js\":\"0484777d4d1ee7a9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelClearance.js\":\"56c92c56e0f98133\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelHistory.js\":\"412570c3fbb9e3bb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLanes.js\":\"0551e2d94e25b432\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLayoutProjection.js\":\"170c93198304651a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelScrollAnchor.js\":\"b72530ff180b8d65\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelUrlFlags.js\":\"8a5931e09eda0538\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/platform.js\":\"c8c678face034935\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/pluralize.js\":\"1a6c6831a84e8e0a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyCreation.js\":\"f92c2ef9046101f8\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyNavigation.js\":\"5d632e6a78f89a3e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyValueContext.js\":\"b9e51e519d0c74e2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/react.js\":\"50ce280c0accee10\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeDate.js\":\"6ad6348e0b1a7ca9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeTime.js\":\"c1eeb1dfe7846a57\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/renderScope.js\":\"6f6c6e6c3993fe4c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/resolvedThenable.js\":\"d54bd1c0eade277a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/routing.js\":\"3c9d072dfd7a4171\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/safeMode.js\":\"e7e99c19297f9f23\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/scheduleIdle.js\":\"762d8fe1b9c408b4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/screenWakeLock.js\":\"8062aa52ab46ddd0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/selection.js\":\"4096069ce6409674\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/softKeyboardGrab.js\":\"5eb25a7e28ef1b88\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/startupTimeline.js\":\"1bb1d299fcbc2324\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/state.js\":\"ac76918375ce8341\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/string.js\":\"4e8ee8b03186166c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/surfaceZoom.js\":\"cf8fc20a2ea2850a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/time.js\":\"9abb8c4779480414\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toast.js\":\"59ac7f3915dbca11\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toggleStore.js\":\"3ecb5c25004e83da\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/untilStopped.js\":\"0730a16347fef938\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/userActivity.js\":\"1051d5042bf3dbf1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewTransition.js\":\"b57523832151bab0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewport.js\":\"eb368fe74be3c3bd\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/webLock.js\":\"8eec9f63830f7e37\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceRecovery.js\":\"41900e7421b0d7cc\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceSnapshotStore.js\":\"ed84f16b09784289\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-compiler-runtime.js\":\"f79c4f6c2fbe7d89\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-client.js\":\"75cafc9a92eb6559\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server-edge.js\":\"aa1ade89e2b10995\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server.js\":\"22848afc7869a382\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static-edge.js\":\"0ef108878e6801b6\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static.js\":\"b1bd1b2cba5461eb\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-test-utils.js\":\"786091d8385cc743\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom.js\":\"eace550f2e674746\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-runtime.js\":\"a5b9e708d336731c\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react.js\":\"31f910cd207a1984\",\"/knowledge-medium/pr-preview/pr-1789/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
