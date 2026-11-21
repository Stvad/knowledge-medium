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
		buildId: "79390f9a5d14-f957bf73",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/\":\"c92cd81dbfebbf08\",\"/knowledge-medium/pr-preview/pr-1792/index.html\":\"c92cd81dbfebbf08\",\"/knowledge-medium/pr-preview/pr-1792/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1792/assets/FacadeVFS-DK_m4b1Y.js\":\"4bb791addfac3c12\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSCoopSyncVFS-Zqtg_HSC.js\":\"592db766baace772\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSWriteAheadVFS-BpV4uArO.js\":\"b6e82fc411767c60\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-C5JwTb57.js\":\"2036114e522e7b90\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-D2n_Bu4X.js\":\"273a25129a94281e\",\"/knowledge-medium/pr-preview/pr-1792/assets/worker-CNaCKKyd.js\":\"b0b355ab45606872\",\"/knowledge-medium/pr-preview/pr-1792/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1792/chunks/app-HXWsnutT.js\":\"9507c5a9cf70eeee\",\"/knowledge-medium/pr-preview/pr-1792/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1792/index.js\":\"4273daf9dc22ef7a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1792/assets/AccessHandlePoolVFS-DfigPRIs.js\":\"d32bc6e08a10b20a\",\"/knowledge-medium/pr-preview/pr-1792/assets/IDBBatchAtomicVFS-CdFFIkSz.js\":\"e115a0a7b12a5a6d\",\"/knowledge-medium/pr-preview/pr-1792/assets/MemoryVFS-CyGGf8x8.js\":\"0f96075ab673944f\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-CT_C0yjA.js\":\"be4b1aa564c15771\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-BWiDfXtw.js\":\"e49beb7cafd65848\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1792/chunks/AccessHandlePoolVFS-DSEX8SZ0.js\":\"9ed88ddda2978cbd\",\"/knowledge-medium/pr-preview/pr-1792/chunks/FacadeVFS-CooPm8zP.js\":\"212dc2bd630a4fa6\",\"/knowledge-medium/pr-preview/pr-1792/chunks/IDBBatchAtomicVFS-CUw7kaIb.js\":\"14da7c303f0ab627\",\"/knowledge-medium/pr-preview/pr-1792/chunks/MemoryVFS-KSPnk2kf.js\":\"6ac8c2b06b7bf38e\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSCoopSyncVFS-CxFrk0-E.js\":\"e40b6a6626221777\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSWriteAheadVFS-CXeNVM8Q.js\":\"852a58f573dd42b6\",\"/knowledge-medium/pr-preview/pr-1792/chunks/Preview-Co_inn5p.js\":\"46b30d39911a2808\",\"/knowledge-medium/pr-preview/pr-1792/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1792/chunks/card-BAfWsnKK.js\":\"3152331c8adadc64\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-DLmd2XH_.js\":\"536ef7aaa15d7973\",\"/knowledge-medium/pr-preview/pr-1792/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-DX-cJLLu.js\":\"59201cd2f0953ad9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-async-BFPgErhd.js\":\"ff80946b27b0e1f3\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-ARZaxr3L.js\":\"061272ef9465a427\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-B3P_K1tS.js\":\"4f57d1debe2a5542\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-B7LKuFpx.js\":\"29d6c0b979526deb\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-B8AQt4V0.js\":\"cf7c5e7cbc52de0a\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-Crj8Qh54.js\":\"7329c55898dc8442\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-DRxM_Q91.js\":\"5e3943d30db08273\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-Dnce-sxr.js\":\"3e9e0101a00ce3ab\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-H56etJp-.js\":\"286ff42353b4b788\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server-legacy.browser.production-Bg5mDk1F.js\":\"81a3c24efadea2ea\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.browser.production-BuXWRmmB.js\":\"1eb985fbd7233a6a\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.edge.production-CrSYSuMg.js\":\"3ac93c40e53f701b\",\"/knowledge-medium/pr-preview/pr-1792/chunks/server.browser-BtyYG3Ud.js\":\"c26a820f9d2b4867\",\"/knowledge-medium/pr-preview/pr-1792/chunks/textarea-D4Bmvmrd.js\":\"9a3d81fd79ca46c8\",\"/knowledge-medium/pr-preview/pr-1792/chunks/ui-DaUG3nSh.js\":\"02f224c9db6838ca\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-BiJyU6tu.js\":\"3488f6117774d257\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-async-CLHlzpnB.js\":\"3dbb1e830709a816\",\"/knowledge-medium/pr-preview/pr-1792/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1792/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/src/App.js\":\"c206b423525f05fa\",\"/knowledge-medium/pr-preview/pr-1792/src/appUpdate.js\":\"590f4a809950f51b\",\"/knowledge-medium/pr-preview/pr-1792/src/appVersion.js\":\"206b6b4a6f8481ab\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/initialLayout.js\":\"e75c43b0e04bfc49\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/openWorkspaceData.js\":\"ea46cdfbe3c34ca9\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/resolveWorkspace.js\":\"2adcfab086103abb\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/workspaceBootstrap.js\":\"e4f790ce0a3b3466\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockComponent.js\":\"e822e452ddabb581\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockCrumbs.js\":\"80907b424acb38c9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockEditor.js\":\"3f6194d82fa0d26f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockLoadingPlaceholder.js\":\"818fa77fbf887a22\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockProperties.js\":\"a572840e2ae8441b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockSearchPicker.js\":\"19a8b5bc92fb7fa2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ConfirmBulkDeleteDialog.js\":\"9d37b2227d90b97b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DividerHandle.js\":\"f26c4c34d3c82077\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DraftEditor.js\":\"44385ff78d52d60a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/GutterPill.js\":\"acd0486f8592b554\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Header.js\":\"293c78ce6a93a3ae\",\"/knowledge-medium/pr-preview/pr-1792/src/components/LazyBlockComponent.js\":\"c2ba5deff607cd38\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Login.js\":\"8b1220415d2e1b7e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ZoomableSurface.js\":\"27f2dfe12110c63e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/editModeKeepalive.js\":\"901cf4d44c3f46bd\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4dcf0a490562f065\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fa232a9d585e0926\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefPropertyEditor.js\":\"75b2e83518cb0993\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefTargetTypePicker.js\":\"5db7f5d080f9df93\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/SelectPropertyEditor.js\":\"c8f37858f2f15585\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/TypesPropertyEditor.js\":\"8c79649ea5c6a262\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/defaults.js\":\"c4971d3d030ca455\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/kernelValuePresets.js\":\"5003fae2c2e825d8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/selectablePresets.js\":\"b1fb00980478311c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/typesPropertyUi.js\":\"dc05aefb542dd7e9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/AddPropertyForm.js\":\"58065a67b9e02331\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyPicker.js\":\"07f7ab0d3ebc9b4d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyRow.js\":\"d05e126cd9c412a4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/Rows.js\":\"0c273aaf0fbd5cc8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/actions.js\":\"25bbc0aa7581dffe\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/declarationOnly.js\":\"432f11d5df722472\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/layout.js\":\"4f20c94415f5aa83\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/model.js\":\"58ba49196de506fb\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapeUi.js\":\"32080d527c07e483\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapes.js\":\"6e587e0c1c274158\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/usePropertyEditingActivation.js\":\"512a44faf248f820\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/visibility.js\":\"9e89e96026c74916\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanelSections.js\":\"ca4fc3f0bc1f7d5f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockEmbed.js\":\"a4f07833bca6d6a7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockLink.js\":\"da043e3c8fd1d3dd\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockRef.js\":\"ca6e79f1984d240f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/ReferenceLink.js\":\"19a38a1ebcc10dae\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuard.js\":\"968595169decd3a8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuardContext.js\":\"fd2f366608e18f0d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/linkInteraction.js\":\"f8f00770f066fc80\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/referenceLayout.js\":\"8ef5a2deae242661\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/useBlockRefAncestors.js\":\"d4bd8940767afde8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockGutter.js\":\"9184f6d5604d0862\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockInfoDialog.js\":\"3a6539ebacefcf2f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockTypeBlockRenderer.js\":\"b55fc31814f5946e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BulletHoverCard.js\":\"4c93ea7147fa1104\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorContentRenderer.js\":\"fd7410b0b9a902f3\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"580e58f11fa1af67\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ColumnResizeHandles.js\":\"36ba3bd489b3e8ec\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"550d4743ac973f1f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/DefaultBlockRenderer.js\":\"bff42d71967d844b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/LayoutRenderer.js\":\"3f357146c379c024\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MarkdownContentRenderer.js\":\"d75676c129bfb3c4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MissingDataRenderer.js\":\"d04739ecd1f66d5d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PanelRenderer.js\":\"ac5522c5d1c1c8f3\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PropertySchemaBlockRenderer.js\":\"dc0189a21b669c23\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/TopLevelRenderer.js\":\"190c2a7aee91a1d2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockGutterMode.js\":\"301988a9cfb5b3ed\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockTitleText.js\":\"88ab092fda1da7ed\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/fieldCreationKeydown.js\":\"8bad2f86c1c035f0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/layoutRootContext.js\":\"56d860fbd2c45709\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/TypeChip.js\":\"45aac7cf988ba481\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/chipStyle.js\":\"4c7b660bd026db35\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/anchored-floating.js\":\"a43e93bec6b4926a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/button.js\":\"15d5b39521439446\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/card.js\":\"a51b6b89a734ceef\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/checkbox.js\":\"540cfd76d1e4d16f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/collapsible.js\":\"9a12671e8ef20f92\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/command.js\":\"ed39f1870c346475\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/context-menu.js\":\"c61b95afd9e2a71f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dialog.js\":\"d741627ec0043b7f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dropdown-menu.js\":\"b5567cb723e11407\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/floating-listbox.js\":\"cd8f8813c9796968\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/index.js\":\"a8570594e82a3efe\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/input.js\":\"275a91ab40688b52\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/kbd.js\":\"51fcd8d22b442858\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/label.js\":\"fc3e86b3ad06c382\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/textarea.js\":\"b36be62396da4735\",\"/knowledge-medium/pr-preview/pr-1792/src/components/useEditModeYieldKeepalive.js\":\"6c3fa03073f1f6e0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/BootFallback.js\":\"d756c184d6cd9bfd\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/FocusedRowLazyMount.js\":\"b0ce3034f0ecbca4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LazyViewportMount.js\":\"e0602eb1ad8af007\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LocalDbCorruptionFallback.js\":\"119fe462c3e7fcb2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/error.js\":\"a21e2bb5cfa45771\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/lazyMountRegistry.js\":\"0d3c30816ee1ef55\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/suspense.js\":\"8aa278143df74972\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/CreateWorkspaceDialog.js\":\"02923b1474f46302\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/PendingInvitations.js\":\"aefa28c4ebf570ce\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/SyncProgress.js\":\"78d4b31c29245dc8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/UnlockProgress.js\":\"34d32ac7a561ce2b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceKeyGate.js\":\"ea1464e074b3a886\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSettingsDialog.js\":\"6791fa7939ad0469\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSwitcher.js\":\"f7f326d7429a1747\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSyncGate.js\":\"0c54a158b8bbdda6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlow.js\":\"7eeeaadd57e84efd\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlowHost.js\":\"b50227e6fc18e1b4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/EncryptionSection.js\":\"f7743334a287c5db\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/attachmentPrompts.js\":\"fb7ac1ecb0d893da\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/bundleFolderPrompts.js\":\"491aee8c186f5b56\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowDeps.js\":\"6d8668cb6bbf2e0a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowStore.js\":\"3e57f8cf1cd73e85\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/flowUi.js\":\"ef79fe3adb7344f7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/useConversionRun.js\":\"e19fb954e213079a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/keyUi.js\":\"935665d76a846f9d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnKeyLoss.js\":\"ff81bdb63556dfa5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnServerE2ee.js\":\"0a34cc5dde1ee8b8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/workspaceUnlocked.js\":\"7672950e2afd98ea\",\"/knowledge-medium/pr-preview/pr-1792/src/context/backgroundSubtree.js\":\"c2f34637864086ca\",\"/knowledge-medium/pr-preview/pr-1792/src/context/block.js\":\"fe5bf6460b20b724\",\"/knowledge-medium/pr-preview/pr-1792/src/context/layoutWsContext.js\":\"69858dbe06ee0b57\",\"/knowledge-medium/pr-preview/pr-1792/src/context/propertyDisplay.js\":\"38139ec8e3fe5e2a\",\"/knowledge-medium/pr-preview/pr-1792/src/context/repo.js\":\"1f647ce5c66506ec\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasClaim.js\":\"3af3fa6553a2fc25\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasSeatNamespace.js\":\"67a39c1569ee640c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockData.js\":\"e63fcd94a58a6d9a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockType.js\":\"be19ff59a7ab544d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/changeScope.js\":\"a22a98eb11f4ebc9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/codecs.js\":\"b2d89264aa9f0d12\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/derivedData.js\":\"3cefc05d492fc977\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/errors.js\":\"daa95642df79dbe3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/events.js\":\"e985d0e4b385cc6c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/handle.js\":\"f03832c1f8bf970e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/index.js\":\"9729ded8525e3780\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/mutator.js\":\"146f90a56a1a08dd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/processor.js\":\"ea709aaf13041776\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/propertySchema.js\":\"6c1b7967fc8b24c3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/query.js\":\"b972057795bb1e7a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/sameTxProcessor.js\":\"a113992b45e20f69\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/schema.js\":\"f03832c1f8bf970e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/tx.js\":\"f03832c1f8bf970e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/typedBlockQuery.js\":\"ab1e35a488933512\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/user.js\":\"1dc710002c4ee649\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresetCore.js\":\"c9e803507babfe99\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresets.js\":\"efefef5ef21a01d5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/attachmentCleanerIOVerb.js\":\"6d3721b1ebd4457d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/block.js\":\"2a6a58c2e6a561fa\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockCache.js\":\"c456453285e33744\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockId.js\":\"1a9fd546c4eb0640\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockLiveness.js\":\"94a4b69a6f6b45f9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockMerge.js\":\"095a89b4b16cec03\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockSchema.js\":\"a91fb6748f244751\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockTypes.js\":\"1daa923ce5a69929\",\"/knowledge-medium/pr-preview/pr-1792/src/data/clientContext.js\":\"7be47f47fcf5c09a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/dbFileSiblings.js\":\"889c28bf8384ba51\",\"/knowledge-medium/pr-preview/pr-1792/src/data/definitionSeeds.js\":\"c07e72acafef300f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/derivedIds.js\":\"9d8daf5d7c2d3575\",\"/knowledge-medium/pr-preview/pr-1792/src/data/drawnSubtree.js\":\"9c4b6f4fd7965e94\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facetBridge.js\":\"d45825732f8ff266\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facets.js\":\"5968cac4a215ef90\",\"/knowledge-medium/pr-preview/pr-1792/src/data/globalState.js\":\"7ae99fbb6429dade\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/aliasClaimRederiveProcessor.js\":\"3ce3acdf378f24d7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/ancestorBatch.js\":\"53964560c3bb53a0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/blockTypeTypeifyProcessor.js\":\"5a77ad70b63dd1dd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/clientSchema.js\":\"e605e04426ad340d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/commitPipeline.js\":\"a82f8e37f748a168\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/devAssertions.js\":\"3769c9bdea7483dc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/firstSync.js\":\"8d566958f6c79206\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/freshInitialLoad.js\":\"fee6c90a36e6d244\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/graphBackfillClaim.js\":\"5e8d02268f9a7e17\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/handleStore.js\":\"b523b5690adfec7c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/idleMarkerJobs.js\":\"12ebd049af10ff4f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initialDownload.js\":\"fdea34094b2a3314\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initializeClientDatabase.js\":\"504475174deddedb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/jsonCanonical.js\":\"98c87acfd2e8558b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelInvalidation.js\":\"99f1b392787a4662\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelProcessors.js\":\"54d6fb4332d8a34a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelQueries.js\":\"2afb614ff25490c9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/mergeTypeMembershipProcessor.js\":\"4b93ed2e7db1f6fc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/normalizeReferencesProcessor.js\":\"6ca3c7d0444aa223\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/poolInstrumentation.js\":\"837cc37a5977d73d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/processorRunner.js\":\"73d41d62042823f5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyCellBackfill.js\":\"8695af477047d16a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildMint.js\":\"943e5b4b08f074a8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildrenProcessor.js\":\"6756321af6453c5c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6cf98f9bc361ef67\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionSynthesis.js\":\"69b93c0bd9097864\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyKeyScan.js\":\"df39d29dec10f76d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertySchemaResolution.js\":\"11b3370a3f439130\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/raiseProtocol.js\":\"5c4df0cb5ed085d0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/readBatch.js\":\"2bfa8cf4fbc75b08\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/refProjection.js\":\"2ba0a93facf865fc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetLookups.js\":\"ee89c1d8ed14c622\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetProcessor.js\":\"0eeeb665b7932385\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/replayMerge.js\":\"e278c676b2f0d10d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/sqlBinds.js\":\"4c339c649ea9bd47\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1d2629024eefb7b6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/arrivalProcessors.js\":\"658a88379deaaf7b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/invalidate.js\":\"99d683c3ac738906\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/materialize.js\":\"1232cc287d3327ce\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/observer.js\":\"5fa547495df7a2c7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/reconcile.js\":\"31c8c2027aa166af\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/timingMetrics.js\":\"3cbfbba2133a7545\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/treeQueries.js\":\"e84fd85f5ee850b7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txEngine.js\":\"a8ff209000c045bd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txSnapshots.js\":\"19fda2a1f5536743\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/typedBlockQuery.js\":\"eac7f54653e90563\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/undoManager.js\":\"25c68e77f5569807\",\"/knowledge-medium/pr-preview/pr-1792/src/data/invalidation.js\":\"2f1e7cf5b1557412\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelDataExtension.js\":\"5164f59a8c416b2b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelPage.js\":\"4adaaaccec3ce991\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelValuePresetCores.js\":\"8420cba3a2925224\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbCorruptionSignal.js\":\"2047a12417be2bce\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbStorage.js\":\"6af976f368859a41\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbVfs.js\":\"356d4f5a3a530096\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localSchema.js\":\"cacf2ce90a5d7f38\",\"/knowledge-medium/pr-preview/pr-1792/src/data/maintenance.js\":\"45f8d735288a448e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mergeProperties.js\":\"693131110dc7686a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/metricsConsoleHook.js\":\"5fe24d65634bb9d8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/migrationsPage.js\":\"4604056fd9de44b2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mutators.js\":\"14725ac6f33a5363\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKey.js\":\"ee8cf0bc1ace0110\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKeyPlacement.js\":\"6ea4314b82a44c88\",\"/knowledge-medium/pr-preview/pr-1792/src/data/outlineSurface.js\":\"3bbee3a683487cc2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingEditorContent.js\":\"9f6479e35028010a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingUploadsSql.js\":\"afb8e12023956ce3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pluginStateExtensions.js\":\"5183f575a6b6e102\",\"/knowledge-medium/pr-preview/pr-1792/src/data/powerSyncLogger.js\":\"58d9c6206fa5d76f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/projectorRuntime.js\":\"0d5b89d6fd3a97f0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/properties.js\":\"c5a8a4870f517aec\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertiesPage.js\":\"60c76f5fe06c0086\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyChildren.js\":\"ce3eb54e631ce731\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionFanout.js\":\"6275d9bfa5b08fb4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionMetadata.js\":\"e06ca53bb531a3a0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionRegistry.js\":\"bcf1812fbaf2c98b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDisplayMode.js\":\"965522c4bcd71336\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyRowCreation.js\":\"1b7bf1d57543c12b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySchemaCreation.js\":\"513ebef94ff42bd3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySeeds.js\":\"3591e71474b18b7b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/recentsPage.js\":\"212e50237cd535ab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/referenceBlock.js\":\"238d8207a080c1b9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/releasePowerSyncConnection.js\":\"9c74b6429a199ed4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repo.js\":\"b51bf3351dd1eed3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repoProvider.js\":\"6751e961b43aa41e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/rowProperty.js\":\"ad9013fd487bd438\",\"/knowledge-medium/pr-preview/pr-1792/src/data/searchFilter.js\":\"d7be55301e875912\",\"/knowledge-medium/pr-preview/pr-1792/src/data/seedIdentityLedger.js\":\"c8ae3dc84adfe7d6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/stateBlocks.js\":\"91009d97528bf59c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/structuralEditPolicy.js\":\"db61cdc79e1cbf2d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/subtreeDelete.js\":\"bad7e44760a60a4a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncStreamLock.js\":\"44f73c32f73fc83c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableSqlRecognizer.js\":\"3c76924461ccf4d2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableWriteGuard.js\":\"2e2e8afb6a98dd66\",\"/knowledge-medium/pr-preview/pr-1792/src/data/targets.js\":\"2b7fe4e96a8f5724\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeColors.js\":\"44bd38ea95c89802\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionMetadata.js\":\"24ef3e00076a0639\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionRegistry.js\":\"6a977b2344a7db23\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeExtraction.js\":\"e66716034df8fc3a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeInitialValues.js\":\"bfc07d69bd416a88\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typePropertyGroups.js\":\"41ee0fdafcd6fef3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeSeeds.js\":\"7211005e52877346\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeTagger.js\":\"7ee5e7b2cf8fb44e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typedRecords.js\":\"fe43e1770c692350\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typesPage.js\":\"7b7d7749046a30d4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userPrefs.js\":\"ac5d30a62b391e1c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userSchemasService.js\":\"08536e676a1f725f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userTypesService.js\":\"2ef48d5249ee631d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/valuePresetRegistry.js\":\"41c1c394328b5bf2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/visibleChildren.js\":\"3940c3add466d3ee\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceConversion.js\":\"5f22f54766b3f167\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceFirstSync.js\":\"d910ad89135ec88b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceIdNamespace.js\":\"691a0b5d9019e27c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceSchema.js\":\"34353bb9f24a1205\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaces.js\":\"d4f8eed7e0aca1d5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadLog.js\":\"226e196911d5eef5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/BlockPasteShellDecorator.js\":\"063b0d8a1b60df8d\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/atTrigger.js\":\"8ada38701a6d742b\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/autocomplete.js\":\"3734ffd84214c9a8\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/codeMirrorExtensions.js\":\"5854ec97eee5a265\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/contentFlush.js\":\"94ad415c874e4ad7\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/defaultInteractions.js\":\"350314264012127d\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/editSettleSignal.js\":\"93924dab2c5c2997\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/insertImage.js\":\"e4d1f6df8183a2e8\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceCompletionRange.js\":\"92d03a3f487aec00\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceTargetTypes.js\":\"8511feeeb88ca2d2\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/syntaxContext.js\":\"d6331fe6a6262dcd\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/triggerMatch.js\":\"802373b770080480\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/AppRuntimeProvider.js\":\"1ebf70e80fab109d\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/BlockFocusShellDecorator.js\":\"be52aedcc659f9db\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/ExtensionRenderBoundary.js\":\"dcb08d08367b7e4c\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/PanelContentRecovery.js\":\"331dcde29b7f2366\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/apiCatalog.js\":\"0896687c6d225edc\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/approveExtensionHere.js\":\"d1dcea470ca47a89\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/armedCutAppMount.js\":\"e4e5f61d76d355c2\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/batchableKeyedStore.js\":\"67179647e4eb962e\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockInteraction.js\":\"f3bfe5a1f1fc0449\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockSelectionAction.js\":\"a81a8c16a4e9a518\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compileExtensionModule.js\":\"08b35ff2c182e5d0\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compiledModuleCache.js\":\"65153e6c7a770d41\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/continuousGestures.js\":\"a049e2b411b89a62\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/core.js\":\"c0a05a7e2eac7e10\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/defaultRenderers.js\":\"531e5670ec6684a7\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/definitionFanoutAppMount.js\":\"a081da66c92bc1e8\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dialogAppMount.js\":\"a186c482c10c8a6b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensionSeeds.js\":\"72cda0ff62cfcb82\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensions.js\":\"3db3aa5ae2442fbd\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/exampleExtensions.js\":\"63e4b33e3d40997c\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionApprovalStatus.js\":\"856faf4c2e455203\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrorToast.js\":\"8134a9583b4242ea\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrors.js\":\"4de3ced254b9a21d\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLookup.js\":\"e37bd3e30e7c9ad7\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionToggles.js\":\"6cc971c64bb54cc9\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionUtilitiesCss.js\":\"bc27c9434a84274a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/kernelPageDeletionGuard.js\":\"8df8647cf63992e2\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/liveRuntime.js\":\"c301586ae6b3230a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/openExtensionsSettings.js\":\"abe3f40116f8a543\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/overridesCache.js\":\"4c8cfe2336f7e623\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/pluginIds.js\":\"409e4f45921c05e9\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/processorRejectionToast.js\":\"7194b7ac81c1b8cf\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeActions.js\":\"e3d69041525888f6\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeContext.js\":\"1394535b0cee398d\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticAppExtensions.js\":\"2203cd6fb422f18b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticDataExtensions.js\":\"3b5d700cd89e99a0\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/toastAppMount.js\":\"5a5854c65eb99362\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useOverrides.js\":\"92317dbc774079e6\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useShortcutSurfaceActivations.js\":\"2e113c9c86a8b549\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/discoverToggleTree.js\":\"3cf8c3823a34ac73\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/facet.js\":\"b6a8fc746d15a2e1\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/resolveAppRuntime.js\":\"f984e5360aec72dd\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/runtimeEvents.js\":\"b5491a27fb8057cc\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/togglable.js\":\"472ec23e1101077b\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/variantFacet.js\":\"297c5e10f20c5443\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/verbFacet.js\":\"f1884652a0e120c0\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/block.js\":\"36096d415c915b45\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/focusedChild.js\":\"01d86a001774e24e\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/propertySchemas.js\":\"8856cacc3eab13b7\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/typeRegistry.js\":\"c69f35bb39670c53\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAncestorCrumbs.js\":\"a660bc94ea8472ad\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAutocompleteListbox.js\":\"432f2f8546f7f8d9\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedSearch.js\":\"b0f77850eaa4e3aa\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedValue.js\":\"0e77a3d319f0e1c5\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsFocalRender.js\":\"2499fc165d455568\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsReadOnly.js\":\"8c6170d60b6f6871\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMaterializeBacklog.js\":\"317d9179665522ec\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMinuteClock.js\":\"6259cd2720cb65c8\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePanelLayoutProjection.js\":\"39fd8d4df99aae3a\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePendingInvitations.js\":\"cc934ad2a4cbd0c0\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRendererRegistry.js\":\"115f979d4e7482d9\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRetainedFieldRows.js\":\"2ecfa28de56e5bfc\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useWorkspaces.js\":\"e34d0c295e634e39\",\"/knowledge-medium/pr-preview/pr-1792/src/lib/utils.js\":\"0731af7c4e4df8a7\",\"/knowledge-medium/pr-preview/pr-1792/src/main.js\":\"28aa851a1e862acd\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/MarkdownImage.js\":\"d460e450269bc7fb\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/blockSeparators.js\":\"d1195ca19b234410\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/context.js\":\"6eac5cacbde2979f\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/defaultMarkdownExtension.js\":\"d47c03da7a43cdfe\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/extensions.js\":\"5360c17933f97f7b\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/renderMarkdownHtml.js\":\"2bf9f3d50fe06813\",\"/knowledge-medium/pr-preview/pr-1792/src/minimal-editor.js\":\"9cdf03fe6a9feb88\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/armedCut.js\":\"75a5d7c329e10398\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/captureMediaVerb.js\":\"1e17ca0fbe00aa23\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/clipboard.js\":\"d90bbc54a785f098\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/decision.js\":\"78bfdc84275de489\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/operations.js\":\"49c271aa349edf95\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/AccountHeaderItem.js\":\"e1bb7262fdff454c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/index.js\":\"d49b8f73a8b27aea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7c2fa97762898c68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askAgent.js\":\"e82e0c9e0f6c5659\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askedStore.js\":\"182c7d532f96ee78\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a52f2ffed062b313\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/chipState.js\":\"0cd838d1b2835e58\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/dataExtension.js\":\"509ff71a7ab768ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/index.js\":\"fa1d18c821ebe4bf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a1916a8b3c11d7e6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/schema.js\":\"80874176094f4266\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/AgentTokensDialog.js\":\"bae6b2b216c6cb6c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/BridgePairingDialog.js\":\"50ea432f84a18fff\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/addMedia.js\":\"3d48f128695a4182\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ab5772d61040b312\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/block.js\":\"26b3417fdcb59a04\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/context.js\":\"83ffd3f493c1f18a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c579ae49fdde4dc6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/index.js\":\"c5171e7ec2d33f19\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/outline.js\":\"fef6c3e8126f7f96\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/properties.js\":\"0797fb7fe8436a98\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/refs.js\":\"33b63a03b27875fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b5a1d0a2b07180ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/search.js\":\"311b9e0d70786563\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/shared.js\":\"c89d6ba0208438fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"00aa753411308cbc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/text.js\":\"c49f3d4d0801cc2a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentWrites.js\":\"05a7903d5bcdc240\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/authoringCatalog.js\":\"a32878afa466e9f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/blockRefTargets.js\":\"b79c2abdacb492ab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridge.js\":\"0c49f67af259e8a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridgeLoop.js\":\"d515c2dca3053d96\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/changeHistory.js\":\"3265a3bd4d19499a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commands.js\":\"2f890e08f9606956\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commentsCommands.js\":\"a163a514cbeebd82\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataExtension.js\":\"26a54225b9b59e5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataModelGuide.js\":\"574eb4b801533644\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/describeRuntime.js\":\"c36393ffed289ef9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/extensionLint.js\":\"787fe5123b8b2b41\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/grainAudit.js\":\"340a6b01658c5e7b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/healthCommand.js\":\"fa7670aad7b20b9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/index.js\":\"fdd96475803fa845\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/presetIdentity.js\":\"efb3e58e969fdd0a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a06315fc369c4d87\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/readMedia.js\":\"8c010389781b8504\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/schema.js\":\"13cf40803f9b5043\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/serialization.js\":\"4a4d059ac4ccf531\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/targets.js\":\"7b5d8d2897be0ea4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/tokens.js\":\"e4555c24b882bb83\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/watchEvents.js\":\"b6d4f29899e7c8b0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/workspaceGuard.js\":\"4bdb7407289b0c40\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/writeCommands.js\":\"de0b0895075284cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/AliasCollisionToast.js\":\"6423477dde0c72da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/DuplicateNameBanner.js\":\"f2ab3c6823610738\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/collisionMerge.js\":\"2cda28fdbcbaed71\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/dataExtension.js\":\"3bb2ced2c059015e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/index.js\":\"3d7ba86a38de4bda\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/mergeCollisionAction.js\":\"6cd7e967b7afcd36\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/pageStyling.js\":\"a480307fe98f96c8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/rejectionToast.js\":\"da1cbb279dcc37ec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/syncProcessor.js\":\"f2de4e32011fc60d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/actions.js\":\"0228857a82970b44\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/addComment.js\":\"8fd3f1391f14df0f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchor.js\":\"a5de1413f07bc141\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchorState.js\":\"00ffc807a54c062f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/commentLinks.js\":\"21ad76a1b668ea3c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/confirmThreadDeletion.js\":\"6309c34ca9745171\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/container.js\":\"fea7091a26cfd088\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/dataExtension.js\":\"9b56ba8cb63a6e51\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/deleteComment.js\":\"5f990bfdd21eec3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/highlights.js\":\"72a8193208c64f4c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/index.js\":\"9f29bf075e09a3a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/linkedCommentsPill.js\":\"4616ed1cf59b27c6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/margin.js\":\"eb7c40fafda51238\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/marginSchema.js\":\"cd384b83aee58428\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/newComment.js\":\"3315cc7332a01ef7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ownThreadPicker.js\":\"3cb03b3eb06a6c79\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/placement.js\":\"0da9c1b2fb6b2d0c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/queries.js\":\"5bf8ea75d2c7acb0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotePosition.js\":\"b67db37fe52ec213\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedIn.js\":\"a3dc0b4eb0d4dca5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedRange.js\":\"14667f149c885eaf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/rangeRefs.js\":\"bd27b6a791a5128d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readHighlights.js\":\"b8fa4d450d1052b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelection.js\":\"6d5081bc977def51\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelectionUi.js\":\"744ab409605dc3d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/reanchor.js\":\"dca53a742dbcd876\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/schema.js\":\"16b1112c1eb6e1d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scope.js\":\"786f8ef40ac6b57d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scopeThreads.js\":\"a8843b34a9c00318\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/splitRetarget.js\":\"9d463a152f971996\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestionCard.js\":\"9e2edb7e825e718e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestions.js\":\"b8ae9c2ae421141a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaries.js\":\"1ec984dbb3a9392e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaryBatch.js\":\"afe266f7dddefaa4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/surface.js\":\"beeff0487a5bbde5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threadNavigation.js\":\"44750c2e03adaf6c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threads.js\":\"2eb213ad35d9921e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ui.js\":\"57fcb4e11d5506cb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/uiStore.js\":\"16ee942295b07c92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/appIntents.js\":\"54a0cb65aa60d0b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/index.js\":\"f8045e944bcd7a51\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/index.js\":\"257f2e11cfc47bb7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/status.js\":\"b9606cbbf6c6050d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d95be477e8a2756f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaBlockRenderer.js\":\"e0a24e2c5656739b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6fe9ccd35a1dfbaa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaUploadReconciler.js\":\"a6a170b97e091200\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetDownLane.js\":\"a831bdfe96a86ffe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetResolver.js\":\"24e813d910916851\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetUpload.js\":\"d8f6045f180c70f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/attachmentCleanerIO.js\":\"cfb53d40a5885959\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6666df5e5c239bc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/blobStore.js\":\"f259f6fe516891ad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/byteStore.js\":\"f162d5f94191f731\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanerIO.js\":\"0714a1663a29cdbf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanupAttachments.js\":\"3103b2a6c9728892\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/dataExtension.js\":\"dc300d3404da1b9f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/downLane.js\":\"df492835bd34e3d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/index.js\":\"a4ea550ccaeec3cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/insertImageContribution.js\":\"88bee6d0619042a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneArming.js\":\"734056f46f623447\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneLock.js\":\"e703cbfec30b0b2c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaBlock.js\":\"f31cef38c6357b7b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaCapture.js\":\"f3d8e9ad96ba89d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewers.js\":\"6bae8effb3650751\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewersFacet.js\":\"42c7eba0d7ebbe66\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/pasteCapture.js\":\"57152284df477c3f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/resolver.js\":\"3f4e8bbfa8930dd6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/retryUploadsAction.js\":\"34044f05737f4ac0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/storagePaths.js\":\"294ec019e05d7dc0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadDrain.js\":\"4dd17852ceb62565\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadLaneStatus.js\":\"9435bc5856f40b9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadReconcile.js\":\"b25cad46c4776c6a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadRecovery.js\":\"b9084085a1447128\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadStore.js\":\"500cb84a96c7121f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/useAssetObjectUrl.js\":\"78216a130a31f7d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"84b20904f63cefbd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a9cacaf27c86ab1e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/facet.js\":\"a9659a1003a82427\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/index.js\":\"327f7ebd02cae39e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/prop.js\":\"a75c9919d4e535ef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinkFilters.js\":\"ab0de56722edf3a3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"209d2679adba73d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BlockEntry.js\":\"1609f4723a604b01\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/LinkedReferences.js\":\"f4663083c728929d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"35fc0d27653cb0b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dailyNoteDefaults.js\":\"c0d80acc5ed9d523\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dataExtension.js\":\"214d8874aa382b57\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/edgeExclusions.js\":\"a95ba410cf20a008\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/filterProperty.js\":\"e22b6c8bed9f449d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/index.js\":\"7d644ffd0462dc0e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a51255e7373c6e37\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/applies.js\":\"88613149edc4623c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/countQuery.js\":\"93e5064170688a6e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8e78098d9d079731\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/index.js\":\"55889f1cf5d00d43\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"389cff64168c3238\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/presentationInvalidation.js\":\"5861532b106e674a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyEditorOverride.js\":\"3db07c1ccc5e973a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyFilter.js\":\"fb71d74000de04d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/query.js\":\"16b5364ec81f6bb5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/resolveFilter.js\":\"6172908f06c9d3f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sourceBatch.js\":\"56b35889bc04c66f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sources.js\":\"e45362a08ba9c011\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useBacklinks.js\":\"ef8162ff93f0e3f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d8441b3a42ebc642\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayCelebration.js\":\"7a971e036d9fe14b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayOverlay.js\":\"7103c170e73d3735\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/gate.js\":\"a74a504ee3037357\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/index.js\":\"c0df15cd0412213f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/wolfTheme.js\":\"753a65e65f28555d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/BlockDragLayer.js\":\"5ce36f6eb29c99ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dragController.js\":\"6034b6a5ed60589e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dropTarget.js\":\"cf3c28913efe219f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/index.js\":\"02e14228b93f0c50\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/projection.js\":\"aa0ca3730f08c4a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/BlockMetaCard.js\":\"312cb270a848fe81\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/index.js\":\"87ebfad2d29a9297\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/AddTagDialog.js\":\"04127451cc365f99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2b2dbb27b96a5ba3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/TagNameIssueHint.js\":\"adbee0892b0e63f7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/addTagAction.js\":\"0d055493cdccdd80\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/appendTag.js\":\"5f909805088bc4dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/config.js\":\"5d882a5d0a5d0833\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/dataExtension.js\":\"92262c5fd5671cb1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/index.js\":\"6a2eabc2fec878fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/propertyEditorOverride.js\":\"541b269f2a1c2c66\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e3c10ae7584962c2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f0e777ac02f8a32b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9b6f6459a72cd29f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0e666937d4d2a597\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b029c94b7666a614\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/index.js\":\"cb8bf6e575ec6a21\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"85b5fa6db61751ae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/CharacterCountItem.js\":\"4e962bf524b8bf3f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8f6fb10261fe298c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/actions.js\":\"9736e996bacfbabf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/blockType.js\":\"66bbce83511c1645\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/charCount.js\":\"8f6a9979ee35afc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/dataExtension.js\":\"3166e4f11cdce93f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/index.js\":\"417e752bb99c2fd1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/profiles.js\":\"a79f9b814a4fef40\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/properties.js\":\"5bf80ff6db70ce90\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/textCounts.js\":\"1bb8a6df9a0db311\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/colemak-keybindings/index.js\":\"6b40733a20ee0a0c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/CommandPalette.js\":\"27d0d9719391dc85\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/HeaderItem.js\":\"a4c7293fb3738f67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/context.js\":\"a92705cf5c8d188a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/index.js\":\"42963f1e91c3bab2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/selection.js\":\"0ddb304822c381f4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/toggleStore.js\":\"0074c508b7e96e1d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/useCommandPaletteActions.js\":\"ccd7454b4f3a6012\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/ContributorBadges.js\":\"e2b4290f74144083\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/author.js\":\"ddf3bec3ed914e4a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/codeMirrorExtensions.js\":\"54c4ad02c33dbba1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/dataExtension.js\":\"ba8b941afb9bc298\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/index.js\":\"2988fe21d2a67462\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/mentionAutocomplete.js\":\"333530fb4d0eea85\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/processor.js\":\"e3605fa3d5fc9f8e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/profiles.js\":\"9b4b73f2763f38f7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/queries.js\":\"bb64e8da3580dfed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/schema.js\":\"09581103135e6ff3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a21e3d659409a7a1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/followOrigin.js\":\"722d5ca314f2e710\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/index.js\":\"6be9b58294757af9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"515e8852bbea1563\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7685c900618beb24\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/CalendarGrid.js\":\"bc46e41c3c662bd5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DailyNotePicker.js\":\"8713522eb99e56e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a21d15312cb63bf4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateNavDecorator.js\":\"ca2a5b240560faec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateScrubOverlay.js\":\"b9e174b1ebb5adf6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/HeaderItem.js\":\"0bf4e7a0ff1c3cbf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/ReschedulePicker.js\":\"5530e4a5790f93a7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/SpreadDatesDialog.js\":\"01c99101a7e19c20\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/actions.js\":\"6fa8a162915525e7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/blockDateAdapter.js\":\"3736420dd8bf39b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/calendar.js\":\"3db7872eb71a6a9f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dailyNotes.js\":\"72f4830f33bf6d44\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dataExtension.js\":\"4274620b66354938\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubActions.js\":\"4729708a7245dcc6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGesture.js\":\"80a734bfd847bcb5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGestureActions.js\":\"17faadb45c437948\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c332f1e3fea2b12b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/deletionGuard.js\":\"4b0542a277bb64f7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dueQuery.js\":\"d0e332265b4efc2e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/index.js\":\"5f15cf4b9f5252b4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/landing.js\":\"f43de7f0ded56d45\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/localSchema.js\":\"f3a1b47215a0a6b7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/referenceDateAdapter.js\":\"14f5aff70ffdefef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/rescheduleAction.js\":\"62fd4e536692201a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/schema.js\":\"de80c51e063c87e7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadBlockDates.js\":\"3abe444315429e08\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadDatesAction.js\":\"a1207960754eef5b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/today.js\":\"c6663612ec1567d0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3cc21c1cdfcbb610\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7b68f03b6af2ca3f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/audit.js\":\"3a2228e6565b2849\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditAction.js\":\"747fd00d4879aa7a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditRanges.js\":\"c056b491c2aaca14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/diagnosticsSource.js\":\"a890c830b4fc68c0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/divergenceScan.js\":\"3ea7d5d306980057\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/index.js\":\"0813de459cd3700a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/propertyChildrenChecks.js\":\"53ffc03e2d1956f8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/referencesMirror.js\":\"8bf97e485da348f9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/rowJson.js\":\"ab109ace478d3992\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/schedule.js\":\"a799504107a32a90\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/store.js\":\"ff6f7178a0f56852\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/action.js\":\"9f7756269a4e57ff\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/index.js\":\"1fed0b98270b4555\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/plugin.js\":\"804d2ef89f41ede8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c930f23983af1f86\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/actions.js\":\"e8d565258bac22bf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/changeMarker.js\":\"ecd5876f262d90a1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/diagnostics.js\":\"bc24e48faa18819d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/fileSystemAccess.js\":\"3a0906660627ba70\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/filenames.js\":\"b4b874b5a984e5b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/index.js\":\"18e7a888e097fa77\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/mirror.js\":\"cd24b4eb397f4ab1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runLock.js\":\"ecae1ab4678b94d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runtimeHealth.js\":\"42f4700b25c8c912\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/schedule.js\":\"273752eab73966de\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/store.js\":\"6494306954fbd953\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/index.js\":\"1aee478ea647ebe7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/themes.js\":\"954c8677e461fc36\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/facet.js\":\"214838cc15f59d1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/useDiagnostics.js\":\"8c6fd37bd1b845eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/dismissals.js\":\"1e461f95ae70e4ee\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/index.js\":\"e2df05739edce8b8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/status.js\":\"4468dbfacad80bcf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/store.js\":\"30796e94f24748a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9c7469250eca4e0e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fd3a0da55b9fb079\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/actions.js\":\"a445aae82a6defc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/config.js\":\"95790a698630811e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/dataExtension.js\":\"91502004ea03f3e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/effect.js\":\"c801b2f8801e42d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/index.js\":\"f87b0f3564adf89b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f7ed6599f04fe609\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/useToggleTree.js\":\"64e1418b3b00995c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/ExtractTypeDialog.js\":\"1c21619e0d8f1b4e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"1f00f7982fecc2eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/PropertyShapePicker.js\":\"1273349377e679ef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/action.js\":\"0a1114fc06defcea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/index.js\":\"91b4f8e61dfae2a7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/FindReplaceDialog.js\":\"7d1643940504ff65\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/HeaderItem.js\":\"482326d247094884\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/dataExtension.js\":\"38324aed71ee29d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/index.js\":\"e37d8162f7eb5087\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/search.js\":\"13b6b04e9f0e8eb4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/toggleStore.js\":\"1bb1c03cee19f7aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/LocationPropertyEditor.js\":\"bfe996585787d83f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/MapView.js\":\"e785b9e5fab6de8f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/blockTypes.js\":\"82abed0288c20cd4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/codeMirrorExtensions.js\":\"defc69f9261c5944\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/createOrFindPlace.js\":\"aa09db2f803ecc67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/currentLocation.js\":\"ffdb20798d5eb8b7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/dataExtension.js\":\"0679532e8bfdad0e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/geoContentDecorator.js\":\"f31e38173d265831\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/googlePlacesClient.js\":\"2f9011447a1d4e5f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/index.js\":\"c2987bc55469cb67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/locationsPage.js\":\"280ccd70fa9078d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/mapViewport.js\":\"5a9b921b2e022258\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/pickCurrentLocation.js\":\"6cbbd98f9e494465\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeAutocomplete.js\":\"4c978841c9d63382\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeNameCollision.js\":\"69b25817dbcc9dab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/properties.js\":\"e4a8f68c3bb37fd7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/propertyEditorOverrides.js\":\"876a82a12bdd645b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/query.js\":\"181e7b9d8ae311d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/usePlaceSearch.js\":\"9eea8eb96dbd0a43\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b50ba42400914076\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ac4c31f56ce7e0d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7da438375430cbfa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/config.js\":\"45450b63f0160873\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/dataExtension.js\":\"c5dfbab247bb3c86\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/facet.js\":\"e8033eb0598ebdd7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/grouping.js\":\"c9c6ff0f3bb979f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/index.js\":\"5ac79b9ac16edb04\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1972591bf5f2ea2c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/query.js\":\"3ea1989624bdc90e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/resolveConfig.js\":\"3ce7e3fef09cc82f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e20fdcd2fcb73b5b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6301170dc9e0b442\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlDocumentContent.js\":\"6ddd6081cb6bd7af\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlFrame.js\":\"be47e22c25bda665\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/actions.js\":\"448686a27131ae9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/blockType.js\":\"9c186d0903e6f4bf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/confirmRunScripts.js\":\"a6e46986beffc83f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/dataExtension.js\":\"99a77fc013a8e12d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameAnnotations.js\":\"a3a54cac1d577040\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameDocument.js\":\"c5b8987af419a0f5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameTheme.js\":\"ab7ed88de252b2d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/index.js\":\"e97eec38e948bace\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/scriptConsent.js\":\"15f12daaff16165a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/sourceMap.js\":\"1d6a95756636bcea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/useDocumentScripts.js\":\"7b98b3c230ef9b75\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/index.js\":\"50721889a2352f42\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/record.js\":\"3bceaddea5d0b106\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/recordStore.js\":\"db033bbaf72ed9a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/responsiveness.js\":\"82dffc1660ffe3fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/schedule.js\":\"d3b2a549570ba0f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/sessionContext.js\":\"d5f124b6b27083b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"535034e540d73647\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"fd11855470b35318\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/actions.js\":\"cd9e5754d0f39f7f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/config.js\":\"0aa7bfb013054c99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/dataExtension.js\":\"68ae23badcdec621\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/effect.js\":\"27f540bba9034946\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/index.js\":\"244532ddb9cb4c33\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/keyCapture.js\":\"044fee2c018df77f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/overrideStore.js\":\"66cee015eef144fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"54408c35c9f729d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/HeaderItem.js\":\"427cd45032a5cf3f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/LeftSidebar.js\":\"69c42a455367bcb0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/actions.js\":\"062ad4e4339ddb44\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/facet.js\":\"1a251f46e9981bec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/index.js\":\"43159fa116c6a615\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/shortcuts.js\":\"ada6a6af0cba4cf0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/toggleStore.js\":\"1b5c5273d455d8c5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/MergePicker.js\":\"4fb900928fe578da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/index.js\":\"b859f5618affeff1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/mergeAction.js\":\"53b8f19bde540563\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/strategy.js\":\"9d976b38a7b86dc4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/Button.js\":\"2facee374b1d6745\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"704ee36afb62d57d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/defaultItems.js\":\"09f2777d812c0ac8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/facet.js\":\"aa6781f7614861a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/index.js\":\"4b8328f2edfcdd6e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c1738eecaeef6ae2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a62468d5f6aaa7c0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cb142ca019022c67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/facet.js\":\"eb8fbb4a2a0ec250\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/index.js\":\"5368a8832a542e80\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/MoveDestinationPicker.js\":\"02c3e695c84f5d48\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f0a36b5499a45b80\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/contextMenuItem.js\":\"68e0024911c7d2d0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/index.js\":\"ad6985c7321d8398\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveAction.js\":\"fd9f1812982a3f35\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveBlocks.js\":\"d17502ab24b36564\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/selectionAfterMove.js\":\"bf1e9d3bb2affe92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/TutorialBanner.js\":\"f9cb4df844026a64\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/action.js\":\"84ca0e63ff791e4d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/bannerDismissal.js\":\"084752b5a3925cad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/documents/cheatSheet.js\":\"7e5c2f57be0f3241\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/index.js\":\"d8c902df762aceb8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/keys.js\":\"df8dd80821a589fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/landing.js\":\"680e9b1d91f8b4f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/outline.js\":\"354d073ceeb82999\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/seed.js\":\"ec3ad25455a0f856\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/PerfTrendDialog.js\":\"fd04a50c21e55d2c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/analyze.js\":\"a10d1d4dd27ad789\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/diagnosticsSource.js\":\"8c330b32f94e64bf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/index.js\":\"f64ecb2b919d282b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/load.js\":\"3bd9dee5511bb238\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/monitorRun.js\":\"053b1882f53d5f2b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/schedule.js\":\"702db335e5646f11\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/series.js\":\"fd8f5a52cbd4d68b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/store.js\":\"8f22a4a690f751df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/trendAction.js\":\"b85ed1212c38ac83\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/verdict.js\":\"bccbed0ac2ecbfca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/clickToEditAction.js\":\"cab049bed463ac7e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/index.js\":\"2a4a42f83e523c92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/interactions.js\":\"185387a6c1fa6b03\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"541e68d928bd4560\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGate.js\":\"f3749e0e83f7a70b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGateDialog.js\":\"8f1f687e47019945\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/action.js\":\"f8585b2e52da5baf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/index.js\":\"cd61b3ee6a98ad22\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/localRunMessage.js\":\"2915cc604cb20d27\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/plugin.js\":\"eebdf48e9c8ea863\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/progressReport.js\":\"11e76d1790e12c6d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/sweepProgress.js\":\"f884dbb4fb7bf780\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/FieldRowRenderer.js\":\"b6785bbd8b1f87a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/ValueRowRenderer.js\":\"7f52c01f80c14746\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/actions.js\":\"54ba3677547e2763\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/autocomplete.js\":\"38768c044a24c64c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/fieldRow.js\":\"5bd4e76952c64daa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/index.js\":\"32a1540bc935cd76\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/referenceWarning.js\":\"f3385c77441defe8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueAutocomplete.js\":\"cf4f7ca5153ca3c8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueSchema.js\":\"702cb0389b1d0a64\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/HeaderItem.js\":\"91022a30d26e40aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/QuickFind.js\":\"167c0b3b40ee3b36\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/index.js\":\"38c320627cfb968a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/recents.js\":\"830d2de13243b4fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/resultItems.js\":\"5b615ba2d46e328c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/selection.js\":\"94c92c8e4b2eaaa7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/toggleStore.js\":\"b85bcb4bcacddd32\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/HeaderItem.js\":\"7a14b09d35016045\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e9ee9656a7a085f9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/grouping.js\":\"fa417c039aef3902\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/index.js\":\"a5d7018df8ce3ac0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/target.js\":\"e47196f2c059a6d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/codeMirrorExtensions.js\":\"544f8648e6e282cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/contentPrefill.js\":\"0ea22c6a635dbfc3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/dataExtension.js\":\"6240fcab3975bb9c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/index.js\":\"fa2e88d99aafac7d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c7fd08403f4a5bbd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/invalidation.js\":\"d0f62e8431994342\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/localSchema.js\":\"1a82f3cc341c902b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/index.js\":\"8f1ac22e24546a72\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"017bfed1f92d25c7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/index.js\":\"da42b9335be2479b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/referenceNode.js\":\"f277f43288bcc464\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d66e0720e70922dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9c632305b2e2baa6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/index.js\":\"42caabaaf297085e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1d1a4d36d6825910\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cf85c9e2f283ba45\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/mergeRetargetProcessor.js\":\"424f0f8b6c2ec462\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/parseFence.js\":\"e817048223d1d43b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceParser.js\":\"cdcada78a71d5381\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceProjection.js\":\"3ad7dc60c280c9fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referencesProcessor.js\":\"400b5aa6d90ee981\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/renameProcessor.js\":\"038e7826f578c50b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/spanReplacement.js\":\"79da34034a1490f2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/htmlToOutline.js\":\"67dfa7f93ea16b07\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/index.js\":\"06c86a8e59331b74\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ef0a62e3db2ea26a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/pasteDecision.js\":\"30b0caf8180ff95d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/action.js\":\"dfe38b9c54432943\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/blockIds.js\":\"30401968db22dfcc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/content.js\":\"4eaec75c8f75e9dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/effect.js\":\"19860a5810788b1e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/ids.js\":\"e480d6ca4ec0c4c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/import.js\":\"7af424117a762a7f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/index.js\":\"df412450f56b0f6e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plan.js\":\"b5916ba4df78b817\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plugin.js\":\"1050f9bc0fb037b9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/promotion.js\":\"3f0dd8fe269e22f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/properties.js\":\"8683f4ddb52f36b5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/references.js\":\"cf0133828ed4abea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/report.js\":\"4f243eea26623ad6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/roamMemo.js\":\"e84cbcf2e561de69\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/runtime.js\":\"4e4e99055e7d5c99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/schemaReconciliation.js\":\"cfc3970dcf618f3f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/srsMarkers.js\":\"0c93d782e02c582e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/todo.js\":\"4d341690fb93a818\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/typeCandidates.js\":\"62c1e6bd029ecb37\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/types.js\":\"34932b17948e1986\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/index.js\":\"ba4185b1e76f564d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/store.js\":\"3336d2c287eb3b50\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/HeaderItem.js\":\"cc4bb817122ad648\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"555bf1c83637383d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/index.js\":\"c0e1489535d22be7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/model.js\":\"33b588e1677531f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/toggleStore.js\":\"0ae0de078744d1b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/useKeyInspector.js\":\"d56fcbf99c886f0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"969b2f8cbb126b79\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/ShellDecorator.js\":\"47a9754c8d7d67bb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/actions.js\":\"c8e90d9715b3744c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9f3000b8168c5787\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/index.js\":\"3939af2f9e04cb9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/shell.js\":\"62f7ff98a83c9197\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/surface.js\":\"7c7cf996929423dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/walker.js\":\"77502dafd3bdb94a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e3d933ea51f0f4ad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/dataExtension.js\":\"5d4fe4320e539eca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/index.js\":\"ed16d35057ca21e0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/indicator.js\":\"a04413f4fcdba936\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/moveSrsState.js\":\"fc06d93a4150f85c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"efa11a5c3b3e7350\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/scheduler.js\":\"d75f2cccc1e8598f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/schema.js\":\"3dfe4d778dca9360\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"89577a94855dd8f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsClipboard.js\":\"88cd175b14cf2fc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"63b5f9b41320e3ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f7d09f5f334a539a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DeckPicker.js\":\"062218045c13912e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewControls.js\":\"df6cfe0f1c5b6d2a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewDeckRenderer.js\":\"22be0d9845fa45e9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewSession.js\":\"c1321f227a1e6056\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/actions.js\":\"62a7a29af694e418\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/archive.js\":\"07fa2ff02ace9a11\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dataExtension.js\":\"f4a5666134f33087\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/deck.js\":\"9a2c432ce631bb8b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dueQuery.js\":\"55ae1115f1f980ab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/gradeDecision.js\":\"a1e3763dfea04d76\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/index.js\":\"97ad91a3cd6c8519\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/keyHints.js\":\"46da3ebc4fe3ec05\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewCardLayout.js\":\"ffa58e6f161df53a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewProgress.js\":\"099cf6641318bff7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/schema.js\":\"1a811919ff20f0fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/useDueCards.js\":\"2836f41681043c1e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/index.js\":\"f7bc06ba17ead62d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/record.js\":\"773227d8956b8bad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/index.js\":\"b43566d8694a1260\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/persistenceStatus.js\":\"1130c68c7049e2c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/requestAction.js\":\"ce61b7400a8b52bb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/TypeChipsDecorator.js\":\"2c164a8386f574e0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/codeMirrorExtensions.js\":\"39c4236540e9a2b7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/index.js\":\"1d2df0d0dd25581f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/typeAutocomplete.js\":\"f2155c4b93ef6234\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3bbd123f33c5b372\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/actions.js\":\"39d530a6a5e4ae3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/anchor.js\":\"dac5ffd15d950f4c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/events.js\":\"616f5e2461e124ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/gestureActions.js\":\"14c939ad733f2799\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/index.js\":\"85a308a0e8439f7e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cc49aadb44f3acdf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/collect.js\":\"2264a35e63183036\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/index.js\":\"e82d35a62aebd56d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/record.js\":\"ebb651ec43c62453\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/RejectionDialog.js\":\"bf281495682de24a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5feb2f6e393adfa1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/index.js\":\"df580ebd152bbf4b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/model.js\":\"38de58a92fbcbda7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/queueCounts.js\":\"ee64b89df3a76df3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rejectedHelpers.js\":\"362ffd58e74f1eed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rematerializeAction.js\":\"313856323f5dd085\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/useHysteresis.js\":\"176bfa77449bc77f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/effect.js\":\"4d8c82a94a02b8de\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/index.js\":\"b1487f5da5224523\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/theme.js\":\"83f24faf82bd9147\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/actions.js\":\"4e4491f40bb727b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/dataExtension.js\":\"1e2714fb1bc896d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/index.js\":\"7f9058258cf822b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/schema.js\":\"68406a111b4921e7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/TouchSelectionLayer.js\":\"15f3444889244bd6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/actions.js\":\"3fb935c4034a4883\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/defaultItems.js\":\"6ca096eb8b2c83a2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/facet.js\":\"d58951d55f6bfb67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/holdRecognizer.js\":\"c0f3eba1959722a9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/index.js\":\"2a10cb25fd5ac014\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/UpdateIndicator.js\":\"abf83e1635aa341c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/index.js\":\"0e405727a70488f2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/loadTimes.js\":\"72a54ce642264559\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoNotesRenderer.js\":\"8250d62f83664a53\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoPlayerRenderer.js\":\"61c83e3a6378e168\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoTimeStamp.js\":\"b3a9bfc8b23e09ae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/actions.js\":\"4a23f5c2eeecf313\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/index.js\":\"d287925a726d445b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/markdown.js\":\"b58ab0a5ef87bf48\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/notes.js\":\"cf29420eb61e6ae6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/registry.js\":\"716d2e896ec4c931\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/remark-timestamps.js\":\"dd71ff03f9d9d684\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/view.js\":\"b95405f2bc66c326\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/LinkHints.js\":\"6c974548a9b3ef99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/index.js\":\"ba030e14df6b40dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/model.js\":\"91480d9e4e3ff3bc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/settings.js\":\"f55972b50a2fb6b5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/actions.js\":\"f4202211f9a728d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/index.js\":\"70396b45074e0c99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/interactions.js\":\"064dac739b532323\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/workspace-header/index.js\":\"32d8320bf8c7c2dd\",\"/knowledge-medium/pr-preview/pr-1792/src/registerServiceWorker.js\":\"6c3cb1e5cd58dc5d\",\"/knowledge-medium/pr-preview/pr-1792/src/requestPersistentStorage.js\":\"5b5de15c0631c53b\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authRequestDeadline.js\":\"26300f3bcb475539\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authStorage.js\":\"62d69edb5dbeb8be\",\"/knowledge-medium/pr-preview/pr-1792/src/services/powersync.js\":\"85f6ce67ee11eaff\",\"/knowledge-medium/pr-preview/pr-1792/src/services/supabase.js\":\"912b15d92760a530\",\"/knowledge-medium/pr-preview/pr-1792/src/services/uploadErrorClassifier.js\":\"cf43b731428a47b1\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/ActiveContexts.js\":\"99872456798a9a57\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/HotkeyReconciler.js\":\"3935f202a66fd9c2\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/WipeLocalDataDialog.js\":\"0a9dd92899d801e5\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionDispatch.js\":\"de9a9f1ec65de8fa\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionRefItems.js\":\"139a40f6e218c5ca\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/applyKeybindingOverrides.js\":\"1c4ad3b5ca60a82d\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/blockActions.js\":\"71628cb3f0e92243\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/canonicalizeChord.js\":\"dc825a4cecbf8adb\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultContexts.js\":\"ba0d8d9d80d62003\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultShortcuts.js\":\"d378e366c68cf054\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/effectiveActions.js\":\"df9b8cc5eea6b69e\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureAction.js\":\"f28752c5fc48458d\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureBinding.js\":\"34085a8e5d488e07\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/holdRegistry.js\":\"56d2f9e97255c9a7\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingConflicts.js\":\"03e30092e6598feb\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingOverrides.js\":\"0984eb20b9252908\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/pointerAction.js\":\"ef19a22111daede9\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/resolve.js\":\"a54084b7d195a8db\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/runAction.js\":\"f37314b68a72fc8c\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/sequenceMatcher.js\":\"41868556d4b3ca17\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/types.js\":\"ae7b7ff92e26bef1\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionContext.js\":\"fc9901705f3e3311\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionDiscovery.js\":\"0dc51efa4e676255\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/utils.js\":\"5a2701e6bbfbe169\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/bootStore.js\":\"230df081a0abc703\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/previewDatabases.js\":\"fff3ff5ae72fcb37\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/byteTransform.js\":\"4587d83e4ffe15dc\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/attachmentCleaner.js\":\"31c081288451dcf9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/attachmentParts.js\":\"7954f9b6c1927759\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleParts.js\":\"f2f3a1de19485618\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleRecord.js\":\"66b9fe5a1b3c21f7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/manifest.js\":\"67d9f1be07398499\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/takeBundle.js\":\"08c6da4a55bccb05\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/verifyBundle.js\":\"ee1b7503eba9e035\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/cleaningStage.js\":\"1bdf85b73ab54714\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionKey.js\":\"78dff886b16bc9b7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionServer.js\":\"f0d3b9b4686920f4\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flip.js\":\"764c3723647a439d\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flipAttempts.js\":\"fa49bfd7ecfb97a9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/pages.js\":\"ffbcc9fbc6c1744d\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/preflight.js\":\"979827ab11011c7a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/reseal.js\":\"10ddd3e0f65498af\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runConversion.js\":\"e46688bb18450bfc\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runLock.js\":\"a3f1e04778abad70\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealing.js\":\"7e82a83f89f11fa7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealingStage.js\":\"6fa1f4c9dd904076\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/stage.js\":\"db8c133a363f6538\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/verifyReseal.js\":\"9645bdd2e0d4a4e4\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aad.js\":\"e750d6e30069f7af\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aead.js\":\"6b04ccf19ef3323d\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base32.js\":\"4b4eadffe41bcdc9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base64url.js\":\"ab4115841a28c810\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/binaryEnvelope.js\":\"a1b5da314dc10ddd\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/byteAead.js\":\"bc6e399da660a5c1\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/canary.js\":\"22bbc4195988df89\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentHash.js\":\"7f522a79139e410b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentKey.js\":\"9dc98f2aa415d2b5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/derivedIdNamespace.js\":\"c779f1d5c9c90848\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/envelope.js\":\"ca2727763bd8ceca\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/hex.js\":\"76723dea4155b4f8\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/sha256Hex.js\":\"11a3e6e30e365c29\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/workspaceKey.js\":\"b7f3d6cddf6dad56\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/conversionState.js\":\"728f18f9c6d0b323\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/createEncryptedWorkspace.js\":\"724b0c8aaae89552\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/pastedKey.js\":\"df8db54643e3e3c7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"346d862a958a0491\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/upgradeWorkspacePin.js\":\"fe71b7cc5cde365d\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/keyStore.js\":\"d1ac2a618d548d07\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/mintWorkspaceKey.js\":\"ac3c1ead4ca24cd5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/modePin.js\":\"4ff6b381aef0ca09\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/openWorkspaceKeys.js\":\"a777d96411904e96\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolveWorkspaceEntry.js\":\"3d2bc245c3de939e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolver.js\":\"2ec752f34f9efcb8\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/workspaceAccess.js\":\"3047f12da8b05126\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/transform.js\":\"764561f9ae79630a\",\"/knowledge-medium/pr-preview/pr-1792/src/themeBootDefaults.js\":\"ef72d8dddb06f16a\",\"/knowledge-medium/pr-preview/pr-1792/src/types.js\":\"52122a76b1e9805b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/ClientLocalSettings.js\":\"98b3f5a079c2c16b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/abortableSleep.js\":\"0b6812f8b8f8619f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/array.js\":\"b41573567aab8423\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/backlinkAutocomplete.js\":\"0c1c864582e55cf5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockCrumbs.js\":\"f373e754a056697a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockrefAutocomplete.js\":\"91ec62836607a7a4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/cadencedIdleJob.js\":\"f0335cac45509ef0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/callbackSet.js\":\"1bfb4f971909d1f1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/clientId.js\":\"814b78550e457575\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirror.js\":\"08213f0237d35e3e\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirrorCompletion.js\":\"aecbc06666b0e747\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/copy.js\":\"c21aa876c824cf05\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dailyPage.js\":\"8071c87aff8a0261\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensics.js\":\"f818a2e1b5ddf639\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensicsHooks.js\":\"046ef2860078b1b2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/deleteBlockThroughUi.js\":\"0a14220577dadb1c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dialogs.js\":\"4f8ac119cbdce99a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dom.js\":\"c2c7d5d190189858\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/downloadBlob.js\":\"f8550df9ac63cbc2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/exportSqliteDb.js\":\"620ec9cffcd2b764\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fileSystemAccess.js\":\"bf41a226ba40a7c6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/flipSlide.js\":\"82a43c77b2e1137b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fnv1a.js\":\"b5f542e0de9cc79f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/formatBytes.js\":\"ac0063521564ef78\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fuzzyRank.js\":\"a257cc4a0b65786d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idbKeyedStore.js\":\"cc3e97d9ba84b4a4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idleCallbackPolyfill.js\":\"d2fc1ce4705b7a77\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardAwareScroll.js\":\"091dee1421ab4db2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardViewport.js\":\"7da144d8ef9cf9ac\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/lastWorkspace.js\":\"11a6f324d37cfcd8\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutColumns.js\":\"13c8a7e09929975d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionDom.js\":\"346a8dde9f4d9d2f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionId.js\":\"ff7e55189609d7a5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkClickGestures.js\":\"de8ebde62d99b504\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkTargetAutocomplete.js\":\"640c303abe951bf1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbCorruption.js\":\"ada7550d7aed4777\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbRecovery.js\":\"15a26380bdcd14f9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/markdownParser.js\":\"7a9dd1a2ebb25b73\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/memoize.js\":\"aa4fff0b4fa5ccf0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameFieldCommit.js\":\"6f6a478a97e1dbf6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameList.js\":\"8e532c5a94ac2553\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/navigation.js\":\"8e510c9abba873ae\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/omnilinerNamespace.js\":\"aa0d6bf7625f091f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/opfsPageScan.js\":\"2f370dee0f56a4ac\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelClearance.js\":\"a907a626fe44c264\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelHistory.js\":\"b98fd4e36b0c9751\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLanes.js\":\"9744bf1026abf403\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLayoutProjection.js\":\"ff6270e438570caa\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelScrollAnchor.js\":\"f15d74019c6899a2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelUrlFlags.js\":\"eae1d11596e767a7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/platform.js\":\"dc3ef5863c93875a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/pluralize.js\":\"731c12ecb7bb8858\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyCreation.js\":\"e350b7ddd3ac4f73\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyNavigation.js\":\"bda75b4aca2124d2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyValueContext.js\":\"5e763957e1bade4d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/react.js\":\"b0bfa64140d11fd3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeDate.js\":\"54e67894ef297a7f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeTime.js\":\"17f962cefe191005\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/renderScope.js\":\"484ea3467debaebe\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/resolvedThenable.js\":\"99da402068bee61d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/routing.js\":\"8693d36d81249a92\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/safeMode.js\":\"5f58f0b8496685cc\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/scheduleIdle.js\":\"75f528933f1b2702\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/screenWakeLock.js\":\"e1895844876c0ecb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/selection.js\":\"cda1409495189a4b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/softKeyboardGrab.js\":\"49b84f8914264f10\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/startupTimeline.js\":\"df3fafd4a93505bc\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/state.js\":\"fb35c7780f955d64\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/string.js\":\"73c5dd2629871c3b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/surfaceZoom.js\":\"ad7845316a04b4f3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/time.js\":\"2ae941c345f438b0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toast.js\":\"b0b7def6db0f3f6d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toggleStore.js\":\"d7672b1eba4a50d4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/untilStopped.js\":\"1a16adbd91ad1cc9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/userActivity.js\":\"be1ee98e8cacaf89\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewTransition.js\":\"a0dfe40fa4557cc4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewport.js\":\"440d969f8d4c2897\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/webLock.js\":\"6bbf1889f1ad1f41\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceRecovery.js\":\"4450f44314b2cb7b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceSnapshotStore.js\":\"ca0ec49f8990a246\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-compiler-runtime.js\":\"f20768bc72e90b38\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-client.js\":\"da9e3e0fe77d9007\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server-edge.js\":\"7a1f479abba6f997\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server.js\":\"7a6f2db7481d902d\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static-edge.js\":\"44a89a64ab261159\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static.js\":\"60c435085c7f934c\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-test-utils.js\":\"addae7cbfe679a9c\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom.js\":\"5f388d7d070833d3\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-runtime.js\":\"7c21c661cc39393d\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react.js\":\"d12a9182511706eb\",\"/knowledge-medium/pr-preview/pr-1792/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
