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
		buildId: "c0617859bb6e-d37f9fce",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/\":\"2e63d3bcedde657d\",\"/knowledge-medium/pr-preview/pr-1790/index.html\":\"2e63d3bcedde657d\",\"/knowledge-medium/pr-preview/pr-1790/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1790/assets/FacadeVFS-Cbz06kB2.js\":\"74485875235893db\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSCoopSyncVFS-CUVNwzUr.js\":\"e0851b0ee1e1b671\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSWriteAheadVFS-3B0A1y4m.js\":\"bda9e01b694b4232\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-ktd0X-Hw.js\":\"0210f7d865f204c3\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-hQQbA2y8.js\":\"89ab406fe54e76b8\",\"/knowledge-medium/pr-preview/pr-1790/assets/worker--0zFX5-A.js\":\"d900c6d783ab594c\",\"/knowledge-medium/pr-preview/pr-1790/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1790/chunks/app-DBvFP7wO.js\":\"f7a748ed698233da\",\"/knowledge-medium/pr-preview/pr-1790/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1790/index.js\":\"b563af9b2af6f565\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1790/assets/AccessHandlePoolVFS-gsTi_WFb.js\":\"b665fa33c58c6af9\",\"/knowledge-medium/pr-preview/pr-1790/assets/IDBBatchAtomicVFS-dQYMcIHE.js\":\"c912dab8e9d130e9\",\"/knowledge-medium/pr-preview/pr-1790/assets/MemoryVFS--Q_GuuQF.js\":\"9c9014025853b9bd\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-D6OQyPL_.js\":\"108b39bf1f438432\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-D5Vpv8RX.js\":\"ae93362cb200092c\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1790/chunks/AccessHandlePoolVFS-DF__NFG0.js\":\"da3f6bf53174416a\",\"/knowledge-medium/pr-preview/pr-1790/chunks/FacadeVFS-Bjfj4zGg.js\":\"96442988320dbd3c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/IDBBatchAtomicVFS-BL7kfo8x.js\":\"f91bc3ea1f5a123d\",\"/knowledge-medium/pr-preview/pr-1790/chunks/MemoryVFS-CLPUPO1r.js\":\"45838b861cd149ac\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSCoopSyncVFS-C09Vaqio.js\":\"e16b1e81ad6260e7\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSWriteAheadVFS-DA6fvm-v.js\":\"2a46addb7da6fb38\",\"/knowledge-medium/pr-preview/pr-1790/chunks/Preview-C8vFPpi8.js\":\"29b1c541edde0612\",\"/knowledge-medium/pr-preview/pr-1790/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/card-Dr7B8b4M.js\":\"bd75686d2cdc5c9a\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-3WY-Wi6-.js\":\"2f86c46cc34829ff\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1790/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-DjZHvn0K.js\":\"9ff586e15f0095f1\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-async-D6txpUFE.js\":\"adfe25c6f0b68367\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-4t8h6ZkH.js\":\"203129cd7d1cf2b0\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-B62S2bdQ.js\":\"6923cb9339b68e23\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-BPypMp4H.js\":\"23a0598012b9c438\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-C8nwuZOS.js\":\"27bb7f2563b81786\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-CuWgx5lT.js\":\"2917d7b9091f14c9\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-DL7Smk1G.js\":\"cce45fc7c6057a3c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-D_VpZVfD.js\":\"497e7fcf6853eb06\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-De6qdz8n.js\":\"ecd6a8f24be3de48\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server-legacy.browser.production-pHxdvri-.js\":\"9bd298f285961135\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.browser.production-EWaOhwQx.js\":\"7f4dd7fef1919ead\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.edge.production-BX0z1dWy.js\":\"c4cf4719a4aae328\",\"/knowledge-medium/pr-preview/pr-1790/chunks/server.browser-lKAAwLHQ.js\":\"5ca11830f844d6c8\",\"/knowledge-medium/pr-preview/pr-1790/chunks/textarea-B3z_8flE.js\":\"6b97a66fdaf2b7eb\",\"/knowledge-medium/pr-preview/pr-1790/chunks/ui-2s-t6Gqv.js\":\"e5ee4477f9e8e296\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-Cw0QXI3_.js\":\"6bfb45abd330d337\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-async-B1GzTLn2.js\":\"9814a68e4ef205ef\",\"/knowledge-medium/pr-preview/pr-1790/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1790/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/src/App.js\":\"addc34e53ebd2cab\",\"/knowledge-medium/pr-preview/pr-1790/src/appUpdate.js\":\"6501fe4ae8b5296e\",\"/knowledge-medium/pr-preview/pr-1790/src/appVersion.js\":\"cc43c0c17de3340f\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/initialLayout.js\":\"7a5bf5a2cddbaa4d\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/openWorkspaceData.js\":\"0270d2db1dee39a0\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/resolveWorkspace.js\":\"0adec1ed8f852bd7\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/workspaceBootstrap.js\":\"24edde0e365c4838\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockComponent.js\":\"80bb120fdec477bd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockCrumbs.js\":\"6c6d725d6be2330d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockEditor.js\":\"ede552aa1d81800f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockLoadingPlaceholder.js\":\"42cf807a134df8f9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockProperties.js\":\"c18a51f329ac3147\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockSearchPicker.js\":\"40310d5c5bdbf077\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ConfirmBulkDeleteDialog.js\":\"2b9cfb98f8bc1dcf\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DividerHandle.js\":\"d92868224374af63\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DraftEditor.js\":\"c2c9b1d595ec68cc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/GutterPill.js\":\"d5e07abed7555b59\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Header.js\":\"be67349d152dddff\",\"/knowledge-medium/pr-preview/pr-1790/src/components/LazyBlockComponent.js\":\"55689b04f00a4861\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Login.js\":\"e4bc1cf308e4fca8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ZoomableSurface.js\":\"46896b5458d07b8c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/editModeKeepalive.js\":\"606078291c0358b2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f15ebd9e20b733ad\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2a9d39dd60c1befe\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefPropertyEditor.js\":\"57ea66f7dc63abf1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefTargetTypePicker.js\":\"459ff84f3006a63a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/SelectPropertyEditor.js\":\"7d8eec235abce467\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/TypesPropertyEditor.js\":\"87f1a836a0b32248\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/defaults.js\":\"794789852244dd17\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/kernelValuePresets.js\":\"233ea6638313a406\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/selectablePresets.js\":\"94480b2c69b4339d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/typesPropertyUi.js\":\"0cfb1a71c8860956\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/AddPropertyForm.js\":\"9dbf06ea2825b820\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyPicker.js\":\"17ab0571df641633\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyRow.js\":\"d51002c3abb6c2b2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/Rows.js\":\"6248481eb7f23c45\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/actions.js\":\"2cfe50e25ceb45d7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/declarationOnly.js\":\"87e3ac4575a765fc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/layout.js\":\"c9fc7709c17c8d08\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/model.js\":\"527429840a118008\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapeUi.js\":\"d861b34a421cbffb\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapes.js\":\"7edfaa07008bf692\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7c1c8189db749ee2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/visibility.js\":\"ee152b6938551483\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanelSections.js\":\"61dc9dc087d92422\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockEmbed.js\":\"22811d8a8ec65c37\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockLink.js\":\"90870234fd65b5af\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockRef.js\":\"7a5b9574061d3822\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/ReferenceLink.js\":\"26354557614baf1c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuard.js\":\"4f42cd186a1a47f0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuardContext.js\":\"c637119004e92b1e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/linkInteraction.js\":\"e183b1dd32c8d566\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/referenceLayout.js\":\"202ff15be657c87d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/useBlockRefAncestors.js\":\"4ee9fdd3a363ce24\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockGutter.js\":\"bc9749ee7f3991e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockInfoDialog.js\":\"6bcf8d984195b2de\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockTypeBlockRenderer.js\":\"b49515fc69b0cd91\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BulletHoverCard.js\":\"fa825a2609eb7899\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorContentRenderer.js\":\"9099815b84ebf7ca\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"18a6c1fdd6e0c140\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ColumnResizeHandles.js\":\"4ece364c71583090\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"738f89cbc39b322e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/DefaultBlockRenderer.js\":\"57b3e818ee42cd60\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/LayoutRenderer.js\":\"522eec1b5dcd552b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MarkdownContentRenderer.js\":\"c513cc986c66ce56\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MissingDataRenderer.js\":\"a0d2b14cbe545b4a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PanelRenderer.js\":\"70b84d685581ba50\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PropertySchemaBlockRenderer.js\":\"756c4d4ed0bb557f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/TopLevelRenderer.js\":\"d2766a93aac2b88d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockGutterMode.js\":\"cb7f4ab0546771f4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockTitleText.js\":\"db5f136be92103cc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/fieldCreationKeydown.js\":\"5965518f333aab26\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/layoutRootContext.js\":\"8bd92179b5c9cd8b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/TypeChip.js\":\"7b43682c197b4aa3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/chipStyle.js\":\"04863186e8aaa652\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/anchored-floating.js\":\"66fedcc7a03ac125\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/button.js\":\"223d9144c1c98977\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/card.js\":\"9c94980129273e20\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/checkbox.js\":\"d8026d45357a7f1f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/collapsible.js\":\"602442419a535643\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/command.js\":\"0240aa3ef65e14b9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/context-menu.js\":\"6d1db9ef8b775c7a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dialog.js\":\"4b18b7708d6331ce\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dropdown-menu.js\":\"aef61e5619770499\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/floating-listbox.js\":\"f44427de2be8017a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/index.js\":\"5747bc0c4a57f909\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/input.js\":\"7601219d6352b9ad\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/kbd.js\":\"69afd9694a627e1a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/label.js\":\"37f469c9eb874736\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/textarea.js\":\"cd6050fd8e08193e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/useEditModeYieldKeepalive.js\":\"eb2e9f4e66710884\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/BootFallback.js\":\"fb5a6dba9e0184a1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/FocusedRowLazyMount.js\":\"004861e69f624b4d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LazyViewportMount.js\":\"cd300ebdab209a20\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LocalDbCorruptionFallback.js\":\"e255de9b87a538b4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/error.js\":\"498eca57482680ec\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/lazyMountRegistry.js\":\"767238e76a52201f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/suspense.js\":\"954b71a8da84ed90\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/CreateWorkspaceDialog.js\":\"9623d498251ff043\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/PendingInvitations.js\":\"2c52f2936d59b0b6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/SyncProgress.js\":\"e62ac8dd4d359764\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/UnlockProgress.js\":\"f5cd1e20a105e4c6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceKeyGate.js\":\"dfe64241eeaf0021\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSettingsDialog.js\":\"e0654a07f4a13185\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSwitcher.js\":\"da1710149da402f1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSyncGate.js\":\"28415bf0b0994eb7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlow.js\":\"0668220eef6238ee\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlowHost.js\":\"99804806974113e8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/EncryptionSection.js\":\"a2c1ad67782161c7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/attachmentPrompts.js\":\"c50756e24b209a70\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a1c90ee67b0329f5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowDeps.js\":\"53d2aaf8615012a4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowStore.js\":\"2cfa7835c29fc982\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/flowUi.js\":\"60006b1b95c75ded\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/useConversionRun.js\":\"928c215c843a59e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/keyUi.js\":\"45f022b99092a273\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnKeyLoss.js\":\"64567cb437329a9f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnServerE2ee.js\":\"f9165a2fddae7d3e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/workspaceUnlocked.js\":\"c614dbbe8a114c6c\",\"/knowledge-medium/pr-preview/pr-1790/src/context/backgroundSubtree.js\":\"c7722e83f4079a92\",\"/knowledge-medium/pr-preview/pr-1790/src/context/block.js\":\"f0ba2ccce951a00b\",\"/knowledge-medium/pr-preview/pr-1790/src/context/layoutWsContext.js\":\"04c9b5580e431b1e\",\"/knowledge-medium/pr-preview/pr-1790/src/context/propertyDisplay.js\":\"64cdf2935cb76521\",\"/knowledge-medium/pr-preview/pr-1790/src/context/repo.js\":\"e3cd8adee1921f16\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasClaim.js\":\"87deec8aa5385186\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasSeatNamespace.js\":\"2da575e50c9d825b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockData.js\":\"cb0ea0242c968b0a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockType.js\":\"429d3c42cdb3bc8d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/changeScope.js\":\"aecab060b9a5e289\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/codecs.js\":\"292c64b3340f4956\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/derivedData.js\":\"54f18d7250d5af15\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/errors.js\":\"5d6a5bd2d9636696\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/events.js\":\"de371b8458399a4c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/handle.js\":\"01ed4f2ee0fb506f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/index.js\":\"35ddbc3c6d653a51\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/mutator.js\":\"a870242e403f9022\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/processor.js\":\"d78e281294c9a960\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/propertySchema.js\":\"971c6483d977e818\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/query.js\":\"a1dedffbd6bf9bf7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/sameTxProcessor.js\":\"57d0c19ee8e94932\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/schema.js\":\"01ed4f2ee0fb506f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/tx.js\":\"01ed4f2ee0fb506f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/typedBlockQuery.js\":\"172a78db5e31b9ee\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/user.js\":\"89c45fa6f6d2b9cf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresetCore.js\":\"8e6deee9de10d044\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresets.js\":\"43ca1db26fa7c93c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/attachmentCleanerIOVerb.js\":\"ca8768d0c2196972\",\"/knowledge-medium/pr-preview/pr-1790/src/data/block.js\":\"f3423ab18727e40a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockCache.js\":\"dd7e1331df61396b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockId.js\":\"6f5c107c139b802d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockLiveness.js\":\"ac755c287066cb55\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockMerge.js\":\"25756c351924c468\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockSchema.js\":\"b3b1daae73438cad\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockTypes.js\":\"fc17d308000e3e7d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/clientContext.js\":\"aadf2b3bcffb3453\",\"/knowledge-medium/pr-preview/pr-1790/src/data/dbFileSiblings.js\":\"fcedc5a5b01c35d7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/definitionSeeds.js\":\"b2ef81e64a00e77c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/derivedIds.js\":\"fec2481f6a7fbed5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/drawnSubtree.js\":\"67eff3394ab93a1d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facetBridge.js\":\"c30d114c8e1f02d3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facets.js\":\"459001145af2b4ad\",\"/knowledge-medium/pr-preview/pr-1790/src/data/globalState.js\":\"eae6b106a8155ab6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/aliasClaimRederiveProcessor.js\":\"d8d3edaf1e06cfcd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/ancestorBatch.js\":\"0fe2affc314b7df6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/blockTypeTypeifyProcessor.js\":\"b0455c6dee24a616\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/clientSchema.js\":\"124cc1b9527269aa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/commitPipeline.js\":\"f770f59843ccd857\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/devAssertions.js\":\"78de7b185f130ec0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/firstSync.js\":\"a4cef4ea0b55d23f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/freshInitialLoad.js\":\"8e42a9f0d18a8e37\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/graphBackfillClaim.js\":\"e35f273c976ada45\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/handleStore.js\":\"eac98959beadb263\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/idleMarkerJobs.js\":\"1bee61ae4efdaa5b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initialDownload.js\":\"a190bf4d1420bd82\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initializeClientDatabase.js\":\"82230088c8f406bd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/jsonCanonical.js\":\"96643bc39b883bfd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelInvalidation.js\":\"1665738f43197617\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelProcessors.js\":\"76df0401932d1096\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelQueries.js\":\"b89a56dc49c82cb8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/mergeTypeMembershipProcessor.js\":\"eb5001c74e9bb279\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/normalizeReferencesProcessor.js\":\"9ce60ac13b9d94ac\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/poolInstrumentation.js\":\"00eeac7da889cea4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/processorRunner.js\":\"e8c86ffb3b46f700\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyCellBackfill.js\":\"d6e33deb94d15b7f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildMint.js\":\"4f41e9d55fd30f97\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildrenProcessor.js\":\"23f0442f9ea94b58\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6ac9cde5744f2fab\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionSynthesis.js\":\"bd9e89b6f7336e82\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyKeyScan.js\":\"274717b45320637d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertySchemaResolution.js\":\"50e1e44abd9464d2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/raiseProtocol.js\":\"d88fb11c5fc8d639\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/readBatch.js\":\"cfd47b79ee7a4d4f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/refProjection.js\":\"042061413a5e8b18\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetLookups.js\":\"6ff0219266d53e60\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetProcessor.js\":\"dadeefa8d5a1d147\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/replayMerge.js\":\"da93ca3df34586e9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/sqlBinds.js\":\"70fd0610e67ed04b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b7bcc23c34ba91f1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/arrivalProcessors.js\":\"a68420b457e70ea5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/invalidate.js\":\"89c14ed38dd31782\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/materialize.js\":\"3cc758bde0a003f5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/observer.js\":\"078504451141a1e8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/reconcile.js\":\"068fbed3cf9a59f3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/timingMetrics.js\":\"bc8171f81b9b738d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/treeQueries.js\":\"78a10cdc1824a8af\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txEngine.js\":\"09d668785d0873f5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txSnapshots.js\":\"e7fb042d5c686289\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/typedBlockQuery.js\":\"a9b98d372a017b72\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/undoManager.js\":\"4dc24896a97bec2a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/invalidation.js\":\"91f7a8b24de007c9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelDataExtension.js\":\"897479a13b2ec9f3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelPage.js\":\"39b1b6673f3520a8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelValuePresetCores.js\":\"4e75991ffb7908d3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbCorruptionSignal.js\":\"6d106d29069e6013\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbStorage.js\":\"3febf6adaead5e6b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbVfs.js\":\"3f5e7e997d63ac17\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localSchema.js\":\"cf5638dbd59d422f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/maintenance.js\":\"32636cedf281136a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mergeProperties.js\":\"a8080c987f6045f2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/metricsConsoleHook.js\":\"3e4f34216f3bba5f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/migrationsPage.js\":\"970d156d1bc1e07b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mutators.js\":\"e21676ce1e9fc138\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKey.js\":\"fc08d15209e51720\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKeyPlacement.js\":\"f13851e349d53b5b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/outlineSurface.js\":\"08ce19c05be64efe\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingEditorContent.js\":\"63fe00469565b5f1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingUploadsSql.js\":\"6f731b032d5bf09f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pluginStateExtensions.js\":\"0fea9a1f19dbac06\",\"/knowledge-medium/pr-preview/pr-1790/src/data/powerSyncLogger.js\":\"aa01b3488d83cf90\",\"/knowledge-medium/pr-preview/pr-1790/src/data/projectorRuntime.js\":\"f2cc239e0caf5bd8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/properties.js\":\"98c1617ca7b4b1be\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertiesPage.js\":\"90d6ea715f31ddf3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyChildren.js\":\"d781e5ad297ef236\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionFanout.js\":\"0b5b3279f7f994a9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionMetadata.js\":\"1a8f0d846d201afa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionRegistry.js\":\"24a0d059ff7d96ee\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDisplayMode.js\":\"c310bae8435d2d43\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyRowCreation.js\":\"eb884bd5fb33d601\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySchemaCreation.js\":\"41a83b7a1d2a9cff\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySeeds.js\":\"bbfae3dbc5334550\",\"/knowledge-medium/pr-preview/pr-1790/src/data/recentsPage.js\":\"000888c95a8818d0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/referenceBlock.js\":\"cacd09b8e2d23a4d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/releasePowerSyncConnection.js\":\"25a41433a1901263\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repo.js\":\"9a2c7e1bfac0b030\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repoProvider.js\":\"84eaf339e50b08a8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/rowProperty.js\":\"1344ca764dd441a5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/searchFilter.js\":\"a21f757ba2a4463f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/seedIdentityLedger.js\":\"2129c40fab7092ee\",\"/knowledge-medium/pr-preview/pr-1790/src/data/stateBlocks.js\":\"a236413997a071c6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/structuralEditPolicy.js\":\"2511355cd7bdfa21\",\"/knowledge-medium/pr-preview/pr-1790/src/data/subtreeDelete.js\":\"4b63a562bfaed0af\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncStreamLock.js\":\"9f04b3d6cfeed400\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableSqlRecognizer.js\":\"5f0a274888357944\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableWriteGuard.js\":\"a1c124b02b797f94\",\"/knowledge-medium/pr-preview/pr-1790/src/data/targets.js\":\"e62640e00b792729\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeColors.js\":\"f5392c2a91a71fde\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionMetadata.js\":\"0a69e8385b386d4a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionRegistry.js\":\"cd6086f360d4f38e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeExtraction.js\":\"12d5a9bd3d24a907\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeInitialValues.js\":\"6d9b8daa93606a2e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typePropertyGroups.js\":\"5986387364da2f57\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeSeeds.js\":\"857540cc804155a9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeTagger.js\":\"84e786ab91b231b7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typedRecords.js\":\"7a7eb25f4430d039\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typesPage.js\":\"8f5a01b731b67cfe\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userPrefs.js\":\"00a9e77ad5e665d3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userSchemasService.js\":\"6f2f55aaeae51057\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userTypesService.js\":\"6a80a807e3c70671\",\"/knowledge-medium/pr-preview/pr-1790/src/data/valuePresetRegistry.js\":\"bab8068dbaf541f9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/visibleChildren.js\":\"50bb0134c7a9e814\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceConversion.js\":\"ea34b678b6d8f017\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceFirstSync.js\":\"c935bca6dd18b3fe\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceIdNamespace.js\":\"2d4579c740723800\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceSchema.js\":\"edd89cb95b0da6eb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaces.js\":\"badd87cfb50571ab\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadLog.js\":\"78841750a7e63ddc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/BlockPasteShellDecorator.js\":\"0ec0df0cdc864bca\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/atTrigger.js\":\"6f131ad54c4aafce\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/autocomplete.js\":\"b7482436fa86daae\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/codeMirrorExtensions.js\":\"c98484839ac49eba\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/contentFlush.js\":\"3e3953cda3ee9cbe\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/defaultInteractions.js\":\"eb3f3dd5a8070ab2\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/editSettleSignal.js\":\"7acb848129489a8b\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/insertImage.js\":\"b37e7f561088f478\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceCompletionRange.js\":\"a0094420ea5e73aa\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceTargetTypes.js\":\"5a7ef572326d9b17\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/syntaxContext.js\":\"936000086c6821dd\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/triggerMatch.js\":\"22424b81e5af8055\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/AppRuntimeProvider.js\":\"6c1953625ff93bfd\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/BlockFocusShellDecorator.js\":\"8c4ef7826fda23c1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/ExtensionRenderBoundary.js\":\"3b7299aa2b168b91\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/PanelContentRecovery.js\":\"d8e21e79a0d8a10c\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/apiCatalog.js\":\"f05917642cf61263\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/approveExtensionHere.js\":\"869545896e7cccb4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/armedCutAppMount.js\":\"55caca181b2abf96\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/batchableKeyedStore.js\":\"c31814ca0895314a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockInteraction.js\":\"4c5860a1c8b7875e\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockSelectionAction.js\":\"8fb6e5e1d6cb9964\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compileExtensionModule.js\":\"734c3ab57cb204b1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compiledModuleCache.js\":\"9a3cdf3d5afdc55f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/continuousGestures.js\":\"057f8e58d2e08c32\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/core.js\":\"375e653ccc5366bc\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/defaultRenderers.js\":\"ed3a85577d8449ef\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/definitionFanoutAppMount.js\":\"359bafa9ade7fe8f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dialogAppMount.js\":\"68274101ab09193e\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensionSeeds.js\":\"8194f25ebc4e78ee\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensions.js\":\"7a5a7bcbda800b52\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/exampleExtensions.js\":\"572ed0c7acf6fd9c\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionApprovalStatus.js\":\"70baf31590f3b3d7\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrorToast.js\":\"5cd7556099b93c7a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrors.js\":\"ba11a3cb521955f1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLookup.js\":\"651f582c18baad19\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionToggles.js\":\"1b0db8e432aca9aa\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionUtilitiesCss.js\":\"ca14755196c286a0\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/kernelPageDeletionGuard.js\":\"1667af8705ae4128\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/liveRuntime.js\":\"c3cc3fe50d6727b2\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/openExtensionsSettings.js\":\"37508ce4cdbdc409\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/overridesCache.js\":\"792644de3bae0d69\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/pluginIds.js\":\"8cb80a33a611228d\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/processorRejectionToast.js\":\"4d86d13e89c05272\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeActions.js\":\"dbb5b33e725464be\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeContext.js\":\"5f413939af6b6f53\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticAppExtensions.js\":\"8bfe3560e177c606\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticDataExtensions.js\":\"1a8fdd7019ccdddd\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/toastAppMount.js\":\"5d89a11058591dfc\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useOverrides.js\":\"c9a5958b2ce7e6ac\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useShortcutSurfaceActivations.js\":\"baa1d34eaeae4a22\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/discoverToggleTree.js\":\"7bf48fe6acc800ae\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/facet.js\":\"566722f09fa6a52c\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/resolveAppRuntime.js\":\"ba7262be819c06d2\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/runtimeEvents.js\":\"e955d8454ed629f9\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/togglable.js\":\"cd2cf92b9e357ebb\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/variantFacet.js\":\"9e09bf9b9b18b711\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/verbFacet.js\":\"703b5b4e492023af\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/block.js\":\"4a990f84216e9ca5\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/focusedChild.js\":\"e72b24a6d9772a69\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/propertySchemas.js\":\"b478c58f4220b0e9\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/typeRegistry.js\":\"b2773728320baafc\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAncestorCrumbs.js\":\"758c273abda61b87\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAutocompleteListbox.js\":\"4cbd4f42df1cd4ca\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedSearch.js\":\"6d6cc7f47d1dfe99\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedValue.js\":\"7c3f22a63bbb12d6\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsFocalRender.js\":\"d10d06497d1011f7\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsReadOnly.js\":\"6baab27a7c3aa987\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMaterializeBacklog.js\":\"e15abee80f5ab442\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMinuteClock.js\":\"b0cc99781bb1ea6d\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePanelLayoutProjection.js\":\"7dcd76e4f5a6856a\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePendingInvitations.js\":\"4cf467f9803f0412\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRendererRegistry.js\":\"e7cf9f6740019753\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRetainedFieldRows.js\":\"a536ba0ba210e5cb\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useWorkspaces.js\":\"25f42b555134e028\",\"/knowledge-medium/pr-preview/pr-1790/src/lib/utils.js\":\"b10848c2dffe26b5\",\"/knowledge-medium/pr-preview/pr-1790/src/main.js\":\"37637cff89ea4fd1\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/MarkdownImage.js\":\"0ee69b8b27be746c\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/blockSeparators.js\":\"ce80e9c10ad17c93\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/context.js\":\"9a81cf4b086e3a39\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/defaultMarkdownExtension.js\":\"efd84f5bd271e457\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/extensions.js\":\"2d8c048b4f2cfff1\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/renderMarkdownHtml.js\":\"748b033580990df2\",\"/knowledge-medium/pr-preview/pr-1790/src/minimal-editor.js\":\"604df9395f3ea4f6\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/armedCut.js\":\"9317b950758d2e7b\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/captureMediaVerb.js\":\"fe889d63195ab06c\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/clipboard.js\":\"3698760ba8f42248\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/decision.js\":\"791447e873fa7f21\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/operations.js\":\"8367a541b6c25e61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/AccountHeaderItem.js\":\"21665fee729f9a67\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/index.js\":\"6f192200d72ad240\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b14462eb1ca98484\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askAgent.js\":\"0077eb539bb0476a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askedStore.js\":\"15ea77adf954800b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"11932c161740e5f8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/chipState.js\":\"2502d6168c3140f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec19bfcd313cc4cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/index.js\":\"75b59a252b81394d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"32c3352b34693a78\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/schema.js\":\"b34d87416313e947\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1f43083cfd191173\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/BridgePairingDialog.js\":\"63768f8dccb79e6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/addMedia.js\":\"e343fe51aad1ea92\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/backlinks.js\":\"48789fa288323f97\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/block.js\":\"231c0af14a7150c1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/context.js\":\"afd5a08816d63aa3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/displayIds.js\":\"8b481985c5bd2278\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/index.js\":\"cc037267c88d4dbc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/outline.js\":\"a9d3a1112c0ae7e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/properties.js\":\"b25ebceba87132ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/refs.js\":\"4f210060a628753a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8cbda4778963adf3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/search.js\":\"ba1424dfaf0f4b6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/shared.js\":\"d3440bd63456b50f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f8514171e621d3b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/text.js\":\"4d5bee9fc034895b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentWrites.js\":\"938085c13bce6053\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/authoringCatalog.js\":\"e1c4484151f7d8f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/blockRefTargets.js\":\"25d8322559595c8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridge.js\":\"a80e4d709d582dfd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridgeLoop.js\":\"44fcd41d9c529cd5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/changeHistory.js\":\"e91948f0f4c47cab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commands.js\":\"ea1078761c230f0d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commentsCommands.js\":\"1a61a90a5b445a86\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataExtension.js\":\"2f858e73de1027d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataModelGuide.js\":\"6706b8a896697f55\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/describeRuntime.js\":\"18280b50c90f5ce5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/extensionLint.js\":\"c05c7a36ed397506\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/grainAudit.js\":\"bae97a8e48a63a87\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/healthCommand.js\":\"e73805304c17919a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/index.js\":\"7801dfc51d2dc3af\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/presetIdentity.js\":\"346186bc9b05a2ca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7bd4da15ae0a6ab4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/readMedia.js\":\"5568dff64c410610\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/schema.js\":\"a5197a7a74b5ebe8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/serialization.js\":\"01e241e4fdc63af1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/targets.js\":\"7fbbd431a5acce50\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/tokens.js\":\"577d65a963519557\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/watchEvents.js\":\"8e8f369656f3d249\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/workspaceGuard.js\":\"1ab0a6dd20b11063\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/writeCommands.js\":\"55e908d69ffa53e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/AliasCollisionToast.js\":\"9695c8f199720737\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/DuplicateNameBanner.js\":\"8192282f28fa326a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/collisionMerge.js\":\"a7e35f174ee65438\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/dataExtension.js\":\"808319425507fd71\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/index.js\":\"0e991c75a3cf83c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/mergeCollisionAction.js\":\"871cdf6ce77f973b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/pageStyling.js\":\"8efd597dfc60be2c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/rejectionToast.js\":\"40923da1d717fc44\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/syncProcessor.js\":\"e57d1e9f247c25e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/actions.js\":\"edbec5f85c73a401\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/addComment.js\":\"7cea6f86f17aa553\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchor.js\":\"7b1648fa9c77f73b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchorState.js\":\"bb2386e1bd4048a7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/commentLinks.js\":\"9f7aa133161cd9ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/confirmThreadDeletion.js\":\"c5e7b9ccf660f3db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/container.js\":\"e1fa1a6ddd55473f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/dataExtension.js\":\"4fc9698e0da4cb7b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/deleteComment.js\":\"0fdb415d41810bfd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/highlights.js\":\"c3149866cb90a75e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/index.js\":\"dd82e0e7fcd30792\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/linkedCommentsPill.js\":\"ee3b80d4728b8884\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/margin.js\":\"c5d456cadba82e37\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/marginSchema.js\":\"20926cb5f0ff9bd8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/newComment.js\":\"34ee6dc82097bc68\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ownThreadPicker.js\":\"893e1b98cff15e82\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/placement.js\":\"803cfe63b337f772\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/queries.js\":\"970a3823bb2ac294\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotePosition.js\":\"fa27fb4c3434b847\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedIn.js\":\"d379cb5860974009\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedRange.js\":\"bcf4b4aa6dafa2f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/rangeRefs.js\":\"cbe1911ee1e96196\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readHighlights.js\":\"928a1e58a8888ea4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelection.js\":\"2596f44c8f4d5ab0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelectionUi.js\":\"fff4d94743b85787\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/reanchor.js\":\"12dea3db196e466c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/schema.js\":\"ce42302703ce5c90\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scope.js\":\"c3233da62d2fcc7c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scopeThreads.js\":\"9d2f6c0f603b6223\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/splitRetarget.js\":\"28b8a3c800a86734\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestionCard.js\":\"e61df2271d184b63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestions.js\":\"e7cce218df4130f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaries.js\":\"c4acd0879e18c349\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaryBatch.js\":\"0c1a10b98a254402\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/surface.js\":\"5ca46064cc640f16\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threadNavigation.js\":\"214def37b7697267\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threads.js\":\"3de8e0e1705ee1f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ui.js\":\"378b385686e94847\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/uiStore.js\":\"5fb454ff0ff77ff7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/appIntents.js\":\"4fbaf7db88fb9409\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/index.js\":\"2875e57f2a828b30\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/index.js\":\"4899e36b250f7334\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/status.js\":\"9f1a6a0a9edbb579\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a4fef5ecaa86bbe7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaBlockRenderer.js\":\"80d0915f24294c18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6c5d6efe35904837\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaUploadReconciler.js\":\"81643eb65acc0aa8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetDownLane.js\":\"3f5067fa821be851\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetResolver.js\":\"7cd13a8a506f2395\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetUpload.js\":\"6dda0d2e3a57cf3f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/attachmentCleanerIO.js\":\"20a258afed49843c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/supabaseAuditIO.js\":\"eeee8c22f81708b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/blobStore.js\":\"f46c62e71c756dd5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/byteStore.js\":\"464863b126cc3906\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanerIO.js\":\"1706616bed4f7ddc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanupAttachments.js\":\"484e07232beba172\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/dataExtension.js\":\"ebed098ef976ccfb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/downLane.js\":\"d1ca16628cd6cf0a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/index.js\":\"bdd5db05d446d838\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/insertImageContribution.js\":\"8b308f0102d4dca5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneArming.js\":\"54ebe4b4237f611e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneLock.js\":\"fda0c6efbd365688\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaBlock.js\":\"6d27745c00213215\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaCapture.js\":\"5cf8c34f2cca7b70\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewers.js\":\"db05f6450b6527cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewersFacet.js\":\"13ada7176c54081c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/pasteCapture.js\":\"a92820103f5cd11d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/resolver.js\":\"b0446fbc811184b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/retryUploadsAction.js\":\"0b5081322b6c541e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/storagePaths.js\":\"efc67d43a9e5a0d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadDrain.js\":\"fe56fb0ee643a262\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadLaneStatus.js\":\"da38ad77e40617c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadReconcile.js\":\"25308077200cb772\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadRecovery.js\":\"d69ea3c290c19cb6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadStore.js\":\"09e692b6b1667471\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/useAssetObjectUrl.js\":\"fae5858d6a773c55\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"88648a324ac89b82\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksViewSection.js\":\"cacc4d04026af809\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/facet.js\":\"519343bae10a8e78\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/index.js\":\"e4666c148ea23ef3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/prop.js\":\"828664f96e5e2b12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinkFilters.js\":\"3cf9fea940be3939\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b993c13a3008bb63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BlockEntry.js\":\"a8535711da159832\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/LinkedReferences.js\":\"af902c43b3879ad4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2ffb60786b00bc15\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dailyNoteDefaults.js\":\"fe26644bc0bf64bc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dataExtension.js\":\"aceea59165023f8e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/edgeExclusions.js\":\"f3b8877e0d7798aa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/filterProperty.js\":\"81663db67ea192f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/index.js\":\"b9034d37668425e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2e17efc2ef061e5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/applies.js\":\"66df286ee5f5e788\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/countQuery.js\":\"e80d8baafeb8903f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cad0501dd4e69a6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/index.js\":\"9af8f9861cd5e79c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c3673695aea04652\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/presentationInvalidation.js\":\"511806e414b7dacd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyEditorOverride.js\":\"f65a4ce0622fc107\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyFilter.js\":\"e2ae4b23fedfb59f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/query.js\":\"1ab796759d610cd8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/resolveFilter.js\":\"1c4cf356f553d6f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sourceBatch.js\":\"9af2debb9d744946\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sources.js\":\"e0e1cc169a1bb3ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useBacklinks.js\":\"f40792bdac20c7b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"aecdb80ef5cde941\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayCelebration.js\":\"8b75df67c6e30ea7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayOverlay.js\":\"8a30fdb73dd986c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/gate.js\":\"28c70e063aaae506\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/index.js\":\"71eaa311e317819c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/wolfTheme.js\":\"1bb8974dce048cf6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/BlockDragLayer.js\":\"a5410248a8396eb5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dragController.js\":\"b0ea23ecb3a96ea6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dropTarget.js\":\"8226486926732fb1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/index.js\":\"078abf518195700c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/projection.js\":\"ed6590f73cb98457\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/BlockMetaCard.js\":\"4b6b792f35437c1a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/index.js\":\"5073b6e541db69b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/AddTagDialog.js\":\"3b93ed5f5db2a828\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"633901caff83e2c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/TagNameIssueHint.js\":\"034cfa8db71a3d74\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/addTagAction.js\":\"2d068c8bbf30023f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/appendTag.js\":\"75d0bbbb3542b2a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/config.js\":\"35382e8140fca337\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/dataExtension.js\":\"0d7773fb3e4a7849\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/index.js\":\"afe6ba36b1911148\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/propertyEditorOverride.js\":\"3a12846dc6052a80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ce178f739ebd6b5c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e15e9ceb95b57021\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/Breadcrumbs.js\":\"78c2166c331b19d2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2ae673907c49368f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"110dbb690bc3fd97\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/index.js\":\"95cb6ba770194487\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9cdbe889e1afd406\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/CharacterCountItem.js\":\"be3821b6a1a8f773\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/ProfilePropertyEditor.js\":\"86bdf081a540eb33\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/actions.js\":\"b86a06de83cb7fcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/blockType.js\":\"92745e41b07b2b60\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/charCount.js\":\"afb3b037ae86edb6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/dataExtension.js\":\"1dd17a03a1e32216\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/index.js\":\"0c8543706e581671\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/profiles.js\":\"b29b1f8e9c280426\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/properties.js\":\"0261cd51724b6345\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/textCounts.js\":\"af362e159c0c96ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/colemak-keybindings/index.js\":\"f2111c1ec5dd64c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/CommandPalette.js\":\"8fa02ea4300998a0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/HeaderItem.js\":\"aee12762e463c385\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/context.js\":\"11a15771d3484046\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/index.js\":\"46be79414b55d2b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/selection.js\":\"055e73339f0c8d00\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/toggleStore.js\":\"937e283e93653680\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/useCommandPaletteActions.js\":\"1b4fd233f0326242\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/ContributorBadges.js\":\"7e39d1d51f930d10\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/author.js\":\"46fb9dbde2f381be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/codeMirrorExtensions.js\":\"5567d3ab31023dd0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/dataExtension.js\":\"842022c348571483\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/index.js\":\"03a8780e698af0ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/mentionAutocomplete.js\":\"8905c9a50257fdcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/processor.js\":\"9601d0c12d765313\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/profiles.js\":\"1bb0736a69ae88ba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/queries.js\":\"1d1e9ae0bf2922bf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/schema.js\":\"508206d8508eceaf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"890fb641e4b14980\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c096b3a8f61af564\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/index.js\":\"4d56e7f4136eeadc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0ab4bcc8c1eeddec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"af7069d19e6ef1fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/CalendarGrid.js\":\"66b6e8bbb4ac84be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DailyNotePicker.js\":\"a9662ed4c77c32ba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"68cf5e30ffa2f999\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateNavDecorator.js\":\"426631b2d5eea17e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateScrubOverlay.js\":\"919d41d060e2041d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/HeaderItem.js\":\"dc5a50d532f7a75d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/ReschedulePicker.js\":\"959401b4e9bbf2ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/SpreadDatesDialog.js\":\"881728d856d2c6a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/actions.js\":\"2ea03b7951918936\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/blockDateAdapter.js\":\"19fd34bd6eca4126\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/calendar.js\":\"26e42054e48ebe2c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dailyNotes.js\":\"2f1bf775bc652573\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dataExtension.js\":\"0170ed9ad76dda4d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubActions.js\":\"3e4275e9c552eb31\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGesture.js\":\"d3abd17d06e57357\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f2df280c56b14ef0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d28baea8b7d87a0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/deletionGuard.js\":\"2763a296dbe5373e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dueQuery.js\":\"ae5d0b268bb611d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/index.js\":\"3dffeeac2a836e52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/landing.js\":\"802ef2cd543dbe0b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/localSchema.js\":\"c426cd2e10975745\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/referenceDateAdapter.js\":\"21e0bafe115298c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/rescheduleAction.js\":\"183e2c32e5b227d2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/schema.js\":\"06dd66c72f183def\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadBlockDates.js\":\"417467d7aba50ff5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadDatesAction.js\":\"1961da3f346ec33f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/today.js\":\"1860848456404f87\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9bae04e1f847302d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"db5951ff2cad9f13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/audit.js\":\"a401510750dcb764\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditAction.js\":\"e975ea682b473bde\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditRanges.js\":\"72500484da925881\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/diagnosticsSource.js\":\"be840f29185b422a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/divergenceScan.js\":\"6b1d215b960d6c10\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/index.js\":\"29aec4550dd7d0ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dafde70b032ea69b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/referencesMirror.js\":\"b4b2452760b907fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/rowJson.js\":\"5ae1a82035a288a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/schedule.js\":\"5ef61ca83cdf9dbc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/store.js\":\"eaacce9764a9a486\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/action.js\":\"5ec440832fb3a212\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/index.js\":\"5049504024170cde\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/plugin.js\":\"b68dccdf6fee977a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f8db7a486cc56ca5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/actions.js\":\"1df71e61e58798b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/changeMarker.js\":\"d5adcb4c083355bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/diagnostics.js\":\"1ca4045ef56c8238\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/fileSystemAccess.js\":\"3ace4911408ba190\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/filenames.js\":\"505019c13cbf9184\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/index.js\":\"5df14e9bfe1e237a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/mirror.js\":\"4fa6db1bf9aca8a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runLock.js\":\"915eb1cdf8a49f90\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runtimeHealth.js\":\"fc0191271eab3a33\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/schedule.js\":\"602f42af595476f8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/store.js\":\"04dad7adc8ff329c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/index.js\":\"2f51023fb65afe67\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/themes.js\":\"f33302dcea4a053d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/facet.js\":\"7c3ab4d62ba0dfeb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/useDiagnostics.js\":\"e00d2b68dd7964c1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/dismissals.js\":\"e2793163f480fd9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/index.js\":\"92380bb6508f95e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/status.js\":\"72c3f6f7207ebdf8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/store.js\":\"c3dd88307faec438\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a880e2ea6dc7a471\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d911aff2c92da66f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/actions.js\":\"cfd5ac7d6fa1d428\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/config.js\":\"84d303993e7a0df9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/dataExtension.js\":\"f6b744beb4a66044\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/effect.js\":\"ddb60122b028ff91\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/index.js\":\"0b93914fd776ee8d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bf5fb1c888ec3c1e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/useToggleTree.js\":\"8951f74277559f07\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/ExtractTypeDialog.js\":\"2abc2768f5dff8b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"1eb394b85fd8597d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/PropertyShapePicker.js\":\"f4ee2d81ebf64795\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/action.js\":\"71cd601974e9cfe7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/index.js\":\"0efa5947bed87ae5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/FindReplaceDialog.js\":\"bddb984503fbf662\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/HeaderItem.js\":\"66d93fe9b3cbf543\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/dataExtension.js\":\"853500ebefc6dbcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/index.js\":\"6e4227987bdf4244\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/search.js\":\"e1ca61fac20105b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/toggleStore.js\":\"93d3a752afa6c92b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/LocationPropertyEditor.js\":\"7ab32f85eb6119fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/MapView.js\":\"940f6e2518fa2162\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/blockTypes.js\":\"02794913cf478681\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/codeMirrorExtensions.js\":\"ec6d60dcde4a5674\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/createOrFindPlace.js\":\"3878c668408c34a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/currentLocation.js\":\"c59d870551536db5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/dataExtension.js\":\"cc9beb23ea31eae2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/geoContentDecorator.js\":\"47546765f2cd3830\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/googlePlacesClient.js\":\"ae1f31ae3f6c4634\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/index.js\":\"8c3712d81ed81a75\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/locationsPage.js\":\"f1208a7b4afcf575\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/mapViewport.js\":\"6632b21e94db3303\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/pickCurrentLocation.js\":\"6c355011ceea9711\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeAutocomplete.js\":\"af3ede74fc80f593\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeNameCollision.js\":\"d958a216ad7f2722\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/properties.js\":\"ce3c9adf0f8bf350\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/propertyEditorOverrides.js\":\"5adf0c74c8b6c579\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/query.js\":\"02788aff15a19357\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/usePlaceSearch.js\":\"79f294a6c57dc2bf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ffdc020a8331a005\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"66ca441750ef961e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"54a76b56d27a4b7c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/config.js\":\"6bb6b0a7132ab301\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/dataExtension.js\":\"0c1901668a13cf86\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/facet.js\":\"1c667bceff7e54b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/grouping.js\":\"ccafc913f8d599d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/index.js\":\"65b0764d101502c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d47b52b758a2cc06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/query.js\":\"ceb660f6371a0c59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/resolveConfig.js\":\"f2e5df20bf2c22e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7a242c48e4f2e0ca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"689d66549adce129\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlDocumentContent.js\":\"f39bc796ebcb1416\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlFrame.js\":\"8896d095a6ff9a28\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/actions.js\":\"378e0eeb2b582922\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/blockType.js\":\"e2e590a8364bd575\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/confirmRunScripts.js\":\"6fe3f0a1d704a618\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/dataExtension.js\":\"81fe9ec2d7ba70e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameAnnotations.js\":\"124f88fc71ca41c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameDocument.js\":\"2a46002de3c64e71\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameTheme.js\":\"1df31d2549d8e635\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/index.js\":\"566d7cbad4bac977\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/scriptConsent.js\":\"34a65414cd9eb9a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/sourceMap.js\":\"1e255d781c73f7b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/useDocumentScripts.js\":\"970489be7b7e9ff9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/index.js\":\"1b503445ff336db8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/record.js\":\"9ee822a35288b252\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/recordStore.js\":\"bb601b0466d0e26a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/responsiveness.js\":\"7f01514c7cc5f25a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/schedule.js\":\"882030f57bfcd6ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/sessionContext.js\":\"c83ccd2d45f6b265\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"61272f61e6acfc27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e363d7cc4e80f3b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/actions.js\":\"5a2e343156e0d00e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/config.js\":\"371d18127b9f2c27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/dataExtension.js\":\"6a69f93e12b656b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/effect.js\":\"a622383b9b2939b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/index.js\":\"afdde167b090f2b3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/keyCapture.js\":\"5d974f55e902005d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/overrideStore.js\":\"b3a30ea3c4eedc12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5d6db9564739858b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/HeaderItem.js\":\"19490c205a623082\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/LeftSidebar.js\":\"f62615cd0b92adbe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/actions.js\":\"f9af730c2b4e8cef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/facet.js\":\"f624f250f03e1dff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/index.js\":\"33d7e9a0acd5f52f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/shortcuts.js\":\"8a33f62b9ec12cb6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/toggleStore.js\":\"63efa7b9dae9eaf2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/MergePicker.js\":\"9eb79c9f5578f553\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/index.js\":\"72ff0e7d5976d01b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/mergeAction.js\":\"18cf6ce6e6c1552b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/strategy.js\":\"ec69a05006a0ea1c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/Button.js\":\"a01be3252a3bb388\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6b9971f882c2de99\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f622fb2c4e3e63ba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/facet.js\":\"02ee57799ef9f802\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/index.js\":\"43b7dbd13ec1a2cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"485c446be5428b2a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/actions.js\":\"959b33a5c53ae82b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f46b733f708bb7e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/facet.js\":\"155be4b4b8661359\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/index.js\":\"afc16e89b7d97888\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6ac5687a91f278b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9793a1a0d518703d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/contextMenuItem.js\":\"2aada59e3ba6518c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/index.js\":\"14f77627214e5f7e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveAction.js\":\"0d9632d6cf57733e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveBlocks.js\":\"2aff857aae9e02eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/selectionAfterMove.js\":\"e6f758402c9ec278\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/TutorialBanner.js\":\"392715841e97bd60\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/action.js\":\"b90484b85d21d1ca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/bannerDismissal.js\":\"7dba607f805f3367\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/documents/cheatSheet.js\":\"45aa7475d6b641e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/index.js\":\"ab16d32e183a1e44\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/keys.js\":\"22d2631a2f6400c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/landing.js\":\"f59c23eb3b94b3d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/outline.js\":\"e5ed5d189f19b0b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/seed.js\":\"495e4ebb8435a740\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1862cd9de5acd2f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/analyze.js\":\"fd1ee7472efaf69f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/diagnosticsSource.js\":\"b12cb2fa46ff1551\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/index.js\":\"816dae4e7bb9e7f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/load.js\":\"7f8929aaab511cb6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/monitorRun.js\":\"6bf4dce09ab6a1f2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/schedule.js\":\"8f38df6be1426328\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/series.js\":\"6e115113a692a258\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/store.js\":\"37f9f2ca435507d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/trendAction.js\":\"0ad774f9cc47ab4d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/verdict.js\":\"12785f03bffc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/clickToEditAction.js\":\"a5a7375421345f2c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/index.js\":\"354c024a2d265fd2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/interactions.js\":\"dab4fa9a47ca88bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3ff39406da2887ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGate.js\":\"05f5fe2f9271f494\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGateDialog.js\":\"d5f076430ac6498d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/action.js\":\"0233d0d4ae70ddcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/index.js\":\"3726961ab47bf29d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/localRunMessage.js\":\"3eb5634d82001f8e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/plugin.js\":\"614a53ab67143e14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/progressReport.js\":\"f7365143291c6cdc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/sweepProgress.js\":\"bdbc3c76f4921377\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/FieldRowRenderer.js\":\"f2be97ec6a6fb2dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/ValueRowRenderer.js\":\"87b2d5d8bf1731fe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/actions.js\":\"271aea93f1f4ee4e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/autocomplete.js\":\"10b7dc76612db1d0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/fieldRow.js\":\"aad091d25aeed2db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/index.js\":\"8f94c490b7220a3e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/referenceWarning.js\":\"bf01caab7fbb46d0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueAutocomplete.js\":\"88085db43730260f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueSchema.js\":\"daa9ccc94616f5c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/HeaderItem.js\":\"b7db5076fba50969\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/QuickFind.js\":\"d5f6100a1356db5d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/index.js\":\"751471e9dfd8de2f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/recents.js\":\"b45d48ba5cc46c99\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/resultItems.js\":\"bca15ce4ce12d0e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/selection.js\":\"f330ca34a6617310\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/toggleStore.js\":\"e1b6ea18337eb140\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/HeaderItem.js\":\"901e46d5747e413e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e74e2a17cd61d496\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/grouping.js\":\"d2e5904cd3e29c84\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/index.js\":\"7d2d5945a4d7af70\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/target.js\":\"f8b3e0840f1dceb5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/codeMirrorExtensions.js\":\"40cf4fab89fcf16e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/contentPrefill.js\":\"e30ffd17257668d9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/dataExtension.js\":\"54abc456a04551e0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/index.js\":\"f83796052a18a940\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3b8ce00cb147a41b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/invalidation.js\":\"8b36024c76791e75\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/localSchema.js\":\"e89784d6298d437b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/index.js\":\"e89ea15b39fe35db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"40a43ff9f41aa618\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/index.js\":\"6ccd361430db78db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/referenceNode.js\":\"05cabbd463113a40\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b4e916530e9f42de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"73608723f6734b66\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/index.js\":\"3a312da726a7574e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"98265f348ad6b6cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5de3b1454a267ebe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/mergeRetargetProcessor.js\":\"2ca08cbcc3595679\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/parseFence.js\":\"0d8e8ebd8ce8f922\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceParser.js\":\"2224e939c4d493e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceProjection.js\":\"cb6568c66d4a9a05\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referencesProcessor.js\":\"b08412e5d690fdb9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/renameProcessor.js\":\"8fa1d9b8e746cf6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/spanReplacement.js\":\"f4e01715f661bf61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/htmlToOutline.js\":\"1e0f289cf89a2e45\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/index.js\":\"411bd9466609e9c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/normalizeClipboardDom.js\":\"06b54787e06e85a4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/pasteDecision.js\":\"afc27eea55c8dba1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/action.js\":\"1b8f283aa4bfcb4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/blockIds.js\":\"486771b162455f7d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/content.js\":\"60ee63e0245d8af8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/effect.js\":\"988f6cf4ba73f469\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/ids.js\":\"ca8c157a4dcb7410\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/import.js\":\"39e6ed6eabf7f1ff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/index.js\":\"446aa59b671ca56a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plan.js\":\"ecb2b00ca62d6532\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plugin.js\":\"96d24ef9d81c1a49\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/promotion.js\":\"a650744037519b39\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/properties.js\":\"e4a35408a319b982\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/references.js\":\"1ff6c5f43e492d5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/report.js\":\"a3b1a30fc5281b4a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/roamMemo.js\":\"a6050f3f6aa7abd0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/runtime.js\":\"c5f055354275eb8d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/schemaReconciliation.js\":\"2d5f68fecdcc4a2c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/srsMarkers.js\":\"6c51f7871c5e5413\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/todo.js\":\"ba44295926b2f74c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/typeCandidates.js\":\"2af9700dde77e789\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/types.js\":\"848cd73468ee3bd0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/index.js\":\"8ed301b551ddacba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/store.js\":\"03395796f3970800\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/HeaderItem.js\":\"6b494411db212ffd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"df5361eda2690b3e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/index.js\":\"f87b40bcc1f794b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/model.js\":\"1c174193f84488b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/toggleStore.js\":\"2fc938d000659dfe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/useKeyInspector.js\":\"83c8d6b62493a781\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"90b74e831e1c9e8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/ShellDecorator.js\":\"ac9fb97d836d402a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/actions.js\":\"d798c09800901946\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/exclusionsFacet.js\":\"270f195f54a74608\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/index.js\":\"3e9caf58b82dd874\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/shell.js\":\"9bd322382c0b52f2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/surface.js\":\"d05f275eb4734576\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/walker.js\":\"81b1d575e3f4000d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d33c2a01e2e9534e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/dataExtension.js\":\"abab961bf3fad638\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/index.js\":\"dfa80157d3ff0f40\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/indicator.js\":\"4e8bced07dbd3dd8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/moveSrsState.js\":\"0c81e3955ec502fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6f74e8bc2ed40ca1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/scheduler.js\":\"6df584f8c58e02c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/schema.js\":\"c42b9d3a9e8fdc0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"160d4caa4716706c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsClipboard.js\":\"022afea76c0526bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"990d66a3bc79e2c5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DailyNoteReviewHint.js\":\"719eda80cfe56a53\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DeckPicker.js\":\"a92c943a189207f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewControls.js\":\"faeb7bb520849039\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5e6b2d1debb313d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewSession.js\":\"d7562b47ed3666d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/actions.js\":\"7ce97f29436df389\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/archive.js\":\"9382cb6ac4cf55d3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dataExtension.js\":\"2ae2b1500e4fc79f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/deck.js\":\"330db2258519adc8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dueQuery.js\":\"42712b62f9fa6791\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/gradeDecision.js\":\"7105335db7b02d8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/index.js\":\"28b210683ab0ad04\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/keyHints.js\":\"3ee1c1e6ae6a2ec6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewCardLayout.js\":\"06729b2c802904d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewProgress.js\":\"401508f0ce7b4712\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/schema.js\":\"c4c588259b3e92f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/useDueCards.js\":\"aa2b19ca71d0d577\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/index.js\":\"52e5cc67e36f6236\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/record.js\":\"679e6529ac99cf3d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/index.js\":\"72b43bd30bc910b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/persistenceStatus.js\":\"fd4adfab7aeef3d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/requestAction.js\":\"572fe768bfc47b70\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/TypeChipsDecorator.js\":\"7c07f41005cd2e02\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/codeMirrorExtensions.js\":\"51fb367eb937724e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/index.js\":\"1ae9fa7d9b68fb06\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/typeAutocomplete.js\":\"9dac098e58155f53\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1f1da0e43e385255\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/actions.js\":\"5093f4d463fa06ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/anchor.js\":\"9ace8bc4441bc2d6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/events.js\":\"3cffb430e63ae683\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/gestureActions.js\":\"011968a8098d3549\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/index.js\":\"89c132ac2c21e062\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"96d1c2f5d6679054\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/collect.js\":\"870100f43133c28a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/index.js\":\"42e56620b4f8667e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/record.js\":\"dcc2b52edcb094db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/RejectionDialog.js\":\"335ca6c5c3d8b78b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d523a9177e35e4b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/index.js\":\"15b0b7e4ecba947f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/model.js\":\"e329d05abce1571c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/queueCounts.js\":\"9456bfeae5509a90\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rejectedHelpers.js\":\"a1f9404f36208eb7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rematerializeAction.js\":\"883406af232c3af6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/useHysteresis.js\":\"d91473e5b4853f7c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/effect.js\":\"9c62443e5cffcc56\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/index.js\":\"b5585cb2e986f14c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/theme.js\":\"6cc14629ba26a31b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/actions.js\":\"84fb0678a7a5dbdc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/dataExtension.js\":\"1e53058907e02dfe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/index.js\":\"9b4a9a8b6402851b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/schema.js\":\"79ea39b73ca3ea96\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a7d3df34a055e8df\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/actions.js\":\"3db9fc9afa8728d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/defaultItems.js\":\"191af327851485e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/facet.js\":\"91014494ac8b3d91\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/holdRecognizer.js\":\"82e5a81d711c1442\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/index.js\":\"82ce3344043119db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/UpdateIndicator.js\":\"81fe50aab226efd4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/index.js\":\"4a2d1774a3e757ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/loadTimes.js\":\"00d6c341e74daf59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoNotesRenderer.js\":\"ad5a174b8b757d30\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoPlayerRenderer.js\":\"80bb9d5ce64f83b1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoTimeStamp.js\":\"ac66fb04fe9aa168\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/actions.js\":\"4b370b0ae0b8d27d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/index.js\":\"35ef89a3d8f75222\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/markdown.js\":\"5abbcb632f70655f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/notes.js\":\"653cf53eeb0fdda6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/registry.js\":\"d9c65a6b921e1742\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/remark-timestamps.js\":\"d0f87a332d1bf4f7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/view.js\":\"fe2ced4e19f1d5e2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/LinkHints.js\":\"8d55d6eb3d74853b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/index.js\":\"1a6630d1b5979682\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/model.js\":\"9d255a9d989381b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/settings.js\":\"39f0d698eb2e69ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/actions.js\":\"dea52c98fd648a0b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/index.js\":\"b179a34e7f8a0b68\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/interactions.js\":\"d746f31ad96e3e64\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/workspace-header/index.js\":\"beb2dde5484a2024\",\"/knowledge-medium/pr-preview/pr-1790/src/registerServiceWorker.js\":\"74e9ef7370d6a6e1\",\"/knowledge-medium/pr-preview/pr-1790/src/requestPersistentStorage.js\":\"7a76ca18284d0584\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authRequestDeadline.js\":\"ff8ed25bc77038f7\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authStorage.js\":\"6fb4885cab72f639\",\"/knowledge-medium/pr-preview/pr-1790/src/services/powersync.js\":\"f30cb6f306264ef3\",\"/knowledge-medium/pr-preview/pr-1790/src/services/supabase.js\":\"767763bd1984582e\",\"/knowledge-medium/pr-preview/pr-1790/src/services/uploadErrorClassifier.js\":\"97d5ca1f81d1ed28\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/ActiveContexts.js\":\"3e8805dc0bbf3c12\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/HotkeyReconciler.js\":\"da69ce777a772406\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/WipeLocalDataDialog.js\":\"a81350fe1a94ace7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionDispatch.js\":\"1cdc83418640baac\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionRefItems.js\":\"eb3b0ad06ab29ebf\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/applyKeybindingOverrides.js\":\"4d8f70ce12ccf27d\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/blockActions.js\":\"4095adeedcc0f6ac\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/canonicalizeChord.js\":\"307b187b5a736da3\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultContexts.js\":\"500a7c943a46e32d\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultShortcuts.js\":\"fec393effb1f5770\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/effectiveActions.js\":\"fd55a60d1e6284fb\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureAction.js\":\"d75122dd32b6d5f0\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureBinding.js\":\"fd03abe3e63d5087\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/holdRegistry.js\":\"52cd9195b3971138\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingConflicts.js\":\"2335a3764f9bd727\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingOverrides.js\":\"300a82d422d1f69e\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/pointerAction.js\":\"6196489d68b37293\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/resolve.js\":\"51835766aa764dea\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/runAction.js\":\"4189369ce14940cd\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/sequenceMatcher.js\":\"2a5faa8f759dc594\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/types.js\":\"bf683fa0100b8bf0\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionContext.js\":\"b6ab510f4024f34c\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionDiscovery.js\":\"2d89fb5c0358537f\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/utils.js\":\"323818f38f19704d\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/bootStore.js\":\"dc8fb3e492c35bf9\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/previewDatabases.js\":\"5764d0e015021612\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/byteTransform.js\":\"47ed5af21ca406c0\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/attachmentCleaner.js\":\"784bf6b70d10a2a3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/attachmentParts.js\":\"d24111a986f59bfa\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleParts.js\":\"6bcb152b4e607306\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleRecord.js\":\"2eff9ce9fe80e0e8\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/manifest.js\":\"98292fc0a24be513\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/takeBundle.js\":\"74eece38fa6aada8\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/verifyBundle.js\":\"d66a3c6f65254518\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/cleaningStage.js\":\"8ee2982c48edb51c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionKey.js\":\"0ec5c073456a712a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionServer.js\":\"4038cc6b85d91925\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flip.js\":\"5cd7165e6ea514f9\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flipAttempts.js\":\"fd29e1beac687f4c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/pages.js\":\"2a6a948131a3a84f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/preflight.js\":\"9be308be2f0ad3fa\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/reseal.js\":\"dca84101e5b9aa99\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runConversion.js\":\"a37ab15429d4ced1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runLock.js\":\"016a681d11b82853\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealing.js\":\"53b1568f6e54f07b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealingStage.js\":\"b066fdacd51ba998\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/stage.js\":\"ba9a7afcf0d63229\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/verifyReseal.js\":\"34a5fee645cb288a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aad.js\":\"4848b9c9e6f10c00\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aead.js\":\"026f107447abe711\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base32.js\":\"c824a3de720863e3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base64url.js\":\"c21cd1f5e6ebe475\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/binaryEnvelope.js\":\"b4a7688092d4822c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/byteAead.js\":\"032a59ff4508cd00\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/canary.js\":\"4d51ae2d9c6df612\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentHash.js\":\"5bd60c0d40529da4\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentKey.js\":\"af587dc47218e6cf\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/derivedIdNamespace.js\":\"07c1174967c2739f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/envelope.js\":\"fbb69c5b7bbfa305\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/hex.js\":\"c79fc687e9f9a944\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/sha256Hex.js\":\"60766cd587827f31\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/workspaceKey.js\":\"07d2fa99567fd146\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/conversionState.js\":\"cc9ea2130940cf9f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/createEncryptedWorkspace.js\":\"54115eb7d8ce6fcd\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/pastedKey.js\":\"e20b108449d26732\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c0d3ba2808764c9b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/upgradeWorkspacePin.js\":\"821eadc8b789488b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/keyStore.js\":\"6ce93772d5380547\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/mintWorkspaceKey.js\":\"5517abdfa78fe520\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/modePin.js\":\"a756c078532f7d68\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/openWorkspaceKeys.js\":\"0c8a2898f51f0be7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolveWorkspaceEntry.js\":\"da230b64906ca21a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolver.js\":\"145d8fca517168ed\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/workspaceAccess.js\":\"21a4e0844cd443bd\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/transform.js\":\"ffcc0b492927cf48\",\"/knowledge-medium/pr-preview/pr-1790/src/themeBootDefaults.js\":\"09a235d17bacdb12\",\"/knowledge-medium/pr-preview/pr-1790/src/types.js\":\"3739f9b0119eecbb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/ClientLocalSettings.js\":\"8c973b858c1cf48d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/abortableSleep.js\":\"aac923cdba240a57\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/array.js\":\"ea38206585f1fdfc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/backlinkAutocomplete.js\":\"0b04393318226a93\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockCrumbs.js\":\"9f626b1f453cb26e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockrefAutocomplete.js\":\"a7ecec70f8179160\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/cadencedIdleJob.js\":\"02e359f8f4d260f7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/callbackSet.js\":\"19723a99e15ccd28\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/clientId.js\":\"a0d48177f1816250\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirror.js\":\"772ad6635914f601\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirrorCompletion.js\":\"07feee16086bd920\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/copy.js\":\"1d354ff8af88362a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dailyPage.js\":\"24263fd9873f6f30\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensics.js\":\"984e8b3a50d4042d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensicsHooks.js\":\"213d1ee32c3233c2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/deleteBlockThroughUi.js\":\"cc6d2aad28f84ae3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dialogs.js\":\"106b3964e35bcd2a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dom.js\":\"7f0bb9a5760471c5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/downloadBlob.js\":\"2eece19207246378\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/exportSqliteDb.js\":\"52e5269b4a31ffc5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fileSystemAccess.js\":\"a19555bb498356b9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/flipSlide.js\":\"ece48318c112606b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fnv1a.js\":\"99356c40f1b9ab70\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/formatBytes.js\":\"b145ce2ffd312e54\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fuzzyRank.js\":\"667558586ff5d3fe\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idbKeyedStore.js\":\"a3064b0e095f0fa1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idleCallbackPolyfill.js\":\"eb7465ff52ae608f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardAwareScroll.js\":\"cfa831c7f6dda909\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardViewport.js\":\"785cfee15a2e9655\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/lastWorkspace.js\":\"a783af1f3342b073\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutColumns.js\":\"ad731c0f256e5393\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionDom.js\":\"a68f02c3bc99aac7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionId.js\":\"cf6040610ed17153\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkClickGestures.js\":\"e3777565d8aaad49\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkTargetAutocomplete.js\":\"2bcdfc926af42544\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbCorruption.js\":\"452ecd7bb540f954\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbRecovery.js\":\"f1aa327c0de2cf88\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/markdownParser.js\":\"cd975c436e5194e7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/memoize.js\":\"05b940dcc6a06dbd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameFieldCommit.js\":\"e8d5e311d0968cfa\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameList.js\":\"73a75eaf3f87eb31\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/navigation.js\":\"38c00a8453b13198\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/omnilinerNamespace.js\":\"452d32b04f986e87\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/opfsPageScan.js\":\"ed21d88319ce67ac\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelClearance.js\":\"b94d5b5b9fbd3820\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelHistory.js\":\"d60665f4d5238835\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLanes.js\":\"0043505e09af62c7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLayoutProjection.js\":\"7cbf57e5b32f988e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelScrollAnchor.js\":\"3d131710e080d2a6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelUrlFlags.js\":\"ef521eb51280aaec\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/platform.js\":\"0840176b781660e0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/pluralize.js\":\"9419ca4c9fe5e07e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyCreation.js\":\"72477f10ca3f9d6b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyNavigation.js\":\"c5f80ca4831d67cb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyValueContext.js\":\"fa223bc2b9580b0f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/react.js\":\"b4ea11aa83e5bf49\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeDate.js\":\"2fd402f16ccf850b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeTime.js\":\"fb186e821e65b750\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/renderScope.js\":\"80f44dd4390ce5b2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/resolvedThenable.js\":\"483f52ba2371a78b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/routing.js\":\"432f779a76d29527\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/safeMode.js\":\"7ba73d29157cd23d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/scheduleIdle.js\":\"f25f964d4201a8ef\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/screenWakeLock.js\":\"2892193252e0579c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/selection.js\":\"4221e5d44b6c74c5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/softKeyboardGrab.js\":\"4c0478c92fcaca2c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/startupTimeline.js\":\"019fbf2b4c159dbb\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/state.js\":\"09171288ed75920b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/string.js\":\"f5a0d83aeb87b344\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/surfaceZoom.js\":\"c366ecc61cebaec6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/time.js\":\"1940e737acd9896f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toast.js\":\"ca3201600657fad5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toggleStore.js\":\"37b0b70b72d4be4e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/untilStopped.js\":\"8712f18b15e2eaf2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/userActivity.js\":\"00b9d256f18f8430\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewTransition.js\":\"e8d8bf65d9760b9a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewport.js\":\"eacd34214c7582fd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/webLock.js\":\"5de43676e06c91bc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceRecovery.js\":\"f70b41ce00dd47e5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceSnapshotStore.js\":\"54e71361397e6209\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-compiler-runtime.js\":\"b0935702116874d8\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-client.js\":\"4e3778a1bb366c60\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server-edge.js\":\"6a37f56faee6b7ee\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server.js\":\"ca6111de73417c4f\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static-edge.js\":\"847c39ecab70bae5\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static.js\":\"35d196bbe374356b\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-test-utils.js\":\"d9a33025be5049bd\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom.js\":\"5154a62560df5c4c\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-runtime.js\":\"748904d409205bd3\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react.js\":\"217b9fee8eaf8a51\",\"/knowledge-medium/pr-preview/pr-1790/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
