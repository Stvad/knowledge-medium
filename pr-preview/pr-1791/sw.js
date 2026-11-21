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
		buildId: "db44f393626a-504650b3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/\":\"70aebafa07a93ef5\",\"/knowledge-medium/pr-preview/pr-1791/index.html\":\"70aebafa07a93ef5\",\"/knowledge-medium/pr-preview/pr-1791/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1791/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1791/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1791/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1791/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1791/assets/FacadeVFS-Bo-euXIe.js\":\"447f2a539c77b827\",\"/knowledge-medium/pr-preview/pr-1791/assets/OPFSCoopSyncVFS-_CtkZMqz.js\":\"339816031faeeb9f\",\"/knowledge-medium/pr-preview/pr-1791/assets/OPFSWriteAheadVFS-DDAD00cL.js\":\"c777f8b88f1bb2c3\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-Vk65PKQH.js\":\"f40953ca5d496b3e\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1791/assets/wa-sqlite-async-IkXiaC_e.js\":\"f4b7af9b2684e5b0\",\"/knowledge-medium/pr-preview/pr-1791/assets/worker-Bo02BjS5.js\":\"8f5292316ac0f48b\",\"/knowledge-medium/pr-preview/pr-1791/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1791/chunks/app-tF7kmgr9.js\":\"ba9848e122234567\",\"/knowledge-medium/pr-preview/pr-1791/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1791/index.js\":\"03a64a4bcd78109a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1791/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1791/assets/AccessHandlePoolVFS-CUkXUyxN.js\":\"0f1277895214827e\",\"/knowledge-medium/pr-preview/pr-1791/assets/IDBBatchAtomicVFS-B-lG_HH7.js\":\"8e4b4dca750bfe3d\",\"/knowledge-medium/pr-preview/pr-1791/assets/MemoryVFS-DAVi_7XE.js\":\"57820040a430d6e4\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-Comk6hg5.js\":\"af71661f34c49124\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-async-BuvQWzQC.js\":\"8219fad0d844f455\",\"/knowledge-medium/pr-preview/pr-1791/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1791/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1791/chunks/AccessHandlePoolVFS-gJHWJUwK.js\":\"2a522ed2bfc6505e\",\"/knowledge-medium/pr-preview/pr-1791/chunks/FacadeVFS-n9165MfM.js\":\"95ae2319f0a67803\",\"/knowledge-medium/pr-preview/pr-1791/chunks/IDBBatchAtomicVFS-BIWVci6b.js\":\"be97ac0d8b955721\",\"/knowledge-medium/pr-preview/pr-1791/chunks/MemoryVFS-e6n1a2Zx.js\":\"67679e27db34ca04\",\"/knowledge-medium/pr-preview/pr-1791/chunks/OPFSCoopSyncVFS-gSP_1HeB.js\":\"b5cc09e107bccc23\",\"/knowledge-medium/pr-preview/pr-1791/chunks/OPFSWriteAheadVFS-BLMzR2D7.js\":\"82942db17af51bc7\",\"/knowledge-medium/pr-preview/pr-1791/chunks/Preview-C-LDVISR.js\":\"b47820540540cf69\",\"/knowledge-medium/pr-preview/pr-1791/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1791/chunks/card-BvtiNBNF.js\":\"e9cf9179294463f1\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-Bu1J5nss.js\":\"1273b558e2bff423\",\"/knowledge-medium/pr-preview/pr-1791/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1791/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1791/chunks/mc-wa-sqlite-async-BtcMySa_.js\":\"c3ae73a8ae3bcf37\",\"/knowledge-medium/pr-preview/pr-1791/chunks/mc-wa-sqlite-krCileQt.js\":\"0a32185cfab892cf\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-BNwO-z3R.js\":\"37a9fecaeb574ce3\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-BW88NfuN.js\":\"2e95b5b7e85e16fd\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-BcVESAe9.js\":\"f4244e25e7a71a7c\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-BvT_mtZY.js\":\"08036471bd9558e1\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-CSYJM6GX.js\":\"28d3930c88cddb41\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-Ce9pFRI0.js\":\"bfb6e23fc3d1d4d6\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-DjRPhsaO.js\":\"c306d628465b3da8\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-TXeyp0p3.js\":\"b5f8acd376d7b624\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server-legacy.browser.production-QV_-JgeA.js\":\"2658f9fcc8eaecb5\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server.browser.production-BynxOp-2.js\":\"b51c7d31ceaef6c6\",\"/knowledge-medium/pr-preview/pr-1791/chunks/react-dom-server.edge.production-DvUxfTeY.js\":\"f4a0b6a8ca3c3ff0\",\"/knowledge-medium/pr-preview/pr-1791/chunks/server.browser-bQAaFOEu.js\":\"80249a4cba52e548\",\"/knowledge-medium/pr-preview/pr-1791/chunks/textarea-B2ySdr5H.js\":\"7bdd979e36ecdd4a\",\"/knowledge-medium/pr-preview/pr-1791/chunks/ui-COBazPXX.js\":\"2980a9c5d6624f57\",\"/knowledge-medium/pr-preview/pr-1791/chunks/wa-sqlite-CSC44jom.js\":\"7d115e3e8799dc13\",\"/knowledge-medium/pr-preview/pr-1791/chunks/wa-sqlite-async-gHwyNybN.js\":\"a294d03e6f241a44\",\"/knowledge-medium/pr-preview/pr-1791/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1791/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1791/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1791/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1791/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1791/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1791/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1791/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1791/src/App.js\":\"be5bbcb8b6a9136e\",\"/knowledge-medium/pr-preview/pr-1791/src/appUpdate.js\":\"2ff5ae54e24f55f7\",\"/knowledge-medium/pr-preview/pr-1791/src/appVersion.js\":\"62f33d3eee866e5d\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/initialLayout.js\":\"1d1afa0aeb77809b\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/openWorkspaceData.js\":\"ac358ad006bf2dae\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/resolveWorkspace.js\":\"aec57f0a485a083b\",\"/knowledge-medium/pr-preview/pr-1791/src/bootstrap/workspaceBootstrap.js\":\"5011cdecf1188ac2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockComponent.js\":\"9944716ef2153bae\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockCrumbs.js\":\"6bacc75b8ef9b52f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockEditor.js\":\"2f0f8c4dc44dec01\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockLoadingPlaceholder.js\":\"f309972781db7a1f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockProperties.js\":\"8bd7e56a24de9d0d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/BlockSearchPicker.js\":\"c4197bd5849ad94d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ConfirmBulkDeleteDialog.js\":\"2aa48f5b954cc129\",\"/knowledge-medium/pr-preview/pr-1791/src/components/DividerHandle.js\":\"daade899c8622a4b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/DraftEditor.js\":\"c8888c53efcf28fe\",\"/knowledge-medium/pr-preview/pr-1791/src/components/GutterPill.js\":\"97ffab3cc921df2c\",\"/knowledge-medium/pr-preview/pr-1791/src/components/Header.js\":\"9814a016735d36a6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/LazyBlockComponent.js\":\"6a590fb7496e0905\",\"/knowledge-medium/pr-preview/pr-1791/src/components/Login.js\":\"53546b1088d2a3ea\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ZoomableSurface.js\":\"74a8dc817afece6c\",\"/knowledge-medium/pr-preview/pr-1791/src/components/editModeKeepalive.js\":\"fb2a93a7fd56214c\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ff644dcd27ccea87\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"906e7bd233aaa27a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/RefPropertyEditor.js\":\"528b1eb565c0be64\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/RefTargetTypePicker.js\":\"d9438c273618bf20\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/SelectPropertyEditor.js\":\"5567138aea14d09a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/TypesPropertyEditor.js\":\"bbd817b86c1b84bb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/defaults.js\":\"fee22172de4e06da\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/kernelValuePresets.js\":\"1d1a008b9f05d466\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/selectablePresets.js\":\"90a0a01980f3763c\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyEditors/typesPropertyUi.js\":\"efc8cae2c667a596\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/AddPropertyForm.js\":\"b81bb00ffd4dd48a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/PropertyPicker.js\":\"610c7c8a8de76f01\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/PropertyRow.js\":\"19f36ef2c864199d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/Rows.js\":\"2df79a8e885f9b6f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/actions.js\":\"e30295d456b82db2\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/declarationOnly.js\":\"aa39c4214c1e0840\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/layout.js\":\"72bf6eaeb4983fae\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/model.js\":\"789ce33aa41337fd\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/shapeUi.js\":\"fd22f4f28eb9749b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/shapes.js\":\"9ffadd89ba606d77\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d0422d1f625e1894\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanel/visibility.js\":\"48f4121d64b5e5d7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/propertyPanelSections.js\":\"3e0e120482faabde\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockEmbed.js\":\"802b244b90d7c0d6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockLink.js\":\"ee117ed230ce2f33\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/BlockRef.js\":\"385d578a8bf8baeb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/ReferenceLink.js\":\"a7fd432c3a7ae508\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/cycleGuard.js\":\"f1ed3c96b9247db4\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/cycleGuardContext.js\":\"eee71fcc922f560e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/linkInteraction.js\":\"94949e6d24c0183b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/referenceLayout.js\":\"3610bb95695dad49\",\"/knowledge-medium/pr-preview/pr-1791/src/components/references/useBlockRefAncestors.js\":\"1bf0ca5885330b49\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockGutter.js\":\"c338b0e9da945f01\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockInfoDialog.js\":\"715d2ce7e1a85c46\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BlockTypeBlockRenderer.js\":\"5f5e200b6b8bf389\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/BulletHoverCard.js\":\"26a1618f5d66a0f5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/CodeMirrorContentRenderer.js\":\"afc55a23c0c3355e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0a27a47d79c16e43\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/ColumnResizeHandles.js\":\"71d1ae8641a3d5dc\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"19d1b68ffc8c76d0\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/DefaultBlockRenderer.js\":\"a2bee148d1d974bb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/LayoutRenderer.js\":\"d91c42f54ce7ee4f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/MarkdownContentRenderer.js\":\"8f8a438bd23ff0e4\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/MissingDataRenderer.js\":\"8ba7272e016faefb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/PanelRenderer.js\":\"f6465494f23bf2e7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ea704862b739ab84\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/TopLevelRenderer.js\":\"825319990ab24169\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/blockGutterMode.js\":\"a3c554614dea92f6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/blockTitleText.js\":\"246b1e6e90acce14\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/fieldCreationKeydown.js\":\"1f72164c71326934\",\"/knowledge-medium/pr-preview/pr-1791/src/components/renderer/layoutRootContext.js\":\"b610ddeb82b2afbb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/typeChip/TypeChip.js\":\"04abf87b0db6c4f6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/typeChip/chipStyle.js\":\"d748942630ee6291\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/anchored-floating.js\":\"649b0f84d80c5fc5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/button.js\":\"5074aa80a818687b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/card.js\":\"4b6413039953e32a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/checkbox.js\":\"c831254eb9d4d9f6\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/collapsible.js\":\"993522dff3bd9588\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/command.js\":\"fa4e9c670f6af05e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/context-menu.js\":\"ef7cfb66c8867212\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/dialog.js\":\"3083c135c79e57cb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/dropdown-menu.js\":\"0e9535ef8b1d8dc4\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/floating-listbox.js\":\"5991449144e2ad9b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/index.js\":\"0829756d04107684\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/input.js\":\"45c826f6bf82f638\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/kbd.js\":\"100953d09f4b5cfe\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/label.js\":\"62736f25ad3d1030\",\"/knowledge-medium/pr-preview/pr-1791/src/components/ui/textarea.js\":\"11d8dde3793e2813\",\"/knowledge-medium/pr-preview/pr-1791/src/components/useEditModeYieldKeepalive.js\":\"cc983628932d554a\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/BootFallback.js\":\"23f84cdefd858776\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/FocusedRowLazyMount.js\":\"85ed579d1d2d7859\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/LazyViewportMount.js\":\"ccd736a8e20a56d5\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/LocalDbCorruptionFallback.js\":\"3ba35365de0db713\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/error.js\":\"bed208b8d534eee7\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/lazyMountRegistry.js\":\"601c7228b4c7d5ce\",\"/knowledge-medium/pr-preview/pr-1791/src/components/util/suspense.js\":\"75e205153c23ffb9\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/CreateWorkspaceDialog.js\":\"e8620acde9949b03\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/PendingInvitations.js\":\"d990abad8eea018e\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/SyncProgress.js\":\"ead1fbbd68098b76\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/UnlockProgress.js\":\"ce2c8709764f7c41\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceKeyGate.js\":\"40cfc08c4e09bb01\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSettingsDialog.js\":\"9ece9eec24b5e0ad\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSwitcher.js\":\"0d02b08aadd9bb15\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/WorkspaceSyncGate.js\":\"ae58849ea9e7a1fb\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/ConversionFlow.js\":\"20a79f1321469e1d\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/ConversionFlowHost.js\":\"6b9a6a0db0cca812\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/EncryptionSection.js\":\"e83326812d081b41\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/attachmentPrompts.js\":\"f2d9c2e44171bdbd\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7218dd17ab75c860\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/conversionFlowDeps.js\":\"4c07835e4b2db6ac\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/conversionFlowStore.js\":\"887fc86dd906c84b\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/flowUi.js\":\"fce960a5342b6e21\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/conversion/useConversionRun.js\":\"f021e84e4f798e3f\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/keyUi.js\":\"396c38f1af154580\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/useCloseOnKeyLoss.js\":\"db19de09f5e20696\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/useCloseOnServerE2ee.js\":\"9d6afc316dc78777\",\"/knowledge-medium/pr-preview/pr-1791/src/components/workspace/workspaceUnlocked.js\":\"af5905964893526a\",\"/knowledge-medium/pr-preview/pr-1791/src/context/backgroundSubtree.js\":\"b641b2ad6d065d45\",\"/knowledge-medium/pr-preview/pr-1791/src/context/block.js\":\"18c4139507431d68\",\"/knowledge-medium/pr-preview/pr-1791/src/context/layoutWsContext.js\":\"fa7c8c8b46d70d16\",\"/knowledge-medium/pr-preview/pr-1791/src/context/propertyDisplay.js\":\"373faef4309169c0\",\"/knowledge-medium/pr-preview/pr-1791/src/context/repo.js\":\"7e46ce2f5f01095e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/aliasClaim.js\":\"542fd4d50921d8cc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/aliasSeatNamespace.js\":\"d9efb89f9423aae7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/blockData.js\":\"d2348fe0c58457a5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/blockType.js\":\"1e932d1d49d9750a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/changeScope.js\":\"46c1c496704c8fa9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/codecs.js\":\"c222f1ea9a529295\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/derivedData.js\":\"91c187cd5c3e613d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/errors.js\":\"36b17d6221bf8292\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/events.js\":\"22b86476aab01c61\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/handle.js\":\"f1e140da77dfb572\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/index.js\":\"cd5764e906bf6c03\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/mutator.js\":\"04685e9436932291\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/processor.js\":\"af5d8ff8d8af4bfe\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/propertySchema.js\":\"ea7e2c60dbdcadbc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/query.js\":\"7b9f2511e9625c47\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/sameTxProcessor.js\":\"6d9b50d858711e14\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/schema.js\":\"f1e140da77dfb572\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/tx.js\":\"f1e140da77dfb572\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/typedBlockQuery.js\":\"72f09eb8f5a3fd50\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/user.js\":\"1f98f26b80dabd5b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/valuePresetCore.js\":\"0c3780e77b55c027\",\"/knowledge-medium/pr-preview/pr-1791/src/data/api/valuePresets.js\":\"59e6d4dc77516132\",\"/knowledge-medium/pr-preview/pr-1791/src/data/attachmentCleanerIOVerb.js\":\"9ed6626cf9d5406d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/block.js\":\"b312783335db1e9d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockCache.js\":\"8fcfeaec8d246326\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockId.js\":\"7ec9f9a476d290ca\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockLiveness.js\":\"5ecb9b2b944050c2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockMerge.js\":\"c30028dc8053af35\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockSchema.js\":\"5aec0865cab55109\",\"/knowledge-medium/pr-preview/pr-1791/src/data/blockTypes.js\":\"cd4ba5074efdcc81\",\"/knowledge-medium/pr-preview/pr-1791/src/data/clientContext.js\":\"25b2388e09cedfc6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/dbFileSiblings.js\":\"9b3957396468bdb6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/definitionSeeds.js\":\"e79a2dfda96cfd40\",\"/knowledge-medium/pr-preview/pr-1791/src/data/derivedIds.js\":\"9c2ca383cdf99520\",\"/knowledge-medium/pr-preview/pr-1791/src/data/drawnSubtree.js\":\"ad1fc8c8e2862842\",\"/knowledge-medium/pr-preview/pr-1791/src/data/facetBridge.js\":\"3ffc40908f21893a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/facets.js\":\"0ad44f4774fde969\",\"/knowledge-medium/pr-preview/pr-1791/src/data/globalState.js\":\"53fcc4cde4b59d50\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/aliasClaimRederiveProcessor.js\":\"abfccb0a7371796a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/ancestorBatch.js\":\"4c327a959414c052\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/blockTypeTypeifyProcessor.js\":\"d2ff8f495490d7f1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/clientSchema.js\":\"504fd19ee395e3bf\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/commitPipeline.js\":\"5170559bf6ddd8f5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/devAssertions.js\":\"2b70123f85581d4e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/firstSync.js\":\"634354e9a2c330d9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/freshInitialLoad.js\":\"b8b29e9c5256099a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/graphBackfillClaim.js\":\"a9da26a85357f2ef\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/handleStore.js\":\"ba7a9b87f623f353\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/idleMarkerJobs.js\":\"4583201f3a381424\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/initialDownload.js\":\"dca28e96122f4a2d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/initializeClientDatabase.js\":\"e49e869e1fb0ed06\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/jsonCanonical.js\":\"43a6eb5f22e08245\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelInvalidation.js\":\"6ed292ce4e9afb09\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelProcessors.js\":\"892d79d13b36a6d4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/kernelQueries.js\":\"cc2bb3f6553d25a5\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/mergeTypeMembershipProcessor.js\":\"bc1db5e197e35c37\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/normalizeReferencesProcessor.js\":\"7255519d672bc8b9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/poolInstrumentation.js\":\"0002a4a4b5978202\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/processorRunner.js\":\"28c0e7a34435c4ee\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyCellBackfill.js\":\"1d58b71526aff8ee\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyChildMint.js\":\"b78f207a4a262d45\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyChildrenProcessor.js\":\"5265e58fdaf8a608\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6a7a82d1d87db47c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyDefinitionSynthesis.js\":\"e75fd924ac1e4324\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertyKeyScan.js\":\"bf554e79bafbd258\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/propertySchemaResolution.js\":\"c6d3937db4bc3c18\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/raiseProtocol.js\":\"6ff7a511949a2e15\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/readBatch.js\":\"919ab2fdd8ede5e9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/refProjection.js\":\"01f69283d77c8dce\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/referenceTargetLookups.js\":\"27889f4f4f83a4c7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/referenceTargetProcessor.js\":\"3575f6200a068eb2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/replayMerge.js\":\"2994dbeb2da58264\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/sqlBinds.js\":\"64e26b8454fc8881\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cb540d7aaed0d066\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/arrivalProcessors.js\":\"8f0873e8ff5536d7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/invalidate.js\":\"855e8a443e03002f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/materialize.js\":\"586b7af1958e5468\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/observer.js\":\"8406676b98f18a10\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/syncObserver/reconcile.js\":\"51f80d674a79ac62\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/timingMetrics.js\":\"9712a7e05aac02d3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/treeQueries.js\":\"ac9bb8494ceff926\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/txEngine.js\":\"2dccc916842cd960\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/txSnapshots.js\":\"be5a91baad3c7975\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/typedBlockQuery.js\":\"b7e6dd3585f5bf49\",\"/knowledge-medium/pr-preview/pr-1791/src/data/internals/undoManager.js\":\"bdf8afe131988064\",\"/knowledge-medium/pr-preview/pr-1791/src/data/invalidation.js\":\"151bb77788ce2ffc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelDataExtension.js\":\"965dda4035a95a48\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelPage.js\":\"9b2465e6f74db934\",\"/knowledge-medium/pr-preview/pr-1791/src/data/kernelValuePresetCores.js\":\"afa3fd57dd30f253\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbCorruptionSignal.js\":\"ac1dca387e3fa44d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbStorage.js\":\"15c17822471fad7e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localDbVfs.js\":\"26b18e7b2390fbbd\",\"/knowledge-medium/pr-preview/pr-1791/src/data/localSchema.js\":\"518e2cc1ffc2e6c4\",\"/knowledge-medium/pr-preview/pr-1791/src/data/maintenance.js\":\"c1aa30fa94250ac8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/mergeProperties.js\":\"1cd8d6ced8b080ed\",\"/knowledge-medium/pr-preview/pr-1791/src/data/metricsConsoleHook.js\":\"7978868dd8541c07\",\"/knowledge-medium/pr-preview/pr-1791/src/data/migrationsPage.js\":\"fe533d9313d25e75\",\"/knowledge-medium/pr-preview/pr-1791/src/data/mutators.js\":\"3ecd630ef7e2789f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/orderKey.js\":\"4d5901fca0df0591\",\"/knowledge-medium/pr-preview/pr-1791/src/data/orderKeyPlacement.js\":\"169445387fc30015\",\"/knowledge-medium/pr-preview/pr-1791/src/data/outlineSurface.js\":\"d53e99f3e2268184\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pendingEditorContent.js\":\"c717efcf1d5247c9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pendingUploadsSql.js\":\"0cd48eca3c9ae9f8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/pluginStateExtensions.js\":\"5b8b891ff7bdb420\",\"/knowledge-medium/pr-preview/pr-1791/src/data/powerSyncLogger.js\":\"b807a78e79fd03e6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/projectorRuntime.js\":\"8c20e3ae5859c401\",\"/knowledge-medium/pr-preview/pr-1791/src/data/properties.js\":\"fed4e20dab7bd456\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertiesPage.js\":\"1c15c68a13f527b0\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyChildren.js\":\"4e2d762eddd2ac33\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionFanout.js\":\"2edb543ebbd52cd2\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionMetadata.js\":\"79d2148eaba25567\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDefinitionRegistry.js\":\"b398e9149a533831\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyDisplayMode.js\":\"8d04d69ec696799f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertyRowCreation.js\":\"0177082c042b2e92\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertySchemaCreation.js\":\"68abdcab037de4ba\",\"/knowledge-medium/pr-preview/pr-1791/src/data/propertySeeds.js\":\"68fd0aa7991cb83e\",\"/knowledge-medium/pr-preview/pr-1791/src/data/recentsPage.js\":\"b0bfe67ccff46168\",\"/knowledge-medium/pr-preview/pr-1791/src/data/referenceBlock.js\":\"fe902b064211713d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/releasePowerSyncConnection.js\":\"7ff1fc4b067eed5a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/repo.js\":\"e4b60b749ece9d65\",\"/knowledge-medium/pr-preview/pr-1791/src/data/repoProvider.js\":\"daa14c79c61af0ca\",\"/knowledge-medium/pr-preview/pr-1791/src/data/rowProperty.js\":\"e16634c850756fa3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/searchFilter.js\":\"ccf2607da299e8c9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/seedIdentityLedger.js\":\"f99b9ccc64d19f6f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/stateBlocks.js\":\"a28496638219f344\",\"/knowledge-medium/pr-preview/pr-1791/src/data/structuralEditPolicy.js\":\"14d19bc97f7f947d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/subtreeDelete.js\":\"357b3734db5a917d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncStreamLock.js\":\"e58034d8d6b4bff6\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncedTableSqlRecognizer.js\":\"135cd49eba0d8e3b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/syncedTableWriteGuard.js\":\"a62d65f2b01b247c\",\"/knowledge-medium/pr-preview/pr-1791/src/data/targets.js\":\"1a0055014feb870f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeColors.js\":\"e4a6992eb0a39500\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeDefinitionMetadata.js\":\"0e40b9a01b423b8d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeDefinitionRegistry.js\":\"675d5d270121e844\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeExtraction.js\":\"0b780a5a9e623bfc\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeInitialValues.js\":\"354bac61bc7f96ab\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typePropertyGroups.js\":\"c14e087ee54f4c41\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeSeeds.js\":\"47eae9b982a51a70\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typeTagger.js\":\"3988c41cd08a1106\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typedRecords.js\":\"b808d2133752bdc9\",\"/knowledge-medium/pr-preview/pr-1791/src/data/typesPage.js\":\"8cc0acd90867330b\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userPrefs.js\":\"706e380609720cea\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userSchemasService.js\":\"ed0cde147c90cec3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/userTypesService.js\":\"cfc31a51789d33c3\",\"/knowledge-medium/pr-preview/pr-1791/src/data/valuePresetRegistry.js\":\"33dabcf84307ddd8\",\"/knowledge-medium/pr-preview/pr-1791/src/data/visibleChildren.js\":\"5bbc516625e368d7\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceConversion.js\":\"eecf018ecac45b0a\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceFirstSync.js\":\"1d80c63fbc175f0f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceIdNamespace.js\":\"eb9efb2ed5839d2d\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaceSchema.js\":\"e15c30e4d2b4e56f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/workspaces.js\":\"692999e8f9125eb1\",\"/knowledge-medium/pr-preview/pr-1791/src/data/writeAheadLog.js\":\"c146735d85d08a2f\",\"/knowledge-medium/pr-preview/pr-1791/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/BlockPasteShellDecorator.js\":\"331e8272537e5083\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/atTrigger.js\":\"9c269af8744d521c\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/autocomplete.js\":\"63e74220c6ea4c80\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/codeMirrorExtensions.js\":\"97e370bb42b1dd97\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/contentFlush.js\":\"7b9246cfa546fd98\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/defaultInteractions.js\":\"20ef0713ec6e818d\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/editSettleSignal.js\":\"0de2522ffe9bd45e\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/insertImage.js\":\"7fb021e7cee90cd8\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/referenceCompletionRange.js\":\"636f0143ba66e080\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/referenceTargetTypes.js\":\"416033d789652601\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/syntaxContext.js\":\"832f68016065424c\",\"/knowledge-medium/pr-preview/pr-1791/src/editor/triggerMatch.js\":\"1c6e0e5e6fdbf843\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/AppRuntimeProvider.js\":\"c70ca40e6dbd326a\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/BlockFocusShellDecorator.js\":\"ddafc2e356913ab0\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/ExtensionRenderBoundary.js\":\"bae66879c5b479a3\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/PanelContentRecovery.js\":\"e4668749b6cb03d7\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/apiCatalog.js\":\"8a6db4a87951332e\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/approveExtensionHere.js\":\"6ada1c365fdb640d\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/armedCutAppMount.js\":\"f9a76e0d8cf275d5\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/batchableKeyedStore.js\":\"e5061d63f55caded\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/blockInteraction.js\":\"31c46eecd9ebc13c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/blockSelectionAction.js\":\"0862321bf811396c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/compileExtensionModule.js\":\"8fa5408cf135f461\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/compiledModuleCache.js\":\"fc08841c05fecaa9\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/continuousGestures.js\":\"8f00102177562d6d\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/core.js\":\"1513890baf0a9127\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/defaultRenderers.js\":\"fd5a6dc4baadf05d\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/definitionFanoutAppMount.js\":\"ad28bcc55f409689\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dialogAppMount.js\":\"60fcff28085a3bb2\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dynamicExtensionSeeds.js\":\"00acc6160a251274\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/dynamicExtensions.js\":\"c1b03c0113a48fab\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/exampleExtensions.js\":\"6a031871def8cdc6\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionApprovalStatus.js\":\"077c652a47047f93\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLoadErrorToast.js\":\"ee3e9bf4b29a31a1\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLoadErrors.js\":\"c8282bb04e34704c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionLookup.js\":\"728de8c5a3ee10a4\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionToggles.js\":\"d216ea38c8a1b88f\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/extensionUtilitiesCss.js\":\"484a35070d074d6e\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/kernelPageDeletionGuard.js\":\"c41eca5faaf6c830\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/liveRuntime.js\":\"db1472756797d141\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/openExtensionsSettings.js\":\"1609259ae48951b9\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/overridesCache.js\":\"d83e23802f8bdbc4\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/pluginIds.js\":\"a45614b04b8d1c08\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/processorRejectionToast.js\":\"438efd73c3aa4fb2\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/runtimeActions.js\":\"68fd4ffb62ee91f7\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/runtimeContext.js\":\"b2bc60478848f83c\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/staticAppExtensions.js\":\"0563eefa96daa2b5\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/staticDataExtensions.js\":\"789d7a5ee9ef57d4\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/toastAppMount.js\":\"0761f0c4cd37d64a\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/useOverrides.js\":\"30130e699783d957\",\"/knowledge-medium/pr-preview/pr-1791/src/extensions/useShortcutSurfaceActivations.js\":\"412ecf1888379813\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/discoverToggleTree.js\":\"2e02bff0df4055a3\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/facet.js\":\"44125bc2916d50c6\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/resolveAppRuntime.js\":\"1f012855ed18552d\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/runtimeEvents.js\":\"7585532cb154dbef\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/togglable.js\":\"4242404ceed3d119\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/variantFacet.js\":\"322e70c38baf290d\",\"/knowledge-medium/pr-preview/pr-1791/src/facets/verbFacet.js\":\"c4526887e488e5c9\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/block.js\":\"1ee1348bd7928719\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/focusedChild.js\":\"0aaa7f1fa081b757\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/propertySchemas.js\":\"6cb8551e67defa76\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/typeRegistry.js\":\"ead80d7eb68c58c2\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useAncestorCrumbs.js\":\"93d1f6073754d7ef\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useAutocompleteListbox.js\":\"ed2b135d32f298eb\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useDebouncedSearch.js\":\"769cae8613d12ba6\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useDebouncedValue.js\":\"b2109334345d6f1d\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useIsFocalRender.js\":\"099ce4d68d1d5f70\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useIsReadOnly.js\":\"bf5d00ed45b0ce98\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useMaterializeBacklog.js\":\"3e206e5e5ba2a637\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useMinuteClock.js\":\"c5829a35000a34dc\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/usePanelLayoutProjection.js\":\"0513a463d0671348\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/usePendingInvitations.js\":\"4a35c0c8606528d2\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useRendererRegistry.js\":\"c410f80beba23307\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useRetainedFieldRows.js\":\"a17efcb0ee5ef092\",\"/knowledge-medium/pr-preview/pr-1791/src/hooks/useWorkspaces.js\":\"c43403b2bb380e58\",\"/knowledge-medium/pr-preview/pr-1791/src/lib/utils.js\":\"51dacdaf61ff3d83\",\"/knowledge-medium/pr-preview/pr-1791/src/main.js\":\"f2d85e58da14de04\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/MarkdownImage.js\":\"aa1746aa3c9d41f8\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/blockSeparators.js\":\"3f7b6c00d9b30457\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/context.js\":\"2491280f432a47a2\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/defaultMarkdownExtension.js\":\"7efdfa7efca28c82\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/extensions.js\":\"decb3b01e16a5b7f\",\"/knowledge-medium/pr-preview/pr-1791/src/markdown/renderMarkdownHtml.js\":\"5c5f48f732ff8031\",\"/knowledge-medium/pr-preview/pr-1791/src/minimal-editor.js\":\"3e8903a2ba1aee41\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/armedCut.js\":\"c6df6d2f4e35fe48\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/captureMediaVerb.js\":\"14d1be6730f6c44b\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/clipboard.js\":\"4af8700e04b8ac69\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/decision.js\":\"9835750f83672ac4\",\"/knowledge-medium/pr-preview/pr-1791/src/paste/operations.js\":\"d990510497cd23f1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/account-header/AccountHeaderItem.js\":\"c7d58aaad79e3208\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/account-header/index.js\":\"f99260831ab25362\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a0ee965e6a3119b7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/askAgent.js\":\"9074f956680a5b29\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/askedStore.js\":\"ba10421f3a38daef\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"691aa40cce3fa121\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/chipState.js\":\"980b75f2c6846f58\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/dataExtension.js\":\"05e55ae542ea847b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/index.js\":\"c7e5f3b0639b556d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9ced7a9b979779a2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-dispatch-companion/schema.js\":\"e2294ec54d4e2845\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2eaaed4ef18a5588\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a944214d505e0ee5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/addMedia.js\":\"fdf9314b8f7368f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/backlinks.js\":\"32c07851844eb9c5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/block.js\":\"45f631d5ad505aa9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/context.js\":\"58f85fc6178f2a78\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d121a97ebe189aea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/index.js\":\"50680a06a3a0bb25\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/outline.js\":\"15b55e6ae4346e30\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/properties.js\":\"cec1849692feb28b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/refs.js\":\"a6386f02e66e264b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2af0b67772a81492\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/search.js\":\"a552cbccbbf145f8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/shared.js\":\"db199d11d7f4f184\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7d4c0d284506ef37\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentViews/text.js\":\"ad3f5a261b369325\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/agentWrites.js\":\"dcaf01ed715790bb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/authoringCatalog.js\":\"8ed2003a6d048666\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/blockRefTargets.js\":\"e92e44f55542c3c9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/bridge.js\":\"8f83ce9ef6039abe\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/bridgeLoop.js\":\"e6c7961f1a4a14df\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/changeHistory.js\":\"a19134a899ede476\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/commands.js\":\"15b6c7cf64b2ecbd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/commentsCommands.js\":\"90cb674e7b6712bd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/dataExtension.js\":\"1011a6967fc7b45b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/dataModelGuide.js\":\"5c7f3acefb3e767f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/describeRuntime.js\":\"6b6561ff1149dab1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/extensionLint.js\":\"be3fc2fcd5de76f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/grainAudit.js\":\"781bcba4ca1c0872\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/healthCommand.js\":\"687b2e672c52c333\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/index.js\":\"c85fe935a961c44b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/presetIdentity.js\":\"da7c1372ec1084ec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5fa654e47d72df65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/readMedia.js\":\"09831f31d345fdac\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/schema.js\":\"545833328c57be65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/serialization.js\":\"2f17ffff84fe2fab\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/targets.js\":\"da5d177da413b369\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/tokens.js\":\"c8d39c8cb8bca639\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/watchEvents.js\":\"c1049c7d4fb354d3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/workspaceGuard.js\":\"32930dad93bd385d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/agent-runtime/writeCommands.js\":\"83b25b510f736845\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/AliasCollisionToast.js\":\"a0280d2a7ef6ba5a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/DuplicateNameBanner.js\":\"b21568a092559e51\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/collisionMerge.js\":\"abc158920901e62d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/dataExtension.js\":\"8ac663f64d067a2d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/index.js\":\"0dbe0490df01f18f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/mergeCollisionAction.js\":\"5a02edcfa964b5e2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/pageStyling.js\":\"11442a249076fc94\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/rejectionToast.js\":\"22841adc63f22bd3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/alias/syncProcessor.js\":\"9d3b77254f671807\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/actions.js\":\"0eba2f586af98eae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/addComment.js\":\"97f3fa6b83b2c338\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/anchor.js\":\"1c4089e07afbaa8d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/anchorState.js\":\"263c63a777462141\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/commentLinks.js\":\"720e840c74b5937b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/confirmThreadDeletion.js\":\"f7137acba58efe06\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/container.js\":\"79b7e6b0970e8562\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/dataExtension.js\":\"3184749a81cd70aa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/deleteComment.js\":\"655e359d9e8e5527\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/highlights.js\":\"ea65956a62ff7662\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/index.js\":\"33aa09102c095919\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/linkedCommentsPill.js\":\"912c38ba10a58e63\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/margin.js\":\"296b4300a999e061\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/marginSchema.js\":\"dd56aa6f79329613\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/newComment.js\":\"8da2f6e0a0b05c7a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/ownThreadPicker.js\":\"8a572251133c3ca8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/placement.js\":\"44e9fa40c29e8940\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/queries.js\":\"911e0160f703cbae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotePosition.js\":\"32b2de29de1f18d6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotedIn.js\":\"53c79339655dbc2b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/quotedRange.js\":\"6cde4b0687ed2f29\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/rangeRefs.js\":\"e1c81a1d56e8da3a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readHighlights.js\":\"523b30860bc12dec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readSelection.js\":\"12bb983d20f035f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/readSelectionUi.js\":\"d112afadfee5e746\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/reanchor.js\":\"309f53cc36b3d6ae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/schema.js\":\"b54b40f513963cfd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/scope.js\":\"a9205fb59182ade1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/scopeThreads.js\":\"0eef78c01ba9d063\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/splitRetarget.js\":\"8fa91e5fb65aa728\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/suggestionCard.js\":\"b1f1279ce3bdca6c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/suggestions.js\":\"c04d757cb8c84010\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/summaries.js\":\"3aaf3a6df4b1d076\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/summaryBatch.js\":\"fbacb79c7b2becf7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/surface.js\":\"f3a4dd0e259441ee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/threadNavigation.js\":\"70a3dda8a642a0e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/threads.js\":\"243ab023ca78221a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/ui.js\":\"1620b416f51ce848\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/annotations/uiStore.js\":\"28c7b0fc5984c5d8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-intents/appIntents.js\":\"8740f63fc3dbfafd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-intents/index.js\":\"dd39ecf016125cde\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-update-prompt/index.js\":\"1d316556f85425c2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/app-update-prompt/status.js\":\"b690f1ae8dea1790\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3945f4cfe0f7441b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaBlockRenderer.js\":\"5a7e1d70e298d4b3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ee27c852824f3035\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/MediaUploadReconciler.js\":\"1cd64ecfae4797c2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetDownLane.js\":\"676cebf51f60a559\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetResolver.js\":\"d301a49711379ed3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/assetUpload.js\":\"fdf3c47526c4ffa3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/attachmentCleanerIO.js\":\"4c828b7b0953b221\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3f5ff86210582df9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/blobStore.js\":\"be156cc119574838\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/byteStore.js\":\"8ecc13fc5a00efb5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/cleanerIO.js\":\"f9f20c8b7f7e2305\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/cleanupAttachments.js\":\"f050f667e13e54f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/dataExtension.js\":\"242d56a0b0e3f925\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/downLane.js\":\"c70d5d7538879e86\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/index.js\":\"9d5a0d956f235feb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/insertImageContribution.js\":\"3725dbd828f74497\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/laneArming.js\":\"e55525719eda6647\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/laneLock.js\":\"7bda236617a33019\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaBlock.js\":\"0bb1ab9436e71c02\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaCapture.js\":\"dd88a27548341101\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaViewers.js\":\"e255c1af1d665646\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/mediaViewersFacet.js\":\"7e06a4dcb582eade\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/pasteCapture.js\":\"003b257c54f53ec2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/resolver.js\":\"13c0b28dcda0a01e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/retryUploadsAction.js\":\"9e122ab6325b7291\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/storagePaths.js\":\"f67332f0f889e2e9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadDrain.js\":\"30487c36af82e096\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadLaneStatus.js\":\"735f11362a16977d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadReconcile.js\":\"acebff619d9811de\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadRecovery.js\":\"2e33d58e795b9596\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/uploadStore.js\":\"75848682c44e81d0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/attachments/useAssetObjectUrl.js\":\"e8bed34ddf137de3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5bc7ff74ac77724a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5bb2f35df8c160b1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/facet.js\":\"5e1ca5de03ec23e0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/index.js\":\"fdd4609dd2b3012b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks-view/prop.js\":\"01829d65cdcb8369\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BacklinkFilters.js\":\"a99c63955ba95282\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b8488e0dcaa64a00\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/BlockEntry.js\":\"63091588ea02f70a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/LinkedReferences.js\":\"bdda568faf4d1c51\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6a7ce1512609dbbe\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/dailyNoteDefaults.js\":\"40feafc934695142\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/dataExtension.js\":\"191b5484cf3283f1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/edgeExclusions.js\":\"4631c4072316be12\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/filterProperty.js\":\"8c322af01ef9179a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/index.js\":\"5d937925d3d22c4a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"eaeed7998affaa1e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/applies.js\":\"c0726f7b0a542c34\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/countQuery.js\":\"b0a23130a84dde5d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/expansionStore.js\":\"178ce1401086f53c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/index.js\":\"a9d6555aec20463c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"455db5e8fb98be3f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/presentationInvalidation.js\":\"7715f74937bc6414\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/propertyEditorOverride.js\":\"1a1b9889dca5c518\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/propertyFilter.js\":\"2c1d2758a8e119a6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/query.js\":\"7d6908acf11f43da\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/resolveFilter.js\":\"f3ec4f4cf9ce5f01\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/sourceBatch.js\":\"248c8070230067fc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/sources.js\":\"8a3c17de1f0de74a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/useBacklinks.js\":\"69ffa8b19482b827\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e9b97fb5f4df8835\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/BirthdayCelebration.js\":\"822dd3a38f5c9024\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/BirthdayOverlay.js\":\"e057b00fe0d44de2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/gate.js\":\"b2682356f5bd28eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/index.js\":\"2097e47db27d821a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/birthday/wolfTheme.js\":\"9a24603befc7e80a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/BlockDragLayer.js\":\"709b8611c2a45ceb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/dragController.js\":\"f42a0a50b7a2b1d7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/dropTarget.js\":\"b1cf7aa1420eb7eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/index.js\":\"18040d52e7b29182\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-drag/projection.js\":\"a9cb7c17273490c0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-info/BlockMetaCard.js\":\"b7bc45f22ce340bd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-info/index.js\":\"1df272f0736c01a3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/AddTagDialog.js\":\"c32b19a52faab6d7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"57e8c58fdaee8b2a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/TagNameIssueHint.js\":\"8a4ffd141ff25d81\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/addTagAction.js\":\"0bfda90bbdf3019a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/appendTag.js\":\"329189bae31216f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/config.js\":\"b0946ca1ae21ca12\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/dataExtension.js\":\"60aed898f68a80bd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/index.js\":\"a71235d5c3ac69f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/block-tagging/propertyEditorOverride.js\":\"af553fdc2ce29856\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a453fc823dfee4aa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6fc8605d42fd89a8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/Breadcrumbs.js\":\"add93e945b048c9a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1f9dce563bf4d5cf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a25f54429c862ba2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/index.js\":\"cb15dbcb7e0a3c99\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dd9d16865b6b94a6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/CharacterCountItem.js\":\"46411b7a524c60db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8584e1ece2aa96b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/actions.js\":\"915d53b68397b630\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/blockType.js\":\"b75876f43580a2b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/charCount.js\":\"a07f936b687809e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/dataExtension.js\":\"f17dcf3d7f85eb24\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/index.js\":\"94857ca522111a1f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/profiles.js\":\"447f4d02336491cf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/properties.js\":\"840df8bcf9c6c5a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/character-counter/textCounts.js\":\"30e94d498816d8c2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/colemak-keybindings/index.js\":\"0ca3cf458db941fb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/CommandPalette.js\":\"77adf229e596ebe4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/HeaderItem.js\":\"6b9db3c87fd2eb0f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/context.js\":\"aca3c0aefed62f44\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/index.js\":\"a8ff254891b606f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/selection.js\":\"c86e95096b8c8a00\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/toggleStore.js\":\"7ac0dd9288062e63\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/command-palette/useCommandPaletteActions.js\":\"36d64f6f16e4caa8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/ContributorBadges.js\":\"abaac23d11214a11\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/author.js\":\"d6103c4096b129df\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/codeMirrorExtensions.js\":\"e127907ea953703c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/dataExtension.js\":\"c2b52edbc82b3181\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/index.js\":\"c7d399daa2194fae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/mentionAutocomplete.js\":\"ac5b9ab0a164b6e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/processor.js\":\"5905e2dfd908ff82\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/profiles.js\":\"9926e3457b111a07\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/queries.js\":\"525f289a965a6d1d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/contributors/schema.js\":\"95c537871b9e32e7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9255b8471e17ec8f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/followOrigin.js\":\"09bc2e6c57dd059f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/index.js\":\"ef5784263b53f60e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2afaf560af388aaf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"92807cb50725d365\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/CalendarGrid.js\":\"452892e31be82c6e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DailyNotePicker.js\":\"ffc474c5fcbb5f98\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"68c975adcef8ffb8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateNavDecorator.js\":\"592085d093d65f1e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/DateScrubOverlay.js\":\"29625efc507c4f35\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/HeaderItem.js\":\"06bbb5b1e2376ba8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/ReschedulePicker.js\":\"0796df14e61cfc7a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/SpreadDatesDialog.js\":\"27ce56534c2133a7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/actions.js\":\"abf24d62f7d8f7c8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/blockDateAdapter.js\":\"3992f56e27a743c8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/calendar.js\":\"51c9250664c2164b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dailyNotes.js\":\"ea1635a8e25d9606\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dataExtension.js\":\"0e6d5f717b4e4abd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubActions.js\":\"71fa466510cbfd68\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubGesture.js\":\"e9f9cf4e14fd8127\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b713d8c1562197c6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3451eb136fec6108\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/deletionGuard.js\":\"b84b0b524a928359\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/dueQuery.js\":\"e4dc6f81ff904bbc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/index.js\":\"b394697adc675bba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/landing.js\":\"cd366fe53b26d4e2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/localSchema.js\":\"23ccd7953e16b1f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/referenceDateAdapter.js\":\"1c7a53cb894389a1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/rescheduleAction.js\":\"096bddd8b58c2298\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/schema.js\":\"db0e5ab19b7c9679\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/spreadBlockDates.js\":\"0c510ef7bb7e332b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/spreadDatesAction.js\":\"bc75948ae0feff95\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/today.js\":\"431b673229c383cf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"14667184bed160f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"db5b1de6ac7bc9be\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/audit.js\":\"ef6dd81757a3c029\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/auditAction.js\":\"50b0170db64e12f9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/auditRanges.js\":\"ca0199853adb319d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/diagnosticsSource.js\":\"2aca4e1ca664fbf6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/divergenceScan.js\":\"e5e5839459b381fc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/index.js\":\"0e9c2847e8cf94ea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a3e7d0a3bbefb115\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/referencesMirror.js\":\"699943f023f5d465\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/rowJson.js\":\"d347442b243dba27\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/schedule.js\":\"16e9e7e85201fd7b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/data-integrity/store.js\":\"ba98f74a413da7fc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/action.js\":\"b3e30006a15e050d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/index.js\":\"d216f89cf9f7d62d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-maintenance/plugin.js\":\"535188fb998c2886\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"97085e9e777d21d4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/actions.js\":\"4409d748752ec93c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/changeMarker.js\":\"8e23e1b7b9297831\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/diagnostics.js\":\"07c7e8c4cf20f30b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/fileSystemAccess.js\":\"7576cbe544481220\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/filenames.js\":\"d4e3c59d0c79976c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/index.js\":\"cad8f74738013242\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/mirror.js\":\"d270ab9d41daf9f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/runLock.js\":\"2eb6981e9e74b273\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/runtimeHealth.js\":\"e7c8d7e5b1f0a0f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/schedule.js\":\"61cf63ffdd233f85\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/db-mirror/store.js\":\"d913331a6cf181cf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/default-themes/index.js\":\"9dcd5e9636beae48\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/default-themes/themes.js\":\"d723b241dc668d29\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/diagnostics/facet.js\":\"3a2e2d8bd160eaf7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/diagnostics/useDiagnostics.js\":\"1319594ca78a25eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/dismissals.js\":\"3f11cdc5c95bd10e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/index.js\":\"34bccc50713aeff4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/status.js\":\"07057f65095a44e4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extension-prompts/store.js\":\"26be5fba3bfd64cb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"42a232f41d3c39ad\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/ExtensionsSettings.js\":\"98d6962f7627dc04\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/actions.js\":\"18f7db498c97a50b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/config.js\":\"f9f9271dd9e5c5f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/dataExtension.js\":\"5acabe7abae1e0ee\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/effect.js\":\"7faa5b479fef5d2b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/index.js\":\"b887eff1a1944738\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/propertyEditorOverride.js\":\"67655ec24817cd6f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extensions-settings/useToggleTree.js\":\"cc1be8b49ea7e119\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/ExtractTypeDialog.js\":\"faa2617c83f54fbb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"8c2e3c63a4b4b202\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/PropertyShapePicker.js\":\"24058aa8e96e6855\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/action.js\":\"326ded110fbb62eb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/extract-type/index.js\":\"56fe8504b2e9010d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/FindReplaceDialog.js\":\"45974cbfa472e57f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/HeaderItem.js\":\"5227e5903cc46412\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/dataExtension.js\":\"15e59c3ffbd67745\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/index.js\":\"b56e0fca8efbf54c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/search.js\":\"443eaf0bf30d60fb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/toggleStore.js\":\"138762c624decca3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/LocationPropertyEditor.js\":\"27d274635c72d4e8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/MapView.js\":\"e3b452b5e4b64316\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/blockTypes.js\":\"9efc6c32b5c28806\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/codeMirrorExtensions.js\":\"d43b5662d3fc0460\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/createOrFindPlace.js\":\"7f9818bc743c2770\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/currentLocation.js\":\"79939c5202a368bf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/dataExtension.js\":\"9ed8b753ba2ea04a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/geoContentDecorator.js\":\"64fb53e7c10d15fa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/googlePlacesClient.js\":\"692e09458c757189\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/index.js\":\"050bffb46c14598b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/locationsPage.js\":\"9daefc713f225e9f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/mapViewport.js\":\"9d5eebd8a8edb5af\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/pickCurrentLocation.js\":\"f3f15142e65573a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/placeAutocomplete.js\":\"8a0f8dd4653fca95\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/placeNameCollision.js\":\"64f639184d3a2ef0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/properties.js\":\"b9a9e1afcad0e3fc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/propertyEditorOverrides.js\":\"a77900ef86e1f35e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/query.js\":\"860bd2364a3c55ea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/geo/usePlaceSearch.js\":\"1200a49e846338d7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7cb1aba2a0f62f54\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d0ebd725c86b9597\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"fc71db5a3aca3506\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/config.js\":\"bad98d1110d4a0a5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/dataExtension.js\":\"5aa2607bd493cfb7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/facet.js\":\"4a06526fbd748045\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/grouping.js\":\"fb777af9ff97a8b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/index.js\":\"199cea6c28d16964\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f32406f9d3f75717\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/query.js\":\"b314ce26a62171d9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/resolveConfig.js\":\"f595119d495600e2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4af95c775fbb4226\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"876d84f512fa44f7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/HtmlDocumentContent.js\":\"50b27d3561e9b241\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/HtmlFrame.js\":\"7165a37959d87bcd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/actions.js\":\"7f9c43c11f5531a3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/blockType.js\":\"076adfafb8a9fc91\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/confirmRunScripts.js\":\"e8c36c792013d0fa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/dataExtension.js\":\"ba48367d756eb965\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameAnnotations.js\":\"4caf3ae6163d719b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameDocument.js\":\"8e47451d13b7c2a2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/frameTheme.js\":\"9b69368d34c81aa0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/index.js\":\"bf45cc4d9c55d371\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/scriptConsent.js\":\"fa20c169de5de018\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/sourceMap.js\":\"df46d552798b9a9d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/html-document/useDocumentScripts.js\":\"759f745679ab6dec\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/index.js\":\"9fca34c77b5db07c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/record.js\":\"fe3e2ad9193efd36\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/recordStore.js\":\"b17ffc22525159b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/responsiveness.js\":\"79900dbae191fb89\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/schedule.js\":\"16fb68f868a0e3d1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/interaction-metrics/sessionContext.js\":\"ad7ca38957612d01\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2f4d8fbf5484ab4e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"97309b9fad0c0799\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/actions.js\":\"673e2696817bd9a1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/config.js\":\"c4e1651f74060ce3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/dataExtension.js\":\"59e971f6e11786a8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/effect.js\":\"6de62d934b6d3e26\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/index.js\":\"19e61ac2a6f2b456\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/keyCapture.js\":\"e1bb5c5cd5ea6902\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/overrideStore.js\":\"3d2c44978d98aafd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"92dda8da1cbf2daf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/HeaderItem.js\":\"f55dd5a01e582578\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/LeftSidebar.js\":\"0c247ae22de18019\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/actions.js\":\"9e356a5332955936\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/facet.js\":\"e5a683fef707a5b6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/index.js\":\"bf8f0ba4db4978c6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/shortcuts.js\":\"87fd97fceba7dd0d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/left-sidebar/toggleStore.js\":\"49d58e611c40a984\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/MergePicker.js\":\"c48f7d27c5186628\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/index.js\":\"e54ec73b88790d24\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/mergeAction.js\":\"2f202f63484b4c7e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/merge-blocks/strategy.js\":\"8b38724281f89113\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/Button.js\":\"ae24b8b9469ec084\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d4f5b33e52420166\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/defaultItems.js\":\"619a770eb38abfc4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/facet.js\":\"8098ec9569a97fe8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-bottom-nav/index.js\":\"896eb0e9519abff3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"19ad1f9bd87b14d2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/actions.js\":\"09594483d23a781d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"03141095708d7cf6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b1bae722ec4ec647\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/mobile-keyboard-toolbar/index.js\":\"6cf52a2334b313ba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/MoveDestinationPicker.js\":\"11b33eac91794f6c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e196a7aa01c942b7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/contextMenuItem.js\":\"20be82a460d117fe\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/index.js\":\"71538a45b6ddd5db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/moveAction.js\":\"f4e5e770bc4d785d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/moveBlocks.js\":\"670b9dd3dd2961a8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/move-blocks/selectionAfterMove.js\":\"d24979c5ffeb51e5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/TutorialBanner.js\":\"cf6bad60980d0d54\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/action.js\":\"c87aeb9ffaed9ff8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/bannerDismissal.js\":\"fb2fe821c878b35d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/documents/cheatSheet.js\":\"dfc309306e958122\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/index.js\":\"6f7ff397c97d0b66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/keys.js\":\"b70baed6ab0ab828\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/landing.js\":\"7490f7f3fdae3cc6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/outline.js\":\"2083ae7fa2684090\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/onboarding/seed.js\":\"7af2d2c745627161\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/PerfTrendDialog.js\":\"aeb09b02a1c019da\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/analyze.js\":\"4d505c4adeefb51e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/diagnosticsSource.js\":\"c39ab1b2f634edfb\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/index.js\":\"7839bd90ddf5ee2c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/load.js\":\"690c6ae166b42201\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/monitorRun.js\":\"f505b7dc78e8bf89\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/schedule.js\":\"9849406a6641a494\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/series.js\":\"8b1d47a77ad6e929\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/store.js\":\"d3c743514d588a5a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/trendAction.js\":\"c4834d08089c9fc8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/perf-monitor/verdict.js\":\"40b293d50bc3e02b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/clickToEditAction.js\":\"bf79812f8dfe34ea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/index.js\":\"8db3868d430b83a9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/plain-outliner/interactions.js\":\"54ea29ca62d91df7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ff84502cc677aeaf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/MigrationGate.js\":\"506020ac05999fa2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/MigrationGateDialog.js\":\"a78913486e8f5bc2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/action.js\":\"a449df9336dcef7e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/index.js\":\"64df094d0c420040\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/localRunMessage.js\":\"1d98e3895cf266e6\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/plugin.js\":\"2a7f090e148fb499\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/progressReport.js\":\"3de3079e7c1f4847\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/properties-migration/sweepProgress.js\":\"c4463994c4318e76\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/FieldRowRenderer.js\":\"8604b15fe4df7020\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/ValueRowRenderer.js\":\"99f66a7eb17eb2e5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/actions.js\":\"8cf400b9452b4240\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/autocomplete.js\":\"2efcfca9c47fa491\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/fieldRow.js\":\"56484eef1d4e64d1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/index.js\":\"320f9713fad23601\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/referenceWarning.js\":\"4be971f04f86dfc1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/valueAutocomplete.js\":\"e903a9c82971064b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/property-rows/valueSchema.js\":\"f2a4bda1a8cc6007\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/HeaderItem.js\":\"8050f6dc6cda1aba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/QuickFind.js\":\"e8b4db29e2289686\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/index.js\":\"fd18dd7923289b81\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/recents.js\":\"8ac13c86cd757c1a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/resultItems.js\":\"945ca7e4cca42e7a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/selection.js\":\"272b4953524965f5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/quick-find/toggleStore.js\":\"dd342c9fd1e48179\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/HeaderItem.js\":\"dae2d909408d92a7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dfa5cdd6ae37eff0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/grouping.js\":\"9dc512488603b5cc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/index.js\":\"16f2383249857382\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/recents/target.js\":\"a399850de84de188\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/codeMirrorExtensions.js\":\"2d0d9597ac51ee86\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/contentPrefill.js\":\"adb8e7cb34ac5228\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/dataExtension.js\":\"b4933ea72505e799\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/index.js\":\"cf3fbe2d8d073566\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4072583ef741c5df\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/invalidation.js\":\"eb6bcf17132fb2b2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/localSchema.js\":\"2d717f5e9ef43bba\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/blockrefs/index.js\":\"892fd5c76040e649\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0a17a4d6a7dde699\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/index.js\":\"473b93aede986ef8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/referenceNode.js\":\"1c47e57f63f0bf8d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/remark-reference-occurrences.js\":\"94eac44589613df8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"23dc8c8fc6b8d4c3\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/index.js\":\"0c7398c639a8dbbd\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e6d910b5f3613c66\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a335223d7ca0d461\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/mergeRetargetProcessor.js\":\"bc87ef054db25432\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/parseFence.js\":\"ca54c8586d6cc76b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referenceParser.js\":\"e28ca1c446e4cb09\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referenceProjection.js\":\"ff2f4f16d95a431d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/referencesProcessor.js\":\"4bebc7a95ac96c6f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/renameProcessor.js\":\"08ed01bf7eeb88cc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/references/spanReplacement.js\":\"23fdbd4d602a6404\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/htmlToOutline.js\":\"ca8704620a5f50f0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/index.js\":\"51d1df27d947c0e7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/normalizeClipboardDom.js\":\"036fe73c16084cd7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/rich-paste/pasteDecision.js\":\"2e24e1af467fe023\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/action.js\":\"dbe4097448775e6a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/blockIds.js\":\"dbae850cf09df21b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/content.js\":\"9eec914eaa54ad8e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/effect.js\":\"84f3f7cd540e4893\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/ids.js\":\"6b4c6d0193b96191\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/import.js\":\"cec955be805a7df4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/index.js\":\"c5dd2b7576b07c45\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/plan.js\":\"a66db81870925211\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/plugin.js\":\"748b43e1a5d183f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/promotion.js\":\"d38ac41bb2fa497a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/properties.js\":\"2d77d7a790882df8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/references.js\":\"513bff889ecda722\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/report.js\":\"5ec81617a44e5a90\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/roamMemo.js\":\"ce01fbaac4f5a34b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/runtime.js\":\"1575082705b94077\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/schemaReconciliation.js\":\"a633abeefb855d8a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/srsMarkers.js\":\"ade33fd67e7d4563\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/todo.js\":\"add9c4ccc18cc758\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/typeCandidates.js\":\"3e7452cc94017ee7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/roam-import/types.js\":\"fcd460f0419287e7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/search-health/index.js\":\"0de6497f8db3d4c9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/search-health/store.js\":\"19cb332d78d91b4d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/HeaderItem.js\":\"17d25be4b4bf50e1\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ef7bab090ff44521\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/index.js\":\"a1aed35cda0a4b75\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/model.js\":\"9c23670d6c05e98c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/toggleStore.js\":\"12fa44f2231b01a0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/shortcut-help/useKeyInspector.js\":\"74c06c35c304b3c2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d3e783b0a78d03f8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/ShellDecorator.js\":\"db89d7fa1dd1a9f2\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/actions.js\":\"401021ce4ac06eea\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e664a482b2170db8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/index.js\":\"15849f1302220338\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/shell.js\":\"2504062d55684087\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/surface.js\":\"a2b3da02bfc6d44b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/spatial-navigation/walker.js\":\"b8ca6b3ee2b19498\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/RescheduleToast.js\":\"726d240fe0ef0680\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/dataExtension.js\":\"b8abae2556bd1b7c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/index.js\":\"480796d3a330cb34\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/indicator.js\":\"bacdfc217a56114f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/moveSrsState.js\":\"dd23c186e4aadf81\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"313afbce01cfac37\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/scheduler.js\":\"ba2fdd7a91a84156\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/schema.js\":\"1a049ad9b321084d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"89c63ba5b350b06d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/srsClipboard.js\":\"c1b9776a64f2b19c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7e382c0ba589f602\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/DailyNoteReviewHint.js\":\"90b7a3ba8a4d8efa\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/DeckPicker.js\":\"b5ae88284557e738\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewControls.js\":\"73b4c9636b63739d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewDeckRenderer.js\":\"90620c45e178e74c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/ReviewSession.js\":\"5e6757c17bdb34ed\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/actions.js\":\"1b034911eeed072e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/archive.js\":\"5b3535d53f46b0ed\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/dataExtension.js\":\"8626bd39ac1f4bb4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/deck.js\":\"a338ecd5a678e35b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/dueQuery.js\":\"4704538a7eadbb05\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/gradeDecision.js\":\"9643b57d9c60f0ae\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/index.js\":\"c6fdacc2a0d329b0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/keyHints.js\":\"fd04c9afdb304512\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/reviewCardLayout.js\":\"bfae00df5e28741c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/reviewProgress.js\":\"f8abf94ff7f2182c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/schema.js\":\"3ba79d63d9ca59db\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/srs-review/useDueCards.js\":\"4aea72f1abec403b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/startup-metrics/index.js\":\"78df4813e429d84b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/startup-metrics/record.js\":\"f1bd3526d11a12bc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/index.js\":\"7dfffc41312a6253\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/persistenceStatus.js\":\"2e5f7f7d59845262\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/storage-persistence/requestAction.js\":\"6fafe0992cc5a4d5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/TypeChipsDecorator.js\":\"495d0ba6308fde26\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/codeMirrorExtensions.js\":\"e8c2e4abc86a2373\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/index.js\":\"febd76528e03577b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/supertags/typeAutocomplete.js\":\"0e28a86bdf79ab03\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b938fb1a34a3be42\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/actions.js\":\"ff47e68248608bbf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/anchor.js\":\"48bbf9db3d1d503e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/events.js\":\"3bbc03f651741fca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/gestureActions.js\":\"c7f84d9fa5e907b0\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/index.js\":\"36a9d22952755a46\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f2ee925f6b811592\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/collect.js\":\"70c3bb7f2ff54204\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/index.js\":\"946f78f37855d94c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/sync-metrics/record.js\":\"46202133c2f73dac\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/RejectionDialog.js\":\"821468b1c21ffb77\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5ba8d77bb4f35221\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/index.js\":\"b6eb197503a95c65\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/model.js\":\"b61dcd7193df637e\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/queueCounts.js\":\"d3efb25416ecb49d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/rejectedHelpers.js\":\"783098503be6cbe5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/rematerializeAction.js\":\"be707e031fac877b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/system-status/useHysteresis.js\":\"43871ff139eb9486\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/effect.js\":\"d17adc85a6ffb4af\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/index.js\":\"427332fb1e7a3c9b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/theme-toggle/theme.js\":\"0180e24e9cbd7549\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/actions.js\":\"51e584ca90b7daac\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/dataExtension.js\":\"88626dc09137fcc4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/index.js\":\"60f2acbf99beea0a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/todo/schema.js\":\"7970280b2d7dd42a\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bdea44b71bf61088\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/actions.js\":\"3dd4ca9c52a1568d\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/defaultItems.js\":\"825dc280825afd6f\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/facet.js\":\"9aadd81567ab2a18\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/holdRecognizer.js\":\"96741e70edebf33c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/touch-selection/index.js\":\"f81635cbcc59f931\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/UpdateIndicator.js\":\"2213ffc7680f776c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/index.js\":\"0a279b191f392be8\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/update-indicator/loadTimes.js\":\"5d6e5ed2f25f8d72\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoNotesRenderer.js\":\"c2a9284a3359677c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoPlayerRenderer.js\":\"f5d810864848889b\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/VideoTimeStamp.js\":\"bb46a0db6e3a65c4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/actions.js\":\"7d31240de094e81c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/index.js\":\"4b0b3e7c89dfebe7\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/markdown.js\":\"cfaaf4a7b5f0b6cf\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/notes.js\":\"fb9456db76dfcdd9\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/registry.js\":\"7e894032cb807575\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/remark-timestamps.js\":\"53ccb7082f4bc809\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/video-player/view.js\":\"647e3fb9a5295bc5\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/LinkHints.js\":\"d15aff421ba2d3bc\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/index.js\":\"ce01417a065d6c02\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/model.js\":\"a976f65343020e0c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-link-hints/settings.js\":\"1a2d74c75f064041\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/actions.js\":\"3ef04986447baf6c\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/index.js\":\"6b091c4c3e8888f4\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/vim-normal-mode/interactions.js\":\"7c9d8a2d30dfb8ca\",\"/knowledge-medium/pr-preview/pr-1791/src/plugins/workspace-header/index.js\":\"b03ddac7d4ba4eaf\",\"/knowledge-medium/pr-preview/pr-1791/src/registerServiceWorker.js\":\"c5318d094ae90ebe\",\"/knowledge-medium/pr-preview/pr-1791/src/requestPersistentStorage.js\":\"32eafe01c8d595a8\",\"/knowledge-medium/pr-preview/pr-1791/src/services/authRequestDeadline.js\":\"4e040fd8ffbfb60d\",\"/knowledge-medium/pr-preview/pr-1791/src/services/authStorage.js\":\"5b8132651242e618\",\"/knowledge-medium/pr-preview/pr-1791/src/services/powersync.js\":\"501a92628fb43c49\",\"/knowledge-medium/pr-preview/pr-1791/src/services/supabase.js\":\"e695086342eca9c4\",\"/knowledge-medium/pr-preview/pr-1791/src/services/uploadErrorClassifier.js\":\"8a7a651d96383a86\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/ActiveContexts.js\":\"3a9c3279da13865d\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/HotkeyReconciler.js\":\"c9c136c950e1d72a\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/WipeLocalDataDialog.js\":\"ce254b0e7123d370\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/actionDispatch.js\":\"bbab520507f3690b\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/actionRefItems.js\":\"f177d99d6c4dbd02\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/applyKeybindingOverrides.js\":\"4e4ba236266d743c\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/blockActions.js\":\"741c87d2c235a396\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/canonicalizeChord.js\":\"3e49fb95d413c7ac\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/defaultContexts.js\":\"9ab6f09f2311740a\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/defaultShortcuts.js\":\"f06bbf93070f93b2\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/effectiveActions.js\":\"b507b9fb91cdfecb\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/gestureAction.js\":\"3888c097cb599423\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/gestureBinding.js\":\"a0913a136898e754\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/holdRegistry.js\":\"3c869924af4c7aa5\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/keybindingConflicts.js\":\"496e0016b33fb62e\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/keybindingOverrides.js\":\"96e85d4b2b9cb5c9\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/pointerAction.js\":\"2f5eab64177acee9\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/resolve.js\":\"2fede3d7e39cca6a\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/runAction.js\":\"bf45c9bd482913a3\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/sequenceMatcher.js\":\"d243cf78c85529b8\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/types.js\":\"79b0737a2521e266\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/useActionContext.js\":\"49b46045a031aad8\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/useActionDiscovery.js\":\"3932418103c79ebe\",\"/knowledge-medium/pr-preview/pr-1791/src/shortcuts/utils.js\":\"087f0de156cd092f\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/bootStore.js\":\"89ba74cf8f988059\",\"/knowledge-medium/pr-preview/pr-1791/src/sw/previewDatabases.js\":\"074d6b63b4201743\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/byteTransform.js\":\"c9af80d5d3a9c762\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/attachmentCleaner.js\":\"df20d5c52b0213c9\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/attachmentParts.js\":\"1b287bc08138cdae\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/bundleParts.js\":\"ff39d0288c5a097d\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/bundleRecord.js\":\"8856a9e2cf8ac0dd\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/manifest.js\":\"2ee03bb77b5753ea\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/takeBundle.js\":\"4b5aa2df8572eae3\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/bundle/verifyBundle.js\":\"671dcf5ed23fcdfb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/cleaningStage.js\":\"06503907db72b3eb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionKey.js\":\"efbe6290dc1b094a\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/conversionServer.js\":\"063ca7a2630654a9\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/flip.js\":\"96bad85d103f77eb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/flipAttempts.js\":\"bac587a51959782e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/pages.js\":\"a57e2cbeaf863f67\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/preflight.js\":\"c0ff510f7673ba5d\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/reseal.js\":\"b1d658092fa63bb4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/runConversion.js\":\"f1081252a040d6c2\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/runLock.js\":\"1ce76d19a46985d1\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/sealing.js\":\"f72cbebbe9b0532c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/sealingStage.js\":\"a9110fbfc2211d12\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/stage.js\":\"e369957bc533d23c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/conversion/verifyReseal.js\":\"481f7d9edb6e5dd6\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/aad.js\":\"f35d91eaa47d32b4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/aead.js\":\"cfc352769dedfe5e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/base32.js\":\"27d41a5fcb6e368e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/base64url.js\":\"f86f0667a5488466\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/binaryEnvelope.js\":\"a2cce364b3ef7cd5\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/byteAead.js\":\"091c0e16957d7b70\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/canary.js\":\"5b920f10dfe7b4cb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/contentHash.js\":\"d7ff2172b4e7530b\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/contentKey.js\":\"78e79ba111dbb7b8\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/derivedIdNamespace.js\":\"5a62cc7f4a912f63\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/envelope.js\":\"4cb3ccee5305296c\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/hex.js\":\"cc1827a01dfbcf69\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/sha256Hex.js\":\"479f5631f175c675\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/crypto/workspaceKey.js\":\"cbcbeb62aa6cf25e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/conversionState.js\":\"5f0f82afded727a6\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/createEncryptedWorkspace.js\":\"30ff433d778a2a5f\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/pastedKey.js\":\"e7e422224f2f5d80\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7688f8d67515bf70\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1e678ca3306fd767\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/keyStore.js\":\"ded1adeab3b9b6c2\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/mintWorkspaceKey.js\":\"4c9cfbecd6d2cf9e\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/modePin.js\":\"041c827a68fac277\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/openWorkspaceKeys.js\":\"9717c01e67d855cb\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/resolveWorkspaceEntry.js\":\"4d844fb358c21c19\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/resolver.js\":\"7b29cd394bc18ad4\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/keys/workspaceAccess.js\":\"2ae18ee818916793\",\"/knowledge-medium/pr-preview/pr-1791/src/sync/transform.js\":\"214701032efb35d8\",\"/knowledge-medium/pr-preview/pr-1791/src/themeBootDefaults.js\":\"77d695894fa45cd1\",\"/knowledge-medium/pr-preview/pr-1791/src/types.js\":\"5a415d349d57e0f2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/ClientLocalSettings.js\":\"aef88b30c28a93ba\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/abortableSleep.js\":\"9265e7996a6d08b5\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/array.js\":\"c09b0f9818e90a2f\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/backlinkAutocomplete.js\":\"0ec50a0cd912820c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/blockCrumbs.js\":\"c2a05c359f3afd1e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/blockrefAutocomplete.js\":\"67df057a30df7970\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/cadencedIdleJob.js\":\"a0ff038862347a89\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/callbackSet.js\":\"0085d69eef178519\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/clientId.js\":\"eb3eafc4507bf9bc\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/codemirror.js\":\"0e9f95b1acc87383\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/codemirrorCompletion.js\":\"cc7ab30702c82d01\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/copy.js\":\"96c9e025e4e2ecfe\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dailyPage.js\":\"dc859473da7c9b94\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dbForensics.js\":\"0468afacb30c2ca6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dbForensicsHooks.js\":\"88b8e2e0a1020d34\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/deleteBlockThroughUi.js\":\"dfd7d08f138d2992\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dialogs.js\":\"e1d14fb75e5560c3\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/dom.js\":\"fc1850e2e44b0e76\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/downloadBlob.js\":\"be91a1aab8010ee4\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/exportSqliteDb.js\":\"df5f898b3c3e82bf\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fileSystemAccess.js\":\"9fac673aa39d90ca\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/flipSlide.js\":\"fc8a214b7bd6fa67\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fnv1a.js\":\"b698124ac342d7aa\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/formatBytes.js\":\"4c092a236541c19b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/fuzzyRank.js\":\"b7275c03df673422\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/idbKeyedStore.js\":\"8d2169f8b84ddaec\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/idleCallbackPolyfill.js\":\"af852ea9ecf14293\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/keyboardAwareScroll.js\":\"95228c5405bfa5fd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/keyboardViewport.js\":\"1a46d425a833585a\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/lastWorkspace.js\":\"ae160b7f83e63951\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutColumns.js\":\"4de7f0e743ecbcad\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutSessionDom.js\":\"e5d74c2ce739c28e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/layoutSessionId.js\":\"6c50f6cb7048edf1\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/linkClickGestures.js\":\"2562e7b4c638918d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/linkTargetAutocomplete.js\":\"0d64a89b49b1daec\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/localDbCorruption.js\":\"86d51faaba70386b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/localDbRecovery.js\":\"5deb5b9ae2f03f77\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/markdownParser.js\":\"974be42f22d6775d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/memoize.js\":\"748e38b40b0395c4\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/nameFieldCommit.js\":\"83edcd8e70108b18\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/nameList.js\":\"c358d837db20bf2d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/navigation.js\":\"6ddc436013925dc2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/omnilinerNamespace.js\":\"96010fe9f96e2abe\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/opfsPageScan.js\":\"85f26eed857879f1\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelClearance.js\":\"ae63fcad620485de\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelHistory.js\":\"7d567172f3abc2ce\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelLanes.js\":\"c149e053a9d0194b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelLayoutProjection.js\":\"2b106b8f16f65e21\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelScrollAnchor.js\":\"e1644bbeb228c1ba\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/panelUrlFlags.js\":\"7ca2f988ccf56d97\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/platform.js\":\"067ee0f77c0ed4dd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/pluralize.js\":\"760600237df74ac9\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyCreation.js\":\"f328711ed970e1cd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyNavigation.js\":\"af3a6e663ee8d367\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/propertyValueContext.js\":\"9917bdf884e595e6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/react.js\":\"7c098bfb6c8408ef\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/relativeDate.js\":\"f240a1be063bf872\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/relativeTime.js\":\"06d13b1372251677\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/renderScope.js\":\"40a3ab123cc52622\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/resolvedThenable.js\":\"fbf3aadf76caac34\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/routing.js\":\"d4a4f586abef5ccd\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/safeMode.js\":\"a8aa545a654bd81b\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/scheduleIdle.js\":\"cf121ed414dc1c1e\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/screenWakeLock.js\":\"16531b9cc9e46521\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/selection.js\":\"55495021a3ffbb02\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/softKeyboardGrab.js\":\"ea5e5f434a77a00c\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/startupTimeline.js\":\"a45b56a9338ed8d2\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/state.js\":\"1f34b8fd513c85d5\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/string.js\":\"fd915335e0901d64\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/surfaceZoom.js\":\"726652078ab767bf\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/time.js\":\"a8bd1d32ae68e727\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/toast.js\":\"436820da8584908d\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/toggleStore.js\":\"5c11b6986d4c9437\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/untilStopped.js\":\"a413d0ddb72232a1\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/userActivity.js\":\"a260eeac8ae7a4ce\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/viewTransition.js\":\"c6240f7c4d548410\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/viewport.js\":\"756da5b2fc31d726\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/webLock.js\":\"e9b0b7453c3f07d5\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/workspaceRecovery.js\":\"1bd8e524c0df3769\",\"/knowledge-medium/pr-preview/pr-1791/src/utils/workspaceSnapshotStore.js\":\"8de3077a13472ae8\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-compiler-runtime.js\":\"4a79656a3f58449f\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-client.js\":\"7af6e2d91ab2d603\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-server-edge.js\":\"5b849a28aaca2d5d\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-server.js\":\"b5d201e5890dfa1c\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-static-edge.js\":\"6be77f3ae2c91443\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-static.js\":\"dfe1adb4964be2ed\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom-test-utils.js\":\"0901c551f5b3f2a7\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-dom.js\":\"c172c93e24a268f5\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react-jsx-runtime.js\":\"d1c4632cf3beeaa4\",\"/knowledge-medium/pr-preview/pr-1791/src/vendor/react.js\":\"a607f0682b97f573\",\"/knowledge-medium/pr-preview/pr-1791/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1791/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1791/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
