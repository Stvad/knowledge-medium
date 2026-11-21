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
		buildId: "5e460f828545-9e5b6e43",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/\":\"8585ae81a9d26bec\",\"/knowledge-medium/pr-preview/pr-1791/index.html\":\"8585ae81a9d26bec\",\"/knowledge-medium/pr-preview/pr-1791/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1791/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1791/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1791/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1791/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1791/assets/FacadeVFS-Bo-euXIe.js\":\"447f2a539c77b827\",\"/knowledge-medium/pr-preview/pr-1791/assets/OPFSCoopSyncVFS-_CtkZMqz.js\":\"339816031faeeb9f\",\"/knowledge-medium/pr-preview/pr-1791/assets/OPFSWriteAheadVFS-DDAD00cL.js\":\"c777f8b88f1bb2c3\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-Vk65PKQH.js\":\"f40953ca5d496b3e\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-async-IkXiaC_e.js\":\"f4b7af9b2684e5b0\",\"/knowledge-medium/pr-preview/pr-1791/assets/worker-Bo02BjS5.js\":\"8f5292316ac0f48b\",\"/knowledge-medium/pr-preview/pr-1791/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1791/chunks/app-zB7ItzVy.js\":\"823db3dea7d1dc64\",\"/knowledge-medium/pr-preview/pr-1791/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1791/index.js\":\"c3918e317e5c27d6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1791/assets/AccessHandlePoolVFS-CUkXUyxN.js\":\"0f1277895214827e\",\"/knowledge-medium/pr-preview/pr-1791/assets/IDBBatchAtomicVFS-B-lG_HH7.js\":\"8e4b4dca750bfe3d\",\"/knowledge-medium/pr-preview/pr-1791/assets/MemoryVFS-DAVi_7XE.js\":\"57820040a430d6e4\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-Comk6hg5.js\":\"af71661f34c49124\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-async-BuvQWzQC.js\":\"8219fad0d844f455\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1791/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1791/chunks/AccessHandlePoolVFS-KQHD1SCH.js\":\"cd476f95b8e85e8c\",\"/knowledge-medium/pr-preview/pr-1791/chunks/FacadeVFS-CZCTYvUV.js\":\"cd4d9c3695ad9c23\",\"/knowledge-medium/pr-preview/pr-1791/chunks/IDBBatchAtomicVFS-DqG9wQ3H.js\":\"92c8aed8eeff6685\",\"/knowledge-medium/pr-preview/pr-1791/chunks/MemoryVFS-BcUCKuYI.js\":\"f2b59d27f00dd080\",\"/knowledge-medium/pr-preview/pr-1791/chunks/OPFSCoopSyncVFS-TyxWtFMw.js\":\"564b00cf780a104a\",\"/knowledge-medium/pr-preview/pr-1791/chunks/OPFSWriteAheadVFS-CDCjtSUB.js\":\"5c74974339893cd7\",\"/knowledge-medium/pr-preview/pr-1791/chunks/Preview-Dep5TLlh.js\":\"c9485c649d5eb941\",\"/knowledge-medium/pr-preview/pr-1791/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1791/chunks/card-DuVR7Ktu.js\":\"7b4bca0d608b0ec8\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-C_MOOUfi.js\":\"b29350cdecab0db9\",\"/knowledge-medium/pr-preview/pr-1791/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1791/chunks/mc-wa-sqlite-async-BtcMySa_.js\":\"c3ae73a8ae3bcf37\",\"/knowledge-medium/pr-preview/pr-1791/chunks/mc-wa-sqlite-krCileQt.js\":\"0a32185cfab892cf\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-BP4Z96l_.js\":\"c01d95b03f23987d\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-CDeuwGs6.js\":\"48614b3ef5a86113\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-CLmmYWjR.js\":\"9aaa97717f5bde51\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-Ck3QdOXw.js\":\"d1cfe90473ee3d43\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-Cni521e8.js\":\"1dec353201669310\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-DX8c--D_.js\":\"fe79460be2eba06b\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-DcqzJf8w.js\":\"35c6cd64a0cefff5\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server-legacy.browser.production-z0O-dXT9.js\":\"8333c1d4706bcc26\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server.browser.production-CV7Nhw2Q.js\":\"2db9457f7c52f49d\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server.edge.production-CM_J0cJ4.js\":\"8ce72df70773aefe\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-fXCM5Csy.js\":\"7472ea22a78c613e\",\"/knowledge-medium/pr-preview/pr-1791/chunks/server.browser-BdC8WAPw.js\":\"9dba4dca130cca41\",\"/knowledge-medium/pr-preview/pr-1791/chunks/textarea-Bwn159WS.js\":\"d8c11b87e9db1173\",\"/knowledge-medium/pr-preview/pr-1791/chunks/ui-BESJdcIF.js\":\"1d50561dacb96acc\",\"/knowledge-medium/pr-preview/pr-1791/chunks/wa-sqlite-CSC44jom.js\":\"7d115e3e8799dc13\",\"/knowledge-medium/pr-preview/pr-1791/chunks/wa-sqlite-async-gHwyNybN.js\":\"a294d03e6f241a44\",\"/knowledge-medium/pr-preview/pr-1791/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1791/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1791/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1791/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1791/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1791/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1791/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1791/src/App.js\":\"e364ac26c0cc9920\",\"/knowledge-medium/pr-preview/pr-1791/src/appUpdate.js\":\"649c15f859bd43fa\",\"/knowledge-medium/pr-preview/pr-1791/src/appVersion.js\":\"1dc0a4b5b415c860\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/initialLayout.js\":\"3bdf4f9b5a24cd91\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/openWorkspaceData.js\":\"fa76f3619c2b6d1e\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/resolveWorkspace.js\":\"29eb38e4e0ede301\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/workspaceBootstrap.js\":\"cbe1d83afe640afa\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockComponent.js\":\"61b5b19bf6d0bef7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockCrumbs.js\":\"23ed0e8841a6f1cb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockEditor.js\":\"2bf9cab1a9009b27\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockLoadingPlaceholder.js\":\"812b818bb8338d03\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockProperties.js\":\"8c637ca8a928e961\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockSearchPicker.js\":\"97c12432adcc4015\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ConfirmBulkDeleteDialog.js\":\"461d9fdaa92d0b05\",\"/knowledge-medium/pr-preview/pr-1791/src/components/DividerHandle.js\":\"ac7f6feb3782458f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/DraftEditor.js\":\"d0b1f1c1d1566fa0\",\"/knowledge-medium/pr-preview/pr-1791/src/components/GutterPill.js\":\"a51b9c7b07f2e88d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/Header.js\":\"b88a694b96d1f99a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/LazyBlockComponent.js\":\"50cd7b7494e7fad8\",\"/knowledge-medium/pr-preview/pr-1791/src/components/Login.js\":\"b53c12bf21952e38\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ZoomableSurface.js\":\"6a6d3544f4db0de5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/editModeKeepalive.js\":\"01e5c4c8b8c7505d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a47ee55126eae0b8\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e970d3982a9de43f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/RefPropertyEditor.js\":\"ad6d1634bf176f2f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/RefTargetTypePicker.js\":\"71ad51197e420b08\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/SelectPropertyEditor.js\":\"fe2d34b68ede3e47\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/TypesPropertyEditor.js\":\"3ec8cfe938f46f22\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/defaults.js\":\"41575c015318658d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/kernelValuePresets.js\":\"b93cb7e51c25f349\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/selectablePresets.js\":\"7a4b511d334c9f80\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/typesPropertyUi.js\":\"94450987168cd8dc\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/AddPropertyForm.js\":\"59bf8e887cdbb697\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/PropertyPicker.js\":\"df53671aa2603b91\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/PropertyRow.js\":\"39b461c7e69ffb37\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/Rows.js\":\"a84c39fc9dad51fd\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/actions.js\":\"dcc9fcaf8b1b7c52\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/declarationOnly.js\":\"a3de195e0d607867\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/layout.js\":\"893f68c541f8f6db\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/model.js\":\"a1093df967c43c13\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/shapeUi.js\":\"bcaddd628c78a284\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/shapes.js\":\"211520c57bb2bd70\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fc0951daa7911358\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/visibility.js\":\"28c8312f723ab0e0\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanelSections.js\":\"095de82fda9ddce6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockEmbed.js\":\"20933de60e2d49e2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockLink.js\":\"3b29cee76c287ef3\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockRef.js\":\"026eb74c1327aa8b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/ReferenceLink.js\":\"f63d3ec433e87c94\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/cycleGuard.js\":\"c0a35cd2b02a6613\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/cycleGuardContext.js\":\"9498e6c4c347b0ca\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/linkInteraction.js\":\"095d025125a8dff3\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/referenceLayout.js\":\"84865e129936e1dd\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/useBlockRefAncestors.js\":\"d2c0f61152f77086\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockGutter.js\":\"4e3654d33be23fc7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockInfoDialog.js\":\"178324a781f8f0d3\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockTypeBlockRenderer.js\":\"30d22f2b3516f296\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BulletHoverCard.js\":\"f12a8792fdf5d4a9\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/CodeMirrorContentRenderer.js\":\"613fdcc8f131449f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cde0f58c40f7f2d5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/ColumnResizeHandles.js\":\"b6ebbe8e3f65e0ff\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0507acecb04a6f88\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/DefaultBlockRenderer.js\":\"42d07069957f6d25\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/LayoutRenderer.js\":\"1ad731d7255bbe96\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/MarkdownContentRenderer.js\":\"799c1adc64d720b1\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/MissingDataRenderer.js\":\"e8f580c2825fd57d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/PanelRenderer.js\":\"73bc140a99c1f92a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b65a4571dbfd9d05\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/TopLevelRenderer.js\":\"5e26e7b8434128b7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/blockGutterMode.js\":\"79d2504f23b234c6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/blockTitleText.js\":\"98d4d7761973a025\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/fieldCreationKeydown.js\":\"c104789b51ebeec2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/layoutRootContext.js\":\"6481a5b6936d016f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/typeChip/TypeChip.js\":\"aac7540607191ecf\",\"/knowledge-medium/pr-preview/pr-1791/src/components/typeChip/chipStyle.js\":\"5b5241e29b179016\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/anchored-floating.js\":\"b06032723415a1a9\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/button.js\":\"cc7d6987a3800edb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/card.js\":\"1fdedcef6cd96da7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/checkbox.js\":\"44021aa616a8f012\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/collapsible.js\":\"3765e87ea3b49f0e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/command.js\":\"3a50ed5d4e2f7101\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/context-menu.js\":\"3ce4e0cc5f080da2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/dialog.js\":\"d2efc5a4ab0f41bb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/dropdown-menu.js\":\"9d94189d79c09610\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/floating-listbox.js\":\"f040581f3bbfa69e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/index.js\":\"a7700364a295e086\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/input.js\":\"09803e3b336587d6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/kbd.js\":\"486bde2c0efd9557\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/label.js\":\"ca63eccd34545a79\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/textarea.js\":\"1b2e02c001fef897\",\"/knowledge-medium/pr-preview/pr-1791/src/components/useEditModeYieldKeepalive.js\":\"9a3a04c0a29d9781\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/BootFallback.js\":\"29a041d07af6c8de\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/FocusedRowLazyMount.js\":\"4a2a212ee713090d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/LazyViewportMount.js\":\"34674c50602b7a7b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/LocalDbCorruptionFallback.js\":\"f12c69d3c43bf747\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/error.js\":\"fc050d1dd9c1d3c6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/lazyMountRegistry.js\":\"00bc45ee0355d0f7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/suspense.js\":\"3c77895f6b771314\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/CreateWorkspaceDialog.js\":\"2f48e23c66c7342d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/PendingInvitations.js\":\"dbc96dc0592ec4b1\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/SyncProgress.js\":\"1b8d0b4950552ff6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/UnlockProgress.js\":\"e5dbc7a18c6b4002\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceKeyGate.js\":\"bfa396f370832b10\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSettingsDialog.js\":\"cfaf4599c7505bbb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSwitcher.js\":\"9174ef0b82a06846\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSyncGate.js\":\"28ef9aeb66f3ec81\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/ConversionFlow.js\":\"6d1c41b9c5b9c2ec\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/ConversionFlowHost.js\":\"3c408149b92ec939\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/EncryptionSection.js\":\"98ceafd2fa0aea2a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/attachmentPrompts.js\":\"f0ca4a2ec9470e96\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fb641475d4e11f33\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/conversionFlowDeps.js\":\"975162959ba105cf\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/conversionFlowStore.js\":\"1fd47bec10a023af\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/flowUi.js\":\"b584cd9364e2e31a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/useConversionRun.js\":\"cb28c6362cae9f7f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/keyUi.js\":\"7f8c4ce16cce16fd\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/useCloseOnKeyLoss.js\":\"559787bcbe6bb983\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/useCloseOnServerE2ee.js\":\"b9730384b3a753c2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/workspaceUnlocked.js\":\"0f8ee524f2364702\",\"/knowledge-medium/pr-preview/pr-1791/src/context/backgroundSubtree.js\":\"91753f0503c31966\",\"/knowledge-medium/pr-preview/pr-1791/src/context/block.js\":\"8c2d35c8134c4357\",\"/knowledge-medium/pr-preview/pr-1791/src/context/layoutWsContext.js\":\"e89dad5bf1a14835\",\"/knowledge-medium/pr-preview/pr-1791/src/context/propertyDisplay.js\":\"9e74e7ad6cfb35d4\",\"/knowledge-medium/pr-preview/pr-1791/src/context/repo.js\":\"10962e6cf0fcc4a8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/aliasClaim.js\":\"59a4358973a2dc22\",\"/knowledge-medium/pr-preview/pr-1791/src/data/aliasSeatNamespace.js\":\"1b4199d596c80da6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/blockData.js\":\"baff18d06db4e3c8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/blockType.js\":\"f65366ebebd771e3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/changeScope.js\":\"0ceb7b712b91eab9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/codecs.js\":\"edb5afabd03a0a91\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/derivedData.js\":\"4fe065e0993e5cd0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/errors.js\":\"1b3af0c6971f1f22\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/events.js\":\"a714ed3fb5cb2825\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/handle.js\":\"487b8b6104b076aa\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/index.js\":\"244d93ee82726219\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/mutator.js\":\"d3065d679ad0787e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/processor.js\":\"df6bf04d0778edbc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/propertySchema.js\":\"05601783c0ca8bd6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/query.js\":\"c2a7180dd29ab112\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/sameTxProcessor.js\":\"ea412de004705d8a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/schema.js\":\"487b8b6104b076aa\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/tx.js\":\"487b8b6104b076aa\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/typedBlockQuery.js\":\"2c83984dac83169f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/user.js\":\"09fb059d81e43638\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/valuePresetCore.js\":\"5c0ba8f28cbe6629\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/valuePresets.js\":\"955e7052fb48429b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/attachmentCleanerIOVerb.js\":\"c49a2ed1c5ca9ccb\",\"/knowledge-medium/pr-preview/pr-1791/src/data/block.js\":\"194b07a819fea377\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockCache.js\":\"f9e93b6f00787e05\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockId.js\":\"92c6d8fa446f803d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockLiveness.js\":\"eeb6887af51e7833\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockMerge.js\":\"7ab669ee18dafe6e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockSchema.js\":\"81f04bd55b4003ec\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockTypes.js\":\"2941a39ba25d2e53\",\"/knowledge-medium/pr-preview/pr-1791/src/data/clientContext.js\":\"c9ee5cf5f3a359b7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/dbFileSiblings.js\":\"45b5135f704e81e7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/definitionSeeds.js\":\"c2623cc4e6c31e4c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/derivedIds.js\":\"8c24653cc36cca26\",\"/knowledge-medium/pr-preview/pr-1791/src/data/drawnSubtree.js\":\"e88ce1023e5ebb99\",\"/knowledge-medium/pr-preview/pr-1791/src/data/facetBridge.js\":\"ce68cd4d540f5451\",\"/knowledge-medium/pr-preview/pr-1791/src/data/facets.js\":\"9a29ea7542f340a3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/globalState.js\":\"6d8a9c50fc1d7de4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/aliasClaimRederiveProcessor.js\":\"a2726ce2354d0f88\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/ancestorBatch.js\":\"e6fe94a17e8691b4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/blockTypeTypeifyProcessor.js\":\"294faaae1aedd288\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/clientSchema.js\":\"568648febe63c86f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/commitPipeline.js\":\"ec1589642403e6a8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/devAssertions.js\":\"6347ac4426899961\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/firstSync.js\":\"38d06828296d279d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/freshInitialLoad.js\":\"2bae60b0057d6e93\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/graphBackfillClaim.js\":\"77be4b922c33b12d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/handleStore.js\":\"c969cb685efdddf2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/idleMarkerJobs.js\":\"8a652a2ab8c64a37\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/initialDownload.js\":\"20d4bedab72262f8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/initializeClientDatabase.js\":\"3ccb0ffe5f6be2a6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/jsonCanonical.js\":\"55ca23b4c4ecca25\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelInvalidation.js\":\"fec1e01afc72d1c4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelProcessors.js\":\"9034012e649ff93d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelQueries.js\":\"21564d114bd0c898\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/mergeTypeMembershipProcessor.js\":\"6bfafcb829f1de97\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/normalizeReferencesProcessor.js\":\"85ed845664ebe4d3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/poolInstrumentation.js\":\"0d99b940691d02e3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/processorRunner.js\":\"1491b38a120c9111\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyCellBackfill.js\":\"efdcd29500b3d25f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyChildMint.js\":\"ddefd215c6145033\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyChildrenProcessor.js\":\"9fca212a28ed04a3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyDefinitionChangeProcessor.js\":\"670e9a4336b13ee3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyDefinitionSynthesis.js\":\"307f4a88d2b0d28f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyKeyScan.js\":\"f4b64a7a0b645043\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertySchemaResolution.js\":\"3541db55163e36d7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/raiseProtocol.js\":\"ce442588839a6a7e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/readBatch.js\":\"755599a0128a611f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/refProjection.js\":\"eb5dd73bbef4a104\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/referenceTargetLookups.js\":\"ded16cbadd506e49\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/referenceTargetProcessor.js\":\"3bb29ce9a62863c6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/replayMerge.js\":\"09ea314884ffd85b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/sqlBinds.js\":\"b475115ad0e9da26\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"23cc1207d1da8b95\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/arrivalProcessors.js\":\"c6ae60bb76e5f731\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/invalidate.js\":\"64d72ff2b7e7c6b8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/materialize.js\":\"da3909f2199c29c5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/observer.js\":\"029f60bcc36e8a05\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/reconcile.js\":\"5e03df72e73be258\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/timingMetrics.js\":\"17e97ef3cfc25d3e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/treeQueries.js\":\"f71364eee4b4c252\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/txEngine.js\":\"7db0fb7815eee4c0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/txSnapshots.js\":\"9145c459349ef857\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/typedBlockQuery.js\":\"2df52550003bf5d9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/undoManager.js\":\"4b0b39b6bada3380\",\"/knowledge-medium/pr-preview/pr-1791/src/data/invalidation.js\":\"5ad79852d1cf9ce8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelDataExtension.js\":\"1c14f6b953e68a62\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelPage.js\":\"e45a4815d14f41ec\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelValuePresetCores.js\":\"a75f2cda1bdb4e02\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbCorruptionSignal.js\":\"cfad5ead2553f712\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbStorage.js\":\"eba4f9345114a702\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbVfs.js\":\"a471eb746d373591\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localSchema.js\":\"851dc5606a1ea14b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/maintenance.js\":\"6e79cda1151cabf3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/mergeProperties.js\":\"f2e22cef49333b39\",\"/knowledge-medium/pr-preview/pr-1791/src/data/metricsConsoleHook.js\":\"038b3a31537d72fb\",\"/knowledge-medium/pr-preview/pr-1791/src/data/migrationsPage.js\":\"1a7fe5189cb5620d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/mutators.js\":\"4ca682cedaf48bce\",\"/knowledge-medium/pr-preview/pr-1791/src/data/orderKey.js\":\"de91657a20157a4f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/orderKeyPlacement.js\":\"10f7a6048f2ab280\",\"/knowledge-medium/pr-preview/pr-1791/src/data/outlineSurface.js\":\"95735a5f18f62ecc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pendingEditorContent.js\":\"22246a7eeba78dc1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pendingUploadsSql.js\":\"e5d4070ad3eccffa\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pluginStateExtensions.js\":\"eeadd29c21df0109\",\"/knowledge-medium/pr-preview/pr-1791/src/data/powerSyncLogger.js\":\"723179293781f31c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/projectorRuntime.js\":\"ee0057570c4ccd68\",\"/knowledge-medium/pr-preview/pr-1791/src/data/properties.js\":\"ac80f6d2793bc950\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertiesPage.js\":\"adfe108e16ac18b2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyChildren.js\":\"359b923d90c0e3c9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionFanout.js\":\"3da2de88307d5f9c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionMetadata.js\":\"2a53e2652ec8ee6c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionRegistry.js\":\"4d35ea0c57aa9576\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDisplayMode.js\":\"9adf34d626e9ea45\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyRowCreation.js\":\"148ae8f23c78ec26\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertySchemaCreation.js\":\"d4eb56d1f62db2ef\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertySeeds.js\":\"fb04be40948de430\",\"/knowledge-medium/pr-preview/pr-1791/src/data/recentsPage.js\":\"34c24757d58e9f80\",\"/knowledge-medium/pr-preview/pr-1791/src/data/referenceBlock.js\":\"2868426f7af6bf81\",\"/knowledge-medium/pr-preview/pr-1791/src/data/releasePowerSyncConnection.js\":\"2ff7bbaa880cdb7b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/repo.js\":\"144055b50cdd6fee\",\"/knowledge-medium/pr-preview/pr-1791/src/data/repoProvider.js\":\"01446f754eb3d700\",\"/knowledge-medium/pr-preview/pr-1791/src/data/rowProperty.js\":\"b8494051f03b0a62\",\"/knowledge-medium/pr-preview/pr-1791/src/data/searchFilter.js\":\"03a79887ef4f52be\",\"/knowledge-medium/pr-preview/pr-1791/src/data/seedIdentityLedger.js\":\"65e9f828e9291d58\",\"/knowledge-medium/pr-preview/pr-1791/src/data/stateBlocks.js\":\"f8f4b4196dbce7c9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/structuralEditPolicy.js\":\"c00ddcc14a113063\",\"/knowledge-medium/pr-preview/pr-1791/src/data/subtreeDelete.js\":\"856e1505322fcb8c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncStreamLock.js\":\"702fef66a4ccf2f0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncedTableSqlRecognizer.js\":\"db573cfa79d7c56b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncedTableWriteGuard.js\":\"f8120de3cdca82d2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/targets.js\":\"25482c287eb2025c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeColors.js\":\"27754c0940e1e207\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeDefinitionMetadata.js\":\"1c470db40284ea7d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeDefinitionRegistry.js\":\"b0919b105cec7691\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeExtraction.js\":\"c323ba4dae3b3ff0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeInitialValues.js\":\"64fa83ee0be2bbcb\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typePropertyGroups.js\":\"a1c16e3b31b5f30f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeSeeds.js\":\"84acc7b42e5cdddf\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeTagger.js\":\"1e2d8dee610ec0b5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typedRecords.js\":\"d210832505c19616\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typesPage.js\":\"3c974b1a2b01ab0a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userPrefs.js\":\"4ecbba8a81c8fe17\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userSchemasService.js\":\"92ff48ef5a140ae4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userTypesService.js\":\"8677209e5b288f9f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/valuePresetRegistry.js\":\"914aa3565aea6e64\",\"/knowledge-medium/pr-preview/pr-1791/src/data/visibleChildren.js\":\"0db9ef8ea0db9a7b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceConversion.js\":\"38b814f9c9100f26\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceFirstSync.js\":\"4a232a8939c09e47\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceIdNamespace.js\":\"016b5265463d3825\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceSchema.js\":\"4f4e3cb45b312511\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaces.js\":\"e7b8c412fba228e6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/writeAheadLog.js\":\"3bd0510dfc25b067\",\"/knowledge-medium/pr-preview/pr-1791/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/BlockPasteShellDecorator.js\":\"6facab1cef8245c5\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/atTrigger.js\":\"351f3523d1d9ed5e\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/autocomplete.js\":\"7e13aa10f6dcd26a\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/codeMirrorExtensions.js\":\"1213f2bd9427ba52\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/contentFlush.js\":\"d0da5ecc03c285db\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/defaultInteractions.js\":\"381422356efa9bb4\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/editSettleSignal.js\":\"0521285462b83416\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/insertImage.js\":\"72610ad8bff88200\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/referenceCompletionRange.js\":\"2dfb1d56e47953cd\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/referenceTargetTypes.js\":\"7e98855de631c704\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/syntaxContext.js\":\"430b65af32ccd130\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/triggerMatch.js\":\"c6a043eb3f7b0ef3\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/AppRuntimeProvider.js\":\"c52752d2a64e4829\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/BlockFocusShellDecorator.js\":\"5028bc7ff8cc8cf6\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/ExtensionRenderBoundary.js\":\"9f10cf72c9a8848c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/PanelContentRecovery.js\":\"037dd4e666661f43\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/apiCatalog.js\":\"5d0ef0dcdbc65541\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/approveExtensionHere.js\":\"0bd3e2c15f7fd795\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/armedCutAppMount.js\":\"63371b2cb97a9316\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/batchableKeyedStore.js\":\"7687e8777d5e9dfe\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/blockInteraction.js\":\"8712c66c1497dafc\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/blockSelectionAction.js\":\"79c78852b4decd45\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/compileExtensionModule.js\":\"056356171594629f\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/compiledModuleCache.js\":\"25289f242665747b\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/continuousGestures.js\":\"98a70d196327f607\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/core.js\":\"a72d5a500e87db5c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/defaultRenderers.js\":\"6a5694c3a296a0ad\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/definitionFanoutAppMount.js\":\"2270fa9bbfeae437\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dialogAppMount.js\":\"93299a5291a1a866\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dynamicExtensionSeeds.js\":\"a7c57ff6906d6a4e\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dynamicExtensions.js\":\"2e3bc1c153dced64\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/exampleExtensions.js\":\"eca1164c24396611\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionApprovalStatus.js\":\"4477832bc9c9590b\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLoadErrorToast.js\":\"b6794605e2cfb0c8\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLoadErrors.js\":\"a459682b2bbcf3fc\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLookup.js\":\"9b52f9984f15c934\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionToggles.js\":\"724c1f4106f6ddc5\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionUtilitiesCss.js\":\"709381e1c051362e\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/kernelPageDeletionGuard.js\":\"2effabdad0240bf7\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/liveRuntime.js\":\"2421dc27eb7c1575\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/openExtensionsSettings.js\":\"65e95cf36f23fc87\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/overridesCache.js\":\"418ec94fedc1906c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/pluginIds.js\":\"5f09d581f8a87ea3\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/processorRejectionToast.js\":\"c2f8b81875d4162b\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/runtimeActions.js\":\"4dc165f11afbfacf\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/runtimeContext.js\":\"5da02ecdde4aaf73\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/staticAppExtensions.js\":\"ea688af3bb5d7495\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/staticDataExtensions.js\":\"bb625868a1ce13e0\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/toastAppMount.js\":\"9cfc0d86f8f2f75b\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/useOverrides.js\":\"8a3169a3567518d7\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/useShortcutSurfaceActivations.js\":\"1a4712bbb5bafdfd\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/discoverToggleTree.js\":\"d8c488c724a231b9\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/facet.js\":\"fb8321d65a5fd8af\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/resolveAppRuntime.js\":\"66e5dd4ed8ad4b02\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/runtimeEvents.js\":\"2452ab939185f92f\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/togglable.js\":\"9c66f4b7c3b187c6\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/variantFacet.js\":\"fa3782448fb2f6cf\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/verbFacet.js\":\"97e52d39b7fa20f6\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/block.js\":\"4b103b927392dfaf\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/focusedChild.js\":\"088a0949532bf9ae\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/propertySchemas.js\":\"29326157aea40d78\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/typeRegistry.js\":\"783187e1f79b2b39\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useAncestorCrumbs.js\":\"303c3c3975a84992\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useAutocompleteListbox.js\":\"63deb11262e8e92b\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useDebouncedSearch.js\":\"c964d2b6af1baf9e\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useDebouncedValue.js\":\"4ce56b3c173a27b8\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useIsFocalRender.js\":\"cafa4dcc5e63c7df\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useIsReadOnly.js\":\"6f6c4e089fc89a02\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useMaterializeBacklog.js\":\"1302d504b7d7459b\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useMinuteClock.js\":\"053199966a5aaf66\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/usePanelLayoutProjection.js\":\"514b679a8288c9f6\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/usePendingInvitations.js\":\"9951299069891672\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useRendererRegistry.js\":\"b20483793aed10c3\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useRetainedFieldRows.js\":\"8078ba80e326a919\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useWorkspaces.js\":\"abd7f23ab3fffba3\",\"/knowledge-medium/pr-preview/pr-1791/src/lib/utils.js\":\"23cca3a5ca0d03f7\",\"/knowledge-medium/pr-preview/pr-1791/src/main.js\":\"6b3db9b1908a1976\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/MarkdownImage.js\":\"0762fe806160e8a8\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/blockSeparators.js\":\"d19e479e5a5d8a53\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/context.js\":\"46b5356e3b72dfb3\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/defaultMarkdownExtension.js\":\"c87fad4ef80f9948\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/extensions.js\":\"89d3f438032477b6\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/renderMarkdownHtml.js\":\"525f7da5b2cc2226\",\"/knowledge-medium/pr-preview/pr-1791/src/minimal-editor.js\":\"617d1f73695f779a\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/armedCut.js\":\"4c33f67e7825717f\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/captureMediaVerb.js\":\"6325cf3c5785e19c\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/clipboard.js\":\"ce254cf3621faae5\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/decision.js\":\"394fbea3a0ccd78d\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/operations.js\":\"19aa945f9e217bf4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/account-header/AccountHeaderItem.js\":\"e2e86ff3d8915bbd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/account-header/index.js\":\"094e7cfac6dc2b75\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"492394bded058cee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/askAgent.js\":\"43ddb22efaf82832\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/askedStore.js\":\"0f220229193eb81d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6cdc8a597f44020c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/chipState.js\":\"87d6888108a58b4a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/dataExtension.js\":\"64cfa965b4555913\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/index.js\":\"1915adf251938edf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"fe6170016826c9eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/schema.js\":\"b10d564693bf148f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/AgentTokensDialog.js\":\"15fcc295788957f8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6e9ccd488083e927\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/addMedia.js\":\"6e5859f547d27074\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6fda65ebc1ec6157\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/block.js\":\"0ea28c080f6fcadb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/context.js\":\"a74533eab35175f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5ae5da7e8aa3c57c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/index.js\":\"e727602da4faed77\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/outline.js\":\"6a2c7861adba3df3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/properties.js\":\"af2a5f175914cc4e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/refs.js\":\"406014786b1d77aa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ad0639b6556f36f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/search.js\":\"0be6747747efc087\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/shared.js\":\"19c125b6d016bcb7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"abde11a0e0dc1023\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/text.js\":\"f611309cf114143c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentWrites.js\":\"cdc2510906289593\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/authoringCatalog.js\":\"11f9b14710f813ed\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/blockRefTargets.js\":\"2dc50661863d4d04\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/bridge.js\":\"7a56315fc8591cbb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/bridgeLoop.js\":\"4ebf914be1a33fd9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/changeHistory.js\":\"d62400898b9b7c16\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/commands.js\":\"e040afcc2e84908f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/commentsCommands.js\":\"62e17d8fcbe3d404\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/dataExtension.js\":\"c3801234e784bfc5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/dataModelGuide.js\":\"89d0c506f8a32c34\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/describeRuntime.js\":\"560e179a5cd07494\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/extensionLint.js\":\"b8b53c69554c4998\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/grainAudit.js\":\"710a550c6d933914\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/healthCommand.js\":\"6d24e2d322cbd26e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/index.js\":\"7a082931760632ba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/presetIdentity.js\":\"5ae50f80b2aed70a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7e71058c22c02340\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/readMedia.js\":\"a81fad8cff6feb28\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/schema.js\":\"5248a8f93715140a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/serialization.js\":\"1157efb8a713bc7a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/targets.js\":\"90d20e251c2d35b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/tokens.js\":\"7a3dafe71cabd256\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/watchEvents.js\":\"9038eddeb019c6bd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/workspaceGuard.js\":\"ab0510d72c98ba66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/writeCommands.js\":\"950681f1845ec590\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/AliasCollisionToast.js\":\"834430882a9aba55\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/DuplicateNameBanner.js\":\"8f92db5b658826ec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/collisionMerge.js\":\"98507ebe2e1ef4ca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/dataExtension.js\":\"c62a47ab9da36344\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/index.js\":\"fcee69e3295881c2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/mergeCollisionAction.js\":\"c09ac5a3994fcb4f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/pageStyling.js\":\"9d74fa3b53c35b26\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/rejectionToast.js\":\"8e8d1c7ef73a7a4b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/syncProcessor.js\":\"5e20bce0f21a2096\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/actions.js\":\"11eea20f9f3aff77\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/addComment.js\":\"7158183417fc8612\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/anchor.js\":\"f4425b1b585d7825\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/anchorState.js\":\"0361f89dad0c350f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/commentLinks.js\":\"cde92f24a29182b9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/confirmThreadDeletion.js\":\"4ec2556bf78df6b2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/container.js\":\"989384467f1b9e19\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/dataExtension.js\":\"b1a4141796612536\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/deleteComment.js\":\"185366c193590ab5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/highlights.js\":\"ac2633f6ee7644cd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/index.js\":\"e8b458b853cf7326\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/linkedCommentsPill.js\":\"ac38283db7ec28eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/margin.js\":\"e70b51a91d963e48\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/marginSchema.js\":\"2ec977c6f6dcb254\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/newComment.js\":\"7bb80d53102aa82e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/ownThreadPicker.js\":\"ceced1de7aea6c5d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/placement.js\":\"5c277e4d059882d1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/queries.js\":\"fad98eba958e3d50\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotePosition.js\":\"5e6465b7733b0702\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotedIn.js\":\"8278f785063280e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotedRange.js\":\"a308b179c653e9b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/rangeRefs.js\":\"8cfafc5c20688a94\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readHighlights.js\":\"2d0f5ff462deaec5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readSelection.js\":\"479719a84c898516\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readSelectionUi.js\":\"b5fea33b4d2016a2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/reanchor.js\":\"3da3511e13e69989\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/schema.js\":\"afa3c309a0be9093\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/scope.js\":\"a76efe80bb56eeea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/scopeThreads.js\":\"b4a5042d0c7e0d39\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/splitRetarget.js\":\"f6102723db744a31\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/suggestionCard.js\":\"90be4ba2f942dca5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/suggestions.js\":\"26dcbed9304c90a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/summaries.js\":\"4738b3b262c1a3c8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/summaryBatch.js\":\"278a4cc93cb34fdf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/surface.js\":\"ef83417947cea23f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/threadNavigation.js\":\"b2f6716b8b6c18e6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/threads.js\":\"54fb4dc7ae8291b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/ui.js\":\"52eb4245a96b0433\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/uiStore.js\":\"8649a626992a7768\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-intents/appIntents.js\":\"0682b95725101b2c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-intents/index.js\":\"ba09ac7fe0bcf4db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-update-prompt/index.js\":\"34c8f7b78bb503a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-update-prompt/status.js\":\"c327f8fb74c8618d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"55e16070befb822c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaBlockRenderer.js\":\"230b933fc0ea5e2f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaDownLaneReplicator.js\":\"81214d16c2c0b0a0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaUploadReconciler.js\":\"7edaf84cddc59cb2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetDownLane.js\":\"1de6e37ef37f8b9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetResolver.js\":\"3e28b5eaf0cf7d21\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetUpload.js\":\"0e5b2735c7b5e076\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/attachmentCleanerIO.js\":\"cf2dfda65068234d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/supabaseAuditIO.js\":\"169ee3eafde91fe7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/blobStore.js\":\"7f769e0c1a92e017\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/byteStore.js\":\"30b2c3cce20a9cde\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/cleanerIO.js\":\"d5cfcc45ee2bb373\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/cleanupAttachments.js\":\"ce9460d0895fc3e9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/dataExtension.js\":\"4f42bd430bade1a2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/downLane.js\":\"a15cbe99404186e5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/index.js\":\"b75a84f2a9e8275e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/insertImageContribution.js\":\"da214b4a4acca927\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/laneArming.js\":\"37e0e056bdc94f1a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/laneLock.js\":\"1ac79b6552b60e7b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaBlock.js\":\"a251c70e4e918ab1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaCapture.js\":\"d0140080e140874c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaViewers.js\":\"5bc06d3725e6dcfe\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaViewersFacet.js\":\"e89113e00342f3b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/pasteCapture.js\":\"928c0ab76c2d88e9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/resolver.js\":\"72fbe668f67da6be\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/retryUploadsAction.js\":\"8cdfbe8f33230fd5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/storagePaths.js\":\"fca5f7f03a0f7f67\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadDrain.js\":\"aee40039f1dd8e1a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadLaneStatus.js\":\"a975ce9a3262f763\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadReconcile.js\":\"b1a9dd57b82c338a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadRecovery.js\":\"a53f067b93998e2c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadStore.js\":\"7c82120e4bf2de10\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/useAssetObjectUrl.js\":\"46e9f4a615400119\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"408047f12fa06f34\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ca9765fa5bf67c64\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/facet.js\":\"4b96b4be81dc8896\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/index.js\":\"4da6cd078e667302\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/prop.js\":\"eac1da1469918ea9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BacklinkFilters.js\":\"fac6173b3c0127b0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"817cacbf83fea672\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BlockEntry.js\":\"e968bba52f50b756\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/LinkedReferences.js\":\"f57ce1473420b33c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8f52b192bf3a3a32\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/dailyNoteDefaults.js\":\"2e60062162429f8a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/dataExtension.js\":\"2316296e63b8f702\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/edgeExclusions.js\":\"ce90fc6fff26a07e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/filterProperty.js\":\"f1f8c3f00841e25c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/index.js\":\"70839b029da505fc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1e6c78137b7f5ba1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/applies.js\":\"f204b728d4d70e00\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/countQuery.js\":\"8384c47f6a29fe61\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fc34219e51f2eff0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/index.js\":\"5a9ef2760bddd8a3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"81070037567f2846\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/presentationInvalidation.js\":\"ea7cac7704704c81\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/propertyEditorOverride.js\":\"32adb327513f53be\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/propertyFilter.js\":\"6159e46d6db2f2d4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/query.js\":\"bbabe9395f9a5954\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/resolveFilter.js\":\"db9598036730f8a5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/sourceBatch.js\":\"76c6d3df5dc446db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/sources.js\":\"a8619e758c50dbc5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/useBacklinks.js\":\"cc806c035ad7740e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5043b9674744cabb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/BirthdayCelebration.js\":\"a39137c8edf778f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/BirthdayOverlay.js\":\"379d1f90c171f337\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/gate.js\":\"2e54d91c84526923\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/index.js\":\"045c60e6a4fcfb8a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/wolfTheme.js\":\"0d7f0789726c9b24\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/BlockDragLayer.js\":\"b4a64f65ff32cb88\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/dragController.js\":\"3533b40239b264dc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/dropTarget.js\":\"37eb5467e538ef53\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/index.js\":\"a3fbe241741ebf57\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/projection.js\":\"bcf235d0e67be3b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-info/BlockMetaCard.js\":\"c14a9e4c990afb39\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-info/index.js\":\"d71d758f95a2781b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/AddTagDialog.js\":\"2d1e0db4b2b38426\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"072c1754fc9cd030\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/TagNameIssueHint.js\":\"1636c91c54a26f91\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/addTagAction.js\":\"1c0a45b3830bb9a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/appendTag.js\":\"89b18f3e532667c1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/config.js\":\"d155c821701ee06e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/dataExtension.js\":\"f2d6f89f04868b6c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/index.js\":\"3da152c9fe00e840\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/propertyEditorOverride.js\":\"f93286314d1c6d9d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/BreadcrumbList.js\":\"886fc45b1d83f059\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6804c2dec0182f1b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/Breadcrumbs.js\":\"2b5e66b20763f360\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"89dd4e034650fa9e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f699925b08f01532\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/index.js\":\"32b3d81042d360e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"90f72ee72f2f0f83\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/CharacterCountItem.js\":\"3230e75677251f4f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5fbb34656dd53270\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/actions.js\":\"cbcbb27e43b9b7ce\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/blockType.js\":\"bdf2503ee4eff8bf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/charCount.js\":\"2a2f2658ee426559\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/dataExtension.js\":\"768e8b6cdda9edb2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/index.js\":\"4bee024d07fcc5a4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/profiles.js\":\"3808f2594ba5beea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/properties.js\":\"43e26f06489a7792\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/textCounts.js\":\"fde15dccd5d9bdd0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/colemak-keybindings/index.js\":\"05228a5500e270f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/CommandPalette.js\":\"0ed9ae728bb21d1c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/HeaderItem.js\":\"d177df7d838ec623\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/context.js\":\"61944a4142257510\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/index.js\":\"c8813cc0b87100d4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/selection.js\":\"48f410e6940a59a2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/toggleStore.js\":\"8a7757bcc5d278e2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/useCommandPaletteActions.js\":\"06deeb30145c4e3c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/ContributorBadges.js\":\"c12c3e0fd653788a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/author.js\":\"d3804bd1f9110710\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/codeMirrorExtensions.js\":\"df5e943580dd22a5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/dataExtension.js\":\"a61fbe86aa3c9392\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/index.js\":\"7a74f760bc2da075\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/mentionAutocomplete.js\":\"7b1dd474e1782a2e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/processor.js\":\"c432038734bde424\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/profiles.js\":\"8649094bdab47f40\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/queries.js\":\"2064498f5c959f38\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/schema.js\":\"d98e2e9f91aaa835\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f1747a6ca97f2577\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4de0ec9efe4ccfb9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/index.js\":\"a07b420aa2ff072a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9e63b562b31fc6a1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dfd9afb4e0ea3de8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/CalendarGrid.js\":\"cfe854f57acf7819\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DailyNotePicker.js\":\"179a6feed22441ed\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"229c6002921b9661\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateNavDecorator.js\":\"07e5592c68d25261\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateScrubOverlay.js\":\"5dc22882e8fffa53\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/HeaderItem.js\":\"947e24aa09927f4b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/ReschedulePicker.js\":\"766fbce039f352b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6f7f2144f7f42321\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/actions.js\":\"a37b94909d85f2d6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/blockDateAdapter.js\":\"130523e0b6c55855\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/calendar.js\":\"066a6eb353444086\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dailyNotes.js\":\"d6ee6fbefa8cf3e7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dataExtension.js\":\"0cc753dad833aee2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubActions.js\":\"537099d36740443d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubGesture.js\":\"21f1090b842f7eea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ef81c9d81459182d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bbb61e5e56bb24ec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/deletionGuard.js\":\"5d001dda158abee4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dueQuery.js\":\"169f75a190dc4df2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/index.js\":\"a5e62ecbe1dab031\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/landing.js\":\"cf8312456bd92d29\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/localSchema.js\":\"608ba9fd7030b516\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/referenceDateAdapter.js\":\"ed3a08dec5757730\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/rescheduleAction.js\":\"f48d2db02c65955a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/schema.js\":\"80f6fd89aa834507\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/spreadBlockDates.js\":\"81c490137cd909ff\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/spreadDatesAction.js\":\"ed8f0cf66b8df9d2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/today.js\":\"6660a0fdd18d6177\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c33991eaf4fd6421\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3bcf6636653190e0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/audit.js\":\"565a2a8909093557\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/auditAction.js\":\"04a72406c58d0f64\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/auditRanges.js\":\"84619c09db6bbcd0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/diagnosticsSource.js\":\"925e54b628489270\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/divergenceScan.js\":\"354cd8cf5e460c33\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/index.js\":\"bf1d7f4c0c3c7ae9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fc7f2fc7d3889e82\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/referencesMirror.js\":\"425b8b953bd5674a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/rowJson.js\":\"6fe086dda4daa939\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/schedule.js\":\"ee951d1dd1d7ca3e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/store.js\":\"8dfa508942255a4e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/action.js\":\"ac700167b171150a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/index.js\":\"8331c8dba779fe62\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/plugin.js\":\"8cca7341ffc792d3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"30bcaec837feec02\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/actions.js\":\"de6a392f403b4393\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/changeMarker.js\":\"8956819bcd8e80c7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/diagnostics.js\":\"d1a9a961d69f553d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/fileSystemAccess.js\":\"8e7636af82ed7017\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/filenames.js\":\"43bc793fc8ab4bac\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/index.js\":\"e0e7cb37a64cb638\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/mirror.js\":\"f076130b5d68985f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/runLock.js\":\"06f9e0c161198206\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/runtimeHealth.js\":\"3bca2d5e0ecd8b58\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/schedule.js\":\"7d9cf1ce0a018714\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/store.js\":\"f2e684cb956aafb3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/default-themes/index.js\":\"ba31e815ec5a9cf9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/default-themes/themes.js\":\"ce0f0a735c7a570c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/diagnostics/facet.js\":\"759fadc4d29f014e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/diagnostics/useDiagnostics.js\":\"82a760863920c017\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/dismissals.js\":\"904d6aa649c8d60f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/index.js\":\"f296e498be969e82\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/status.js\":\"29c5ec9c297ca072\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/store.js\":\"d28516d313669179\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1f3c61f586427130\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/ExtensionsSettings.js\":\"034f7bc76e2f19a4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/actions.js\":\"9577efddaabfd05c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/config.js\":\"533f56d9d0463af7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/dataExtension.js\":\"5dd44ba818fb303f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/effect.js\":\"6689738a2cd541e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/index.js\":\"74ae3ea90c3dbda8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9e2dafd01ba472f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/useToggleTree.js\":\"42ef3c1404769316\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/ExtractTypeDialog.js\":\"b0722ff7be01c2a3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"65a26fa1f0c59271\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/PropertyShapePicker.js\":\"049984a51530f43b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/action.js\":\"03451e48bed55246\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/index.js\":\"f01153831d66d61d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/FindReplaceDialog.js\":\"e4634577df3d5724\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/HeaderItem.js\":\"5c0f84942bb1eb78\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/dataExtension.js\":\"8c0389b9328b3387\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/index.js\":\"423ea9c8cd8b9486\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/search.js\":\"0476785eab59e62c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/toggleStore.js\":\"12a16badfd5b7f15\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/LocationPropertyEditor.js\":\"140079a09de008db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/MapView.js\":\"9e31783a2b15161e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/blockTypes.js\":\"cce304e0c203ed95\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/codeMirrorExtensions.js\":\"6ad73292f2f4fe0e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/createOrFindPlace.js\":\"dc2b79d1c7f1df37\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/currentLocation.js\":\"131834536fdf89e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/dataExtension.js\":\"e59545e1c16d3c04\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/geoContentDecorator.js\":\"1675a763e56cc84f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/googlePlacesClient.js\":\"dd61e26b19448b2b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/index.js\":\"1701b607b72c0b6a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/locationsPage.js\":\"8297577db3647291\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/mapViewport.js\":\"25f543eea42b4954\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/pickCurrentLocation.js\":\"752048d5c0377d5f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/placeAutocomplete.js\":\"3119e95efbce50e2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/placeNameCollision.js\":\"246b2aac33384ba4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/properties.js\":\"84f9962a8504f43c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/propertyEditorOverrides.js\":\"787cf08a53fad29b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/query.js\":\"cf036314f5091a32\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/usePlaceSearch.js\":\"982330b615cfd11f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9a0d84786295f6b0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3ec9566cc2cb3e73\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9ccf3a7f17e3ed48\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/config.js\":\"78a315bcf9f88238\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/dataExtension.js\":\"dfbc573031243e60\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/facet.js\":\"af0c17fca6198731\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/grouping.js\":\"3cd8f726eafd57f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/index.js\":\"cedb00d02c69c0e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"74b79a0f199e2d8d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/query.js\":\"8bc1cf7b3c9312b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/resolveConfig.js\":\"ce26fd215a8227e0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9660cc6a4008a270\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a0d9f46c933fd4b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/HtmlDocumentContent.js\":\"4a2a0729816c2b72\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/HtmlFrame.js\":\"3252599a546aa176\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/actions.js\":\"618b2b80bab24836\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/blockType.js\":\"17b1727dfc7b3d50\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/confirmRunScripts.js\":\"87755b5fd6edf15a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/dataExtension.js\":\"8ab479b9879fca7b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameAnnotations.js\":\"c051c40338836265\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameDocument.js\":\"e5e913c051e8368e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameTheme.js\":\"2ad323fb1257faf5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/index.js\":\"bf645c072fc5350f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/scriptConsent.js\":\"102f347698e101e2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/sourceMap.js\":\"0fca78a0bab3a355\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/useDocumentScripts.js\":\"007a4a46f105c883\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/index.js\":\"e57fa0bebeefa331\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/record.js\":\"4854432662dca932\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/recordStore.js\":\"7456b72b28afbb39\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/responsiveness.js\":\"26934a3d7496224b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/schedule.js\":\"807dee7490f8e132\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/sessionContext.js\":\"7ea311f0eb7e9a41\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a1279bf30b4a289d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e8b0ec8e26402b01\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/actions.js\":\"c7967588f7289568\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/config.js\":\"823a78c8fa990197\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/dataExtension.js\":\"7f0a2e29b00fa932\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/effect.js\":\"ae503f09a552fa16\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/index.js\":\"7f5ec8ecfccb9cef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/keyCapture.js\":\"cf66e01d473642ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/overrideStore.js\":\"45bffda3ff681332\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"70efb37d87310b0c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/HeaderItem.js\":\"86f276fd0cd7a630\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/LeftSidebar.js\":\"0d6c47852f4834a6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/actions.js\":\"477a5f60e9e51501\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/facet.js\":\"ef28a6eb48110098\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/index.js\":\"3216e70e3b1d74f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/shortcuts.js\":\"e89e5210f0e5f254\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/toggleStore.js\":\"32db5f57243c6023\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/MergePicker.js\":\"01f73bdc65da6915\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/index.js\":\"b5d093657a6c7807\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/mergeAction.js\":\"357b2fee597566e6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/strategy.js\":\"f96f20249a56c33f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/Button.js\":\"e8e106ff79160c7a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ff27054720e43357\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/defaultItems.js\":\"96e2a54bd3f208c7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/facet.js\":\"17d26fd29ce42252\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/index.js\":\"1a56661f2f448f99\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"daa95e0f304da6e0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5d2ceaed5f79a66a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2370ee998d4ef042\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a7d8d5ba2b4df3d5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/index.js\":\"99bb37877398554a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d35eca6cdd3e0875\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/blockSubtreeMembership.js\":\"42f4b6d760c90deb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/contextMenuItem.js\":\"6002a0a6374299fc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/index.js\":\"63cc9cd69736357d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/moveAction.js\":\"993239edddd5d854\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/moveBlocks.js\":\"a59f6c4aca84702e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/selectionAfterMove.js\":\"a12d2332b2f88a60\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/TutorialBanner.js\":\"1525c1a554258811\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/action.js\":\"db9299be61306213\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/bannerDismissal.js\":\"669f0dca1051af33\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/documents/cheatSheet.js\":\"028eb5b0b25dedcf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/index.js\":\"47419912e35a8a5b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/keys.js\":\"48aa21360931440a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/landing.js\":\"cfe3f69cac7ad0ad\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/outline.js\":\"0219b10f2f291c65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/seed.js\":\"f111b1b01aff9e8e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/PerfTrendDialog.js\":\"23dd913651b2abc1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/analyze.js\":\"c5bcbaf846c29ba8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/diagnosticsSource.js\":\"8742c20ae96b12f1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/index.js\":\"25a8b8ddc724de37\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/load.js\":\"8067dd11b11aa703\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/monitorRun.js\":\"b4aa4c230d3e2593\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/schedule.js\":\"accaac16e89e8abb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/series.js\":\"3e725207b82b0133\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/store.js\":\"a22c9fa8f55c06f6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/trendAction.js\":\"691b4787bab9a89e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/verdict.js\":\"6c1a3088e4acb5c5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/clickToEditAction.js\":\"86807dbcdf3645c1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/index.js\":\"6d1e15f76d138212\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/interactions.js\":\"1b488b48d041e26d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"77ff1b3874f73953\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/MigrationGate.js\":\"447ba293386f1195\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/MigrationGateDialog.js\":\"7f2db23b0f4c0f73\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/action.js\":\"9c2f75f1ba681649\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/index.js\":\"344b44589b51ecda\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/localRunMessage.js\":\"bea2c3b7269b18a1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/plugin.js\":\"d21742562524a3cc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/progressReport.js\":\"c524e14c3a751099\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/sweepProgress.js\":\"50262b4c31732f04\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/FieldRowRenderer.js\":\"500796dfb4cb6968\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/ValueRowRenderer.js\":\"a176897b17745232\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/actions.js\":\"f64ed295dd14968e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/autocomplete.js\":\"8227f1cb60ee43c5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/fieldRow.js\":\"808d3eddff099418\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/index.js\":\"b76dec0d1bc0d84c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/referenceWarning.js\":\"e9a74ec890b1b635\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/valueAutocomplete.js\":\"bae5e3330e8672ca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/valueSchema.js\":\"677b4e5d3aa1d5b9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/HeaderItem.js\":\"5b08966787e5dd74\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/QuickFind.js\":\"56acaea525d61373\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/index.js\":\"4cdc3ef8185323b2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/recents.js\":\"9f21d8dd8f3333ab\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/resultItems.js\":\"758c2fc56264c2a0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/selection.js\":\"99b6bc2cc8c649ad\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/toggleStore.js\":\"575313f5b660918d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/HeaderItem.js\":\"4ea378ad05a3342c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/RecentsPageBlockRenderer.js\":\"63d8da0589d659f8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/grouping.js\":\"929340066d9715b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/index.js\":\"cf1c520eda9e4114\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/target.js\":\"5ca245339b9e5f4e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/codeMirrorExtensions.js\":\"59f90ffb3680eb57\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/contentPrefill.js\":\"db3ad5d1e9a211a8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/dataExtension.js\":\"b3ce584a052d60c1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/index.js\":\"c73d13affde3a45e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"09c7b4e7c02ab2b7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/invalidation.js\":\"e42f29f215cf31b4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/localSchema.js\":\"ca119e7935b5af5e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/blockrefs/index.js\":\"e2e9c49b72920154\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"eb4824abd3c52d97\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/index.js\":\"af689761b1fb9843\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/referenceNode.js\":\"0f2e80672cc8f9ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1249cd5a2ecf6952\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ce28e5fd6fc62733\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/index.js\":\"82059e7573d31cbd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"513265c4f61c5ac6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"932926b08408d2aa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/mergeRetargetProcessor.js\":\"e90597b257e3662e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/parseFence.js\":\"d7082dc11ede4960\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referenceParser.js\":\"d5b671df1b4273dd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referenceProjection.js\":\"b71daec3e03eca6b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referencesProcessor.js\":\"b6a979ab28151b30\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/renameProcessor.js\":\"28b569b003b2960f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/spanReplacement.js\":\"98e660b2c86cd450\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/htmlToOutline.js\":\"be43945799e37ee9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/index.js\":\"6c5d5e9dac094787\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f4f46c81e936af09\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/pasteDecision.js\":\"96591f0b965d2a05\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/action.js\":\"ad27aec837403f35\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/blockIds.js\":\"44abd247a6f30d31\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/content.js\":\"533e8cbc8548b0e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/effect.js\":\"a3b4a3a15d629785\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/ids.js\":\"576424258c8af80a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/import.js\":\"3a27825f9c3cba7a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/index.js\":\"0e88e7e3d4313bb3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/plan.js\":\"35249f26e78c5c4c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/plugin.js\":\"45a6ce0f2fa629db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/promotion.js\":\"7b5b1bf03b40e16b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/properties.js\":\"8950535d62d792cd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/references.js\":\"b72dab3a98d10eb2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/report.js\":\"83e2e282e006a893\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/roamMemo.js\":\"b42854726e4949aa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/runtime.js\":\"2cbd2ccb109f7841\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/schemaReconciliation.js\":\"24bca6b81bdf089b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/srsMarkers.js\":\"19252b032bb6ab09\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/todo.js\":\"997a7cb1851b9ee7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/typeCandidates.js\":\"970bebed265eb5af\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/types.js\":\"8983d1767465bfee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/search-health/index.js\":\"be251d741d2bc6c0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/search-health/store.js\":\"1bd88f64cf6fe4c0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/HeaderItem.js\":\"e16b77a8e8e42c6e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4cc7b1c6784554b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/index.js\":\"f367daf9d696b593\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/model.js\":\"37a56858d815421e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/toggleStore.js\":\"5040e7e6248d64a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/useKeyInspector.js\":\"d4e931f4d8e7b77f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"923d669e1bfaf45e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/ShellDecorator.js\":\"489e6f3e5550736f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/actions.js\":\"b84f69b3655a08c4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f6e637f6e62d9e3b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/index.js\":\"b02c18fa3de2de08\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/shell.js\":\"4eb5000e3e7f4f8f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/surface.js\":\"1e75867b4287ea8c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/walker.js\":\"ad4deb1af05d33f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/RescheduleToast.js\":\"381abe4cd59e15d5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/dataExtension.js\":\"bcde5f0e4fb5756c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/index.js\":\"4143c52da6e21627\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/indicator.js\":\"905bc4530316f59c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/moveSrsState.js\":\"b0208693069cc762\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bb85bd9d95b8a394\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/scheduler.js\":\"739124af8d00a37c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/schema.js\":\"37492d6644c8c218\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4fcd2d5d39d20b2f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/srsClipboard.js\":\"ae68f621a5a2fa57\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7006f05562d4c552\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/DailyNoteReviewHint.js\":\"48adbd319a84a1a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/DeckPicker.js\":\"b68191c8417df06a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewControls.js\":\"76e998eac7e9e49a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewDeckRenderer.js\":\"391323f828dd4ca4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewSession.js\":\"9d6aa1e1b432d66d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/actions.js\":\"d9e249ccda5bdec2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/archive.js\":\"15527178c8e43539\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/dataExtension.js\":\"7eae46c4e21ed65a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/deck.js\":\"27b0fe0cef356595\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/dueQuery.js\":\"a7d3f72ee987be98\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/gradeDecision.js\":\"963316f5ddd7a481\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/index.js\":\"d825f2896d5cf8b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/keyHints.js\":\"1a8c9ac453ed2a04\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/reviewCardLayout.js\":\"a0fae8c59cee2d9a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/reviewProgress.js\":\"e20265001381b50b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/schema.js\":\"b67782040756850d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/useDueCards.js\":\"4ba4abbb93768d79\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/startup-metrics/index.js\":\"63336636e8068a89\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/startup-metrics/record.js\":\"cb826e68395b9c0d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/index.js\":\"e6bfda2ae14f6e90\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/persistenceStatus.js\":\"52c5349527fc7dd4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/requestAction.js\":\"5ced10d9cc0fefe1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/TypeChipsDecorator.js\":\"c112eb6ce038c5c5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/codeMirrorExtensions.js\":\"ba5a8d4e6a056d64\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/index.js\":\"f13d6fa1dbdb1df6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/typeAutocomplete.js\":\"2ec4f6e2e4fed675\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5be35175fb7287b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/actions.js\":\"27bda8d742e34dda\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/anchor.js\":\"d7747c19c73ffb4d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/events.js\":\"17cd3cc7aac5c852\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/gestureActions.js\":\"9212d172d3a6755f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/index.js\":\"f9b0b81acc9490d8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1918130b984cdf21\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/collect.js\":\"49eb55e0ce3b0403\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/index.js\":\"a6407343bd7f770a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/record.js\":\"a6f7020540c4bc1a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/RejectionDialog.js\":\"924c2617a5402e46\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ef2d32f1d6aa0c64\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/index.js\":\"91e7aedb731efcd6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/model.js\":\"0dc3564632c7059a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/queueCounts.js\":\"c8667de96c15bcc7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/rejectedHelpers.js\":\"fefeaf64c16a58f3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/rematerializeAction.js\":\"c0aae15cf35c4d99\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/useHysteresis.js\":\"112a7a0a07c3c749\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/effect.js\":\"eadfef7a8757105a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/index.js\":\"4262ef7648fe7140\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/theme.js\":\"1c34333caec062f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/actions.js\":\"ff5a2cb0b5f65602\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/dataExtension.js\":\"d2390a0bb13bb64c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/index.js\":\"9a1ed5f8b9d7be02\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/schema.js\":\"bc32f5c4529d8c73\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0b03d86f6967d660\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/actions.js\":\"6d2ed18de758bc99\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/defaultItems.js\":\"b7388d793b062cf1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/facet.js\":\"9a3ff55f253103cd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/holdRecognizer.js\":\"0f963bbb55e32cbe\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/index.js\":\"545a1fbcfc12753e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/UpdateIndicator.js\":\"f8c004e6ae93bb33\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/index.js\":\"00517c1c52869a7b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/loadTimes.js\":\"e83911f2515415a2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoNotesRenderer.js\":\"e548e919aed4e797\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoPlayerRenderer.js\":\"8574cae32463cc03\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoTimeStamp.js\":\"fe70d9d058e66cb4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/actions.js\":\"61e4f87eedb17e15\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/index.js\":\"819cc1b993a626dc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/markdown.js\":\"802e68ce2600ba1f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/notes.js\":\"2f293c7fc75129e5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/registry.js\":\"edc3e01ec65d4389\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/remark-timestamps.js\":\"b7073d40083312d6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/view.js\":\"da6a82ce5caf8938\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/LinkHints.js\":\"3d77a83ea26012ff\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/index.js\":\"640801d3df8e2d96\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/model.js\":\"332b7ff41e695fdd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/settings.js\":\"421451ce689fbf0d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/actions.js\":\"672a65b7c39c77d0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/index.js\":\"bd92915ba83298b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/interactions.js\":\"00e2715c81679974\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/workspace-header/index.js\":\"ca911cc75cb311e2\",\"/knowledge-medium/pr-preview/pr-1791/src/registerServiceWorker.js\":\"3d3b8af682d72475\",\"/knowledge-medium/pr-preview/pr-1791/src/requestPersistentStorage.js\":\"8ed8912fd7430e70\",\"/knowledge-medium/pr-preview/pr-1791/src/services/authRequestDeadline.js\":\"59deeead21fe7db3\",\"/knowledge-medium/pr-preview/pr-1791/src/services/authStorage.js\":\"49ac83d49d2c7427\",\"/knowledge-medium/pr-preview/pr-1791/src/services/powersync.js\":\"97fbdc6bd2955a5c\",\"/knowledge-medium/pr-preview/pr-1791/src/services/supabase.js\":\"25a0ff70bfdeaeb6\",\"/knowledge-medium/pr-preview/pr-1791/src/services/uploadErrorClassifier.js\":\"2a8a2d4ce2fe40d3\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/ActiveContexts.js\":\"1021d28a25128e2a\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/HotkeyReconciler.js\":\"32687cb26923a599\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/WipeLocalDataDialog.js\":\"af85719b3f0c46f4\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/actionDispatch.js\":\"9f31c80ac7f59fce\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/actionRefItems.js\":\"8c7fade66b5b5223\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/applyKeybindingOverrides.js\":\"002f38929415a203\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/blockActions.js\":\"beade20ac4cdc948\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/canonicalizeChord.js\":\"7f4498bfe01ebddd\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/defaultContexts.js\":\"63245623a9b63d95\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/defaultShortcuts.js\":\"44d88cd39f5fbe7c\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/effectiveActions.js\":\"cca3d90ed91040b0\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/gestureAction.js\":\"66a71d17a2969f86\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/gestureBinding.js\":\"ca1637e725a99380\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/holdRegistry.js\":\"b500d076d94016b6\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/keybindingConflicts.js\":\"73ec34f36949e37c\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/keybindingOverrides.js\":\"2cf06de4fb225218\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/pointerAction.js\":\"9b3d5c82388a2ad2\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/resolve.js\":\"d8994b7e806fe1e2\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/runAction.js\":\"03f545fd80ab3844\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/sequenceMatcher.js\":\"469ea4b1d2e130a1\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/types.js\":\"4fd05c8dccd0d845\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/useActionContext.js\":\"2d26fcb5c6a80b98\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/useActionDiscovery.js\":\"3fe623693875d4e6\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/utils.js\":\"9c8bd83615f11a35\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/bootStore.js\":\"021f62ca08666239\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/previewDatabases.js\":\"0a641889751a54f4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/byteTransform.js\":\"c85dbc52b16e8ce4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/attachmentCleaner.js\":\"426d3b5458475d26\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/attachmentParts.js\":\"ebd7129a09164ada\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/bundleParts.js\":\"f612e745bf93189b\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/bundleRecord.js\":\"5ab1cd33cdf34a37\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/manifest.js\":\"921c5d3e8011f5e3\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/takeBundle.js\":\"40711b27b12efe77\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/verifyBundle.js\":\"8111b70312cd56f6\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/cleaningStage.js\":\"6010f6b168b4e332\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionKey.js\":\"a16976c2355282ec\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionServer.js\":\"8b6c848ac931d434\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/flip.js\":\"b43c9ec28fc25786\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/flipAttempts.js\":\"5f1f4f9b17636145\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/pages.js\":\"00d10f9acc5bb815\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/preflight.js\":\"0fcad36665c2186d\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/reseal.js\":\"fa686eb857773ecb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/runConversion.js\":\"f59ffa38ad7d65d1\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/runLock.js\":\"b3176ea231c2bccc\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/sealing.js\":\"a09b549b8061d209\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/sealingStage.js\":\"f6df4e3afc26c005\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/stage.js\":\"f6a6665316c47000\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/verifyReseal.js\":\"a5bea14aeed7b231\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/aad.js\":\"efca154b06c10fd1\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/aead.js\":\"98c3b8337ca848bd\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/base32.js\":\"bb9ae4b4550eab82\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/base64url.js\":\"62f0aa33a570e9a8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/binaryEnvelope.js\":\"c65b09d2ab2d4838\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/byteAead.js\":\"c0c98662f2b43335\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/canary.js\":\"d2dbaf55c3019351\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/contentHash.js\":\"92cc14cc6bb36c8e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/contentKey.js\":\"d016b8cf111b04c9\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/derivedIdNamespace.js\":\"61ccc0934fb4d062\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/envelope.js\":\"f4c0498d9f175bf1\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/hex.js\":\"f099ddae30a2d3a0\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/sha256Hex.js\":\"64b56e6d85d11074\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/workspaceKey.js\":\"c021d5683a3d4637\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/conversionState.js\":\"bee65f69711171b9\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1cad53de695d1890\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/pastedKey.js\":\"3f8441e1bb15408b\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"eecbed709ccf2118\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/upgradeWorkspacePin.js\":\"58931a5213940ccd\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/keyStore.js\":\"4565752d249203ff\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/mintWorkspaceKey.js\":\"cf8c3d30d2bdf41e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/modePin.js\":\"40b790103d880b31\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/openWorkspaceKeys.js\":\"dd83039b2c57e0b7\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/resolveWorkspaceEntry.js\":\"fd712f20f46daa0e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/resolver.js\":\"8f66483f631bf246\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/workspaceAccess.js\":\"59b6e96da6a86c7a\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/transform.js\":\"23e4342b11028047\",\"/knowledge-medium/pr-preview/pr-1791/src/themeBootDefaults.js\":\"cd992c91e06d7335\",\"/knowledge-medium/pr-preview/pr-1791/src/types.js\":\"1223d16c29e0b3bb\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/ClientLocalSettings.js\":\"39a5265dfc9c2aba\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/abortableSleep.js\":\"572b86d69a72df24\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/array.js\":\"110a60c6b992542b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/backlinkAutocomplete.js\":\"6d403851c3b462df\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/blockCrumbs.js\":\"60213c21331a0143\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/blockrefAutocomplete.js\":\"6db60f6f49c95569\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/cadencedIdleJob.js\":\"5cbc79051a0b2039\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/callbackSet.js\":\"7f0595941cfb5a29\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/clientId.js\":\"cf36acbbf46d11e4\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/codemirror.js\":\"e9eb96cedaaa95be\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/codemirrorCompletion.js\":\"c99a42af3721e024\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/copy.js\":\"cc236718bc434604\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dailyPage.js\":\"b721049f14c04fd9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dbForensics.js\":\"b7eb27d83def7995\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dbForensicsHooks.js\":\"212d342779e27ffc\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/deleteBlockThroughUi.js\":\"c7ea4c2b3df171de\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dialogs.js\":\"9315ee08767acc49\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dom.js\":\"0886459786cadd45\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/downloadBlob.js\":\"7a1fe0ce0a030834\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/exportSqliteDb.js\":\"b9b090295b3b4125\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fileSystemAccess.js\":\"7b72b5bd15d42b20\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/flipSlide.js\":\"e3e50b1a470469bd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fnv1a.js\":\"b0d84bba6bf8f1ae\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/formatBytes.js\":\"552e5d84f277271d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fuzzyRank.js\":\"17ac88f1d6a7f71c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/idbKeyedStore.js\":\"00c227bddadfb82c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/idleCallbackPolyfill.js\":\"9c95144762e2e702\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/keyboardAwareScroll.js\":\"6585ad3cf95ed977\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/keyboardViewport.js\":\"31978fac7a35fb7b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/lastWorkspace.js\":\"945df9e14e4297ba\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutColumns.js\":\"b1fdeabc5720d843\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutSessionDom.js\":\"18ee06377b7b261a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutSessionId.js\":\"7ac0c0211c6f5a1f\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/linkClickGestures.js\":\"88bfb7a58676fa89\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/linkTargetAutocomplete.js\":\"25d55e2ce80f2b24\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/localDbCorruption.js\":\"f319fb29eab02ecc\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/localDbRecovery.js\":\"512f63aa6c797299\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/markdownParser.js\":\"e30a4955065a2583\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/memoize.js\":\"0691b28b62fc3a98\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/nameFieldCommit.js\":\"a4944488533a91e2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/nameList.js\":\"902429203e228bed\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/navigation.js\":\"62985e1c7ad0c669\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/omnilinerNamespace.js\":\"4fb9eb6ae9fb6c55\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/opfsPageScan.js\":\"accf08e7e73707cf\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelClearance.js\":\"c7614261aa07c569\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelHistory.js\":\"adf253e480cb09f0\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelLanes.js\":\"637a3914533bd92a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelLayoutProjection.js\":\"5ba89149fee05405\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelScrollAnchor.js\":\"eda3b7e2b1c7eb3e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelUrlFlags.js\":\"818828d44a9cbcb4\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/platform.js\":\"e9c053d586809169\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/pluralize.js\":\"13d66044c33f60dd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyCreation.js\":\"bf2a85b4e80a661c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyNavigation.js\":\"8b3b44e4996eca78\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyValueContext.js\":\"02f6895e861f3392\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/react.js\":\"0a676ffd3812cd17\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/relativeDate.js\":\"1dd33b2c48beda02\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/relativeTime.js\":\"a0bea3003297f567\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/renderScope.js\":\"eada614796533ed6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/resolvedThenable.js\":\"6c3327b6fd876603\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/routing.js\":\"d63763b569c5481e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/safeMode.js\":\"38bf974dcfd19bf0\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/scheduleIdle.js\":\"eb1d62141ed0aeb9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/screenWakeLock.js\":\"9d333669b6c2a41c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/selection.js\":\"555d392b5ba61985\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/softKeyboardGrab.js\":\"efbccdfbbe775f01\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/startupTimeline.js\":\"18f623c13d989102\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/state.js\":\"bf9e4cdd34455f3b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/string.js\":\"69866ccb2daf651f\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/surfaceZoom.js\":\"5aaf05d05d9128ef\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/time.js\":\"c1d56e0b9be6b4a7\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/toast.js\":\"79988e5a48c76396\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/toggleStore.js\":\"4767da2b1ea567f8\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/untilStopped.js\":\"f6571563bcf7beaf\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/userActivity.js\":\"5a1916f988b5f7cb\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/viewTransition.js\":\"0e903aa892e0054a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/viewport.js\":\"450cea2616184fea\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/webLock.js\":\"cf0ddfcaba4d5950\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/workspaceRecovery.js\":\"27d8ed10b941d5ec\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/workspaceSnapshotStore.js\":\"6cd3516921a4bb6e\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-compiler-runtime.js\":\"59836aa8a47ae24c\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-client.js\":\"78be1e0fae131b2e\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-server-edge.js\":\"c3baac212f965429\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-server.js\":\"fbf51c6c8c29d0d8\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-static-edge.js\":\"fec25a8c848b14bf\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-static.js\":\"3f3666063295f963\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-test-utils.js\":\"8e5fc6311ff1d466\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom.js\":\"7063e0d13bcde6f1\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-jsx-runtime.js\":\"0c05c9d48f8e5f84\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react.js\":\"f66c8912a63126ae\",\"/knowledge-medium/pr-preview/pr-1791/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1791/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1791/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
