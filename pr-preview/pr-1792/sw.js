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
		buildId: "4c1b583258c2-b8fb7415",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/\":\"33ae59a2eafe47be\",\"/knowledge-medium/pr-preview/pr-1792/index.html\":\"33ae59a2eafe47be\",\"/knowledge-medium/pr-preview/pr-1792/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1792/assets/FacadeVFS-DK_m4b1Y.js\":\"4bb791addfac3c12\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSCoopSyncVFS-Zqtg_HSC.js\":\"592db766baace772\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSWriteAheadVFS-BpV4uArO.js\":\"b6e82fc411767c60\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-C5JwTb57.js\":\"2036114e522e7b90\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-D2n_Bu4X.js\":\"273a25129a94281e\",\"/knowledge-medium/pr-preview/pr-1792/assets/worker-CNaCKKyd.js\":\"b0b355ab45606872\",\"/knowledge-medium/pr-preview/pr-1792/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1792/chunks/app-BWjVG2Le.js\":\"29aea10e30ed348d\",\"/knowledge-medium/pr-preview/pr-1792/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1792/index.js\":\"de792eb828bf328d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1792/assets/AccessHandlePoolVFS-DfigPRIs.js\":\"d32bc6e08a10b20a\",\"/knowledge-medium/pr-preview/pr-1792/assets/IDBBatchAtomicVFS-CdFFIkSz.js\":\"e115a0a7b12a5a6d\",\"/knowledge-medium/pr-preview/pr-1792/assets/MemoryVFS-CyGGf8x8.js\":\"0f96075ab673944f\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-CT_C0yjA.js\":\"be4b1aa564c15771\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-BWiDfXtw.js\":\"e49beb7cafd65848\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1792/chunks/AccessHandlePoolVFS-6Fed5C-4.js\":\"2561874c2a361ae0\",\"/knowledge-medium/pr-preview/pr-1792/chunks/FacadeVFS-DAhAAeua.js\":\"1150d8c929cc29b0\",\"/knowledge-medium/pr-preview/pr-1792/chunks/IDBBatchAtomicVFS-DKpHYzIQ.js\":\"7da15f798464686a\",\"/knowledge-medium/pr-preview/pr-1792/chunks/MemoryVFS-y1IuPMSv.js\":\"7cc2442d6ab4e133\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSCoopSyncVFS-B9LrAXjy.js\":\"801057fdf3066464\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSWriteAheadVFS-D5AisPT8.js\":\"57c66eb572bcceeb\",\"/knowledge-medium/pr-preview/pr-1792/chunks/Preview-Bl4Hgoj-.js\":\"059ed71b97f54f82\",\"/knowledge-medium/pr-preview/pr-1792/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1792/chunks/card-3-u_8PE9.js\":\"9096b6e68f7f3539\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-CrK1L1K5.js\":\"dd25f82889d99cbb\",\"/knowledge-medium/pr-preview/pr-1792/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-DX-cJLLu.js\":\"59201cd2f0953ad9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-async-BFPgErhd.js\":\"ff80946b27b0e1f3\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-B-APM_wH.js\":\"f91a117834951fb9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-Bl1wre7S.js\":\"2319552d290197c4\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-C-GpSM04.js\":\"01ced3a57361bbea\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-CMIWNqpZ.js\":\"f0c815956730bc73\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-CYTaTk9c.js\":\"e081072d1dcb428d\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-CjtGETIo.js\":\"de37799bcea92700\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-YxbyaAk1.js\":\"683f3fda536a7583\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server-legacy.browser.production-HajzXpro.js\":\"a7b0d7ae9a0aff3f\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.browser.production-y6gA4efF.js\":\"034583bc31e8443b\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.edge.production-BRYZu6bF.js\":\"d227fb2e83c9fbf3\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-p5h0z410.js\":\"746b8b1851d000bf\",\"/knowledge-medium/pr-preview/pr-1792/chunks/server.browser-hEKHl8Ds.js\":\"49381e28fed7e8a5\",\"/knowledge-medium/pr-preview/pr-1792/chunks/textarea-BV0eFQLz.js\":\"0e9d6fd214bb18ef\",\"/knowledge-medium/pr-preview/pr-1792/chunks/ui-DuDpxfrL.js\":\"b82947aefee62eda\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-BiJyU6tu.js\":\"3488f6117774d257\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-async-CLHlzpnB.js\":\"3dbb1e830709a816\",\"/knowledge-medium/pr-preview/pr-1792/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1792/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/src/App.js\":\"f6462ed60a7b5f77\",\"/knowledge-medium/pr-preview/pr-1792/src/appUpdate.js\":\"7943b8298728d637\",\"/knowledge-medium/pr-preview/pr-1792/src/appVersion.js\":\"21bff71b4a3b75f6\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/initialLayout.js\":\"9cb1eb334e998e58\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/openWorkspaceData.js\":\"bb70fae833a9bb26\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/resolveWorkspace.js\":\"cc40897a21e082b4\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/workspaceBootstrap.js\":\"ce3b72f31d861afb\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockComponent.js\":\"fd2ddf8e2b37b951\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockCrumbs.js\":\"1b2356ea20dcf1ad\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockEditor.js\":\"73d1c3cf75d845b6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockLoadingPlaceholder.js\":\"4dcbf1f42efdb2ca\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockProperties.js\":\"db6e0d08e576df9f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockSearchPicker.js\":\"b165c485458872d4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ConfirmBulkDeleteDialog.js\":\"de69f4930f450c08\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DividerHandle.js\":\"95e60ab26b24a6c6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DraftEditor.js\":\"355d87b93775d1dc\",\"/knowledge-medium/pr-preview/pr-1792/src/components/GutterPill.js\":\"bb0cfffcd24de512\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Header.js\":\"caf2291e64218ce0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/LazyBlockComponent.js\":\"652ea00fb80f92d4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Login.js\":\"cf1c0fa1da1e5c9a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ZoomableSurface.js\":\"f7012649b8535476\",\"/knowledge-medium/pr-preview/pr-1792/src/components/editModeKeepalive.js\":\"c42415864a00ac74\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e2cf96766f3d3a06\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"52f1d0f1ace65cb6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefPropertyEditor.js\":\"ae8b49713f24e230\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefTargetTypePicker.js\":\"1e4ae3117f993570\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/SelectPropertyEditor.js\":\"2cdf34dd5db8795d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/TypesPropertyEditor.js\":\"ebd316813ef7cbe3\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/defaults.js\":\"a8d2a3311d128ea5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/kernelValuePresets.js\":\"3c304a2e956aa681\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/selectablePresets.js\":\"e5b6584c3a860999\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/typesPropertyUi.js\":\"99bb8836a69c0e0d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/AddPropertyForm.js\":\"74d5b3b34926fda6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyPicker.js\":\"6f9045c1523126a0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyRow.js\":\"9f7b2d09190bbc79\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/Rows.js\":\"37506cf8cbfbe58f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/actions.js\":\"6a11f0b8b27a929f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/declarationOnly.js\":\"7d26b087e627dc50\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/layout.js\":\"b7951abc79353135\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/model.js\":\"61df78df7b8e9ba2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapeUi.js\":\"d90137d5fb34ee41\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapes.js\":\"0be93d8a6f7fca0b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ce4571f0fc281e3f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/visibility.js\":\"2344136abec520c5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanelSections.js\":\"77d1d517c6ffec2b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockEmbed.js\":\"f12f0d3d1af6af5c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockLink.js\":\"3b703848f95339e7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockRef.js\":\"3dcd2c3f777d2f5f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/ReferenceLink.js\":\"42ff0f393ad21ce6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuard.js\":\"5c895603f798b620\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuardContext.js\":\"efd76ac58dc03da4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/linkInteraction.js\":\"6dedb95f2fa4af29\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/referenceLayout.js\":\"87efc08503a97b8a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/useBlockRefAncestors.js\":\"fd90594b4a5f5391\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockGutter.js\":\"3fbb482905a138f5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockInfoDialog.js\":\"d65cddc76cda570a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockTypeBlockRenderer.js\":\"86dcae62a692f3f0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BulletHoverCard.js\":\"864f4591d542ca78\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorContentRenderer.js\":\"1810a06d51e8319c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"556933e36b1df1e7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ColumnResizeHandles.js\":\"bfd6329d9e4ac374\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1d87bfe3d2a25ef2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/DefaultBlockRenderer.js\":\"be166e8f3cc73606\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/LayoutRenderer.js\":\"e972bbc4db684d83\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MarkdownContentRenderer.js\":\"7e9305278a9e2584\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MissingDataRenderer.js\":\"81238fcb72afba23\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PanelRenderer.js\":\"7c120f895de8e1e7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d4482bf09b777d34\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/TopLevelRenderer.js\":\"5b5ca9ae01d1b757\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockGutterMode.js\":\"38189be58f5fea61\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockTitleText.js\":\"207ee1d4c4ef2e95\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/fieldCreationKeydown.js\":\"278a03750b7bb55b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/layoutRootContext.js\":\"457167df2d414dd4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/TypeChip.js\":\"1dc18912af17a78f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/chipStyle.js\":\"1880f7c2fc644b28\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/anchored-floating.js\":\"a407766da6e9f3db\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/button.js\":\"946cf96f912b4924\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/card.js\":\"7e447f1ce30d5831\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/checkbox.js\":\"48a467d3dbf81772\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/collapsible.js\":\"9d184de6687770aa\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/command.js\":\"62230f24a70896c7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/context-menu.js\":\"6364bd83b65df129\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dialog.js\":\"5562cec7a634989d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dropdown-menu.js\":\"87222aa42af78489\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/floating-listbox.js\":\"989929c50ee33370\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/index.js\":\"24ac72ed390d6ce5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/input.js\":\"fcfa795773570e30\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/kbd.js\":\"ec2196e03c2fdb9d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/label.js\":\"fca90c0207723870\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/textarea.js\":\"4c1454eeebe2402d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/useEditModeYieldKeepalive.js\":\"43c9f94c58b57ee4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/BootFallback.js\":\"886932d99a83c2e6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/FocusedRowLazyMount.js\":\"094cd528ea68f733\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LazyViewportMount.js\":\"74cb084c3d442df7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LocalDbCorruptionFallback.js\":\"dc5bea91a4c9c50f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/error.js\":\"1e6c35f1329021c7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/lazyMountRegistry.js\":\"79892f24fec90b48\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/suspense.js\":\"e37895a168298b24\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/CreateWorkspaceDialog.js\":\"876e4de3a72ac597\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/PendingInvitations.js\":\"6b9cac0190e896f5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/SyncProgress.js\":\"205ab114efffc581\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/UnlockProgress.js\":\"1b93e873e82f778b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceKeyGate.js\":\"fd3fd08d8297c23b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSettingsDialog.js\":\"0a7e1473358f96df\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSwitcher.js\":\"7fe8a3cec3aee206\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSyncGate.js\":\"471e18f2679358e1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlow.js\":\"646ae9d36f4ccad9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlowHost.js\":\"28c82dfb51ff06d0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/EncryptionSection.js\":\"71ad412e14deea55\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/attachmentPrompts.js\":\"ae0b1467b310c4c4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/bundleFolderPrompts.js\":\"56378be9bd00b864\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowDeps.js\":\"5f88f5687e086ce0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowStore.js\":\"1507b00174cb4c96\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/flowUi.js\":\"11ddcacccfb67c45\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/useConversionRun.js\":\"acacdf8a1f17cf8c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/keyUi.js\":\"0985706fe96db55b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnKeyLoss.js\":\"29d371c432a8901f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnServerE2ee.js\":\"236972334bfda914\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/workspaceUnlocked.js\":\"629d6e84297a2250\",\"/knowledge-medium/pr-preview/pr-1792/src/context/backgroundSubtree.js\":\"2fab725842871081\",\"/knowledge-medium/pr-preview/pr-1792/src/context/block.js\":\"4286fbef2f684856\",\"/knowledge-medium/pr-preview/pr-1792/src/context/layoutWsContext.js\":\"c509a6492ff39f78\",\"/knowledge-medium/pr-preview/pr-1792/src/context/propertyDisplay.js\":\"d49743a5cb06e3e3\",\"/knowledge-medium/pr-preview/pr-1792/src/context/repo.js\":\"59b90d7872f4584d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasClaim.js\":\"8842a9af988b4ebf\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasSeatNamespace.js\":\"ca9afb0e5f44e2b2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockData.js\":\"ac33a7cf5704205c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockType.js\":\"c6a42918f323ccf8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/changeScope.js\":\"7b7302c2da7346ee\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/codecs.js\":\"8523cfb1e48fda3c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/derivedData.js\":\"4280bfe4216c19a5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/errors.js\":\"4572c30d234361cd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/events.js\":\"f2b60902c2e6fd42\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/handle.js\":\"d9ba0fc1a56faf98\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/index.js\":\"0604f32bff3a202d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/mutator.js\":\"e58b12b43e516772\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/processor.js\":\"d8c6cd48dcd213fc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/propertySchema.js\":\"4021619835b1c465\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/query.js\":\"0d956e691a2183ca\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/sameTxProcessor.js\":\"c80460b1ce700b1e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/schema.js\":\"d9ba0fc1a56faf98\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/tx.js\":\"d9ba0fc1a56faf98\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/typedBlockQuery.js\":\"226cd0fe65351a3f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/user.js\":\"592b6a857eb8a296\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresetCore.js\":\"df30d6c58e69ad9f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresets.js\":\"8cc2573fed2e84d7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/attachmentCleanerIOVerb.js\":\"c0e93e8c0de59f65\",\"/knowledge-medium/pr-preview/pr-1792/src/data/block.js\":\"18d767f172c95da5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockCache.js\":\"b699ac9c9103cc04\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockId.js\":\"9462fbda3e598bf6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockLiveness.js\":\"931087bb3239ed6f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockMerge.js\":\"041b19f21d1fc0f7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockSchema.js\":\"568d4c049e9eb42d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockTypes.js\":\"c7f84d418193d1dd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/clientContext.js\":\"848f8b71cda4c2cc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/dbFileSiblings.js\":\"19f629cfbb50f13b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/definitionSeeds.js\":\"c3fb3f50fd489753\",\"/knowledge-medium/pr-preview/pr-1792/src/data/derivedIds.js\":\"53d1e1adda1b622c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/drawnSubtree.js\":\"972601e7dfa89722\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facetBridge.js\":\"795269a0c5c4870f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facets.js\":\"4c1a855f2a5daf9d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/globalState.js\":\"14caa77d9758c329\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/aliasClaimRederiveProcessor.js\":\"450b73f6b297b445\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/ancestorBatch.js\":\"3125faa44ebe01bb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/blockTypeTypeifyProcessor.js\":\"76b7e73ca5f6a221\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/clientSchema.js\":\"f0e8d9ce50d74b30\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/commitPipeline.js\":\"8826d0ce53c0af17\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/devAssertions.js\":\"8bbebdad95d10a3a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/firstSync.js\":\"b05bb6a4d53acf0f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/freshInitialLoad.js\":\"2fefd0ae4e42ed0a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/graphBackfillClaim.js\":\"51bfa1317c83775f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/handleStore.js\":\"cddd80e2ef95d126\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/idleMarkerJobs.js\":\"a6b5d78886b5d162\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initialDownload.js\":\"9a6baffb34e4c5ac\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initializeClientDatabase.js\":\"2a9663487ac301c0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/jsonCanonical.js\":\"9392c517c084fc93\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelInvalidation.js\":\"59481978a99de09c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelProcessors.js\":\"08a783e982225b88\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelQueries.js\":\"fa3e6387e59af67a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/mergeTypeMembershipProcessor.js\":\"c023a9a710c83de7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/normalizeReferencesProcessor.js\":\"ce2d890fa0ec6fef\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/poolInstrumentation.js\":\"49ba7588863344ee\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/processorRunner.js\":\"0d74faac6db26ee7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyCellBackfill.js\":\"52cf5137bdd6b712\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildMint.js\":\"790d5be36f344bb2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildrenProcessor.js\":\"47c8e01aec2969f9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7bd2f9b05a04bac7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionSynthesis.js\":\"ebc1e445e0c6f208\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyKeyScan.js\":\"58dfc7ce7feffbeb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertySchemaResolution.js\":\"4f5985eaa0e568a2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/raiseProtocol.js\":\"07e92aac867b8ea0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/readBatch.js\":\"0937a6408a986dff\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/refProjection.js\":\"c8427d21a1a8b26a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetLookups.js\":\"31ecee6901443796\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetProcessor.js\":\"42825be7c786011d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/replayMerge.js\":\"0ff6c5f1a9eae47a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/sqlBinds.js\":\"602789ae67b6b8ba\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2ff8cfc6589032c0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/arrivalProcessors.js\":\"2d097e87f0e78210\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/invalidate.js\":\"f141f68053f09e85\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/materialize.js\":\"a3b64a17a85aa55e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/observer.js\":\"08f8e01f47ab5e86\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/reconcile.js\":\"5b35b562fcdfb81e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/timingMetrics.js\":\"ad461750e5397c49\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/treeQueries.js\":\"6588af4fa788e6d0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txEngine.js\":\"e8c43a6813f70460\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txSnapshots.js\":\"0d5f3ea281c52e0c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/typedBlockQuery.js\":\"6988ea96a6c00d26\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/undoManager.js\":\"d98889ae618de59e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/invalidation.js\":\"f1671cb1e8ab8d0a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelDataExtension.js\":\"acffd5ba796acba1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelPage.js\":\"1fa698091b48efca\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelValuePresetCores.js\":\"aff789a5d25b67ee\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbCorruptionSignal.js\":\"01ab1707127c6da3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbStorage.js\":\"a61934cbe1f4f99f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbVfs.js\":\"05a40caf2acf5a4d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localSchema.js\":\"41f7f14edae195b8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/maintenance.js\":\"f40c29d47659f2ba\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mergeProperties.js\":\"1e1159a61b346985\",\"/knowledge-medium/pr-preview/pr-1792/src/data/metricsConsoleHook.js\":\"92944a4157e01d52\",\"/knowledge-medium/pr-preview/pr-1792/src/data/migrationsPage.js\":\"ccb962aa2b3bc1c5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mutators.js\":\"8fb1d7523b698f89\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKey.js\":\"340c3337f535cb85\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKeyPlacement.js\":\"3ff9f598e86b1fce\",\"/knowledge-medium/pr-preview/pr-1792/src/data/outlineSurface.js\":\"3940c9eadebe30d6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingEditorContent.js\":\"53512b3138ef1841\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingUploadsSql.js\":\"cde055227b8378ef\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pluginStateExtensions.js\":\"136be1d622d4b285\",\"/knowledge-medium/pr-preview/pr-1792/src/data/powerSyncLogger.js\":\"d6e1f93f7671b645\",\"/knowledge-medium/pr-preview/pr-1792/src/data/projectorRuntime.js\":\"b5b010c649594402\",\"/knowledge-medium/pr-preview/pr-1792/src/data/properties.js\":\"bd6abdda1d2df028\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertiesPage.js\":\"88c0c34f31486c13\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyChildren.js\":\"fe51e21fe6453c8c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionFanout.js\":\"559dc616bd8a9a94\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionMetadata.js\":\"a99adbabb99bfc92\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionRegistry.js\":\"d080e976d338cc05\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDisplayMode.js\":\"9b5e1585d6b3dfba\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyRowCreation.js\":\"12c47c7b3d77660e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySchemaCreation.js\":\"6b74b077acac9f72\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySeeds.js\":\"f30e77825d9c409f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/recentsPage.js\":\"3861a4bbe93d48c5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/referenceBlock.js\":\"6d811322fd2b71fd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/releasePowerSyncConnection.js\":\"a05e1b9ad91f31b9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repo.js\":\"2c6ab4603f981e2f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repoProvider.js\":\"e299fc0a9232b166\",\"/knowledge-medium/pr-preview/pr-1792/src/data/rowProperty.js\":\"bbdfe7c287f65c4c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/searchFilter.js\":\"58e617fe44ed62f7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/seedIdentityLedger.js\":\"36cd7c97fd615528\",\"/knowledge-medium/pr-preview/pr-1792/src/data/stateBlocks.js\":\"2fa38b852e9be11f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/structuralEditPolicy.js\":\"716e32eaed2873b8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/subtreeDelete.js\":\"6b1152fb912d4d7f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncStreamLock.js\":\"6402aa8f91235d70\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableSqlRecognizer.js\":\"4763ecf58b292019\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableWriteGuard.js\":\"735aeddaa251bffd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/targets.js\":\"d6b83af8260dbe89\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeColors.js\":\"270f9f6793f213d2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionMetadata.js\":\"9cdb458ee76a4ea3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionRegistry.js\":\"5ff339fa61998921\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeExtraction.js\":\"bdc22c0ce192ce15\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeInitialValues.js\":\"38345eb11b679a67\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typePropertyGroups.js\":\"33af296f7f21ce36\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeSeeds.js\":\"5114b5f95e5ddf53\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeTagger.js\":\"23178e52230aa55b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typedRecords.js\":\"696e5477de1ecc90\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typesPage.js\":\"61926e5e99e08c31\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userPrefs.js\":\"c01e356163714814\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userSchemasService.js\":\"7d0c16908846c431\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userTypesService.js\":\"9a0dd4c35dbe6e5e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/valuePresetRegistry.js\":\"b75f323a31902e3f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/visibleChildren.js\":\"13ea08b7286b2b99\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceConversion.js\":\"4ca4a38025550bbf\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceFirstSync.js\":\"fd9547b13c44ccd7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceIdNamespace.js\":\"ea64f0e71363268d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceSchema.js\":\"f668dd3bf987ba26\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaces.js\":\"17b0971c2ddd2ec9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadLog.js\":\"98c78db6bc9a8c55\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/BlockPasteShellDecorator.js\":\"ae59bebdda5ba8e3\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/atTrigger.js\":\"0d604cc0bcb59c99\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/autocomplete.js\":\"2c161cb98ac24c1d\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/codeMirrorExtensions.js\":\"c00ec8b6bf2fe69e\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/contentFlush.js\":\"f9d38c5f6cf94036\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/defaultInteractions.js\":\"44c3ba2deac789e0\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/editSettleSignal.js\":\"313a7861ae09cf2f\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/insertImage.js\":\"e965c82f4af16d32\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceCompletionRange.js\":\"ddefd66580189349\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceTargetTypes.js\":\"3fb58d555b336a2a\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/syntaxContext.js\":\"04dab15c2b2fcfc0\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/triggerMatch.js\":\"309e6f05feea64dc\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/AppRuntimeProvider.js\":\"134e4530e7569ff3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/BlockFocusShellDecorator.js\":\"d451441d6bf85d1b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/ExtensionRenderBoundary.js\":\"934d0270b322f29c\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/PanelContentRecovery.js\":\"83f47cc8252a6eb0\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/apiCatalog.js\":\"f32a62fc125f6e17\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/approveExtensionHere.js\":\"86f6a16ee594f688\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/armedCutAppMount.js\":\"32615f26373cd039\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/batchableKeyedStore.js\":\"b47624bdb24cfe33\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockInteraction.js\":\"e8bcd26e34b4355c\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockSelectionAction.js\":\"b3fe5845e836a7ca\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compileExtensionModule.js\":\"3fd3abb39ac960bc\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compiledModuleCache.js\":\"7b9347ac4362d232\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/continuousGestures.js\":\"f90c4b98b3bac755\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/core.js\":\"5be7e45347c0eb42\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/defaultRenderers.js\":\"9dc665fadaf13e57\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/definitionFanoutAppMount.js\":\"454ae6e8c79eb254\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dialogAppMount.js\":\"cf53c6b010445e1c\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensionSeeds.js\":\"df82db29c6ba424e\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensions.js\":\"9222e8544d606300\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/exampleExtensions.js\":\"8d28a87de98264ed\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionApprovalStatus.js\":\"345d02dfd8eeed5f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrorToast.js\":\"2bac083579b8c68e\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrors.js\":\"cacca9716368f4f7\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLookup.js\":\"c9879958c8652b24\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionToggles.js\":\"b8654fb5e3661fc5\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionUtilitiesCss.js\":\"03510eb6328b084e\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/kernelPageDeletionGuard.js\":\"3c7dde7397f3c669\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/liveRuntime.js\":\"94a72f36a95179ac\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/openExtensionsSettings.js\":\"36473385f20616ba\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/overridesCache.js\":\"6b2228fbb92a0c1a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/pluginIds.js\":\"47a4cb9f7e889ac4\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/processorRejectionToast.js\":\"48704b8882829eb3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeActions.js\":\"b6a66f7c810b3715\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeContext.js\":\"9c28f1e97d19bc61\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticAppExtensions.js\":\"6d3bd45aadbd2f1d\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticDataExtensions.js\":\"074cc39effc08899\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/toastAppMount.js\":\"e94ef33d3db00296\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useOverrides.js\":\"b0f29a27303e14b8\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useShortcutSurfaceActivations.js\":\"12ff207922aea5a0\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/discoverToggleTree.js\":\"827ceb36c99754af\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/facet.js\":\"de8b7881a5f26a34\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/resolveAppRuntime.js\":\"f8d4244e07a6a3fc\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/runtimeEvents.js\":\"fed9e5a651859667\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/togglable.js\":\"7e60fda99ea6c609\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/variantFacet.js\":\"591d25c01b793887\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/verbFacet.js\":\"fa2c3f8db81be43d\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/block.js\":\"cb8f957588a6c2cd\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/focusedChild.js\":\"a6f92c5c7e22a8d6\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/propertySchemas.js\":\"167831343f5a91bf\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/typeRegistry.js\":\"f45cc996b65ce418\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAncestorCrumbs.js\":\"dbf97065cc01940b\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAutocompleteListbox.js\":\"47e8fb219164fada\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedSearch.js\":\"925e8895bb7d46ff\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedValue.js\":\"86aa0e8c7d32dc79\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsFocalRender.js\":\"f1f09bb0b4ad6f90\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsReadOnly.js\":\"984771aebe4cc7cf\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMaterializeBacklog.js\":\"ff35405f88cf7012\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMinuteClock.js\":\"49d13737913a4d80\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePanelLayoutProjection.js\":\"5109377a44596e3e\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePendingInvitations.js\":\"3af0c3b596ea6b1c\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRendererRegistry.js\":\"20180d8d801513be\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRetainedFieldRows.js\":\"1fd86bd9e32ab3f0\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useWorkspaces.js\":\"1cc1a3e584ba7458\",\"/knowledge-medium/pr-preview/pr-1792/src/lib/utils.js\":\"718097e0405e8c35\",\"/knowledge-medium/pr-preview/pr-1792/src/main.js\":\"4c9e29e16577f9f2\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/MarkdownImage.js\":\"8d197e041fdb8c0f\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/blockSeparators.js\":\"0d0bc1698167d5f1\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/context.js\":\"e20df472e973a477\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/defaultMarkdownExtension.js\":\"8ad6abcae209b7a2\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/extensions.js\":\"5424eb8d495ee7d9\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/renderMarkdownHtml.js\":\"88f7780901f389f1\",\"/knowledge-medium/pr-preview/pr-1792/src/minimal-editor.js\":\"6ee6abfe038b9ab5\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/armedCut.js\":\"a54be1ffa15fea74\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/captureMediaVerb.js\":\"73597fefb35bfc62\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/clipboard.js\":\"ecd650457697db17\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/decision.js\":\"d2452df85625a209\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/operations.js\":\"9d0a7a9c3b8eda64\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/AccountHeaderItem.js\":\"92140dcd0ce8e921\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/index.js\":\"6fd7b9d4b36d160f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5ba26697a9072d59\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askAgent.js\":\"1d6455b66e702fd1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askedStore.js\":\"6a3e9e7877defb20\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"45ce3401428cbd8d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/chipState.js\":\"13c9e4c9e56f78a1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/dataExtension.js\":\"59cf1ee84657811c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/index.js\":\"61e65c8adfebe000\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f98116b5994823e8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/schema.js\":\"ea1d6c0330e31118\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e68e2dd1c2262301\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/BridgePairingDialog.js\":\"1e6846184a587015\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/addMedia.js\":\"e47dc0a0c726507c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0c77453e08aa982d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/block.js\":\"fe156bea67935eab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/context.js\":\"1ba9385c434c7ef9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f4d8315288aaa563\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/index.js\":\"f84582e29180df1d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/outline.js\":\"668d36b88baf637c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/properties.js\":\"89d0b1afb5d02d58\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/refs.js\":\"96ba556ad9914e7d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"238e19ec346accfc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/search.js\":\"a72be518f8c54e68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/shared.js\":\"d2d635fc13737b39\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f3b304d136dc1d8c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/text.js\":\"d25712ae77deecda\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentWrites.js\":\"003954d6120c89a6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/authoringCatalog.js\":\"02b1758f9e2b811c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/blockRefTargets.js\":\"5389ec2f88e7ea9a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridge.js\":\"f0a0635c06a8a039\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridgeLoop.js\":\"3a1e1992d8c6a62e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/changeHistory.js\":\"e380f2febe826aaf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commands.js\":\"3222db19a26c491c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commentsCommands.js\":\"c45ad0847635dc62\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataExtension.js\":\"9881e308df417a9f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataModelGuide.js\":\"355cda7004d89919\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/describeRuntime.js\":\"179eb74021200070\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/extensionLint.js\":\"1ce5a77e3cf9211a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/grainAudit.js\":\"8be439d3b6bd8963\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/healthCommand.js\":\"ec967a5349c9f9e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/index.js\":\"cc43efb0c4658c6c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/presetIdentity.js\":\"666a58c864fa6023\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"db4edb57407e064a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/readMedia.js\":\"273e356ec75498ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/schema.js\":\"e7b702ae905d5715\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/serialization.js\":\"c6dfd3933ff5c169\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/targets.js\":\"46c225fa8d25f4f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/tokens.js\":\"36be9cde8f4de859\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/watchEvents.js\":\"a4cdc09a177a4f9d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/workspaceGuard.js\":\"0d655b8350c7945d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/writeCommands.js\":\"59338c1a6ae1c70c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/AliasCollisionToast.js\":\"91be7772e801eeeb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/DuplicateNameBanner.js\":\"b0d23519a2d1f25d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/collisionMerge.js\":\"944518543f4518df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/dataExtension.js\":\"090d88e86892e215\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/index.js\":\"4cf7c99b74629ddb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/mergeCollisionAction.js\":\"4551ee11140ada13\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/pageStyling.js\":\"e679ee50bcc0d7c3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/rejectionToast.js\":\"a1b118bf17f458cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/syncProcessor.js\":\"4e43370a529f67a0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/actions.js\":\"d2ce8680dfbaabb7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/addComment.js\":\"da8a10177809f113\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchor.js\":\"5b14509ceaa272c8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchorState.js\":\"b73308cbf1c86baf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/commentLinks.js\":\"4270a514d76d48d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/confirmThreadDeletion.js\":\"9ac1a240303272fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/container.js\":\"87c4f8370bcace84\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/dataExtension.js\":\"0a58858184bbf53b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/deleteComment.js\":\"039e18bb3d5d0e7c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/highlights.js\":\"8c89578771c624a2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/index.js\":\"20bb6f90a9c42928\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/linkedCommentsPill.js\":\"3f945368964acbba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/margin.js\":\"1b68d589be8e2998\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/marginSchema.js\":\"4cac7d5d6cb123b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/newComment.js\":\"f12b4ee8e8fc67c0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ownThreadPicker.js\":\"7d5afc24866d709e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/placement.js\":\"f41f2ea6bacde754\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/queries.js\":\"fc55bf5624368d3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotePosition.js\":\"7f93acdabe802e0e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedIn.js\":\"154e41d8fcf96199\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedRange.js\":\"3164a92e10fbea3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/rangeRefs.js\":\"caa37eecea5e1b2d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readHighlights.js\":\"7725a9ec05b95739\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelection.js\":\"add0bfe5b124ff07\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelectionUi.js\":\"e290616a3fd571cd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/reanchor.js\":\"53d54be4ecf0c3ef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/schema.js\":\"985b5a26cd42a673\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scope.js\":\"3a5cc3241583a2e8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scopeThreads.js\":\"3dcabfd1c9733669\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/splitRetarget.js\":\"6cd2fb234e3761c1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestionCard.js\":\"e91d8f260feb5e45\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestions.js\":\"5e6dbb9207185530\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaries.js\":\"4562b62c86722c6f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaryBatch.js\":\"f33e43bea5a57d1a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/surface.js\":\"11b204757419289b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threadNavigation.js\":\"0104228b36a82508\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threads.js\":\"7d5cc008f417c3f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ui.js\":\"b3ab92a016130f3a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/uiStore.js\":\"4ae3bed0f637735e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/appIntents.js\":\"1e205d0c32e174a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/index.js\":\"e2ca503a77036372\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/index.js\":\"e926c75c462e0026\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/status.js\":\"f3714705ab33cff5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"bdd78a9243cd8b8d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaBlockRenderer.js\":\"9bf65d8ca5d3508b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7dc22e05fb1e02e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaUploadReconciler.js\":\"f2bdb7b65160f7d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetDownLane.js\":\"a6d4e2b19ee6afaa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetResolver.js\":\"6e9d5c798222d126\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetUpload.js\":\"2f9a2118184ddf8e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/attachmentCleanerIO.js\":\"0d758dfc5e4f3a16\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a5b8f5d0fc4f015c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/blobStore.js\":\"852df2d8f3a05722\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/byteStore.js\":\"a1b9ec9924506290\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanerIO.js\":\"ed1f151d629cf2b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanupAttachments.js\":\"ec7d66b6e2c64612\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/dataExtension.js\":\"204277d4740d88da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/downLane.js\":\"a0edf71c37c92ecb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/index.js\":\"ac84e324352c0ace\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/insertImageContribution.js\":\"9eb8a55759225bb8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneArming.js\":\"f8221d6df235a92f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneLock.js\":\"0e088dfe7eaada27\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaBlock.js\":\"d28df15deef44453\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaCapture.js\":\"0fc58397a01a619e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewers.js\":\"6aea68926b760793\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewersFacet.js\":\"b3ad3f99f30e70a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/pasteCapture.js\":\"6025fcd4d1bcef06\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/resolver.js\":\"e760a1ff0f597ec7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/retryUploadsAction.js\":\"eeec429e9a762f64\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/storagePaths.js\":\"150ab57db47ee3d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadDrain.js\":\"f0b3322d4db3d536\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadLaneStatus.js\":\"e2063c1ae54df96a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadReconcile.js\":\"4f566c7618c90fac\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadRecovery.js\":\"6295cad5cfaac0da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadStore.js\":\"87356bf2184f053f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/useAssetObjectUrl.js\":\"5427933f13949b78\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"37a7e0ced46f6ca1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksViewSection.js\":\"cfe71d1bc41d9f1b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/facet.js\":\"78d7ccfdd20bf4c2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/index.js\":\"61c51f55e6f368b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/prop.js\":\"178812d0123fc64f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinkFilters.js\":\"351f4b4339fab727\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dc19b2c28366d0fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BlockEntry.js\":\"f1c05d7a8f66d4b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/LinkedReferences.js\":\"91879b2c7b6a9c00\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6debaf0a30c59a91\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dailyNoteDefaults.js\":\"f1719c14751a155e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dataExtension.js\":\"7460a5eae4e783eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/edgeExclusions.js\":\"cfaee93a405be1dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/filterProperty.js\":\"c5aed126b9bed8d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/index.js\":\"784f9dd1f9f17d24\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"577eddcf33b89630\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/applies.js\":\"60124cfcb47076cd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/countQuery.js\":\"50e432c7523bf3da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5d34c3de6b48a9b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/index.js\":\"51efe03da5078312\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"65a8a6eb78bd6513\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/presentationInvalidation.js\":\"78d8e67a42efd7f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyEditorOverride.js\":\"fc98a35cafff4f84\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyFilter.js\":\"67850bb788968e77\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/query.js\":\"b78ac8747a392ff6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/resolveFilter.js\":\"1d5333bf0cfe2a9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sourceBatch.js\":\"5499800c6f9e5da5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sources.js\":\"74fc4b959ba78383\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useBacklinks.js\":\"b966c2aece82ee0e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"cd4bdb9e401925bd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayCelebration.js\":\"d113e01aa514dbc0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayOverlay.js\":\"feda41d1a5d0936f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/gate.js\":\"35a78de8c214e9b7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/index.js\":\"d8ee39fdf8373ef7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/wolfTheme.js\":\"3917662362c4b596\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/BlockDragLayer.js\":\"06ffa8ce2dfb86f4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dragController.js\":\"65af6371b584529a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dropTarget.js\":\"cffaf9b831e2bf1b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/index.js\":\"80799691fb5276ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/projection.js\":\"74d3432369793057\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/BlockMetaCard.js\":\"72480430e4ad6e7f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/index.js\":\"918ddcddaa698a48\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/AddTagDialog.js\":\"a2534cb73d982e71\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2b656c762f571ee7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/TagNameIssueHint.js\":\"bee63009c15cf4cf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/addTagAction.js\":\"93241f667c43d48e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/appendTag.js\":\"fe0180dc921aa5ce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/config.js\":\"d6916e06e70891cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/dataExtension.js\":\"eac41fb7ac208586\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/index.js\":\"6a41fe81217dc12d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/propertyEditorOverride.js\":\"7b8638db9a9827bf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ecf1947e3d5493f5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3d259d428d7fa4dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/Breadcrumbs.js\":\"17c0bae00cde5c46\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d0f6dbfb6fdd8b31\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"db47232209303721\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/index.js\":\"b83b1edffb427093\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cd59359b9f02ea64\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/CharacterCountItem.js\":\"3a82d16c985a03c4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/ProfilePropertyEditor.js\":\"51f579d29a21c2e8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/actions.js\":\"affbd64893a88610\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/blockType.js\":\"f2c9222ef3761ae3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/charCount.js\":\"cd5bb8d4a9c8a477\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/dataExtension.js\":\"a40e4e07d29b7446\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/index.js\":\"a22e4d3276b16637\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/profiles.js\":\"f79f07ceaaba5545\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/properties.js\":\"9d8a2d53d1e8ab5f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/textCounts.js\":\"9d75d63066ca0cfc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/colemak-keybindings/index.js\":\"1c13b78226195301\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/CommandPalette.js\":\"a9ad7dc6e86fc431\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/HeaderItem.js\":\"97d6c068fb2397c3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/context.js\":\"43604db5dbbdc015\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/index.js\":\"eca7a4d0c454c384\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/selection.js\":\"a9715268f5500730\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/toggleStore.js\":\"45ff8272a47fe735\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/useCommandPaletteActions.js\":\"e528539301df6a6b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/ContributorBadges.js\":\"d5bd32a43acd12fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/author.js\":\"cf5d2d16d5091ac9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/codeMirrorExtensions.js\":\"0e3044474af8d0a1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/dataExtension.js\":\"8fd248779bbe5a7e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/index.js\":\"7a854062e24374a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/mentionAutocomplete.js\":\"05ca028850b22d27\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/processor.js\":\"f3508b7686424f49\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/profiles.js\":\"4c28b5f36812f893\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/queries.js\":\"2a7e67b82909c357\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/schema.js\":\"8f7e96d42d7e0b62\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5a139de440c939c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/followOrigin.js\":\"50e50ae01962ffa3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/index.js\":\"e9d66b440f6f4994\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a3edfc17038572ef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9ef16c158910a284\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/CalendarGrid.js\":\"a2ee4bcddb2c3cfe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DailyNotePicker.js\":\"a32c9e478c18ec64\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"5940f7a0a97610f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateNavDecorator.js\":\"2916af3622c5ba99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateScrubOverlay.js\":\"64810ee6aff4df19\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/HeaderItem.js\":\"13945d29da91fac6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/ReschedulePicker.js\":\"4ec401aa53688d94\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/SpreadDatesDialog.js\":\"95bca36c577bb25e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/actions.js\":\"44203aa9458d0de4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/blockDateAdapter.js\":\"a78efc0643282e70\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/calendar.js\":\"920b0f6f7ea48358\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dailyNotes.js\":\"f59d6c0598c0ed4e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dataExtension.js\":\"d324a97b6c86f399\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubActions.js\":\"74466798eeb1af1d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGesture.js\":\"8e418fb0a81ff8a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b90e89be141d4357\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7ca05befee9fe8d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/deletionGuard.js\":\"88ba2c84f7301c72\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dueQuery.js\":\"3b643905e8c109fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/index.js\":\"ab9c6690425f6e53\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/landing.js\":\"26e2ecb79e2e0ee1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/localSchema.js\":\"4b8de7f879326220\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/referenceDateAdapter.js\":\"caf23be627662f65\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/rescheduleAction.js\":\"6cb970276adedc1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/schema.js\":\"80f252dea71cc3a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadBlockDates.js\":\"3aca165b89b7668c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadDatesAction.js\":\"25924327ee8c9e3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/today.js\":\"55f6511f45852f82\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"776cb6edfd83e435\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"281465d9cdc9e8d6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/audit.js\":\"d4bfe4897d10d5f7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditAction.js\":\"8ca690cd042c11c4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditRanges.js\":\"277d4e6c67e83c21\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/diagnosticsSource.js\":\"a2f9b68bb8072ba6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/divergenceScan.js\":\"e389a506b1df72f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/index.js\":\"c777c80fee387ddc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2aeccda1a6183420\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/referencesMirror.js\":\"b5391cda53b24aef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/rowJson.js\":\"0d654a9511cdd90f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/schedule.js\":\"ffc3b0d5aa684a08\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/store.js\":\"69fe9ed0219d3b5b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/action.js\":\"c1d3868fac9fdcea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/index.js\":\"4f25ca8ed29c9f00\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/plugin.js\":\"fdf4d9c4a9b21ceb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a420576c9933c913\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/actions.js\":\"93dc725d8ea8a07f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/changeMarker.js\":\"ad2ac4929170724f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/diagnostics.js\":\"65b21319f9de586c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/fileSystemAccess.js\":\"512ca201c70f753e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/filenames.js\":\"5ad429d744dcf58a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/index.js\":\"46170b36811c21ae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/mirror.js\":\"75c73384aa7edecd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runLock.js\":\"72db79343f6f0437\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runtimeHealth.js\":\"7ed14634583dec8f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/schedule.js\":\"532b2edfb41aa94e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/store.js\":\"2152f02543594b0e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/index.js\":\"557442c86e7726ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/themes.js\":\"541e9003b788ec6d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/facet.js\":\"7f9d956cd82404f2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/useDiagnostics.js\":\"5697f63515a65482\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/dismissals.js\":\"63736d84639b61ec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/index.js\":\"35e1e1c6d4ea0974\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/status.js\":\"e7f0f30e0e47de5c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/store.js\":\"beb9ab3b42622dcc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e414c1ec2d1b8294\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fe3ec169641a5c5a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/actions.js\":\"c4aec068cdc64492\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/config.js\":\"940e60f419ae0c2d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/dataExtension.js\":\"078ab4c8da83f74b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/effect.js\":\"83b8c3a902fecae7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/index.js\":\"46c282508c98fbdf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/propertyEditorOverride.js\":\"408333912ad31712\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/useToggleTree.js\":\"278de74330e200bc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/ExtractTypeDialog.js\":\"299c7b4a84fb0d99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f501595cdecec0ae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/PropertyShapePicker.js\":\"2378c70968ef812e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/action.js\":\"21152eb51adabca4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/index.js\":\"90757f88340b4586\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/FindReplaceDialog.js\":\"829832b31c813230\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/HeaderItem.js\":\"1a7162fc7f7b7ae6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/dataExtension.js\":\"4faf4b46a352974b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/index.js\":\"c61c6c0e016411e9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/search.js\":\"2d373a07fbf8a359\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/toggleStore.js\":\"e64a2507f102793e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/LocationPropertyEditor.js\":\"083036dbe0dbd9be\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/MapView.js\":\"083a803ea4249806\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/blockTypes.js\":\"2f6c84077ff966fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/codeMirrorExtensions.js\":\"677d84365b725dc5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/createOrFindPlace.js\":\"cae00078cfc77da5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/currentLocation.js\":\"51bc747f9492b65a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/dataExtension.js\":\"f96cad34609620ba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/geoContentDecorator.js\":\"653d41c88db9336f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/googlePlacesClient.js\":\"b20c7429b4f8f9b7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/index.js\":\"553777edad39e0c0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/locationsPage.js\":\"50158afaf2c5fb72\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/mapViewport.js\":\"90f545e88cef6e3d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/pickCurrentLocation.js\":\"d9b666bd70cbbe9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeAutocomplete.js\":\"352f7fe335eb43dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeNameCollision.js\":\"adb066da7eadf12e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/properties.js\":\"d5c455b324ae0418\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/propertyEditorOverrides.js\":\"82d4612babe52b77\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/query.js\":\"f093f92b513416b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/usePlaceSearch.js\":\"608ec8aadc528209\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b287a13db402de61\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1943410a11b5e7b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a14a11b3ff9a2cb7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/config.js\":\"8548591072a6d6fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/dataExtension.js\":\"530bb62a3bf1d296\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/facet.js\":\"b6159df52325a67b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/grouping.js\":\"9ff2f8b10a92445f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/index.js\":\"90e8ef6c8d3f2140\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f6adcbbab53defb2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/query.js\":\"974e47d9a4b2dc43\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/resolveConfig.js\":\"90b4989f6eeb5dcc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"62709fe9d121bdac\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6e6e43156c7b04de\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlDocumentContent.js\":\"6606c0f765b410f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlFrame.js\":\"057ce74ddc0cc774\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/actions.js\":\"d9f4711dc5fcee6e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/blockType.js\":\"9afe1cb8dc8981ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/confirmRunScripts.js\":\"e5f0757841230821\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/dataExtension.js\":\"8c04305b0405c193\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameAnnotations.js\":\"ef37017af499f675\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameDocument.js\":\"4e29eff14b120427\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameTheme.js\":\"4e793ca44533a918\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/index.js\":\"7592aab351a7b133\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/scriptConsent.js\":\"074f1d2f1d53284f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/sourceMap.js\":\"8c720c39249793dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/useDocumentScripts.js\":\"e26fa78532d5de91\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/index.js\":\"335ac14d1bc8476e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/record.js\":\"182e4a937e91594b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/recordStore.js\":\"025129226c207381\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/responsiveness.js\":\"3a98f668910dbe9f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/schedule.js\":\"fe97ca24b50c922e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/sessionContext.js\":\"bbedbb37028f4841\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6b20d6fb7abda637\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"acb30baf41ce264a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/actions.js\":\"eed0d716cf5dfe2a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/config.js\":\"5ee722099f1e9499\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/dataExtension.js\":\"b407dbef288e1990\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/effect.js\":\"6c55064e458a4521\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/index.js\":\"8bb557528fb9fb89\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/keyCapture.js\":\"0cf9e8f01048cbae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/overrideStore.js\":\"fa9a9d86b7f64008\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"09be1067e04fdc27\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/HeaderItem.js\":\"88ad805b149f8bcd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/LeftSidebar.js\":\"473b1a2e678d24bd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/actions.js\":\"fa69cc6376a0b5a6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/facet.js\":\"5e2f69d0b9694b45\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/index.js\":\"de0d3e82cb2e5d67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/shortcuts.js\":\"69fae9f8ae479e20\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/toggleStore.js\":\"e3bfcb74e91b0ec8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/MergePicker.js\":\"b023ba38cec8343a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/index.js\":\"21ffa74e113f2e8e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/mergeAction.js\":\"6cde412df7aec7b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/strategy.js\":\"4d8b9d227e7a8963\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/Button.js\":\"427c2ca18129e6b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c1b97e51c714c2c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/defaultItems.js\":\"20349563556b9887\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/facet.js\":\"2e2d4cacc97c810c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/index.js\":\"cd7fcacea376a720\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f7118d5e19c36e7d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7ab99b81b6621d35\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"dc402791a63667d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/facet.js\":\"55e228db07594821\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/index.js\":\"976875b747cf1d7b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ca985e54d936fa99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6f5dbc43a89d9bc6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/contextMenuItem.js\":\"48cac5a602ae5959\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/index.js\":\"f9c6b8502a008e1d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveAction.js\":\"bf75d27effe41992\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveBlocks.js\":\"76a730935c16e506\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/selectionAfterMove.js\":\"7c6d72783a5c1f9c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/TutorialBanner.js\":\"3d9dee32ccde63bd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/action.js\":\"2be96a4ebf880cbd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/bannerDismissal.js\":\"61e4510e319c3be9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/documents/cheatSheet.js\":\"8249d5cf36e17396\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/index.js\":\"5248150091181073\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/keys.js\":\"dce0e1e354d864b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/landing.js\":\"7e4f26f7f08d4edd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/outline.js\":\"6d34d1a078d00e1e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/seed.js\":\"2f031f9df7786ee0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a07222d0ee17290d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/analyze.js\":\"7ae22951cafce749\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/diagnosticsSource.js\":\"7e49c2a9ca585fc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/index.js\":\"73ceba593834f1f5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/load.js\":\"09a0f8b8ccc3cc1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/monitorRun.js\":\"d6a88fa2b296478d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/schedule.js\":\"687bcec96f181908\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/series.js\":\"2ee779548832b171\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/store.js\":\"4989e8f77f2f4a26\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/trendAction.js\":\"94d7188cf7626174\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/verdict.js\":\"378d07804f2069c2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/clickToEditAction.js\":\"fd7cab2b657964f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/index.js\":\"bc2635875ec5306f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/interactions.js\":\"e28b04f5d130d869\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5fdbb908bc037ccc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGate.js\":\"8bbb22c0e7b3d416\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGateDialog.js\":\"66e4c2a44635533b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/action.js\":\"b31f621dc4fd2fe7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/index.js\":\"a9c6bbf8fa46742a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/localRunMessage.js\":\"bcf62810a9151b2b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/plugin.js\":\"9b2e70759e090bad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/progressReport.js\":\"6b4c841bf2ab8bb4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/sweepProgress.js\":\"4ea0e2429f46733b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/FieldRowRenderer.js\":\"f0862ea3e84cc55b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/ValueRowRenderer.js\":\"ad5202df20f1322e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/actions.js\":\"a838bd47b50d2632\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/autocomplete.js\":\"6b93dec4e637e1b8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/fieldRow.js\":\"91ac94da4f571af0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/index.js\":\"bc216a36b9ff1eab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/referenceWarning.js\":\"fe8f54c3ea4152fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueAutocomplete.js\":\"e957c67e7f8655a1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueSchema.js\":\"8d21384d571e589b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/HeaderItem.js\":\"bcc55dbc71b3306d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/QuickFind.js\":\"b5b57d4786ef03d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/index.js\":\"da7ec4a20419c72b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/recents.js\":\"2d40290ef9df7834\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/resultItems.js\":\"8dfde9b76312836a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/selection.js\":\"dc206701bed252fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/toggleStore.js\":\"2dcf49f840e8772e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/HeaderItem.js\":\"6dbef8c5e998602f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/RecentsPageBlockRenderer.js\":\"394d0c6158b82f9a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/grouping.js\":\"50480f6d0e997fda\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/index.js\":\"f00b439bcb942036\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/target.js\":\"c5cca4f29d99a19a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/codeMirrorExtensions.js\":\"1d39a7e5f648d743\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/contentPrefill.js\":\"9f1e0298ec11f9cf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/dataExtension.js\":\"a3a2a12955a6032c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/index.js\":\"aaf5f0fefd741601\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"72741056065bf12b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/invalidation.js\":\"945d69ead1ba8846\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/localSchema.js\":\"cec91745058c01bc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/index.js\":\"f5d32192fca5c851\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"53160d5ed59263bf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/index.js\":\"9dbd556138955220\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/referenceNode.js\":\"6050e3863c4e9475\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ef7fd26b5dffae21\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5e68cdd6b684bd45\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/index.js\":\"2b05a979a097e6c8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7cc211edd8450d4d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dc90cebd6a4a0d6a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/mergeRetargetProcessor.js\":\"98f7deccb0484355\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/parseFence.js\":\"7a797d0bd3710765\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceParser.js\":\"0aed6623b0313781\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceProjection.js\":\"7d7ff076b31741c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referencesProcessor.js\":\"4d313f2a41fceaac\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/renameProcessor.js\":\"4f0f64fb1597e2ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/spanReplacement.js\":\"1989ca7ada338792\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/htmlToOutline.js\":\"b7b1e0cdafcf48b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/index.js\":\"92cffd38353e8e14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ec20a6d0efbca076\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/pasteDecision.js\":\"e0ccc4ca251a407e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/action.js\":\"66d29ac3285c4016\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/blockIds.js\":\"26e60314907a16b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/content.js\":\"8a1ea6e1dbc47380\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/effect.js\":\"626b771e8964717a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/ids.js\":\"c87ea68daf22b191\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/import.js\":\"3e563a899d30b95c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/index.js\":\"b14b9c7ad4befaf1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plan.js\":\"474f9e9776690fdd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plugin.js\":\"64c554870dc16c93\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/promotion.js\":\"cd3d4e9f34f93a25\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/properties.js\":\"b4cb711e5dcc6679\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/references.js\":\"30bf5e2823d8368f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/report.js\":\"37eafa556a622b7a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/roamMemo.js\":\"a0d377b2dfeaa0ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/runtime.js\":\"99f1cf3cd4b38735\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/schemaReconciliation.js\":\"1eaa204a1432a138\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/srsMarkers.js\":\"8cd6ca56aa889e07\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/todo.js\":\"304dbe7778a1c7b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/typeCandidates.js\":\"3e78a0d724bd3286\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/types.js\":\"6f7171ac52b37a5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/index.js\":\"b419fa3fe533860b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/store.js\":\"1cda30425821752a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/HeaderItem.js\":\"0958ea176eb3c19f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"58c577b594d60e78\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/index.js\":\"c7a2356cbc11d282\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/model.js\":\"4abd7b40d7123382\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/toggleStore.js\":\"0cd78eca370b826c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/useKeyInspector.js\":\"6f73a7ccf17c6c35\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9b0f8e7cf11a8bb3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/ShellDecorator.js\":\"2d61b01776e65494\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/actions.js\":\"b0b4510f7d64cd12\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/exclusionsFacet.js\":\"21f3be66eea067ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/index.js\":\"825d15be2cce0ce1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/shell.js\":\"76f4c0a7a726d37a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/surface.js\":\"9db503955dbe77db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/walker.js\":\"92925242a5006115\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4feafe92d584e78e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/dataExtension.js\":\"7df38e8c8bec47a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/index.js\":\"2b2e012ab063b4c5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/indicator.js\":\"4f35c9475e41fc53\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/moveSrsState.js\":\"55941df6fd7bd9d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"af6178bc5d0e46a8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/scheduler.js\":\"d554133fa3f2d5d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/schema.js\":\"302c7ff7cb539f31\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"efa7550dcf8427e5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsClipboard.js\":\"d8beb859d44b8f4d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"59b1dd5e680f2cca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a920294fe27508c4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DeckPicker.js\":\"2c78bb26a93cdf6c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewControls.js\":\"a8ad14805d36b2fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a8d1c47e8502f0a3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewSession.js\":\"ea5ee3242e7ac7d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/actions.js\":\"1d517a36a4c1ce67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/archive.js\":\"5370c59b1d3bd80e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dataExtension.js\":\"bb2dac84be2c9e18\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/deck.js\":\"838682ff5317fd03\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dueQuery.js\":\"ad1cdcb28b980b55\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/gradeDecision.js\":\"09169707191cb42c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/index.js\":\"a90cd4c86aecc741\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/keyHints.js\":\"e8696ab575501a37\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewCardLayout.js\":\"a1b8bca33adf121c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewProgress.js\":\"ec38711f710d59b0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/schema.js\":\"40aa80db4cc2fc40\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/useDueCards.js\":\"dc1fc332019f9916\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/index.js\":\"586272986b553894\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/record.js\":\"bbbb1f2bbb8f1b5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/index.js\":\"02127591d2b86456\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/persistenceStatus.js\":\"7b6036ea998985a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/requestAction.js\":\"6997c226095af985\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/TypeChipsDecorator.js\":\"4aa2452f3bbee8a3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/codeMirrorExtensions.js\":\"8fc2ab27e11a8cb6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/index.js\":\"0ae373af6e5f868e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/typeAutocomplete.js\":\"d916770e9ae6696b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1429d03ed301c593\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/actions.js\":\"6bb8c6b0657dcd3e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/anchor.js\":\"9d922e9469112bb2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/events.js\":\"299ec2f3fb95396f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/gestureActions.js\":\"6deeba0113072547\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/index.js\":\"19211f8f9dc3345a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"93ba9be99c79416a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/collect.js\":\"98a3313d7a761a0b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/index.js\":\"7bd04d67ebb97c70\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/record.js\":\"5fb9c14384cf5a69\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/RejectionDialog.js\":\"3f0861af6a2b155b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0d2b15fed9b74372\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/index.js\":\"a9f50a34bab862fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/model.js\":\"4944e25b03671a45\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/queueCounts.js\":\"3f947ab1bbd7e4a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rejectedHelpers.js\":\"03f7cc4c81a64ade\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rematerializeAction.js\":\"c08624ea899e5e9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/useHysteresis.js\":\"c438c4f849724774\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/effect.js\":\"73e266c7f6280b5d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/index.js\":\"d2474e3892957ee2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/theme.js\":\"d2f1bbb14aa24f39\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/actions.js\":\"b86b57ae35e273db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/dataExtension.js\":\"ab5a421aaee509fb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/index.js\":\"f49c245707505192\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/schema.js\":\"d97fa14c2047d4b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5a01d4a24b4346c7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/actions.js\":\"5fb80ff5dc7de1dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/defaultItems.js\":\"9c5091e0a4b9150e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/facet.js\":\"39c715539b950b94\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/holdRecognizer.js\":\"d37cb78872ecaaa6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/index.js\":\"bac026223617d898\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/UpdateIndicator.js\":\"2220b8bdbae4e45d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/index.js\":\"53a758249e92326c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/loadTimes.js\":\"ecc10437e330f738\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoNotesRenderer.js\":\"7e7855f327d777b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoPlayerRenderer.js\":\"56d43ae16ecd2ea0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoTimeStamp.js\":\"1a09c8d5e200639a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/actions.js\":\"e682b0ba73fcc208\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/index.js\":\"ef9cfc2522a695ff\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/markdown.js\":\"38273d3ea5d91811\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/notes.js\":\"6efd01eb5eb5f65e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/registry.js\":\"b8852520296d6398\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/remark-timestamps.js\":\"306e27517f4490fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/view.js\":\"46f04480820ea114\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/LinkHints.js\":\"e5e09486bb498a94\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/index.js\":\"d6a3e6dc2879d342\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/model.js\":\"c77eaf0a86bf3fda\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/settings.js\":\"2a8f2e92062c5917\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/actions.js\":\"b0348dd7ff2aceaa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/index.js\":\"922c926ff6d7efd3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/interactions.js\":\"a9a0c9757c9406e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/workspace-header/index.js\":\"fb372dc478799884\",\"/knowledge-medium/pr-preview/pr-1792/src/registerServiceWorker.js\":\"bebc0233be23783e\",\"/knowledge-medium/pr-preview/pr-1792/src/requestPersistentStorage.js\":\"244b1234d079f622\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authRequestDeadline.js\":\"4df2d289bb0e821a\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authStorage.js\":\"9f59462c02d10194\",\"/knowledge-medium/pr-preview/pr-1792/src/services/powersync.js\":\"ec71d2bbe14ba27b\",\"/knowledge-medium/pr-preview/pr-1792/src/services/supabase.js\":\"0619cf0bc47e85b1\",\"/knowledge-medium/pr-preview/pr-1792/src/services/uploadErrorClassifier.js\":\"27b6d4e75db87228\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/ActiveContexts.js\":\"c9632249a017f875\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/HotkeyReconciler.js\":\"657e03dcd585f8a0\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/WipeLocalDataDialog.js\":\"bd8047403580982c\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionDispatch.js\":\"0499da708c775599\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionRefItems.js\":\"09d0111909e2e0a3\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/applyKeybindingOverrides.js\":\"17f5ece25e91214d\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/blockActions.js\":\"e200710be62d5d61\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/canonicalizeChord.js\":\"a26381cd5078f213\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultContexts.js\":\"c0d297ae47ecf171\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultShortcuts.js\":\"94497f7556b33e03\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/effectiveActions.js\":\"869affc2be78411b\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureAction.js\":\"84705068c9415ac0\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureBinding.js\":\"8b9d79b252807026\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/holdRegistry.js\":\"b1990c9248a95225\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingConflicts.js\":\"b2c1291a6cc19aee\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingOverrides.js\":\"aa70d709986da3c6\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/pointerAction.js\":\"2e7fad3428c63254\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/resolve.js\":\"1a3d238afc89a7f0\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/runAction.js\":\"1c9d6ba6c8e4e71d\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/sequenceMatcher.js\":\"ddbbbd2e72414a91\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/types.js\":\"a3dabe87156bd156\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionContext.js\":\"8fe6d36f2288cc2e\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionDiscovery.js\":\"2955577e712a0b2b\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/utils.js\":\"18bddadbe6c7fedd\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/bootStore.js\":\"68b8587c186fdd38\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/previewDatabases.js\":\"0f5f01afb551b534\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/byteTransform.js\":\"f8f263679a4b8f86\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/attachmentCleaner.js\":\"0fb3687030f84634\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/attachmentParts.js\":\"487a0d42dccceae1\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleParts.js\":\"d6d6d5690fde1fda\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleRecord.js\":\"277a6ecad9c19830\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/manifest.js\":\"1ad5d3c04d694645\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/takeBundle.js\":\"5561440dbc941f0b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/verifyBundle.js\":\"b6e7dee7e95ae813\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/cleaningStage.js\":\"984c4620a120c49e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionKey.js\":\"e6de0672291354a2\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionServer.js\":\"87bca5288b84521c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flip.js\":\"63fa9581b7218d41\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flipAttempts.js\":\"8e839b5da08d93b9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/pages.js\":\"48898b94eadd2176\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/preflight.js\":\"d98dcd58921f16df\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/reseal.js\":\"59626b093c502d5f\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runConversion.js\":\"f6af74d83d077472\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runLock.js\":\"eb1347cfe47f1969\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealing.js\":\"912e2382f18ac041\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealingStage.js\":\"460a66c76cd20fd7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/stage.js\":\"33888b44e6d03d5b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/verifyReseal.js\":\"dc49a97023295740\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aad.js\":\"13386974907970a2\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aead.js\":\"5718e9475dbc9f42\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base32.js\":\"ae2f7998cc93aced\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base64url.js\":\"4e5c7069561a2e86\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/binaryEnvelope.js\":\"d4ec003bec802b38\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/byteAead.js\":\"b1af2f937a587b37\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/canary.js\":\"95e29a7cfdaae69a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentHash.js\":\"51c715d5781fafd4\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentKey.js\":\"1475d578a2dbbd9e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/derivedIdNamespace.js\":\"a6bf8a6296c8db5c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/envelope.js\":\"2f03bfe5a2acd887\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/hex.js\":\"19d39c9e65a96289\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/sha256Hex.js\":\"d13ff639afb1914b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/workspaceKey.js\":\"cc6ac600aaaf6a23\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/conversionState.js\":\"1ce9ec65b98b863b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3764544a130716a5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/pastedKey.js\":\"689fb965e182fbe4\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"78cbf716c82afc26\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2dc7592660294c2d\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/keyStore.js\":\"0caba207709155da\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/mintWorkspaceKey.js\":\"63994f8aac63c62e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/modePin.js\":\"89f11d7ad776ec78\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/openWorkspaceKeys.js\":\"d0a63387827d842a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolveWorkspaceEntry.js\":\"857c759ed6e258f6\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolver.js\":\"e16fd42296c0e979\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/workspaceAccess.js\":\"ae7eefe8016bee6c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/transform.js\":\"1aba75457457e780\",\"/knowledge-medium/pr-preview/pr-1792/src/themeBootDefaults.js\":\"39930da8aaf87692\",\"/knowledge-medium/pr-preview/pr-1792/src/types.js\":\"a91a0c6f7ad42abe\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/ClientLocalSettings.js\":\"31d5942eb27e04bb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/abortableSleep.js\":\"a7e760461395d383\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/array.js\":\"65dbadc3fb4d5594\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/backlinkAutocomplete.js\":\"d0d2e6c4fc26a117\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockCrumbs.js\":\"bc3e4b3001fcdc12\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockrefAutocomplete.js\":\"c77f7b545f053908\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/cadencedIdleJob.js\":\"1e2f217e0e925ee5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/callbackSet.js\":\"b8735cfe609153af\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/clientId.js\":\"f8ef004ea0fec0a4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirror.js\":\"7e784be510e6354b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirrorCompletion.js\":\"74ddaea96b5beb08\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/copy.js\":\"8da7a036aabf7bef\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dailyPage.js\":\"8a79e4e0417f1502\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensics.js\":\"9e72c1f79c51ae94\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensicsHooks.js\":\"5702b757063e3699\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/deleteBlockThroughUi.js\":\"cf44458f3597bc62\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dialogs.js\":\"42d6b1e461d89d65\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dom.js\":\"352ab7f2534c3f79\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/downloadBlob.js\":\"3c964b8e4a01a65d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/exportSqliteDb.js\":\"180de188c68d9a64\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fileSystemAccess.js\":\"45beee7c596bf01b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/flipSlide.js\":\"539a46cdd61e41bc\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fnv1a.js\":\"4f3eeb654fab0fc4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/formatBytes.js\":\"a02877d7b1b38ce1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fuzzyRank.js\":\"1f45bba66e9c0ca9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idbKeyedStore.js\":\"49714cd5f399b1d3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idleCallbackPolyfill.js\":\"7abdc70203129b1c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardAwareScroll.js\":\"26a9d4f3f7812647\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardViewport.js\":\"2e8f19b40f6d4602\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/lastWorkspace.js\":\"c9dfc9e4bc87c3ac\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutColumns.js\":\"4b2d94e57beef9fe\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionDom.js\":\"8700482e9c9ac465\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionId.js\":\"c2b769871a9ecc91\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkClickGestures.js\":\"b43838ca287b5c58\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkTargetAutocomplete.js\":\"a8d3c67286dace0d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbCorruption.js\":\"924a0576256214b5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbRecovery.js\":\"fc940e85df0829cf\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/markdownParser.js\":\"aa55a9d7625d7810\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/memoize.js\":\"16b96191701429ee\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameFieldCommit.js\":\"0bd93adb58debdf0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameList.js\":\"0cdbbdc75edca3bf\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/navigation.js\":\"a7e8c02ed67c4867\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/omnilinerNamespace.js\":\"f8a9561c543ad666\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/opfsPageScan.js\":\"dc0b4798be6eab9c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelClearance.js\":\"476f19863139bf42\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelHistory.js\":\"d74e7e02763caf37\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLanes.js\":\"f39802ac434afb92\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLayoutProjection.js\":\"874f52b314f62874\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelScrollAnchor.js\":\"a0800725766d6c50\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelUrlFlags.js\":\"0d5ffb6bdf245671\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/platform.js\":\"afb9704c86e54d7b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/pluralize.js\":\"9da3f48e43656230\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyCreation.js\":\"87e3d19465e8177a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyNavigation.js\":\"e4559a7233ea22b2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyValueContext.js\":\"7036c8b77c61b972\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/react.js\":\"c92b97a422827327\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeDate.js\":\"8f2771b552994ad0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeTime.js\":\"30e8b7ad27e0f8b9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/renderScope.js\":\"d132288c2ba8360a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/resolvedThenable.js\":\"8ef0870226165424\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/routing.js\":\"63e74573f679bde3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/safeMode.js\":\"93864e452c71af44\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/scheduleIdle.js\":\"10eb8c395deecf62\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/screenWakeLock.js\":\"19797569664985b4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/selection.js\":\"cb7b20cef24e8d43\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/softKeyboardGrab.js\":\"ae5a1c93e1e3b0e3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/startupTimeline.js\":\"0cabba2d3e4c51ec\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/state.js\":\"f3acfb9bf2d91f98\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/string.js\":\"55c9e64040cbd8cb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/surfaceZoom.js\":\"abf3cc248fc30640\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/time.js\":\"71e43b951d5bdfdc\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toast.js\":\"54d416546f0a2a1d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toggleStore.js\":\"c33902701fa382d3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/untilStopped.js\":\"bab4cd6a019575cd\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/userActivity.js\":\"42dcfc4672add981\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewTransition.js\":\"bd334b38377aa14f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewport.js\":\"0f6d382a72950264\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/webLock.js\":\"4a27bec521683d0c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceRecovery.js\":\"f7512f75e0f27b98\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceSnapshotStore.js\":\"9c515a8587d8bc9e\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-compiler-runtime.js\":\"26d0983471b5c8e7\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-client.js\":\"16c031d3815c8313\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server-edge.js\":\"512cc8db209d1c90\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server.js\":\"bb6d54fad4e624a7\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static-edge.js\":\"13b46d298c27efcf\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static.js\":\"b3196ba86e65238f\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-test-utils.js\":\"4ea76f84a4318027\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom.js\":\"f6bef112d02074be\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-runtime.js\":\"d8c47c48d68ce8f4\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react.js\":\"f6872fa97ede0234\",\"/knowledge-medium/pr-preview/pr-1792/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
