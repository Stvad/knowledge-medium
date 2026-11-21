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
		buildId: "ad8d7d12f7b8-eacc2b9f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/\":\"6c4832525f4875c7\",\"/knowledge-medium/pr-preview/pr-1790/index.html\":\"6c4832525f4875c7\",\"/knowledge-medium/pr-preview/pr-1790/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1790/assets/FacadeVFS-Cbz06kB2.js\":\"74485875235893db\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSCoopSyncVFS-CUVNwzUr.js\":\"e0851b0ee1e1b671\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSWriteAheadVFS-3B0A1y4m.js\":\"bda9e01b694b4232\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-ktd0X-Hw.js\":\"0210f7d865f204c3\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-hQQbA2y8.js\":\"89ab406fe54e76b8\",\"/knowledge-medium/pr-preview/pr-1790/assets/worker--0zFX5-A.js\":\"d900c6d783ab594c\",\"/knowledge-medium/pr-preview/pr-1790/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1790/chunks/app-DYrnuTOU.js\":\"c454480883ce1728\",\"/knowledge-medium/pr-preview/pr-1790/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1790/index.js\":\"9f5ef1b5bb33e034\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1790/assets/AccessHandlePoolVFS-gsTi_WFb.js\":\"b665fa33c58c6af9\",\"/knowledge-medium/pr-preview/pr-1790/assets/IDBBatchAtomicVFS-dQYMcIHE.js\":\"c912dab8e9d130e9\",\"/knowledge-medium/pr-preview/pr-1790/assets/MemoryVFS--Q_GuuQF.js\":\"9c9014025853b9bd\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-D6OQyPL_.js\":\"108b39bf1f438432\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-D5Vpv8RX.js\":\"ae93362cb200092c\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1790/chunks/AccessHandlePoolVFS-DBJL4Wvg.js\":\"c87ad5e1efcf3e2e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/FacadeVFS-Bu4xxvxK.js\":\"fdd14335893feca7\",\"/knowledge-medium/pr-preview/pr-1790/chunks/IDBBatchAtomicVFS-BpjLp1Mz.js\":\"dc82a988c99158f0\",\"/knowledge-medium/pr-preview/pr-1790/chunks/MemoryVFS-WyuLVEbc.js\":\"54aac67c757042b3\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSCoopSyncVFS-DPaWeFOs.js\":\"8690ee01a51a80c7\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSWriteAheadVFS-zEGK7B1W.js\":\"1c6dcdc38ef99b96\",\"/knowledge-medium/pr-preview/pr-1790/chunks/Preview-CmPe38qU.js\":\"9eb27e42764a353b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/card-BWHGjWaT.js\":\"2675eec5ba7411da\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-j4MeHrCJ.js\":\"4e00cad56bb1d605\",\"/knowledge-medium/pr-preview/pr-1790/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-DjZHvn0K.js\":\"9ff586e15f0095f1\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-async-D6txpUFE.js\":\"adfe25c6f0b68367\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-B6VS-9kG.js\":\"a04260c7d64ba8ea\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-BvM5wm5A.js\":\"7c018af4560ce7d3\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-ClW0eeoi.js\":\"e5aea15a2bf80905\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-Cu975Ob_.js\":\"7e4f39d1fbaafe17\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-Cwg9Weg6.js\":\"a42a1a1b52fd75ca\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-DJ21g_br.js\":\"efc26042dae1c352\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-DnWGWvZE.js\":\"fd3abb88f9957b5c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server-legacy.browser.production-CAtoWPYJ.js\":\"ee67383b43fcd85f\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.browser.production-DZ2xIEN4.js\":\"3a5276ea6bb2a4ed\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.edge.production-wupS5S7T.js\":\"c89c3d5942026d2f\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-hHTPxVNm.js\":\"d904640a0f07ef50\",\"/knowledge-medium/pr-preview/pr-1790/chunks/server.browser-BiiUY4ch.js\":\"a5f65ae6ec0ac310\",\"/knowledge-medium/pr-preview/pr-1790/chunks/textarea-BLTsC459.js\":\"1e962152e2a2d77b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/ui-CZiFfgWK.js\":\"51db59aad0a94174\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-Cw0QXI3_.js\":\"6bfb45abd330d337\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-async-B1GzTLn2.js\":\"9814a68e4ef205ef\",\"/knowledge-medium/pr-preview/pr-1790/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1790/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/src/App.js\":\"90f70c3aa601eecc\",\"/knowledge-medium/pr-preview/pr-1790/src/appUpdate.js\":\"c7ae186f08238cd6\",\"/knowledge-medium/pr-preview/pr-1790/src/appVersion.js\":\"9dc777767251450c\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/initialLayout.js\":\"7d039814b4e2d4d0\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/openWorkspaceData.js\":\"90c3f1433fac011e\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/resolveWorkspace.js\":\"8462b9e991aa2f12\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/workspaceBootstrap.js\":\"aa25e8345517483c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockComponent.js\":\"1b8eaee1f73d44bc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockCrumbs.js\":\"e377ab75b84c9827\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockEditor.js\":\"3e7e4eaf44d11ee2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockLoadingPlaceholder.js\":\"51be10c0dd34dc32\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockProperties.js\":\"b5c5e6e45cc476a6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockSearchPicker.js\":\"520e25d6ff0f44de\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ConfirmBulkDeleteDialog.js\":\"0ea438218020884a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DividerHandle.js\":\"7db5c18fdfde1162\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DraftEditor.js\":\"da25a3309b142a86\",\"/knowledge-medium/pr-preview/pr-1790/src/components/GutterPill.js\":\"4fcd3ca57e9eae08\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Header.js\":\"90018f1e4a1038d3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/LazyBlockComponent.js\":\"621d9817791a2729\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Login.js\":\"61beae431631130b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ZoomableSurface.js\":\"417be1a216e941a1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/editModeKeepalive.js\":\"b2e1588f188bd0c6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d967e4e11a11293d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5ccebd9906539f79\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefPropertyEditor.js\":\"836916fea517f3c4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefTargetTypePicker.js\":\"82fa82ade6d4c263\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/SelectPropertyEditor.js\":\"4466b8aa7660ba3a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/TypesPropertyEditor.js\":\"24b54f2bf38184b0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/defaults.js\":\"ca3f56cc1fcd479f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/kernelValuePresets.js\":\"5f76be0b39beea0e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/selectablePresets.js\":\"f264f0764bcb2344\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/typesPropertyUi.js\":\"cc3175a0a5152b12\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/AddPropertyForm.js\":\"ad3e1131f4dd0dcc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyPicker.js\":\"e9caf8cf256c0a2b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyRow.js\":\"fc7de752b49bdeb4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/Rows.js\":\"82bc8f2d409cc0fd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/actions.js\":\"fe293621339272da\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/declarationOnly.js\":\"82ecbc821da0d9c0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/layout.js\":\"1cc60fc05669e190\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/model.js\":\"f439902bc8149794\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapeUi.js\":\"3bcbbbe1b5801b00\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapes.js\":\"dcd7b3eb89082011\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1f2358efa300f3dd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/visibility.js\":\"f868f8909416ff46\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanelSections.js\":\"01a7e0201cf77808\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockEmbed.js\":\"f472d4dfe6cd93c0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockLink.js\":\"945a00713af9eb1b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockRef.js\":\"f9603ec4b5c2f620\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/ReferenceLink.js\":\"d57a63d2c70f914f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuard.js\":\"00e7eba666841590\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuardContext.js\":\"2b0d22495ebaec70\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/linkInteraction.js\":\"c058b6bdade838d7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/referenceLayout.js\":\"e62905174440210e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/useBlockRefAncestors.js\":\"d0f0fbd3279ed6bf\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockGutter.js\":\"2d2ad278c98096e2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockInfoDialog.js\":\"e3e6835e6dad20a9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockTypeBlockRenderer.js\":\"8af56c264cb3275f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BulletHoverCard.js\":\"8b659bfbed964887\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorContentRenderer.js\":\"d3d8c223a0270b34\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c1c16e413432420d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ColumnResizeHandles.js\":\"537a0c0c265c0c4b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6510f6b518b4acb6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/DefaultBlockRenderer.js\":\"eb06e0520b03c910\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/LayoutRenderer.js\":\"776a91834a8a2578\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MarkdownContentRenderer.js\":\"b0b67f9c90ead6fe\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MissingDataRenderer.js\":\"02efdf0d1ed332c8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PanelRenderer.js\":\"b9a194ddcf941e93\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PropertySchemaBlockRenderer.js\":\"22991d5eae8e1d5c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/TopLevelRenderer.js\":\"748a12ba865f3c7a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockGutterMode.js\":\"b5c300f5a99d10c4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockTitleText.js\":\"5bec597dd9273023\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/fieldCreationKeydown.js\":\"cd8e485042689b2c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/layoutRootContext.js\":\"6b4a6a3820d2030c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/TypeChip.js\":\"cb8d114eb88bfafc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/chipStyle.js\":\"24de99cce85fd412\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/anchored-floating.js\":\"7be2e4bd279a6e87\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/button.js\":\"cce1a9547d69f9d0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/card.js\":\"3f0c40a78fee0f30\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/checkbox.js\":\"04709ce8ce568e2a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/collapsible.js\":\"7cc26e142b6244f4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/command.js\":\"ab23b80926ac2841\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/context-menu.js\":\"ca0f7b8317ab9f6c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dialog.js\":\"6bf130ec0861275d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dropdown-menu.js\":\"d82259c132bf8fb3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/floating-listbox.js\":\"6acad28dff741fbe\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/index.js\":\"a257e28994b7f8c1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/input.js\":\"797af1a0bfc97f2f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/kbd.js\":\"0c4e55c7b368a30f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/label.js\":\"bcdbf86621295640\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/textarea.js\":\"8ada46408da83cd4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/useEditModeYieldKeepalive.js\":\"1dc4231c1398842e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/BootFallback.js\":\"b01dd7ec5b7cb30d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/FocusedRowLazyMount.js\":\"89fe51e27dbf0c1c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LazyViewportMount.js\":\"9fba6479541d2cee\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LocalDbCorruptionFallback.js\":\"d45ce4647b69cf55\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/error.js\":\"16413755ff7dc1ae\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/lazyMountRegistry.js\":\"d2ce027423400903\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/suspense.js\":\"5905114b01b94089\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/CreateWorkspaceDialog.js\":\"2eb2eab436f5fc2d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/PendingInvitations.js\":\"2cefa529a66a49bb\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/SyncProgress.js\":\"831b154bb7ef27ca\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/UnlockProgress.js\":\"d3ac73c52a0e5d19\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceKeyGate.js\":\"56ceb51b1e94fd2c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSettingsDialog.js\":\"cf8c7f57b5857da8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSwitcher.js\":\"c1708834dfbfbc43\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSyncGate.js\":\"89d4b45af58dbcd1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlow.js\":\"9049f9eb33636aa1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlowHost.js\":\"fddc6373d252c801\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/EncryptionSection.js\":\"ecc01d53eed55950\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/attachmentPrompts.js\":\"4d27e09a99ef9e0d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ffe03333ffd961e3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowDeps.js\":\"1eba113d43632e99\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowStore.js\":\"76dc14ea631341a4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/flowUi.js\":\"70b812eac5394416\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/useConversionRun.js\":\"33f3dcf0b01e4bbd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/keyUi.js\":\"d878c63a1ff30d7d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnKeyLoss.js\":\"7793ee20d85de382\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnServerE2ee.js\":\"0c533d81930c4d65\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/workspaceUnlocked.js\":\"dcc383aac10b4724\",\"/knowledge-medium/pr-preview/pr-1790/src/context/backgroundSubtree.js\":\"f5dba7d0b370bb0b\",\"/knowledge-medium/pr-preview/pr-1790/src/context/block.js\":\"a0e089d7eb74656e\",\"/knowledge-medium/pr-preview/pr-1790/src/context/layoutWsContext.js\":\"aa14fb9c51b8ffa6\",\"/knowledge-medium/pr-preview/pr-1790/src/context/propertyDisplay.js\":\"3729d7844e6f6817\",\"/knowledge-medium/pr-preview/pr-1790/src/context/repo.js\":\"4590c18a8880a26c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasClaim.js\":\"178e1de55a608c64\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasSeatNamespace.js\":\"024a5eb95f46d586\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockData.js\":\"f8dee4a1218381b5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockType.js\":\"22d07d565d21a72e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/changeScope.js\":\"3187129a622093c1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/codecs.js\":\"438d2c5fa2373b1f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/derivedData.js\":\"40312367149770ea\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/errors.js\":\"15a6e1ab5898055c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/events.js\":\"d87fe51cb9a7759e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/handle.js\":\"63412a309f0fc5ae\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/index.js\":\"da1716afbfde6e67\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/mutator.js\":\"f780c65e415bc744\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/processor.js\":\"342cfa19e42737df\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/propertySchema.js\":\"c992af1a939cf427\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/query.js\":\"1a4e9e69fcc62cd8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/sameTxProcessor.js\":\"1a8df9e80ab77113\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/schema.js\":\"63412a309f0fc5ae\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/tx.js\":\"63412a309f0fc5ae\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/typedBlockQuery.js\":\"974f682e302c71e8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/user.js\":\"f7b71571ffcef3be\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresetCore.js\":\"7bb943d36c6abcb4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresets.js\":\"5a74746fe27f539f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/attachmentCleanerIOVerb.js\":\"4232948a7c02e0dc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/block.js\":\"9b916b6c44b0c373\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockCache.js\":\"5734875ed9027d42\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockId.js\":\"448a7b668e360d13\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockLiveness.js\":\"64a8554c0cee4507\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockMerge.js\":\"a433d830b4f79a51\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockSchema.js\":\"b8c9c1028a372497\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockTypes.js\":\"8ae6ca5639644287\",\"/knowledge-medium/pr-preview/pr-1790/src/data/clientContext.js\":\"2d3fd13ad0a52de6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/dbFileSiblings.js\":\"c1cd94025368536b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/definitionSeeds.js\":\"6e192f930d30e54b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/derivedIds.js\":\"216f05503353c904\",\"/knowledge-medium/pr-preview/pr-1790/src/data/drawnSubtree.js\":\"f0179823315e4032\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facetBridge.js\":\"fd20b74e9e86a171\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facets.js\":\"b90f3841d39f3ef6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/globalState.js\":\"3a91e5605af411af\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/aliasClaimRederiveProcessor.js\":\"d08b938ad166b560\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/ancestorBatch.js\":\"fa5b9da7a1bcc0f9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/blockTypeTypeifyProcessor.js\":\"4683c94b7d798b2b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/clientSchema.js\":\"424ff7934fb4bb07\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/commitPipeline.js\":\"6c656f1fa1455573\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/devAssertions.js\":\"ff795203d93832e9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/firstSync.js\":\"0abc8abe44149f2f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/freshInitialLoad.js\":\"1a8b0548f412017b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/graphBackfillClaim.js\":\"7db0a760d5ba3d9e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/handleStore.js\":\"546aac725570e114\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/idleMarkerJobs.js\":\"a66fff4138ee39d3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initialDownload.js\":\"5c6d579df7b526e9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initializeClientDatabase.js\":\"ca236960985beb64\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/jsonCanonical.js\":\"2aee5c85e54eb58d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelInvalidation.js\":\"2420aaf51bb9c9f1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelProcessors.js\":\"23dadb8435ecd868\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelQueries.js\":\"7e4190e357f0eb6c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/mergeTypeMembershipProcessor.js\":\"c8c27a7b584c223b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/normalizeReferencesProcessor.js\":\"45ce97e4bd114e30\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/poolInstrumentation.js\":\"b00d7ad2028c8653\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/processorRunner.js\":\"bf589d01098c5b0a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyCellBackfill.js\":\"8ceb44627849dced\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildMint.js\":\"370cd6a555d9e626\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildrenProcessor.js\":\"ff7381038f2afd9d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionChangeProcessor.js\":\"91566e02d5d6d76e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionSynthesis.js\":\"439f1bd3752bd17b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyKeyScan.js\":\"62b700eaf6d9dc85\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertySchemaResolution.js\":\"662229a6db27936f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/raiseProtocol.js\":\"da20fd5cac79dd8f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/readBatch.js\":\"29b3d85a5899db3c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/refProjection.js\":\"53ee39ef96a0936a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetLookups.js\":\"1b2b467db5f00b72\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetProcessor.js\":\"89dc9627c24fd5c3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/replayMerge.js\":\"8cc24cf4d8d41845\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/sqlBinds.js\":\"defaa58fdfff85e1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b3ddc1a41acb6dcf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/arrivalProcessors.js\":\"c29f999d0b0d2f68\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/invalidate.js\":\"9d5f3f52fac5a733\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/materialize.js\":\"685b7a1f8a39be9d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/observer.js\":\"4e0c0760923be85b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/reconcile.js\":\"e0dde6218ae3908c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/timingMetrics.js\":\"3da8aac86c1d4da4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/treeQueries.js\":\"5d8dc191e60e1518\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txEngine.js\":\"95477c44b743757b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txSnapshots.js\":\"9e8a1f5ab0d32cb6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/typedBlockQuery.js\":\"4b75f69dca80d15d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/undoManager.js\":\"3fa281b5ae15b2d6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/invalidation.js\":\"5fd00889568141cb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelDataExtension.js\":\"f0bdc01fbe5a9fcf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelPage.js\":\"d027d9600f7a76ca\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelValuePresetCores.js\":\"3eaf66a0a1f6b994\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbCorruptionSignal.js\":\"1105dec2a0dd7bed\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbStorage.js\":\"cbbc9203144fd24b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbVfs.js\":\"6d9eb5b93e2e8512\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localSchema.js\":\"963b303ae42eb0d9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/maintenance.js\":\"ae31175bfcf6d8a8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mergeProperties.js\":\"6d4dbbf0eb677103\",\"/knowledge-medium/pr-preview/pr-1790/src/data/metricsConsoleHook.js\":\"72c26d85b837f07f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/migrationsPage.js\":\"80f383365e8516d4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mutators.js\":\"afd974d283484830\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKey.js\":\"928b38c7ca14b4c9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKeyPlacement.js\":\"6a7cf3c1b1cd28cc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/outlineSurface.js\":\"595eeafda76c944e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingEditorContent.js\":\"521625879d3f700f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingUploadsSql.js\":\"c48ad027344552b7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pluginStateExtensions.js\":\"85163833e561f467\",\"/knowledge-medium/pr-preview/pr-1790/src/data/powerSyncLogger.js\":\"3c2ec59748af24c9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/projectorRuntime.js\":\"3abf880c269cac39\",\"/knowledge-medium/pr-preview/pr-1790/src/data/properties.js\":\"fc1ac713b2223467\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertiesPage.js\":\"21f763b8f86cca9f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyChildren.js\":\"9f767ff0361abcdf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionFanout.js\":\"17a3b463e76a8dfb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionMetadata.js\":\"13a6fda46a523065\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionRegistry.js\":\"87e164d17b26b575\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDisplayMode.js\":\"adf313d3e1f19b5e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyRowCreation.js\":\"668b35947f8cc5ea\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySchemaCreation.js\":\"4c637bdd7501a963\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySeeds.js\":\"448fec7a7d1c3a71\",\"/knowledge-medium/pr-preview/pr-1790/src/data/recentsPage.js\":\"01131df2f83f8539\",\"/knowledge-medium/pr-preview/pr-1790/src/data/referenceBlock.js\":\"570877afddf93ab8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/releasePowerSyncConnection.js\":\"ee636fe799f7edf8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repo.js\":\"492a991d40e6c282\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repoProvider.js\":\"e1014624237636c9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/rowProperty.js\":\"e46862602d59a789\",\"/knowledge-medium/pr-preview/pr-1790/src/data/searchFilter.js\":\"0554b591fe0aedb9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/seedIdentityLedger.js\":\"f8f4cd876d946662\",\"/knowledge-medium/pr-preview/pr-1790/src/data/stateBlocks.js\":\"98156852b2646ec4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/structuralEditPolicy.js\":\"120a147c42e16272\",\"/knowledge-medium/pr-preview/pr-1790/src/data/subtreeDelete.js\":\"f0c7ebf96b00fc50\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncStreamLock.js\":\"795fdee8b561544e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableSqlRecognizer.js\":\"77b3c2ce315fe377\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableWriteGuard.js\":\"d3d2ac93209a8077\",\"/knowledge-medium/pr-preview/pr-1790/src/data/targets.js\":\"4e6e9522c7cc82b2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeColors.js\":\"cbdb1b5611130196\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionMetadata.js\":\"9cb8939bedb0a1a9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionRegistry.js\":\"f76112d629fe24aa\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeExtraction.js\":\"8ac0065335e4a8f6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeInitialValues.js\":\"801c6c36ad05a4d7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typePropertyGroups.js\":\"9840b04a3cfcfd13\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeSeeds.js\":\"1dff480fb009f641\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeTagger.js\":\"fb5679a05221043a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typedRecords.js\":\"7fd810f6644bb82d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typesPage.js\":\"fe3a1dfb2261516d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userPrefs.js\":\"30a508747756de7b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userSchemasService.js\":\"7b19ea30f8bfee7d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userTypesService.js\":\"8349f8fd1c4470e4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/valuePresetRegistry.js\":\"181789207e3fea39\",\"/knowledge-medium/pr-preview/pr-1790/src/data/visibleChildren.js\":\"af96361cea67ace2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceConversion.js\":\"f2e82fa6a8578e6c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceFirstSync.js\":\"867793a0db41755c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceIdNamespace.js\":\"fc665fd3c356b76e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceSchema.js\":\"b894c3d90eccd63e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaces.js\":\"1aac7a311e4ee74a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadLog.js\":\"efb6b31264d148d0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/BlockPasteShellDecorator.js\":\"b1d9430b12dc8db6\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/atTrigger.js\":\"302a2db55bfea016\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/autocomplete.js\":\"0cb732759b3f86ba\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/codeMirrorExtensions.js\":\"697c3c13e5cba73d\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/contentFlush.js\":\"f9ace308d731d29c\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/defaultInteractions.js\":\"b3d90ec413553f4f\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/editSettleSignal.js\":\"d0ae511c75371c35\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/insertImage.js\":\"634ee4aa42875038\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceCompletionRange.js\":\"b2566953ad6bc171\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceTargetTypes.js\":\"769d259f1d6972d5\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/syntaxContext.js\":\"f8541e6a0ab6e8b2\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/triggerMatch.js\":\"ba41d5dcf85539dd\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/AppRuntimeProvider.js\":\"07dda99f17d012e2\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/BlockFocusShellDecorator.js\":\"66de2f52cc56c3b4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/ExtensionRenderBoundary.js\":\"323249bee48fedc6\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/PanelContentRecovery.js\":\"629649ac3dbebacb\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/apiCatalog.js\":\"0d6bc335df3ef171\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/approveExtensionHere.js\":\"9b6d6eba1eacc5ad\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/armedCutAppMount.js\":\"20257a9b5c7e71ec\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/batchableKeyedStore.js\":\"d8155c31d696222d\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockInteraction.js\":\"84a728b730141f68\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockSelectionAction.js\":\"d710ba6bc2b8595b\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compileExtensionModule.js\":\"9719b8620a3dbdd4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compiledModuleCache.js\":\"0edece154c5de9a4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/continuousGestures.js\":\"63c5afbdcf35dba1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/core.js\":\"9dbd192d0a423017\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/defaultRenderers.js\":\"783b8901cebba6e1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/definitionFanoutAppMount.js\":\"1acce84260f2cbb6\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dialogAppMount.js\":\"1855fe0db57bd202\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensionSeeds.js\":\"de29d6a5dc63fce0\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensions.js\":\"06704effa4b13515\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/exampleExtensions.js\":\"b122b52f2b6fd444\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionApprovalStatus.js\":\"b099bc6c670e89b1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrorToast.js\":\"d557efbed1d186fe\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrors.js\":\"f36579af3d08ace2\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLookup.js\":\"ffea98cb7833c4c3\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionToggles.js\":\"ce1e0cf3ffe36def\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionUtilitiesCss.js\":\"1d645cba3f9394ca\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/kernelPageDeletionGuard.js\":\"d1876820e81c2f34\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/liveRuntime.js\":\"3f36f3c861ed65bb\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/openExtensionsSettings.js\":\"875f822d9b51d63b\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/overridesCache.js\":\"8dd40100f30b1bde\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/pluginIds.js\":\"3024b012e32cdd0c\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/processorRejectionToast.js\":\"8e51bc639d41a140\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeActions.js\":\"13433e238016ecbd\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeContext.js\":\"e28c1716d8cd5f14\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticAppExtensions.js\":\"6fa251ca0b385b3d\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticDataExtensions.js\":\"375d1f9deeceec5f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/toastAppMount.js\":\"039a000146ed7f92\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useOverrides.js\":\"af1491a7e4534e0a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useShortcutSurfaceActivations.js\":\"adadb6954c1baad3\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/discoverToggleTree.js\":\"44d1c903c20ff100\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/facet.js\":\"87b2311e390bda12\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/resolveAppRuntime.js\":\"fd01729fc12bf67a\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/runtimeEvents.js\":\"eb6112e6fe70e429\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/togglable.js\":\"da6930cb88d46f74\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/variantFacet.js\":\"f4ea694489e02406\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/verbFacet.js\":\"c13f75844e7ff220\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/block.js\":\"34411d8f4ef551ad\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/focusedChild.js\":\"4f460e462b649e64\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/propertySchemas.js\":\"e00e01c3b675c4e3\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/typeRegistry.js\":\"d31652ba205e6900\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAncestorCrumbs.js\":\"418401a14a972d3e\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAutocompleteListbox.js\":\"5e33e87835951530\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedSearch.js\":\"4295695e3e82b439\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedValue.js\":\"e3737435914c9054\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsFocalRender.js\":\"9f72f2bcfadc2e99\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsReadOnly.js\":\"9efac34f08482f16\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMaterializeBacklog.js\":\"370cf249dc4d0aa5\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMinuteClock.js\":\"3b00d83dd497ba94\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePanelLayoutProjection.js\":\"7f71a2f54ca91c7c\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePendingInvitations.js\":\"8f9d2fe261660e15\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRendererRegistry.js\":\"3664368cabdf9a57\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRetainedFieldRows.js\":\"76cf351dde219a36\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useWorkspaces.js\":\"6b1f7f7e358a91d5\",\"/knowledge-medium/pr-preview/pr-1790/src/lib/utils.js\":\"e39473c544ae2b3e\",\"/knowledge-medium/pr-preview/pr-1790/src/main.js\":\"98a656af18c8390d\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/MarkdownImage.js\":\"4cb8df4866b0bfdd\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/blockSeparators.js\":\"1f4124ffe6511496\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/context.js\":\"6a378900875ea995\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/defaultMarkdownExtension.js\":\"e7edf2dc249e1145\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/extensions.js\":\"c9b2e0292cdbfdc0\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/renderMarkdownHtml.js\":\"f98b8ee6ae49a06f\",\"/knowledge-medium/pr-preview/pr-1790/src/minimal-editor.js\":\"4129382d0304f3cf\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/armedCut.js\":\"499932657ee85dc8\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/captureMediaVerb.js\":\"2c74e08935625a75\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/clipboard.js\":\"e862bf97cf09281c\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/decision.js\":\"517f91324915b2b1\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/operations.js\":\"4fa6701a0f56965b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/AccountHeaderItem.js\":\"3226ddf7d8d3e666\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/index.js\":\"9d5a39ac745eb8c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5b2fff8819d19107\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askAgent.js\":\"caed27dc8f49862a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askedStore.js\":\"8597b42ad0617a09\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6c0c897498cdf783\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/chipState.js\":\"31a3e0b4dc831b67\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9345149c846bcb71\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/index.js\":\"e81239246220a53a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5741fe08f634394f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/schema.js\":\"ccb9cc56e2d9e467\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7da41159100d09f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ad5dc2c78639944b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/addMedia.js\":\"0ab2d731d515ab12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d1c7a92618d68701\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/block.js\":\"7851fea7ae937add\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/context.js\":\"d921b8069aa5b7f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e353e00a16890210\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/index.js\":\"b95eba0a5390fe80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/outline.js\":\"a3de19cd2858f4b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/properties.js\":\"990029aca4f9a86e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/refs.js\":\"bd8614d59af9c682\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"282bb95a9f8be12d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/search.js\":\"1e81cddb193b39d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/shared.js\":\"6ea2c82d787941b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3a2008d99a77ffcc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/text.js\":\"5a843a73050b8897\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentWrites.js\":\"7b2e309e8b1a4a54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/authoringCatalog.js\":\"990f641232babe89\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/blockRefTargets.js\":\"bfb0acaa31b9698e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridge.js\":\"0068032bbda9e640\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridgeLoop.js\":\"0ed767a195bc2519\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/changeHistory.js\":\"6a745e049fdef733\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commands.js\":\"ede13684a9ba16ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commentsCommands.js\":\"1b0cd246be39a22f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataExtension.js\":\"71354e86d1479459\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataModelGuide.js\":\"3a7700660d885029\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/describeRuntime.js\":\"3c35aac782fc294c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/extensionLint.js\":\"9e9d3cce2edbb46f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/grainAudit.js\":\"386bacae3286e242\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/healthCommand.js\":\"130534a24c2d2e4e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/index.js\":\"7f7b67b80dc68ef4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/presetIdentity.js\":\"8c3d58b2e7504120\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0395c94755cc133d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/readMedia.js\":\"1d531a76230f9725\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/schema.js\":\"2869eb537633f063\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/serialization.js\":\"94cb5a4ace290580\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/targets.js\":\"94788eb5cc9ffc01\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/tokens.js\":\"95a6a6ec79a8f16c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/watchEvents.js\":\"e388334d5f5c9ae4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/workspaceGuard.js\":\"0880953c6ce6d5f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/writeCommands.js\":\"6f184e91d575c962\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/AliasCollisionToast.js\":\"60badeec37f6b6f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/DuplicateNameBanner.js\":\"4662f1d63957b0af\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/collisionMerge.js\":\"6ba895e816b25556\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/dataExtension.js\":\"1adb465937ac1239\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/index.js\":\"4d3bd4484ae8b16b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/mergeCollisionAction.js\":\"2994d72534a247ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/pageStyling.js\":\"1c16a43261c5a1ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/rejectionToast.js\":\"5fd2242d95e22ee0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/syncProcessor.js\":\"9bda2d378f36d988\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/actions.js\":\"2b3b8a70f5572816\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/addComment.js\":\"b9e999beae3f3958\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchor.js\":\"2fc770133d24fec0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchorState.js\":\"dbf6d4ddc3dc1002\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/commentLinks.js\":\"ceb9ed462220bc18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/confirmThreadDeletion.js\":\"f43b0c695ee0dbb5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/container.js\":\"9dbdf05df1c77b51\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/dataExtension.js\":\"660ef6138c1c5c48\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/deleteComment.js\":\"a97be2c23b7a7991\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/highlights.js\":\"e7f1ce893d0f9065\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/index.js\":\"a23981820d1cb338\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/linkedCommentsPill.js\":\"5360bd34447cb8ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/margin.js\":\"f76c7b319fb57b9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/marginSchema.js\":\"e0782951f708eac2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/newComment.js\":\"e6d248780942775d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ownThreadPicker.js\":\"f7afc2e726285852\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/placement.js\":\"e657d3cc7dfec022\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/queries.js\":\"c8b04fd32ef259fa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotePosition.js\":\"390ce0f542488395\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedIn.js\":\"d9de92a30a2e0d91\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedRange.js\":\"21bd881ced22ca27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/rangeRefs.js\":\"1bfc4f4153b8e056\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readHighlights.js\":\"877e207dcaba42a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelection.js\":\"f467831fa1a607a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelectionUi.js\":\"ca5924f871bbe299\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/reanchor.js\":\"ed787455cdf3f7bd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/schema.js\":\"e4420c9798df21ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scope.js\":\"fd63f264e6189e52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scopeThreads.js\":\"916801b800c5168c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/splitRetarget.js\":\"702959c3984f4626\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestionCard.js\":\"af29a57e1251c153\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestions.js\":\"98fca6bae7eceb66\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaries.js\":\"301bafb75feb24d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaryBatch.js\":\"0d8886146c1c5964\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/surface.js\":\"3dbca1a791f04b34\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threadNavigation.js\":\"357290837d695316\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threads.js\":\"79afa435b9089307\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ui.js\":\"ab15d8859548c812\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/uiStore.js\":\"38b86eb593676a6b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/appIntents.js\":\"676bbfe55ae3edeb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/index.js\":\"86e057688de95dc9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/index.js\":\"d924cd33dcba5431\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/status.js\":\"0f79148dcb93ccc8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"bb6a21289ad92cf2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaBlockRenderer.js\":\"19d7fe70cff2f191\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaDownLaneReplicator.js\":\"34c4f3ccafcf2658\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaUploadReconciler.js\":\"3d69086c3adb2256\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetDownLane.js\":\"099906a0aba04536\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetResolver.js\":\"d358fe75e2c4ed9d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetUpload.js\":\"cdcf36c09ba325be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/attachmentCleanerIO.js\":\"45e31bb937e05828\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b67d6efedc33e270\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/blobStore.js\":\"d5a2a06ce68bd882\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/byteStore.js\":\"7ea9f20ae6c7c103\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanerIO.js\":\"b9376b7aa8032541\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanupAttachments.js\":\"fd60839673cdd823\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/dataExtension.js\":\"48b0b982ef56e809\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/downLane.js\":\"b041e6e6e7e8f699\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/index.js\":\"684053ab9bc2bf2a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/insertImageContribution.js\":\"e0ffe513f0dc28a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneArming.js\":\"ef28485c3b0ddcc6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneLock.js\":\"2aa07cf07ed09e17\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaBlock.js\":\"fbb1b93376a18a84\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaCapture.js\":\"81efa99dfd5d1903\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewers.js\":\"c57bd3c7901856eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewersFacet.js\":\"fac87461caa7c63d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/pasteCapture.js\":\"2c4981b160a1d316\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/resolver.js\":\"53ef39a004e26089\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/retryUploadsAction.js\":\"0c512dd7b5def349\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/storagePaths.js\":\"fc07b64ddbaaa449\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadDrain.js\":\"4b9b9b2157f7a06f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadLaneStatus.js\":\"d90656f511cc6f14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadReconcile.js\":\"081a8a23f2116b68\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadRecovery.js\":\"6e9af282f3af54b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadStore.js\":\"fc7ca216d4dbb69e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/useAssetObjectUrl.js\":\"27630f66638c86b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c1d466e8c1698828\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksViewSection.js\":\"4cc7197b1beaf661\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/facet.js\":\"6da79f615a07d3ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/index.js\":\"a782bed2dd0c0837\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/prop.js\":\"b88a43f1f43ff9d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinkFilters.js\":\"f9d82d49dbe107c2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8c0448cf38e7252a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BlockEntry.js\":\"594007fee46ca232\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/LinkedReferences.js\":\"ce92ccdb4262be4a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cc6dc1a8c74889eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dailyNoteDefaults.js\":\"a67bcb398eba8769\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dataExtension.js\":\"327439f98babfb8c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/edgeExclusions.js\":\"c7c39b956e48c05d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/filterProperty.js\":\"86ee659196766aa8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/index.js\":\"3ab31cbcabad2b4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c50ff50ca39c123b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/applies.js\":\"492376e8bd83e2fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/countQuery.js\":\"966e2b1f6723528b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/expansionStore.js\":\"47d6acd2cd495f83\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/index.js\":\"f1ad76157df1de36\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"be05b2417962d032\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/presentationInvalidation.js\":\"4046a740208893b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyEditorOverride.js\":\"abcdc856f13f34f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyFilter.js\":\"82e9d07fc28068f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/query.js\":\"68deddd472a59163\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/resolveFilter.js\":\"98cb07e94646f3ba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sourceBatch.js\":\"2d7674055be18e3b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sources.js\":\"fd96e3ac7b45b1a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useBacklinks.js\":\"e8ccb7a1be0f5350\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"745d82c7250ce3cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayCelebration.js\":\"4da33acebbd4e546\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayOverlay.js\":\"1041dd2e889dd04a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/gate.js\":\"4f75825b9fb6bd12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/index.js\":\"8465b0bc7651d4fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/wolfTheme.js\":\"476de09508cb3029\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/BlockDragLayer.js\":\"596112908ed18687\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dragController.js\":\"7506ddf8c4737952\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dropTarget.js\":\"36f4fe4d0ace46d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/index.js\":\"fa47b41fd09bb08b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/projection.js\":\"95cc185747e92b16\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/BlockMetaCard.js\":\"97c87445bdaa7e8d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/index.js\":\"6a79ad930643be44\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/AddTagDialog.js\":\"50d16f15134c2392\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"48f9459958f0b9ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/TagNameIssueHint.js\":\"11d1ce84b68adb86\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/addTagAction.js\":\"56863d7a0a5ccae6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/appendTag.js\":\"47e1a098d44e14d8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/config.js\":\"56986ce6f0ac19cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/dataExtension.js\":\"91441d725a6b7fcb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/index.js\":\"078c2c44a2040f41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/propertyEditorOverride.js\":\"d27582697858664a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f7b4eb9310d926be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a0e5bcd02e1f36a9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/Breadcrumbs.js\":\"73f63e8cc541eb4d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"096cea23d8841ebb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4eae130c6912ca7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/index.js\":\"2fcbd75a26d9ad59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7af079acd0e0b830\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/CharacterCountItem.js\":\"ce7b59b64be995a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fe8cd6520a724074\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/actions.js\":\"34404b4675be3be1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/blockType.js\":\"76fbd4c348c5fdba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/charCount.js\":\"9173abcdb29380f6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/dataExtension.js\":\"4533ccc014f80d86\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/index.js\":\"dd5ad1bf88c23c4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/profiles.js\":\"258361573b754ae7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/properties.js\":\"6ecef374b389b686\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/textCounts.js\":\"378df8963865eab4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/colemak-keybindings/index.js\":\"35ab434c19bba9e0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/CommandPalette.js\":\"8211ebd356d493a5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/HeaderItem.js\":\"fce2597e99da883d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/context.js\":\"4bcb714496db87ff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/index.js\":\"fd43130afdf2ad81\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/selection.js\":\"3ecac32e0914a411\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/toggleStore.js\":\"2da1ae8e561e0f39\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/useCommandPaletteActions.js\":\"dbc9c637f67a469a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/ContributorBadges.js\":\"37a5eff8be123221\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/author.js\":\"22c642dcebaf7263\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/codeMirrorExtensions.js\":\"5a00af82257523ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/dataExtension.js\":\"fc7e94047da59161\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/index.js\":\"05586323e23ce89e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/mentionAutocomplete.js\":\"60f867e359c3c858\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/processor.js\":\"84ca4da1c3b16fb4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/profiles.js\":\"4dc5cae970c7cd52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/queries.js\":\"b9d6dd0618b1995b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/schema.js\":\"4903e4acff59fda5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a6998e877b974109\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0d043e24af36c977\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/index.js\":\"367594f13be6282f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"22231a9d6914a2f2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dd20cdd0e3d7f7e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/CalendarGrid.js\":\"87263ee86b47a64c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DailyNotePicker.js\":\"53a6a24a0c7c167a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9065e8d04b9d5402\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateNavDecorator.js\":\"7eac32a8fe6a4c5c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateScrubOverlay.js\":\"3b0593c5950334c7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/HeaderItem.js\":\"3c0f8142dbf06be7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/ReschedulePicker.js\":\"5913897608d4bace\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8ed84b2ab47f96c4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/actions.js\":\"3958661b4dab0f19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/blockDateAdapter.js\":\"e4b1115e1b642315\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/calendar.js\":\"9785744c5b71ab6a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dailyNotes.js\":\"1de077caa7c94436\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dataExtension.js\":\"dba7effc76de83ff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubActions.js\":\"3c9e0d53bd4d4f4c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGesture.js\":\"3856251e6d294d63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGestureActions.js\":\"124617878eb27dd3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d2c56de8c7ee0fcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/deletionGuard.js\":\"ee1106409f5c413f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dueQuery.js\":\"d7bada9bcf83b400\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/index.js\":\"7a24fe7c2ffd50b1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/landing.js\":\"7eef26cb9380a3ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/localSchema.js\":\"ba8e8e6c8ed1b0a7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/referenceDateAdapter.js\":\"9f6738fd7f986ea1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/rescheduleAction.js\":\"b22706de5f0e28ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/schema.js\":\"5b7b5bbee5e140ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadBlockDates.js\":\"9d3a5ce6d0373f14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadDatesAction.js\":\"ef3e0e8746468000\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/today.js\":\"52393e683d2845df\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"de62ff4a0c32ff79\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"96a4de20911d25b2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/audit.js\":\"6ed7f75bee8c0c9d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditAction.js\":\"ad239d5d89478e0d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditRanges.js\":\"1f479d398a881d0a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/diagnosticsSource.js\":\"8c800514c8621917\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/divergenceScan.js\":\"1b78e5ae8f9cd9ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/index.js\":\"2c133a18f38b8180\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b8118c22e3c8b7ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/referencesMirror.js\":\"47d0ca16668f3462\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/rowJson.js\":\"af7bb1e8b1ce2d8c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/schedule.js\":\"e2729798120888a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/store.js\":\"3e32268b1412ea52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/action.js\":\"f6f39c2a22ee3769\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/index.js\":\"0104727c56599902\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/plugin.js\":\"233c8a4256256432\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0f1095816d7a7be2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/actions.js\":\"38c430598c589c98\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/changeMarker.js\":\"1412a63b57aaecf0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/diagnostics.js\":\"1b058e4f94046c78\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/fileSystemAccess.js\":\"e391e03d17257078\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/filenames.js\":\"23a848ad1039e483\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/index.js\":\"3104e1b26f332eed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/mirror.js\":\"0f1d050a4697e725\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runLock.js\":\"b51475413b373b5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runtimeHealth.js\":\"7a898b337f3a774c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/schedule.js\":\"36f7aeae63bde693\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/store.js\":\"d452fcac30fa78bd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/index.js\":\"0ccb45a19c334b75\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/themes.js\":\"2db2be3a4054db65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/facet.js\":\"46b171746a7309d0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/useDiagnostics.js\":\"970d50f77948d317\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/dismissals.js\":\"7ca0928ff5226b7e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/index.js\":\"fe83b324af14f3fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/status.js\":\"ba7396a9021e8441\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/store.js\":\"a7813e733e7e920e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"06673d7a8e548083\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ec3d7eb6a105077f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/actions.js\":\"49a0093ee55b1f6d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/config.js\":\"f7c3285b3400cdc1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/dataExtension.js\":\"1715b88215f28eba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/effect.js\":\"7e533c6a4b37b8d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/index.js\":\"18188d1a5fd65c7d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ff29ea411aede1ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/useToggleTree.js\":\"3746e53033c1d537\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/ExtractTypeDialog.js\":\"9237e77f97a43528\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"abbb5f0b3a0f9af5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/PropertyShapePicker.js\":\"0f63929f7952ab37\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/action.js\":\"d86ddce066cbf4f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/index.js\":\"973362d659e4610a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/FindReplaceDialog.js\":\"b51fe23417eefe83\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/HeaderItem.js\":\"e4bdfc54ca0eded3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/dataExtension.js\":\"6452417d647a3a44\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/index.js\":\"ee0261ffff23222c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/search.js\":\"dce66fa4c6ccef63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/toggleStore.js\":\"539c7f50f55fafdb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/LocationPropertyEditor.js\":\"c98353312d4fc6b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/MapView.js\":\"920ccaf748d67c11\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/blockTypes.js\":\"8e140ad7e4d18779\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/codeMirrorExtensions.js\":\"4a22a850ecfe0764\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/createOrFindPlace.js\":\"48125c53b8c501a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/currentLocation.js\":\"1b64739296b510e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/dataExtension.js\":\"bf880dfb95abd00e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/geoContentDecorator.js\":\"ed394f96216420ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/googlePlacesClient.js\":\"a2795fa5cd112b42\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/index.js\":\"c60cc525a8b09243\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/locationsPage.js\":\"34c5bb57547de0e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/mapViewport.js\":\"b706c2c733f676c1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/pickCurrentLocation.js\":\"4c5e8f96460bc905\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeAutocomplete.js\":\"1cbe274eadfac4c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeNameCollision.js\":\"f07ea94a18a6a457\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/properties.js\":\"2683c7f6b8015574\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/propertyEditorOverrides.js\":\"26552b6c8d936744\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/query.js\":\"7bc90c1b3e87939b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/usePlaceSearch.js\":\"c16b97a107f3909f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b9bbc99e46515d15\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"98382a194ab89685\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cf73a1eb4e569bc2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/config.js\":\"ad47dcb7796cf948\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/dataExtension.js\":\"0ff77f9076fd95cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/facet.js\":\"0e4492cefe816162\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/grouping.js\":\"e0b61d41c4be4227\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/index.js\":\"d2780aaef8d6eb57\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"aa1877cb86507354\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/query.js\":\"4c7f2f416374bf15\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/resolveConfig.js\":\"2701343f79692c18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0968734aa4b7f494\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d934d567bc8916cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlDocumentContent.js\":\"c91720c03d138845\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlFrame.js\":\"1abcbf7d6f486cf2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/actions.js\":\"8a65c6140b3c002c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/blockType.js\":\"c91e2b5678c72d9d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/confirmRunScripts.js\":\"5bfa91ccafd8a588\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/dataExtension.js\":\"6c2bb4905814b804\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameAnnotations.js\":\"b31e25c6072cd570\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameDocument.js\":\"9452e0dd95edeae7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameTheme.js\":\"076ba74ff223edff\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/index.js\":\"8f1ba425bf20da62\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/scriptConsent.js\":\"2cc8e9bd46061ab7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/sourceMap.js\":\"93b91db27e098a77\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/useDocumentScripts.js\":\"92261f9779d4c407\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/index.js\":\"fe56acfbac2dc988\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/record.js\":\"3f3b09d2b969386a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/recordStore.js\":\"3f1f12b809908e93\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/responsiveness.js\":\"f5faec45f1f0a741\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/schedule.js\":\"f2480af3bf9aec05\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/sessionContext.js\":\"c492e85370a1283e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2d7316839e4fd09d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"268237b8435591ea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/actions.js\":\"138d35e0f2cbd5a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/config.js\":\"cf6e81a005121473\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/dataExtension.js\":\"191e9c8a5bfd9cd2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/effect.js\":\"89df4a758f728e12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/index.js\":\"d9addf4b9bd98c3f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/keyCapture.js\":\"c7603052cd66d2f6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/overrideStore.js\":\"51343358abe695f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"abc08b4e88dff4f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/HeaderItem.js\":\"966b4a1e5c02bf8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/LeftSidebar.js\":\"ba40cb4a104117ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/actions.js\":\"22c26070585b2ed1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/facet.js\":\"964e9d869696cdd3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/index.js\":\"a2568245a0c715f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/shortcuts.js\":\"720f575fd21055eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/toggleStore.js\":\"fdcbded5fe8a9cac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/MergePicker.js\":\"573f9e0ed40b9b98\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/index.js\":\"a9162ae0332bc13d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/mergeAction.js\":\"d1f8aeb57e0888a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/strategy.js\":\"a06ffc19115f689e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/Button.js\":\"a647d6a98888e0d0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9594ec7186835a94\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2427625672c0cd3e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/facet.js\":\"450cb78ec72f15a7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/index.js\":\"074b747f373ec653\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"162066b0ee38cd63\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/actions.js\":\"11d9b8096335c96a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c8d5e49b435677ca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/facet.js\":\"878184bb0fd5109f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/index.js\":\"270dbe101614f287\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/MoveDestinationPicker.js\":\"97abda537d54330b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d54ddfbac8824387\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/contextMenuItem.js\":\"a849b2341622b32f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/index.js\":\"3fc34d667e80c5b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveAction.js\":\"ad5a49a0d95d2fcf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveBlocks.js\":\"fd47d272bec9fcc2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/selectionAfterMove.js\":\"f753c3a9a28d58be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/TutorialBanner.js\":\"4852a2b9ce8978fa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/action.js\":\"26c9e9025b57dcce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/bannerDismissal.js\":\"75fee777f5441a35\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/documents/cheatSheet.js\":\"2ab77fa9a1798ed0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/index.js\":\"74b16ae4f09d62ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/keys.js\":\"3a8acfe806c1317f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/landing.js\":\"c9541892a7c36aa8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/outline.js\":\"2b12dcf80374949d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/seed.js\":\"41f9c279946ce132\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/PerfTrendDialog.js\":\"720f725eadfd6345\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/analyze.js\":\"8b7c65be94bf4d68\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/diagnosticsSource.js\":\"5922e7a797be4300\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/index.js\":\"05d6c6b718d43f51\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/load.js\":\"624ceaf26e1be651\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/monitorRun.js\":\"6be861d4ad392d80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/schedule.js\":\"ae6608667cee4929\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/series.js\":\"364da0aa4d84f941\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/store.js\":\"a2e1971b0e1b1d9c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/trendAction.js\":\"221425b9cc6a00ba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/verdict.js\":\"fb1c00d07ce57cf4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/clickToEditAction.js\":\"c421d8d8d00e56eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/index.js\":\"3c75bbcd365fe519\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/interactions.js\":\"ed8b4da935a26b01\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b5b30888013e5508\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGate.js\":\"7302a9d88371ebce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGateDialog.js\":\"518d51ba63a124d2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/action.js\":\"9d81490509eda522\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/index.js\":\"461177bddeebac96\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/localRunMessage.js\":\"233f5ea315e0aa50\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/plugin.js\":\"c0af71fb56c27f12\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/progressReport.js\":\"998af620667314f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/sweepProgress.js\":\"f74a25ac171d4410\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/FieldRowRenderer.js\":\"ddb83c12cd3bfd10\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/ValueRowRenderer.js\":\"f3d06c8515b59488\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/actions.js\":\"67fbc9f6707a143c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/autocomplete.js\":\"b9e82bf163f01896\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/fieldRow.js\":\"401f8da3e10dbbd7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/index.js\":\"a4834af3ba6ebe7e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/referenceWarning.js\":\"a28ee5f5e9560204\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueAutocomplete.js\":\"01a4dd5e4aaf5d5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueSchema.js\":\"26e838dc9eea4f9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/HeaderItem.js\":\"54d5137ae64d8ae9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/QuickFind.js\":\"454ccd661fe4ff29\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/index.js\":\"690f8553d38ef0b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/recents.js\":\"46e3ab768a5d0171\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/resultItems.js\":\"ff2ac31c33045d20\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/selection.js\":\"61b6d101ff012d3b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/toggleStore.js\":\"1fbf04e430a4fe44\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/HeaderItem.js\":\"d42e7a2a60165aa0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9fc2a12044780758\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/grouping.js\":\"394a808014af9e5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/index.js\":\"ae997ee778f7a5b1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/target.js\":\"a88f4f2c9e8c0466\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/codeMirrorExtensions.js\":\"e59d699e433c6375\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/contentPrefill.js\":\"649234361cb00136\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/dataExtension.js\":\"6da5dea0568840cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/index.js\":\"24f65ad0515be562\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"db2168ab1b15d14c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/invalidation.js\":\"fbdc3726f1021493\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/localSchema.js\":\"87fa0332978a7a75\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/index.js\":\"05a3474f687e12b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ed81e7342d9faa9a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/index.js\":\"74f74e00ed46d3b6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/referenceNode.js\":\"fd40d5c9488e36cd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ea386dbbfd2aace9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"90b332a4358ed22a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/index.js\":\"dc5e448ac6a1ff41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2dd19f2c5f8768f3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ce6dbb66e695a391\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/mergeRetargetProcessor.js\":\"01483a8676437322\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/parseFence.js\":\"e3d2ebdc18658c61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceParser.js\":\"a7798e888dc56f36\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceProjection.js\":\"2c0aec2e0ecdd6fa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referencesProcessor.js\":\"3248dd96b54e21ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/renameProcessor.js\":\"7f755de8369cb72b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/spanReplacement.js\":\"7b95c85bed0d4258\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/htmlToOutline.js\":\"86621a2fff3c4e91\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/index.js\":\"b5de6dec7613bf81\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/normalizeClipboardDom.js\":\"eb4488caf3d8b4cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/pasteDecision.js\":\"7ef013228390caca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/action.js\":\"abe9f7397696b467\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/blockIds.js\":\"d624f99835e53f72\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/content.js\":\"e0d4e7d96e36e2bc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/effect.js\":\"b4c4824698b47204\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/ids.js\":\"44869f6acd27f7fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/import.js\":\"b0971f0495f2ee33\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/index.js\":\"317aa25b332040a4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plan.js\":\"b8699ac5935b665c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plugin.js\":\"88b038559e42223d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/promotion.js\":\"a32baba96f79bd96\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/properties.js\":\"64d88aa81e48e3ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/references.js\":\"94131d88b2cb2df1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/report.js\":\"5757d88cfabbe265\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/roamMemo.js\":\"0b8d0a1ce9089769\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/runtime.js\":\"fa88c820fe41936b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/schemaReconciliation.js\":\"279399eceb92b678\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/srsMarkers.js\":\"a026b97ce97d7d82\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/todo.js\":\"eadd9b2b86cab3d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/typeCandidates.js\":\"4e8b3baec6f95a03\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/types.js\":\"fe0150fa93eeca1c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/index.js\":\"bbb7e2f6d6b7f964\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/store.js\":\"c08923e1d323c7fb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/HeaderItem.js\":\"426732593ba3b663\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"62cfb01fefad78a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/index.js\":\"30af999a40c509f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/model.js\":\"328383c7ce6777d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/toggleStore.js\":\"097a9279339c99ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/useKeyInspector.js\":\"fd8852a98e45e182\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7c72a2c164d4bfc4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/ShellDecorator.js\":\"e83cbb5f5803ae6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/actions.js\":\"ddf78557a69f41f8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/exclusionsFacet.js\":\"aa05afac80c4ba5f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/index.js\":\"b87a958175b2958e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/shell.js\":\"0880d9fc3c7286d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/surface.js\":\"fcc7bfa430c2f64d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/walker.js\":\"dff326630e73c37f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c5cc69c386675ff7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/dataExtension.js\":\"ab24bb4537cfeb1d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/index.js\":\"d56820c045301a6d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/indicator.js\":\"ab4aa8a9388fefdc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/moveSrsState.js\":\"f77f2ed08ae97a7a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"633c3b5394c4e448\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/scheduler.js\":\"33537e6d7ea7a482\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/schema.js\":\"f542c763969bc7ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a79acb01adddcad7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsClipboard.js\":\"0ccab4980a7ea6fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b05f945f87dc8951\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DailyNoteReviewHint.js\":\"41dabc48a90a3404\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DeckPicker.js\":\"e6499e12d654a4e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewControls.js\":\"4783a25e3f26bec3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e1544f5bd4a54a2b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewSession.js\":\"d410d34774e304a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/actions.js\":\"7845f1e0789e4663\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/archive.js\":\"70ee5e9c876d0bac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dataExtension.js\":\"1cea1c45a9104c40\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/deck.js\":\"16a2e5cf68bc2d27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dueQuery.js\":\"73e07db815593170\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/gradeDecision.js\":\"cf88e18d9d54be0e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/index.js\":\"cc7d4716ca546ec8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/keyHints.js\":\"feeb00d4787b65e7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewCardLayout.js\":\"6be634603031c619\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewProgress.js\":\"82a4b64b1cbec190\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/schema.js\":\"399df383f6660f47\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/useDueCards.js\":\"3635521c06f5eb18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/index.js\":\"79cbeffca8db9350\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/record.js\":\"47e27f281563e3a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/index.js\":\"a7a125bb0ac8a1d2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/persistenceStatus.js\":\"ce652b5eca19389e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/requestAction.js\":\"e0f0664693f1355f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/TypeChipsDecorator.js\":\"543c54fb22732ec8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/codeMirrorExtensions.js\":\"22491f299f067ece\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/index.js\":\"0532418967dec9b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/typeAutocomplete.js\":\"eb59f7f08fc85d7a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a8fc20e008334b1c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/actions.js\":\"4ed028a830bf0afa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/anchor.js\":\"f7ef82b6a40bc4b0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/events.js\":\"e82fcddda9417ef0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/gestureActions.js\":\"997bab8c781172d1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/index.js\":\"0554460875701469\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3f78f2a48d271f55\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/collect.js\":\"c32c787eb9a091ef\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/index.js\":\"110a7273fbb203bb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/record.js\":\"639853a0734993c4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/RejectionDialog.js\":\"8a9cdc3c6e26c2e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c9a59daef641b660\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/index.js\":\"b41be53dea03b78c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/model.js\":\"7a689d5834d65802\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/queueCounts.js\":\"a07ef975887ccbcb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rejectedHelpers.js\":\"ae30e12c322ab39d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rematerializeAction.js\":\"fee28831baff87de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/useHysteresis.js\":\"33a2d43b7204ce11\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/effect.js\":\"013f9cc465b6c50e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/index.js\":\"d50d7520d643b3db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/theme.js\":\"7ef617ab07802601\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/actions.js\":\"283b6db268fc7f5b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/dataExtension.js\":\"79ebb3e8488e1b9e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/index.js\":\"2dd3b6b5446023cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/schema.js\":\"05fbb9e5f470512d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/TouchSelectionLayer.js\":\"20a3cc45eb84efbe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/actions.js\":\"81c5bbc5c37d3f82\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/defaultItems.js\":\"cc24143142561fd4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/facet.js\":\"d9630ae27f8ce1cd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/holdRecognizer.js\":\"ba7197335f459204\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/index.js\":\"9e753e70d250c1d3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/UpdateIndicator.js\":\"bbbcf348faf1ccfe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/index.js\":\"583ac2ea0ceba365\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/loadTimes.js\":\"a0d06f94c1193de4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoNotesRenderer.js\":\"f89a33007b3faf35\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoPlayerRenderer.js\":\"3f5993ee7e97d71e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoTimeStamp.js\":\"31cfebb307f859f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/actions.js\":\"e6fef4d3fee4e0bf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/index.js\":\"802042a3ae68c972\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/markdown.js\":\"a5841d5d1e10203d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/notes.js\":\"5de64a98fa339f9d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/registry.js\":\"adad62ae29371a43\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/remark-timestamps.js\":\"aa846ea7006c8aeb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/view.js\":\"d97b3f069560082c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/LinkHints.js\":\"cac7f3c0dc107f09\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/index.js\":\"dfc380c1bedfbcc1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/model.js\":\"cdfceec76cc54660\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/settings.js\":\"f08b7ff4dfcceebe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/actions.js\":\"d2d7fc78aa687dc8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/index.js\":\"896af4da1e266c77\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/interactions.js\":\"ada86f6895eddedb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/workspace-header/index.js\":\"28dc8ea312236691\",\"/knowledge-medium/pr-preview/pr-1790/src/registerServiceWorker.js\":\"b6f989a737b368cc\",\"/knowledge-medium/pr-preview/pr-1790/src/requestPersistentStorage.js\":\"07bd5421a3d598d6\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authRequestDeadline.js\":\"deed6e2c48fbb9b0\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authStorage.js\":\"2f769ed455397ce8\",\"/knowledge-medium/pr-preview/pr-1790/src/services/powersync.js\":\"da525a8496c3d767\",\"/knowledge-medium/pr-preview/pr-1790/src/services/supabase.js\":\"6d6b17222232714e\",\"/knowledge-medium/pr-preview/pr-1790/src/services/uploadErrorClassifier.js\":\"14d8104c556ffc59\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/ActiveContexts.js\":\"5cf1f8f5efbf0526\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/HotkeyReconciler.js\":\"05a94075c0a4d00c\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/WipeLocalDataDialog.js\":\"085b4b7852d70c74\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionDispatch.js\":\"93c9f8ffe902ac79\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionRefItems.js\":\"98166245d18bc959\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/applyKeybindingOverrides.js\":\"2ab54ad68d31c3f1\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/blockActions.js\":\"5199eda920045fd7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/canonicalizeChord.js\":\"1c4f8e7dfe84a9ee\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultContexts.js\":\"fec29711c312fda7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultShortcuts.js\":\"53a6fb77cb198a1e\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/effectiveActions.js\":\"3254a8ac339f0d97\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureAction.js\":\"ea6ca6a0924d27f7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureBinding.js\":\"2cb3dd5d20eb8b82\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/holdRegistry.js\":\"29866ecd774dc3e1\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingConflicts.js\":\"3bb213d79d39c1df\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingOverrides.js\":\"7183c82659153067\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/pointerAction.js\":\"ad4107cc10217ec4\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/resolve.js\":\"a61cee6f2d3b759f\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/runAction.js\":\"a559525067ab3925\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/sequenceMatcher.js\":\"9bf2b2f3b15c8006\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/types.js\":\"fc5485c5132e8e4b\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionContext.js\":\"262afc8a576b7d43\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionDiscovery.js\":\"1576fb27f5dfbc31\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/utils.js\":\"dee8148a38fa98d7\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/bootStore.js\":\"27b3c1a6d55db71a\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/previewDatabases.js\":\"7967f3ff58658860\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/byteTransform.js\":\"e7cb71a21d143150\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/attachmentCleaner.js\":\"19603d2189b18946\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/attachmentParts.js\":\"6c23ee13e76f0280\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleParts.js\":\"1f75a9a18537c05a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleRecord.js\":\"264ccd7208f477c2\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/manifest.js\":\"bd60de9a78e982de\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/takeBundle.js\":\"cf4a07c552303094\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/verifyBundle.js\":\"2ead447ddc332b9e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/cleaningStage.js\":\"5053c00bcd307157\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionKey.js\":\"77b747a8f8a4c50a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionServer.js\":\"51d705634be16e18\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flip.js\":\"d14c84740e280657\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flipAttempts.js\":\"fe4135a3a0b9115a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/pages.js\":\"5442563c2a9a5876\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/preflight.js\":\"a757e5ef1ea9f357\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/reseal.js\":\"1301cdbfedfdb4fe\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runConversion.js\":\"30dc570135a608ca\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runLock.js\":\"58a91d2d280ee0a7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealing.js\":\"48801a205ef53943\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealingStage.js\":\"79056bf84d7b9b76\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/stage.js\":\"4460b9d465da4f23\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/verifyReseal.js\":\"6c50d1240909f447\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aad.js\":\"a849930ea117e8d2\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aead.js\":\"b3dbed4ce88294a3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base32.js\":\"e15ca0df98c105e7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base64url.js\":\"3050f2f73e216bb9\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/binaryEnvelope.js\":\"86c1eebdb1c9cfec\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/byteAead.js\":\"61694d323ce46e66\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/canary.js\":\"2c1f39b148275608\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentHash.js\":\"392a29b1bf051576\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentKey.js\":\"00e98672f1105aa1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/derivedIdNamespace.js\":\"3adb1a77a7987e3c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/envelope.js\":\"b93511924823a219\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/hex.js\":\"9891457b1e2871d6\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/sha256Hex.js\":\"47806d975ecb6a9a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/workspaceKey.js\":\"7ae973a0d56b945b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/conversionState.js\":\"de7a718cbc031943\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fe3a11490521980f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/pastedKey.js\":\"051515906aba7198\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3f864c62e77cfb6a\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b3af5b2454286844\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/keyStore.js\":\"e19e77d3963efa78\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/mintWorkspaceKey.js\":\"64eeea5dfa1b6561\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/modePin.js\":\"00fe23cf7a614883\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/openWorkspaceKeys.js\":\"43640a6a588dbdec\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolveWorkspaceEntry.js\":\"c87cea2e87ea6964\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolver.js\":\"f3fa07e894a18897\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/workspaceAccess.js\":\"1013c19e5de80ec4\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/transform.js\":\"104394ea4d907872\",\"/knowledge-medium/pr-preview/pr-1790/src/themeBootDefaults.js\":\"85358cb319912250\",\"/knowledge-medium/pr-preview/pr-1790/src/types.js\":\"163bb37e427f13dd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/ClientLocalSettings.js\":\"ad598eaf1deebbc3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/abortableSleep.js\":\"3be6af009150ca3b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/array.js\":\"649ad21ce52c792b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/backlinkAutocomplete.js\":\"dbbed2734a663830\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockCrumbs.js\":\"9e6fdafa27cd292e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockrefAutocomplete.js\":\"668f7ee2130203d6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/cadencedIdleJob.js\":\"000a94242e2d7c81\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/callbackSet.js\":\"964cc562627f98f0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/clientId.js\":\"7f9f27122086ed70\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirror.js\":\"3219efffc79cd45d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirrorCompletion.js\":\"0c432b7c08a48352\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/copy.js\":\"9ccd801a9c7ff4a4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dailyPage.js\":\"f0a93686d743b593\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensics.js\":\"fde0db815c91a129\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensicsHooks.js\":\"4bde2e4d257e3b65\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/deleteBlockThroughUi.js\":\"a1419a3279916af3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dialogs.js\":\"c79ee5445763f836\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dom.js\":\"615ab88216addd57\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/downloadBlob.js\":\"efd7717ef5730d5e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/exportSqliteDb.js\":\"c36fa5044b20dc50\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fileSystemAccess.js\":\"f38a3c18fdfec72f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/flipSlide.js\":\"8d5c091fb607fa44\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fnv1a.js\":\"1d6a417a675663e2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/formatBytes.js\":\"12c5e512d8506fca\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fuzzyRank.js\":\"8e2308c705dc2182\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idbKeyedStore.js\":\"c8137c2950ad1ee5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idleCallbackPolyfill.js\":\"821730ae105def90\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardAwareScroll.js\":\"01d55fc143b7cef7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardViewport.js\":\"008cde636f55cec8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/lastWorkspace.js\":\"ca5d2c4024afa210\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutColumns.js\":\"130f937214203c53\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionDom.js\":\"ada3d6f0bf24ee7e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionId.js\":\"a7dd0cd2d8677722\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkClickGestures.js\":\"30d5901cc83b311e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkTargetAutocomplete.js\":\"08046349d0ac428d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbCorruption.js\":\"f700fc3f0b221935\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbRecovery.js\":\"ca1923be098f10f4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/markdownParser.js\":\"e13c12955f49f552\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/memoize.js\":\"b6d36b6c52366287\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameFieldCommit.js\":\"dd69dee7429a88bc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameList.js\":\"284c7bfc257aaf4c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/navigation.js\":\"22237bdb7569b9e3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/omnilinerNamespace.js\":\"50efec565d1d5fb2\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/opfsPageScan.js\":\"36623d2546af4ea5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelClearance.js\":\"fc6f3bfda7970f11\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelHistory.js\":\"90162ce7c5a32d86\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLanes.js\":\"a5b10c473e2c59d3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLayoutProjection.js\":\"a1761477a911c024\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelScrollAnchor.js\":\"5214e9725e775b51\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelUrlFlags.js\":\"21bf5b45bbd64b75\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/platform.js\":\"3d1c8bb8b17d1c4c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/pluralize.js\":\"0b706ae2381fbdf4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyCreation.js\":\"6215cc63748c563d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyNavigation.js\":\"e14a7bb34629ec33\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyValueContext.js\":\"556fb6232b0289c3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/react.js\":\"a7030db7c95c833f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeDate.js\":\"9f5ab2c4769564c4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeTime.js\":\"204b015ef89d34ee\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/renderScope.js\":\"f90b79d7812b3bb1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/resolvedThenable.js\":\"4bd05c3d69efb891\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/routing.js\":\"2e8c3d2ad1c10e71\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/safeMode.js\":\"421d3f9a8bba0994\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/scheduleIdle.js\":\"1cbcb4adca00510b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/screenWakeLock.js\":\"d97d153463537155\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/selection.js\":\"508a9d01a97d0a96\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/softKeyboardGrab.js\":\"a25daa6fcde6d760\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/startupTimeline.js\":\"da20c9d75c6c5a5c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/state.js\":\"ab7190eca9208a40\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/string.js\":\"faeac5b04e72d2f1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/surfaceZoom.js\":\"e47f3c736049228d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/time.js\":\"5345286a1e9364a3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toast.js\":\"ee43154225ad7d26\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toggleStore.js\":\"4f6ec68f3cd082de\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/untilStopped.js\":\"f2fcb1323fbad91e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/userActivity.js\":\"f0092ec3710c488c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewTransition.js\":\"202d9545f6beb352\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewport.js\":\"9b2c0c205f14c7ed\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/webLock.js\":\"c9ff8a9dd51ea79e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceRecovery.js\":\"72a94e33e03f6aa9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceSnapshotStore.js\":\"a4be5f6455c59366\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-compiler-runtime.js\":\"5f67309d2489e1f8\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-client.js\":\"45c3d137e32e95a3\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server-edge.js\":\"53e913835747f748\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server.js\":\"00c99dc8006c7974\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static-edge.js\":\"269cace02ebb94e4\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static.js\":\"7377259756ba26b7\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-test-utils.js\":\"396066b01526cb50\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom.js\":\"1e9af157b1d4be55\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-runtime.js\":\"7e593f80a8777349\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react.js\":\"4d357c67cf204cc9\",\"/knowledge-medium/pr-preview/pr-1790/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
