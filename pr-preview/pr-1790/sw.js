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
		buildId: "cec395a019dd-32ce36d7",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/\":\"910db6ad9e8ade92\",\"/knowledge-medium/pr-preview/pr-1790/index.html\":\"910db6ad9e8ade92\",\"/knowledge-medium/pr-preview/pr-1790/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1790/assets/FacadeVFS-Cbz06kB2.js\":\"74485875235893db\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSCoopSyncVFS-CUVNwzUr.js\":\"e0851b0ee1e1b671\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSWriteAheadVFS-3B0A1y4m.js\":\"bda9e01b694b4232\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-ktd0X-Hw.js\":\"0210f7d865f204c3\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-hQQbA2y8.js\":\"89ab406fe54e76b8\",\"/knowledge-medium/pr-preview/pr-1790/assets/worker--0zFX5-A.js\":\"d900c6d783ab594c\",\"/knowledge-medium/pr-preview/pr-1790/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1790/chunks/app-DIasVfWu.js\":\"1eb6387442421c7b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1790/index.js\":\"466a7f21962b6bc4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1790/assets/AccessHandlePoolVFS-gsTi_WFb.js\":\"b665fa33c58c6af9\",\"/knowledge-medium/pr-preview/pr-1790/assets/IDBBatchAtomicVFS-dQYMcIHE.js\":\"c912dab8e9d130e9\",\"/knowledge-medium/pr-preview/pr-1790/assets/MemoryVFS--Q_GuuQF.js\":\"9c9014025853b9bd\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-D6OQyPL_.js\":\"108b39bf1f438432\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-D5Vpv8RX.js\":\"ae93362cb200092c\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1790/chunks/AccessHandlePoolVFS-UXvxA8uQ.js\":\"6fc19075f4ca1e7e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/FacadeVFS-Ebrd8CQh.js\":\"f33a83c6c6954b70\",\"/knowledge-medium/pr-preview/pr-1790/chunks/IDBBatchAtomicVFS-B9C60bR3.js\":\"dd3a01ace4e1322d\",\"/knowledge-medium/pr-preview/pr-1790/chunks/MemoryVFS-NlLO3CSm.js\":\"a57f57736963ea07\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSCoopSyncVFS-BBNRZd09.js\":\"b911c3e7b5878bc2\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSWriteAheadVFS-B-fE2Naa.js\":\"d462621dcc58b5a5\",\"/knowledge-medium/pr-preview/pr-1790/chunks/Preview-CSe5cb_r.js\":\"45b4182773044350\",\"/knowledge-medium/pr-preview/pr-1790/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/card-Diy081wH.js\":\"a593fbfbdb49b193\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-CbCjWanO.js\":\"6ed85de347cc7d9f\",\"/knowledge-medium/pr-preview/pr-1790/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-DjZHvn0K.js\":\"9ff586e15f0095f1\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-async-D6txpUFE.js\":\"adfe25c6f0b68367\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-BvJwJUaD.js\":\"333bae5dea3e948e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-CgTSPMhn.js\":\"1ac42c166cbe38ab\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-D3goFrKW.js\":\"605ae823f8a8b2d9\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-DkkByFIY.js\":\"dd23c0f942b30d54\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-GOfzTBEB.js\":\"0e646117a1a7b0f5\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-SHeoUIAO.js\":\"aaca6a94cb4d8d64\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-ZC2pcKLX.js\":\"4fe4063d6c2aef45\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server-legacy.browser.production-BUQMGXpA.js\":\"8753fecf94e8370c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.browser.production-AoYIzV1N.js\":\"e9868f11e2d09c5e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.edge.production-DYABLFzY.js\":\"6d356d5fc4c62d04\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-evhUMhEk.js\":\"a083638e4552e7b1\",\"/knowledge-medium/pr-preview/pr-1790/chunks/server.browser-BulKQKtP.js\":\"662dd662d985aa30\",\"/knowledge-medium/pr-preview/pr-1790/chunks/textarea-CKotNCOp.js\":\"edec2c9bb0e34525\",\"/knowledge-medium/pr-preview/pr-1790/chunks/ui-DN6838Zj.js\":\"20533ccaf6b1228d\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-Cw0QXI3_.js\":\"6bfb45abd330d337\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-async-B1GzTLn2.js\":\"9814a68e4ef205ef\",\"/knowledge-medium/pr-preview/pr-1790/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1790/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/src/App.js\":\"ff0a39ab4e31ac73\",\"/knowledge-medium/pr-preview/pr-1790/src/appUpdate.js\":\"f1744c3c24c96acd\",\"/knowledge-medium/pr-preview/pr-1790/src/appVersion.js\":\"9c8a01a8c3939dbd\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/initialLayout.js\":\"520660da86061d83\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/openWorkspaceData.js\":\"0e5152989e69c443\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/resolveWorkspace.js\":\"b51de237d70e7f1b\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/workspaceBootstrap.js\":\"1ae6fb5d87ad12b2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockComponent.js\":\"766fb9f257cf0e56\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockCrumbs.js\":\"dbcbcd60cd522243\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockEditor.js\":\"89c0ccfd25279b38\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockLoadingPlaceholder.js\":\"6463551427c2f492\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockProperties.js\":\"85932b7ea4e33c36\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockSearchPicker.js\":\"86813608c3841268\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ConfirmBulkDeleteDialog.js\":\"472819db1f00fbd1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DividerHandle.js\":\"982f9706ad622edb\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DraftEditor.js\":\"94ff2e40f9fd2776\",\"/knowledge-medium/pr-preview/pr-1790/src/components/GutterPill.js\":\"9c6332a206df20e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Header.js\":\"c9645a906188c58f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/LazyBlockComponent.js\":\"fe4999a7571a14f2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Login.js\":\"4bd71097664d4ca4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ZoomableSurface.js\":\"025e4a5cda32a7aa\",\"/knowledge-medium/pr-preview/pr-1790/src/components/editModeKeepalive.js\":\"b6762d4a17fa3219\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyDisplay/PropertyDisplayScope.js\":\"923c85fd61c69500\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b6979fc3c232964c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefPropertyEditor.js\":\"946c90ea2b943a8f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefTargetTypePicker.js\":\"d55b2bb4e04b7339\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/SelectPropertyEditor.js\":\"eeccca050f72367e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/TypesPropertyEditor.js\":\"79d448132a93f56e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/defaults.js\":\"02b6cec012f76098\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/kernelValuePresets.js\":\"1cb2081b5ab19471\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/selectablePresets.js\":\"d19ea3cb363613db\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/typesPropertyUi.js\":\"bfbccd3fc720c355\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/AddPropertyForm.js\":\"3089b750ef5c6caf\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyPicker.js\":\"60ecdc565261ad4e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyRow.js\":\"6bf4663b4ca1300c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/Rows.js\":\"4c3dea3b658ac979\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/actions.js\":\"c8b65520c2b13dea\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/declarationOnly.js\":\"3359f1b31a5b895b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/layout.js\":\"445f7e9f009eebee\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/model.js\":\"4d2d4415f868490f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapeUi.js\":\"00e7f8f491fa3b9c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapes.js\":\"9899c7b3c6a9318a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/usePropertyEditingActivation.js\":\"031df8dcd23a41dd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/visibility.js\":\"9a3836fecb17b801\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanelSections.js\":\"8eaed07b24721aee\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockEmbed.js\":\"6b89b870ab55a603\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockLink.js\":\"212b35204a49d061\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockRef.js\":\"4fd1d66af5002d83\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/ReferenceLink.js\":\"71c8159a6f02f3f5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuard.js\":\"c38513deb4ce57f2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuardContext.js\":\"338d74f028b20da1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/linkInteraction.js\":\"f659cc61b0a45a33\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/referenceLayout.js\":\"2b37fc975f8caef2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/useBlockRefAncestors.js\":\"e40d7cd27ddaa158\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockGutter.js\":\"dbdfeb2372c5f8e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockInfoDialog.js\":\"251926cee831c501\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockTypeBlockRenderer.js\":\"6f37a9b0b03d074a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BulletHoverCard.js\":\"29ad9dc78624eb2c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorContentRenderer.js\":\"9ae573194e893667\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9d0a095e08f5f1a3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ColumnResizeHandles.js\":\"a3c3a0ed14bf9ede\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"88bbc72c11c10966\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/DefaultBlockRenderer.js\":\"ea17039337fd02de\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/LayoutRenderer.js\":\"96bd00ed4a3fa898\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MarkdownContentRenderer.js\":\"e46268a755bfd219\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MissingDataRenderer.js\":\"c18aa97e2f6fc1e0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PanelRenderer.js\":\"3ddc16f044e17f7c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2372ed61948e826b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/TopLevelRenderer.js\":\"8861b1d3756aba42\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockGutterMode.js\":\"14fa24d56399559e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockTitleText.js\":\"51074bc7c544a0c0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/fieldCreationKeydown.js\":\"01f641633b34d549\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/layoutRootContext.js\":\"a172e6011d2e46d5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/TypeChip.js\":\"61ef814417cfe615\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/chipStyle.js\":\"f74648fb0c52621d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/anchored-floating.js\":\"fd941a985d20fb13\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/button.js\":\"361ac22e752c5877\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/card.js\":\"2eb7cb841cc2ad59\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/checkbox.js\":\"5db1c417c6a108c4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/collapsible.js\":\"b9fc20c47325076b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/command.js\":\"2d85d93d69089a7a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/context-menu.js\":\"426515ae4e0df278\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dialog.js\":\"80708c57f652f621\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dropdown-menu.js\":\"eb0ed6105ab0118e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/floating-listbox.js\":\"6b3d915315531291\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/index.js\":\"7a4b7e9b7a339665\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/input.js\":\"e6ccc81490bfd682\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/kbd.js\":\"de8d53ac3a5d7440\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/label.js\":\"ce05e208eea00203\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/textarea.js\":\"f72f4a460cbc6d61\",\"/knowledge-medium/pr-preview/pr-1790/src/components/useEditModeYieldKeepalive.js\":\"db5bbef1534207c2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/BootFallback.js\":\"7014c070bd6d465a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/FocusedRowLazyMount.js\":\"c61e5e17f1dc1de5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LazyViewportMount.js\":\"de697b851dcee996\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LocalDbCorruptionFallback.js\":\"25e2f62494cd57cd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/error.js\":\"97d43f2bf7ee089a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/lazyMountRegistry.js\":\"ffa726fb3539e323\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/suspense.js\":\"a74c5306bd985901\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/CreateWorkspaceDialog.js\":\"4a2994254541e706\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/PendingInvitations.js\":\"f895d21e4e44dfc6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/SyncProgress.js\":\"18f7a174c650ae23\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/UnlockProgress.js\":\"8f1f0f0305eb3b01\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceKeyGate.js\":\"cd339a64e8985cf8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSettingsDialog.js\":\"a67d7b14df219e03\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSwitcher.js\":\"b06e25a5a7fa2c66\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSyncGate.js\":\"efff99cb04fccdd3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlow.js\":\"7ec6e56b6d77dc3a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlowHost.js\":\"9ff22eb9e63da8b6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/EncryptionSection.js\":\"9e5fe1a8838616ce\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/attachmentPrompts.js\":\"60a83389c2929099\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/bundleFolderPrompts.js\":\"cfc985c19bcd419f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowDeps.js\":\"80c668e793d56680\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowStore.js\":\"ff26183a8a1b5917\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/flowUi.js\":\"5e0c7ecc3ce12058\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/useConversionRun.js\":\"5059f040859ae642\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/keyUi.js\":\"c6d5bb8664853c51\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnKeyLoss.js\":\"9b72027d12c01fb2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnServerE2ee.js\":\"9a27ac139dfe40e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/workspaceUnlocked.js\":\"51dc37b2f2824b97\",\"/knowledge-medium/pr-preview/pr-1790/src/context/backgroundSubtree.js\":\"4b5a75371892f570\",\"/knowledge-medium/pr-preview/pr-1790/src/context/block.js\":\"70b88d125910db52\",\"/knowledge-medium/pr-preview/pr-1790/src/context/layoutWsContext.js\":\"1135500501b6f656\",\"/knowledge-medium/pr-preview/pr-1790/src/context/propertyDisplay.js\":\"3c9b7643e1f9218f\",\"/knowledge-medium/pr-preview/pr-1790/src/context/repo.js\":\"bc6e5b88124d9199\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasClaim.js\":\"53f489d037919fb0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasSeatNamespace.js\":\"833cd8a03810bb63\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockData.js\":\"058a7e6b45eac881\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockType.js\":\"a128642fd6b638e6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/changeScope.js\":\"e9d059b1da7ac134\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/codecs.js\":\"35570f5dcc7488af\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/derivedData.js\":\"4496331b28ab978a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/errors.js\":\"232b5d0d3a799e0b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/events.js\":\"3db6996e9ce2a4e0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/handle.js\":\"94f9f776012d1445\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/index.js\":\"164e931eaf44ba50\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/mutator.js\":\"445f09f74b919d8b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/processor.js\":\"676faad03763ac8f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/propertySchema.js\":\"4b1b5969603afb68\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/query.js\":\"9775c8078c3ee662\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/sameTxProcessor.js\":\"5600f440ff10ff8a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/schema.js\":\"94f9f776012d1445\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/tx.js\":\"94f9f776012d1445\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/typedBlockQuery.js\":\"757f53b39dbd784e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/user.js\":\"1e77d4a74c46daee\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresetCore.js\":\"8dbc253965fd2ab9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresets.js\":\"a784008039a1641a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/attachmentCleanerIOVerb.js\":\"980ebab580ad9d27\",\"/knowledge-medium/pr-preview/pr-1790/src/data/block.js\":\"8c7b509056da21e2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockCache.js\":\"3fd0c11e5fb403c7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockId.js\":\"d4160f70ce4a0005\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockLiveness.js\":\"2f2eb51345bf14a5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockMerge.js\":\"2639fc055af14c84\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockSchema.js\":\"10b4b7dae0547217\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockTypes.js\":\"222a7cab6531ddb3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/clientContext.js\":\"b31c5306350b9ea0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/dbFileSiblings.js\":\"88c9229d69d216a9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/definitionSeeds.js\":\"b66ea05091e7cb31\",\"/knowledge-medium/pr-preview/pr-1790/src/data/derivedIds.js\":\"58ea237b7fcf493d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/drawnSubtree.js\":\"1d1c6b1104830ec7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facetBridge.js\":\"d2dfa55d332cde69\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facets.js\":\"7bd13fe404491b95\",\"/knowledge-medium/pr-preview/pr-1790/src/data/globalState.js\":\"fcac81c4eddb9044\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/aliasClaimRederiveProcessor.js\":\"31b9dcaf7e231219\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/ancestorBatch.js\":\"7bdc404489b2a6e3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/blockTypeTypeifyProcessor.js\":\"2b44833cff6babd4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/clientSchema.js\":\"d71b7c6f6e51c516\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/commitPipeline.js\":\"3a87de95eda226c2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/devAssertions.js\":\"c658de57479fb0d7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/firstSync.js\":\"ad796388ff4312e3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/freshInitialLoad.js\":\"6af3c571b8e282eb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/graphBackfillClaim.js\":\"701d27dd26b2583e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/handleStore.js\":\"e0c52f5f4e148a0e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/idleMarkerJobs.js\":\"bb48e16d14e85b0a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initialDownload.js\":\"cfa555fa13ad35f3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initializeClientDatabase.js\":\"42865043b89f03d6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/jsonCanonical.js\":\"63d115bd7b6ccbd3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelInvalidation.js\":\"a3a27da7da6f621e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelProcessors.js\":\"360be6422a6a936d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelQueries.js\":\"90a475a35c209600\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/mergeTypeMembershipProcessor.js\":\"ffe2b3e216a810e8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/normalizeReferencesProcessor.js\":\"f5984ef912d703b1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/poolInstrumentation.js\":\"bf09c5e04bb31e32\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/processorRunner.js\":\"8370928444798956\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyCellBackfill.js\":\"894e49a1d45e81ac\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildMint.js\":\"d7bbaaa94e8064b3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildrenProcessor.js\":\"bfa31a99a114dd77\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionChangeProcessor.js\":\"02115448c72d5773\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionSynthesis.js\":\"d2cf41ba64a8669a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyKeyScan.js\":\"d24fdd7b75390444\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertySchemaResolution.js\":\"48c7a2437065bb7a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/raiseProtocol.js\":\"c816ba7c1d9db0db\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/readBatch.js\":\"52c2a6810bf1c0cd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/refProjection.js\":\"ad7e641a4f000d41\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetLookups.js\":\"5d3da9445ffc0eaa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetProcessor.js\":\"9f6f8d2d19b42a14\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/replayMerge.js\":\"59853a34d7e64776\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/sqlBinds.js\":\"6482b5542b312090\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3210095d06e3fabf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/arrivalProcessors.js\":\"a6f2e4fc19ff94e4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/invalidate.js\":\"cee51c3ac8916ce1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/materialize.js\":\"d8d30f31fd6c0acb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/observer.js\":\"295bdf0abfa7d62b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/reconcile.js\":\"ac1cb3016e76521f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/timingMetrics.js\":\"9a44a5ec6b44276e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/treeQueries.js\":\"b66d5fb74d71b8ef\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txEngine.js\":\"07bf0e2c675e1ce6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txSnapshots.js\":\"a7e21b4aa52de9d0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/typedBlockQuery.js\":\"2047dc862ea99df1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/undoManager.js\":\"a8361f06e425c26b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/invalidation.js\":\"109e71b22fc95ff1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelDataExtension.js\":\"caac0d4e30865bcc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelPage.js\":\"9a2c54becd8e9e9e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelValuePresetCores.js\":\"c48f0b52ccb46def\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbCorruptionSignal.js\":\"35e53af53ec716a4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbStorage.js\":\"61dbd262afb7f2bc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbVfs.js\":\"5f02c011f97cc7c7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localSchema.js\":\"6df7f47cedf351b7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/maintenance.js\":\"e567dc73836f3fc4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mergeProperties.js\":\"24ffda8e9ac2168e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/metricsConsoleHook.js\":\"09e4b28f2e20c979\",\"/knowledge-medium/pr-preview/pr-1790/src/data/migrationsPage.js\":\"a93e8a3e95b56fa4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mutators.js\":\"69df333c36c5032f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKey.js\":\"af2b1fc5562701dc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKeyPlacement.js\":\"181ba48179086ff9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/outlineSurface.js\":\"76f27f5261e22180\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingEditorContent.js\":\"cf1833b467076aba\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingUploadsSql.js\":\"52d4c7ecdb40d9e6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pluginStateExtensions.js\":\"846c2d73dd370d42\",\"/knowledge-medium/pr-preview/pr-1790/src/data/powerSyncLogger.js\":\"39870b01b235b22e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/projectorRuntime.js\":\"e8ef0a556f4d3cc1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/properties.js\":\"50867056d70a2ffa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertiesPage.js\":\"2c4371f367546847\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyChildren.js\":\"aa359a87df405749\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionFanout.js\":\"948ea261c29c18a2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionMetadata.js\":\"5c2b2b94594b59c5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionRegistry.js\":\"200205f18d7a021b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDisplayMode.js\":\"24aab59f1076344d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyRowCreation.js\":\"6d0f457318a01fc4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySchemaCreation.js\":\"aa955c0e1afed621\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySeeds.js\":\"18a9447ac7870553\",\"/knowledge-medium/pr-preview/pr-1790/src/data/recentsPage.js\":\"0e3646a71b38d458\",\"/knowledge-medium/pr-preview/pr-1790/src/data/referenceBlock.js\":\"beee118af99e3dc5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/releasePowerSyncConnection.js\":\"f7708950cb01bf96\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repo.js\":\"5dc75c1de19c3b19\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repoProvider.js\":\"aee84ddf55f9f0bd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/rowProperty.js\":\"a35f1dc4754e1f7c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/searchFilter.js\":\"c964a696204a389b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/seedIdentityLedger.js\":\"8ff526d7b8a59c1b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/stateBlocks.js\":\"bf1ddc8d14ffe5d5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/structuralEditPolicy.js\":\"47373c564cd277f9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/subtreeDelete.js\":\"eb56f3752fd6e972\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncStreamLock.js\":\"830c88ede4161f8f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableSqlRecognizer.js\":\"ba7f953ed41ad541\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableWriteGuard.js\":\"47f90c8625eb629c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/targets.js\":\"8af39737a098d946\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeColors.js\":\"353cec3e1b87b66b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionMetadata.js\":\"ce3ff9392fcb9d32\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionRegistry.js\":\"26a82713fe3d640b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeExtraction.js\":\"326ce24b076bcfaa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeInitialValues.js\":\"4db7dca0462ffdc8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typePropertyGroups.js\":\"f9de7f0d45d7afa1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeSeeds.js\":\"d89868fb00692738\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeTagger.js\":\"6324b717e999cd70\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typedRecords.js\":\"a3f31b00e631d9b7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typesPage.js\":\"4956046e8ae09d57\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userPrefs.js\":\"607a4e0824e04380\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userSchemasService.js\":\"dec8fcf0fb313332\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userTypesService.js\":\"586ab430421c6835\",\"/knowledge-medium/pr-preview/pr-1790/src/data/valuePresetRegistry.js\":\"e095a3e1f01276cf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/visibleChildren.js\":\"a298b46814b493d6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceConversion.js\":\"33d3bdb668879219\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceFirstSync.js\":\"b32a376d64ac104f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceIdNamespace.js\":\"a97797c0f2868449\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceSchema.js\":\"c251542fca4ec0db\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaces.js\":\"111a344e0e3aba07\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadLog.js\":\"c62adb9ffa5020c7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/BlockPasteShellDecorator.js\":\"b7f8cafc1c6142e7\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/atTrigger.js\":\"37369019e2f789f9\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/autocomplete.js\":\"835c95bf43558e9e\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/codeMirrorExtensions.js\":\"3be4a516b1e34f0a\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/contentFlush.js\":\"028ebcab6d531cbc\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/defaultInteractions.js\":\"2b28843c60164c46\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/editSettleSignal.js\":\"7b56524accfd7e35\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/insertImage.js\":\"38e1a9bcdde4191f\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceCompletionRange.js\":\"25f4c8b42a9981ab\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceTargetTypes.js\":\"dbf1782314a547e7\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/syntaxContext.js\":\"2214f57183911975\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/triggerMatch.js\":\"ff4cc532be256489\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/AppRuntimeProvider.js\":\"4c21f8ae8fd36769\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/BlockFocusShellDecorator.js\":\"cdd588ecf62737d1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/ExtensionRenderBoundary.js\":\"2561e5b0c6a40529\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/PanelContentRecovery.js\":\"c6801d32626f2d29\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/apiCatalog.js\":\"545fbc5cd631d47a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/approveExtensionHere.js\":\"8aa1491a12ac90bb\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/armedCutAppMount.js\":\"0dfed96684467093\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/batchableKeyedStore.js\":\"11cae30c85687865\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockInteraction.js\":\"3ba9c660fb87ae84\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockSelectionAction.js\":\"53cbae35d1391398\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compileExtensionModule.js\":\"0d22dcaeffe353fd\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compiledModuleCache.js\":\"f9050e417594e707\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/continuousGestures.js\":\"94e8df646b4bd888\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/core.js\":\"94672868544fcffb\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/defaultRenderers.js\":\"d7be5209c55db936\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/definitionFanoutAppMount.js\":\"7278adfa42bd1ab5\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dialogAppMount.js\":\"a1a711dc825576b1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensionSeeds.js\":\"3e3ef8224ac63462\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensions.js\":\"ffed8e3042d20925\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/exampleExtensions.js\":\"ba955aec3e724e0f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionApprovalStatus.js\":\"d07aad9329b7f46d\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrorToast.js\":\"1edef606157b4d75\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrors.js\":\"5319a4fc132e018c\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLookup.js\":\"91b519dce0716a4e\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionToggles.js\":\"12e3c94f1d69fd49\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionUtilitiesCss.js\":\"0c80c494d1667e22\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/kernelPageDeletionGuard.js\":\"b9cb0cf03ad42e41\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/liveRuntime.js\":\"aa54129baf8b3794\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/openExtensionsSettings.js\":\"165aa470e7a6fff0\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/overridesCache.js\":\"8efc58308d8dc576\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/pluginIds.js\":\"a59023884ae13e81\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/processorRejectionToast.js\":\"70bff1acf2c28915\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeActions.js\":\"455e64d17674a974\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeContext.js\":\"1ee36d9eea8a670e\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticAppExtensions.js\":\"cfe66db2deb73ff7\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticDataExtensions.js\":\"1245d9ea56e24591\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/toastAppMount.js\":\"040010e7a08d2a44\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useOverrides.js\":\"774cb30092e23118\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useShortcutSurfaceActivations.js\":\"bc3d578d73b7d607\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/discoverToggleTree.js\":\"50635af4d4d0ea24\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/facet.js\":\"8af1c068941c083a\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/resolveAppRuntime.js\":\"afdb3320e71324ba\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/runtimeEvents.js\":\"e8683dcf60ace770\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/togglable.js\":\"47fbbdc94c6650db\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/variantFacet.js\":\"263e40bcf5eb0943\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/verbFacet.js\":\"8500663d4ba9be76\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/block.js\":\"af09460f389c9df5\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/focusedChild.js\":\"071ac1c3b14dfcf4\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/propertySchemas.js\":\"24313e6feaa34a0a\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/typeRegistry.js\":\"6861f67fdbfba481\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAncestorCrumbs.js\":\"bb75e1b0a8ccb81f\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAutocompleteListbox.js\":\"dae720156806454c\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedSearch.js\":\"57b5822fecae1dff\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedValue.js\":\"090437a98519cb18\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsFocalRender.js\":\"6a57f281b082f449\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsReadOnly.js\":\"4e8fe841b47df5f0\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMaterializeBacklog.js\":\"35fe7449fde2e7ad\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMinuteClock.js\":\"8d12d9069070fdc4\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePanelLayoutProjection.js\":\"2f2097ad34cb5fb8\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePendingInvitations.js\":\"9cb266763a4418ec\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRendererRegistry.js\":\"7b5e5c9b98d1ce58\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRetainedFieldRows.js\":\"4f9031da9b10111d\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useWorkspaces.js\":\"cf9f8214feac2b28\",\"/knowledge-medium/pr-preview/pr-1790/src/lib/utils.js\":\"2c0267d04de6454c\",\"/knowledge-medium/pr-preview/pr-1790/src/main.js\":\"ab07bb275b8f6436\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/MarkdownImage.js\":\"ca3e5b1844d27d70\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/blockSeparators.js\":\"7d5c4e3ee4d44a62\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/context.js\":\"68959514ac074a8c\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/defaultMarkdownExtension.js\":\"73accd2426c17569\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/extensions.js\":\"c5e0ebc577c3056d\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/renderMarkdownHtml.js\":\"382c971aff37506d\",\"/knowledge-medium/pr-preview/pr-1790/src/minimal-editor.js\":\"c94ae12f6b9c3c41\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/armedCut.js\":\"6afe338bceb13edf\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/captureMediaVerb.js\":\"2429aa7fe921c0b2\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/clipboard.js\":\"98486966a3559dfd\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/decision.js\":\"354a39f106dfacc3\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/operations.js\":\"b5a5ac323482ac65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/AccountHeaderItem.js\":\"803e7bf7832e92c6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/index.js\":\"1150a5fac26e99a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2c685f5888a99315\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askAgent.js\":\"e98e6014e655ef6c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askedStore.js\":\"b8716482a34aab97\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"23a33a39863f9677\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/chipState.js\":\"05ae23d25b7eb4a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d3e246f9aac674cd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/index.js\":\"75ddbb6b40ec3479\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6a24d794b906659a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/schema.js\":\"c515f6e5682020cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7393d2e31636a2bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6b1009b0fc57a6a9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/addMedia.js\":\"6b98cd8f3a6141b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ffd7bab200340139\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/block.js\":\"8ffa821257b5b8f1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/context.js\":\"88d59077368a3197\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c96aee2ffb5c71e5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/index.js\":\"1620247a88ea95e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/outline.js\":\"a3b970d44bcd25b2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/properties.js\":\"5e4a94fb60a0c3b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/refs.js\":\"92d02f956e6b42c5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"41e0028cae698e22\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/search.js\":\"64aed183bded8cff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/shared.js\":\"f0e5d2fabf559e21\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"04c3ea4974518d22\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/text.js\":\"fc0fe9845554a143\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentWrites.js\":\"1c66975f4663aa6b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/authoringCatalog.js\":\"1b6708f051d556ff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/blockRefTargets.js\":\"1503f5ea8c6f19c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridge.js\":\"e9ded5b878fd7722\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridgeLoop.js\":\"a3f89776959e6eb1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/changeHistory.js\":\"e48d9a95410acc31\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commands.js\":\"9629110950cdc068\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commentsCommands.js\":\"3184b9693a6e2ac1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataExtension.js\":\"7068cb295e35e687\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataModelGuide.js\":\"d61eb2dd4707af84\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/describeRuntime.js\":\"50f73855a0e7385d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/extensionLint.js\":\"e97da5c9b3cba7a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/grainAudit.js\":\"ca639005d3da0d18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/healthCommand.js\":\"ed6245c93f62588f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/index.js\":\"66b1519eb404d0a9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/presetIdentity.js\":\"72d79aea81318149\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"aa954f72b0c6760c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/readMedia.js\":\"303a56ffb8bda2d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/schema.js\":\"b646db011f7036ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/serialization.js\":\"077c0b4be3199ef8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/targets.js\":\"9a37afc650b67cbd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/tokens.js\":\"72d5c1192e69babf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/watchEvents.js\":\"649699c1c01fc6e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/workspaceGuard.js\":\"61814a390322b497\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/writeCommands.js\":\"e5cf302e0eeae371\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/AliasCollisionToast.js\":\"f2d00e45ce4181ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/DuplicateNameBanner.js\":\"7edbe958668a797e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/collisionMerge.js\":\"800a060c030e3b27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/dataExtension.js\":\"24fbd4f679f3fcd1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/index.js\":\"6bd2ae45256d62b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/mergeCollisionAction.js\":\"21f4a8b7e637f053\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/pageStyling.js\":\"45471a90df004413\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/rejectionToast.js\":\"edbae9a383b01394\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/syncProcessor.js\":\"0f5149fdf9c3f90c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/actions.js\":\"dd83768e2abc9346\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/addComment.js\":\"cbf3496cddc224b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchor.js\":\"302ce2921c2e4324\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchorState.js\":\"f4ceef691f7715de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/commentLinks.js\":\"02d8cf53a2c0c34b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/confirmThreadDeletion.js\":\"0b91bc4af2d14eef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/container.js\":\"7ed3d7027020e5d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/dataExtension.js\":\"4e06d3af5e1a38d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/deleteComment.js\":\"a58c2833713658e2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/highlights.js\":\"e8ffaf3f0110e60f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/index.js\":\"ce0d21520b9e6bca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/linkedCommentsPill.js\":\"78d43c60089df257\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/margin.js\":\"3af69a19696762ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/marginSchema.js\":\"588613993b5c23d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/newComment.js\":\"4b87199be0201569\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ownThreadPicker.js\":\"266ea3b516d6a7ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/placement.js\":\"df6e3cd01544b046\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/queries.js\":\"b96966e8759ccd42\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotePosition.js\":\"a124859e02a05bbe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedIn.js\":\"f4efe5e14aa1285f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedRange.js\":\"6e0a16fb9d146d84\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/rangeRefs.js\":\"48f5a46a92f8464e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readHighlights.js\":\"5cc9c35c1a780e7c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelection.js\":\"b1f3a66c1c118800\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelectionUi.js\":\"6c686547efadd8ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/reanchor.js\":\"4f6d172604701119\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/schema.js\":\"f4e76d914b47f22e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scope.js\":\"06117500f2164aa1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scopeThreads.js\":\"15c5d4778a87db39\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/splitRetarget.js\":\"8d6911b80439e2dc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestionCard.js\":\"a7855424bef66ae4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestions.js\":\"34d727ac77c873bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaries.js\":\"3e5c2ee208533010\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaryBatch.js\":\"1b948644f08a7637\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/surface.js\":\"0c34c3c6aeda9fcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threadNavigation.js\":\"6294c8c866266c47\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threads.js\":\"d736e6cca6e5e449\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ui.js\":\"2e86db29d4a38ab4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/uiStore.js\":\"be926324d3693719\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/appIntents.js\":\"f9331447a9758d30\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/index.js\":\"ca5183b4433db88d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/index.js\":\"a0db251dc8757bc9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/status.js\":\"02faf97b210109d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3c113badf5de6bbd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaBlockRenderer.js\":\"1226e9c7a73c394a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f7b8276639e92e8c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaUploadReconciler.js\":\"53874e2275491343\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetDownLane.js\":\"b187607ae84fef74\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetResolver.js\":\"4d78e64ee6f5964e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetUpload.js\":\"47b1d5cf4b4a220b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/attachmentCleanerIO.js\":\"2969fa2f013d0048\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/supabaseAuditIO.js\":\"669c4004c42899c5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/blobStore.js\":\"4f25a104edb78ebf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/byteStore.js\":\"a5ef655e6f404b25\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanerIO.js\":\"71096b026490c16c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanupAttachments.js\":\"5aa8ab006c580613\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/dataExtension.js\":\"3e3329a1590224f1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/downLane.js\":\"4ed3a9358a55cfc4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/index.js\":\"7f66bc93655717ff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/insertImageContribution.js\":\"a7cbea20cf52e68c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneArming.js\":\"c4df71f423d6bd26\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneLock.js\":\"e2f7fad31ffd05f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaBlock.js\":\"a037de12510c71d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaCapture.js\":\"fa61fc572b6480d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewers.js\":\"c74429e590565103\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewersFacet.js\":\"013087a260060fdc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/pasteCapture.js\":\"161f4d22bc4e7af9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/resolver.js\":\"080483135b6a8384\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/retryUploadsAction.js\":\"bf187dc20bde2a35\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/storagePaths.js\":\"0294f7a62beee380\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadDrain.js\":\"1e6967816319a45c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadLaneStatus.js\":\"8bda3d66cdb45f84\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadReconcile.js\":\"2563b4507d1d44ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadRecovery.js\":\"851ee71d2436bd40\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadStore.js\":\"493054b9afea8794\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/useAssetObjectUrl.js\":\"e5b12a85472687f8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"726dc9929a92b566\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f29201925a1e469c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/facet.js\":\"d2150dddcf7781ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/index.js\":\"95cdedf18a54cb5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/prop.js\":\"2790ccc5b1108840\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinkFilters.js\":\"eac824d109e85c37\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"05c86ec1b2467505\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BlockEntry.js\":\"177f74e83b7048fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/LinkedReferences.js\":\"03f0cb3a5a692edf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0835111d56bd3ae3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dailyNoteDefaults.js\":\"9730fadc310280de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dataExtension.js\":\"96dbdf08250d41a9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/edgeExclusions.js\":\"4e704ca6ff911041\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/filterProperty.js\":\"01b182ac1264b9e3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/index.js\":\"9f09e6dbd85e59da\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5db54d2dc5d47437\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/applies.js\":\"fe333342622ca14f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/countQuery.js\":\"24d3922cf728b5f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/expansionStore.js\":\"84689b87ec66bf5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/index.js\":\"824871aa2942990b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5e9a0011c6491f30\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/presentationInvalidation.js\":\"6bfc5dab71fa54b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyEditorOverride.js\":\"16fb8fed52a68e45\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyFilter.js\":\"2dc5374bd180cc6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/query.js\":\"75c9f04f9a44b7cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/resolveFilter.js\":\"7d0df51e823592ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sourceBatch.js\":\"0c21af68ddc20cce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sources.js\":\"9378d22eee52df9c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useBacklinks.js\":\"aa9ff21a67373503\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fbabbdd33761fdc8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayCelebration.js\":\"84c6730df226eb0e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayOverlay.js\":\"91f5f3d335602c63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/gate.js\":\"106a28eb1ed0d2b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/index.js\":\"5d958b056ef21dfb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/wolfTheme.js\":\"dcee705a0dd48953\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/BlockDragLayer.js\":\"d2825a919b8d5cee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dragController.js\":\"a7034de28bfbdb10\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dropTarget.js\":\"6a45c2ea0f788949\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/index.js\":\"037015a75e987bae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/projection.js\":\"f32cacf2b528fb64\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/BlockMetaCard.js\":\"bc3992afd75ba323\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/index.js\":\"b385961688c0f958\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/AddTagDialog.js\":\"48ffff8bbea7ab5f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1aec32b572c0c0f7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/TagNameIssueHint.js\":\"f3d6b3c813f83436\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/addTagAction.js\":\"1f01d561df2feb7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/appendTag.js\":\"c57574f672446769\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/config.js\":\"acfa36f3d305417f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/dataExtension.js\":\"eeacde7d44318561\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/index.js\":\"5078d51e8eae1fc8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/propertyEditorOverride.js\":\"e9eeaaa780f40d95\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbList.js\":\"af257057f7e7bb3e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1056bb5aaa6d2092\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/Breadcrumbs.js\":\"da5630d9bd57e2d0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"00e60267a19d7320\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7d2fa7f708c5bf29\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/index.js\":\"aac5ff5ea40b1e27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5a4ee171804d8a4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/CharacterCountItem.js\":\"5c3a8eecfd84011c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a65adab3a9c7052b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/actions.js\":\"651a24b89670b203\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/blockType.js\":\"daf6652c3d0995f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/charCount.js\":\"a515f99f986eae15\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/dataExtension.js\":\"65cc0dd04f17c45c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/index.js\":\"ea5589a404bc5717\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/profiles.js\":\"605222c641d66b73\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/properties.js\":\"ced6458bcbfac4a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/textCounts.js\":\"ee2ec0fd8c71ff4f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/colemak-keybindings/index.js\":\"df890e750f77136d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/CommandPalette.js\":\"54a9646727c6b4f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/HeaderItem.js\":\"3e2c08b0b20d34ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/context.js\":\"e675a5a6b1057ea2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/index.js\":\"e80425fa76006d90\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/selection.js\":\"47027c44ee754859\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/toggleStore.js\":\"0a6a41ee0dda7d08\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/useCommandPaletteActions.js\":\"3013ec488d60e8c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/ContributorBadges.js\":\"ecd01b8d21aecd88\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/author.js\":\"e35106ea0a6bb210\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/codeMirrorExtensions.js\":\"7f11db63ee0f079d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/dataExtension.js\":\"e4e536bfffef3ee9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/index.js\":\"98023e7b626bddef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/mentionAutocomplete.js\":\"66ca8f7cb0b2504b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/processor.js\":\"5829d2f05a9fc15a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/profiles.js\":\"baba3f7ce4bce834\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/queries.js\":\"616dcea906976b54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/schema.js\":\"4698a1c520302030\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a95a9f6f37d85e70\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ea8c66ca38de2370\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/index.js\":\"980960d680ce5715\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6728ca045da04585\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1a274f15455f34de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/CalendarGrid.js\":\"eb5ddd0bcbeaf850\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DailyNotePicker.js\":\"4dd40afdb3b760cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4bd99dd47c8f43c2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateNavDecorator.js\":\"1a33ca2d5c810746\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateScrubOverlay.js\":\"5c03b910ba27f142\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/HeaderItem.js\":\"192e66aca8298912\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/ReschedulePicker.js\":\"f6dd2545b920e763\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5f73025b0de3caa5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/actions.js\":\"29a3fbaf2bf6e9c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/blockDateAdapter.js\":\"fd2bead59d11101f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/calendar.js\":\"468367f8a5f833ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dailyNotes.js\":\"d322cb4e84a2e63b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dataExtension.js\":\"94a6fac48eb37638\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubActions.js\":\"8c88574c0a786011\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGesture.js\":\"454d62fa74523bb1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b878ea1430d98139\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubRecognizer.js\":\"59995785ea4a116b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/deletionGuard.js\":\"4fc52ed7086c77bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dueQuery.js\":\"9db173cd49462118\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/index.js\":\"e3db16126dc82d0b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/landing.js\":\"79eaa7d384f2d715\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/localSchema.js\":\"bd2cf1a21f0fd144\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/referenceDateAdapter.js\":\"c2875f144e5e80ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/rescheduleAction.js\":\"0f5e247c74a801c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/schema.js\":\"5615dfb6299172ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadBlockDates.js\":\"f34fe7f7080a2830\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadDatesAction.js\":\"78f699a685f2cdde\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/today.js\":\"8a2d13fe980aa637\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0ceb0b695e1adca5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"586e80cc0b4c200b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/audit.js\":\"211cc4c604e9a8dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditAction.js\":\"7d7984967b05ba66\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditRanges.js\":\"d710e224b34a61db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/diagnosticsSource.js\":\"fb7b15b6d85f9665\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/divergenceScan.js\":\"09c13ea868dfcef4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/index.js\":\"40db3d5caa841e08\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0f0cf8738297221a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/referencesMirror.js\":\"37cd9f21c8966807\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/rowJson.js\":\"e5db809e5a9f54fb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/schedule.js\":\"3499f129f2438c91\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/store.js\":\"edf71d6ca845de34\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/action.js\":\"26b232fcde8db572\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/index.js\":\"41936e45edb9ebda\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/plugin.js\":\"9c93ad027c7dfb8b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"68b5c35e363a7d6e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/actions.js\":\"b46deff88878d862\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/changeMarker.js\":\"579f7b8ae23239c6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/diagnostics.js\":\"cabe21239deee933\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/fileSystemAccess.js\":\"dea920ea4eb4d0b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/filenames.js\":\"7882f4242808e3ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/index.js\":\"168b52bcc9241ac5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/mirror.js\":\"4219a3dc46ad9653\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runLock.js\":\"7eb8e3d214f4d05b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runtimeHealth.js\":\"dd49ac1aa0546065\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/schedule.js\":\"07a13855e396bb6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/store.js\":\"40e3158ab8eb5814\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/index.js\":\"a01cb6a9ecc7720b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/themes.js\":\"19e2d8042e095213\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/facet.js\":\"3df37f7e9aab4bc5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/useDiagnostics.js\":\"fee1676372a584e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/dismissals.js\":\"9a6935f04858228a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/index.js\":\"c6088834c4a70167\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/status.js\":\"63ad3799ad0a7206\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/store.js\":\"9d6d3b1d17ce2248\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6b58ff043f649c0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b102bbbf7b882c62\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/actions.js\":\"fd94b9694d857233\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/config.js\":\"d80d6d92d53efa7c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/dataExtension.js\":\"731aba5b0cbedb1e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/effect.js\":\"42bb6c71609e1667\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/index.js\":\"bf512767cabcccaf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ab0fff04643738ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/useToggleTree.js\":\"ca5efeaa6b578c52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/ExtractTypeDialog.js\":\"0574c805ec5f6d8b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e6dfd5553c9c379d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/PropertyShapePicker.js\":\"90f50926398724c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/action.js\":\"116fa12ff7731aeb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/index.js\":\"05157810a8c8d823\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/FindReplaceDialog.js\":\"0bbb2e3e616fe75b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/HeaderItem.js\":\"9071c8aaaf70ef46\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/dataExtension.js\":\"8fafe7de39d7a664\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/index.js\":\"39c33b15d8defaca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/search.js\":\"598730a6dc3cd2d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/toggleStore.js\":\"a6cb22d13c97de95\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/LocationPropertyEditor.js\":\"27199526ac5aeae1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/MapView.js\":\"497a2e0bc87d351e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/blockTypes.js\":\"dfc83c7c61dcc17b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/codeMirrorExtensions.js\":\"761f450f94a28407\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/createOrFindPlace.js\":\"2865e4192889f499\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/currentLocation.js\":\"854abf5b6597fdd6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/dataExtension.js\":\"bef96a3107a7e682\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/geoContentDecorator.js\":\"d82e4c817a4249d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/googlePlacesClient.js\":\"ccfeaa232eadac18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/index.js\":\"54256fe40d75d593\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/locationsPage.js\":\"121444651ea0c535\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/mapViewport.js\":\"8b9e86c4a85c1a8e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/pickCurrentLocation.js\":\"a381f06d775deb19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeAutocomplete.js\":\"caddffd062470349\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeNameCollision.js\":\"d542eae247cb46c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/properties.js\":\"413f7f3775834c49\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/propertyEditorOverrides.js\":\"c6642518223f66da\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/query.js\":\"002a5912a74c12be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/usePlaceSearch.js\":\"26160d1c0472a78f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"637e981e90a441b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e499bab3af1c69a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ddfe61917105b0ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/config.js\":\"436f73dd46ecdf0d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/dataExtension.js\":\"a205f0fab8407d4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/facet.js\":\"55d17dc32ebb7048\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/grouping.js\":\"8783ac2cf665f597\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/index.js\":\"b1fd99590ba95f9c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0b3067d863312544\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/query.js\":\"634077be37444d0c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/resolveConfig.js\":\"b4effe12060253ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e35a6181d7b6ec6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f86dbe1f6d17ab24\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlDocumentContent.js\":\"44274e0424951f77\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlFrame.js\":\"616cf2cd0e98b0c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/actions.js\":\"60ccba21f3f108d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/blockType.js\":\"96b759923707faa0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/confirmRunScripts.js\":\"0d39cfb213ae9a6b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/dataExtension.js\":\"f0a9d191ebf21f56\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameAnnotations.js\":\"e89470d811713446\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameDocument.js\":\"ef59ca6f7fbeb7dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameTheme.js\":\"2bfd6c3c0c7aac50\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/index.js\":\"ecfdb9d24320c49d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/scriptConsent.js\":\"0c16d3b70f0be237\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/sourceMap.js\":\"c03e8a9251d558bc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/useDocumentScripts.js\":\"0aa058bf7bfb8630\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/index.js\":\"2e8fe87266ba1ace\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/record.js\":\"ec74b58290032952\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/recordStore.js\":\"d1d3a532289f198a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/responsiveness.js\":\"4447fd14d94b8ecc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/schedule.js\":\"635018c66267d0f6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/sessionContext.js\":\"628b79f1c332230e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"26bd26a78326aa32\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d1f4a290d6a15966\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/actions.js\":\"345e7970f9dc2a3f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/config.js\":\"c7758e7770b9e7bf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/dataExtension.js\":\"60290dd5f9869ae2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/effect.js\":\"a4d981d8f09115d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/index.js\":\"2d1d6476d881b9f2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/keyCapture.js\":\"c7dcb513e998fb18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/overrideStore.js\":\"3dad7d7525b5f043\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4cfe768051f0ca51\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/HeaderItem.js\":\"ebcbdc221c09084f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/LeftSidebar.js\":\"357276a5c8d45db3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/actions.js\":\"9feb77bac3b769a0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/facet.js\":\"70c99477d76285e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/index.js\":\"2f1b4cc340f246bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/shortcuts.js\":\"36679857d26371d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/toggleStore.js\":\"561da42b8bec99c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/MergePicker.js\":\"8f34333a0c12331e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/index.js\":\"e928c8fc1132290d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/mergeAction.js\":\"e3f725892ef4b771\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/strategy.js\":\"c6023be6c45a1c98\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/Button.js\":\"ae710700e48fab7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"848ffd9295863115\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8db32d4a4ef866c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/facet.js\":\"9ea45ffb6653ded9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/index.js\":\"688b37c9d1d6cd0c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"88bffd54616a86a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5045c2e14f3104e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2f6762ef681a4cb5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c56c0d3690abf62b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/index.js\":\"4a536b0409ed9fa5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f3699285606e6ffa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/blockSubtreeMembership.js\":\"79fff3b13e1d425c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/contextMenuItem.js\":\"98c7c83ea29a6363\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/index.js\":\"f8460310bfd5d6da\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveAction.js\":\"1d4a6457cd9e873a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveBlocks.js\":\"01dd4f6c046508a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/selectionAfterMove.js\":\"4e80dbd8f864b897\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/TutorialBanner.js\":\"4db6198b1d888647\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/action.js\":\"79547294751504f8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/bannerDismissal.js\":\"978f2af6f82cd407\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/documents/cheatSheet.js\":\"981838168adea6c2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/index.js\":\"3332489fc51d319c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/keys.js\":\"8f4b9a88d57a6bb6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/landing.js\":\"e6dd18c75abbb2de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/outline.js\":\"673fdb2c28cf6af7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/seed.js\":\"de35ac6f9d4a2dee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d47f813405d0ae53\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/analyze.js\":\"dbd1e83179050b90\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/diagnosticsSource.js\":\"f63443b86bc3eb6b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/index.js\":\"bd42c80354e765ca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/load.js\":\"5e5a7b4899c983a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/monitorRun.js\":\"815d29444ade4b75\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/schedule.js\":\"68e3f9c14466cc0d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/series.js\":\"f4263f8b15eed019\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/store.js\":\"a2e78d889a983896\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/trendAction.js\":\"2f0126b0907c182b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/verdict.js\":\"2078bb462282a421\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/clickToEditAction.js\":\"c4b27ee012746751\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/index.js\":\"d6f319fc8ca587b2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/interactions.js\":\"94936b89ea575f73\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"134c022d7d92fbf1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGate.js\":\"28ee84d4bbd9c941\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGateDialog.js\":\"e0321394eecec666\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/action.js\":\"3439bbdd12321a21\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/index.js\":\"e2762875a471d154\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/localRunMessage.js\":\"059147d2ab6b92c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/plugin.js\":\"d9c278757c30cd52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/progressReport.js\":\"b74d5ead668fbaae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/sweepProgress.js\":\"5826bf0c03c3ab36\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/FieldRowRenderer.js\":\"24cf1cd781fbebee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/ValueRowRenderer.js\":\"64ea48f8ca929ab9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/actions.js\":\"ab7f4e6b5ad378a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/autocomplete.js\":\"0dc6aef1d734b5ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/fieldRow.js\":\"bae34500d49377c6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/index.js\":\"8f9c16ef90ab2f59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/referenceWarning.js\":\"8c9b950c8eef5002\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueAutocomplete.js\":\"e508edc5f1f7c1d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueSchema.js\":\"91807eebfd5bf29a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/HeaderItem.js\":\"7469a52697ccf17b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/QuickFind.js\":\"83b54c3910c5c7dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/index.js\":\"18a8793816e5202c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/recents.js\":\"99a4caf13fa768de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/resultItems.js\":\"765ad03fa86e73be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/selection.js\":\"f9ff2fb31458f832\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/toggleStore.js\":\"584dd53982e39f6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/HeaderItem.js\":\"40f1666d89e2b1da\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bdf49e29f21ed011\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/grouping.js\":\"d46a57ef67f12d2a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/index.js\":\"5661040b0126b2f7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/target.js\":\"c9bd03b803d1a305\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/codeMirrorExtensions.js\":\"5839e1b5c1bfd059\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/contentPrefill.js\":\"0b636bb488e667e3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/dataExtension.js\":\"c81ac6dc35a9b548\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/index.js\":\"ba29659984ce4d59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7571df98ad0a6f41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/invalidation.js\":\"655c4af4231cf891\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/localSchema.js\":\"f4741230d210bc72\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/index.js\":\"614d739c1eaa0f06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1d02499594001057\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/index.js\":\"d08a863e0638bd79\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/referenceNode.js\":\"8ed7b11e7f9d0ff9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5dc4c0a52ee9a103\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"77546eaa8ed1a4f6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/index.js\":\"9493b603409a11aa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e0b37134a10e5ddf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3a52d90a76b46d7e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/mergeRetargetProcessor.js\":\"6ca39888bd8100ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/parseFence.js\":\"cae4518158242614\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceParser.js\":\"99bfe9bea559371f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceProjection.js\":\"7614c65d3566f893\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referencesProcessor.js\":\"b4c9aac044a183d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/renameProcessor.js\":\"a3ffa1799ae7c57a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/spanReplacement.js\":\"d1a03091888cbdc8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/htmlToOutline.js\":\"1c600940644e2924\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/index.js\":\"5627c3c460cccb27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/normalizeClipboardDom.js\":\"10c72104cd3e0be1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/pasteDecision.js\":\"404164b0f0c2350e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/action.js\":\"2f42fc768a309d38\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/blockIds.js\":\"94591cd74a5a6f4f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/content.js\":\"f193e66f0941c9ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/effect.js\":\"feb217611f6242f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/ids.js\":\"428f6bf15d096d02\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/import.js\":\"c872fc3b1590e017\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/index.js\":\"0b812146a8f7734f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plan.js\":\"31ea912e64016635\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plugin.js\":\"0bd4ea7aa884021c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/promotion.js\":\"394d9804f9825b9e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/properties.js\":\"5e9852b7272a7043\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/references.js\":\"dae809f83da1142c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/report.js\":\"a48b873807d16f88\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/roamMemo.js\":\"d8436ea2186802c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/runtime.js\":\"d6ee33b55067c23b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/schemaReconciliation.js\":\"37c1cdb39e5b180c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/srsMarkers.js\":\"591702fc97ac4b6e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/todo.js\":\"3143eaebe74b2cfd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/typeCandidates.js\":\"04224470187b5400\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/types.js\":\"f8c7e16053f5902b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/index.js\":\"57f1088f008c961a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/store.js\":\"2442ef84e9c24b61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/HeaderItem.js\":\"0a87b317b274eb7a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9e89c765bfd6ca00\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/index.js\":\"7fffe4a200f56c57\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/model.js\":\"4b5a74d07f4a5351\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/toggleStore.js\":\"fa7121d474de8658\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/useKeyInspector.js\":\"3efa78c92a446c7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"93356a5e00d5459d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/ShellDecorator.js\":\"9978748b8ed602fb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/actions.js\":\"7b7d4556c9b39572\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/exclusionsFacet.js\":\"87415711dec6fadf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/index.js\":\"c88ce716abd3c700\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/shell.js\":\"1c71fb8cfc4c7335\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/surface.js\":\"132ff85131f66d7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/walker.js\":\"7feb77b1e3670b05\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/RescheduleToast.js\":\"cd81befe2843489c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/dataExtension.js\":\"4bf642fada74ab31\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/index.js\":\"91fa16593ad24534\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/indicator.js\":\"b487f84454247af0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/moveSrsState.js\":\"c7b157c39022d06f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9fce33f2e0e67121\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/scheduler.js\":\"8847cbf16d761860\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/schema.js\":\"dcaadf69e415dd01\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"eb614df9fcdd2ab7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsClipboard.js\":\"4ec8dae17b705795\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b4fab84c58dcd4b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DailyNoteReviewHint.js\":\"72fb11033a24884d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DeckPicker.js\":\"4c891d7586d9c1ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewControls.js\":\"b67d6fcbb20bf119\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b50009fd628a3d5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewSession.js\":\"7cf827a0ec0967f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/actions.js\":\"e894dabbb00f0677\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/archive.js\":\"4c86eb2365146eb4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dataExtension.js\":\"57f72e8e8f4a56c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/deck.js\":\"8384606e00570e5a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dueQuery.js\":\"e2c9593178fa2301\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/gradeDecision.js\":\"84625701011d9029\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/index.js\":\"fef7755148f29b14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/keyHints.js\":\"ecf36ba68f7939ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewCardLayout.js\":\"218359ba072c34f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewProgress.js\":\"f675c93f7ad22153\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/schema.js\":\"754d6652e04c1900\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/useDueCards.js\":\"ed2f848755ccc8e2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/index.js\":\"d4fcfe43b59d36b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/record.js\":\"5bb91bb174745acb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/index.js\":\"0ca329bd1c0b95be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/persistenceStatus.js\":\"27b35fa6258a3da9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/requestAction.js\":\"7a9d6a1e55dd8a7c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/TypeChipsDecorator.js\":\"fb573fde3a1c36ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/codeMirrorExtensions.js\":\"fea13c1235861402\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/index.js\":\"f4438b0f63d8ff0d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/typeAutocomplete.js\":\"7b4e8ff73da5d05d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c4bbfb46faf4b473\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/actions.js\":\"1e2d35da7d2b84ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/anchor.js\":\"ebb531eb569fa40e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/events.js\":\"ecb5e105df2cd28d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/gestureActions.js\":\"73a40df08edb7e32\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/index.js\":\"c9a67d3a4a498f1f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f0f65c3168983cb8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/collect.js\":\"fe40e61def95d6a4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/index.js\":\"e80540efa8a98bdc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/record.js\":\"e92fd4cb950de731\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/RejectionDialog.js\":\"6f88d15604699e4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/SystemStatusHeaderItem.js\":\"10e3ce1281c7bb9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/index.js\":\"f6b3e541a259cc71\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/model.js\":\"cdd9d3fd55076d03\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/queueCounts.js\":\"aee4076897e245ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rejectedHelpers.js\":\"9c6d43e624fb7c03\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rematerializeAction.js\":\"11d9b93d5923bb15\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/useHysteresis.js\":\"651b6f3a68d0097a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/effect.js\":\"69b44457f255ed8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/index.js\":\"8366519be03d913b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/theme.js\":\"4d5be7bf706235bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/actions.js\":\"93c887747766976f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/dataExtension.js\":\"a6abcacfc40e846f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/index.js\":\"89f0a390a98f3d55\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/schema.js\":\"6b9eb1b4bda91c3a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/TouchSelectionLayer.js\":\"62036476be97d715\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/actions.js\":\"6cdc0dfcda2c4e29\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/defaultItems.js\":\"7ef02daadc7c0f65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/facet.js\":\"0970ff70eee72b2c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/holdRecognizer.js\":\"b0fea3d18d13a1eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/index.js\":\"36aef50f3319041f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/UpdateIndicator.js\":\"ccbf7ee95a2deca1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/index.js\":\"d64548f480332596\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/loadTimes.js\":\"045daaf2ea468559\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoNotesRenderer.js\":\"1e32f23cb7b96a00\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoPlayerRenderer.js\":\"6067632c85d533c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoTimeStamp.js\":\"df6421e105b41b83\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/actions.js\":\"d131b4cef66c128e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/index.js\":\"4d32ae58dd05b128\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/markdown.js\":\"b82402b6094ca9be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/notes.js\":\"2be380dd4ab4a03c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/registry.js\":\"889595db1d80062e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/remark-timestamps.js\":\"5661a9ee27e7902c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/view.js\":\"be3b56e89286fa6c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/LinkHints.js\":\"e62b10cbeb3b316c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/index.js\":\"e46bf3afb68fd37b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/model.js\":\"8f80a1c1269315b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/settings.js\":\"1476fc5be429c1a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/actions.js\":\"57b3d721e51ed94f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/index.js\":\"b7617bf1a790ef51\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/interactions.js\":\"fa26663c85875812\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/workspace-header/index.js\":\"57190c925f55e567\",\"/knowledge-medium/pr-preview/pr-1790/src/registerServiceWorker.js\":\"a767938adbb6f315\",\"/knowledge-medium/pr-preview/pr-1790/src/requestPersistentStorage.js\":\"bb3cc4c0915a7ffd\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authRequestDeadline.js\":\"5000f421f3d89cd4\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authStorage.js\":\"baec4d350d4cc96f\",\"/knowledge-medium/pr-preview/pr-1790/src/services/powersync.js\":\"0b4d6a3ed394d32a\",\"/knowledge-medium/pr-preview/pr-1790/src/services/supabase.js\":\"520580744139f6fd\",\"/knowledge-medium/pr-preview/pr-1790/src/services/uploadErrorClassifier.js\":\"3241bf7814b9a4b3\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/ActiveContexts.js\":\"d85059611c021e42\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/HotkeyReconciler.js\":\"15e075b3c4bc867a\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/WipeLocalDataDialog.js\":\"acd54cb9ce96aac6\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionDispatch.js\":\"ae05494e3fbd8825\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionRefItems.js\":\"ee975f2c83116302\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/applyKeybindingOverrides.js\":\"8f019348404fb25e\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/blockActions.js\":\"56d73d0bd686ef2d\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/canonicalizeChord.js\":\"cf4d63a3dedf86aa\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultContexts.js\":\"9d892e4e8e25b6ff\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultShortcuts.js\":\"2d4cc86c7b89256b\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/effectiveActions.js\":\"d8951c31fc2b948a\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureAction.js\":\"829c26c589a706fc\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureBinding.js\":\"82d4d69b23bbe3a8\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/holdRegistry.js\":\"b2a0e3545718fbf0\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingConflicts.js\":\"bfbf7f6bfe534fd9\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingOverrides.js\":\"7faeab66a6785a59\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/pointerAction.js\":\"7ba200778d6178bf\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/resolve.js\":\"5526eab330abb831\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/runAction.js\":\"7a577f7b8711732b\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/sequenceMatcher.js\":\"c0d5f6b7de80b513\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/types.js\":\"23a61d068ae85b03\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionContext.js\":\"ed9925c5e3fbcc65\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionDiscovery.js\":\"c3f55133d8eeb9df\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/utils.js\":\"cd56e0805a25bbd0\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/bootStore.js\":\"73837d165588225f\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/previewDatabases.js\":\"5ed7bad9bce99ce6\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/byteTransform.js\":\"78fe195672d13463\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/attachmentCleaner.js\":\"11aa0a8c8fb87710\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/attachmentParts.js\":\"3d712d3a372b78a3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleParts.js\":\"c20b25d00f246d2c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleRecord.js\":\"d5ebb59558bd3e46\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/manifest.js\":\"21f6bff4d623ec4c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/takeBundle.js\":\"e0e91f59707dc5b3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/verifyBundle.js\":\"48ca8110f3e5ac7c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/cleaningStage.js\":\"38d9992c011c2582\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionKey.js\":\"4efc49fcc0f42f0d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionServer.js\":\"3164d3842aa69b81\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flip.js\":\"6f92425e579ff490\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flipAttempts.js\":\"2d4441b6a9fc1647\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/pages.js\":\"3955ad7d806b38fd\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/preflight.js\":\"869acb52d1472035\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/reseal.js\":\"8db264709eb2cda1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runConversion.js\":\"c06aaa5c7bc2275d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runLock.js\":\"470078411e738388\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealing.js\":\"9c7ec6dab1ea8010\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealingStage.js\":\"f9905425157e488e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/stage.js\":\"a2eba44a52846a9c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/verifyReseal.js\":\"ace231a5e75225b6\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aad.js\":\"ad93cbba4afe7aa1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aead.js\":\"a4b17fb9652e3fd0\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base32.js\":\"5487438469a4841a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base64url.js\":\"1832bf13c3e6cbad\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/binaryEnvelope.js\":\"860135aa8198bf8e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/byteAead.js\":\"9c2e4c15a21bcb15\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/canary.js\":\"36b5dc7ec248428f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentHash.js\":\"d010a675d0cf1f18\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentKey.js\":\"a9cb130359c09d2e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/derivedIdNamespace.js\":\"e6a80706c1ad7c88\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/envelope.js\":\"5ecdc17230f567e2\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/hex.js\":\"8171c4912e3df00a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/sha256Hex.js\":\"109ca09eec6b3f1c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/workspaceKey.js\":\"cfa2d865c02d4aaf\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/conversionState.js\":\"fc4f79e9ab2c2f39\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/createEncryptedWorkspace.js\":\"21bc4f19958ff0bf\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/pastedKey.js\":\"37dfc00d802d4c73\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"17f3e4cbdf242404\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/upgradeWorkspacePin.js\":\"089b64acfd17fdca\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/keyStore.js\":\"310c0f149c7d6a1e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/mintWorkspaceKey.js\":\"20e1c5d3743e5b6c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/modePin.js\":\"e855c2874a24454c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/openWorkspaceKeys.js\":\"89aab5f963bc2342\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolveWorkspaceEntry.js\":\"7a05a71b593411d9\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolver.js\":\"05f2cddd9d3ea4b1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/workspaceAccess.js\":\"73771100f874d0b6\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/transform.js\":\"c4fa8a9f9a0e2ce5\",\"/knowledge-medium/pr-preview/pr-1790/src/themeBootDefaults.js\":\"5275b36f76a04218\",\"/knowledge-medium/pr-preview/pr-1790/src/types.js\":\"df76c1a2e317109f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/ClientLocalSettings.js\":\"ce2fa41bb79190b4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/abortableSleep.js\":\"6240ba4909fb58ec\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/array.js\":\"60b2e8d5978baf32\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/backlinkAutocomplete.js\":\"fcfa9eb7d80a3cbd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockCrumbs.js\":\"4128c02092eb7194\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockrefAutocomplete.js\":\"0f598304e0314bee\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/cadencedIdleJob.js\":\"ae2381ce059a480c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/callbackSet.js\":\"78a0afed5d37f71e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/clientId.js\":\"de3b18484bbd4a83\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirror.js\":\"7e1d19d9ff1da395\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirrorCompletion.js\":\"cb49e882cf5e3cbf\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/copy.js\":\"50f9248813589e0b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dailyPage.js\":\"27bec6938f83d74f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensics.js\":\"49bed5d3e10e9090\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensicsHooks.js\":\"a2e96b551b310fcd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/deleteBlockThroughUi.js\":\"c9ffa4b0c4cfeed0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dialogs.js\":\"bc084bdf3bbd2c5d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dom.js\":\"eaeaf324c5174bf0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/downloadBlob.js\":\"38ae6605f829b19b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/exportSqliteDb.js\":\"67b381f10f2cf6c8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fileSystemAccess.js\":\"920234fde2da8cb1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/flipSlide.js\":\"71753b25a8e365fd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fnv1a.js\":\"d577e8712d9efddc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/formatBytes.js\":\"8ac875c840885052\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fuzzyRank.js\":\"e667b5c7c3f80901\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idbKeyedStore.js\":\"9a79cd02e09524a3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idleCallbackPolyfill.js\":\"ded183ba69d05a92\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardAwareScroll.js\":\"74b2bee35ef6b12d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardViewport.js\":\"3a1bfa3802f6b250\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/lastWorkspace.js\":\"a225c2ad4f908b72\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutColumns.js\":\"5030c4d8075e8845\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionDom.js\":\"dbbfb4d9887b46cb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionId.js\":\"8971577f37920205\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkClickGestures.js\":\"304c14ec8523edcd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkTargetAutocomplete.js\":\"3ed258f4fe6d15b0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbCorruption.js\":\"a9cb4355b0821e83\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbRecovery.js\":\"a6db450be5f02cb8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/markdownParser.js\":\"78df7f7550efc300\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/memoize.js\":\"207e4a909f6d247b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameFieldCommit.js\":\"a7fa60feef0adbc6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameList.js\":\"d4c860f4a2294998\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/navigation.js\":\"4a7832b597a76e90\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/omnilinerNamespace.js\":\"3cbe2a9f97eea084\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/opfsPageScan.js\":\"1d8099168ac48d20\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelClearance.js\":\"1bf0b325b2666271\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelHistory.js\":\"f7767d3665ab4797\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLanes.js\":\"d43e9ac405c9d0aa\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLayoutProjection.js\":\"c621e0dff3187c23\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelScrollAnchor.js\":\"0869308942a054a4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelUrlFlags.js\":\"04d27bd7d24cd6d7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/platform.js\":\"894348084a50b6bd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/pluralize.js\":\"6814b2c6a82f0675\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyCreation.js\":\"386eb51865291ecc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyNavigation.js\":\"30856617c1d16f81\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyValueContext.js\":\"c9b48f3537e7cfe9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/react.js\":\"450c2e0c674f87d2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeDate.js\":\"f0f7f37b2fa53a98\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeTime.js\":\"94c6dc4910582ac2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/renderScope.js\":\"4f1580113b7292d4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/resolvedThenable.js\":\"384a48d9745aec55\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/routing.js\":\"6d4255160f3abc78\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/safeMode.js\":\"6357a4a7dbf992b0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/scheduleIdle.js\":\"8183f0425f1f608e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/screenWakeLock.js\":\"22f4ad914fdeeb9d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/selection.js\":\"efce36a7e39dab0d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/softKeyboardGrab.js\":\"8dc1572ca2967861\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/startupTimeline.js\":\"e101e039afed39f8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/state.js\":\"1cd92f344d6c2f5e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/string.js\":\"7c08f7c794e2310e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/surfaceZoom.js\":\"bf57c76d05a5ff27\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/time.js\":\"19cf439304f1d2bb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toast.js\":\"5f47d629eb2a7e35\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toggleStore.js\":\"6aedd14278493dfc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/untilStopped.js\":\"8bbacb043baf2e71\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/userActivity.js\":\"766f09e7684f806f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewTransition.js\":\"540236678710abb4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewport.js\":\"9f21eaa42c41e3c3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/webLock.js\":\"e7d7eaad9ed7854f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceRecovery.js\":\"3bcbba4d11be8fbc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceSnapshotStore.js\":\"e8dc610ba4c84b5f\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-compiler-runtime.js\":\"27d323a743d07b40\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-client.js\":\"d21051a20b23e8ee\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server-edge.js\":\"8f58a5d6814c90a9\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server.js\":\"2a873af08cfc85e2\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static-edge.js\":\"c14ff8b6d09ce319\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static.js\":\"54545b41fe135a54\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-test-utils.js\":\"dcadac1de5d7d5db\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom.js\":\"fe2b9263b7fea33a\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-runtime.js\":\"6a93e389e8ba5a1b\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react.js\":\"93eaa0af378806bf\",\"/knowledge-medium/pr-preview/pr-1790/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
