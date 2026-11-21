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
		buildId: "af2136fb2579-25a0ecd6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/\":\"6e1c6c5959078b7c\",\"/knowledge-medium/pr-preview/pr-1791/index.html\":\"6e1c6c5959078b7c\",\"/knowledge-medium/pr-preview/pr-1791/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1791/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1791/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1791/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1791/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1791/assets/FacadeVFS-Bo-euXIe.js\":\"447f2a539c77b827\",\"/knowledge-medium/pr-preview/pr-1791/assets/OPFSCoopSyncVFS-_CtkZMqz.js\":\"339816031faeeb9f\",\"/knowledge-medium/pr-preview/pr-1791/assets/OPFSWriteAheadVFS-DDAD00cL.js\":\"c777f8b88f1bb2c3\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-Vk65PKQH.js\":\"f40953ca5d496b3e\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-async-IkXiaC_e.js\":\"f4b7af9b2684e5b0\",\"/knowledge-medium/pr-preview/pr-1791/assets/worker-Bo02BjS5.js\":\"8f5292316ac0f48b\",\"/knowledge-medium/pr-preview/pr-1791/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1791/chunks/app-fpkX8a3L.js\":\"e1bdaa7c540c27f5\",\"/knowledge-medium/pr-preview/pr-1791/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1791/index.js\":\"7deb821704e63ac9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1791/assets/AccessHandlePoolVFS-CUkXUyxN.js\":\"0f1277895214827e\",\"/knowledge-medium/pr-preview/pr-1791/assets/IDBBatchAtomicVFS-B-lG_HH7.js\":\"8e4b4dca750bfe3d\",\"/knowledge-medium/pr-preview/pr-1791/assets/MemoryVFS-DAVi_7XE.js\":\"57820040a430d6e4\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-Comk6hg5.js\":\"af71661f34c49124\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-async-BuvQWzQC.js\":\"8219fad0d844f455\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1791/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1791/chunks/AccessHandlePoolVFS-CAHpoHZX.js\":\"2219ebab3fd253a9\",\"/knowledge-medium/pr-preview/pr-1791/chunks/FacadeVFS-sEb39RsJ.js\":\"d314afc982f72f45\",\"/knowledge-medium/pr-preview/pr-1791/chunks/IDBBatchAtomicVFS-DNmDO0dz.js\":\"9579cfb549c15345\",\"/knowledge-medium/pr-preview/pr-1791/chunks/MemoryVFS-D8DWybR5.js\":\"4b9e12e9fbe20b2a\",\"/knowledge-medium/pr-preview/pr-1791/chunks/OPFSCoopSyncVFS-BuuTTYDa.js\":\"5663965d246a0ae4\",\"/knowledge-medium/pr-preview/pr-1791/chunks/OPFSWriteAheadVFS-XmhlurCH.js\":\"8a8d2d5d8fe805fa\",\"/knowledge-medium/pr-preview/pr-1791/chunks/Preview-BOYGlA4y.js\":\"dbd8108d8e0910bf\",\"/knowledge-medium/pr-preview/pr-1791/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1791/chunks/card-B9K1-Gek.js\":\"c751d06c9c3fa560\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-B2MxnrZZ.js\":\"c232064e57fd70f4\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1791/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1791/chunks/mc-wa-sqlite-async-BtcMySa_.js\":\"c3ae73a8ae3bcf37\",\"/knowledge-medium/pr-preview/pr-1791/chunks/mc-wa-sqlite-krCileQt.js\":\"0a32185cfab892cf\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-B0hgr0_d.js\":\"aca36a4fcb247a11\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-CYd6t1g8.js\":\"579910cc19721dc7\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-C_1YySSN.js\":\"c65d4bdb27999fe0\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-DSJEgE7Z.js\":\"b28aed7fe215c8ae\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-D_NfabNb.js\":\"2bd25b4845e72e25\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-DqVMPLRQ.js\":\"388da41762e6998b\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-YXl6WRJD.js\":\"4860c17a11f3c84b\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server-legacy.browser.production-Cg0NJu43.js\":\"425bad65f93cd6d4\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server.browser.production-CHB2vWBc.js\":\"9e35a8ab40b1449d\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server.edge.production-CF0pYQGF.js\":\"1cfd0ca2b913a2af\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-q1mAD-fq.js\":\"2c668e97ccab5b89\",\"/knowledge-medium/pr-preview/pr-1791/chunks/server.browser-DHAARxju.js\":\"406881bcbd6df06e\",\"/knowledge-medium/pr-preview/pr-1791/chunks/textarea-BJDIQB7w.js\":\"3765131a2751101d\",\"/knowledge-medium/pr-preview/pr-1791/chunks/ui-BV6QM7ni.js\":\"a94f329160671fb8\",\"/knowledge-medium/pr-preview/pr-1791/chunks/wa-sqlite-CSC44jom.js\":\"7d115e3e8799dc13\",\"/knowledge-medium/pr-preview/pr-1791/chunks/wa-sqlite-async-gHwyNybN.js\":\"a294d03e6f241a44\",\"/knowledge-medium/pr-preview/pr-1791/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1791/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1791/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1791/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1791/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1791/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1791/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1791/src/App.js\":\"bdba2d5566391e2b\",\"/knowledge-medium/pr-preview/pr-1791/src/appUpdate.js\":\"8e2d0e2c68b84033\",\"/knowledge-medium/pr-preview/pr-1791/src/appVersion.js\":\"95e618f5a3618886\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/initialLayout.js\":\"30cdb8adee7624aa\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/openWorkspaceData.js\":\"2d7b14b275ccef9d\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/resolveWorkspace.js\":\"6ada4b3d8effc380\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/workspaceBootstrap.js\":\"226e0735ed620907\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockComponent.js\":\"7dff3b011736ed01\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockCrumbs.js\":\"512ceb247d4e8964\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockEditor.js\":\"cbca72cc7a00b197\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockLoadingPlaceholder.js\":\"52a1027c0c411583\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockProperties.js\":\"c03cdf3ca19ce51a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockSearchPicker.js\":\"803e0783dd550f73\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ConfirmBulkDeleteDialog.js\":\"904beb0a3fc82fd6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/DividerHandle.js\":\"0786c291b98edf74\",\"/knowledge-medium/pr-preview/pr-1791/src/components/DraftEditor.js\":\"f8c090bb54e62900\",\"/knowledge-medium/pr-preview/pr-1791/src/components/GutterPill.js\":\"8ed6ad54851b77a2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/Header.js\":\"b77622d084e0290f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/LazyBlockComponent.js\":\"5e217a3558a1cfeb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/Login.js\":\"e0133b16b616d520\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ZoomableSurface.js\":\"91f84b907564e03a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/editModeKeepalive.js\":\"115a9d802c5e8550\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4c3e225ecd5c9277\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7773e3eb4e7fd85c\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/RefPropertyEditor.js\":\"869c981ef08222cb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/RefTargetTypePicker.js\":\"ab1e61c48c2315ba\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/SelectPropertyEditor.js\":\"cb6870ec410a7160\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/TypesPropertyEditor.js\":\"2d0847c2b94c9ec3\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/defaults.js\":\"34b8b7b7e18460f7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/kernelValuePresets.js\":\"2b945f3090f7598e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/selectablePresets.js\":\"804ef27d6b232043\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/typesPropertyUi.js\":\"6342040d8555b976\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/AddPropertyForm.js\":\"735e2e1945c7b03d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/PropertyPicker.js\":\"c6ae93d3f0d34609\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/PropertyRow.js\":\"e3e8c371df380af6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/Rows.js\":\"05aeb7dc45108064\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/actions.js\":\"e741cf05fbc541cf\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/declarationOnly.js\":\"5653b4f8f3e0a751\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/layout.js\":\"7b5f2727fb3e9621\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/model.js\":\"8816bd6824a685fb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/shapeUi.js\":\"9a813fa04eeabdb5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/shapes.js\":\"e8ef17a33e653210\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/usePropertyEditingActivation.js\":\"cbbac18db90bdc25\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/visibility.js\":\"eb689a4f153764b5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanelSections.js\":\"57742fca8a4cb132\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockEmbed.js\":\"22602ab13e3e5232\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockLink.js\":\"8542fb470be8c06a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockRef.js\":\"60cba96447b5905d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/ReferenceLink.js\":\"03c6d3174b31bc0d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/cycleGuard.js\":\"c4846ebfc5d8f78f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/cycleGuardContext.js\":\"365becd79b093f12\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/linkInteraction.js\":\"f3b79bf2f89a7499\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/referenceLayout.js\":\"9f059d1191cee6b0\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/useBlockRefAncestors.js\":\"b90d26d1bf383879\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockGutter.js\":\"22aa8a5232b5afec\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockInfoDialog.js\":\"809dfe331e7dc8cd\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockTypeBlockRenderer.js\":\"edc4753dca9f55e8\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BulletHoverCard.js\":\"5eaa0c784ed6100d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/CodeMirrorContentRenderer.js\":\"722cbc696a6f752e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cfae704ec9e98dc4\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/ColumnResizeHandles.js\":\"5683176a61f0c7c6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1357d850f7a79203\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/DefaultBlockRenderer.js\":\"60da918dc3780597\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/LayoutRenderer.js\":\"9ae3bd803875b03a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/MarkdownContentRenderer.js\":\"d02c0dcfeda8c44d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/MissingDataRenderer.js\":\"cfb58c8d4b1a9ce5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/PanelRenderer.js\":\"01fa8f74dcf4070a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8409fc10d028f6fc\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/TopLevelRenderer.js\":\"7a2994fcc96bc157\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/blockGutterMode.js\":\"1367414c735abb23\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/blockTitleText.js\":\"05d3f9f5360f4327\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/fieldCreationKeydown.js\":\"f02c50da163bf3f9\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/layoutRootContext.js\":\"d76f2f244f45ee90\",\"/knowledge-medium/pr-preview/pr-1791/src/components/typeChip/TypeChip.js\":\"de1dc793021aaf5b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/typeChip/chipStyle.js\":\"4b69adc2be68fe05\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/anchored-floating.js\":\"e381cff24f5b706e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/button.js\":\"a97ba3c73da37946\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/card.js\":\"3ea260c7908762d3\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/checkbox.js\":\"c94a25f3308d20b9\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/collapsible.js\":\"4c7a4c602e81db0e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/command.js\":\"adcf9666d0106cc5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/context-menu.js\":\"8136dd13605ad47a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/dialog.js\":\"169c571ea7214bbf\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/dropdown-menu.js\":\"52203936df33f71a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/floating-listbox.js\":\"3fa36c42ffcca797\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/index.js\":\"f31e85310e67dcc1\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/input.js\":\"92a07615d321ebe0\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/kbd.js\":\"1df38b09f82b9e1f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/label.js\":\"84407f3baf684f80\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/textarea.js\":\"fe586f757b34178e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/useEditModeYieldKeepalive.js\":\"4beea3ff5e4e414f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/BootFallback.js\":\"0a17f4901618d0ea\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/FocusedRowLazyMount.js\":\"80777d537781dd83\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/LazyViewportMount.js\":\"954d4ea498299de5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/LocalDbCorruptionFallback.js\":\"eb8fa289b5352683\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/error.js\":\"62abdb5620fd6000\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/lazyMountRegistry.js\":\"05f0ea5841f1b300\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/suspense.js\":\"ea3efbcb4822b010\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/CreateWorkspaceDialog.js\":\"0d2cefe708d5242f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/PendingInvitations.js\":\"a8b0735fa6c581fe\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/SyncProgress.js\":\"6e42ea2ee9d75418\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/UnlockProgress.js\":\"9be4b8e47c6520a4\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceKeyGate.js\":\"a15b63a03dcce124\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSettingsDialog.js\":\"10750621fc1e8299\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSwitcher.js\":\"ab246309db365a77\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSyncGate.js\":\"6d09569bb71fed2e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/ConversionFlow.js\":\"8ddd41188ba7ba11\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/ConversionFlowHost.js\":\"a5dbb4b19e8df97e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/EncryptionSection.js\":\"04614dd15c7df66e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/attachmentPrompts.js\":\"f02f9473966da141\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d2253f9d551a5601\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/conversionFlowDeps.js\":\"550a214520dfbeba\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/conversionFlowStore.js\":\"af9be9e21f9f066a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/flowUi.js\":\"4e96a716b1b0883c\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/useConversionRun.js\":\"64b18e1a7cb16811\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/keyUi.js\":\"0d48b8e637d5c65b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/useCloseOnKeyLoss.js\":\"44e8909b0e2a7cdc\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/useCloseOnServerE2ee.js\":\"cf255a704e8d1c73\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/workspaceUnlocked.js\":\"9d561a4f5a73d525\",\"/knowledge-medium/pr-preview/pr-1791/src/context/backgroundSubtree.js\":\"d526ef8dec49a572\",\"/knowledge-medium/pr-preview/pr-1791/src/context/block.js\":\"035a670d7fc009e5\",\"/knowledge-medium/pr-preview/pr-1791/src/context/layoutWsContext.js\":\"5373e92662a4c6ac\",\"/knowledge-medium/pr-preview/pr-1791/src/context/propertyDisplay.js\":\"09c1c0d252c94492\",\"/knowledge-medium/pr-preview/pr-1791/src/context/repo.js\":\"4c10f5dfb6402de6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/aliasClaim.js\":\"43b5ba9043b78e8e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/aliasSeatNamespace.js\":\"3e56e7b8e60a41a3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/blockData.js\":\"b210bbc1b976cfea\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/blockType.js\":\"f1d58be23f6bb743\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/changeScope.js\":\"e2389f4b668877fb\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/codecs.js\":\"2bda938eea55da6e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/derivedData.js\":\"f5f5bd7e26dafc8a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/errors.js\":\"1f3e2bc10874a235\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/events.js\":\"78952ec64ef0f2b9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/handle.js\":\"f2bd51c977ae729d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/index.js\":\"1ec02b4756ca64f4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/mutator.js\":\"e436e8545e8b5d4c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/processor.js\":\"ea6490ff9a64d236\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/propertySchema.js\":\"841d218a5792f02f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/query.js\":\"b3dbbe3b43d603f3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/sameTxProcessor.js\":\"4514893125298006\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/schema.js\":\"f2bd51c977ae729d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/tx.js\":\"f2bd51c977ae729d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/typedBlockQuery.js\":\"be2d5d55fdfda0f1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/user.js\":\"8f288be61709a698\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/valuePresetCore.js\":\"03326b62f57ab4ac\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/valuePresets.js\":\"e0023cdf6599983c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/attachmentCleanerIOVerb.js\":\"d19410001c89c578\",\"/knowledge-medium/pr-preview/pr-1791/src/data/block.js\":\"4f986fd57c43e7c4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockCache.js\":\"01091d4fd2b27142\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockId.js\":\"b9bb842c36710411\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockLiveness.js\":\"8578cc8d047b3b1c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockMerge.js\":\"f3b55f03027ebd5a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockSchema.js\":\"810e8996f7851093\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockTypes.js\":\"8f0767840779e510\",\"/knowledge-medium/pr-preview/pr-1791/src/data/clientContext.js\":\"469bac38a519a5b7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/dbFileSiblings.js\":\"bf6053ce674f16d0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/definitionSeeds.js\":\"69fa1577a8232b29\",\"/knowledge-medium/pr-preview/pr-1791/src/data/derivedIds.js\":\"faa75ed0343405af\",\"/knowledge-medium/pr-preview/pr-1791/src/data/drawnSubtree.js\":\"fd989c303574a55d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/facetBridge.js\":\"4095261b93cfd3b0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/facets.js\":\"27287bf5c344493b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/globalState.js\":\"d134930baccd04b7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/aliasClaimRederiveProcessor.js\":\"a5cd8be394d83dbe\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/ancestorBatch.js\":\"6540c3a4153e4b60\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/blockTypeTypeifyProcessor.js\":\"921373152d10993a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/clientSchema.js\":\"6c883b7e25a4786d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/commitPipeline.js\":\"ad9d871515767b27\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/devAssertions.js\":\"4acad0bb79ef17d5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/firstSync.js\":\"bf609971ceeca5e5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/freshInitialLoad.js\":\"4101e3699c6d0b9e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/graphBackfillClaim.js\":\"def12278155e872e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/handleStore.js\":\"fd8f6eabc842f35f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/idleMarkerJobs.js\":\"b49596935c1e25dc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/initialDownload.js\":\"16e70a03262788d7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/initializeClientDatabase.js\":\"a048497caf969141\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/jsonCanonical.js\":\"215f4f7ad74f4827\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelInvalidation.js\":\"8ebec887587c977d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelProcessors.js\":\"36b83bfd6a4adb7f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelQueries.js\":\"e9efeed27ca3eacc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/mergeTypeMembershipProcessor.js\":\"de43becbb27e056d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/normalizeReferencesProcessor.js\":\"765c7a0a84702fa8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/poolInstrumentation.js\":\"9364b401ffe92006\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/processorRunner.js\":\"0de9295396403c20\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyCellBackfill.js\":\"70594eb82541425c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyChildMint.js\":\"b3ba5dca5cb9c486\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyChildrenProcessor.js\":\"51a4333b19e74e41\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyDefinitionChangeProcessor.js\":\"077398bf46825326\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyDefinitionSynthesis.js\":\"0e4597ac170ab5e5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyKeyScan.js\":\"b02fc563de7b4ba2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertySchemaResolution.js\":\"143e3c6fa7e0ce7f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/raiseProtocol.js\":\"dd415f47f65e0575\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/readBatch.js\":\"cf022e83fb814da5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/refProjection.js\":\"f3af4ebf6ce1a736\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/referenceTargetLookups.js\":\"9bde0e75c6c01eaf\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/referenceTargetProcessor.js\":\"8b3fb1769e2e823d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/replayMerge.js\":\"11f99e866912ff52\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/sqlBinds.js\":\"60e4a810aa321e39\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d751f0468cdee2d3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/arrivalProcessors.js\":\"ceaa4657438a0ae6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/invalidate.js\":\"86fc43969dd79a89\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/materialize.js\":\"e46a683654b5d2d6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/observer.js\":\"eb628519b19421df\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/reconcile.js\":\"d4424a8a4326e7bd\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/timingMetrics.js\":\"a21addd42f9b7b82\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/treeQueries.js\":\"3ffe42e5e3dbd060\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/txEngine.js\":\"ec318588ef31a647\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/txSnapshots.js\":\"86c2c63b8ce59a37\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/typedBlockQuery.js\":\"aebf0b241186302c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/undoManager.js\":\"98e0eb8af568f8d5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/invalidation.js\":\"c5c4c901c1205772\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelDataExtension.js\":\"8c63bc98c4d3567a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelPage.js\":\"446ef76efdd67dfb\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelValuePresetCores.js\":\"fe282dbd593f6e0b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbCorruptionSignal.js\":\"dc679c8aa6193b3f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbStorage.js\":\"0904350bb883c252\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbVfs.js\":\"76a36d39159330bf\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localSchema.js\":\"95dd2544822b0c02\",\"/knowledge-medium/pr-preview/pr-1791/src/data/maintenance.js\":\"6dc0c05983112db7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/mergeProperties.js\":\"458cca8fe3315d7b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/metricsConsoleHook.js\":\"10846f5f30617453\",\"/knowledge-medium/pr-preview/pr-1791/src/data/migrationsPage.js\":\"e827c525579b59c1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/mutators.js\":\"c4bb711a6c6411de\",\"/knowledge-medium/pr-preview/pr-1791/src/data/orderKey.js\":\"55d8ddcaf0a544ea\",\"/knowledge-medium/pr-preview/pr-1791/src/data/orderKeyPlacement.js\":\"ae3f90e15b970e16\",\"/knowledge-medium/pr-preview/pr-1791/src/data/outlineSurface.js\":\"3db69a4e6d9838c3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pendingEditorContent.js\":\"d9eb99943b54e8ac\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pendingUploadsSql.js\":\"dcda7f889429e351\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pluginStateExtensions.js\":\"2aeff103587cd66b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/powerSyncLogger.js\":\"79171a5309c12558\",\"/knowledge-medium/pr-preview/pr-1791/src/data/projectorRuntime.js\":\"58fd7e76402ee593\",\"/knowledge-medium/pr-preview/pr-1791/src/data/properties.js\":\"02f28b708a2ca12e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertiesPage.js\":\"f3d19198130afc8f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyChildren.js\":\"0e586573e97001f1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionFanout.js\":\"2c0f1c9a7a1cdef6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionMetadata.js\":\"d23495b333bb64e0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionRegistry.js\":\"95a6800b043afc19\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDisplayMode.js\":\"1d8b0e94ee62734e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyRowCreation.js\":\"853c3f89fa9f90a3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertySchemaCreation.js\":\"42bba8faf02b1cea\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertySeeds.js\":\"1142a427ced56e58\",\"/knowledge-medium/pr-preview/pr-1791/src/data/recentsPage.js\":\"c731b7948dd05cd2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/referenceBlock.js\":\"aec5b8b54f4ba979\",\"/knowledge-medium/pr-preview/pr-1791/src/data/releasePowerSyncConnection.js\":\"24106568a49381eb\",\"/knowledge-medium/pr-preview/pr-1791/src/data/repo.js\":\"01f6f37621678c4c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/repoProvider.js\":\"887ec842ca3e9305\",\"/knowledge-medium/pr-preview/pr-1791/src/data/rowProperty.js\":\"264533671e5f742c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/searchFilter.js\":\"141d063f91a3610f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/seedIdentityLedger.js\":\"9e5f99aca6c293c8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/stateBlocks.js\":\"1040f34ba7fbcc59\",\"/knowledge-medium/pr-preview/pr-1791/src/data/structuralEditPolicy.js\":\"5dbf6bb4404e007b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/subtreeDelete.js\":\"9e9d573724884e38\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncStreamLock.js\":\"69fbe31c3fbc3420\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncedTableSqlRecognizer.js\":\"e3a4feb575cc8835\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncedTableWriteGuard.js\":\"1ca003c6eafd626a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/targets.js\":\"8c5313bf2021cf98\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeColors.js\":\"67bf80b717002b5d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeDefinitionMetadata.js\":\"67f199bd8feac0a2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeDefinitionRegistry.js\":\"211aad8dde39872e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeExtraction.js\":\"0df91a0e32519bde\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeInitialValues.js\":\"5c534c2957d5d200\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typePropertyGroups.js\":\"a09b15ec299c1f2d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeSeeds.js\":\"5923685cf8310a41\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeTagger.js\":\"aa09a08f3f2405b3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typedRecords.js\":\"1eb13385c38a9be3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typesPage.js\":\"7b2f162e9db02ec1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userPrefs.js\":\"33630c67cd2281d9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userSchemasService.js\":\"b223efaaccda45ed\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userTypesService.js\":\"f3627b6f52dcfb62\",\"/knowledge-medium/pr-preview/pr-1791/src/data/valuePresetRegistry.js\":\"f17327d48eb98c4f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/visibleChildren.js\":\"6d11d38a62fabf90\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceConversion.js\":\"2b2d5ebd43bcc27f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceFirstSync.js\":\"1469b00024cb816a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceIdNamespace.js\":\"f3362abe6a47e73e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceSchema.js\":\"adab67b010f0fd0c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaces.js\":\"95888aedddc3f6d9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/writeAheadLog.js\":\"86119bb198386434\",\"/knowledge-medium/pr-preview/pr-1791/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/BlockPasteShellDecorator.js\":\"423dc93f916265ec\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/atTrigger.js\":\"f55e164aec041faa\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/autocomplete.js\":\"d5f7a768f0c21beb\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/codeMirrorExtensions.js\":\"f149a2928b4dbb12\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/contentFlush.js\":\"f356bf13d991965e\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/defaultInteractions.js\":\"711cca700d30d5dc\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/editSettleSignal.js\":\"de4039fdf9ee44bb\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/insertImage.js\":\"23e004fb51acfb58\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/referenceCompletionRange.js\":\"b4a0df7ac78db5ea\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/referenceTargetTypes.js\":\"bd41f298e4135687\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/syntaxContext.js\":\"ed4c9669173d6908\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/triggerMatch.js\":\"a737e92fad9cdedf\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/AppRuntimeProvider.js\":\"f952927f68179fc3\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/BlockFocusShellDecorator.js\":\"36d049a58442d65c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/ExtensionRenderBoundary.js\":\"d3fba8957eaea7a9\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/PanelContentRecovery.js\":\"336c2d465ff48dfa\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/apiCatalog.js\":\"4d3b9accf6844263\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/approveExtensionHere.js\":\"4e8d3731190d748d\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/armedCutAppMount.js\":\"fb90221e0a1bdd84\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/batchableKeyedStore.js\":\"b6b91a1028ffec6f\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/blockInteraction.js\":\"b36bc99c901c8146\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/blockSelectionAction.js\":\"69dbeca26249d607\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/compileExtensionModule.js\":\"ee53c980a2e0512a\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/compiledModuleCache.js\":\"2e65b3f6e50768ca\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/continuousGestures.js\":\"848a9e0613abeb8d\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/core.js\":\"764924335877e92b\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/defaultRenderers.js\":\"68aec957b03cccc5\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/definitionFanoutAppMount.js\":\"4b7852e3441484df\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dialogAppMount.js\":\"e3ea677615aef1e0\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dynamicExtensionSeeds.js\":\"490c3a1d5cfc00bc\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dynamicExtensions.js\":\"2cf436b35dd39f42\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/exampleExtensions.js\":\"ee347996a20804e4\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionApprovalStatus.js\":\"4f0003d1e222ec5c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLoadErrorToast.js\":\"107e582ed63ed722\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLoadErrors.js\":\"9089863f624d5d80\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLookup.js\":\"7ac159c74bd572fe\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionToggles.js\":\"95b03d312d127857\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionUtilitiesCss.js\":\"3751facf8ba28616\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/kernelPageDeletionGuard.js\":\"aaa8de45bff182b0\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/liveRuntime.js\":\"c469204331c3ec57\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/openExtensionsSettings.js\":\"d3fb2c9aaaaa148b\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/overridesCache.js\":\"a7345364aee34a59\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/pluginIds.js\":\"5e83e13f15aa3822\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/processorRejectionToast.js\":\"421b5116b2114682\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/runtimeActions.js\":\"4c3a48d0ee48a9a4\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/runtimeContext.js\":\"d1a1cfd7a3399f73\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/staticAppExtensions.js\":\"5eb1079706631ec4\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/staticDataExtensions.js\":\"aaac39a97d48084f\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/toastAppMount.js\":\"cbe75e10439b0fb7\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/useOverrides.js\":\"eda3cd7eeb6fc812\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/useShortcutSurfaceActivations.js\":\"903ad6b51cc403d5\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/discoverToggleTree.js\":\"b1e5eddb24a54d6a\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/facet.js\":\"31f3c7a0efc2d377\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/resolveAppRuntime.js\":\"ff6d2796761529d2\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/runtimeEvents.js\":\"2bb4ae64af05e550\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/togglable.js\":\"684b6bdee6b59a7a\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/variantFacet.js\":\"25f6ee94071c3abe\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/verbFacet.js\":\"cb546e3d13104dde\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/block.js\":\"5823743e12c66a4d\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/focusedChild.js\":\"306fc6b445665b07\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/propertySchemas.js\":\"3a4de46ec7e48fee\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/typeRegistry.js\":\"c0297106cfcd42a1\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useAncestorCrumbs.js\":\"219d4fa2c40a32d3\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useAutocompleteListbox.js\":\"89dbc1a0eb079a6e\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useDebouncedSearch.js\":\"11cc499ab920ac7d\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useDebouncedValue.js\":\"f999c06b304dad54\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useIsFocalRender.js\":\"7d5c57a026590bdc\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useIsReadOnly.js\":\"3c934eace214e9a9\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useMaterializeBacklog.js\":\"8165315cdbd4d9a9\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useMinuteClock.js\":\"903f1274d042971f\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/usePanelLayoutProjection.js\":\"4712030148d92233\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/usePendingInvitations.js\":\"11852c81b22d59f5\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useRendererRegistry.js\":\"096af02abd094cec\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useRetainedFieldRows.js\":\"22d11759fa1e41aa\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useWorkspaces.js\":\"9a18ad31cd9589ad\",\"/knowledge-medium/pr-preview/pr-1791/src/lib/utils.js\":\"ffe0a834f5974c88\",\"/knowledge-medium/pr-preview/pr-1791/src/main.js\":\"8e75534764085725\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/MarkdownImage.js\":\"19c288c466c10c91\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/blockSeparators.js\":\"adb404d2d13d243b\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/context.js\":\"ca6a4b47fe7045e8\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/defaultMarkdownExtension.js\":\"67b3066d1abcb2f0\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/extensions.js\":\"c7fcf037fab512e6\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/renderMarkdownHtml.js\":\"5cf9d7d5a58df677\",\"/knowledge-medium/pr-preview/pr-1791/src/minimal-editor.js\":\"4ae3e6fc172f2cab\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/armedCut.js\":\"c0622bada862016a\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/captureMediaVerb.js\":\"a23c4bf1f0465e02\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/clipboard.js\":\"03ca490f09f25df4\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/decision.js\":\"b19f334a989f79b6\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/operations.js\":\"950585526f79ad8f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/account-header/AccountHeaderItem.js\":\"56118e367e9b6b46\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/account-header/index.js\":\"062e7c05eb865a00\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"52e18ac937bf79f6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/askAgent.js\":\"915fb05d98bebe90\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/askedStore.js\":\"53bdd840348afae2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5db9749f2660a833\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/chipState.js\":\"1977ca09b2a16189\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ff0c6193fcb077f0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/index.js\":\"b9b1fa7895527994\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bb039b064a614f94\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/schema.js\":\"daab13d5ed4baf54\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d73463787d4097c0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/BridgePairingDialog.js\":\"78fc7e4710b21368\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/addMedia.js\":\"2032fa2de3b045d8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b9f4dc6c73e3357c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/block.js\":\"bdc9b9c0fd267ed3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/context.js\":\"559b3e5c83e33b56\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/displayIds.js\":\"147962806f1dcd92\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/index.js\":\"3030548b63664954\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/outline.js\":\"b22669e4e47fca54\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/properties.js\":\"a4e01c69d2ae484b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/refs.js\":\"1fa4f42dec266bfb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f2f2a9f4371ea6e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/search.js\":\"f352d909f17207e6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/shared.js\":\"49da6299843b8045\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"13bfc7d5b3d55fda\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/text.js\":\"f4f6a45dd989c8ce\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentWrites.js\":\"1ed3e9c9ef7e6747\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/authoringCatalog.js\":\"7e7dfd7d914bb61e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/blockRefTargets.js\":\"c95943fcf00b2024\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/bridge.js\":\"f38a43c79316e730\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/bridgeLoop.js\":\"da5cde3b84f8c207\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/changeHistory.js\":\"28d5d98f2882836b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/commands.js\":\"4e88bce30b0c7073\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/commentsCommands.js\":\"0e27d4b58beffb00\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/dataExtension.js\":\"f3b7f1e146f2c55f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/dataModelGuide.js\":\"28fd722b4eb63f45\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/describeRuntime.js\":\"f202c678d20e54be\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/extensionLint.js\":\"e0b164d5e43162ec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/grainAudit.js\":\"8ba8f11b4b69c93d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/healthCommand.js\":\"c7a9c45cb2eb46ec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/index.js\":\"3d80b5b0ee2ed6ab\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/presetIdentity.js\":\"3d1b7567f30d964d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e45becd4b75b35a0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/readMedia.js\":\"be3ad1a7c1b460de\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/schema.js\":\"2a36ed50a24ed447\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/serialization.js\":\"13bdd62e4911d50f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/targets.js\":\"e71499da95b510b3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/tokens.js\":\"c560999d342b56f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/watchEvents.js\":\"a04b73e332a9d599\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/workspaceGuard.js\":\"874a36c30685ed8e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/writeCommands.js\":\"cfc32004c7e3ca92\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/AliasCollisionToast.js\":\"80ef4dc0e579926e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/DuplicateNameBanner.js\":\"00ff6289a135f89f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/collisionMerge.js\":\"ca0bc60111f86578\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/dataExtension.js\":\"556996f59b817b70\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/index.js\":\"80b518deef671721\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/mergeCollisionAction.js\":\"ac33347c7d13a278\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/pageStyling.js\":\"77ee2926b37a3659\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/rejectionToast.js\":\"d7c8936e89e795b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/syncProcessor.js\":\"9673b800c4cc5882\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/actions.js\":\"fb09b87e9c75446f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/addComment.js\":\"ad7101bb1d44c024\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/anchor.js\":\"d323b8a2883ab3c7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/anchorState.js\":\"749b9061965300ba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/commentLinks.js\":\"120b433a92631a10\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/confirmThreadDeletion.js\":\"c5612547adc2f5f6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/container.js\":\"826172c50287ccdb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/dataExtension.js\":\"2b621b09a993f87e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/deleteComment.js\":\"aed210f8449c82e0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/highlights.js\":\"4506e1569c65ba0f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/index.js\":\"99ee4e8496a701cd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/linkedCommentsPill.js\":\"a688a019a4f4b56a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/margin.js\":\"b3655d291c8401b2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/marginSchema.js\":\"90172ed26639b788\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/newComment.js\":\"fa2406212cb7ba9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/ownThreadPicker.js\":\"1c4ba6464b0fc95d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/placement.js\":\"d77c19cd366d8ff9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/queries.js\":\"2f0017f2d4896fcc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotePosition.js\":\"d9f801cf0d125649\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotedIn.js\":\"eaaf983a3a77f8de\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotedRange.js\":\"02b84c77a71e85b0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/rangeRefs.js\":\"cac07aefd48f6b91\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readHighlights.js\":\"f6fc9dbae5a9dd41\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readSelection.js\":\"e0d46ea95a324926\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readSelectionUi.js\":\"c08a695613d58cf0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/reanchor.js\":\"ab0721d527983e2e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/schema.js\":\"04f589d37c63d9a7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/scope.js\":\"6ef44af204694d35\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/scopeThreads.js\":\"bcd8f741303d126e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/splitRetarget.js\":\"2ae4d9d1571a772d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/suggestionCard.js\":\"62b523f04deab737\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/suggestions.js\":\"6c68ad9015b11757\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/summaries.js\":\"60d16f8b8b4c84c6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/summaryBatch.js\":\"4259d848b37ff6f0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/surface.js\":\"6bfa499fe4d82d2a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/threadNavigation.js\":\"2d1ce3c6d27c3ce2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/threads.js\":\"e2061d93c4eca1c5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/ui.js\":\"f69523e29d4cd2c1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/uiStore.js\":\"72bedc93b07a11b1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-intents/appIntents.js\":\"6d771c9f7f30ab1a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-intents/index.js\":\"6da7a74cac565839\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-update-prompt/index.js\":\"99ab3da70cb2dc0c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-update-prompt/status.js\":\"6ee675d5c96abb0d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d7349c1065b8f548\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaBlockRenderer.js\":\"5ebcdefb8b0dc476\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5cd90f111dd72a61\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaUploadReconciler.js\":\"e4235c8514fcba62\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetDownLane.js\":\"33744b92a4f17870\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetResolver.js\":\"067c06177a3a2ec0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetUpload.js\":\"eb1f90da49bb494c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/attachmentCleanerIO.js\":\"e75122ff89e1fd66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b9684b0a04ce0d3d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/blobStore.js\":\"194baa05ccf08b41\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/byteStore.js\":\"42a49bc07265cc3d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/cleanerIO.js\":\"a9b30539ed8d744e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/cleanupAttachments.js\":\"fd870bed8289349a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/dataExtension.js\":\"5a0e873cc527e394\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/downLane.js\":\"a58659b772e24f89\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/index.js\":\"d2c31fee46cfb694\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/insertImageContribution.js\":\"ba0f340d1bb31ae5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/laneArming.js\":\"e4c27c1e6154f181\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/laneLock.js\":\"19d9c169545bc96f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaBlock.js\":\"43702e5e6662c0df\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaCapture.js\":\"e170bdc95014cb21\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaViewers.js\":\"991c7149236ed4b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaViewersFacet.js\":\"ddc3feb085f745a0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/pasteCapture.js\":\"d2768dcbed2bc3f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/resolver.js\":\"0c3c47997a029aa0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/retryUploadsAction.js\":\"c3d04e9a3b979cb6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/storagePaths.js\":\"1a975aecfc706ec5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadDrain.js\":\"031ae516119ab8ba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadLaneStatus.js\":\"55adc29b8667a5e5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadReconcile.js\":\"0913754662035082\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadRecovery.js\":\"c5071a30944454eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadStore.js\":\"d6d8d2e5a7cc0f49\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/useAssetObjectUrl.js\":\"1e04295ec091243b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fedc1aac421111ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/BacklinksViewSection.js\":\"cd66ba1feddc3e4e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/facet.js\":\"768e70768e180a8e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/index.js\":\"1ba279c760a31af5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/prop.js\":\"20ed52e905366c92\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BacklinkFilters.js\":\"f3663db7cdceb8c3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4fd05f47217f8ae7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BlockEntry.js\":\"1920b9271d872288\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/LinkedReferences.js\":\"192920f3a91d8345\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1241a30e3b1608ab\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/dailyNoteDefaults.js\":\"22ce8ad501733254\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/dataExtension.js\":\"b065b0334c6d3edf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/edgeExclusions.js\":\"874d8a311c3fae58\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/filterProperty.js\":\"44bdaf453bad9370\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/index.js\":\"8451c24c3346e12d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"8b95fed8cf701647\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/applies.js\":\"16b56fcbb4401f65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/countQuery.js\":\"1527648976c9e890\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7c3565847c5663cc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/index.js\":\"00b4915fcc99831f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"32601bd536a2b460\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/presentationInvalidation.js\":\"da5c087f42d8666d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/propertyEditorOverride.js\":\"82247f0cd5497b0f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/propertyFilter.js\":\"5032b4274e0ba70a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/query.js\":\"9aacced52a67c174\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/resolveFilter.js\":\"41d192baa9a48fd0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/sourceBatch.js\":\"f24938c177cc4df7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/sources.js\":\"6cf355ae99ba3650\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/useBacklinks.js\":\"93e308c03232da8f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d89e1a2e873caa51\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/BirthdayCelebration.js\":\"3839150a6c512fd4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/BirthdayOverlay.js\":\"4326d5d35ffd69ae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/gate.js\":\"e84ba90c8fa73f01\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/index.js\":\"611957b477b75d79\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/wolfTheme.js\":\"1c673fc5c63b5b9d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/BlockDragLayer.js\":\"75adc7a7fa77ab8e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/dragController.js\":\"cf97f04c2aaaf8d3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/dropTarget.js\":\"e9a937f68e60049a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/index.js\":\"4285fdedf384e26b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/projection.js\":\"79d7eeb8de195fce\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-info/BlockMetaCard.js\":\"8710eb152f7bcbea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-info/index.js\":\"651c09de832be471\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/AddTagDialog.js\":\"72f3cf9754f6990b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"898cee494eb579c6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/TagNameIssueHint.js\":\"3602af175dfd0dd6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/addTagAction.js\":\"fea996732fe0af4f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/appendTag.js\":\"eb6548769be326d0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/config.js\":\"6ffb47a1a64b5eac\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/dataExtension.js\":\"562b14bb79e03b9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/index.js\":\"3fa7e8e438253174\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/propertyEditorOverride.js\":\"84fbfcbc6d174751\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cb0efd20a80969f1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3d8a460929cd69ed\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4c69065bd0cb2965\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9dc192bed287fbe6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8163892a2c5faa0b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/index.js\":\"32e234c0c8c0c76e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"00c448cebd72845e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/CharacterCountItem.js\":\"2dadf7d25e9eb032\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a3f87b73c6690b4e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/actions.js\":\"c4ce45c917230dae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/blockType.js\":\"884405987acd3226\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/charCount.js\":\"575a3f7b8cbce138\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/dataExtension.js\":\"e51740bd13839f9a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/index.js\":\"769e52664cac50a7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/profiles.js\":\"10811454802b35e3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/properties.js\":\"77ff9390a6b3e69a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/textCounts.js\":\"d6c40a5c01bcdd1a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/colemak-keybindings/index.js\":\"b1abb77d28efdc8e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/CommandPalette.js\":\"e5df86f96d2b432e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/HeaderItem.js\":\"532355bbab700045\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/context.js\":\"b798027d8bf7d12f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/index.js\":\"0b1502f5b02f66da\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/selection.js\":\"aaccbc7473811d51\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/toggleStore.js\":\"3244edf8b08ee7f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/useCommandPaletteActions.js\":\"9ed31ddbdb7df3e7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/ContributorBadges.js\":\"a36bcc5d95b240b4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/author.js\":\"e4ffa885c070c73f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/codeMirrorExtensions.js\":\"764b8552b20035a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/dataExtension.js\":\"087ac4c6862bf5b4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/index.js\":\"bb8ccf63397e2f9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/mentionAutocomplete.js\":\"ff34ce0a135987dc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/processor.js\":\"8cf330e23a80bc9e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/profiles.js\":\"6e3ffb9ffa0ffbcf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/queries.js\":\"dda1c935d295f5e8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/schema.js\":\"347078fbf9a74008\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c47d34137540049a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/followOrigin.js\":\"93615cad977a901c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/index.js\":\"8bd3e1727f2c6829\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e156947c56cbb43c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f5db2900b072a56b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/CalendarGrid.js\":\"f64a4c99420a4d22\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DailyNotePicker.js\":\"270df0c1d0c5abc8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3c62a131e7034b9a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateNavDecorator.js\":\"df6ec3bbd11a0d91\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateScrubOverlay.js\":\"8f8aa941e411d0d9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/HeaderItem.js\":\"44f4b172bc49e992\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/ReschedulePicker.js\":\"e7b4630a0db0f146\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/SpreadDatesDialog.js\":\"fb2fad3454e73b28\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/actions.js\":\"16a39af6f5b2a506\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/blockDateAdapter.js\":\"df2f3c22d1030910\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/calendar.js\":\"c2d7d3ce249a7343\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dailyNotes.js\":\"75067c53db732aeb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dataExtension.js\":\"fdc430ab43867695\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubActions.js\":\"57203e81aa446202\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubGesture.js\":\"d19580c0ca376891\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d190ea4f564bfbde\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0d6735a13e049fa5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/deletionGuard.js\":\"6eb3faf970d0f64d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dueQuery.js\":\"1afe407c16f0bb0e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/index.js\":\"b140911b7b273d5f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/landing.js\":\"c3137effa1b43d76\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/localSchema.js\":\"ba8bb7ec3c9e4e66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/referenceDateAdapter.js\":\"4ea6e3f72d2d6df1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/rescheduleAction.js\":\"3181cfc181523278\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/schema.js\":\"8b467b7e69f7642b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/spreadBlockDates.js\":\"45c018d2d5e31c39\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/spreadDatesAction.js\":\"8823bedf59aef5a8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/today.js\":\"83fb646624d3ab1e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"093601d5de315a9e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d8645daec77e1149\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/audit.js\":\"1b237b1beaf8ad0e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/auditAction.js\":\"83b1a9112606b2a0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/auditRanges.js\":\"c5a776d3f19717e6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/diagnosticsSource.js\":\"94b24c7b545b41ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/divergenceScan.js\":\"4283c458f42a9618\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/index.js\":\"9e5f9869acce868e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ad6264a119e8f1c4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/referencesMirror.js\":\"20f5b6b2ccf45f2f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/rowJson.js\":\"997e3e1a54c5f090\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/schedule.js\":\"8d2abb78b793ee9b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/store.js\":\"6506163ec97933bc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/action.js\":\"c107aba53b6ec82a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/index.js\":\"2d004e360b179e03\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/plugin.js\":\"a98042ed67d75c13\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3d8148450438a59a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/actions.js\":\"f11dc48e308e8351\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/changeMarker.js\":\"73055ba17d7b219d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/diagnostics.js\":\"657989f6b1b3c620\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/fileSystemAccess.js\":\"fa7666cbcebcc59f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/filenames.js\":\"5a2a7aef1e305c88\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/index.js\":\"449f408e31c83358\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/mirror.js\":\"9cefd4f76c40d2d9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/runLock.js\":\"3953406383efa95a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/runtimeHealth.js\":\"f8b382c0dc7be17a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/schedule.js\":\"f68e5a2eba2d879c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/store.js\":\"b0ba4ddd83d1dcaf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/default-themes/index.js\":\"b262957e840bbda2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/default-themes/themes.js\":\"71422aa4903ceab1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/diagnostics/facet.js\":\"32d5ea2da19b8b68\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/diagnostics/useDiagnostics.js\":\"1b8f14ef06b2de93\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/dismissals.js\":\"21cc96370fe740f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/index.js\":\"1a0caf997ec95b58\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/status.js\":\"5a3ed666660f44ec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/store.js\":\"47176c1d4d4c1f44\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f1f0f613dafadd33\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/ExtensionsSettings.js\":\"61884dc6e9f41c12\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/actions.js\":\"124545323e619e1e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/config.js\":\"5cd95a0cd025c262\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/dataExtension.js\":\"f2196d3511116f3d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/effect.js\":\"1a9183821e5d8a10\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/index.js\":\"b1e97087c0e204bd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9047c721236ea3a3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/useToggleTree.js\":\"38bb69e3bb8bb358\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/ExtractTypeDialog.js\":\"24684491bb3cf2ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f30f38bee07c75dd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/PropertyShapePicker.js\":\"05dddbc9c5a3e376\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/action.js\":\"5f55968ad8f46356\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/index.js\":\"aa564e663b586ff9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/FindReplaceDialog.js\":\"c136d5321f86d65f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/HeaderItem.js\":\"6f4cd948953a6048\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/dataExtension.js\":\"c566b3fe64bfcb56\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/index.js\":\"5afe738e9a6c9eca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/search.js\":\"1f20ce3b1d8b7eb7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/toggleStore.js\":\"3f9ac8c55c144afc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/LocationPropertyEditor.js\":\"59770e1bc1cebc21\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/MapView.js\":\"0020318ecb24937a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/blockTypes.js\":\"0d81195bc21c76f8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/codeMirrorExtensions.js\":\"9437bf9c641b269b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/createOrFindPlace.js\":\"7719dfadc8b540e7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/currentLocation.js\":\"4c25885bd8361ee8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/dataExtension.js\":\"cfec82d88fa440d5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/geoContentDecorator.js\":\"83a765271ff8f48d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/googlePlacesClient.js\":\"f579f322ce15f6bf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/index.js\":\"caee49e0558d1c67\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/locationsPage.js\":\"15d6e51c377de773\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/mapViewport.js\":\"29855eff3fdbb428\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/pickCurrentLocation.js\":\"e3a1be38cf65b22b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/placeAutocomplete.js\":\"78a0a96061aad895\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/placeNameCollision.js\":\"f1a0834ed299b35b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/properties.js\":\"be5980c856d47b6c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/propertyEditorOverrides.js\":\"755edad7bf5bc33f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/query.js\":\"c7a4a7d51d9dbc8c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/usePlaceSearch.js\":\"2d0f198ca21421b9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c546af94935f0663\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d3bdf1b0598d240f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d7781ee2e4be4545\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/config.js\":\"90ad91222b27a1ca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/dataExtension.js\":\"4779338fc470e00b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/facet.js\":\"4c6d4956f41db085\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/grouping.js\":\"9e7ac433b5332ebc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/index.js\":\"06561454f55e3695\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"df7904a9677f9d6a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/query.js\":\"970b69577f839aa3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/resolveConfig.js\":\"44aa0c979ddb6739\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"14e2a2fbed9aa114\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2ec527ad7acae71d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/HtmlDocumentContent.js\":\"c318b8781363e6b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/HtmlFrame.js\":\"2ae40abf86e391ed\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/actions.js\":\"7a1cd69e33db0201\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/blockType.js\":\"c6a45ad7f614ce21\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/confirmRunScripts.js\":\"5c65da9541fc2333\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/dataExtension.js\":\"421623db3da08555\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameAnnotations.js\":\"4acbb1e27b178052\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameDocument.js\":\"0210ca16b2e46acd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameTheme.js\":\"35c37a888b0c8559\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/index.js\":\"dbba9a9d978a76b3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/scriptConsent.js\":\"cca1f27f86b65ab2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/sourceMap.js\":\"e87800adae6ea2bc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/useDocumentScripts.js\":\"e9c852e9795368ad\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/index.js\":\"514f6b0316c44842\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/record.js\":\"91f7da63d7414841\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/recordStore.js\":\"e1cf2dea251347ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/responsiveness.js\":\"bfb38132bf541b22\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/schedule.js\":\"b7103b377c46a466\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/sessionContext.js\":\"b74d9216b68c12f3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"03e62f3184618fb8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"17b7261a554cd36d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/actions.js\":\"6e16026734cd498e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/config.js\":\"e73c259addfc3e23\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/dataExtension.js\":\"d57fef31665d222f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/effect.js\":\"099267afee31a8ba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/index.js\":\"a45fe5efa1e71818\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/keyCapture.js\":\"15551f47beccffb4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/overrideStore.js\":\"5ad2d4fff4b87015\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e8dbd8564872849b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/HeaderItem.js\":\"e610924cb486033f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/LeftSidebar.js\":\"6a4a28802852c4b3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/actions.js\":\"3b80595e4a330e82\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/facet.js\":\"6339db3f8a8b69d2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/index.js\":\"bf1658864d005f28\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/shortcuts.js\":\"48ca0b64028fd517\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/toggleStore.js\":\"05682f0f2f46cb5c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/MergePicker.js\":\"0a8e7a3b71f3dc0b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/index.js\":\"010a5a4a04a3e140\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/mergeAction.js\":\"b3c47c119f5bbbb8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/strategy.js\":\"6ff6094104735fa6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/Button.js\":\"03ca922d9006aa29\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"84309820e250c200\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c54bb2ef226443d8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/facet.js\":\"441342b505a5414d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/index.js\":\"d8d946c10aa80f3d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"72145192ae35fedb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/actions.js\":\"45f13e1a8e55b220\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1f73ea823ea860d6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/facet.js\":\"34996a59246449cb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/index.js\":\"cb48bdd0c58f1e5f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4f6bbae9d31c1f7d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/blockSubtreeMembership.js\":\"63bbaf9cdd6e3666\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/contextMenuItem.js\":\"01b3ef96f09c129b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/index.js\":\"0f50ac91b36a80b2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/moveAction.js\":\"e6bc8474628b9a07\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/moveBlocks.js\":\"ff5688e67ba66dba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/selectionAfterMove.js\":\"ca988a7f5df1de57\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/TutorialBanner.js\":\"af22dcc5e2183f9a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/action.js\":\"a360fe94f58e1e01\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/bannerDismissal.js\":\"38b2a56a4aa416c8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/documents/cheatSheet.js\":\"baa96ecaf29383ee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/index.js\":\"5838da7beca8cfeb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/keys.js\":\"86490f46ea155d2d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/landing.js\":\"16d3e6f93dfa4399\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/outline.js\":\"156e4cba93cbc43c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/seed.js\":\"716fcc572729387f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b599608da97795f0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/analyze.js\":\"7e7faa725a2a7bf0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/diagnosticsSource.js\":\"fd5fa7fcdacb9ee7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/index.js\":\"424297f0bede40c8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/load.js\":\"e81494f077dbf7cd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/monitorRun.js\":\"5895a0cb2e38d937\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/schedule.js\":\"0bbe61cda43a16ab\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/series.js\":\"d93297f71bd3be2d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/store.js\":\"8a0a75f5640127a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/trendAction.js\":\"12eaabed49b50346\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/verdict.js\":\"fcd7216dbccbf438\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/clickToEditAction.js\":\"122351281bf39338\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/index.js\":\"333da38faf54f2b2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/interactions.js\":\"a6d636beedcd83d7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"55fc55a4451f30ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/MigrationGate.js\":\"d6e952e0938ca0fa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/MigrationGateDialog.js\":\"94041107eef4aff8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/action.js\":\"c4387100459391db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/index.js\":\"1f8a29b8426c18de\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/localRunMessage.js\":\"88377ab44270ea3c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/plugin.js\":\"8c8fd3d401fc2774\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/progressReport.js\":\"85416fc7e5f7eb51\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/sweepProgress.js\":\"fb65f5067c4481bb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/FieldRowRenderer.js\":\"1c800b84160108e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/ValueRowRenderer.js\":\"2b74e7cb335608f1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/actions.js\":\"0a24db6e0d433c4f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/autocomplete.js\":\"350c5f8596a6d2b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/fieldRow.js\":\"770fc08ba5c42f82\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/index.js\":\"ba05b7421cfcd341\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/referenceWarning.js\":\"4d97e30a2db4099b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/valueAutocomplete.js\":\"3c40189a7be43cdc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/valueSchema.js\":\"6c83eb421bfd4d08\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/HeaderItem.js\":\"bf572d99af59d687\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/QuickFind.js\":\"af5dbf1678efe936\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/index.js\":\"6676d39af40afb52\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/recents.js\":\"6f9c2f9620a0c1f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/resultItems.js\":\"51827571cbde1e63\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/selection.js\":\"86f07b10eb89d2ae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/toggleStore.js\":\"76bef37edbca58a7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/HeaderItem.js\":\"3dc85f3b2ff72762\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5683a3bfef89f20a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/grouping.js\":\"b23827569c25f4ca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/index.js\":\"d1e228bce29aa031\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/target.js\":\"9b5353c44f738d07\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/codeMirrorExtensions.js\":\"3f474fb166c877d0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/contentPrefill.js\":\"13894a6b0a0bb787\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/dataExtension.js\":\"93d63587992ee3d4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/index.js\":\"1bb507eba654bfb3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e0a5880ab5aaec36\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/invalidation.js\":\"5d44e623934267be\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/localSchema.js\":\"9bed22c3587e2db6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/blockrefs/index.js\":\"388a2632f63134fe\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"32e684e31d3eabdd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/index.js\":\"6c7a3c2d7af2c3b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/referenceNode.js\":\"5bc041df2d08ebcc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/remark-reference-occurrences.js\":\"725c2c73c1f9d7bc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a01f92d7b10b5f84\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/index.js\":\"aa2d857ef12cdee0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"51769a8da66eada5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ee5d0794bda84108\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/mergeRetargetProcessor.js\":\"0a57b47b3ef57a09\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/parseFence.js\":\"afa67eb4eb532dcb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referenceParser.js\":\"4a843a0691bca99b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referenceProjection.js\":\"ddfd194b0b81a6b4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referencesProcessor.js\":\"289e34aec0a91d53\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/renameProcessor.js\":\"22f6330f9a13cb77\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/spanReplacement.js\":\"305f91dfe5b6449c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/htmlToOutline.js\":\"a96678c524a55bab\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/index.js\":\"eb354266eaee78ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6721fe02bd58f791\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/pasteDecision.js\":\"3e952859e58fba63\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/action.js\":\"1258a2fa22445e0b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/blockIds.js\":\"67d9e935855f6372\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/content.js\":\"78a11b6f01890552\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/effect.js\":\"11e7e00020e4c168\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/ids.js\":\"48a390f563a561b8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/import.js\":\"01301b6ac437b3c4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/index.js\":\"1169d6810ff43787\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/plan.js\":\"d4e28256535627a3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/plugin.js\":\"84e16ec62d8045b5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/promotion.js\":\"5157c2d3a2789f84\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/properties.js\":\"bfe9b4c0f7b043d6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/references.js\":\"1206c44eb5a75f2d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/report.js\":\"937592a207c89387\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/roamMemo.js\":\"010222211e985f36\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/runtime.js\":\"7a9b9827acef4642\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/schemaReconciliation.js\":\"3480c2d25461eef0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/srsMarkers.js\":\"b1313b52f5bdeba9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/todo.js\":\"a9a6738431130776\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/typeCandidates.js\":\"632e97d5b5bd4293\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/types.js\":\"01ce926630aa1333\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/search-health/index.js\":\"440ba068308c3f66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/search-health/store.js\":\"b61ab70cd075245e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/HeaderItem.js\":\"d8e1f99abd56f051\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0efa834dcb7cf2c0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/index.js\":\"9c24937773d2d898\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/model.js\":\"2046738198e8ccdb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/toggleStore.js\":\"251fdcb5f612672e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/useKeyInspector.js\":\"7ec62aca29143b2b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4fbd5d530c304a6a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/ShellDecorator.js\":\"5aebaf0571881d74\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/actions.js\":\"a80412dba5740bfa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c50dca24f54e59ef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/index.js\":\"51558869a8d91d44\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/shell.js\":\"cad5fb1caa370739\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/surface.js\":\"cd1c801783d75e50\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/walker.js\":\"d97e3c27d04fac87\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2cf9b5d9016a5695\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/dataExtension.js\":\"536a3e97a509672a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/index.js\":\"0dbdb8ba2354a30a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/indicator.js\":\"7c77bebc24e7e834\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/moveSrsState.js\":\"0008edf7773445ba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bab11cb28195348c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/scheduler.js\":\"3617c64e0d178f64\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/schema.js\":\"81d14113d3e94677\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e35eaf65a14afe2c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/srsClipboard.js\":\"014cb7fbf773dc05\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"525230154d90f64d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/DailyNoteReviewHint.js\":\"580c7e0d474a2fe8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/DeckPicker.js\":\"bbaa4f80fada94fb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewControls.js\":\"9d410897640ae54a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b3ff566dd1080e3b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewSession.js\":\"1843d935870b888a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/actions.js\":\"8b55de3c50fef225\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/archive.js\":\"0d390db5551b17f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/dataExtension.js\":\"9f2e3c17d4624b03\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/deck.js\":\"5d25107e35c86821\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/dueQuery.js\":\"6c6fbc09644ed99e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/gradeDecision.js\":\"145b523cdc1ba7b4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/index.js\":\"923c302e89ffeec0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/keyHints.js\":\"c5f24068cf244fa5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/reviewCardLayout.js\":\"3dd085cc6f5ef448\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/reviewProgress.js\":\"cc2378b70ea00659\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/schema.js\":\"33ec71c70457fca8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/useDueCards.js\":\"9fd9959822d347b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/startup-metrics/index.js\":\"6375f1d27405f71d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/startup-metrics/record.js\":\"0409651b514fc04c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/index.js\":\"78b29780b3787241\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/persistenceStatus.js\":\"3e8e4e6df1e326df\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/requestAction.js\":\"c223e441034167d5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/TypeChipsDecorator.js\":\"0b4526ca3f7dab1f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/codeMirrorExtensions.js\":\"cda6a296818575df\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/index.js\":\"35bbde23d751468b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/typeAutocomplete.js\":\"2f097e0fee70ba88\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0b847da2e90f5a10\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/actions.js\":\"d8c66205f6f43442\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/anchor.js\":\"c2c59eeaf592edcc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/events.js\":\"eb4855b7b8b1ecc3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/gestureActions.js\":\"4cb4307de00e9bda\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/index.js\":\"038b6ffa7b2ca52a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5f538d76f63e9188\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/collect.js\":\"7f2bc2736ec7ad98\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/index.js\":\"491b75e56d03202e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/record.js\":\"a9e93ed14aa9be0c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/RejectionDialog.js\":\"cd4725f2ad81f3f6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b78f162fc3a013d2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/index.js\":\"0603e5ca96a56b3e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/model.js\":\"e8483c6716b54aac\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/queueCounts.js\":\"7dcb0bb55a8debe2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/rejectedHelpers.js\":\"656e1865698c30a8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/rematerializeAction.js\":\"dbd1e05a243f6763\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/useHysteresis.js\":\"197b74dd5c797315\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/effect.js\":\"4206dcf6205b50af\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/index.js\":\"c164ef31a7713d3e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/theme.js\":\"6e9bb2d69b3a5894\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/actions.js\":\"2bffe7accbc5f36d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/dataExtension.js\":\"576f89dd6236229b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/index.js\":\"a7f992dba31e5fe4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/schema.js\":\"09e6ce2eff172441\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3fdd3444f6f657e6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/actions.js\":\"376cbcc171c7bf9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/defaultItems.js\":\"668c5b4f25f54156\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/facet.js\":\"19d2cd3d78f0f6b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/holdRecognizer.js\":\"187186ff975c4d79\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/index.js\":\"28295f8dac020113\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/UpdateIndicator.js\":\"abe5a20a8d305074\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/index.js\":\"a5ebd77b269a6a66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/loadTimes.js\":\"1caf0f1ce73da4ca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoNotesRenderer.js\":\"81dc27e630d26031\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoPlayerRenderer.js\":\"5341975b627179f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoTimeStamp.js\":\"c35e16f2f7e5784a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/actions.js\":\"b6cc63d13f3ecf26\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/index.js\":\"a3df3b5d067400ee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/markdown.js\":\"203c06200669096e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/notes.js\":\"f0c3329422b65871\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/registry.js\":\"549ef5c6798dd01a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/remark-timestamps.js\":\"4931c5194614f206\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/view.js\":\"86e67a93b7a4f5bc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/LinkHints.js\":\"8e981a9b186b765d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/index.js\":\"22465275e558fd9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/model.js\":\"55f42dede535a640\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/settings.js\":\"b913a1bfbeaff1ee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/actions.js\":\"aedfe48e4be894d4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/index.js\":\"089149844263909d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/interactions.js\":\"3038f4ecd550d6d5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/workspace-header/index.js\":\"c28b90187f1da668\",\"/knowledge-medium/pr-preview/pr-1791/src/registerServiceWorker.js\":\"f5a653d172ea812e\",\"/knowledge-medium/pr-preview/pr-1791/src/requestPersistentStorage.js\":\"d951d221cf2df3ba\",\"/knowledge-medium/pr-preview/pr-1791/src/services/authRequestDeadline.js\":\"7a15883b20a1447e\",\"/knowledge-medium/pr-preview/pr-1791/src/services/authStorage.js\":\"ac10e89b7232dd5e\",\"/knowledge-medium/pr-preview/pr-1791/src/services/powersync.js\":\"1eb6681344954e45\",\"/knowledge-medium/pr-preview/pr-1791/src/services/supabase.js\":\"b18dcbef0a79097c\",\"/knowledge-medium/pr-preview/pr-1791/src/services/uploadErrorClassifier.js\":\"7d1fff10aba83468\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/ActiveContexts.js\":\"6fc3a68a3f07d665\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/HotkeyReconciler.js\":\"b995f712f5428669\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/WipeLocalDataDialog.js\":\"fe34c37941b9593b\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/actionDispatch.js\":\"53d64329fc73afb7\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/actionRefItems.js\":\"9fa0eb6d86551725\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/applyKeybindingOverrides.js\":\"1c73ea465da7b43b\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/blockActions.js\":\"25228dbea4d23391\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/canonicalizeChord.js\":\"0f157f0bdb6c928d\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/defaultContexts.js\":\"10ee76c72ee7d8a4\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/defaultShortcuts.js\":\"559a65bf30869701\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/effectiveActions.js\":\"aeef074ae9aca583\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/gestureAction.js\":\"61d684a99672ccd4\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/gestureBinding.js\":\"b9b0f53097ab444e\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/holdRegistry.js\":\"93b09936e4a94029\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/keybindingConflicts.js\":\"b263fbb111e17829\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/keybindingOverrides.js\":\"31da424318f68374\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/pointerAction.js\":\"dc6430f84a40f0c9\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/resolve.js\":\"c56656b10173772e\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/runAction.js\":\"956c5d636f831b43\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/sequenceMatcher.js\":\"3b2c03a13e01e958\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/types.js\":\"7d28977aee9f72ea\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/useActionContext.js\":\"0723d1df3b212c37\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/useActionDiscovery.js\":\"77ff360100cb870a\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/utils.js\":\"0ab04f598f800c64\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/bootStore.js\":\"e86bfede3428ea86\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/previewDatabases.js\":\"0d98ff9a3bb3fac0\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/byteTransform.js\":\"429e358564772a33\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/attachmentCleaner.js\":\"2c1aa66228348b7a\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/attachmentParts.js\":\"071246e061592309\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/bundleParts.js\":\"1a45f08eafc3a5fe\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/bundleRecord.js\":\"e89be5d32ddb5274\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/manifest.js\":\"cb600f054311710a\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/takeBundle.js\":\"8d9745e021e8f22f\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/verifyBundle.js\":\"5b6dbf79d0fdeb08\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/cleaningStage.js\":\"0ded60ff62e1c37d\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionKey.js\":\"2e6e5d1d93c714b4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionServer.js\":\"a543111c0363fffc\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/flip.js\":\"917a211848ff62e8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/flipAttempts.js\":\"a59ff64bf609e3c4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/pages.js\":\"8473beebce8903a1\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/preflight.js\":\"db2365a6648317d4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/reseal.js\":\"b73da00d56cd91df\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/runConversion.js\":\"a9bee8b6c035e4f9\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/runLock.js\":\"c8e3a8ad5c056771\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/sealing.js\":\"6c857b3e111fccc4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/sealingStage.js\":\"e13a48962b491302\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/stage.js\":\"de522bdb6fc3e9c2\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/verifyReseal.js\":\"e682bcfa786147f2\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/aad.js\":\"a482add8d8828d0c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/aead.js\":\"1d5a37ac168a25c8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/base32.js\":\"f281954b8e476fd2\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/base64url.js\":\"14fb4896fbc16530\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/binaryEnvelope.js\":\"c14616da7f92ae89\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/byteAead.js\":\"a233f9d28734b030\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/canary.js\":\"14001f926ca31be8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/contentHash.js\":\"9214302a4f72e90c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/contentKey.js\":\"27182f0818fde073\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/derivedIdNamespace.js\":\"a1eb2c1bdcfd78b0\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/envelope.js\":\"e494fcd0e1f789b8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/hex.js\":\"011a24845e0ef5c7\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/sha256Hex.js\":\"cc502653a3bc6b0d\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/workspaceKey.js\":\"c0d76a036b17fb3d\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/conversionState.js\":\"c1cf085fbf0587e9\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dfa6cd39eb4963d1\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/pastedKey.js\":\"6c312e902a88b9b8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b4cfc1b84e4caabb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9b4f456ada4e6957\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/keyStore.js\":\"63d3e7392cac521c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/mintWorkspaceKey.js\":\"831b6f7e1d291a2c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/modePin.js\":\"100736e96cd6707a\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/openWorkspaceKeys.js\":\"61da773aa6532995\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/resolveWorkspaceEntry.js\":\"d63c3d893be930c0\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/resolver.js\":\"5edcaf37c4e24691\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/workspaceAccess.js\":\"64b9236d17d8644a\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/transform.js\":\"15f31f3bc60c5c5c\",\"/knowledge-medium/pr-preview/pr-1791/src/themeBootDefaults.js\":\"28744e61d8c663c2\",\"/knowledge-medium/pr-preview/pr-1791/src/types.js\":\"cb92ee35e3ddeb56\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/ClientLocalSettings.js\":\"ef082d82941edff2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/abortableSleep.js\":\"372ed1d7e256ef14\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/array.js\":\"c3c15ca6fae46705\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/backlinkAutocomplete.js\":\"b021d4606b1758ea\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/blockCrumbs.js\":\"df9819edb83a7101\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/blockrefAutocomplete.js\":\"1090a050ef5789df\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/cadencedIdleJob.js\":\"432bbe0d286c9fa6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/callbackSet.js\":\"331c1fb598824a80\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/clientId.js\":\"c9ac123f5e54de01\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/codemirror.js\":\"1f4e79b2857a7459\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/codemirrorCompletion.js\":\"8991f7791e830087\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/copy.js\":\"9b727b2573391403\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dailyPage.js\":\"736819a3f76e79e3\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dbForensics.js\":\"ac462d138c9e3629\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dbForensicsHooks.js\":\"0b3b52f0e0083743\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/deleteBlockThroughUi.js\":\"733ca97c677d0a67\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dialogs.js\":\"79b82f06a59ff978\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dom.js\":\"cdb45608f550104c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/downloadBlob.js\":\"8327c12ec54a5bfd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/exportSqliteDb.js\":\"50116fbd96f15323\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fileSystemAccess.js\":\"d8888546f2ec0ada\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/flipSlide.js\":\"e77d8e94c7de45f4\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fnv1a.js\":\"e69caaf24836e38a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/formatBytes.js\":\"97b99af49ffa0ea7\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fuzzyRank.js\":\"9a4ae77c71c57a37\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/idbKeyedStore.js\":\"47f85398a0d52be6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/idleCallbackPolyfill.js\":\"1f88763b6b7ed67f\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/keyboardAwareScroll.js\":\"f99445437b0494fb\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/keyboardViewport.js\":\"2bfc9c4f04618cbf\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/lastWorkspace.js\":\"240f90b069916fc0\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutColumns.js\":\"1084cdadebe0758c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutSessionDom.js\":\"8a0b71fb7911d14c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutSessionId.js\":\"89d35bf23456b0ad\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/linkClickGestures.js\":\"2d8e05b58df1f79e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/linkTargetAutocomplete.js\":\"66ce9358aae50b2c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/localDbCorruption.js\":\"543475b4a23501a9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/localDbRecovery.js\":\"0d74d4ddbec72b4e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/markdownParser.js\":\"5c283dfc9074ca57\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/memoize.js\":\"dcce5276c3d97710\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/nameFieldCommit.js\":\"68fc4e5210ec6c36\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/nameList.js\":\"116ac0d3558d6a82\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/navigation.js\":\"4b90f0b2f8134b3c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/omnilinerNamespace.js\":\"a2a1c2cf713c1bd4\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/opfsPageScan.js\":\"e314bcffcd12e4bb\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelClearance.js\":\"d95d7641a907d85d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelHistory.js\":\"25bcda8e3bc2a84a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelLanes.js\":\"f344f253a72b2823\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelLayoutProjection.js\":\"67192f48d796da2d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelScrollAnchor.js\":\"49bdd4b5dba4467d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelUrlFlags.js\":\"5a3e937c92dec1ab\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/platform.js\":\"a2a5f225d23c1517\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/pluralize.js\":\"85dfa3e5cdf96ab1\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyCreation.js\":\"20907e178ffd14b9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyNavigation.js\":\"67f82a98f76289e2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyValueContext.js\":\"0254de580cec41dd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/react.js\":\"64bd98fdaecbe426\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/relativeDate.js\":\"b47dba9dda659dd3\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/relativeTime.js\":\"bba743a116c728ea\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/renderScope.js\":\"84ae961009e0c9b8\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/resolvedThenable.js\":\"bcaed7d93d886c7e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/routing.js\":\"1d71cf8a8204a7f9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/safeMode.js\":\"d012b3ff36e59e30\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/scheduleIdle.js\":\"1d0c664cf764cc49\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/screenWakeLock.js\":\"536ae4d57072ec4d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/selection.js\":\"18b9312ff0ed3c01\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/softKeyboardGrab.js\":\"4581e0db3edab8f3\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/startupTimeline.js\":\"07b56581db4836c9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/state.js\":\"d47ca0901e77a69e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/string.js\":\"64698a142b7653b7\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/surfaceZoom.js\":\"1d5d9863c4662486\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/time.js\":\"ed1630ffc6496918\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/toast.js\":\"d5a022664efb3af7\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/toggleStore.js\":\"713678c2f927f0d5\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/untilStopped.js\":\"1b8b8c1cfcfee17c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/userActivity.js\":\"748f303ec6d1c34e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/viewTransition.js\":\"338c0452fda074f2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/viewport.js\":\"73d89d16812505c0\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/webLock.js\":\"604ea053c6087858\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/workspaceRecovery.js\":\"8ea1a8ad7a79114a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/workspaceSnapshotStore.js\":\"9b0741f69605c2a4\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-compiler-runtime.js\":\"3ab7054cf1236344\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-client.js\":\"14ab059af192e76c\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-server-edge.js\":\"d533288241271570\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-server.js\":\"417b5f2d44005f90\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-static-edge.js\":\"804524efcd9ee52b\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-static.js\":\"7ea87412a6cec5ae\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-test-utils.js\":\"dd7bf0e87ae46134\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom.js\":\"407a9e56096afd75\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-jsx-runtime.js\":\"afd6ae856283b90b\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react.js\":\"f307f40c0a2c2aae\",\"/knowledge-medium/pr-preview/pr-1791/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1791/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1791/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
