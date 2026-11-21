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
		buildId: "c92757f7e548-ada8e874",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/\":\"b38c741de22fe875\",\"/knowledge-medium/pr-preview/pr-1790/index.html\":\"b38c741de22fe875\",\"/knowledge-medium/pr-preview/pr-1790/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1790/assets/FacadeVFS-Cbz06kB2.js\":\"74485875235893db\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSCoopSyncVFS-CUVNwzUr.js\":\"e0851b0ee1e1b671\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSWriteAheadVFS-3B0A1y4m.js\":\"bda9e01b694b4232\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-ktd0X-Hw.js\":\"0210f7d865f204c3\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-hQQbA2y8.js\":\"89ab406fe54e76b8\",\"/knowledge-medium/pr-preview/pr-1790/assets/worker--0zFX5-A.js\":\"d900c6d783ab594c\",\"/knowledge-medium/pr-preview/pr-1790/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1790/chunks/app-DJ7FLaVq.js\":\"7ea4133024eea296\",\"/knowledge-medium/pr-preview/pr-1790/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1790/index.js\":\"06408fea5c89072e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1790/assets/AccessHandlePoolVFS-gsTi_WFb.js\":\"b665fa33c58c6af9\",\"/knowledge-medium/pr-preview/pr-1790/assets/IDBBatchAtomicVFS-dQYMcIHE.js\":\"c912dab8e9d130e9\",\"/knowledge-medium/pr-preview/pr-1790/assets/MemoryVFS--Q_GuuQF.js\":\"9c9014025853b9bd\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-D6OQyPL_.js\":\"108b39bf1f438432\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-D5Vpv8RX.js\":\"ae93362cb200092c\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1790/chunks/AccessHandlePoolVFS-wPzBYsls.js\":\"c84b9e54582bcb1c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/FacadeVFS-BaXHsBfZ.js\":\"ea4bc9a7dff4d24f\",\"/knowledge-medium/pr-preview/pr-1790/chunks/IDBBatchAtomicVFS-B4MtycPf.js\":\"08e5d81feb4a15bd\",\"/knowledge-medium/pr-preview/pr-1790/chunks/MemoryVFS-DAvgN2F9.js\":\"005ca026b4fb536e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSCoopSyncVFS-DYkTBtER.js\":\"69d3d5e2ce64d7c8\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSWriteAheadVFS-DAKw4A35.js\":\"a193c5d4ca3f384b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/Preview-NpWaGcuH.js\":\"49234dcb8baa7709\",\"/knowledge-medium/pr-preview/pr-1790/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/card-Lw7_EPZ9.js\":\"fbc8599953a2748c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-WfyOXHJm.js\":\"0d98ad74c31bce57\",\"/knowledge-medium/pr-preview/pr-1790/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-DjZHvn0K.js\":\"9ff586e15f0095f1\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-async-D6txpUFE.js\":\"adfe25c6f0b68367\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-B9olS_Cb.js\":\"9f24d6aed3a02fa6\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-Bn6BqsGP.js\":\"df7ca67980f65db5\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-CDfYAFfB.js\":\"3aea36e3b37ea678\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-D15ZXXF8.js\":\"72705ac2fd67689a\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-D3YFuWu1.js\":\"e16368244b8ab12b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-DyBzYqEZ.js\":\"eb39a3bec2dedde4\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-PfkhdcGs.js\":\"b62a1e74c06995fc\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server-legacy.browser.production-CZQ6jwkh.js\":\"46954c0e75f8fb41\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.browser.production-LchIqTyE.js\":\"5826c55a5972c826\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.edge.production-CzL_ba4j.js\":\"b0bcfec0d87e802e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-p-3jnoFo.js\":\"b27c0b818cb5e4e3\",\"/knowledge-medium/pr-preview/pr-1790/chunks/server.browser-C_7rsIM9.js\":\"0ba5039011df4f00\",\"/knowledge-medium/pr-preview/pr-1790/chunks/textarea-CCij4FXK.js\":\"a5e85fc1e64294cf\",\"/knowledge-medium/pr-preview/pr-1790/chunks/ui-eW68B4m4.js\":\"b96f4c7057cf0759\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-Cw0QXI3_.js\":\"6bfb45abd330d337\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-async-B1GzTLn2.js\":\"9814a68e4ef205ef\",\"/knowledge-medium/pr-preview/pr-1790/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1790/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/src/App.js\":\"5cc2abaa829525ac\",\"/knowledge-medium/pr-preview/pr-1790/src/appUpdate.js\":\"006ea574125a00da\",\"/knowledge-medium/pr-preview/pr-1790/src/appVersion.js\":\"d536f5170289f85a\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/initialLayout.js\":\"907cdcca10f3e276\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/openWorkspaceData.js\":\"eb169a67d6b7ab81\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/resolveWorkspace.js\":\"7eec5f1fb4678fc7\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/workspaceBootstrap.js\":\"8bf95cda70f467d6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockComponent.js\":\"8f9c9273f8e55602\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockCrumbs.js\":\"94b2a8006872d67f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockEditor.js\":\"316a6fe044a38186\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockLoadingPlaceholder.js\":\"b1184f99c9f5fb6d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockProperties.js\":\"fe0faf82203ea057\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockSearchPicker.js\":\"d0b90324e0a82b5c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ConfirmBulkDeleteDialog.js\":\"ab38296ea54eb510\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DividerHandle.js\":\"3fa2ab382bc5d510\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DraftEditor.js\":\"c93f0cb2c69e7f01\",\"/knowledge-medium/pr-preview/pr-1790/src/components/GutterPill.js\":\"90ecfc08d6218c62\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Header.js\":\"3fea5c356fa3488a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/LazyBlockComponent.js\":\"cf0c634029028b05\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Login.js\":\"caba5048f9c1b620\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ZoomableSurface.js\":\"9942fa6b38662e41\",\"/knowledge-medium/pr-preview/pr-1790/src/components/editModeKeepalive.js\":\"2b261b7d07f89652\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyDisplay/PropertyDisplayScope.js\":\"279a5606638cc30e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8f96346f280a5df8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefPropertyEditor.js\":\"6411dd511e4839c1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefTargetTypePicker.js\":\"2703535575f5141d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/SelectPropertyEditor.js\":\"6e046f5bcfea4235\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/TypesPropertyEditor.js\":\"19c1a1147d9cfffa\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/defaults.js\":\"4bf6acc2d1eb6601\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/kernelValuePresets.js\":\"2a8c55b45fe8841d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/selectablePresets.js\":\"b7e02001b46bb057\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/typesPropertyUi.js\":\"85aedb77cc6c69c5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/AddPropertyForm.js\":\"83d807a4ccf90ef4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyPicker.js\":\"82f81d6dd38a361d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyRow.js\":\"bc7d20267d3afeb5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/Rows.js\":\"8f1509928c10b87a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/actions.js\":\"f99350eb015801d8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/declarationOnly.js\":\"f4b17a30b08ae2a7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/layout.js\":\"ee882492dbe7ac6f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/model.js\":\"d29395d91197f179\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapeUi.js\":\"79cbf02c83da260c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapes.js\":\"785adfd2b9a5278a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/usePropertyEditingActivation.js\":\"dd63814eb280f56d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/visibility.js\":\"88d86e0dd9471243\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanelSections.js\":\"78f2ebdef3df79b9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockEmbed.js\":\"7f2cb135a8dc44f8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockLink.js\":\"5e7e171f37bdc115\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockRef.js\":\"f4c57f44a25b4285\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/ReferenceLink.js\":\"5d18aa5d57d4b5a2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuard.js\":\"65f0fae1e3495941\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuardContext.js\":\"ecd4e26ce75898da\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/linkInteraction.js\":\"67a7182e56776f6d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/referenceLayout.js\":\"2ba0fb5123ef7573\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/useBlockRefAncestors.js\":\"ed6467b34766d6d0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockGutter.js\":\"d87bc8b73c685288\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockInfoDialog.js\":\"74edb56953bf9f6e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockTypeBlockRenderer.js\":\"fd80f21727568299\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BulletHoverCard.js\":\"5dd9c5eeb74e2b4e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorContentRenderer.js\":\"1eac73002dcf4ed9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cb222ea9f3479de1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ColumnResizeHandles.js\":\"d94cd27f32de786e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b33301e4bbf1c00a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/DefaultBlockRenderer.js\":\"314e0d5d90c2270a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/LayoutRenderer.js\":\"953ca8685676e959\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MarkdownContentRenderer.js\":\"7ae87308846fa0dd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MissingDataRenderer.js\":\"e24eb00e5c5cecf7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PanelRenderer.js\":\"8d88c5126be949a9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c7145989865930f5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/TopLevelRenderer.js\":\"27ad3c05264b8632\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockGutterMode.js\":\"fdb3193ecab4fde4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockTitleText.js\":\"7ac6b5429eadae54\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/fieldCreationKeydown.js\":\"7f76f0f42fc892d6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/layoutRootContext.js\":\"7be8516c188824ff\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/TypeChip.js\":\"0b3cdda81a863384\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/chipStyle.js\":\"3eb4e54f49190cf4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/anchored-floating.js\":\"a3c53d0a97abad1f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/button.js\":\"81b87ae5317ed3e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/card.js\":\"3b1a690282cd79f2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/checkbox.js\":\"35b7ce8a2724cd0d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/collapsible.js\":\"bdbc3d0154e007ce\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/command.js\":\"9316e3940eaa9afa\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/context-menu.js\":\"efa2b80ee6dfb6ed\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dialog.js\":\"a3e5a6b88d9b7968\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dropdown-menu.js\":\"5046dbb9c83523fc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/floating-listbox.js\":\"abf1b1a3d3be8a06\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/index.js\":\"7a10f6d1929d6a1e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/input.js\":\"5efba0f948f0eac2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/kbd.js\":\"e13258c68fa2639a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/label.js\":\"253210a5712555fa\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/textarea.js\":\"b0688fb26e507b41\",\"/knowledge-medium/pr-preview/pr-1790/src/components/useEditModeYieldKeepalive.js\":\"53126abd3e530845\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/BootFallback.js\":\"a52995883630e1ed\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/FocusedRowLazyMount.js\":\"c2ea9a7599a5f544\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LazyViewportMount.js\":\"a91b12468f6a064d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LocalDbCorruptionFallback.js\":\"34faece9c4ec2a56\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/error.js\":\"a8880ddd5a7f61f2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/lazyMountRegistry.js\":\"dcb630b6f4480a87\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/suspense.js\":\"370e1ba69f1ef78c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/CreateWorkspaceDialog.js\":\"d6ea2e1a8f1b62ca\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/PendingInvitations.js\":\"df88acb25c052527\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/SyncProgress.js\":\"c04f45207a6ed8e4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/UnlockProgress.js\":\"3ce21b1f4529c5ed\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceKeyGate.js\":\"bf3e4802bfc47d4a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSettingsDialog.js\":\"666b28b6a0fb6f58\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSwitcher.js\":\"993bd3d0fbc4bf73\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSyncGate.js\":\"8687d647668a8ae8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlow.js\":\"ed5a2c3e31e83b11\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlowHost.js\":\"bb29438b60fa647b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/EncryptionSection.js\":\"34216af78e8c497a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/attachmentPrompts.js\":\"791a56b481667178\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7062dff297ecb2c1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowDeps.js\":\"fb2398d9f9c67c5a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowStore.js\":\"a6e330495eb818f9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/flowUi.js\":\"683cd20c3cca9021\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/useConversionRun.js\":\"e92c7bf44a74f621\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/keyUi.js\":\"fe1c14c45253eeff\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnKeyLoss.js\":\"ed0b55fd6a70cdd5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnServerE2ee.js\":\"96c18961dc71950d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/workspaceUnlocked.js\":\"43b19d23692eb2e4\",\"/knowledge-medium/pr-preview/pr-1790/src/context/backgroundSubtree.js\":\"8e7e725e366661c7\",\"/knowledge-medium/pr-preview/pr-1790/src/context/block.js\":\"2b50415b16eeb3c5\",\"/knowledge-medium/pr-preview/pr-1790/src/context/layoutWsContext.js\":\"26cc56d6b964a440\",\"/knowledge-medium/pr-preview/pr-1790/src/context/propertyDisplay.js\":\"a78d843da210bda3\",\"/knowledge-medium/pr-preview/pr-1790/src/context/repo.js\":\"2fc7075d8d342f18\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasClaim.js\":\"808dcbc973c474e7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasSeatNamespace.js\":\"277743eec3a4db97\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockData.js\":\"1fd915cd1f05be21\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockType.js\":\"4c69b9601d1fc8d8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/changeScope.js\":\"6f1de5c71fd6f9a8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/codecs.js\":\"2e43356095a9791a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/derivedData.js\":\"4fd8a39c01f478f8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/errors.js\":\"ad7adeb7f6236aa4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/events.js\":\"a5edcb2748f3cfcb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/handle.js\":\"9dce8e9457dc9373\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/index.js\":\"ca0b62a8fc1e6468\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/mutator.js\":\"e36408fc8c818aba\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/processor.js\":\"e4c36d7f38f5d5b7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/propertySchema.js\":\"723f11b29c1d8500\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/query.js\":\"9e673b7a52d41576\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/sameTxProcessor.js\":\"135a89f855b88bbf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/schema.js\":\"9dce8e9457dc9373\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/tx.js\":\"9dce8e9457dc9373\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/typedBlockQuery.js\":\"22c5161aa9bb3e3d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/user.js\":\"1ec42e7ce07e47bb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresetCore.js\":\"d4a94ee7d0c1f566\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresets.js\":\"6e168047db4fe133\",\"/knowledge-medium/pr-preview/pr-1790/src/data/attachmentCleanerIOVerb.js\":\"c2c61c73e1bfb0de\",\"/knowledge-medium/pr-preview/pr-1790/src/data/block.js\":\"f153c81cd02c4a54\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockCache.js\":\"096d1a2352c20745\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockId.js\":\"78a06388c56da9dc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockLiveness.js\":\"dad91f9ff3cbb6a4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockMerge.js\":\"0486096439aae09f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockSchema.js\":\"dbbc625ded0b6dc8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockTypes.js\":\"7f11776006ef54aa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/clientContext.js\":\"9ead0188072952e7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/dbFileSiblings.js\":\"318d8ea997461461\",\"/knowledge-medium/pr-preview/pr-1790/src/data/definitionSeeds.js\":\"ff9dcde79ec9698f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/derivedIds.js\":\"8361f9e790c6b952\",\"/knowledge-medium/pr-preview/pr-1790/src/data/drawnSubtree.js\":\"18b46684a61635c4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facetBridge.js\":\"9dd9496957bc4fb4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facets.js\":\"3794427993a3aa6f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/globalState.js\":\"51714ee9ff58d52b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/aliasClaimRederiveProcessor.js\":\"7a2f70a72d038e1d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/ancestorBatch.js\":\"cead53f87be54cf4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/blockTypeTypeifyProcessor.js\":\"6bd3b4fdb7386d67\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/clientSchema.js\":\"96dcd20c3200799d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/commitPipeline.js\":\"dc625e3d59c63faa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/devAssertions.js\":\"37d06a47c235e3b5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/firstSync.js\":\"ccbbcc8eb71d1959\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/freshInitialLoad.js\":\"b56f57a51b5b6bdc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/graphBackfillClaim.js\":\"4ac9730ac3036c4b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/handleStore.js\":\"7d9946574fd8b678\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/idleMarkerJobs.js\":\"e36628a65763c935\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initialDownload.js\":\"b713f3779021af78\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initializeClientDatabase.js\":\"c316dfbc6b6fc267\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/jsonCanonical.js\":\"20793f878d662b09\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelInvalidation.js\":\"394c4a467fb3f5b7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelProcessors.js\":\"653338df22f74eda\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelQueries.js\":\"81cd70077e886026\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/mergeTypeMembershipProcessor.js\":\"c68067e013a20e4e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/normalizeReferencesProcessor.js\":\"5c6389a3d87aacee\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/poolInstrumentation.js\":\"d2b2aac4a463fbf2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/processorRunner.js\":\"bf691c0dd23d6985\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyCellBackfill.js\":\"fd0ec964483e9730\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildMint.js\":\"225102406b9a8280\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildrenProcessor.js\":\"25de4d2ed7a21a52\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9f3327f5f35df6e3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionSynthesis.js\":\"5289cc1b73f974d4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyKeyScan.js\":\"9e3ef1338b7fb673\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertySchemaResolution.js\":\"10c732eeae4a00a8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/raiseProtocol.js\":\"688822942201df0a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/readBatch.js\":\"06599292ec00dc2f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/refProjection.js\":\"e471982ed4043b82\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetLookups.js\":\"dc112224267c43dd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetProcessor.js\":\"0413d71abfcc122c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/replayMerge.js\":\"3cdff76fe449ca9a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/sqlBinds.js\":\"76f2c7901e670c94\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a5662bd4104b64af\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/arrivalProcessors.js\":\"dda88e21d21f4f37\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/invalidate.js\":\"7ba89e13765ecd3a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/materialize.js\":\"a95b3f3e0997a032\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/observer.js\":\"f3bc1b773024a4fb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/reconcile.js\":\"8d864ddbc0ff4a22\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/timingMetrics.js\":\"0c30dc21561d0886\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/treeQueries.js\":\"9d4935af0f5567c5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txEngine.js\":\"dafc976fb660f6eb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txSnapshots.js\":\"77ded4d66f460839\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/typedBlockQuery.js\":\"39fea720e65ff23e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/undoManager.js\":\"f1b9ed6b32b1ff9c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/invalidation.js\":\"93965a8b2331647e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelDataExtension.js\":\"1e36e01f8c686111\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelPage.js\":\"107cb49ec025cbff\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelValuePresetCores.js\":\"c121b746aa984410\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbCorruptionSignal.js\":\"4aad0e1acb546889\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbStorage.js\":\"01c7baebf9086a63\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbVfs.js\":\"a6c4b2e19fd8d983\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localSchema.js\":\"a9f8fd2e63f5e646\",\"/knowledge-medium/pr-preview/pr-1790/src/data/maintenance.js\":\"747befb6cbb552ba\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mergeProperties.js\":\"79fc0319177704f3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/metricsConsoleHook.js\":\"027fc463a98f3f1b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/migrationsPage.js\":\"5c54d43082b43833\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mutators.js\":\"69cf8fdc57957584\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKey.js\":\"6ac66b3df221ec78\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKeyPlacement.js\":\"a7ec3b40b1137ffd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/outlineSurface.js\":\"9529d42ea8702a19\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingEditorContent.js\":\"a17017a70dccfa95\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingUploadsSql.js\":\"7964370f6681fef9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pluginStateExtensions.js\":\"e14f79786bb97c1b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/powerSyncLogger.js\":\"f600acc28f45d53b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/projectorRuntime.js\":\"8537516cfee4df51\",\"/knowledge-medium/pr-preview/pr-1790/src/data/properties.js\":\"1d11141640770756\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertiesPage.js\":\"5021c242a402e30e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyChildren.js\":\"f6f37f750b67b38e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionFanout.js\":\"9f39c82a00ccc017\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionMetadata.js\":\"4dca31d002bf645e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionRegistry.js\":\"54db47ab52396fd8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDisplayMode.js\":\"eece870d0c8eb8b5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyRowCreation.js\":\"668c77c019644ebb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySchemaCreation.js\":\"159bde6f2da2ba69\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySeeds.js\":\"1f1d91d2e3cf9cc2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/recentsPage.js\":\"fd1fffcb14b3f19c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/referenceBlock.js\":\"e7c4e017a17e9b0b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/releasePowerSyncConnection.js\":\"a2bfc0bd264b7db7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repo.js\":\"544b216254afc819\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repoProvider.js\":\"cad9c229c57ea250\",\"/knowledge-medium/pr-preview/pr-1790/src/data/rowProperty.js\":\"97406a70949a0f73\",\"/knowledge-medium/pr-preview/pr-1790/src/data/searchFilter.js\":\"124a7aa5649b6947\",\"/knowledge-medium/pr-preview/pr-1790/src/data/seedIdentityLedger.js\":\"11f623a665fb02ef\",\"/knowledge-medium/pr-preview/pr-1790/src/data/stateBlocks.js\":\"882d303f127a7906\",\"/knowledge-medium/pr-preview/pr-1790/src/data/structuralEditPolicy.js\":\"a05520fed309892c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/subtreeDelete.js\":\"b65cb54ce308ff89\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncStreamLock.js\":\"be6c84b9506d4071\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableSqlRecognizer.js\":\"955067c2b91cf24e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableWriteGuard.js\":\"7d5a035281ced267\",\"/knowledge-medium/pr-preview/pr-1790/src/data/targets.js\":\"eeea9d29d30db920\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeColors.js\":\"bce4dc84524f14aa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionMetadata.js\":\"98b379dce294773a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionRegistry.js\":\"595932c95a1ada00\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeExtraction.js\":\"e95e95a09465af1a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeInitialValues.js\":\"a09ecb093f6f4fcf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typePropertyGroups.js\":\"42a9ae4bef952e9d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeSeeds.js\":\"8e6f44f3890fac3d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeTagger.js\":\"aa1b042f9443bb77\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typedRecords.js\":\"1e4bd6d3dcc1057b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typesPage.js\":\"9d81b68849d64219\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userPrefs.js\":\"070bdd947f782d8d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userSchemasService.js\":\"f057caa070f2abb9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userTypesService.js\":\"2d4e9baaac012b8a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/valuePresetRegistry.js\":\"6d10dcb7b579aa6d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/visibleChildren.js\":\"bf5fa9ee1f466925\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceConversion.js\":\"b9d64e7a933dba5d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceFirstSync.js\":\"f9aba5bf65ea20fb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceIdNamespace.js\":\"530e826dfd4285d7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceSchema.js\":\"e74f269ce7c7bd6c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaces.js\":\"2f39a53de9cc3b36\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadLog.js\":\"662e1aa7b2f78ae1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/BlockPasteShellDecorator.js\":\"77d2a76c2c7e27be\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/atTrigger.js\":\"5d9375fe5bfe7955\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/autocomplete.js\":\"3d9704102e2097e5\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/codeMirrorExtensions.js\":\"08ed58abb8ae626e\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/contentFlush.js\":\"dc3f7f1c188a1df4\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/defaultInteractions.js\":\"bfd3ceb6354552a4\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/editSettleSignal.js\":\"9f381b673ac63435\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/insertImage.js\":\"a785a2484d43a86d\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceCompletionRange.js\":\"1ef9c4c16b7833ba\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceTargetTypes.js\":\"461359ff7f9e8e48\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/syntaxContext.js\":\"16a5aa1b851bde4c\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/triggerMatch.js\":\"e1b0270a637d695a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/AppRuntimeProvider.js\":\"795840023d20695a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/BlockFocusShellDecorator.js\":\"d3814da20e98a73c\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/ExtensionRenderBoundary.js\":\"42b3d695499dd5cb\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/PanelContentRecovery.js\":\"093e058ce3b01580\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/apiCatalog.js\":\"6c706fafea37bb60\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/approveExtensionHere.js\":\"65b742e4f4d99356\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/armedCutAppMount.js\":\"e265f36b694791f4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/batchableKeyedStore.js\":\"2ffb282a2557f16e\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockInteraction.js\":\"360522dbf84c1685\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockSelectionAction.js\":\"83dc80a845be0132\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compileExtensionModule.js\":\"635d941d396b2e85\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compiledModuleCache.js\":\"2c3b019484d94468\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/continuousGestures.js\":\"913c8240892c6373\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/core.js\":\"946ba4c0b006a6fd\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/defaultRenderers.js\":\"114c50a0a1ae9954\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/definitionFanoutAppMount.js\":\"2846fe648d4d2aee\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dialogAppMount.js\":\"40caec47b2091dd2\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensionSeeds.js\":\"922fd712ac4a0129\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensions.js\":\"6b69bebeb184989f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/exampleExtensions.js\":\"7176deb74eba3eaf\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionApprovalStatus.js\":\"e28b3d486c5cd292\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrorToast.js\":\"f41654473ed77813\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrors.js\":\"c27d43e992be1336\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLookup.js\":\"a2608b07b5246786\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionToggles.js\":\"6c379c7b159ab45b\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionUtilitiesCss.js\":\"96149b02020de132\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/kernelPageDeletionGuard.js\":\"14b45c2c2cb4e0aa\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/liveRuntime.js\":\"b89a519972b25366\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/openExtensionsSettings.js\":\"286a095a670c032b\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/overridesCache.js\":\"704665f2d031cb32\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/pluginIds.js\":\"bd16f93c967042f4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/processorRejectionToast.js\":\"19fa25a49e067b62\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeActions.js\":\"f0c1455dc748ca0d\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeContext.js\":\"7f9e0d7e11818cb1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticAppExtensions.js\":\"93afe25fbcf418dc\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticDataExtensions.js\":\"8ee46a6a68d778ac\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/toastAppMount.js\":\"16799d534c23837f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useOverrides.js\":\"732043df0f136c07\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useShortcutSurfaceActivations.js\":\"2594f62362e38f69\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/discoverToggleTree.js\":\"7143341a3bcc509a\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/facet.js\":\"efb3d401edf5895c\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/resolveAppRuntime.js\":\"143647bf8fdcca55\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/runtimeEvents.js\":\"f70acda7484feb5d\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/togglable.js\":\"a7a55578e55ee097\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/variantFacet.js\":\"797b5833b1bece72\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/verbFacet.js\":\"d9d222bf95a644c6\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/block.js\":\"98aa4041f743f8cf\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/focusedChild.js\":\"2248a6500400646f\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/propertySchemas.js\":\"6480ee2ddd6883bc\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/typeRegistry.js\":\"358f9ccf831afee0\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAncestorCrumbs.js\":\"89574a1986ddf2e8\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAutocompleteListbox.js\":\"a56f51c30f3387ad\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedSearch.js\":\"3156e6119e7efe3e\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedValue.js\":\"518f16f839ff3e08\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsFocalRender.js\":\"6c9c0e2885af5188\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsReadOnly.js\":\"f789534383a60489\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMaterializeBacklog.js\":\"663306299551831a\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMinuteClock.js\":\"93b387c3493fd3b4\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePanelLayoutProjection.js\":\"64bcbcbf62e3163f\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePendingInvitations.js\":\"3610bdff00b75a11\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRendererRegistry.js\":\"a2387655d5fcb370\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRetainedFieldRows.js\":\"776ffc9aa4b6a1f2\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useWorkspaces.js\":\"10fbae1245ad91d0\",\"/knowledge-medium/pr-preview/pr-1790/src/lib/utils.js\":\"fe7fe79b64d1adcf\",\"/knowledge-medium/pr-preview/pr-1790/src/main.js\":\"6ca4dcf3978f82a0\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/MarkdownImage.js\":\"d83c7c221ac716de\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/blockSeparators.js\":\"b9e8d79fd8c40be5\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/context.js\":\"ee65bdbe3511532c\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/defaultMarkdownExtension.js\":\"edf0a09ed4f9e96d\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/extensions.js\":\"b8cb7c7c0c06a55a\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/renderMarkdownHtml.js\":\"b3a6017f35fd2d97\",\"/knowledge-medium/pr-preview/pr-1790/src/minimal-editor.js\":\"0340018d78d8a1b8\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/armedCut.js\":\"d166816e98ca83aa\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/captureMediaVerb.js\":\"3e23662eece32b1e\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/clipboard.js\":\"349bb0d8c6197ff6\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/decision.js\":\"0573d79d551dadf1\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/operations.js\":\"6f42fe0c87eb7647\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/AccountHeaderItem.js\":\"4e7fde9c6ace8ba0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/index.js\":\"c0d04bf9ca3772de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5b1f805bdc8c1527\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askAgent.js\":\"59bb2aa2bbfa2391\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askedStore.js\":\"224634045b580331\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e8655b68b20f05e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/chipState.js\":\"4a6e352e2fdd4232\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fe6ae4e979cef433\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/index.js\":\"0f4eeeff15f834f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4b5934c8c21ef0ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/schema.js\":\"2668e602a8d3e143\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e9d0e43ad9c3ac2a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4eba94effae50ac4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/addMedia.js\":\"d21faf09b4884a08\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1d56af391e0ae4bd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/block.js\":\"a4a8e0c058db18d3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/context.js\":\"35a65dd6bd7bb906\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/displayIds.js\":\"79b034cef3ed0c06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/index.js\":\"c8f77c1c7c178c57\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/outline.js\":\"be1158c903070f9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/properties.js\":\"173ce4a1fa21faa8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/refs.js\":\"dd54c3e4027e95fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1727aa55db5159bc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/search.js\":\"5ef2e9d9acb72692\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/shared.js\":\"92b324f6f8db9fa9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9e1e0aef87a73b04\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/text.js\":\"1744b7b247591486\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentWrites.js\":\"b9c2091c61bc0b16\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/authoringCatalog.js\":\"ef89b3e7522c1618\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/blockRefTargets.js\":\"7244ee093a63b3d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridge.js\":\"878c01f2aac28fd2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridgeLoop.js\":\"259b312175c725dc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/changeHistory.js\":\"858ec74827b90465\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commands.js\":\"6eff4b787d4bc312\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commentsCommands.js\":\"6e46f11b27e804dc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataExtension.js\":\"123fadd3334da69d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataModelGuide.js\":\"7cfccd1c8740616c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/describeRuntime.js\":\"f37a223d7611f20e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/extensionLint.js\":\"d91ed5d887d06d8d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/grainAudit.js\":\"ea70899c0ed316c1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/healthCommand.js\":\"322f226ce810405e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/index.js\":\"313354e51b126e38\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/presetIdentity.js\":\"b18d823fb684bded\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a30749024953ae26\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/readMedia.js\":\"4380ac56512ee492\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/schema.js\":\"5e51b92ab2a4681b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/serialization.js\":\"2fe64ff2bb9bcd9e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/targets.js\":\"58fb57df4dbb79df\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/tokens.js\":\"c96897c081df1987\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/watchEvents.js\":\"1091b07d800ca39a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/workspaceGuard.js\":\"06f515e512cc4003\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/writeCommands.js\":\"a3a67d825a48b78d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/AliasCollisionToast.js\":\"ad9f11eac43bb836\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/DuplicateNameBanner.js\":\"81a3951c51a2f57d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/collisionMerge.js\":\"d4a40ee6838a149b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/dataExtension.js\":\"f0f515f8c5d37943\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/index.js\":\"e1309ca6a7fb795c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/mergeCollisionAction.js\":\"4c93959731b42bd6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/pageStyling.js\":\"ab49955c0de20531\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/rejectionToast.js\":\"b4ec9d3cfb3caf4f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/syncProcessor.js\":\"256394c4c72d5db9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/actions.js\":\"77d5cd61905f1f21\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/addComment.js\":\"31803b876a939ca6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchor.js\":\"875eeece16dd02a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchorState.js\":\"1be9c32f73a89d85\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/commentLinks.js\":\"b186f5edef57023e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/confirmThreadDeletion.js\":\"ef346f91720063b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/container.js\":\"f78b8e439f2cc472\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/dataExtension.js\":\"05b47862a3b8865d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/deleteComment.js\":\"c97ef0a455e602d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/highlights.js\":\"b8a9caa5e408d5b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/index.js\":\"f83ebcd7346ea83e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/linkedCommentsPill.js\":\"bf2c01b8b4f38802\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/margin.js\":\"5f8cbab9b8a2f213\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/marginSchema.js\":\"0e091ad6ea013c31\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/newComment.js\":\"ea8bd82e960b9f58\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ownThreadPicker.js\":\"4dd46bf8b595fb19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/placement.js\":\"a460d1988d0fd89a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/queries.js\":\"a1aac65373529aaf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotePosition.js\":\"7e18028c861e1a81\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedIn.js\":\"d91720000f6e3bc3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedRange.js\":\"4539ce435bba31dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/rangeRefs.js\":\"c5ecf474f7009419\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readHighlights.js\":\"15b59aaaaee29b1f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelection.js\":\"667d16828eb759a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelectionUi.js\":\"ef4a332947c75340\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/reanchor.js\":\"c87941b436e46785\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/schema.js\":\"5e7f2384e017ceff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scope.js\":\"5f93eb9fbcd3e821\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scopeThreads.js\":\"22176d9a68aea779\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/splitRetarget.js\":\"d421844bd07800e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestionCard.js\":\"65e1404c0793c220\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestions.js\":\"56a244865c197d4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaries.js\":\"3f8b7b60c8fa4d4f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaryBatch.js\":\"9afa8266c44236d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/surface.js\":\"4ff7911c7db99352\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threadNavigation.js\":\"6bc129ffa3a63767\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threads.js\":\"7e5c08fed66b65e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ui.js\":\"4fb4dc3c35245861\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/uiStore.js\":\"3a214bbffd6e93d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/appIntents.js\":\"c385e7c5a6799faa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/index.js\":\"464d865a353331de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/index.js\":\"bf45c665a066d2cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/status.js\":\"3c44042dc2c829f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7b915be9543b2e17\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaBlockRenderer.js\":\"e684d75f82a5bea9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2001990639eb178b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaUploadReconciler.js\":\"5742f584a65e717e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetDownLane.js\":\"a31df962dcb4baf8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetResolver.js\":\"ec1784e3c9e1c81f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetUpload.js\":\"b33b526ecf10921b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/attachmentCleanerIO.js\":\"89d26a1fab5be04c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/supabaseAuditIO.js\":\"db5aff45bf8511d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/blobStore.js\":\"8e98e6f549928629\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/byteStore.js\":\"69a27f9623c25377\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanerIO.js\":\"364a4188cb29e1bd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanupAttachments.js\":\"512ecf03def97a29\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/dataExtension.js\":\"73e750ae38d73212\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/downLane.js\":\"29bb004dddc8c45a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/index.js\":\"169219ceda2e68e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/insertImageContribution.js\":\"7d228b3de9ca7fc7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneArming.js\":\"21f21ae0b091dabc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneLock.js\":\"3203a95c1de5f4b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaBlock.js\":\"686e57200bbf6bf2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaCapture.js\":\"07447d2b1b45ff39\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewers.js\":\"2617ca4b79ac4250\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewersFacet.js\":\"df82e48a4cb2565f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/pasteCapture.js\":\"59d686e355c8ea58\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/resolver.js\":\"be8b59477912d921\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/retryUploadsAction.js\":\"8e65f5bb9d85e817\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/storagePaths.js\":\"9f2acf0cb775f39b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadDrain.js\":\"d5e4f86b198069eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadLaneStatus.js\":\"8a36648d801a6d3d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadReconcile.js\":\"090d257cfc4eeefb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadRecovery.js\":\"815598cb999168b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadStore.js\":\"72e139d174259789\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/useAssetObjectUrl.js\":\"680f7b846fa20c90\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"00c5093abf508b1b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8a5d33664e46edb1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/facet.js\":\"750abe344b28b53a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/index.js\":\"7811d678b0dc7144\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/prop.js\":\"7b456efbda35ac3f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinkFilters.js\":\"875e49af82a4aa69\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"588a88b43ddf2f5a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BlockEntry.js\":\"402f96881be930e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/LinkedReferences.js\":\"f78e1639e0e7df79\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"820f0cfb45f7a52c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dailyNoteDefaults.js\":\"e6dddd19f7a322d9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dataExtension.js\":\"51dbbe11e90260df\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/edgeExclusions.js\":\"8875f68cc6c1a026\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/filterProperty.js\":\"acb23fbfe289d93b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/index.js\":\"8cf556449a4c0dc4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1b9f8d52713e1d67\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/applies.js\":\"8bc955bd2f3df298\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/countQuery.js\":\"2783132649832de2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/expansionStore.js\":\"61477632c28054db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/index.js\":\"ed539729c25c2d61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"daf852c651ff56de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/presentationInvalidation.js\":\"008c6e7f5632eedd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyEditorOverride.js\":\"c467f812fecfec78\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyFilter.js\":\"72e0be5d0be9b547\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/query.js\":\"79720bf1f5edc62b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/resolveFilter.js\":\"56a06c3f395914fb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sourceBatch.js\":\"e69bb1f97a2b06f2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sources.js\":\"df8d262dbaf702be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useBacklinks.js\":\"5ba42b055ddf574e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"968a4ee87a3f39f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayCelebration.js\":\"cadf906c7519d600\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayOverlay.js\":\"1c38f51e281ad466\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/gate.js\":\"1dea4c2d1e96b40e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/index.js\":\"868e0a67b2355e5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/wolfTheme.js\":\"748be8cb2d9f70a7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/BlockDragLayer.js\":\"c153066dbb06b157\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dragController.js\":\"42d675d2397fc871\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dropTarget.js\":\"12c52c94097911e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/index.js\":\"93952f49cb7a1d41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/projection.js\":\"b0b0649649aa3075\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/BlockMetaCard.js\":\"594324959669fc00\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/index.js\":\"939834347953fab2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/AddTagDialog.js\":\"55f27125fbd252af\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d2ef422374aeccad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/TagNameIssueHint.js\":\"b80e78649de5b9dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/addTagAction.js\":\"77ae5df8d34db46b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/appendTag.js\":\"9c7712521b8ef743\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/config.js\":\"07a7cf4672063a98\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/dataExtension.js\":\"99b75322d1338e5a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/index.js\":\"f472703e0d5e0a9d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/propertyEditorOverride.js\":\"9e4ec77ee4e45adc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e17d02e75317f4e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a3ef5b12992b9c67\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b7e56667fdad2d9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4cab30b79e7f780e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c8ef4adb88c13816\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/index.js\":\"858c8569bd7ef9ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c4662f9fb4a3cf17\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/CharacterCountItem.js\":\"a28a881ee2db9c45\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/ProfilePropertyEditor.js\":\"53baea55b0a13285\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/actions.js\":\"12f0acbb72648a8b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/blockType.js\":\"6c82dbc470891ba1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/charCount.js\":\"b46a15f9d00936b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/dataExtension.js\":\"dc5edb1b1dba5934\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/index.js\":\"ecafef070200ef5e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/profiles.js\":\"c2fe6f38953e52d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/properties.js\":\"014eec8c127e8202\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/textCounts.js\":\"6fad5a74ea69cc0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/colemak-keybindings/index.js\":\"473782982c6e8cd6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/CommandPalette.js\":\"fdafee0219d707f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/HeaderItem.js\":\"7b9aa041f35f0dda\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/context.js\":\"39f6dac77a30ee12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/index.js\":\"cf7560e56af782c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/selection.js\":\"716b1781578ca291\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/toggleStore.js\":\"744772c8c0dec483\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/useCommandPaletteActions.js\":\"adcabd735fc6d1db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/ContributorBadges.js\":\"302ffded986bf320\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/author.js\":\"0abea1405c7d28fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/codeMirrorExtensions.js\":\"be4258fda6981205\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/dataExtension.js\":\"9020d0f09a12fa05\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/index.js\":\"b5135327203f8a69\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/mentionAutocomplete.js\":\"6a7403166c3cadfc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/processor.js\":\"0c574dba8894acd2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/profiles.js\":\"125aaaae92eee82c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/queries.js\":\"58c69c2e9d4ca9d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/schema.js\":\"ff9a333e63eaba68\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"87131992171bafe1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a0a1e78daebb71d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/index.js\":\"bed772c9095d9528\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a18501a7d50e9f2f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"623a5ab828b01642\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/CalendarGrid.js\":\"c5f8705519349c51\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DailyNotePicker.js\":\"77e95f8117974a80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e9c181201e58cdc2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateNavDecorator.js\":\"bd027061e23f5a63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateScrubOverlay.js\":\"c425f1f7b151af73\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/HeaderItem.js\":\"cee946c8f58d2ed2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/ReschedulePicker.js\":\"f9eb9025a9971160\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/SpreadDatesDialog.js\":\"be2399d3c2e0e200\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/actions.js\":\"1ade166cfe8065b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/blockDateAdapter.js\":\"e66c59c9860226d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/calendar.js\":\"5f1204d6be8ac799\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dailyNotes.js\":\"d552656b1d6ceeb9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dataExtension.js\":\"73bf346a1a9ac7d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubActions.js\":\"36bca4aa161b35e5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGesture.js\":\"b80c86b0dc8b4cef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a0dca36184bfd1fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubRecognizer.js\":\"61f25786a4d6f444\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/deletionGuard.js\":\"0963576ded6548eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dueQuery.js\":\"dbdbef2ea1ffffb2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/index.js\":\"8fcf7a98fb1789a9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/landing.js\":\"2a173ac6ffec9edb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/localSchema.js\":\"2c494fd166fe3ea9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/referenceDateAdapter.js\":\"12651d528d878b1f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/rescheduleAction.js\":\"ae726d4b175e4c26\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/schema.js\":\"a7833e6d7905c2f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadBlockDates.js\":\"8aa0d813d9247fd2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadDatesAction.js\":\"dc6997df00c90796\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/today.js\":\"e30f9ff9d32cfe80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d91505c0d37a62cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"29c29e1c5eec2419\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/audit.js\":\"ac0b7f55bb8894b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditAction.js\":\"306a7dbeaec379f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditRanges.js\":\"6d83832a9bc43ce5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/diagnosticsSource.js\":\"c6279d1aad5b75ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/divergenceScan.js\":\"a5a17def2d24c5f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/index.js\":\"1033334787cc54cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3f717f323c947563\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/referencesMirror.js\":\"2594881d5d99d810\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/rowJson.js\":\"c9f8e59e3b9342dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/schedule.js\":\"d9b0d39eb0c62a3f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/store.js\":\"4bb3224a09a7f267\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/action.js\":\"39aaa01f29281593\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/index.js\":\"d442337f7746752f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/plugin.js\":\"336f17cb09762c56\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"341ba40f1b7824ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/actions.js\":\"58019ae8f8f15e50\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/changeMarker.js\":\"9884e299a8250b82\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/diagnostics.js\":\"fb5146ff4c10e378\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/fileSystemAccess.js\":\"95d619359869eb23\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/filenames.js\":\"15de90c5b0428667\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/index.js\":\"b65684c16dfc147a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/mirror.js\":\"b8e8fa85e90cb6ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runLock.js\":\"11cc3304878ca24b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runtimeHealth.js\":\"144818370e967b5d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/schedule.js\":\"a04c1b88d033078c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/store.js\":\"cb820b032bec8b69\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/index.js\":\"66996248e4dc24b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/themes.js\":\"4360389c430f2740\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/facet.js\":\"1fb1832f9b64295c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/useDiagnostics.js\":\"67788e5ad0983282\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/dismissals.js\":\"fe098136fb48cb61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/index.js\":\"2e41d22169f82be8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/status.js\":\"44a4231a4f5a60b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/store.js\":\"9d4476e1a0dcbfcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"12e2749de968a5b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bb6e979b8a6ecee3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/actions.js\":\"fa8232847a6a1215\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/config.js\":\"7fb161689cc72ad5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/dataExtension.js\":\"31045c676cce325f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/effect.js\":\"bec480e0a66cc79e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/index.js\":\"f157f7ca10c8ba41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/propertyEditorOverride.js\":\"b9b7c19cd76e1c6b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/useToggleTree.js\":\"91208bfe7f3f5a14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/ExtractTypeDialog.js\":\"48e812e9089d0c41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"8d10f991aba0e4c4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/PropertyShapePicker.js\":\"dd150da4b1015914\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/action.js\":\"b134610552c5fea7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/index.js\":\"4ff550b857e4d5a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/FindReplaceDialog.js\":\"739872b7cedcc798\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/HeaderItem.js\":\"eef94f4b0690941f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/dataExtension.js\":\"c56d2d98a922e876\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/index.js\":\"abda38cb9840d279\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/search.js\":\"aef76596dca5b2f1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/toggleStore.js\":\"8db3fecfe0b6619b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/LocationPropertyEditor.js\":\"dc16a54d36e4204f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/MapView.js\":\"db5f75f506508b98\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/blockTypes.js\":\"39bf15808a94d674\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/codeMirrorExtensions.js\":\"fe07402c2b838869\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/createOrFindPlace.js\":\"7ba3d876a22e747f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/currentLocation.js\":\"4dcbae9284507da2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/dataExtension.js\":\"b2afb86a58197906\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/geoContentDecorator.js\":\"9cc8f3652e4e0cb4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/googlePlacesClient.js\":\"579de3e11763bad4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/index.js\":\"3b7e7ffecf6e7f69\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/locationsPage.js\":\"29bed0c47d702d1d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/mapViewport.js\":\"d28e773027681fdb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/pickCurrentLocation.js\":\"bf850e40ce7e8e05\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeAutocomplete.js\":\"5dceb05223498dc7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeNameCollision.js\":\"a0efad0beb867cfc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/properties.js\":\"5f1a86d26cc41564\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/propertyEditorOverrides.js\":\"3773ea371a01587c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/query.js\":\"5ad5de71e72160f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/usePlaceSearch.js\":\"d1fa67268d7ee43d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"77548357165daa11\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"22a22634124a1160\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"138d74cf39281f6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/config.js\":\"ba838a5ee7fec686\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/dataExtension.js\":\"0fbe839a4d561530\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/facet.js\":\"b2f36189019facce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/grouping.js\":\"eb1f783eac315eea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/index.js\":\"ab9ffde359422cc6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3d7c9a54d88d91bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/query.js\":\"90d4cea1bb48641d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/resolveConfig.js\":\"f6c1b1a8ccc9ad06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"443e4d102906f316\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"88f83e74eaf9d668\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlDocumentContent.js\":\"b8aa9684b3688eaa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlFrame.js\":\"1deabb9f17b08adb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/actions.js\":\"b23bd3d2249486a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/blockType.js\":\"060c658aae0e0e1e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/confirmRunScripts.js\":\"3cb37032a0df6b64\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/dataExtension.js\":\"993b08c1246cea15\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameAnnotations.js\":\"b5a8fd5ad94a6581\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameDocument.js\":\"0784bb0441c31a81\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameTheme.js\":\"be40b15fb07f12aa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/index.js\":\"27338afdef5bb815\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/scriptConsent.js\":\"fe1be80ce910b681\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/sourceMap.js\":\"c34e5aea2f170b37\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/useDocumentScripts.js\":\"d45bd745f9209bfb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/index.js\":\"48707b9f724841ba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/record.js\":\"bfb9c3925dfb4865\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/recordStore.js\":\"6cd8336adebb63ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/responsiveness.js\":\"32d6c2eb29c152aa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/schedule.js\":\"eea8b2935369f0b1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/sessionContext.js\":\"18d87cefa9f07afd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1c005035a7364395\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"54044536cbabc399\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/actions.js\":\"ec788b26c82c7c06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/config.js\":\"3f459687540f71cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/dataExtension.js\":\"c39ac5234a6b2dc0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/effect.js\":\"ea731ba3ebb64e67\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/index.js\":\"8d68d000f45f07d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/keyCapture.js\":\"4369395664e70eea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/overrideStore.js\":\"1743f224a95c98cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3d0e29bc765a8956\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/HeaderItem.js\":\"272c241a4ee84110\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/LeftSidebar.js\":\"b3f17453ff614d53\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/actions.js\":\"b0fc2c7845bb8934\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/facet.js\":\"70dec199b9617f3b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/index.js\":\"6b45a3182657274f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/shortcuts.js\":\"a9bf08e7fad22ebc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/toggleStore.js\":\"0f3b85c2aae0b847\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/MergePicker.js\":\"25e45c4be166672f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/index.js\":\"05a028504b764cee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/mergeAction.js\":\"f41ab014362be616\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/strategy.js\":\"aa545a8a7c8378da\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/Button.js\":\"a814af06c82f5dc9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6eb8f6024df179fb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/defaultItems.js\":\"926aafd7f3bd504c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/facet.js\":\"7dae89be8947a8e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/index.js\":\"5409a0b2ff39510b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5b3ddcb10bf7e68a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/actions.js\":\"25077ed1b1b28531\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f72158c1678c0a7d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8af53e938af86bf6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/index.js\":\"dd7b27f3d9074168\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/MoveDestinationPicker.js\":\"86191ad44088b6c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6e0ca2f3cf28447d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/contextMenuItem.js\":\"da7a2dc5ea11fc1e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/index.js\":\"7eea4522683d97d0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveAction.js\":\"bc4f363e6cc5091d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveBlocks.js\":\"25832d5a2582f447\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/selectionAfterMove.js\":\"a580066bf7d66d73\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/TutorialBanner.js\":\"d17387bd185b8c02\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/action.js\":\"6b07e6d5af4e0837\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/bannerDismissal.js\":\"0d47b6ca46c0d498\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/documents/cheatSheet.js\":\"dccd044f06bdbb40\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/index.js\":\"6fcecc4a1170cf7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/keys.js\":\"b4d59887f9eea12e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/landing.js\":\"0738cb820a26b304\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/outline.js\":\"3d2a573afd2bf24b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/seed.js\":\"bb0c645e90ab7a20\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/PerfTrendDialog.js\":\"596d289fc277b30c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/analyze.js\":\"aca606635eff84d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/diagnosticsSource.js\":\"f2c2a927751d0a2e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/index.js\":\"ba5e0ad3e39e334b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/load.js\":\"8b3c837b3878f718\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/monitorRun.js\":\"9b8f4d212919da4b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/schedule.js\":\"a831b1b5a03f23f7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/series.js\":\"b6e85b95d1faeb44\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/store.js\":\"254de0b21bd2d91a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/trendAction.js\":\"8581c25e818081a0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/verdict.js\":\"b6b7210c930e256a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/clickToEditAction.js\":\"9fbb98cee90e9fbc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/index.js\":\"a02c34e3c22af18f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/interactions.js\":\"53aa6edea7d69fbc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"bc4abcf999e5f1b2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGate.js\":\"659cefeb94f9fe00\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGateDialog.js\":\"e75c366122f61581\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/action.js\":\"f9110eb71cfe7da3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/index.js\":\"188ca647830ab1f1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/localRunMessage.js\":\"0240dce383b83db2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/plugin.js\":\"fcd30bfc45fb60e0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/progressReport.js\":\"5945bbd070471bdd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/sweepProgress.js\":\"6721b048c9a226b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/FieldRowRenderer.js\":\"d9eade348d278ac6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/ValueRowRenderer.js\":\"c828d9996bcf27c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/actions.js\":\"0997005f59b6abaf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/autocomplete.js\":\"01c700921c4184e2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/fieldRow.js\":\"a5eac4d14ac2ea8d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/index.js\":\"7b6544bb611eb7ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/referenceWarning.js\":\"a6cb4aeba6be6a58\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueAutocomplete.js\":\"75ab637e4441d389\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueSchema.js\":\"04c46792f4b16908\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/HeaderItem.js\":\"9f86d00a3739692c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/QuickFind.js\":\"20778bd82cbc8808\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/index.js\":\"0a5c9ed316c1f9d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/recents.js\":\"2fcf3d18e7134c0e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/resultItems.js\":\"b0299ce11b45d505\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/selection.js\":\"08ea8045c95a5fc5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/toggleStore.js\":\"fb0ab1224a77cc10\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/HeaderItem.js\":\"866d8327ab40f294\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c2c1bf35f8024c27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/grouping.js\":\"51148a8397c68ac4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/index.js\":\"947828783eaf134c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/target.js\":\"7b97a7bdff6aa11f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/codeMirrorExtensions.js\":\"ff1e7e0c6da867c1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/contentPrefill.js\":\"c5d05b8901b85d88\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/dataExtension.js\":\"fcf2247bd6433b35\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/index.js\":\"e3f2f8ae2ef6cd2d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"954d29f1c3bd9d96\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/invalidation.js\":\"fd4ec036c0e2783d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/localSchema.js\":\"3c57867a5ee8d193\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/index.js\":\"fa28feb3f67c8799\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0510bd64fcc0f60e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/index.js\":\"eecb236ffa02d25a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/referenceNode.js\":\"e2a8bd4ce8fbf568\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2e2ac19bad8f2faa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"553d9d56e9ad5667\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/index.js\":\"fd09767eb31b61cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"154cb3a7a002f1cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ddf6dc6fed1f92f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/mergeRetargetProcessor.js\":\"9abcb37b95527abc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/parseFence.js\":\"d8e9333bab40e95b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceParser.js\":\"1f44e8aa7ae0c54b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceProjection.js\":\"7348aa1458a57c3f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referencesProcessor.js\":\"9c950d4901c1ed5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/renameProcessor.js\":\"c03c4aaec4eca152\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/spanReplacement.js\":\"eb93a11b0e824721\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/htmlToOutline.js\":\"7682ea6021b3e2aa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/index.js\":\"24313ad303e8930f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/normalizeClipboardDom.js\":\"924a0f74fcf94f4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/pasteDecision.js\":\"b005521a19828a85\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/action.js\":\"6e32601031bc1c94\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/blockIds.js\":\"21ddc9325a66ab80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/content.js\":\"eb639a2fb7c2402e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/effect.js\":\"c985da4d3515290e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/ids.js\":\"076c51cb713c315d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/import.js\":\"6fe20e5e5860aa96\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/index.js\":\"36f505c82674150b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plan.js\":\"cb23150504c6084a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plugin.js\":\"9772b227226877e3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/promotion.js\":\"e5cc50260bc506da\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/properties.js\":\"acd2452d88fb1fdd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/references.js\":\"24384408378be082\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/report.js\":\"25f971cd8ce15bae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/roamMemo.js\":\"b474b8eec63e2087\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/runtime.js\":\"e942b2e3958238b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/schemaReconciliation.js\":\"96cf91458942302c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/srsMarkers.js\":\"94df64b6a0930ddd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/todo.js\":\"9c00122b08f98f51\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/typeCandidates.js\":\"4353f617305fea54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/types.js\":\"e60ea8e95fe7865d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/index.js\":\"2f5ebbf630446b57\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/store.js\":\"e4e4cdde8e463499\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/HeaderItem.js\":\"a4e334a438b45c21\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"23130d7ebd840624\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/index.js\":\"3729bcffb18f6588\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/model.js\":\"f1ab3a259d7ba0f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/toggleStore.js\":\"c63009ee47b33675\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/useKeyInspector.js\":\"eef3d745b1d189e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9b1bec43dbc03602\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/ShellDecorator.js\":\"1f505333bbc8d645\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/actions.js\":\"40876d1d3be591ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a2a3ed800833d59b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/index.js\":\"ca838c3c226d16d3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/shell.js\":\"614bcb73c22233ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/surface.js\":\"05a7965b164afc9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/walker.js\":\"cf2f065ff430f776\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/RescheduleToast.js\":\"19271df0d566c719\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/dataExtension.js\":\"e4d63f2314b624c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/index.js\":\"24c0377b5e158268\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/indicator.js\":\"d255c53a0a52cb57\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/moveSrsState.js\":\"961cb990f1f8b97c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"025c73abbddfb94f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/scheduler.js\":\"acb437d942399032\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/schema.js\":\"93a7da809f6857c4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"da30b4580be2fe4f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsClipboard.js\":\"8b47c2ada8d939c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"78a35a357a70c50b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DailyNoteReviewHint.js\":\"556e1dd5a92b64b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DeckPicker.js\":\"00cd0c559fa77586\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewControls.js\":\"fba809051e2ce92f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewDeckRenderer.js\":\"fe637f0bbbe810fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewSession.js\":\"6a3a892ff153e736\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/actions.js\":\"0bb1405e7fafd0cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/archive.js\":\"f6603a38931463c6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dataExtension.js\":\"e85188f0e6c2897b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/deck.js\":\"063638e7d3dd26a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dueQuery.js\":\"e118dc767e7e537d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/gradeDecision.js\":\"744020db3d0a8adb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/index.js\":\"3f7990c02237952a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/keyHints.js\":\"f6cc434a1a7fa275\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewCardLayout.js\":\"d93d307bd91e7a06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewProgress.js\":\"ef377efed6cc0913\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/schema.js\":\"0058d9f68653a76c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/useDueCards.js\":\"2a83d64e3ae2176c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/index.js\":\"a592b4a0b9ea2eb3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/record.js\":\"2cc548b56cf1f433\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/index.js\":\"31ccb23e3c20c084\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/persistenceStatus.js\":\"80cdea21fd14dccd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/requestAction.js\":\"8ce81639f548d531\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/TypeChipsDecorator.js\":\"b3ac19f9932cf094\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/codeMirrorExtensions.js\":\"4edbbee332782680\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/index.js\":\"cb492d568c57b236\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/typeAutocomplete.js\":\"2833c820850051b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"dc03acac1b2e2453\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/actions.js\":\"6bda86708655c138\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/anchor.js\":\"404788a4fbb57b53\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/events.js\":\"08311b881ce3a7b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/gestureActions.js\":\"99473c426edf8ae9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/index.js\":\"d5c10a2402749ac3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"809be7d5bf98448b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/collect.js\":\"4f8edc7257e43dea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/index.js\":\"3ee86bd719073f66\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/record.js\":\"8a27cd5f41904f62\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/RejectionDialog.js\":\"e3c25a2fde128fb0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ec6f7931dafc6cc3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/index.js\":\"2342adc0eccbcb11\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/model.js\":\"490ab729152a095f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/queueCounts.js\":\"9c66259c14b08d74\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rejectedHelpers.js\":\"dc4467d372b7ec31\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rematerializeAction.js\":\"c5903f87aac160de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/useHysteresis.js\":\"08203d6801b1b524\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/effect.js\":\"b5c180ab5d632e42\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/index.js\":\"09790ab8c54565ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/theme.js\":\"94f51be8197e1d29\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/actions.js\":\"42c286a80ca2edca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/dataExtension.js\":\"4ec8fedea3095634\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/index.js\":\"19b824377ed5eb89\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/schema.js\":\"7b80e57d9a60d6f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/TouchSelectionLayer.js\":\"656aa4cf39053e1d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/actions.js\":\"3bd3cf49cfa83d12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/defaultItems.js\":\"c945553b92010854\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/facet.js\":\"714724f65fac3b83\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/holdRecognizer.js\":\"f486f00f70d2aaa0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/index.js\":\"dbf92621a08b0739\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/UpdateIndicator.js\":\"b5c36e1b0f360134\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/index.js\":\"4d8f558f7edc08e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/loadTimes.js\":\"fc9527b46b456785\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoNotesRenderer.js\":\"f7bf25d463d8be52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoPlayerRenderer.js\":\"9ea7a87341771cc6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoTimeStamp.js\":\"1a966cde3c30c062\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/actions.js\":\"7986476da6ef86bd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/index.js\":\"e3a93c23b551568e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/markdown.js\":\"f1b4f27c0c645d26\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/notes.js\":\"842b19d409bc35d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/registry.js\":\"51a51f93ee941279\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/remark-timestamps.js\":\"f019c193e819ab9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/view.js\":\"6ae154661eb5a9bf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/LinkHints.js\":\"390bf3f47a1e9eb9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/index.js\":\"f0389097807c286b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/model.js\":\"c3e39b0b86d1b624\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/settings.js\":\"3cc00bb98c3c9d2b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/actions.js\":\"9860df9b6321e93e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/index.js\":\"498a9d07c4c4391b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/interactions.js\":\"0dc817a90e765717\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/workspace-header/index.js\":\"5fa6a1eb1c47ec32\",\"/knowledge-medium/pr-preview/pr-1790/src/registerServiceWorker.js\":\"894bfcc2ec0984c7\",\"/knowledge-medium/pr-preview/pr-1790/src/requestPersistentStorage.js\":\"4b1d64b9056a64aa\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authRequestDeadline.js\":\"b928b00163a57f24\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authStorage.js\":\"2fd7c1ff42c28698\",\"/knowledge-medium/pr-preview/pr-1790/src/services/powersync.js\":\"7fb780fc627a2fa2\",\"/knowledge-medium/pr-preview/pr-1790/src/services/supabase.js\":\"6a1226f32220cb97\",\"/knowledge-medium/pr-preview/pr-1790/src/services/uploadErrorClassifier.js\":\"a22416dde4c98db7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/ActiveContexts.js\":\"d461b88619cc64ff\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/HotkeyReconciler.js\":\"cdc944203bea34e0\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/WipeLocalDataDialog.js\":\"7d75456bb6092f16\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionDispatch.js\":\"e0b8fa6cfec9a6ec\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionRefItems.js\":\"8bdb44d3611df311\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/applyKeybindingOverrides.js\":\"1eb0c696e07ca238\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/blockActions.js\":\"a04ce1a477e093ba\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/canonicalizeChord.js\":\"b6ad07b69b0b93cf\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultContexts.js\":\"c2c39f0a0dfa703d\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultShortcuts.js\":\"d07b351ed488ffe7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/effectiveActions.js\":\"3d4d07eeada67d65\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureAction.js\":\"b9df8e56f58d4df5\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureBinding.js\":\"d44fa84e4aaf97fc\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/holdRegistry.js\":\"f765b93ad91dcb7d\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingConflicts.js\":\"538bd2d21d7437d8\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingOverrides.js\":\"4fe28417a3e74de6\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/pointerAction.js\":\"0fda0aa40aa7ca85\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/resolve.js\":\"984c4fb5f44c9a8f\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/runAction.js\":\"8b56a71a01f43d01\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/sequenceMatcher.js\":\"d02e1587db1d51ed\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/types.js\":\"04d60d5fbec3d152\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionContext.js\":\"5a7abdc5a0b4285f\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionDiscovery.js\":\"1516072f08df0355\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/utils.js\":\"76719b6f1a54716f\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/bootStore.js\":\"ce834e7eb271883b\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/previewDatabases.js\":\"907fea83fc67aa1d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/byteTransform.js\":\"65a67146d33b3b20\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/attachmentCleaner.js\":\"36ec9c429635574b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/attachmentParts.js\":\"598b545299460343\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleParts.js\":\"f7972a4710c2be2d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleRecord.js\":\"fb91c2fabafae050\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/manifest.js\":\"102ee67be18e50c2\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/takeBundle.js\":\"9840de3dd77a1bd7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/verifyBundle.js\":\"16984c6bf63e2c8e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/cleaningStage.js\":\"d3a87f76bdfee263\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionKey.js\":\"791146bc017a64e5\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionServer.js\":\"31355a8335f5c0de\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flip.js\":\"5cb7bee39e235a29\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flipAttempts.js\":\"bb4a070fa5ff86c1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/pages.js\":\"16c47283848a8a3a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/preflight.js\":\"9e58b709e98e302b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/reseal.js\":\"be79b75c66ac8a07\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runConversion.js\":\"0a3b0603bcbd22ac\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runLock.js\":\"8cb22b6829eec2ad\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealing.js\":\"64c4e68556215644\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealingStage.js\":\"0fb02f98a4eef0e8\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/stage.js\":\"d0bd84bd636d4f07\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/verifyReseal.js\":\"48e8c5cb372c6563\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aad.js\":\"5fc0251318770c00\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aead.js\":\"263e2efd5c426d02\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base32.js\":\"ae107a9f7bd4e3d7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base64url.js\":\"d0c084cb41f79e72\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/binaryEnvelope.js\":\"9e8cf9009fa79f2f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/byteAead.js\":\"effeba8f115061d0\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/canary.js\":\"10b914229a437978\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentHash.js\":\"eea586e3f52010c0\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentKey.js\":\"b269f4e7bb714ef7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/derivedIdNamespace.js\":\"fb04c0909a0de001\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/envelope.js\":\"d2baa625b2505e11\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/hex.js\":\"5e9cf82540f6297f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/sha256Hex.js\":\"3762d5e764f5a506\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/workspaceKey.js\":\"4e312107212f9fa2\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/conversionState.js\":\"f309beb0291e3133\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/createEncryptedWorkspace.js\":\"794271d875409534\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/pastedKey.js\":\"fd1e1a935e9583d3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5980c335023d99ac\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b1ef47ece9a10fad\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/keyStore.js\":\"fe4e68b09f1adae4\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/mintWorkspaceKey.js\":\"e501be53ad593409\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/modePin.js\":\"72e2b0ebb145766e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/openWorkspaceKeys.js\":\"f5c505941f24e980\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolveWorkspaceEntry.js\":\"5ca3b76e1671c56f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolver.js\":\"488d334e528e8162\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/workspaceAccess.js\":\"e7ff5754030aa1b5\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/transform.js\":\"aafb6ea2a3ec2da9\",\"/knowledge-medium/pr-preview/pr-1790/src/themeBootDefaults.js\":\"4a7b50fa1f6dd7b6\",\"/knowledge-medium/pr-preview/pr-1790/src/types.js\":\"3867fded39e6533c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/ClientLocalSettings.js\":\"69aeeedd8487a8ec\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/abortableSleep.js\":\"dae86bcbb4c0a09a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/array.js\":\"5d336bab62c81c25\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/backlinkAutocomplete.js\":\"f45172a152324ad6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockCrumbs.js\":\"3cba0205cee5ebc1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockrefAutocomplete.js\":\"e0a9885149672244\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/cadencedIdleJob.js\":\"5123050c94c69a15\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/callbackSet.js\":\"4501528fae3e95f2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/clientId.js\":\"bc20ae45313ac8c8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirror.js\":\"ffaabeea28a91172\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirrorCompletion.js\":\"304e274540a03f77\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/copy.js\":\"5e446c246a150a5a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dailyPage.js\":\"aa4d87b415fbef79\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensics.js\":\"ff05782ed9496bb9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensicsHooks.js\":\"8a42c13508701c03\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/deleteBlockThroughUi.js\":\"e0fd77f22e539033\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dialogs.js\":\"5c6daf7c90bd37b7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dom.js\":\"dae5abbd08ffef15\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/downloadBlob.js\":\"e42fb040d97711f6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/exportSqliteDb.js\":\"e4fd39dfe025e814\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fileSystemAccess.js\":\"86b27cb4dcae7bb4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/flipSlide.js\":\"315d767cb85ccbf2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fnv1a.js\":\"97d93f7ace2b0fee\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/formatBytes.js\":\"079d7a58921e3d6f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fuzzyRank.js\":\"1ef43baa47a092bd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idbKeyedStore.js\":\"a9aaf0fa28daca6a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idleCallbackPolyfill.js\":\"afd9d8efd7c786f3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardAwareScroll.js\":\"cc8225f44d518183\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardViewport.js\":\"e063d0399ab10239\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/lastWorkspace.js\":\"f961e52d4bf7b956\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutColumns.js\":\"bf9cf58e1e88a58f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionDom.js\":\"a576f08dfe2e6a9a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionId.js\":\"cea11a25a511bc44\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkClickGestures.js\":\"9a34b046787d6e87\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkTargetAutocomplete.js\":\"07908f997bd3dccb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbCorruption.js\":\"30950e3e4ce7b0eb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbRecovery.js\":\"3ee15779ddc59c94\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/markdownParser.js\":\"a81968db04264c34\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/memoize.js\":\"0e329060fbd404b2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameFieldCommit.js\":\"61cfc76c63531a89\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameList.js\":\"4b8d8d52015983ff\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/navigation.js\":\"d7ea8d7671ea35bd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/omnilinerNamespace.js\":\"3cc91332eda42ad9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/opfsPageScan.js\":\"a23d00eb99270c2a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelClearance.js\":\"2b3a10c36a0342a4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelHistory.js\":\"22dd1a996a88dffe\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLanes.js\":\"b51eccc5511a7e52\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLayoutProjection.js\":\"0eb5b10f1f332561\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelScrollAnchor.js\":\"485c85ac85ceefde\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelUrlFlags.js\":\"ce33431a876032bc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/platform.js\":\"73d3698477edddb6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/pluralize.js\":\"0b189cddcbe52bae\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyCreation.js\":\"378c33afb101e90a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyNavigation.js\":\"924b0d2e4937dfd5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyValueContext.js\":\"6b69164f4a583036\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/react.js\":\"a06c3122f08dcaac\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeDate.js\":\"4ea6d5a81220be0e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeTime.js\":\"4d72a27af3a2ec82\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/renderScope.js\":\"71b382e8f78acaa8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/resolvedThenable.js\":\"89277b4012ae3867\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/routing.js\":\"c73474a2a6b9376e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/safeMode.js\":\"0a356850a5fd75df\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/scheduleIdle.js\":\"0423e586b45c0f62\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/screenWakeLock.js\":\"214688ce7dd1d187\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/selection.js\":\"47ca2b36b2f4e2ac\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/softKeyboardGrab.js\":\"443b8469839db668\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/startupTimeline.js\":\"e015aeec520e29f9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/state.js\":\"21c6e42eb6c06fec\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/string.js\":\"2ebe0bb3bdcc01bf\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/surfaceZoom.js\":\"8084f1f0053bdc01\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/time.js\":\"233878a563278196\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toast.js\":\"1f13f97a44469868\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toggleStore.js\":\"8b91a332c6a32083\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/untilStopped.js\":\"83292ce2fe777679\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/userActivity.js\":\"4e9982ab60c08e01\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewTransition.js\":\"b0382b5d30ba7644\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewport.js\":\"00a3ea6feb632016\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/webLock.js\":\"3b84a3532443e500\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceRecovery.js\":\"7569827a25eb808a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceSnapshotStore.js\":\"e86ab4de431de840\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-compiler-runtime.js\":\"986d29f4ac8001f8\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-client.js\":\"e9623b81e210686d\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server-edge.js\":\"21c11fa96379fc87\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server.js\":\"fde519e19a700849\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static-edge.js\":\"05eb808321c7e87c\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static.js\":\"cba8a93b5b4d4663\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-test-utils.js\":\"b32e6916089b5106\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom.js\":\"875faa26f6390de4\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-runtime.js\":\"d9e1933c8221c8f1\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react.js\":\"e788e935d1fc68fc\",\"/knowledge-medium/pr-preview/pr-1790/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
