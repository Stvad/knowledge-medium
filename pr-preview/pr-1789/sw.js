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
		buildId: "5ae82381ecaf-2c209021",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/\":\"aa047f7a61a65753\",\"/knowledge-medium/pr-preview/pr-1789/index.html\":\"aa047f7a61a65753\",\"/knowledge-medium/pr-preview/pr-1789/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1789/assets/FacadeVFS-d-meU7VW.js\":\"feb96d86bea97ea8\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSCoopSyncVFS-DOCNXPTE.js\":\"27dd6ca5f860d57b\",\"/knowledge-medium/pr-preview/pr-1789/assets/OPFSWriteAheadVFS-BzKWHlPP.js\":\"463234c5410aba64\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-async-BMA25nbU.js\":\"354886514429fcb3\",\"/knowledge-medium/pr-preview/pr-1789/assets/wa-sqlite-kPYo55fK.js\":\"9ae83449ab2d0344\",\"/knowledge-medium/pr-preview/pr-1789/assets/worker-Dy_qnQht.js\":\"c59d6a5c9bb1e1d5\",\"/knowledge-medium/pr-preview/pr-1789/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1789/chunks/app-CU0-BBhH.js\":\"a1903e2fa85832fb\",\"/knowledge-medium/pr-preview/pr-1789/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1789/index.js\":\"d65757d537526d73\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1789/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1789/assets/AccessHandlePoolVFS-DwPvG84U.js\":\"660b29f9c9177a6b\",\"/knowledge-medium/pr-preview/pr-1789/assets/IDBBatchAtomicVFS-ioIc0pd4.js\":\"036bd21c1ba0e321\",\"/knowledge-medium/pr-preview/pr-1789/assets/MemoryVFS-CpOZQGl3.js\":\"6ccab0d635691d0f\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-C7RFgCwx.js\":\"752467c93608624d\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-B-Ch6wmT.js\":\"7706a6c5b62692f7\",\"/knowledge-medium/pr-preview/pr-1789/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1789/chunks/AccessHandlePoolVFS-DReTB9Pm.js\":\"2c104332e61d13d3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/FacadeVFS-DdVEkuoE.js\":\"20ccab8be659d846\",\"/knowledge-medium/pr-preview/pr-1789/chunks/IDBBatchAtomicVFS-BA3z9NNv.js\":\"7ffc873ee17ae38b\",\"/knowledge-medium/pr-preview/pr-1789/chunks/MemoryVFS-BsrVWVYs.js\":\"2af28b1a7beea23c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSCoopSyncVFS-D3KFTrj-.js\":\"14f405e84915e3af\",\"/knowledge-medium/pr-preview/pr-1789/chunks/OPFSWriteAheadVFS-L8FXgHoi.js\":\"5599355ae357e8df\",\"/knowledge-medium/pr-preview/pr-1789/chunks/Preview-DHYPOWH6.js\":\"b204d78c28c5bb45\",\"/knowledge-medium/pr-preview/pr-1789/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/card-CfaF5RLu.js\":\"96aae1f39661788a\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/dist-D9fLn99T.js\":\"64cc4090a3f7d8c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-Dz1hn0fU.js\":\"b0ab2be8c64b7c5e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/mc-wa-sqlite-async-D5F0ArBL.js\":\"7eecdd4af4d9e5c8\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-B5K-CwBL.js\":\"d83f4d6d84d8f07e\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-BkLMub3z.js\":\"09bf20dd332a7cdb\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CLItXqvG.js\":\"f6a395fc4ed77a3f\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-CkPr0Q97.js\":\"e21b2018570634b3\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-D7mNkwzh.js\":\"8e71675909def680\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-N1EZ-QML.js\":\"b4d501cffba0e5fc\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-XHvsUOP3.js\":\"5090d8f30845fe7c\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server-legacy.browser.production-BZcXpDSO.js\":\"fdfa1d8cc7240c96\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.browser.production-Beb_NPDP.js\":\"a561e7e277115790\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-dom-server.edge.production-Byp0mguN.js\":\"77aff5b0ec3ec339\",\"/knowledge-medium/pr-preview/pr-1789/chunks/react-p03I41hC.js\":\"b4233a30f09cbb30\",\"/knowledge-medium/pr-preview/pr-1789/chunks/server.browser-Bc87w4y2.js\":\"2646b51bbb24f545\",\"/knowledge-medium/pr-preview/pr-1789/chunks/textarea-Dw2I5KEL.js\":\"0e49548433f1af15\",\"/knowledge-medium/pr-preview/pr-1789/chunks/ui-BG3jn-y1.js\":\"a12d95086b6c1e64\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-DF2ZsgOn.js\":\"25c5909413dd88fe\",\"/knowledge-medium/pr-preview/pr-1789/chunks/wa-sqlite-async-CSXkvVqY.js\":\"623aad82ffdd3ff2\",\"/knowledge-medium/pr-preview/pr-1789/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1789/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1789/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1789/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1789/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1789/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1789/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1789/src/App.js\":\"ae60aa29ce586857\",\"/knowledge-medium/pr-preview/pr-1789/src/appUpdate.js\":\"a3f9b8af14858e10\",\"/knowledge-medium/pr-preview/pr-1789/src/appVersion.js\":\"d0a318962a75e760\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/initialLayout.js\":\"e3c3d06179b6776e\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/openWorkspaceData.js\":\"0279a492d5bbd915\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/resolveWorkspace.js\":\"8f6108788df3941e\",\"/knowledge-medium/pr-preview/pr-1789/src/bootstrap/workspaceBootstrap.js\":\"2872e72f650fc1bf\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockComponent.js\":\"e606455fcf509f88\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockCrumbs.js\":\"5b04cec30f705524\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockEditor.js\":\"4bc77d58a094cc22\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockLoadingPlaceholder.js\":\"b3647a487f616c6c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockProperties.js\":\"493a3e60cffbaf3d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/BlockSearchPicker.js\":\"5f9d30e7a6769e34\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ConfirmBulkDeleteDialog.js\":\"da84c03f4c7f23d3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DividerHandle.js\":\"72e810ff631ccd93\",\"/knowledge-medium/pr-preview/pr-1789/src/components/DraftEditor.js\":\"043723792846911e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/GutterPill.js\":\"0b1509627c7044b8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Header.js\":\"c17c00716df0608c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/LazyBlockComponent.js\":\"6ffafce335a96c68\",\"/knowledge-medium/pr-preview/pr-1789/src/components/Login.js\":\"74c08bf17a01e09e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ZoomableSurface.js\":\"369ef435282e6da0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/editModeKeepalive.js\":\"26fdc0858c6c33ca\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9855602780cfe5a8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4635d53e50092d72\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefPropertyEditor.js\":\"98b4e9ef9845554b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/RefTargetTypePicker.js\":\"5be6976369b9591c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/SelectPropertyEditor.js\":\"7eb7ca0e84eea110\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/TypesPropertyEditor.js\":\"e469d5cb1bce69e4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/defaults.js\":\"308ac6bdb36f4138\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/kernelValuePresets.js\":\"ad6771dcfaa01af0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/selectablePresets.js\":\"d8e021a0e233557e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyEditors/typesPropertyUi.js\":\"57f519786eb76cdc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/AddPropertyForm.js\":\"fabbf6108e2b72d9\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyPicker.js\":\"6ce56fd661ca258a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/PropertyRow.js\":\"f33b5958cd850636\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/Rows.js\":\"10dff0595798a402\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/actions.js\":\"467e7943e13a1fdd\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/declarationOnly.js\":\"42dc1c7c8d0555f6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/layout.js\":\"8329a53d4fe00f7e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/model.js\":\"42731b9ed91c3e9e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapeUi.js\":\"95c4db8013b36e3c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/shapes.js\":\"6c9aae62684eebca\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/usePropertyEditingActivation.js\":\"45df3de3137d4c2a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanel/visibility.js\":\"918c7eb740994139\",\"/knowledge-medium/pr-preview/pr-1789/src/components/propertyPanelSections.js\":\"e325efb1800013ef\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockEmbed.js\":\"ea4916a154694e01\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockLink.js\":\"f5b40eba1b66b9d3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/BlockRef.js\":\"bb869a636bc0ad3f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/ReferenceLink.js\":\"221b0b7862090bb6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuard.js\":\"2cf3ee43b5385d09\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/cycleGuardContext.js\":\"f7d0e1e5a5da169f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/linkInteraction.js\":\"9257d98eccda4bb3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/referenceLayout.js\":\"b86c2d2840520587\",\"/knowledge-medium/pr-preview/pr-1789/src/components/references/useBlockRefAncestors.js\":\"b6a1e05b343414c6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockGutter.js\":\"55347873b972a2f4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockInfoDialog.js\":\"d67ddf82263f1091\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BlockTypeBlockRenderer.js\":\"c010a87312ab3f45\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/BulletHoverCard.js\":\"560143d86a3758e6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorContentRenderer.js\":\"8c703d0b4fa1ea8e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f25291cdf965c46e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ColumnResizeHandles.js\":\"33eff0526f97800c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"201c21a169f6d6e3\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/DefaultBlockRenderer.js\":\"133fa3c16f62b0a6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/LayoutRenderer.js\":\"1eb1bb6c97a9791f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MarkdownContentRenderer.js\":\"b79c035b7dd51b9b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/MissingDataRenderer.js\":\"8cd08c5f957bda40\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PanelRenderer.js\":\"e419801b86c2743b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e866c26c935aacb6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/TopLevelRenderer.js\":\"b4af515046cbca2d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockGutterMode.js\":\"e28395321af600b0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/blockTitleText.js\":\"8922f259401ffb2d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/fieldCreationKeydown.js\":\"4a5a5f317e8a4bbb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/renderer/layoutRootContext.js\":\"22d675179376f8be\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/TypeChip.js\":\"b2bdf1458d7487a2\",\"/knowledge-medium/pr-preview/pr-1789/src/components/typeChip/chipStyle.js\":\"0d8baef5799a7f00\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/anchored-floating.js\":\"8527f0c646fa123e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/button.js\":\"9be2e52877f81ea8\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/card.js\":\"5703ae195ca9e184\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/checkbox.js\":\"a1782b7bcc5e8158\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/collapsible.js\":\"6cee8bd610ed1e7a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/command.js\":\"5a994f8019fa3f03\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/context-menu.js\":\"f913878b15b6bb4c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dialog.js\":\"b7da722256416cfa\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/dropdown-menu.js\":\"112f17bf05f6a66d\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/floating-listbox.js\":\"99883fc056fa2b8e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/index.js\":\"2c9068531ccc38b0\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/input.js\":\"db94be1c32af7590\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/kbd.js\":\"f92151406324ba11\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/label.js\":\"555dcdb87ca8c596\",\"/knowledge-medium/pr-preview/pr-1789/src/components/ui/textarea.js\":\"fc4c97bb93d595ca\",\"/knowledge-medium/pr-preview/pr-1789/src/components/useEditModeYieldKeepalive.js\":\"6ff2943a814099ae\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/BootFallback.js\":\"13b5aa09748aca53\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/FocusedRowLazyMount.js\":\"408d4d7963da8013\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LazyViewportMount.js\":\"95b6cf5db5b9ece5\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/LocalDbCorruptionFallback.js\":\"0209c30e8277a845\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/error.js\":\"fdaf66cffe19f3fc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/lazyMountRegistry.js\":\"fd766294c0e7dd0a\",\"/knowledge-medium/pr-preview/pr-1789/src/components/util/suspense.js\":\"f7520a2d535e1f75\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/CreateWorkspaceDialog.js\":\"fddb38b2e362c4bc\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/PendingInvitations.js\":\"85f0dbdb7bf0f69c\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/SyncProgress.js\":\"8fc334739c3f4afa\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/UnlockProgress.js\":\"683488bbd180778f\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceKeyGate.js\":\"bc3815ea4135afca\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSettingsDialog.js\":\"3bc40f5090d0c2b4\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSwitcher.js\":\"ee76bf0271788160\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/WorkspaceSyncGate.js\":\"dd072dcbf049769e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlow.js\":\"4aadba6b5eb60e1b\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/ConversionFlowHost.js\":\"9c476fc9eea36435\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/EncryptionSection.js\":\"980f480b1e155d59\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/attachmentPrompts.js\":\"f6db1a6d49a1074e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4c4e16b865d6dcc6\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowDeps.js\":\"abe6f1aa7c1751da\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/conversionFlowStore.js\":\"ed1b79a57c13f56e\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/flowUi.js\":\"35fbbddc651e87b7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/conversion/useConversionRun.js\":\"533c01a8a6290ffb\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/keyUi.js\":\"265de133e4d93112\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnKeyLoss.js\":\"f896a20c0cd90ff7\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/useCloseOnServerE2ee.js\":\"1f1fb53b5ff48391\",\"/knowledge-medium/pr-preview/pr-1789/src/components/workspace/workspaceUnlocked.js\":\"9e0cf4e900db02cd\",\"/knowledge-medium/pr-preview/pr-1789/src/context/backgroundSubtree.js\":\"fe2d23fa254e1fae\",\"/knowledge-medium/pr-preview/pr-1789/src/context/block.js\":\"0c5819e5e6c2654b\",\"/knowledge-medium/pr-preview/pr-1789/src/context/layoutWsContext.js\":\"d08459394083ea7a\",\"/knowledge-medium/pr-preview/pr-1789/src/context/propertyDisplay.js\":\"b9c489ec6ed2176f\",\"/knowledge-medium/pr-preview/pr-1789/src/context/repo.js\":\"9f4aed0caf5b48ce\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasClaim.js\":\"2844041bf8a5f15b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/aliasSeatNamespace.js\":\"5bd1dc5fe4f928ba\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockData.js\":\"9669db8204663a93\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/blockType.js\":\"7a23dfbb797a43f0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/changeScope.js\":\"879b87c56fcbb551\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/codecs.js\":\"7f38d5b8f4768ca7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/derivedData.js\":\"291aa08195256dfe\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/errors.js\":\"31b93e2138ec6c16\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/events.js\":\"c73bf2f0d8a532c7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/handle.js\":\"f926d0814ca21486\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/index.js\":\"e9f28d4fac1f3021\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/mutator.js\":\"9b6890cf4cdf8952\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/processor.js\":\"f66f308de227cd2c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/propertySchema.js\":\"3da26e94097e79aa\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/query.js\":\"689719fc2cd342e6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/sameTxProcessor.js\":\"e537c5fd540361ae\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/schema.js\":\"f926d0814ca21486\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/tx.js\":\"f926d0814ca21486\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/typedBlockQuery.js\":\"d7310b022ec46e6c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/user.js\":\"98ca28a5c4ef5640\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresetCore.js\":\"cfaed89e1f00a1e0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/api/valuePresets.js\":\"d0ad4d7d667d1348\",\"/knowledge-medium/pr-preview/pr-1789/src/data/attachmentCleanerIOVerb.js\":\"dc80eb4d2ec81f6c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/block.js\":\"e5e5a22a8ed7a3c6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockCache.js\":\"df54e9ff70e5db3c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockId.js\":\"44dad74906d2983b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockLiveness.js\":\"bc6eab7c67de302f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockMerge.js\":\"52e824d0eec44adc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockSchema.js\":\"bf0e7ebcd8b62a58\",\"/knowledge-medium/pr-preview/pr-1789/src/data/blockTypes.js\":\"c4442b357d1538ce\",\"/knowledge-medium/pr-preview/pr-1789/src/data/clientContext.js\":\"10727e897e733830\",\"/knowledge-medium/pr-preview/pr-1789/src/data/dbFileSiblings.js\":\"0344f2137b4b8cfd\",\"/knowledge-medium/pr-preview/pr-1789/src/data/definitionSeeds.js\":\"7fbb97046e102a35\",\"/knowledge-medium/pr-preview/pr-1789/src/data/derivedIds.js\":\"871d3d3ddeab8c6a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/drawnSubtree.js\":\"140a30aa049034e8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facetBridge.js\":\"16794fdb6baac09a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/facets.js\":\"e08edc709294e124\",\"/knowledge-medium/pr-preview/pr-1789/src/data/globalState.js\":\"0d9aea030e8524f4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/aliasClaimRederiveProcessor.js\":\"e4139777708c3c0d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/ancestorBatch.js\":\"43d912ed9f0e21d4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/blockTypeTypeifyProcessor.js\":\"d99f400d46fe202e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/clientSchema.js\":\"68c1d896a55137f7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/commitPipeline.js\":\"e6b82a27fadd3f79\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/devAssertions.js\":\"737fb20c208fec40\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/firstSync.js\":\"3a683ab89e51f1bb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/freshInitialLoad.js\":\"eaf1726b1d135dd8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/graphBackfillClaim.js\":\"b34266ff3ab3090a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/handleStore.js\":\"60ddbf0e37315f15\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/idleMarkerJobs.js\":\"d6cbfc5103d01ef0\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initialDownload.js\":\"ec242023a7e18266\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/initializeClientDatabase.js\":\"dc72e0ebfa2a24b2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/jsonCanonical.js\":\"75d1080cb846243f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelInvalidation.js\":\"412982e318354853\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelProcessors.js\":\"1cbf06a6da6538da\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/kernelQueries.js\":\"a75f4bfc318461ab\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/mergeTypeMembershipProcessor.js\":\"997c6add43957b2b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/normalizeReferencesProcessor.js\":\"9c1f5fa55d658c06\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/poolInstrumentation.js\":\"3f60779cc879787d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/processorRunner.js\":\"a64af3143a26fbd2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyCellBackfill.js\":\"67785ba1763ac331\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildMint.js\":\"a5be6f46861a5d83\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyChildrenProcessor.js\":\"2cd719872292efd8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionChangeProcessor.js\":\"098f7ee09a3f5cbe\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyDefinitionSynthesis.js\":\"2b981dda8fb8948a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertyKeyScan.js\":\"2c7277ed47146005\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/propertySchemaResolution.js\":\"11452165b0a66299\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/raiseProtocol.js\":\"8a1a2b019b843393\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/readBatch.js\":\"8152f7fd58965f87\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/refProjection.js\":\"4a2976cf80231613\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetLookups.js\":\"b0a66c2751c05c48\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/referenceTargetProcessor.js\":\"2ffa71b4c3d4095b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/replayMerge.js\":\"59053d821a72aa6b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/sqlBinds.js\":\"dc7de13cbf54ee12\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"554d043ed6cc4093\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/arrivalProcessors.js\":\"5743b8aa40981a54\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/invalidate.js\":\"cb21c7d387c666cb\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/materialize.js\":\"2aca468179208e19\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/observer.js\":\"ce1c023615fdaa65\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/syncObserver/reconcile.js\":\"c18a2c215eead2b6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/timingMetrics.js\":\"b88dea91fff75c0b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/treeQueries.js\":\"b6df5150fbe36130\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txEngine.js\":\"2846531444b187f6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/txSnapshots.js\":\"1ecf6cfe3e301bdf\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/typedBlockQuery.js\":\"c9658baf2ee66e1f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/internals/undoManager.js\":\"43af087a50ccdcc7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/invalidation.js\":\"c7dba0d0d66f1dd5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelDataExtension.js\":\"7f27c20c626ce61c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelPage.js\":\"59996eab98a7cb6e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/kernelValuePresetCores.js\":\"378dfdd698b031ed\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbCorruptionSignal.js\":\"0345852647de1479\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbStorage.js\":\"ac0e77285c2da6e9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localDbVfs.js\":\"aec88dbe0752aea6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/localSchema.js\":\"0c84acb138a6be73\",\"/knowledge-medium/pr-preview/pr-1789/src/data/maintenance.js\":\"11bbb1b8285d6b70\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mergeProperties.js\":\"b0ba2ee64d0e42d3\",\"/knowledge-medium/pr-preview/pr-1789/src/data/metricsConsoleHook.js\":\"72c9e45bd5ce00f2\",\"/knowledge-medium/pr-preview/pr-1789/src/data/migrationsPage.js\":\"d02f51a297b511ad\",\"/knowledge-medium/pr-preview/pr-1789/src/data/mutators.js\":\"5f94d20cf630c4ba\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKey.js\":\"a72e406e5d86aaf5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/orderKeyPlacement.js\":\"4b009e45a7066014\",\"/knowledge-medium/pr-preview/pr-1789/src/data/outlineSurface.js\":\"e865c50f48d48527\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingEditorContent.js\":\"2cb94355825b114c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pendingUploadsSql.js\":\"ad3870ec5599f0b8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/pluginStateExtensions.js\":\"b4d75b51033dc538\",\"/knowledge-medium/pr-preview/pr-1789/src/data/powerSyncLogger.js\":\"ca3515b388d8a22c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/projectorRuntime.js\":\"0c3fced7cc18dc3b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/properties.js\":\"ed1f4b1e21a01fe7\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertiesPage.js\":\"e28493c500709db4\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyChildren.js\":\"2a47251e99cb2134\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionFanout.js\":\"781dc1dfdf74a91d\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionMetadata.js\":\"574a1e15ffc95e66\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDefinitionRegistry.js\":\"ec9a4ba0e3a43022\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyDisplayMode.js\":\"26d8d04605168183\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertyRowCreation.js\":\"3e9406b626cdbb2b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySchemaCreation.js\":\"6ada071b1fe64361\",\"/knowledge-medium/pr-preview/pr-1789/src/data/propertySeeds.js\":\"a35973e8d4e4def8\",\"/knowledge-medium/pr-preview/pr-1789/src/data/recentsPage.js\":\"82ad1b06702a0d6f\",\"/knowledge-medium/pr-preview/pr-1789/src/data/referenceBlock.js\":\"e344c5a801839f15\",\"/knowledge-medium/pr-preview/pr-1789/src/data/releasePowerSyncConnection.js\":\"4a13689a42131439\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repo.js\":\"6b5060c8d2e3f659\",\"/knowledge-medium/pr-preview/pr-1789/src/data/repoProvider.js\":\"d2bde9d9ff6827e6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/rowProperty.js\":\"c7e78b45969ce283\",\"/knowledge-medium/pr-preview/pr-1789/src/data/searchFilter.js\":\"2d5e16aa042ebad6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/seedIdentityLedger.js\":\"8b68f605be8ff764\",\"/knowledge-medium/pr-preview/pr-1789/src/data/stateBlocks.js\":\"d75344f3f04034fc\",\"/knowledge-medium/pr-preview/pr-1789/src/data/structuralEditPolicy.js\":\"680a4c2cfd83d105\",\"/knowledge-medium/pr-preview/pr-1789/src/data/subtreeDelete.js\":\"c32ffc31622630a5\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncStreamLock.js\":\"53006809b0cfef94\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableSqlRecognizer.js\":\"0713172e1ef41f4e\",\"/knowledge-medium/pr-preview/pr-1789/src/data/syncedTableWriteGuard.js\":\"457bf48e9f90ff21\",\"/knowledge-medium/pr-preview/pr-1789/src/data/targets.js\":\"0e734811a4cf4b70\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeColors.js\":\"4f2a0c6136027276\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionMetadata.js\":\"5fcc13bb93033955\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeDefinitionRegistry.js\":\"1640ac894009a498\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeExtraction.js\":\"5a85059814715331\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeInitialValues.js\":\"9a3ba5f616399b20\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typePropertyGroups.js\":\"a3d7df64934609a9\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeSeeds.js\":\"c79782f160dbb468\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typeTagger.js\":\"7330d7499d6ec59a\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typedRecords.js\":\"5d9f58bebe183756\",\"/knowledge-medium/pr-preview/pr-1789/src/data/typesPage.js\":\"a3a444e047aae0b6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userPrefs.js\":\"10fd7a4b3b77e2ea\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userSchemasService.js\":\"134d7095bb937b50\",\"/knowledge-medium/pr-preview/pr-1789/src/data/userTypesService.js\":\"56f2bf8504e3f815\",\"/knowledge-medium/pr-preview/pr-1789/src/data/valuePresetRegistry.js\":\"ec4bf96f0312532b\",\"/knowledge-medium/pr-preview/pr-1789/src/data/visibleChildren.js\":\"bf38060e0056e64c\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceConversion.js\":\"abb4bfd05c988e84\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceFirstSync.js\":\"d221081e05747515\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceIdNamespace.js\":\"f3c35c7aa1fcdeac\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaceSchema.js\":\"d61db94e03445ea6\",\"/knowledge-medium/pr-preview/pr-1789/src/data/workspaces.js\":\"68df05a5e1015075\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadLog.js\":\"65c15f8c0e834c62\",\"/knowledge-medium/pr-preview/pr-1789/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/BlockPasteShellDecorator.js\":\"dedd9905822fae7f\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/atTrigger.js\":\"371e96688353e116\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/autocomplete.js\":\"b4bef62af38c21ae\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/codeMirrorExtensions.js\":\"8a40f18b141aebb9\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/contentFlush.js\":\"75666eb2a3d1b7dc\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/defaultInteractions.js\":\"8b1edfc1eb8d7869\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/editSettleSignal.js\":\"7e4b71f7b6ec8bb6\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/insertImage.js\":\"c4a6d465e02e10c0\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceCompletionRange.js\":\"40a9442a7a6bf132\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/referenceTargetTypes.js\":\"72977c94b7b45b7e\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/syntaxContext.js\":\"65c97f200a1d54be\",\"/knowledge-medium/pr-preview/pr-1789/src/editor/triggerMatch.js\":\"f124f0f08586b9ca\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/AppRuntimeProvider.js\":\"6e3ca909e51fff17\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/BlockFocusShellDecorator.js\":\"fb2f8b38060887e0\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/ExtensionRenderBoundary.js\":\"ef3953026adccd2b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/PanelContentRecovery.js\":\"65738e282a59bac5\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/apiCatalog.js\":\"1ae35d24fcf713e3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/approveExtensionHere.js\":\"d98375bbabce33ec\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/armedCutAppMount.js\":\"dda69b367b747986\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/batchableKeyedStore.js\":\"7994eadd92b7770b\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockInteraction.js\":\"c32f9e7deb404abf\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/blockSelectionAction.js\":\"5a2ceb1f7c88bf17\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compileExtensionModule.js\":\"e2c078d7c2b070ce\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/compiledModuleCache.js\":\"0751508b9d4bd0b4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/continuousGestures.js\":\"6526d7cc0af53bd9\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/core.js\":\"cbb682c5ce778e41\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/defaultRenderers.js\":\"7e6e619e2d8b900f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/definitionFanoutAppMount.js\":\"e20eae420b09e4f6\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dialogAppMount.js\":\"facef5c58a9c66f3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensionSeeds.js\":\"29997dbdeb37349e\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/dynamicExtensions.js\":\"d2b8e195e3272662\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/exampleExtensions.js\":\"33a65b3cfe787f56\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionApprovalStatus.js\":\"bb4cf60ed016a160\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrorToast.js\":\"30ed82c3e1e53ae5\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLoadErrors.js\":\"eae390a53d318ec4\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionLookup.js\":\"04597aa41a8664a2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionToggles.js\":\"c096698d7ab0279d\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/extensionUtilitiesCss.js\":\"b08822d1f67b153c\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/kernelPageDeletionGuard.js\":\"bfcba4cdf62c1e5f\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/liveRuntime.js\":\"e3addc7dd57e1cb2\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/openExtensionsSettings.js\":\"a42fbaa9e3eea3a3\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/overridesCache.js\":\"6cd9e38fa31fc6a5\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/pluginIds.js\":\"4bd7a5544f08adf8\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/processorRejectionToast.js\":\"55b2b6ea386abf63\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeActions.js\":\"5390b5cd6968a9b1\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/runtimeContext.js\":\"b764d54f2f88a0ad\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticAppExtensions.js\":\"58ed9ea3415b84d5\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/staticDataExtensions.js\":\"389411a2cb18ef14\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/toastAppMount.js\":\"874cb1767c8fa7dd\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useOverrides.js\":\"abee41c28d1e3919\",\"/knowledge-medium/pr-preview/pr-1789/src/extensions/useShortcutSurfaceActivations.js\":\"87f5451061d011ae\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/discoverToggleTree.js\":\"747ca0723030f6d8\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/facet.js\":\"e18e5895477f27a5\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/resolveAppRuntime.js\":\"22b4958b2ee1b174\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/runtimeEvents.js\":\"b753dbdf0a638e28\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/togglable.js\":\"66af985043a1b101\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/variantFacet.js\":\"49cc5ddb950d09a1\",\"/knowledge-medium/pr-preview/pr-1789/src/facets/verbFacet.js\":\"e39f508f1a990742\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/block.js\":\"b98118a86ef6d599\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/focusedChild.js\":\"46b334375e02ccda\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/propertySchemas.js\":\"796945730e547d74\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/typeRegistry.js\":\"e01e50531b3dfb5d\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAncestorCrumbs.js\":\"86e2696026ec3898\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useAutocompleteListbox.js\":\"3d3f827298da016e\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedSearch.js\":\"9f8959ecd105cdff\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useDebouncedValue.js\":\"2f83467d55ec3732\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsFocalRender.js\":\"1fd6e11c0fec5176\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useIsReadOnly.js\":\"d39a5e374da853e4\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMaterializeBacklog.js\":\"d56bbb865f7d28a5\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useMinuteClock.js\":\"e40e40a14ea0fd67\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePanelLayoutProjection.js\":\"d68c2a254f487a75\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/usePendingInvitations.js\":\"bf31520c013c0cc1\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRendererRegistry.js\":\"984e16530015fe5f\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useRetainedFieldRows.js\":\"e7c2c962c6727ba1\",\"/knowledge-medium/pr-preview/pr-1789/src/hooks/useWorkspaces.js\":\"088fe73fce3b44d4\",\"/knowledge-medium/pr-preview/pr-1789/src/lib/utils.js\":\"88072e371682497f\",\"/knowledge-medium/pr-preview/pr-1789/src/main.js\":\"e349f22a84489866\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/MarkdownImage.js\":\"00c0f68f341c677c\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/blockSeparators.js\":\"6f0b1c17f5490076\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/context.js\":\"15214aca39dd435d\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/defaultMarkdownExtension.js\":\"9f81f8748cca7591\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/extensions.js\":\"cfc98ebd8ccc2e94\",\"/knowledge-medium/pr-preview/pr-1789/src/markdown/renderMarkdownHtml.js\":\"6334746cb3abe6dd\",\"/knowledge-medium/pr-preview/pr-1789/src/minimal-editor.js\":\"2afeaa71726e9555\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/armedCut.js\":\"769678e0d3329c7b\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/captureMediaVerb.js\":\"c4c6251abd897250\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/clipboard.js\":\"bfe89e7c6c279fdb\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/decision.js\":\"656937f19187eb26\",\"/knowledge-medium/pr-preview/pr-1789/src/paste/operations.js\":\"49d5b1d6e4cc8308\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/AccountHeaderItem.js\":\"b7b72776f833ee46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/account-header/index.js\":\"42dec0d5259f5866\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b0afabffe36f2651\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askAgent.js\":\"24d0f64dd54cc2e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/askedStore.js\":\"5e6018a5cd097144\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9f5605b6b366bc90\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/chipState.js\":\"844debc1455db3d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/dataExtension.js\":\"25c9830bd997c47c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/index.js\":\"0c69cb72ea55b8f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9ec75afab9429049\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-dispatch-companion/schema.js\":\"8d75d1f919b40853\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0b295b2fad96a096\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fee05e5579ce54f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/addMedia.js\":\"fc319558c75e743f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d47263d5ccae79d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/block.js\":\"f04b2d0962bafa29\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/context.js\":\"cabb5658d745f478\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/displayIds.js\":\"971ad599d874efbe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/index.js\":\"1cd32d442144655d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/outline.js\":\"2c146a26cd47a3a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/properties.js\":\"53bc2165bb95afe6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/refs.js\":\"9f31c7f5528c0e5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f65f0f97baf446d0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/search.js\":\"7d69f684311ae705\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/shared.js\":\"2378ae61b77a1182\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cc0b8d5381aea4fb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentViews/text.js\":\"b681b5f3b23cc27d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/agentWrites.js\":\"0a3da6a2eca72ec9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/authoringCatalog.js\":\"5ff6287f3717d1c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/blockRefTargets.js\":\"da31edb41adc7e89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridge.js\":\"47e30e5a78780e65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/bridgeLoop.js\":\"e6683fb940b85412\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/changeHistory.js\":\"bf6208e223ec360a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commands.js\":\"4caa7b212b1ec8b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/commentsCommands.js\":\"9055d0937738893f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataExtension.js\":\"1eb9a649c30bb0dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/dataModelGuide.js\":\"b0c87a65f1edb38b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/describeRuntime.js\":\"18d9807811f41a30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/extensionLint.js\":\"fc90994f17055576\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/grainAudit.js\":\"bab5bf52b2401f4a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/healthCommand.js\":\"6d97bcd72578ab4e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/index.js\":\"61e21fd54520a223\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/presetIdentity.js\":\"3530fa2f9b7a8570\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9942272338d52613\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/readMedia.js\":\"926d232e36bf5867\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/schema.js\":\"d93b69ae19fdef3f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/serialization.js\":\"5c224a6036a59bfb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/targets.js\":\"86af8492023f84f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/tokens.js\":\"c498d026e831752f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/watchEvents.js\":\"fee2cb77d71b39dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/workspaceGuard.js\":\"01523c53aaf5863f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/agent-runtime/writeCommands.js\":\"c3a437f7f5bc60cb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/AliasCollisionToast.js\":\"18502b3614a714ff\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/DuplicateNameBanner.js\":\"2cf6de6e297eaebc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/collisionMerge.js\":\"00d747225098c977\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/dataExtension.js\":\"bf3dfb8f360ef841\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/index.js\":\"49cc0d0618dab885\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/mergeCollisionAction.js\":\"f4f82d03223f7e48\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/pageStyling.js\":\"ff1fb15fd9ad8ced\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/rejectionToast.js\":\"ac22eb98aeb26f4f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/alias/syncProcessor.js\":\"914c7b0745317bc7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/actions.js\":\"82c8fc51f4437572\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/addComment.js\":\"938e0fbc70b151ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchor.js\":\"7b837f119e756c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/anchorState.js\":\"8eb774964da36b42\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/commentLinks.js\":\"fd9532c1c640f987\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/confirmThreadDeletion.js\":\"769315b2eb7b50ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/container.js\":\"e9f72fd2908fc7f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/dataExtension.js\":\"f87332e6abdd2826\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/deleteComment.js\":\"3a023c85283b9e40\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/highlights.js\":\"c7e35aecb18d349c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/index.js\":\"e2f5298122f916d1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/linkedCommentsPill.js\":\"ff58841315846af0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/margin.js\":\"42cc556572eafef4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/marginSchema.js\":\"d7756f9cd081d8e0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/newComment.js\":\"64de9e3128e48d70\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ownThreadPicker.js\":\"986c7f7d96eb5162\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/placement.js\":\"cbae211723a567b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/queries.js\":\"5af0e7ac2065d9a0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotePosition.js\":\"0d518727fe0e10e2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedIn.js\":\"d8229e856c7a95b4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/quotedRange.js\":\"5d0080c9b1bf4a2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/rangeRefs.js\":\"389936fe9e82be4c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readHighlights.js\":\"304ecd9d5bd1d124\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelection.js\":\"7c5c304c6961d876\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/readSelectionUi.js\":\"04eb5cdfcd234750\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/reanchor.js\":\"36ed11418a7159d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/schema.js\":\"1993ebea297db6e7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scope.js\":\"df5aeb687578f1cf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/scopeThreads.js\":\"324fdb46be5fd2b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/splitRetarget.js\":\"e6a2e8fc79efc058\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestionCard.js\":\"295203217ee12ff8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/suggestions.js\":\"1fb7b4ec4b2960e4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaries.js\":\"efba8106af05e6ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/summaryBatch.js\":\"e4f148075b12052c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/surface.js\":\"e7c291cd54a1b75b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threadNavigation.js\":\"41bf96dd1ed243fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/threads.js\":\"a02ca59abfca2736\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/ui.js\":\"f06fe839d6c3dab0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/annotations/uiStore.js\":\"bbabfcddd030446c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/appIntents.js\":\"8aa30499ef7a722f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-intents/index.js\":\"7d0e88466da265a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/index.js\":\"eb15799bac6b5403\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/app-update-prompt/status.js\":\"07e26a974c9994f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"235f543efef07123\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaBlockRenderer.js\":\"035d8a2d7a7d842b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaDownLaneReplicator.js\":\"fc97f6c4ce9dd79e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/MediaUploadReconciler.js\":\"4bd3bbe474c0f56a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetDownLane.js\":\"bae929a796065cfa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetResolver.js\":\"34825df3085eadc7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/assetUpload.js\":\"d71e978c110c0093\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/attachmentCleanerIO.js\":\"31cd87287d3cab89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a4f67929a1d340be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/blobStore.js\":\"c119b5228e5b345d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/byteStore.js\":\"7e38687c94a10616\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanerIO.js\":\"4122304d19620207\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/cleanupAttachments.js\":\"79362c5b266b91f9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/dataExtension.js\":\"a51387789b756d0e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/downLane.js\":\"c022a32eb7e6ff21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/index.js\":\"86adb3e21f65e8eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/insertImageContribution.js\":\"a23c79b46a7f2f58\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneArming.js\":\"cab053efaa74a7c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/laneLock.js\":\"39ade2dc138154d8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaBlock.js\":\"558b48ae49acb30e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaCapture.js\":\"96b9e00b1921c920\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewers.js\":\"2c38ef979878e887\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/mediaViewersFacet.js\":\"5aa7883a922bec0a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/pasteCapture.js\":\"eccc5644e3601224\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/resolver.js\":\"76cc30077d591bcd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/retryUploadsAction.js\":\"767625cb0be19b65\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/storagePaths.js\":\"42311183b7bb1599\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadDrain.js\":\"d6aa3324611b7cd2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadLaneStatus.js\":\"adc3f90b846e7f7f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadReconcile.js\":\"674dc5c544f335a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadRecovery.js\":\"3bc35893018f63c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/uploadStore.js\":\"19fbf813bf48f3ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/attachments/useAssetObjectUrl.js\":\"b550ffaef9a583f5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"7f2ce4077ad3f135\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/BacklinksViewSection.js\":\"09372a0b9b358eee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/facet.js\":\"438ea63bed6ab31d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/index.js\":\"db60cbe91bd65795\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks-view/prop.js\":\"a6c3b9b3f1b305ce\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinkFilters.js\":\"e10f083946497262\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4fe80da34053c08b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/BlockEntry.js\":\"788897dc1bf79181\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/LinkedReferences.js\":\"74ac0de18033b450\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7de9ac2d34103547\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dailyNoteDefaults.js\":\"6755995cbdca14ee\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/dataExtension.js\":\"95eae76f0db2f747\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/edgeExclusions.js\":\"6eb30acfcec0fd75\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/filterProperty.js\":\"b35fa1a269af2c42\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/index.js\":\"5e247f5c8a5744f8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"684798d521dec4cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/applies.js\":\"cdef5a6761d0adb5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/countQuery.js\":\"1248c896ce44fcd2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4d17ccf2d56db22f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/index.js\":\"6397fe2fd88aa1fa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5052b4170c867efd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/presentationInvalidation.js\":\"c746e86b4f35c68d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyEditorOverride.js\":\"cbc94df4873f513a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/propertyFilter.js\":\"f8b9f32141f97f5f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/query.js\":\"965321617a183ae4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/resolveFilter.js\":\"c9cfc0f57289028c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sourceBatch.js\":\"cf5dfd1454734010\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/sources.js\":\"9c12a5f502fc87ca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useBacklinks.js\":\"956923fc3f1b2156\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c076ce9633784be7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayCelebration.js\":\"f8d9d7a44a6657e5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/BirthdayOverlay.js\":\"ce62a3aea773dc2f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/gate.js\":\"87dad646cb2b5da8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/index.js\":\"334523147659361c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/birthday/wolfTheme.js\":\"c2508a65660af36b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/BlockDragLayer.js\":\"38b107bcc9527849\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dragController.js\":\"b4b1f8b330c085fe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/dropTarget.js\":\"3ac2eeafd55efb71\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/index.js\":\"ba553f8e6af59da8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-drag/projection.js\":\"9f0df6a0567230eb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/BlockMetaCard.js\":\"89ad4c73e3184180\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-info/index.js\":\"7fdbb58add2804e4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/AddTagDialog.js\":\"7792a9156dc3a54f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"cb1f1b239244643b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/TagNameIssueHint.js\":\"298876e77a7fa7f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/addTagAction.js\":\"1066886b235297d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/appendTag.js\":\"6a4d0d6c7956d8c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/config.js\":\"ada71da44b4c1131\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/dataExtension.js\":\"aa5e1ba0e6bb5cdf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/index.js\":\"10b01f52d69ffe0a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/block-tagging/propertyEditorOverride.js\":\"4b233136412b6e5e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbList.js\":\"55cef9e8a788fc50\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"93c589a106a6cdca\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a07e62cb660b9768\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"46ce7e326f0664be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"072f1d8be6811a7c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/index.js\":\"a9eced6286d95611\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"224e8fff9b7cfacf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/CharacterCountItem.js\":\"4274ae80956f9efa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bb7439b148fbea05\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/actions.js\":\"8d3d86a19d40d554\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/blockType.js\":\"ff162d3343f72bd8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/charCount.js\":\"8eb90b9f6b54f660\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/dataExtension.js\":\"78d10d9849d8ecf2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/index.js\":\"650e2682d9935cc2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/profiles.js\":\"ce2acd535558eec1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/properties.js\":\"106a9f9b58ead7e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/character-counter/textCounts.js\":\"d61e3fc1a2e3cfb2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/colemak-keybindings/index.js\":\"23f36016fb93ded7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/CommandPalette.js\":\"121dd515227d8523\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/HeaderItem.js\":\"8c8b7821c2a5ce11\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/context.js\":\"5a14e745321d4568\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/index.js\":\"84103499800876b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/selection.js\":\"6e6b7e674804957d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/toggleStore.js\":\"bd3362c0fb5aae87\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/command-palette/useCommandPaletteActions.js\":\"ca7f2d775010a5c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/ContributorBadges.js\":\"3b1a87c8116c1d94\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/author.js\":\"62ef012a70d00ca1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/codeMirrorExtensions.js\":\"62be261a5b645f78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/dataExtension.js\":\"31a3f46f9e15bab4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/index.js\":\"28b0495ad388cc35\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/mentionAutocomplete.js\":\"ecc22ab5d23628e8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/processor.js\":\"7e6ac0daaa48192d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/profiles.js\":\"a283f92b903ab701\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/queries.js\":\"0c2e16cb699766a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/contributors/schema.js\":\"105a70401f3d819d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"87f327e3270a9d07\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/followOrigin.js\":\"43fa3bbace7ab00d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/index.js\":\"d8deb4319d6abbdc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"12d2d380e2b907a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a72fc00b6343b692\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/CalendarGrid.js\":\"7662934f3203ad8d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DailyNotePicker.js\":\"c553b85dd84663d9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"86a6c61df86a8eb7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateNavDecorator.js\":\"71b58b4b3de6d0d1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/DateScrubOverlay.js\":\"c9481fad07565643\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/HeaderItem.js\":\"f2b35b61fdf0000a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/ReschedulePicker.js\":\"03a8b87f0ba9bb46\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9e9d5f0356470a9b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/actions.js\":\"9bc0c893ad04abf2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/blockDateAdapter.js\":\"995abb6766699d78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/calendar.js\":\"e0bdde782ea68815\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dailyNotes.js\":\"81934cba6e5677c0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dataExtension.js\":\"e8874dc6b1f144db\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubActions.js\":\"41a88da65a401d21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGesture.js\":\"e636b5c57db54025\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubGestureActions.js\":\"caa998358ff84c6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f87c1829ad1380b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/deletionGuard.js\":\"1c3b6dfe2614ddaf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/dueQuery.js\":\"28bb7623c105dd83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/index.js\":\"2f26082f6679c752\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/landing.js\":\"11ad111cd794e567\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/localSchema.js\":\"e03a285c09c5e45c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/referenceDateAdapter.js\":\"4628b580e7d9e6c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/rescheduleAction.js\":\"4f70827ca93270b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/schema.js\":\"fd8b5f5de4c4aeba\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadBlockDates.js\":\"88adc653f335849c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/spreadDatesAction.js\":\"2cbfee648dff2813\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/today.js\":\"caf925c242127ae9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3f9dffa301840203\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9e9787eb740ea4b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/audit.js\":\"0b765723c35ef248\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditAction.js\":\"b37019fa13c3ee82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/auditRanges.js\":\"51c7b31a2e894609\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/diagnosticsSource.js\":\"fdf72b6aa85e727b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/divergenceScan.js\":\"d3cb414d5e37e15a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/index.js\":\"1273c7f7d5a1932d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/propertyChildrenChecks.js\":\"67ac62e897a62842\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/referencesMirror.js\":\"2db2ee1e2e8516e3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/rowJson.js\":\"3d2d52f4cfaf9c10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/schedule.js\":\"604b91c5c37ed0dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/data-integrity/store.js\":\"be7ba7a740d77b44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/action.js\":\"e20f641ad5fa627f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/index.js\":\"da4e7709cbdbf77a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-maintenance/plugin.js\":\"7b040f9ba7fb8c0d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"96cc3f5cff134a1b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/actions.js\":\"22c9151f2d717439\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/changeMarker.js\":\"ed45267a80fc4a39\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/diagnostics.js\":\"4c45bca85cbb2c05\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/fileSystemAccess.js\":\"339ee9280ef5838d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/filenames.js\":\"9c88109b4212440f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/index.js\":\"fa44a23479d0b1d5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/mirror.js\":\"fa706166cdab4abd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runLock.js\":\"84de92f7ae2df3ed\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/runtimeHealth.js\":\"e3f9d238dccf585b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/schedule.js\":\"cfa840c84b962733\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/db-mirror/store.js\":\"973a3334187875ec\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/index.js\":\"545538b67a281b30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/default-themes/themes.js\":\"bc0884afe5a8526b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/facet.js\":\"ef9a482c2be90a04\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/diagnostics/useDiagnostics.js\":\"b5b4fede32ffb5fc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/dismissals.js\":\"6c56f6664dec2f50\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/index.js\":\"9d59d6b45bdbe3c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/status.js\":\"8b441df0b28f7d33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extension-prompts/store.js\":\"c5e080be7df723f0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4fce61fb6472bbe0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8c9b92ad629e6522\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/actions.js\":\"ab6d646a5c236b83\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/config.js\":\"85be8978e3c7999e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/dataExtension.js\":\"ab379c6dd6b2453f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/effect.js\":\"0bec6669a925ab93\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/index.js\":\"8133548551be4193\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/propertyEditorOverride.js\":\"02a4b2b07a3f3443\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extensions-settings/useToggleTree.js\":\"8856cf3ad16d0693\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/ExtractTypeDialog.js\":\"6ba7bddcae80a049\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e65d3db6913d4e0f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/PropertyShapePicker.js\":\"8cd27e91fbb69c98\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/action.js\":\"0c748dd08d5c9f7f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/extract-type/index.js\":\"a6b0b0782ca39f21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/FindReplaceDialog.js\":\"19ac8970426c038c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/HeaderItem.js\":\"5288747920e2fd3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/dataExtension.js\":\"d928c03c9dc432f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/index.js\":\"fbc5fb7cfb124f89\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/search.js\":\"372e29b6c09f6cf0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/toggleStore.js\":\"c64d882e0f017409\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/LocationPropertyEditor.js\":\"a1e790e7a3ecebf1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/MapView.js\":\"9cadff665e775176\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/blockTypes.js\":\"b3994f456ec18efe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/codeMirrorExtensions.js\":\"414c73e2b13ae414\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/createOrFindPlace.js\":\"a552cd552835735d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/currentLocation.js\":\"e47b2b0ced9dc876\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/dataExtension.js\":\"7306a43012a285a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/geoContentDecorator.js\":\"44dfa318948f15a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/googlePlacesClient.js\":\"e02864e057343c3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/index.js\":\"de623fcbf50b8b8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/locationsPage.js\":\"89c9bd83324536ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/mapViewport.js\":\"b5de4629d04ab7bb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/pickCurrentLocation.js\":\"a69c2fcbd1e09923\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeAutocomplete.js\":\"e6011e90a853335d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/placeNameCollision.js\":\"7b126b6bd2c7ea84\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/properties.js\":\"890ec15aa8dfd36c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/propertyEditorOverrides.js\":\"17d1ae5255de6888\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/query.js\":\"90b692fafd0b9b3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/geo/usePlaceSearch.js\":\"bcfacfe586246cfa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ab893ea760d22012\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"dde6b445d90bf63f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8636b75ee25bfa32\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/config.js\":\"6a05870d66d2c34c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/dataExtension.js\":\"974b1275fc6d4586\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/facet.js\":\"33fcbb58fc56613b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/grouping.js\":\"75f5267465d3076a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/index.js\":\"350493fc1af0aa61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"140d1cb98274b945\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/query.js\":\"7e9f7411e24268da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/resolveConfig.js\":\"587370e667d6e927\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d5108e0eade6dff3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c535a86e775f6f22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlDocumentContent.js\":\"ea62e6caa7ef6b81\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/HtmlFrame.js\":\"df7e0a9c2515980b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/actions.js\":\"07dd673f79b7d8a7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/blockType.js\":\"0e106343a2b4018e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/confirmRunScripts.js\":\"dfe5970c8a864f6c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/dataExtension.js\":\"1af6a88d2749339f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameAnnotations.js\":\"6cb88935e8f02581\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameDocument.js\":\"90e7d0142d60370b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/frameTheme.js\":\"54e6ff2f6d9f8a1a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/index.js\":\"44834ff0a75465cc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/scriptConsent.js\":\"27dd6353ea480091\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/sourceMap.js\":\"0121054bc7b4267c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/html-document/useDocumentScripts.js\":\"6c914cfa0bbfb859\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/index.js\":\"900e3551b2558c93\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/record.js\":\"abb24bc38b96bcfd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/recordStore.js\":\"c26ca65c28907b6d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/responsiveness.js\":\"97ba591d82c8870a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/schedule.js\":\"9fa2e91e51f8beb8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/interaction-metrics/sessionContext.js\":\"1b24b5f34933ceb0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d6d4f426c05612af\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2f6608ed8eeec056\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/actions.js\":\"d3ea0c84efbef428\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/config.js\":\"49ac686d978d4aa3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/dataExtension.js\":\"cd5a9b8c79c4bc08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/effect.js\":\"2cca53e0e917c2d3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/index.js\":\"92265fd65084e2a1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/keyCapture.js\":\"666481ff030914da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/overrideStore.js\":\"bf5daa63436882dc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"988c649d7f23196c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/HeaderItem.js\":\"c29100229dfe4a7f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/LeftSidebar.js\":\"00c209b446d1326c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/actions.js\":\"4b74fa4795728673\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/facet.js\":\"19efa002943ea309\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/index.js\":\"b24fa4cca46b6ef4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/shortcuts.js\":\"6017f624cd151dd0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/left-sidebar/toggleStore.js\":\"b44855aecb981a0c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/MergePicker.js\":\"aa8c324e341ebb34\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/index.js\":\"f8a738b0b90ab987\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/mergeAction.js\":\"1562cd7b28ee1eae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/merge-blocks/strategy.js\":\"ecd65252166b2874\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/Button.js\":\"ce54684d6ab236ac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"26474004cdf27d98\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1d34dc36153f0ab5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/facet.js\":\"815ae48b8bacdf30\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-bottom-nav/index.js\":\"55e042ba25e86c8f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7da10984d0ea92c5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/actions.js\":\"583d6dc81d25fd4f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"edf3098cbff7f71f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9c03888038ae63f4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/mobile-keyboard-toolbar/index.js\":\"90411585586d4f76\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/MoveDestinationPicker.js\":\"323558491326bc79\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a12b1fe603b81e05\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/contextMenuItem.js\":\"fc780f88460d7ba0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/index.js\":\"e2f540d01db9a7dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveAction.js\":\"875f41464f515e71\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/moveBlocks.js\":\"7f91fd0db8ce4194\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/move-blocks/selectionAfterMove.js\":\"b3d08eae1faa7359\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/TutorialBanner.js\":\"524a675b6a1bad88\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/action.js\":\"bbb1205a3f40c33c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/bannerDismissal.js\":\"7ee7d49deee9b7ad\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/documents/cheatSheet.js\":\"3d0f0ce3a1253fa0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/index.js\":\"81cb9b1477c8107e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/keys.js\":\"f0416122209919b6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/landing.js\":\"d35883ff87f9fb74\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/outline.js\":\"377e7ea5f6280be7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/onboarding/seed.js\":\"57e5ceb8c4308cf6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/PerfTrendDialog.js\":\"97ba2ee00eb4b690\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/analyze.js\":\"6c38ccf525c603ae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/diagnosticsSource.js\":\"3ff7a4dba99ee3b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/index.js\":\"ba5582a8a955a038\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/load.js\":\"3fbba7e6d936795f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/monitorRun.js\":\"7b00a8ad8901c760\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/schedule.js\":\"654420ad1035cca0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/series.js\":\"aadd0dc3610aa0c2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/store.js\":\"6163a880d18bd248\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/trendAction.js\":\"56c6fe4513c80e7d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/perf-monitor/verdict.js\":\"51704390db7ddfc0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/clickToEditAction.js\":\"774749962c789c28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/index.js\":\"5d4da58fa1ccca34\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/plain-outliner/interactions.js\":\"f9cad5e93c5d54d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5879daed399dec3a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGate.js\":\"97010fbf789f0717\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/MigrationGateDialog.js\":\"fba09c899d53198d\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/action.js\":\"ce6fa0ad06882ffb\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/index.js\":\"8c2246792154d233\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/localRunMessage.js\":\"5539c567f4b3f486\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/plugin.js\":\"4b766c8bbfd54f93\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/progressReport.js\":\"41c018725bdaee08\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/properties-migration/sweepProgress.js\":\"2ea4b1894dd20190\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/FieldRowRenderer.js\":\"d5f71814da898f2e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/ValueRowRenderer.js\":\"64f20064fb8be0d7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/actions.js\":\"2ee96ff229b136aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/autocomplete.js\":\"cf44c79dad283d57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/fieldRow.js\":\"cf2b69bf88fe421b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/index.js\":\"d9383404c0612efc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/referenceWarning.js\":\"070e8b25ea6fcc8b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/resolvePropertyValueInlinePresentation.js\":\"72be31a3727c2a18\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueAutocomplete.js\":\"14921863d556e3f7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/property-rows/valueSchema.js\":\"4082efd20bb6d583\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/HeaderItem.js\":\"e5c6aa7d7952b16e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/QuickFind.js\":\"c4086edeb8438ac1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/index.js\":\"5ec862cddcae025e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/recents.js\":\"63b7a305584ba505\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/resultItems.js\":\"963e26c434e33219\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/selection.js\":\"86d454f5d52ebd96\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/quick-find/toggleStore.js\":\"1d53019d138e6e12\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/HeaderItem.js\":\"a9665c73ac56714a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7fcdcefd500aedc3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/grouping.js\":\"f6b925d0f3862e7a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/index.js\":\"84ae6b270c1bbcae\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/recents/target.js\":\"3b9edcd403e5ad0c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/codeMirrorExtensions.js\":\"efda3c9c7e10126a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/contentPrefill.js\":\"6c01bf0b45ddaffe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/dataExtension.js\":\"659905fa924a85ea\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/index.js\":\"5898d54881b4c010\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ec81576e2072677f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/invalidation.js\":\"f6a35de09b484c43\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/localSchema.js\":\"710264497a3855dd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/index.js\":\"0d1d08baae10e9a9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e5ec7b758a694669\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/index.js\":\"b03aaad9806474da\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/referenceNode.js\":\"9d815cec806a166e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e7a0983138e5214c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a7a6cf5eb95c7edf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/index.js\":\"0d5e79a07f2e87f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"94dbbe4e3829c093\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"81579c1c0495abc0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/mergeRetargetProcessor.js\":\"b4bd620fb23dc634\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/parseFence.js\":\"9b8b09b599799169\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceParser.js\":\"c7abe1b4fcc43740\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referenceProjection.js\":\"335f94507c8e00e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/referencesProcessor.js\":\"d54576ebeffc4d7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/renameProcessor.js\":\"540ab23720e17022\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/references/spanReplacement.js\":\"3b50ad4a99c716bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/htmlToOutline.js\":\"d6e15b9a6b724f05\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/index.js\":\"aa37ea21a028ca78\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a1fbd08c2129b775\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/rich-paste/pasteDecision.js\":\"67e350b04f2f976a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/action.js\":\"8b76667252a07457\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/blockIds.js\":\"035e16ca4533ebbe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/content.js\":\"1cd8fa3ed639279b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/effect.js\":\"f60ac01e778548a3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/ids.js\":\"ac91a9c258dbd16f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/import.js\":\"74f9e3001ebaa332\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/index.js\":\"c70e00214d492bfc\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plan.js\":\"a8954744457a249a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/plugin.js\":\"987ffab8042aaa21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/promotion.js\":\"8ce62d75a5752529\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/properties.js\":\"b79c37f3474b33b0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/references.js\":\"0ba29a2222c39f10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/report.js\":\"144480710b7ac1b8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/roamMemo.js\":\"ba9c843e08be795a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/runtime.js\":\"9988652f9541e0c7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/schemaReconciliation.js\":\"375997f7d79d755b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/srsMarkers.js\":\"225f6d9c0eaa3b09\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/todo.js\":\"d7b32a6c6f2bde22\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/typeCandidates.js\":\"52b2254875067994\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/roam-import/types.js\":\"24ac908214220c44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/index.js\":\"03a0eee0fb8bb254\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/search-health/store.js\":\"05a93976ec3a5d76\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/HeaderItem.js\":\"00804474955de9f3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2510130eca7ddef1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/index.js\":\"d3ff4b1c9e2270bd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/model.js\":\"3d72790944a00d38\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/toggleStore.js\":\"f733345f95bc47b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/shortcut-help/useKeyInspector.js\":\"fa3ddc3d61813986\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ffd2d27af48a966c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/ShellDecorator.js\":\"d24e41e113082058\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/actions.js\":\"cecdb589f6636d6f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0af86baaac58df61\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/index.js\":\"f5cd3a1f518ba146\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/shell.js\":\"16d0cb3fdd383ea2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/surface.js\":\"b1d883cf4d421f92\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/spatial-navigation/walker.js\":\"ecc622f793a9b862\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2b4bb2b9c7a1629e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/dataExtension.js\":\"6dc555c4f9b93c19\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/index.js\":\"0bbf5890071ec065\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/indicator.js\":\"99f90aa95e9479be\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/moveSrsState.js\":\"0db6deca491a5e36\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e26fe2d7be7aea13\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/scheduler.js\":\"e8506ebb02816700\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/schema.js\":\"e948447e3fc676aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"364134fd8a2331ab\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/srsClipboard.js\":\"e79af7f1fd36034e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f691e92f31df202a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b3554c1dc7a4ada9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/DeckPicker.js\":\"a7b64025d83fa108\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewControls.js\":\"4f295b06b603e459\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7d25148b55e0e19b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/ReviewSession.js\":\"204249ab5163600b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/actions.js\":\"a1d0a30320790313\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/archive.js\":\"116c61804c515437\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dataExtension.js\":\"5af185927ae81951\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/deck.js\":\"e8c3fa81aa63c251\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/dueQuery.js\":\"2b000a15914ba054\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/gradeDecision.js\":\"e175f291d0e427aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/index.js\":\"ed8c6c41094f0a6e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/keyHints.js\":\"50ac2ef304b2fcac\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewCardLayout.js\":\"127a56671ef2e612\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/reviewProgress.js\":\"9b09641133074339\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/schema.js\":\"a56f61ab39aa4f7e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/srs-review/useDueCards.js\":\"e11992e83b65310f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/index.js\":\"434900edbb1b7253\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/startup-metrics/record.js\":\"daf041ac561fb376\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/index.js\":\"12dcf3cd81e67ccf\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/persistenceStatus.js\":\"3e1c50bad38f42c3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/storage-persistence/requestAction.js\":\"526dc65241914c28\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/TypeChipsDecorator.js\":\"8618fa56ce76cb57\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/codeMirrorExtensions.js\":\"6f96574e67ea83fd\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/index.js\":\"f549354b367b209a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/supertags/typeAutocomplete.js\":\"aefdc03354b1898a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"724a13a7d93f9923\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/actions.js\":\"577b65714c329e03\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/anchor.js\":\"2e89fc3aa5495be7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/events.js\":\"2cf4e43b757927b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/gestureActions.js\":\"f5760328fafee630\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/index.js\":\"f249509d0695ecb5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"80b547e3f4792a4a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/collect.js\":\"fbf0c59d295b320c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/index.js\":\"173067868ee7d0e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/sync-metrics/record.js\":\"794df2befb8532c8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/RejectionDialog.js\":\"400f0ec1301a478a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0199b2cf4bcc73a5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/index.js\":\"9feb6b1621660216\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/model.js\":\"64fe2e13102a9f5a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/queueCounts.js\":\"7516d61989150185\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rejectedHelpers.js\":\"e708eb88b7b1c74f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/rematerializeAction.js\":\"37de1129e6ca18f6\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/system-status/useHysteresis.js\":\"85a3e0de0ec0a583\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/effect.js\":\"b78bac2db07464b7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/index.js\":\"85126ed79d3ccfc0\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/theme-toggle/theme.js\":\"1c1dd885ea1ad578\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/actions.js\":\"b0dea3fff0d5a48e\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/dataExtension.js\":\"eb13cdf9eb9146c7\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/index.js\":\"4b0863143c109a6b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/todo/schema.js\":\"a3d48de2a98ac7e9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fe245c7ee56c5b10\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/actions.js\":\"7fc5abe32e5c0abe\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/defaultItems.js\":\"462a2631b3bd4ba5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/facet.js\":\"9d7efff90aa63d82\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/holdRecognizer.js\":\"cc823ad0f2e0d3aa\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/touch-selection/index.js\":\"dc0bfefd1dc89d7b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/UpdateIndicator.js\":\"32e1b9b3b63c156f\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/index.js\":\"3ff59d3a3021edf8\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/update-indicator/loadTimes.js\":\"05c329616c56c53a\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoNotesRenderer.js\":\"5433fef66bffcb21\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoPlayerRenderer.js\":\"99a7500c273a9116\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/VideoTimeStamp.js\":\"433acb911e12fe33\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/actions.js\":\"06603e062f0ef372\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/index.js\":\"f61dda219cdf919b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/markdown.js\":\"3059410d0c0e3cf1\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/notes.js\":\"96299de2ce873be5\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/registry.js\":\"9d9cf9afd06192b3\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/remark-timestamps.js\":\"3398ca11be6126f2\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/video-player/view.js\":\"77cc14d1387944b9\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/LinkHints.js\":\"a756a439763c7c4c\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/index.js\":\"561cc26398548a5b\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/model.js\":\"cb99db026a1c1a44\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-link-hints/settings.js\":\"95f8ace345859227\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/actions.js\":\"b4a09f30ec35ded4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/index.js\":\"c16c36aadc779be4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/vim-normal-mode/interactions.js\":\"fafba43c578aabd4\",\"/knowledge-medium/pr-preview/pr-1789/src/plugins/workspace-header/index.js\":\"e26014f1e21ee98b\",\"/knowledge-medium/pr-preview/pr-1789/src/registerServiceWorker.js\":\"69a6d78ac594497d\",\"/knowledge-medium/pr-preview/pr-1789/src/requestPersistentStorage.js\":\"ed8b17edcb4f819a\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authRequestDeadline.js\":\"fe65c4726d3fdfff\",\"/knowledge-medium/pr-preview/pr-1789/src/services/authStorage.js\":\"89803f822b5bb7fe\",\"/knowledge-medium/pr-preview/pr-1789/src/services/powersync.js\":\"8ce5f2d48645af98\",\"/knowledge-medium/pr-preview/pr-1789/src/services/supabase.js\":\"e3b28fb8ca4f689b\",\"/knowledge-medium/pr-preview/pr-1789/src/services/uploadErrorClassifier.js\":\"15a71a3da7aa7553\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/ActiveContexts.js\":\"3b92917a7bbb3bc3\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/HotkeyReconciler.js\":\"d21d844c7a3a4e1b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/WipeLocalDataDialog.js\":\"8adcf117288c1c2c\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionDispatch.js\":\"18bd5645de90b1f2\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/actionRefItems.js\":\"f775347cf9d0ff6d\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/applyKeybindingOverrides.js\":\"1a7583c7cf2e3df8\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/blockActions.js\":\"aa5bd5999404a70b\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/canonicalizeChord.js\":\"9005a65f4358de55\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultContexts.js\":\"ed51f199b71a7479\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/defaultShortcuts.js\":\"8e9109a668b690ab\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/effectiveActions.js\":\"718423157542ea1d\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureAction.js\":\"64e3419703c3bea2\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/gestureBinding.js\":\"a05f2b86c9e2540e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/holdRegistry.js\":\"8322285b25bdf421\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingConflicts.js\":\"34cf777d0621ecb3\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/keybindingOverrides.js\":\"0391ffeed39b55f6\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/pointerAction.js\":\"2674eac3522081a4\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/resolve.js\":\"e38c006b9bd13088\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/runAction.js\":\"cd6fc8881da5b580\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/sequenceMatcher.js\":\"fd1ed7c789bd0cd5\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/types.js\":\"72b575835fd4ecf9\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionContext.js\":\"b838cb11f741ea20\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/useActionDiscovery.js\":\"f6751a517955de5e\",\"/knowledge-medium/pr-preview/pr-1789/src/shortcuts/utils.js\":\"6a4858ce1890ac9c\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/bootStore.js\":\"f32488392960280e\",\"/knowledge-medium/pr-preview/pr-1789/src/sw/previewDatabases.js\":\"ffd51647d5db7880\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/byteTransform.js\":\"27fe3e5f7b86e5c5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/attachmentCleaner.js\":\"52d7b18fb8c6ed52\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/attachmentParts.js\":\"056b024e15877bbc\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleParts.js\":\"84fd0202c96907f5\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/bundleRecord.js\":\"0959cf3ed6c3c8b8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/manifest.js\":\"8b2eb41dc135866a\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/takeBundle.js\":\"489b64a822f5e19f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/bundle/verifyBundle.js\":\"c1a903524c2bd47e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/cleaningStage.js\":\"1178b9d7b092659b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionKey.js\":\"a58fb6fb5dffb76d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/conversionServer.js\":\"03a433fa15b01d3a\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flip.js\":\"b3730d641083f35f\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/flipAttempts.js\":\"773979301ef61652\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/pages.js\":\"3db6c187a1aa7e8b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/preflight.js\":\"e05728b82a5dd373\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/reseal.js\":\"41b98734a391ae0e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runConversion.js\":\"683ff254fc2e0682\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/runLock.js\":\"e3eabf07d0be5ed9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealing.js\":\"78829a551e3e73e9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/sealingStage.js\":\"b4fb03b4429bd995\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/stage.js\":\"bee33912c6bb6610\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/conversion/verifyReseal.js\":\"8f4d7b7b03f72233\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aad.js\":\"85d664a4f4861ea4\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/aead.js\":\"4ecbd27673d2eebe\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base32.js\":\"1d013e703400b990\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/base64url.js\":\"b5f497258b691953\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/binaryEnvelope.js\":\"2f7f6992ac34416c\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/byteAead.js\":\"5a74bf59ee70aa4d\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/canary.js\":\"426a3f34c21b5546\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentHash.js\":\"2012d3d4c5161486\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/contentKey.js\":\"d0e97cb141ced713\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/derivedIdNamespace.js\":\"862a2f592855308b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/envelope.js\":\"802d81ea91fb9e6a\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/hex.js\":\"7c1274f2c5ce1e29\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/sha256Hex.js\":\"18aac43a319c3816\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/crypto/workspaceKey.js\":\"8b406b302ce58fdb\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/conversionState.js\":\"cd23e173d53654e9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1471d17cc509c685\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/pastedKey.js\":\"9d468d1c0ded89a9\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bb4188c0b5fdf022\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e91e22da352abd72\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/keyStore.js\":\"56621b6c9e36371b\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/mintWorkspaceKey.js\":\"19b2d6646b5c2bae\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/modePin.js\":\"c4f24fb218bdb98e\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/openWorkspaceKeys.js\":\"89da834c0fc78dc8\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolveWorkspaceEntry.js\":\"75b1195f02aeaf01\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/resolver.js\":\"50a303aa4fc908f1\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/keys/workspaceAccess.js\":\"e15700fd41224099\",\"/knowledge-medium/pr-preview/pr-1789/src/sync/transform.js\":\"1c6c2959f3a18d52\",\"/knowledge-medium/pr-preview/pr-1789/src/themeBootDefaults.js\":\"efbce4a7b1924ac9\",\"/knowledge-medium/pr-preview/pr-1789/src/types.js\":\"9fb2f2ad3f903325\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/ClientLocalSettings.js\":\"24113c6cb6edfc17\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/abortableSleep.js\":\"06e43cb5c02355db\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/array.js\":\"51b4503614159889\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/backlinkAutocomplete.js\":\"36fad9a3292e53ce\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockCrumbs.js\":\"a85adcbe83fabf94\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/blockrefAutocomplete.js\":\"9050ebcb5060e0ac\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/cadencedIdleJob.js\":\"2d6911464b42309c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/callbackSet.js\":\"60547bd1f387d6a7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/clientId.js\":\"59a04c9ff6a19d6f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirror.js\":\"17ee5397fdf4e64e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/codemirrorCompletion.js\":\"9edc383527256ce1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/copy.js\":\"c3507e16b826e4ab\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dailyPage.js\":\"657de9042c96c0f4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensics.js\":\"ec83d05a094c70f0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dbForensicsHooks.js\":\"d3a2c205cf460fd9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/deleteBlockThroughUi.js\":\"650a4cd8befcee1e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dialogs.js\":\"c6b085672d5477c4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/dom.js\":\"b43887dfcf83d74f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/downloadBlob.js\":\"ee37626821a85127\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/exportSqliteDb.js\":\"f5fdaded619e05b1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fileSystemAccess.js\":\"c8533fe54565dc47\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/flipSlide.js\":\"c3de8d1c367badaf\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fnv1a.js\":\"bd143a69695c9824\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/formatBytes.js\":\"8322b28a6f05d36e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/fuzzyRank.js\":\"a7c6d7eb0acb7ded\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idbKeyedStore.js\":\"41eb1570fa44a9e3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/idleCallbackPolyfill.js\":\"589963ed2fb980a6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardAwareScroll.js\":\"b35b91c98b6febf3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/keyboardViewport.js\":\"bafe1ae5052f74ad\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/lastWorkspace.js\":\"32d4e0cef4eab269\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutColumns.js\":\"fbeb7bce3c617ebd\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionDom.js\":\"e9a39791ccc7c11a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/layoutSessionId.js\":\"09872feb6f60448f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkClickGestures.js\":\"26f483b87aefd6d7\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/linkTargetAutocomplete.js\":\"276fdeac62e1f022\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbCorruption.js\":\"b6a6a8109751f054\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/localDbRecovery.js\":\"5380b9d61098902f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/markdownParser.js\":\"a4d50577848769f4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/memoize.js\":\"daff71df0c006a51\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameFieldCommit.js\":\"6f3c87b0d3a77f87\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/nameList.js\":\"d3055e322add52fa\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/navigation.js\":\"6c07b2c190c4f581\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/omnilinerNamespace.js\":\"77b9ed7a5f3cf8cd\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/opfsPageScan.js\":\"84a34de8e85c7588\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelClearance.js\":\"6e6643e9fd9f9f1d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelHistory.js\":\"18be20576d23b8d2\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLanes.js\":\"1c30d0ffd6cf9c24\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelLayoutProjection.js\":\"f489a13a692895f9\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelScrollAnchor.js\":\"4dafa303ab45d794\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/panelUrlFlags.js\":\"190851d09049ccf4\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/platform.js\":\"d1f50d869caaf225\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/pluralize.js\":\"f9b314f5bae6c14f\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyCreation.js\":\"650b0bc48f4c9dff\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyNavigation.js\":\"3e24132dc5734a6e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/propertyValueContext.js\":\"1cdfefc764725a91\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/react.js\":\"be06d2f9ee74200b\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeDate.js\":\"2ef32863c2672d51\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/relativeTime.js\":\"5b6a5af8328dd2b1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/renderScope.js\":\"8ec756d0e9df9fea\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/resolvedThenable.js\":\"f6788a8a6a9c8b72\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/routing.js\":\"a869b3e57999f4b3\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/safeMode.js\":\"c4ebbc8149289abf\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/scheduleIdle.js\":\"9993c1c5487eac73\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/screenWakeLock.js\":\"cc2412f6c9769ceb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/selection.js\":\"b1d9e80515a9ab2c\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/softKeyboardGrab.js\":\"501a036d27b0e231\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/startupTimeline.js\":\"c838c1dbd867b0e5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/state.js\":\"2663b6ce7f737adb\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/string.js\":\"3b22ad834e4878c0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/surfaceZoom.js\":\"1ded819b9c11280e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/time.js\":\"5313c2b7616a8574\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toast.js\":\"9d3ed48ae0a5343d\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/toggleStore.js\":\"63ce8f3242b385bf\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/untilStopped.js\":\"b2a04c069af0ede5\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/userActivity.js\":\"b9dee51f0583c06a\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewTransition.js\":\"c348fbbc677a0be1\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/viewport.js\":\"7e0726c6d372726e\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/webLock.js\":\"d9d5ba3034a51740\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceRecovery.js\":\"e7a775fc82d39fb0\",\"/knowledge-medium/pr-preview/pr-1789/src/utils/workspaceSnapshotStore.js\":\"7723f936e902193c\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-compiler-runtime.js\":\"28f5843c17ea7f24\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-client.js\":\"895588ed076e9d27\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server-edge.js\":\"daeb67fed5de7754\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-server.js\":\"9f7bf695abeb5388\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static-edge.js\":\"8dfc414ede2d7300\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-static.js\":\"5a62555874fa8344\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom-test-utils.js\":\"97039023e25a5630\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-dom.js\":\"f73da5a73909c8d3\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react-jsx-runtime.js\":\"503a4a739eae58f9\",\"/knowledge-medium/pr-preview/pr-1789/src/vendor/react.js\":\"d958378d54a8518f\",\"/knowledge-medium/pr-preview/pr-1789/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1789/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
