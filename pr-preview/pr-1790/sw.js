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
		buildId: "13fc1fe88f3f-4dd29e5e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/\":\"8a6279da8c096bf8\",\"/knowledge-medium/pr-preview/pr-1790/index.html\":\"8a6279da8c096bf8\",\"/knowledge-medium/pr-preview/pr-1790/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1790/assets/FacadeVFS-Cbz06kB2.js\":\"74485875235893db\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSCoopSyncVFS-CUVNwzUr.js\":\"e0851b0ee1e1b671\",\"/knowledge-medium/pr-preview/pr-1790/assets/OPFSWriteAheadVFS-3B0A1y4m.js\":\"bda9e01b694b4232\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-async-ktd0X-Hw.js\":\"0210f7d865f204c3\",\"/knowledge-medium/pr-preview/pr-1790/assets/wa-sqlite-hQQbA2y8.js\":\"89ab406fe54e76b8\",\"/knowledge-medium/pr-preview/pr-1790/assets/worker--0zFX5-A.js\":\"d900c6d783ab594c\",\"/knowledge-medium/pr-preview/pr-1790/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1790/chunks/app-CFNISOsB.js\":\"8ea5588348a52031\",\"/knowledge-medium/pr-preview/pr-1790/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1790/index.js\":\"ff0052bf0db57973\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1790/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1790/assets/AccessHandlePoolVFS-gsTi_WFb.js\":\"b665fa33c58c6af9\",\"/knowledge-medium/pr-preview/pr-1790/assets/IDBBatchAtomicVFS-dQYMcIHE.js\":\"c912dab8e9d130e9\",\"/knowledge-medium/pr-preview/pr-1790/assets/MemoryVFS--Q_GuuQF.js\":\"9c9014025853b9bd\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-D6OQyPL_.js\":\"108b39bf1f438432\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-D5Vpv8RX.js\":\"ae93362cb200092c\",\"/knowledge-medium/pr-preview/pr-1790/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1790/chunks/AccessHandlePoolVFS-DtfSvDeb.js\":\"4dcbd453c5eb26cd\",\"/knowledge-medium/pr-preview/pr-1790/chunks/FacadeVFS-CODSShoA.js\":\"c6bba7c66d5cfd59\",\"/knowledge-medium/pr-preview/pr-1790/chunks/IDBBatchAtomicVFS-BPA7AmEF.js\":\"efe8efe06236c69d\",\"/knowledge-medium/pr-preview/pr-1790/chunks/MemoryVFS-L3gd0r2S.js\":\"8b640b772bd149da\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSCoopSyncVFS-xKcTMclK.js\":\"3b6dc84286cbc91c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/OPFSWriteAheadVFS-DU-QU9Nk.js\":\"43ac91bf6e249d5e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/Preview-Ceo54HH0.js\":\"ce605ab2200a5336\",\"/knowledge-medium/pr-preview/pr-1790/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/card-BK3a-qrG.js\":\"a9cff10be33b867b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1790/chunks/dist-CjD4nA3Y.js\":\"4728da11a041a80a\",\"/knowledge-medium/pr-preview/pr-1790/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-DjZHvn0K.js\":\"9ff586e15f0095f1\",\"/knowledge-medium/pr-preview/pr-1790/chunks/mc-wa-sqlite-async-D6txpUFE.js\":\"adfe25c6f0b68367\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-9rNXNVU4.js\":\"b38cd056ad1db07a\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-B2XsO6FK.js\":\"80f53db98460ed2c\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-B71T8rCG.js\":\"54fa01257ae56740\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-Bhvd8kAU.js\":\"6d7b4b19983e0bc2\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-C6foExaI.js\":\"f36673f9aa558698\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-CZoDfo9T.js\":\"12e1d64ac7fec0a3\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-CeY9vwyX.js\":\"d73cd0a21d74fffe\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server-legacy.browser.production-C-DZJibI.js\":\"2573120abbb5fe0d\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.browser.production-B1-F9cU6.js\":\"4bf3b82b264a5eef\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-dom-server.edge.production-CsGKN-1Q.js\":\"11eeca1c81081452\",\"/knowledge-medium/pr-preview/pr-1790/chunks/react-nKIuWdpl.js\":\"da2bdec6ce1f3c8b\",\"/knowledge-medium/pr-preview/pr-1790/chunks/server.browser-C5rJNXg2.js\":\"1e114a27217eef00\",\"/knowledge-medium/pr-preview/pr-1790/chunks/textarea-ClyQOCT0.js\":\"a0d3195b98593662\",\"/knowledge-medium/pr-preview/pr-1790/chunks/ui-BK1S6evy.js\":\"7536c1f27bfb5863\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-Cw0QXI3_.js\":\"6bfb45abd330d337\",\"/knowledge-medium/pr-preview/pr-1790/chunks/wa-sqlite-async-B1GzTLn2.js\":\"9814a68e4ef205ef\",\"/knowledge-medium/pr-preview/pr-1790/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1790/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1790/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1790/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1790/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1790/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1790/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1790/src/App.js\":\"28bad6bd2b0e5bd5\",\"/knowledge-medium/pr-preview/pr-1790/src/appUpdate.js\":\"c271b688921bb161\",\"/knowledge-medium/pr-preview/pr-1790/src/appVersion.js\":\"8d62284c88549d4e\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/initialLayout.js\":\"f338727214502f80\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/openWorkspaceData.js\":\"b63160f5f4925062\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/resolveWorkspace.js\":\"611503bc9bba65ac\",\"/knowledge-medium/pr-preview/pr-1790/src/bootstrap/workspaceBootstrap.js\":\"c61303e03172ccd0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockComponent.js\":\"efbbac3a449e92e6\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockCrumbs.js\":\"916ef94dd5dc36f1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockEditor.js\":\"f22580e6e6688f90\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockLoadingPlaceholder.js\":\"7565bf482445d1a2\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockProperties.js\":\"e31557fa49c0c6ff\",\"/knowledge-medium/pr-preview/pr-1790/src/components/BlockSearchPicker.js\":\"7fde8f6afcfeb74c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ConfirmBulkDeleteDialog.js\":\"cfab1fb1c7b20439\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DividerHandle.js\":\"8e55118a40724e74\",\"/knowledge-medium/pr-preview/pr-1790/src/components/DraftEditor.js\":\"1f86084c91410099\",\"/knowledge-medium/pr-preview/pr-1790/src/components/GutterPill.js\":\"2b3c28514616c0e4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Header.js\":\"88e2205744a315e7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/LazyBlockComponent.js\":\"ca2a5e62cff72d68\",\"/knowledge-medium/pr-preview/pr-1790/src/components/Login.js\":\"3c262501ba53d89b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ZoomableSurface.js\":\"952e7bbbf4351243\",\"/knowledge-medium/pr-preview/pr-1790/src/components/editModeKeepalive.js\":\"bd605cba9673454b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyDisplay/PropertyDisplayScope.js\":\"442e5237c7d93149\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"613088d5b67ef970\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefPropertyEditor.js\":\"f47b9965d2c67574\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/RefTargetTypePicker.js\":\"1850c184cbb35eaa\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/SelectPropertyEditor.js\":\"edbb9136479cf31b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/TypesPropertyEditor.js\":\"28b42a9bb4d17018\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/defaults.js\":\"79dd0d41831cab5b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/kernelValuePresets.js\":\"54a81fbcf6f576a7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/selectablePresets.js\":\"a0a6fe27f1e5997e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyEditors/typesPropertyUi.js\":\"71738559070dd98d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/AddPropertyForm.js\":\"e44ccd7bc37592c8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyPicker.js\":\"b9aab56294377eb1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/PropertyRow.js\":\"8ebee09346c217a1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/Rows.js\":\"cd85348b29c228d3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/actions.js\":\"166db09c5d2448f8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/declarationOnly.js\":\"92ce2cbc46190d53\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/layout.js\":\"65c95c77f7751d80\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/model.js\":\"e202159e3ccf9686\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapeUi.js\":\"5830117c7fc8cb6f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/shapes.js\":\"8b3ed2683ff99813\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/usePropertyEditingActivation.js\":\"6eb9dc3dca31f7d0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanel/visibility.js\":\"1aff4b5e00b3ac2e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/propertyPanelSections.js\":\"751d1b9ab0642fb4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockEmbed.js\":\"eb347f9529fc0f44\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockLink.js\":\"17c231f430e5db7c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/BlockRef.js\":\"6978ed6a9170ae2e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/ReferenceLink.js\":\"54345a569317e98f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuard.js\":\"1d6389451ebcdc22\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/cycleGuardContext.js\":\"f2c342e918770587\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/linkInteraction.js\":\"3137376b5d6ebfa0\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/referenceLayout.js\":\"7fe0de1f97db3865\",\"/knowledge-medium/pr-preview/pr-1790/src/components/references/useBlockRefAncestors.js\":\"1e6c2766d7ed8cdd\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockGutter.js\":\"ba20f7469e424dfa\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockInfoDialog.js\":\"7cfc379e0091ac2d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BlockTypeBlockRenderer.js\":\"828dcf2e7df67410\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/BulletHoverCard.js\":\"7b667c9ed914fd5d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorContentRenderer.js\":\"9ed3bea7ac94ae0b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cad485c087f914ab\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ColumnResizeHandles.js\":\"eeda494f1adf77bc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"cf954ec55174a8d8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/DefaultBlockRenderer.js\":\"3a8f05fc29f1b2a7\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/LayoutRenderer.js\":\"f345e6f2f1496404\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MarkdownContentRenderer.js\":\"93b2f1067c3fc3a8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/MissingDataRenderer.js\":\"dd581bd4d7800803\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PanelRenderer.js\":\"fac1610bc1ec377f\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a36e11d7c96cee90\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/TopLevelRenderer.js\":\"6ff076f65407fe87\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockGutterMode.js\":\"9f44d095f88b3acf\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/blockTitleText.js\":\"a9d422f6ea176814\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/fieldCreationKeydown.js\":\"1f65e673eaa64843\",\"/knowledge-medium/pr-preview/pr-1790/src/components/renderer/layoutRootContext.js\":\"55c45b85a76cb9a5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/TypeChip.js\":\"707f17e1270ebf7e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/typeChip/chipStyle.js\":\"7736dfb5277a4c2b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/anchored-floating.js\":\"036f669de8e8b7ea\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/button.js\":\"8212a1b092f38321\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/card.js\":\"8d8fd8aa1daa101e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/checkbox.js\":\"eb614a0e1024b80d\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/collapsible.js\":\"29a02d1621851375\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/command.js\":\"d646a563bdf64fe5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/context-menu.js\":\"8d12f89a18ab1b5c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dialog.js\":\"1b2f560aa18566b9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/dropdown-menu.js\":\"367d78a15e8ba13c\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/floating-listbox.js\":\"eb3c762f045d22b5\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/index.js\":\"61aa885d19033615\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/input.js\":\"8f7f543572baebf4\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/kbd.js\":\"c073e1b4ec888d92\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/label.js\":\"f5b68885b6818e0e\",\"/knowledge-medium/pr-preview/pr-1790/src/components/ui/textarea.js\":\"9523308720ae1b56\",\"/knowledge-medium/pr-preview/pr-1790/src/components/useEditModeYieldKeepalive.js\":\"191bf5e6fa11f2bf\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/BootFallback.js\":\"99ce2e125c884633\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/FocusedRowLazyMount.js\":\"db041c1d913a810a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LazyViewportMount.js\":\"5ab0701565ee2087\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/LocalDbCorruptionFallback.js\":\"7d627c6911af53c3\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/error.js\":\"7a3a6ef9ceab783a\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/lazyMountRegistry.js\":\"cc47f8ec01aa6e24\",\"/knowledge-medium/pr-preview/pr-1790/src/components/util/suspense.js\":\"df91f4629996a009\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/CreateWorkspaceDialog.js\":\"51ec63e28429258b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/PendingInvitations.js\":\"3097cc038ffe1f61\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/SyncProgress.js\":\"73557ed748cbc3ae\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/UnlockProgress.js\":\"2ac36545490df2c1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceKeyGate.js\":\"262c58222a288c2b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSettingsDialog.js\":\"b4bf215823974965\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSwitcher.js\":\"914ffa4e5131b9b8\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/WorkspaceSyncGate.js\":\"843c75def11117eb\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlow.js\":\"4e15e89b942d8ccc\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/ConversionFlowHost.js\":\"742bf7d403653f55\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/EncryptionSection.js\":\"1f9843ab66739b20\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/attachmentPrompts.js\":\"10a58efc73a71000\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/bundleFolderPrompts.js\":\"aa5fe72348154fce\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowDeps.js\":\"7425d269db4685d9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/conversionFlowStore.js\":\"a1a9601bd6f7303b\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/flowUi.js\":\"a6f7045f13133200\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/conversion/useConversionRun.js\":\"a992113593fd87af\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/keyUi.js\":\"262f65eb666e5c62\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnKeyLoss.js\":\"78b6b8d910a7bef1\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/useCloseOnServerE2ee.js\":\"0021bd11cd1c0ac9\",\"/knowledge-medium/pr-preview/pr-1790/src/components/workspace/workspaceUnlocked.js\":\"2b7a340f6a5f753a\",\"/knowledge-medium/pr-preview/pr-1790/src/context/backgroundSubtree.js\":\"2da60bb277e9a85c\",\"/knowledge-medium/pr-preview/pr-1790/src/context/block.js\":\"36909cb83815290f\",\"/knowledge-medium/pr-preview/pr-1790/src/context/layoutWsContext.js\":\"875f36d34eee00a1\",\"/knowledge-medium/pr-preview/pr-1790/src/context/propertyDisplay.js\":\"18d1608c3a5e6e17\",\"/knowledge-medium/pr-preview/pr-1790/src/context/repo.js\":\"a1430f5d3ab15dd5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasClaim.js\":\"26d299cba59bdb42\",\"/knowledge-medium/pr-preview/pr-1790/src/data/aliasSeatNamespace.js\":\"455369dbd2951f2d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockData.js\":\"169e175c2a01376b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/blockType.js\":\"9639a62971167e7d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/changeScope.js\":\"d835b337f8134936\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/codecs.js\":\"3321619dfa312fba\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/derivedData.js\":\"ed7af9b817aa146a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/errors.js\":\"8a48d4a992e989b1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/events.js\":\"975985d2c5952298\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/handle.js\":\"57afb0208c447d78\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/index.js\":\"d5769969a5db2d88\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/mutator.js\":\"26bff4b9c17e6353\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/processor.js\":\"23899dea6c334abf\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/propertySchema.js\":\"d5a15d89c01e1903\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/query.js\":\"fa2e39ba038be51b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/sameTxProcessor.js\":\"6aaf492e4a0e7c73\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/schema.js\":\"57afb0208c447d78\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/tx.js\":\"57afb0208c447d78\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/typedBlockQuery.js\":\"f7ef4236dc0de395\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/user.js\":\"ac63510a66afd215\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresetCore.js\":\"2a634d664abf2902\",\"/knowledge-medium/pr-preview/pr-1790/src/data/api/valuePresets.js\":\"97da58b9855a3011\",\"/knowledge-medium/pr-preview/pr-1790/src/data/attachmentCleanerIOVerb.js\":\"d8fc078d7fb323cd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/block.js\":\"cc86e0343ac84ca0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockCache.js\":\"e83e57c10d41ad6f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockId.js\":\"fd97ad6ad5b8d62b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockLiveness.js\":\"2b03f432d63c72b3\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockMerge.js\":\"8989cee79a6a063b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockSchema.js\":\"fa8523efb4f81a65\",\"/knowledge-medium/pr-preview/pr-1790/src/data/blockTypes.js\":\"9bf54d9b4d12c579\",\"/knowledge-medium/pr-preview/pr-1790/src/data/clientContext.js\":\"c4b3b1e5c8b9b5d0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/dbFileSiblings.js\":\"3a2eb6032cc5b708\",\"/knowledge-medium/pr-preview/pr-1790/src/data/definitionSeeds.js\":\"8f2343163c0232cd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/derivedIds.js\":\"52d693ac7baf3b6b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/drawnSubtree.js\":\"0d271c6f6da1ac63\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facetBridge.js\":\"ee1ff3fe0abe6094\",\"/knowledge-medium/pr-preview/pr-1790/src/data/facets.js\":\"523d9895d8f0a886\",\"/knowledge-medium/pr-preview/pr-1790/src/data/globalState.js\":\"4c689e4a056158ab\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/aliasClaimRederiveProcessor.js\":\"de61c4e49c935380\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/ancestorBatch.js\":\"690a2d9bcaf61f7f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/blockTypeTypeifyProcessor.js\":\"2bba1ecca37edd38\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/clientSchema.js\":\"cd4043cbee7f6dd2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/commitPipeline.js\":\"cbfcef88df206069\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/devAssertions.js\":\"325bdf55687b9389\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/firstSync.js\":\"abf140041803b33c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/freshInitialLoad.js\":\"586512c2e6b2bc30\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/graphBackfillClaim.js\":\"646cf0e07425645c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/handleStore.js\":\"9024d0d01ffa2c2a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/idleMarkerJobs.js\":\"18acbb8c6cd3079f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initialDownload.js\":\"193b94d926c2a3c2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/initializeClientDatabase.js\":\"643d10618a9bd9b2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/jsonCanonical.js\":\"445d238247134374\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelInvalidation.js\":\"be8b30b63f971010\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelProcessors.js\":\"e0bb07c9ee1049d1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/kernelQueries.js\":\"f772f6ddcb0323d8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/mergeTypeMembershipProcessor.js\":\"d1c9e8bff10d4c29\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/normalizeReferencesProcessor.js\":\"c1cc778bd5ceb2a0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/poolInstrumentation.js\":\"d63b5df1a34a1814\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/processorRunner.js\":\"257c477b650b2e5b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyCellBackfill.js\":\"eb8de473050fe048\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildMint.js\":\"5a8bd41b6d24e54d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyChildrenProcessor.js\":\"014bb1473c342a52\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionChangeProcessor.js\":\"5631cba03336e4b6\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyDefinitionSynthesis.js\":\"2537fdad5fd41b99\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertyKeyScan.js\":\"d1e3a54d5593af56\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/propertySchemaResolution.js\":\"04b2d95a533253fb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/raiseProtocol.js\":\"fd61b857a042d3a5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/readBatch.js\":\"64e225b3ebcb506a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/refProjection.js\":\"be4ba97589a9b637\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetLookups.js\":\"c3cc65fab3cebb2e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/referenceTargetProcessor.js\":\"c851778c6ea3409f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/replayMerge.js\":\"fb48dad440b9ae64\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/sqlBinds.js\":\"ed16678b5702e9cd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"03f3ef0594efa139\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/arrivalProcessors.js\":\"73852b5e8a1ea973\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/invalidate.js\":\"f7b8468f1cc90f8d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/materialize.js\":\"442d78b2ef77aad2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/observer.js\":\"3eee03c3d7b9eb63\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/syncObserver/reconcile.js\":\"e287bb123502381e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/timingMetrics.js\":\"19fdbd84769669ba\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/treeQueries.js\":\"1f577ebe6230a1c8\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txEngine.js\":\"1a34d9b5e03e736f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/txSnapshots.js\":\"9468f03784f1d624\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/typedBlockQuery.js\":\"d7380655da144421\",\"/knowledge-medium/pr-preview/pr-1790/src/data/internals/undoManager.js\":\"97a59b75ea7ca543\",\"/knowledge-medium/pr-preview/pr-1790/src/data/invalidation.js\":\"8fc90f0fe0defc69\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelDataExtension.js\":\"00ebe65b07d57705\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelPage.js\":\"276bce04c050902c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/kernelValuePresetCores.js\":\"13313e073dcfd031\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbCorruptionSignal.js\":\"e5820a0ba4f1eb51\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbStorage.js\":\"14c353f58b6d175f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localDbVfs.js\":\"d9dec9185a7f94e0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/localSchema.js\":\"dd58e02847e599e4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/maintenance.js\":\"355a0a0d9b02825b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mergeProperties.js\":\"b11993052207a10d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/metricsConsoleHook.js\":\"dd141a8757fb8733\",\"/knowledge-medium/pr-preview/pr-1790/src/data/migrationsPage.js\":\"e4e885677766337c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/mutators.js\":\"27d6132125f7549a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKey.js\":\"3d2f62a733c14b10\",\"/knowledge-medium/pr-preview/pr-1790/src/data/orderKeyPlacement.js\":\"27c7e53ce3d5b33f\",\"/knowledge-medium/pr-preview/pr-1790/src/data/outlineSurface.js\":\"905ba641592c536b\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingEditorContent.js\":\"b45d264bfcd4f2dc\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pendingUploadsSql.js\":\"be99f48971a22fc4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/pluginStateExtensions.js\":\"0195b26952fa3f2d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/powerSyncLogger.js\":\"79aa35a141815004\",\"/knowledge-medium/pr-preview/pr-1790/src/data/projectorRuntime.js\":\"083ae899cca31fda\",\"/knowledge-medium/pr-preview/pr-1790/src/data/properties.js\":\"97bac69c154fc1d7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertiesPage.js\":\"1dd8552586496050\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyChildren.js\":\"9b728be6c7b3fae4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionFanout.js\":\"ed27e154158c7eba\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionMetadata.js\":\"a05740b83b2c62d0\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDefinitionRegistry.js\":\"5786b5fd1ef46948\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyDisplayMode.js\":\"a14bec3b2967155a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertyRowCreation.js\":\"c8e315710a83a9b5\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySchemaCreation.js\":\"3901d49fa26363b1\",\"/knowledge-medium/pr-preview/pr-1790/src/data/propertySeeds.js\":\"f949c424d02829bd\",\"/knowledge-medium/pr-preview/pr-1790/src/data/recentsPage.js\":\"cef2b289f4889072\",\"/knowledge-medium/pr-preview/pr-1790/src/data/referenceBlock.js\":\"a685adf710fd4d58\",\"/knowledge-medium/pr-preview/pr-1790/src/data/releasePowerSyncConnection.js\":\"980d763a576f80c9\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repo.js\":\"ee2b6af4d3da5485\",\"/knowledge-medium/pr-preview/pr-1790/src/data/repoProvider.js\":\"bcfd9cb9fc7f5742\",\"/knowledge-medium/pr-preview/pr-1790/src/data/rowProperty.js\":\"22457ec3ab32a784\",\"/knowledge-medium/pr-preview/pr-1790/src/data/searchFilter.js\":\"68be5b20070de678\",\"/knowledge-medium/pr-preview/pr-1790/src/data/seedIdentityLedger.js\":\"5745f7a2f49c0c39\",\"/knowledge-medium/pr-preview/pr-1790/src/data/stateBlocks.js\":\"6fac405bddbf6cfb\",\"/knowledge-medium/pr-preview/pr-1790/src/data/structuralEditPolicy.js\":\"a81c986ed3daab8d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/subtreeDelete.js\":\"eaa2a33c17c74839\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncStreamLock.js\":\"4c2e2f728c735278\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableSqlRecognizer.js\":\"58f50cb6a2dd3497\",\"/knowledge-medium/pr-preview/pr-1790/src/data/syncedTableWriteGuard.js\":\"6273d4577547ae7a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/targets.js\":\"0b24f6995e0ac9e2\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeColors.js\":\"0132b1af10323339\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionMetadata.js\":\"492196d2df7bba46\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeDefinitionRegistry.js\":\"8d1a3280f5bbca98\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeExtraction.js\":\"3682f063e267c92a\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeInitialValues.js\":\"86fdf9718c97c874\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typePropertyGroups.js\":\"95efa4277b617995\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeSeeds.js\":\"d33677f173d08c46\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typeTagger.js\":\"c19f4e83f3032e04\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typedRecords.js\":\"66374ba2c4a35239\",\"/knowledge-medium/pr-preview/pr-1790/src/data/typesPage.js\":\"e51c1062d0e4b269\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userPrefs.js\":\"a7573d5eafc94df7\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userSchemasService.js\":\"28cc1c8fc4265546\",\"/knowledge-medium/pr-preview/pr-1790/src/data/userTypesService.js\":\"1ea7853fa0f44758\",\"/knowledge-medium/pr-preview/pr-1790/src/data/valuePresetRegistry.js\":\"d2d47112d969656c\",\"/knowledge-medium/pr-preview/pr-1790/src/data/visibleChildren.js\":\"0146d4b5e08de47e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceConversion.js\":\"17d2288f874fbe59\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceFirstSync.js\":\"6befc57cf35fe32d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceIdNamespace.js\":\"9c4fd07f9bbbc351\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaceSchema.js\":\"8d063e8d9b07f31e\",\"/knowledge-medium/pr-preview/pr-1790/src/data/workspaces.js\":\"9ee4295e956d329d\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadLog.js\":\"53da61cc8dc370a4\",\"/knowledge-medium/pr-preview/pr-1790/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/BlockPasteShellDecorator.js\":\"dcc59318e497fd45\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/atTrigger.js\":\"ac5a98af36bcf415\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/autocomplete.js\":\"e0dde491e4b9d9bb\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/codeMirrorExtensions.js\":\"c7ec5993ee88390b\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/contentFlush.js\":\"cc7ebee5ea12eda5\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/defaultInteractions.js\":\"c1b93d611e613061\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/editSettleSignal.js\":\"0b39885716f0e0e5\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/insertImage.js\":\"90aef4e2e5aa896b\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceCompletionRange.js\":\"e5ef264c7465728c\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/referenceTargetTypes.js\":\"f84d7424f6c0bf8e\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/syntaxContext.js\":\"020f62987fea2437\",\"/knowledge-medium/pr-preview/pr-1790/src/editor/triggerMatch.js\":\"012e3703f47da80f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/AppRuntimeProvider.js\":\"36b1d81fb741f2c1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/BlockFocusShellDecorator.js\":\"0f461c67f8378e61\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/ExtensionRenderBoundary.js\":\"6fdde38c55532c74\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/PanelContentRecovery.js\":\"be5769ca8b0dd866\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/apiCatalog.js\":\"252392ac30dd459d\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/approveExtensionHere.js\":\"0ccdcb759fe248eb\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/armedCutAppMount.js\":\"e81166f8d22a8f6b\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/batchableKeyedStore.js\":\"4767c14f53fca724\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockInteraction.js\":\"767fdce3251f1a2c\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/blockSelectionAction.js\":\"257a3e22acf3c3ed\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compileExtensionModule.js\":\"8ec68d175cc75bf7\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/compiledModuleCache.js\":\"9b66113daa075783\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/continuousGestures.js\":\"91653499eff4c89a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/core.js\":\"659caec82c486162\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/defaultRenderers.js\":\"07acf767e45b2639\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/definitionFanoutAppMount.js\":\"d37f05e7868fe864\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dialogAppMount.js\":\"5fd4b425d9532100\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensionSeeds.js\":\"03d10017b267ad32\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/dynamicExtensions.js\":\"689d014b062e577b\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/exampleExtensions.js\":\"af7b3a69108b4198\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionApprovalStatus.js\":\"d65267d0a8d70963\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrorToast.js\":\"53399cc9011aa623\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLoadErrors.js\":\"db4e9ddc141855f9\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionLookup.js\":\"9c882e88621d3b7f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionToggles.js\":\"5d4b148868887255\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/extensionUtilitiesCss.js\":\"6e4ab38926dfcef4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/kernelPageDeletionGuard.js\":\"3bc74d78ed83b46e\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/liveRuntime.js\":\"f0b36eb84f32a2c9\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/openExtensionsSettings.js\":\"ef93ef289c936a0a\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/overridesCache.js\":\"d593637db4439923\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/pluginIds.js\":\"9b490b73d5f0b3e1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/processorRejectionToast.js\":\"0668d06d321a0bc1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeActions.js\":\"398aa383d9bb7597\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/runtimeContext.js\":\"c033ed3ebb6e71a4\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticAppExtensions.js\":\"49549dacb2bfcf83\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/staticDataExtensions.js\":\"95e5dce23c37f18f\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/toastAppMount.js\":\"77bc67a2e3eeb569\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useOverrides.js\":\"c53eb303708245d1\",\"/knowledge-medium/pr-preview/pr-1790/src/extensions/useShortcutSurfaceActivations.js\":\"dd21cc774e78ac02\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/discoverToggleTree.js\":\"c42e2834aa092d40\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/facet.js\":\"927e63695bf9e279\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/resolveAppRuntime.js\":\"946b979463381453\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/runtimeEvents.js\":\"3fa2e2a8a53de585\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/togglable.js\":\"6654e9407421c503\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/variantFacet.js\":\"55c2dadb398b712d\",\"/knowledge-medium/pr-preview/pr-1790/src/facets/verbFacet.js\":\"8a9ba4958a611181\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/block.js\":\"3ce9570a8dffee47\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/focusedChild.js\":\"a17398910458480c\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/propertySchemas.js\":\"bfb958640c2fe199\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/typeRegistry.js\":\"6f73b22153a1ad70\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAncestorCrumbs.js\":\"bfe6e541e0bed335\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useAutocompleteListbox.js\":\"022fba8bab9dbddd\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedSearch.js\":\"9858e3df4e9467c4\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useDebouncedValue.js\":\"c0037911137b70c2\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsFocalRender.js\":\"b399ce12ed3dff59\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useIsReadOnly.js\":\"d47f5d3a89d07e9e\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMaterializeBacklog.js\":\"fe18e28488a9de6d\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useMinuteClock.js\":\"815117cde59becab\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePanelLayoutProjection.js\":\"5107e8193690c48e\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/usePendingInvitations.js\":\"2a3167d18aca6efc\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRendererRegistry.js\":\"dff11312b195c999\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useRetainedFieldRows.js\":\"93e9f02f8bd374c6\",\"/knowledge-medium/pr-preview/pr-1790/src/hooks/useWorkspaces.js\":\"a26e3f6beb5e7e7b\",\"/knowledge-medium/pr-preview/pr-1790/src/lib/utils.js\":\"0ad02e95469640c9\",\"/knowledge-medium/pr-preview/pr-1790/src/main.js\":\"f9cd49a54f420ce0\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/MarkdownImage.js\":\"6fa449507a8e1e0b\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/blockSeparators.js\":\"77deb60b1a902b84\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/context.js\":\"412f2dfa2a5a79a6\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/defaultMarkdownExtension.js\":\"34a33ebebcbf1065\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/extensions.js\":\"90c9a54b13be52df\",\"/knowledge-medium/pr-preview/pr-1790/src/markdown/renderMarkdownHtml.js\":\"f1ac07bbabcd6ec5\",\"/knowledge-medium/pr-preview/pr-1790/src/minimal-editor.js\":\"cae52e6f68277ead\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/armedCut.js\":\"8f42257f614b428a\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/captureMediaVerb.js\":\"68c5ea76cd75d107\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/clipboard.js\":\"ab53a8b773e5c80f\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/decision.js\":\"5753026382dc0a68\",\"/knowledge-medium/pr-preview/pr-1790/src/paste/operations.js\":\"d6b1f356fd1d0316\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/AccountHeaderItem.js\":\"d71aac80cc946fce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/account-header/index.js\":\"94cb83d857b1f0de\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"724e36b791b2664f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askAgent.js\":\"a42f21f8319d6422\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/askedStore.js\":\"e5c8f22f01a7b0d9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fad6ded912febda8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/chipState.js\":\"7301932c68b62f19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/dataExtension.js\":\"30abe6e9b3b39831\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/index.js\":\"960725aa2779d0e0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1821aee5644f2654\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-dispatch-companion/schema.js\":\"9f419c361b43e629\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/AgentTokensDialog.js\":\"37e1751f90ebfde6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ab2a29d84608e7f8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/addMedia.js\":\"e8bf05c9ae5f2b1d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/backlinks.js\":\"66ded88b50b3b9be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/block.js\":\"1db1d52e16fba97f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/context.js\":\"f187638cca5bd5ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b9f673c25914a12f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/index.js\":\"a1796c8578086220\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/outline.js\":\"57ad5554fd8a597f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/properties.js\":\"605517eb350c5314\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/refs.js\":\"3e73bb9c350c84f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e241599886b418cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/search.js\":\"cb2003114f3c22c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/shared.js\":\"84024a880a0e6f1d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"97fcded93f893929\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentViews/text.js\":\"9476c70183a1b670\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/agentWrites.js\":\"f741157ac741d251\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/authoringCatalog.js\":\"b5607b7d396398b1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/blockRefTargets.js\":\"ee609aefc1fe4046\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridge.js\":\"63f00a0e49a2dc80\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/bridgeLoop.js\":\"bc86d18d6f9dff41\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/changeHistory.js\":\"395a83fcba4843f2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commands.js\":\"d53e8918d639d3a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/commentsCommands.js\":\"b0eeceed662a0fde\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataExtension.js\":\"7f6a79d179ab78a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/dataModelGuide.js\":\"686a80771474b1b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/describeRuntime.js\":\"a753a4321327dcf2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/extensionLint.js\":\"9b9a093dd31716b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/grainAudit.js\":\"52748630d90c333e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/healthCommand.js\":\"fd0f9af3ad5fe8a6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/index.js\":\"e4c9ee606c791b83\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/presetIdentity.js\":\"37909ac9de43f36f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7434b064b71afec8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/readMedia.js\":\"b700e1585b41d5cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/schema.js\":\"a11f8c9faf41534b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/serialization.js\":\"b0360ac41ec5e432\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/targets.js\":\"4ba464a710b58914\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/tokens.js\":\"85d751d33bab8fab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/watchEvents.js\":\"3cbc49cfe7aee095\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/workspaceGuard.js\":\"c1927ec9cf82d1a0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/agent-runtime/writeCommands.js\":\"cad09691cbac73ca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/AliasCollisionToast.js\":\"529d905140439b1e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/DuplicateNameBanner.js\":\"bcd2fb3bef76657e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/collisionMerge.js\":\"62a85425e637dbab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/dataExtension.js\":\"af22cfb4d4f332e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/index.js\":\"e87ba0c813d87748\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/mergeCollisionAction.js\":\"3f1beb6432306dee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/pageStyling.js\":\"165b7e6e0c391f9a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/rejectionToast.js\":\"a70b988bc8e9d84e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/alias/syncProcessor.js\":\"ef97a1cf76252433\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/actions.js\":\"a2e87f2c07904b19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/addComment.js\":\"fcc67df006815a6e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchor.js\":\"0b702ae9746450b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/anchorState.js\":\"401706437910a5f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/commentLinks.js\":\"a3a93d97e36fb101\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/confirmThreadDeletion.js\":\"238fcbdf81d4f027\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/container.js\":\"419f7686a3601ce7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/dataExtension.js\":\"257c1d5edb4a5305\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/deleteComment.js\":\"83c6a050012104a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/highlights.js\":\"5a28fd7dbc7aff43\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/index.js\":\"31e4dc44a1c81932\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/linkedCommentsPill.js\":\"2311f4d6a2a3cbf0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/margin.js\":\"eca77951eba0a87f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/marginSchema.js\":\"a509a4a5488b1fcc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/newComment.js\":\"e83a28f000602ff1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ownThreadPicker.js\":\"882a89997d721815\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/placement.js\":\"80e18f1be3c181ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/queries.js\":\"8e5cd3e3c49672ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotePosition.js\":\"2d2c7141262a7278\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedIn.js\":\"093a26482eba40fe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/quotedRange.js\":\"5d7fcbb70611d834\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/rangeRefs.js\":\"98fa659209002a55\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readHighlights.js\":\"5c377ccde91a7c68\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelection.js\":\"922aa3fc2a189970\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/readSelectionUi.js\":\"8993ffe6cbcf84cb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/reanchor.js\":\"cb10cff7692cdd8b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/schema.js\":\"64e9e854e10a2c77\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scope.js\":\"a7e52ebcd12f9c49\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/scopeThreads.js\":\"8601e71af5c80dad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/splitRetarget.js\":\"15176f2db6d84ab7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestionCard.js\":\"859076722688813e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/suggestions.js\":\"5ccea78be85767bf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaries.js\":\"ee2831c57cf025c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/summaryBatch.js\":\"c7336130f56925a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/surface.js\":\"590ab51e358971e0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threadNavigation.js\":\"979b88aeed695a33\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/threads.js\":\"85cbbb8c3d4b1edf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/ui.js\":\"6f1065be3316a729\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/annotations/uiStore.js\":\"6f0bd2cd9b317a59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/appIntents.js\":\"a1bd9d63ae59d768\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-intents/index.js\":\"e2637d60294de775\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/index.js\":\"442b8a9a9d1e9a2a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/app-update-prompt/status.js\":\"2948222a5b23362c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"796716b2634087a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaBlockRenderer.js\":\"7d5ae357017ea083\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaDownLaneReplicator.js\":\"769436fe183f1dca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/MediaUploadReconciler.js\":\"c124884130ec97f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetDownLane.js\":\"3d03dc8b82cf8dbe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetResolver.js\":\"9b832e281beff820\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/assetUpload.js\":\"160d5b280efd3a43\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/attachmentCleanerIO.js\":\"27e4e6e61cb9dc65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c176aaafdc024828\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/blobStore.js\":\"6beb3c711a28d89f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/byteStore.js\":\"839c7e6a9b137558\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanerIO.js\":\"56b099e1090b2c6d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/cleanupAttachments.js\":\"474cc5ccc18db616\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/dataExtension.js\":\"48c98738a9696611\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/downLane.js\":\"be152a65ec187073\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/index.js\":\"756c6cda27669f9b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/insertImageContribution.js\":\"ff3dd6ca40f92464\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneArming.js\":\"44fbf7e98ca8ef54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/laneLock.js\":\"b8f987c33881a5c2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaBlock.js\":\"ddc26519354a686f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaCapture.js\":\"3d6e47b459d2448e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewers.js\":\"940b69af93efceea\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/mediaViewersFacet.js\":\"1038294feaa7d8b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/pasteCapture.js\":\"b443c4bb4dad6d8a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/resolver.js\":\"a05153db2363f039\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/retryUploadsAction.js\":\"36517b002b846bfb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/storagePaths.js\":\"e467b54d7ad3d302\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadDrain.js\":\"705ff1f76c85f179\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadLaneStatus.js\":\"51ae168ed0dd418f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadReconcile.js\":\"c71a18f5947b1217\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadRecovery.js\":\"9dcbbf5aba0b4f35\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/uploadStore.js\":\"192ff7786153366a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/attachments/useAssetObjectUrl.js\":\"f34da22b117158be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0cbc4d84210ba087\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c16d95384fde923d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/facet.js\":\"3dfc9547a2a6ca65\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/index.js\":\"f2c86a80ad4c4ac5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks-view/prop.js\":\"f1694ecb83ccaf27\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinkFilters.js\":\"47915b3a81036a49\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"83c82270730fd309\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/BlockEntry.js\":\"886899850e57cf72\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/LinkedReferences.js\":\"20e7b361b72bb8d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3af330e73af74c13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dailyNoteDefaults.js\":\"c784add3002d7619\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/dataExtension.js\":\"d27245713255924a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/edgeExclusions.js\":\"b93b17e34aef7f04\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/filterProperty.js\":\"5da35b99a2090711\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/index.js\":\"d706ae39bc0884ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9be5536311bd40ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/applies.js\":\"d01acb3ee931f246\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/countQuery.js\":\"92c9b3ddaa53f97b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/expansionStore.js\":\"552888ab02bb5c78\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/index.js\":\"935e13c8a845f583\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3cc46ae573ad9cf9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/presentationInvalidation.js\":\"71b7e51804a5507b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyEditorOverride.js\":\"7f0b6f20d064899a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/propertyFilter.js\":\"37aa46029ebaf0b4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/query.js\":\"69a40ea5f6071924\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/resolveFilter.js\":\"db90e619aab516e2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sourceBatch.js\":\"5b77b4a21babd957\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/sources.js\":\"7b2912f5d0e22e6d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useBacklinks.js\":\"28bc9c88cd3e5034\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0f34646b137a3ba4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayCelebration.js\":\"8765ed94488ccdfa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/BirthdayOverlay.js\":\"432eb653154bc575\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/gate.js\":\"75f78a9bd574e931\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/index.js\":\"3500ea73d16e6272\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/birthday/wolfTheme.js\":\"f63923977ea5a796\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/BlockDragLayer.js\":\"09456ee90db2109e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dragController.js\":\"1c1a664d0447a979\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/dropTarget.js\":\"9d99a2ae0f2fe84f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/index.js\":\"a291822cb59afa5c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-drag/projection.js\":\"42c7b4a1209818c9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/BlockMetaCard.js\":\"4d9791606c74ec7a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-info/index.js\":\"622df14477ef87a1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/AddTagDialog.js\":\"fc4e3270f1b12515\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"82e8e40c3d084306\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/TagNameIssueHint.js\":\"72174daeb88f0a85\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/addTagAction.js\":\"a4ad6aa34ab45dba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/appendTag.js\":\"dd4e431e7ef0d54a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/config.js\":\"1601a6ef199fb967\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/dataExtension.js\":\"f42301e25b7d90cf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/index.js\":\"d2dee7074bd0a433\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/block-tagging/propertyEditorOverride.js\":\"3feeeb284b8a278f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c80dabed7da4de38\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1020a55454e17735\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/Breadcrumbs.js\":\"064a8ef7231c3321\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b120ef94b25d2d8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7e7f7224bc158fd0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/index.js\":\"9f74c1b6722d2cdf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0a67bbd4e5664b7e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/CharacterCountItem.js\":\"51ea73a90732734c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1fc529af8ab193e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/actions.js\":\"7aeec0d19cee554a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/blockType.js\":\"d17c4425a930eb9f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/charCount.js\":\"bd3c7359ddab141a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/dataExtension.js\":\"930ecda37d4eec40\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/index.js\":\"e4092a48cad346f0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/profiles.js\":\"b33f133cb6a61d1a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/properties.js\":\"8da3e746e35ffaf7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/character-counter/textCounts.js\":\"d2121042f7e8875c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/colemak-keybindings/index.js\":\"c1ee34e8a47d56aa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/CommandPalette.js\":\"b70f0e5a61027627\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/HeaderItem.js\":\"7d5428a632d44900\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/context.js\":\"bf4fe86259a9dc84\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/index.js\":\"0d191e7294599759\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/selection.js\":\"f907b2d979af714e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/toggleStore.js\":\"7be8cfdd1ce2f536\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/command-palette/useCommandPaletteActions.js\":\"c4484867b1d57a13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/ContributorBadges.js\":\"934cd0139414b926\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/author.js\":\"59a9c5dad6f9eb8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/codeMirrorExtensions.js\":\"a7390b9e70a829e9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/dataExtension.js\":\"4075eb6420964611\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/index.js\":\"dd32142266b3d090\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/mentionAutocomplete.js\":\"c9e5abac199add28\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/processor.js\":\"fbd8c7371652419c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/profiles.js\":\"9b232eb8c8fa7253\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/queries.js\":\"fb917018c3c294ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/contributors/schema.js\":\"735000738b310b20\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c623a30da91cf704\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d4b32ee403862380\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/index.js\":\"18bd8baa59c9b509\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1daaf8be6d92703d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4336def3771a2d5f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/CalendarGrid.js\":\"e2cee5a8d5a45db2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DailyNotePicker.js\":\"f158dc180b66f1e0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a3c0c5b800d400c1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateNavDecorator.js\":\"27495f39aa48749c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/DateScrubOverlay.js\":\"f8382a4af820448c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/HeaderItem.js\":\"4a0939424a8ddd08\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/ReschedulePicker.js\":\"b9cbd2ceb73d8f10\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a328705c07acf261\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/actions.js\":\"616b51a9492b04cd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/blockDateAdapter.js\":\"87b48312c133f98f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/calendar.js\":\"6b8200f64661d309\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dailyNotes.js\":\"620c71f6a8e19478\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dataExtension.js\":\"bee5d00796a69f93\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubActions.js\":\"10af5b212d7d0c4e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGesture.js\":\"7031c4e23052be73\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e9b34f8b47fea4b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dateScrubRecognizer.js\":\"038eecbb765f2569\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/deletionGuard.js\":\"83ad51dc8e63fdb0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/dueQuery.js\":\"4df7d083c1362b62\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/index.js\":\"56014bb8814b2901\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/landing.js\":\"e989cf56965fe673\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/localSchema.js\":\"dbb88875ea3db90a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/referenceDateAdapter.js\":\"4f909619810fb870\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/rescheduleAction.js\":\"bcf09515e7b0e2d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/schema.js\":\"0d397f3aeaedc385\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadBlockDates.js\":\"071dc407f2dba72c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/spreadDatesAction.js\":\"371f59396e94de13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/today.js\":\"335c996e2fbf3cb2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bc8d1f33e69c308e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b465ee1543fb47a3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/audit.js\":\"84224e358a3e8f53\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditAction.js\":\"f636fb759f39b955\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/auditRanges.js\":\"c9cb7dab0bb1ec6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/diagnosticsSource.js\":\"833b3292b626933c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/divergenceScan.js\":\"da68361966be6388\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/index.js\":\"bf70599e17bdd3fe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8107cf02f1dbe1d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/referencesMirror.js\":\"ea76858670d31d62\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/rowJson.js\":\"27a5ef77b0492fcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/schedule.js\":\"34d3373c36bf4413\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/data-integrity/store.js\":\"000e6ff6a27bcc87\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/action.js\":\"5b6eecc091d5fc0c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/index.js\":\"6bdc8456d5c2b198\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-maintenance/plugin.js\":\"5954c26a6bf94eba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2fd3f588f6890d52\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/actions.js\":\"6f518a8b37cdc397\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/changeMarker.js\":\"48a9c074a4674a69\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/diagnostics.js\":\"4e2668acbc6bce66\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/fileSystemAccess.js\":\"fa3da86a69f5813f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/filenames.js\":\"b36757f3c0cd67af\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/index.js\":\"1c8c9ba9dba5d55f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/mirror.js\":\"426e6d1de6a51cde\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runLock.js\":\"f852fbc60af41805\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/runtimeHealth.js\":\"ca848150a09aa173\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/schedule.js\":\"60823993286af2ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/db-mirror/store.js\":\"4d6c21775e34b088\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/index.js\":\"50b7d0ab8afa7716\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/default-themes/themes.js\":\"bf8a2cc2cc2f29dd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/facet.js\":\"7ca92847bb323089\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/diagnostics/useDiagnostics.js\":\"3c8618b0b9184703\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/dismissals.js\":\"3c90fa12c08e07ee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/index.js\":\"2671be0822071423\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/status.js\":\"a421bdb8a6a2e5c4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extension-prompts/store.js\":\"b9b768cb1b6f519d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2d0bf0228dae1bcd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c4a4786d340917e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/actions.js\":\"194e8dc2080aff9a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/config.js\":\"a9097653e2d87ef1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/dataExtension.js\":\"7ecf580a5eb62e0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/effect.js\":\"895f8eadedef80c3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/index.js\":\"5e0b4856a318ae35\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/propertyEditorOverride.js\":\"214d1280c9a65504\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extensions-settings/useToggleTree.js\":\"0add8c7710049e60\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/ExtractTypeDialog.js\":\"bfbdd171a7ab0d8f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"62d94cbe52f8fbd1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/PropertyShapePicker.js\":\"caf0b051157727a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/action.js\":\"62f2ef0011cb09e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/extract-type/index.js\":\"5fbbe287046b9ab3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/FindReplaceDialog.js\":\"e4923b1e5db4e316\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/HeaderItem.js\":\"bcf780e11555ae17\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/dataExtension.js\":\"625f9533187068af\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/index.js\":\"8edc5028c8b92302\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/search.js\":\"488a25ff9904369e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/toggleStore.js\":\"4fc68a6121dc4efd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/LocationPropertyEditor.js\":\"31472e991a58002e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/MapView.js\":\"35c392a5aaa641a7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/blockTypes.js\":\"7d55258d25b848ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/codeMirrorExtensions.js\":\"87103f1d1f8acd13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/createOrFindPlace.js\":\"a7a3227fb9039ecc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/currentLocation.js\":\"cb48ad6c5aabc24b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/dataExtension.js\":\"95a1fcc1edf486fb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/geoContentDecorator.js\":\"e1981f6c7ce76e1b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/googlePlacesClient.js\":\"876a34b439527194\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/index.js\":\"9c4890263143852d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/locationsPage.js\":\"76e6e6dfb5bc2f81\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/mapViewport.js\":\"11e83b4a82875a76\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/pickCurrentLocation.js\":\"cb9fee49ff50a19a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeAutocomplete.js\":\"d3217b98476ed78c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/placeNameCollision.js\":\"048abb6f7d68321a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/properties.js\":\"b0fe867da0b79cf8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/propertyEditorOverrides.js\":\"81548ea5a688525b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/query.js\":\"557665eb269b11db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/geo/usePlaceSearch.js\":\"8a7c0812d5a38836\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c277e4d4b7954028\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"730f025775d5eaee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"917bad1aac7d5393\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/config.js\":\"605a3a32214aed59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/dataExtension.js\":\"cc6f30503da2678c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/facet.js\":\"3fe495003b2ef5b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/grouping.js\":\"b856cefae4c59252\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/index.js\":\"c44f76a784297cfa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"25df487e331a52d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/query.js\":\"db2b30566d574b4b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/resolveConfig.js\":\"ed92876b0755f646\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bc68fe7dc77c2cb1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b41942b5606ece85\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlDocumentContent.js\":\"e70a456bc95c7a61\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/HtmlFrame.js\":\"a08a770d36272c94\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/actions.js\":\"927460a67c938d26\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/blockType.js\":\"64d55dbcacc3101d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/confirmRunScripts.js\":\"ce328949937af05d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/dataExtension.js\":\"297ac0f5becf5e1d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameAnnotations.js\":\"6cb25ae3c15d7a98\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameDocument.js\":\"1b3d89ca804f3148\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/frameTheme.js\":\"1cab568c5816576f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/index.js\":\"79530fd4c5e20df6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/scriptConsent.js\":\"867c5592c999fb18\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/sourceMap.js\":\"21f98825a24c355e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/html-document/useDocumentScripts.js\":\"472f29773621404c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/index.js\":\"2365e1af911b9dae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/record.js\":\"ef41c68bc9e81697\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/recordStore.js\":\"770cb157d9bb2ab5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/responsiveness.js\":\"0ffc209a58ad2fab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/schedule.js\":\"a2fb648732778105\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/interaction-metrics/sessionContext.js\":\"c4b97e339d9ed414\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1ec7d40c8e4d2512\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d9f53237fe096844\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/actions.js\":\"27e2136d02bb05a0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/config.js\":\"fd9d5d4152f90071\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/dataExtension.js\":\"17dca50a210dedf2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/effect.js\":\"05781a952e90934c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/index.js\":\"f56daf8fc1307eae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/keyCapture.js\":\"e9017a3ab15a6950\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/overrideStore.js\":\"317d7edbf5616160\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"79725b9d10f65ff3\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/HeaderItem.js\":\"bdfc2b236e4129d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/LeftSidebar.js\":\"e3c5d80b51a72f4a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/actions.js\":\"8d0f5c53a866d820\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/facet.js\":\"c2aa8037940f3901\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/index.js\":\"dba2b855cc937e3e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/shortcuts.js\":\"e85bfc32f42414e2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/left-sidebar/toggleStore.js\":\"b456e021e3446123\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/MergePicker.js\":\"c426f712b57d3263\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/index.js\":\"5f0a05d8fc03e8c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/mergeAction.js\":\"d3ac4cde3a2aa2f6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/merge-blocks/strategy.js\":\"591b63b66a631b13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/Button.js\":\"50cc785af84a45b9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"072840c32be94e17\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a8b0e1b4eea92ce4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/facet.js\":\"0b00d1a5178cfd14\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-bottom-nav/index.js\":\"00224afdc117758c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1b43e60ab66a80f4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ab5869e832ff45dc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2b57a233bf4d774e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/facet.js\":\"fd525bd119affe42\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/mobile-keyboard-toolbar/index.js\":\"e942f097f93ca756\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3ca142b37e9fb747\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/blockSubtreeMembership.js\":\"73f7d68dd2af4e0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/contextMenuItem.js\":\"d05e3186a00d8971\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/index.js\":\"a0bbc7080461913c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveAction.js\":\"332e41901edfdc19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/moveBlocks.js\":\"6329761e7c11d480\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/move-blocks/selectionAfterMove.js\":\"bc85d8c5e831b011\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/TutorialBanner.js\":\"9ad95762ead7f54e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/action.js\":\"0df95e69396c7f19\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/bannerDismissal.js\":\"683732d9feb679b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/documents/cheatSheet.js\":\"d1ada1c4c621fe21\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/index.js\":\"7d1b8a04a396f2c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/keys.js\":\"a4ab265182ac5786\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/landing.js\":\"599905d1b9a317c0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/outline.js\":\"bdc599b381e58caf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/onboarding/seed.js\":\"c44091fb650ec7fe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4a24bb559dc27507\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/analyze.js\":\"cd92c64f27761535\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/diagnosticsSource.js\":\"c13e82a17918a0ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/index.js\":\"41de0e77d606973b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/load.js\":\"dafa68cccaed5201\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/monitorRun.js\":\"5a2253f4f3d26a0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/schedule.js\":\"8ed8c75d943bce83\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/series.js\":\"45795fd46f4ae161\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/store.js\":\"713a71ada4d8fa0a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/trendAction.js\":\"04f4e4278b2dd1d2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/perf-monitor/verdict.js\":\"773b164b33dd5892\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/clickToEditAction.js\":\"e4a7b325763c07b7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/index.js\":\"3a452299fa62b3d7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/plain-outliner/interactions.js\":\"df7a530325a11c55\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"dedb3a565ba0420a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGate.js\":\"52577715cc3bf3e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/MigrationGateDialog.js\":\"9c25780613d8e690\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/action.js\":\"36a89b757a164ccb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/index.js\":\"943f1609baedc9f9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/localRunMessage.js\":\"b5fce203a2c6e16b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/plugin.js\":\"48dfb81643a76bee\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/progressReport.js\":\"8c8ce9074a5d5b09\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/properties-migration/sweepProgress.js\":\"b96bcf9aa1953b54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/FieldRowRenderer.js\":\"bba4b387e9af712f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/ValueRowRenderer.js\":\"b6ec621342dcf948\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/actions.js\":\"586ed6de15b2abd7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/autocomplete.js\":\"ce45f3f329a13db0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/fieldRow.js\":\"75ce81e5623aca22\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/index.js\":\"e4844c2b66b818eb\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/referenceWarning.js\":\"f3d6e98ff0bb6487\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueAutocomplete.js\":\"cfcefeba7285add7\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/property-rows/valueSchema.js\":\"5e656889f8e7bbad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/HeaderItem.js\":\"601b5381fe7c1ba8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/QuickFind.js\":\"d18c116f76bdd4d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/index.js\":\"fd3709054860916c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/recents.js\":\"1f74776beb31c5e5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/resultItems.js\":\"574b1e6ced5c123a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/selection.js\":\"96c5a3fa84ff44ad\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/quick-find/toggleStore.js\":\"8f1c59febb467317\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/HeaderItem.js\":\"1d7fc62d85da5e4b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4faf2e9b82fc65d5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/grouping.js\":\"4e7c4db1c0d943a8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/index.js\":\"e24cdb05dc4820fc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/recents/target.js\":\"eb63ad7fab930c64\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/codeMirrorExtensions.js\":\"4ab2b07242dd0a38\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/contentPrefill.js\":\"b048ad0adb1b8246\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/dataExtension.js\":\"a511e1a3459cb1e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/index.js\":\"b20ed228064d1f4a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"59216af182519173\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/invalidation.js\":\"f1ad00c336ca6162\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/localSchema.js\":\"98aba11a20734a5c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/index.js\":\"e268ef9ebe3b2eba\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6eef3a8981ab402d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/index.js\":\"d6d279106e5f1382\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/referenceNode.js\":\"fc9a1e40ba8726ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fce2ebdca9845563\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"858c039bdd5702d2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/index.js\":\"5bc81494fe574d0f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d530621002a04e5f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fcfbd6270419ab8b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/mergeRetargetProcessor.js\":\"8b9ccff7df680ae5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/parseFence.js\":\"e63919d2b2259def\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceParser.js\":\"c9e21a4d1133816a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referenceProjection.js\":\"a1e40418c7a7b890\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/referencesProcessor.js\":\"d36242110f892afa\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/renameProcessor.js\":\"ab36b872588de0e5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/references/spanReplacement.js\":\"cd22ae2bc41ba6ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/htmlToOutline.js\":\"bd35c93606957a96\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/index.js\":\"e13b9a93edd45f39\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/normalizeClipboardDom.js\":\"528d201d0ef4fc8d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/rich-paste/pasteDecision.js\":\"8c0951eafb27c74e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/action.js\":\"5b8c0ef7c350e195\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/blockIds.js\":\"948311beef089d22\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/content.js\":\"0ae42ba2bb10f308\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/effect.js\":\"2cd331d47e373efc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/ids.js\":\"9b10db6b8abb8347\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/import.js\":\"0c6d5511759978d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/index.js\":\"8636f5c34022edc6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plan.js\":\"0c9ac380f451ff3e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/plugin.js\":\"be760e1f088e410b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/promotion.js\":\"5ee64b08f358dce6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/properties.js\":\"c23667249061311b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/references.js\":\"d6df603a4f68f72a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/report.js\":\"eb60ad95028e39ac\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/roamMemo.js\":\"0b74b1c473969c74\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/runtime.js\":\"195962b4b123eb6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/schemaReconciliation.js\":\"a9f53c2fb9b3759c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/srsMarkers.js\":\"99c39af3668fee7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/todo.js\":\"4d57995fa1b46aa9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/typeCandidates.js\":\"13a4c5f4ec1a9d0c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/roam-import/types.js\":\"6062e9237ecf6400\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/index.js\":\"44f1826f01e2a6cc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/search-health/store.js\":\"50a0209d0d40afbe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/HeaderItem.js\":\"7ce25dddb938f368\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"93e09da76555f04a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/index.js\":\"b3ee4f61aff95965\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/model.js\":\"1fd8aca1d0752002\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/toggleStore.js\":\"a3e93b012e95ff8e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/shortcut-help/useKeyInspector.js\":\"16183bfa3ac4160e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b3955c7dbd51913a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/ShellDecorator.js\":\"b4701d53b18bc561\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/actions.js\":\"24afefc98eccc067\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b0f605d2dd2814b5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/index.js\":\"8270bf4e46b84233\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/shell.js\":\"c9e498ac3c99712b\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/surface.js\":\"b9b8a119458131ed\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/spatial-navigation/walker.js\":\"96953e1558bb42d4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f4ca39225749ff91\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/dataExtension.js\":\"c90ef24c48e1eb43\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/index.js\":\"adcbcc29b76da399\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/indicator.js\":\"32931a2f12d98ef8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/moveSrsState.js\":\"9453185a4dc09e5e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6452b0af17dd5898\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/scheduler.js\":\"4f6875c96b73c732\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/schema.js\":\"ade74bccf6582f36\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cc41ec0c6f59ba39\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/srsClipboard.js\":\"3412252d0c1bd9f1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"86d596d82f319e6f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DailyNoteReviewHint.js\":\"932f6a3f298a5b02\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/DeckPicker.js\":\"d39ae9559c3131a4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewControls.js\":\"47709f29ff504d03\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2fa9b50577d00fca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/ReviewSession.js\":\"fa6d158ff50ea8be\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/actions.js\":\"432db826c348a6e6\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/archive.js\":\"1e4ac6c8573f2ee8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dataExtension.js\":\"823c1da2e9f3bdbc\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/deck.js\":\"13ddf35e698546b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/dueQuery.js\":\"75616b83031665fd\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/gradeDecision.js\":\"f84d34b95df5f1c4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/index.js\":\"39dcdeda4d219782\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/keyHints.js\":\"0111579e8901e999\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewCardLayout.js\":\"53994c0c0e2871db\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/reviewProgress.js\":\"859046ff451a6e38\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/schema.js\":\"53732afe56ef6053\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/srs-review/useDueCards.js\":\"bf14594347129065\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/index.js\":\"ee326407faf76d54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/startup-metrics/record.js\":\"91ebc299c355903e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/index.js\":\"7fea85b7df5eedd9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/persistenceStatus.js\":\"61de1fb9e37dbdb9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/storage-persistence/requestAction.js\":\"d7e286555a0cb1ce\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/TypeChipsDecorator.js\":\"4cc3005acb8c086d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/codeMirrorExtensions.js\":\"ec5028f1c245d79f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/index.js\":\"65e5346feebb4660\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/supertags/typeAutocomplete.js\":\"50928612a2a2941d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4a30f9d832f65ab5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/actions.js\":\"681ae43a633d5f0d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/anchor.js\":\"b226523be84957e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/events.js\":\"ccca563eb5abe4ec\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/gestureActions.js\":\"00be143299d4d8ae\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/index.js\":\"0d8e7c93cbe34d7f\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d5a3fae640f1e25e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/collect.js\":\"86da9bb0357348fe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/index.js\":\"cab48777fb0a1868\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/sync-metrics/record.js\":\"b97770c9119eb06a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/RejectionDialog.js\":\"f087d6faaad75ed9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/SystemStatusHeaderItem.js\":\"295721cfc2302ea0\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/index.js\":\"1dd82b34aa5cb397\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/model.js\":\"ae7ae42aa5900317\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/queueCounts.js\":\"098abb3f843180b8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rejectedHelpers.js\":\"8d190b99f4753c13\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/rematerializeAction.js\":\"6c156fddb9e15469\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/system-status/useHysteresis.js\":\"556a103fb713d3ab\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/effect.js\":\"7eab6a66808fee54\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/index.js\":\"0410a8aaec2435a2\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/theme-toggle/theme.js\":\"add85eeb8235b72e\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/actions.js\":\"de0268621ad87424\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/dataExtension.js\":\"525d054b770445d9\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/index.js\":\"dc682fd0b518632c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/todo/schema.js\":\"28f1954f63d246fe\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4a98d8cd5312bb43\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/actions.js\":\"f45352164f0daeca\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/defaultItems.js\":\"87b9ef97ed9410e4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/facet.js\":\"2b59131c5cabfe00\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/holdRecognizer.js\":\"5aac1d88b957ccd4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/touch-selection/index.js\":\"7133a9da49e5b064\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/UpdateIndicator.js\":\"58ee3aa53e80af59\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/index.js\":\"253682a001a1e407\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/update-indicator/loadTimes.js\":\"ef4fcdec4267eb8a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoNotesRenderer.js\":\"5783f4d4bcaf8fa4\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoPlayerRenderer.js\":\"05a56df40404d2c8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/VideoTimeStamp.js\":\"0d52e5c536f365e8\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/actions.js\":\"a6705c9303a38605\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/index.js\":\"ebca04829b28dddf\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/markdown.js\":\"10aa414610723494\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/notes.js\":\"8cee9d5cfe92a7f5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/registry.js\":\"c70b3395f5252681\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/remark-timestamps.js\":\"42c0a1d634c70a47\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/video-player/view.js\":\"4742f980a47b040d\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/LinkHints.js\":\"12f41e3989013831\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/index.js\":\"a51fb630e98738f1\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/model.js\":\"038089626ed8e1c5\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-link-hints/settings.js\":\"f15717edf57bac71\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/actions.js\":\"e5893484f8d0644a\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/index.js\":\"75754819a4315211\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/vim-normal-mode/interactions.js\":\"3f72fd83557ae18c\",\"/knowledge-medium/pr-preview/pr-1790/src/plugins/workspace-header/index.js\":\"8220890443a84eb2\",\"/knowledge-medium/pr-preview/pr-1790/src/registerServiceWorker.js\":\"9a4a50d7ecbc143a\",\"/knowledge-medium/pr-preview/pr-1790/src/requestPersistentStorage.js\":\"47c56dbb80a87e5b\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authRequestDeadline.js\":\"476212a6392802e9\",\"/knowledge-medium/pr-preview/pr-1790/src/services/authStorage.js\":\"c0d063717c61e3db\",\"/knowledge-medium/pr-preview/pr-1790/src/services/powersync.js\":\"899b4af9e02fbe42\",\"/knowledge-medium/pr-preview/pr-1790/src/services/supabase.js\":\"b17fc524b7ad85e8\",\"/knowledge-medium/pr-preview/pr-1790/src/services/uploadErrorClassifier.js\":\"17c893d81125c100\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/ActiveContexts.js\":\"75da7dec1370cc08\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/HotkeyReconciler.js\":\"923dccff9da1d1c0\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/WipeLocalDataDialog.js\":\"12f44cae2dba2750\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionDispatch.js\":\"1b22f4fec505ed8b\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/actionRefItems.js\":\"4afc975465e7a2f6\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/applyKeybindingOverrides.js\":\"41d49ae204928c0e\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/blockActions.js\":\"64cefec0c510e6b9\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/canonicalizeChord.js\":\"387d477bbb7d2732\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultContexts.js\":\"67e03a0a12513833\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/defaultShortcuts.js\":\"3db2b060ec779abd\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/effectiveActions.js\":\"94c3367724ded2e6\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureAction.js\":\"e3f4fac89f310569\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/gestureBinding.js\":\"00db3c3faacb429f\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/holdRegistry.js\":\"f38d8dad23342b0d\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingConflicts.js\":\"dcd48f2d05b76c48\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/keybindingOverrides.js\":\"1253670f54ade8fb\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/pointerAction.js\":\"d83a203086ad0746\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/resolve.js\":\"4a0602071cb859f7\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/runAction.js\":\"8ecc42590179e2bc\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/sequenceMatcher.js\":\"0148a2679c9bdd57\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/types.js\":\"927bf1a7b7e6df43\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionContext.js\":\"6c54a1dc1fbac3e0\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/useActionDiscovery.js\":\"ad74a83b50b50c5f\",\"/knowledge-medium/pr-preview/pr-1790/src/shortcuts/utils.js\":\"ae96b132285d2904\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/bootStore.js\":\"9b30e417baf8a4f0\",\"/knowledge-medium/pr-preview/pr-1790/src/sw/previewDatabases.js\":\"edaaf7de4e9574a3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/byteTransform.js\":\"96066df9950eb330\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/attachmentCleaner.js\":\"70e58f7378f1e7f8\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/attachmentParts.js\":\"26c8a84ec10510f1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleParts.js\":\"954d3250c201c1ea\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/bundleRecord.js\":\"3e9546c728167a13\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/manifest.js\":\"ac35752c5c4c3ae8\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/takeBundle.js\":\"16a38b2261b91ceb\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/bundle/verifyBundle.js\":\"514404469512cf5e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/cleaningStage.js\":\"6c81c1d91d89c556\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionKey.js\":\"8d9b8e1e02a94a02\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/conversionServer.js\":\"612904c78894d47b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flip.js\":\"413c160e68f296bf\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/flipAttempts.js\":\"c8626e94734dfe23\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/pages.js\":\"c47d7a748bc54a1d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/preflight.js\":\"a151e22950bafe42\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/reseal.js\":\"7ed8593d7d64bacc\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runConversion.js\":\"ab07d1ef1bbe20d7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/runLock.js\":\"a5f52c8e543ed50d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealing.js\":\"5d148bd865082912\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/sealingStage.js\":\"723c9a040eaafa21\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/stage.js\":\"3a48dab41b02fe03\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/conversion/verifyReseal.js\":\"ea2429369364ebe1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aad.js\":\"b94b219f5c4723ed\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/aead.js\":\"db74261185e0cd4b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base32.js\":\"5ffde6b2600ab5cb\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/base64url.js\":\"32f6c3c245ffa352\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/binaryEnvelope.js\":\"efcb1ee4ee3c8fae\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/byteAead.js\":\"4cf3d56904a95b54\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/canary.js\":\"99a37e4424576eb3\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentHash.js\":\"ad2e24cf4f6c66ac\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/contentKey.js\":\"14aa097ec748aa67\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/derivedIdNamespace.js\":\"caff02dfc88cdfa1\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/envelope.js\":\"048b92be6b8bd49b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/hex.js\":\"e129d05bbe4b1451\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/sha256Hex.js\":\"a0ac1fd89f378f0b\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/crypto/workspaceKey.js\":\"ec753a166110bd1e\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/conversionState.js\":\"70d0dc752af9531d\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ddf0a37abe347b2f\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/pastedKey.js\":\"050759c47b7778fb\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e8a3f0c4f89e7052\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2541b2142e658724\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/keyStore.js\":\"57a67b52c1587ed4\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/mintWorkspaceKey.js\":\"e2e5352e9b5d7916\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/modePin.js\":\"185fe84a026ce83c\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/openWorkspaceKeys.js\":\"d18b3f7bd5407e52\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolveWorkspaceEntry.js\":\"949764b2bfed0166\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/resolver.js\":\"9e8d4b96e3df6fe0\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/keys/workspaceAccess.js\":\"53d0a2ece3f9c6d7\",\"/knowledge-medium/pr-preview/pr-1790/src/sync/transform.js\":\"dc34cb665c97e528\",\"/knowledge-medium/pr-preview/pr-1790/src/themeBootDefaults.js\":\"e9bc0c8f44ca46ea\",\"/knowledge-medium/pr-preview/pr-1790/src/types.js\":\"9eea3409b9faedc0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/ClientLocalSettings.js\":\"391ba359affc29c3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/abortableSleep.js\":\"b47d7509dfd335a0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/array.js\":\"c0fb465f33458ee0\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/backlinkAutocomplete.js\":\"42e0f0025b47d01b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockCrumbs.js\":\"b305dde554736fbc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/blockrefAutocomplete.js\":\"132dacd92b4b00e3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/cadencedIdleJob.js\":\"f15097eb48e1c674\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/callbackSet.js\":\"bf40f3e923052be3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/clientId.js\":\"6b69533769db06d6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirror.js\":\"0afdd3106d8deeee\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/codemirrorCompletion.js\":\"5a2ea86818dd0e30\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/copy.js\":\"b2796b42ab6ff13b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dailyPage.js\":\"4aa6e6b1919f17db\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensics.js\":\"891edd25cf039cb4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dbForensicsHooks.js\":\"0f77ff7ffc543222\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/deleteBlockThroughUi.js\":\"62c1e43d97ebd578\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dialogs.js\":\"e5948fc21ba596f3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/dom.js\":\"aae83808a1a807c5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/downloadBlob.js\":\"d3076ee0afb1eae4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/exportSqliteDb.js\":\"056d3c3920b49507\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fileSystemAccess.js\":\"409f0ac3a560a291\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/flipSlide.js\":\"b4f57273f62949b9\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fnv1a.js\":\"7cf3ce48c1bd8761\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/formatBytes.js\":\"df93c84149017eae\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/fuzzyRank.js\":\"5464c83ba0d0e686\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idbKeyedStore.js\":\"496624eb80eaa58e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/idleCallbackPolyfill.js\":\"3c813018e2b837e6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardAwareScroll.js\":\"d82033efc932da62\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/keyboardViewport.js\":\"b3baeeb48d124ffa\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/lastWorkspace.js\":\"76c773634f4e195d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutColumns.js\":\"1bf7c217b4e3edf5\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionDom.js\":\"7f082993337bc237\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/layoutSessionId.js\":\"b75119c0292815cd\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkClickGestures.js\":\"bed4f6008619403e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/linkTargetAutocomplete.js\":\"e25e3055c2bf14dc\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbCorruption.js\":\"82d789fd39c8ab4c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/localDbRecovery.js\":\"a19d70b9589dd910\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/markdownParser.js\":\"67e0374677edd6d3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/memoize.js\":\"5611fb3c2f4cbfba\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameFieldCommit.js\":\"8a9abade96c08a29\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/nameList.js\":\"d6b473f6db58892d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/navigation.js\":\"42c7aafb008213d7\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/omnilinerNamespace.js\":\"304df0ce8a86ec59\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/opfsPageScan.js\":\"482cd603697e6b7d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelClearance.js\":\"4d606ac963271951\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelHistory.js\":\"adfbc8602139b730\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLanes.js\":\"208457438d3f9e1c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelLayoutProjection.js\":\"770d8eedcaab48a3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelScrollAnchor.js\":\"f643984cfb98faf4\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/panelUrlFlags.js\":\"ff7b6b7eec011d6b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/platform.js\":\"577564f4582f0f67\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/pluralize.js\":\"00c3d251d543b72b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyCreation.js\":\"4b4c163898f2ed13\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyNavigation.js\":\"90f35f9df6291ea1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/propertyValueContext.js\":\"16a2b61356628d5e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/react.js\":\"a8fa15fa1448e1c6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeDate.js\":\"5baabcda9cdacb55\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/relativeTime.js\":\"e6e69331f0decf8c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/renderScope.js\":\"d99ef681aeeabb4b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/resolvedThenable.js\":\"02b2c078be22508e\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/routing.js\":\"86a849dd42b6f21a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/safeMode.js\":\"c53a16f23b5b8576\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/scheduleIdle.js\":\"4323020c565efdac\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/screenWakeLock.js\":\"248c520f94ff72c3\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/selection.js\":\"ab572a438b75d601\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/softKeyboardGrab.js\":\"9947ff48b57ebeac\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/startupTimeline.js\":\"949f6863daefa601\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/state.js\":\"695a575a58983242\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/string.js\":\"a8f027614263700f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/surfaceZoom.js\":\"17e07d145c0ec42b\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/time.js\":\"34b8cb692cf4bc37\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toast.js\":\"fcc26b294ca59d5f\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/toggleStore.js\":\"c14b91b712522e97\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/untilStopped.js\":\"72e52f39043c87f1\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/userActivity.js\":\"b7869fa203cd3186\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewTransition.js\":\"559bcb799ade5b9a\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/viewport.js\":\"e429b8cf72aa673d\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/webLock.js\":\"8d4b5b1488083f1c\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceRecovery.js\":\"21bdd2ed6a62aca8\",\"/knowledge-medium/pr-preview/pr-1790/src/utils/workspaceSnapshotStore.js\":\"f13b883eca8466cc\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-compiler-runtime.js\":\"eaae1f5fec4c23f7\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-client.js\":\"a7051b4763a82d9a\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server-edge.js\":\"b1a07e0c8324f18f\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-server.js\":\"71a25980f23497a0\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static-edge.js\":\"d53c5d77a4f5a79d\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-static.js\":\"007731cf1675d4bc\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom-test-utils.js\":\"d11215e1be725f00\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-dom.js\":\"6b4a36b66d620ad4\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react-jsx-runtime.js\":\"469ec347ae1286f2\",\"/knowledge-medium/pr-preview/pr-1790/src/vendor/react.js\":\"1efad265942b9af6\",\"/knowledge-medium/pr-preview/pr-1790/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1790/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
