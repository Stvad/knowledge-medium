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
		buildId: "10819c3c4c23-00bf6321",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/\":\"31186812abc5d6db\",\"/knowledge-medium/pr-preview/pr-1792/index.html\":\"31186812abc5d6db\",\"/knowledge-medium/pr-preview/pr-1792/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1792/assets/FacadeVFS-DK_m4b1Y.js\":\"4bb791addfac3c12\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSCoopSyncVFS-Zqtg_HSC.js\":\"592db766baace772\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSWriteAheadVFS-BpV4uArO.js\":\"b6e82fc411767c60\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-C5JwTb57.js\":\"2036114e522e7b90\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-D2n_Bu4X.js\":\"273a25129a94281e\",\"/knowledge-medium/pr-preview/pr-1792/assets/worker-CNaCKKyd.js\":\"b0b355ab45606872\",\"/knowledge-medium/pr-preview/pr-1792/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1792/chunks/app-DOqSgrox.js\":\"abbecb0e0488a31b\",\"/knowledge-medium/pr-preview/pr-1792/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1792/index.js\":\"483c650dde36f9f0\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1792/assets/AccessHandlePoolVFS-DfigPRIs.js\":\"d32bc6e08a10b20a\",\"/knowledge-medium/pr-preview/pr-1792/assets/IDBBatchAtomicVFS-CdFFIkSz.js\":\"e115a0a7b12a5a6d\",\"/knowledge-medium/pr-preview/pr-1792/assets/MemoryVFS-CyGGf8x8.js\":\"0f96075ab673944f\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-CT_C0yjA.js\":\"be4b1aa564c15771\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-BWiDfXtw.js\":\"e49beb7cafd65848\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1792/chunks/AccessHandlePoolVFS-BhVfnhIx.js\":\"23e53b5f689ca891\",\"/knowledge-medium/pr-preview/pr-1792/chunks/FacadeVFS-eZkLVJCn.js\":\"e74e870725612f95\",\"/knowledge-medium/pr-preview/pr-1792/chunks/IDBBatchAtomicVFS-qLXaUEJc.js\":\"dc3a3df9a7ea5206\",\"/knowledge-medium/pr-preview/pr-1792/chunks/MemoryVFS-DGikAgKc.js\":\"05ae9d1cf5d1fe97\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSCoopSyncVFS-BOQPucZ1.js\":\"b70cfa0e51ad5f37\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSWriteAheadVFS-Cc-F22JI.js\":\"d5d3c4c5b1772e50\",\"/knowledge-medium/pr-preview/pr-1792/chunks/Preview-2RHMiQ6t.js\":\"bac6963eab7d9b70\",\"/knowledge-medium/pr-preview/pr-1792/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1792/chunks/card-CiCbsoDt.js\":\"1dffabcd19b27514\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-DOMIbKb6.js\":\"61076c5edfe64ebc\",\"/knowledge-medium/pr-preview/pr-1792/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-DX-cJLLu.js\":\"59201cd2f0953ad9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-async-BFPgErhd.js\":\"ff80946b27b0e1f3\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-7Njhg0-1.js\":\"710cee09f31e4b70\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-B0UIy9YH.js\":\"67f5ff050ceeb64f\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-BjSO-7f_.js\":\"9dd60e71a3356876\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-CeboBGim.js\":\"3d80fd51bdb0c5a6\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-D7wg_iH_.js\":\"1fd392e583b7f991\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-D9UgoGMh.js\":\"c416f1f94a791345\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-DpZXNoZi.js\":\"ea432117479959d4\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-YJmN_7yD.js\":\"2b4303a824f938db\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server-legacy.browser.production-syXpeKDA.js\":\"d4dc063c83288a37\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.browser.production-CStDm0Ux.js\":\"27370ef7ba329477\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.edge.production-C1PKEBYa.js\":\"cb32326cb99aa97b\",\"/knowledge-medium/pr-preview/pr-1792/chunks/server.browser-DijQRPI_.js\":\"3f04d156d840fbf9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/textarea-D8sC11OM.js\":\"f85fbbe6cc2b76cb\",\"/knowledge-medium/pr-preview/pr-1792/chunks/ui-C8e7HYBe.js\":\"66f8838fe813c19d\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-BiJyU6tu.js\":\"3488f6117774d257\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-async-CLHlzpnB.js\":\"3dbb1e830709a816\",\"/knowledge-medium/pr-preview/pr-1792/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1792/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/src/App.js\":\"62f05e07df2dafe7\",\"/knowledge-medium/pr-preview/pr-1792/src/appUpdate.js\":\"5717c0537d624c78\",\"/knowledge-medium/pr-preview/pr-1792/src/appVersion.js\":\"d62383600e162aca\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/initialLayout.js\":\"336361f820f9fab2\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/openWorkspaceData.js\":\"44296c566215d529\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/resolveWorkspace.js\":\"7ac46da8c1fffd69\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/workspaceBootstrap.js\":\"c27b8f89d841ab2b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockComponent.js\":\"155c1ff30ebe7d52\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockCrumbs.js\":\"1b503d1a06dc9be7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockEditor.js\":\"776802f0de717ffb\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockLoadingPlaceholder.js\":\"aa8923d2e0560f0d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockProperties.js\":\"b40d7a40ad09cd27\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockSearchPicker.js\":\"0cc152da3fcea221\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ConfirmBulkDeleteDialog.js\":\"67485a18f30675a6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DividerHandle.js\":\"bb9e6d4bd78c6d77\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DraftEditor.js\":\"60f4355cf024428e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/GutterPill.js\":\"cc0dece8ac9e07dc\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Header.js\":\"d5249324b4a07c3c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/LazyBlockComponent.js\":\"899a54e9b4c5e64a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Login.js\":\"a0ba36bf95f34608\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ZoomableSurface.js\":\"d7f315f38f461896\",\"/knowledge-medium/pr-preview/pr-1792/src/components/editModeKeepalive.js\":\"a2bf90b644bea091\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9a17fdcb6f31b8d5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7821d65615097c7d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefPropertyEditor.js\":\"7faa6b01ecdec218\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefTargetTypePicker.js\":\"4beb933690075c60\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/SelectPropertyEditor.js\":\"075799fcdc4e5263\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/TypesPropertyEditor.js\":\"425cd4e6907396be\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/defaults.js\":\"404d487bbb7b1631\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/kernelValuePresets.js\":\"255965e9adb5e02c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/selectablePresets.js\":\"5752ccf92d3c00fd\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/typesPropertyUi.js\":\"ea1e6e96f133b8c5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/AddPropertyForm.js\":\"e97326d32134c85e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyPicker.js\":\"d3a4f16b1a804142\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyRow.js\":\"104f952df08460ef\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/Rows.js\":\"85fa6de0b4820b0d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/actions.js\":\"6de61f0974c7a739\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/declarationOnly.js\":\"0ded0d0015d87928\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/layout.js\":\"7ff70043309f64b7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/model.js\":\"4949bc0698463983\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapeUi.js\":\"d5259a3fe0607f55\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapes.js\":\"34085d1301e99b78\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7670b094ba70b95f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/visibility.js\":\"5245c76a1a00a421\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanelSections.js\":\"2a5d42e7e82c8e0b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockEmbed.js\":\"fc1aa19636b0fec1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockLink.js\":\"e1402baa77ae1930\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockRef.js\":\"f0a536a1cb1110de\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/ReferenceLink.js\":\"1167e8b135228173\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuard.js\":\"d0e7447759997dba\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuardContext.js\":\"492b27b05263bb02\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/linkInteraction.js\":\"5304cd9a187f7db7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/referenceLayout.js\":\"f50156053f291653\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/useBlockRefAncestors.js\":\"c3a700ba9f2f3ec0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockGutter.js\":\"c8b2026d82e908a6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockInfoDialog.js\":\"5d174fbe602d5313\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockTypeBlockRenderer.js\":\"9297d88fe57ee92d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BulletHoverCard.js\":\"17ca06d7fd60a8f7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorContentRenderer.js\":\"351f1601653fde88\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"be4efb95b36d67b9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ColumnResizeHandles.js\":\"24c326a1206ec9b7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b825b83c252b7b5f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/DefaultBlockRenderer.js\":\"5b952a5cc57ad573\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/LayoutRenderer.js\":\"8f3f527add496f45\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MarkdownContentRenderer.js\":\"07447f07015e2d74\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MissingDataRenderer.js\":\"b576d247ec0f9ad6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PanelRenderer.js\":\"a84b1dfc71b964dd\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ad51b5dfdd4d98e0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/TopLevelRenderer.js\":\"f9e2f52069cc884b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockGutterMode.js\":\"58339d34c56aaf7e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockTitleText.js\":\"d64f73f61a2ff19f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/fieldCreationKeydown.js\":\"9eaab021c4e9353a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/layoutRootContext.js\":\"2f8748ccbf479360\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/TypeChip.js\":\"a15175f58ab7de0c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/chipStyle.js\":\"8e886764f752c715\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/anchored-floating.js\":\"7c237dbf9e6a6928\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/button.js\":\"6997c35f8d76634f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/card.js\":\"b4a2b3e5e910787c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/checkbox.js\":\"05bf53938b1ad826\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/collapsible.js\":\"61bc273fa329d151\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/command.js\":\"7def0247c0de7d50\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/context-menu.js\":\"9288057c77f10169\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dialog.js\":\"b4ae8146d1559395\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dropdown-menu.js\":\"9a076c0a4e6a66d6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/floating-listbox.js\":\"8b2f8cf2aa8ee616\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/index.js\":\"bb226464359c9b40\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/input.js\":\"447c947a9e9c29f2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/kbd.js\":\"19004c869b9184fc\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/label.js\":\"c71584e3d3e26a57\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/textarea.js\":\"e66c9a73ac4d10ad\",\"/knowledge-medium/pr-preview/pr-1792/src/components/useEditModeYieldKeepalive.js\":\"910cf759ad4119a5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/BootFallback.js\":\"013468b8bbd9aea9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/FocusedRowLazyMount.js\":\"647f8100620c64b0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LazyViewportMount.js\":\"2b355befe22b984f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LocalDbCorruptionFallback.js\":\"10849d6da7f7bfd9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/error.js\":\"dbec7493b6a92c46\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/lazyMountRegistry.js\":\"cbf4051cf67c7206\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/suspense.js\":\"6a96fb6912bbccd9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/CreateWorkspaceDialog.js\":\"0871df8ac25a6c9f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/PendingInvitations.js\":\"1f13dd357fb58ab9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/SyncProgress.js\":\"4941d414c7451d48\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/UnlockProgress.js\":\"ecc2170cb7ef0444\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceKeyGate.js\":\"3a8b9911b42da0bb\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSettingsDialog.js\":\"fe86d5210986a2e5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSwitcher.js\":\"524f47477cb86cfa\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSyncGate.js\":\"97713da529ecc1bf\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlow.js\":\"67a7ea3f77aa255e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlowHost.js\":\"8051a9722d9f0e9a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/EncryptionSection.js\":\"35c00748e74a8f96\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/attachmentPrompts.js\":\"170f40cbfa7f2763\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/bundleFolderPrompts.js\":\"207bc4668f2db0a6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowDeps.js\":\"b03ecb0631b561c7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowStore.js\":\"1786d486a522e707\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/flowUi.js\":\"961a3fcb79b7b852\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/useConversionRun.js\":\"dcc57af6786db254\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/keyUi.js\":\"67973d8d3403e318\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnKeyLoss.js\":\"34f2f2c59dd0c47e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnServerE2ee.js\":\"01f62078743f10da\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/workspaceUnlocked.js\":\"0aecea9251ad54bb\",\"/knowledge-medium/pr-preview/pr-1792/src/context/backgroundSubtree.js\":\"b7f7e048d8647f18\",\"/knowledge-medium/pr-preview/pr-1792/src/context/block.js\":\"65670960481b907f\",\"/knowledge-medium/pr-preview/pr-1792/src/context/layoutWsContext.js\":\"b7bb349a0c1b5424\",\"/knowledge-medium/pr-preview/pr-1792/src/context/propertyDisplay.js\":\"bb1583007be26b59\",\"/knowledge-medium/pr-preview/pr-1792/src/context/repo.js\":\"6ac51786582a74c8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasClaim.js\":\"b3b0f0ff533a5c9f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasSeatNamespace.js\":\"b5cc4921206d6cff\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockData.js\":\"bcbb4b0f38a63ee6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockType.js\":\"19602e95e4d5f194\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/changeScope.js\":\"3a86e72ad26575d8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/codecs.js\":\"6d97427da5724dcd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/derivedData.js\":\"45068c429ba91e13\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/errors.js\":\"e7b255e239bff3cd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/events.js\":\"a24a6257eefe3a16\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/handle.js\":\"5783b85783665d04\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/index.js\":\"9472d697fa1443e4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/mutator.js\":\"316f5de33477ec94\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/processor.js\":\"31e524f56321b1ca\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/propertySchema.js\":\"a883895432787e07\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/query.js\":\"69fccd9639e9eefa\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/sameTxProcessor.js\":\"87f3146d5d0a26f7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/schema.js\":\"5783b85783665d04\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/tx.js\":\"5783b85783665d04\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/typedBlockQuery.js\":\"2e9ebfed27fc9b7b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/user.js\":\"afebef238cd06479\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresetCore.js\":\"ae628c4e9c6da3e3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresets.js\":\"90782bf4e8ecb135\",\"/knowledge-medium/pr-preview/pr-1792/src/data/attachmentCleanerIOVerb.js\":\"31ca40e1adaf5317\",\"/knowledge-medium/pr-preview/pr-1792/src/data/block.js\":\"753b780d029cbacb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockCache.js\":\"2c5bae723c469db8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockId.js\":\"0c4ad09dba67040d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockLiveness.js\":\"3fb268b8cb86ef15\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockMerge.js\":\"1ff8e330e932c81f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockSchema.js\":\"543d1982a2c606cc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockTypes.js\":\"904f91592f0ba5fb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/clientContext.js\":\"77daa58e7351a64d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/dbFileSiblings.js\":\"238d34a537d15f3f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/definitionSeeds.js\":\"c91a44c252a8b509\",\"/knowledge-medium/pr-preview/pr-1792/src/data/derivedIds.js\":\"937c565b05049766\",\"/knowledge-medium/pr-preview/pr-1792/src/data/drawnSubtree.js\":\"91647ab1dbd2fae6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facetBridge.js\":\"23459b3eb6079fe1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facets.js\":\"90233c646e9a0eed\",\"/knowledge-medium/pr-preview/pr-1792/src/data/globalState.js\":\"6f87866ec004beef\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/aliasClaimRederiveProcessor.js\":\"a2087b6887adc3e0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/ancestorBatch.js\":\"41a2e3336a495e89\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/blockTypeTypeifyProcessor.js\":\"938deffa55f99394\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/clientSchema.js\":\"6bf272b596e7b302\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/commitPipeline.js\":\"03c422e62d216937\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/devAssertions.js\":\"40e274225a401401\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/firstSync.js\":\"277e6fd01af5f3e7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/freshInitialLoad.js\":\"62ddf15864e75ac0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/graphBackfillClaim.js\":\"d94737fee1bef030\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/handleStore.js\":\"34c40eb0c0e141e8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/idleMarkerJobs.js\":\"6afca174e5731343\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initialDownload.js\":\"7e28ddd49cce6710\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initializeClientDatabase.js\":\"311fe76aef59a581\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/jsonCanonical.js\":\"002139789a7d229f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelInvalidation.js\":\"aa4052870a059bf6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelProcessors.js\":\"07f1490a9943c2f3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelQueries.js\":\"8ab558e3cef04c04\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/mergeTypeMembershipProcessor.js\":\"64272051a08e2f75\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/normalizeReferencesProcessor.js\":\"fc1fcb62052656e4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/poolInstrumentation.js\":\"df493025f83cd5cc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/processorRunner.js\":\"8f91caa0bf4bf04a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyCellBackfill.js\":\"72a4647020b6054f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildMint.js\":\"c239072a10465011\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildrenProcessor.js\":\"dab8e0696c899344\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9f0cbc7ed812dede\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionSynthesis.js\":\"e418036210187ae4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyKeyScan.js\":\"74401e5cfd682938\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertySchemaResolution.js\":\"74bab3ce5da4da7c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/raiseProtocol.js\":\"13dd13a9438c0f53\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/readBatch.js\":\"4c8081b75e984306\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/refProjection.js\":\"3cc4d5846e1e6f49\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetLookups.js\":\"5260a31d0891fdd8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetProcessor.js\":\"98d2e103ca76ccfa\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/replayMerge.js\":\"cd3efe86b60fc4f4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/sqlBinds.js\":\"8564a38a3bb2a3d9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ef8ef3e0bbddb5da\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/arrivalProcessors.js\":\"3c60a8b2ca2274c8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/invalidate.js\":\"33df3f0ee5059bb5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/materialize.js\":\"0d948b78ef7ec097\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/observer.js\":\"f7d1af6d5318ac94\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/reconcile.js\":\"870f9b6826157bda\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/timingMetrics.js\":\"ad4fb34c3a0aca38\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/treeQueries.js\":\"15dfd00f01010ac7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txEngine.js\":\"c826f055df070624\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txSnapshots.js\":\"3f678a933f598565\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/typedBlockQuery.js\":\"5abe99389c89dd4b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/undoManager.js\":\"1a069c6b38606e2e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/invalidation.js\":\"7e2d73536ea845a0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelDataExtension.js\":\"0c8bcaacd63d315f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelPage.js\":\"ae7eda0d3760789e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelValuePresetCores.js\":\"00428e6bf7a32684\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbCorruptionSignal.js\":\"74341967baa64cf1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbStorage.js\":\"4e69c33e3b050175\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbVfs.js\":\"a71e580418658ffc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localSchema.js\":\"3320bdaba1658095\",\"/knowledge-medium/pr-preview/pr-1792/src/data/maintenance.js\":\"402f824645daa7b0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mergeProperties.js\":\"990b9f909514fc38\",\"/knowledge-medium/pr-preview/pr-1792/src/data/metricsConsoleHook.js\":\"c2ca94e26e965ce8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/migrationsPage.js\":\"fffb4a519dedaf03\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mutators.js\":\"2c79b7954c13f3e7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKey.js\":\"ccc0e9c66cb25c11\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKeyPlacement.js\":\"b80f3cfc09e072ee\",\"/knowledge-medium/pr-preview/pr-1792/src/data/outlineSurface.js\":\"b81e70f96835529c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingEditorContent.js\":\"8814ee9d89f66388\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingUploadsSql.js\":\"e8ef55a20ff7d98b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pluginStateExtensions.js\":\"7cf81c3fc3ac085a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/powerSyncLogger.js\":\"6308fcac8063b29a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/projectorRuntime.js\":\"4f1bec7502deb0a1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/properties.js\":\"e76dde5277792fd5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertiesPage.js\":\"afd0eeb006f39f01\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyChildren.js\":\"bf7e0fec84700a2f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionFanout.js\":\"8fd37a844ae67370\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionMetadata.js\":\"1013fd5debd0574e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionRegistry.js\":\"67dfc84504a54dc7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDisplayMode.js\":\"4334b0a8f04d96ac\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyRowCreation.js\":\"6fb4a8949529965a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySchemaCreation.js\":\"62043efbd288f97e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySeeds.js\":\"927998a528229a0f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/recentsPage.js\":\"dac35ea00bf4aff1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/referenceBlock.js\":\"a578702dfd6b7fab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/releasePowerSyncConnection.js\":\"d907af219ed4b1b6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repo.js\":\"16b1980132e1f94b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repoProvider.js\":\"60c90865ec33d179\",\"/knowledge-medium/pr-preview/pr-1792/src/data/rowProperty.js\":\"73d2f7e8914f3591\",\"/knowledge-medium/pr-preview/pr-1792/src/data/searchFilter.js\":\"319ca2e537766e17\",\"/knowledge-medium/pr-preview/pr-1792/src/data/seedIdentityLedger.js\":\"623ee321b4ada533\",\"/knowledge-medium/pr-preview/pr-1792/src/data/stateBlocks.js\":\"b646b289bbf02d9f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/structuralEditPolicy.js\":\"ee240c4f449837c3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/subtreeDelete.js\":\"aaa61837256e44a5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncStreamLock.js\":\"4f0355a04ccba067\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableSqlRecognizer.js\":\"3d510229b7700172\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableWriteGuard.js\":\"3bd04115bd708a06\",\"/knowledge-medium/pr-preview/pr-1792/src/data/targets.js\":\"347957cd39a63202\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeColors.js\":\"669802f81d6d38a2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionMetadata.js\":\"c245fd351b86836a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionRegistry.js\":\"92287e7a7e12c5bf\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeExtraction.js\":\"071008f3ccc22bf2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeInitialValues.js\":\"ac3f977dc530af41\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typePropertyGroups.js\":\"b089f8f776dd22cc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeSeeds.js\":\"1b2aa5d38ea9838a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeTagger.js\":\"65d39f008247d5e2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typedRecords.js\":\"111fab290466b484\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typesPage.js\":\"8a53fb7e32dfdf49\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userPrefs.js\":\"4a4b2911880524d9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userSchemasService.js\":\"be7bf1aa40fc549e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userTypesService.js\":\"1c6c8ddc2c7815a2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/valuePresetRegistry.js\":\"b8e2a18e30076594\",\"/knowledge-medium/pr-preview/pr-1792/src/data/visibleChildren.js\":\"9724d4774dd3205b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceConversion.js\":\"ba1b167f78e99244\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceFirstSync.js\":\"ccf1d12b10880744\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceIdNamespace.js\":\"7ddeeeaef31060fb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceSchema.js\":\"3b0c02429b66f6e4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaces.js\":\"75938c7b04cbf23b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadLog.js\":\"40c29620248434bd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/BlockPasteShellDecorator.js\":\"e9c920a7db03411c\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/atTrigger.js\":\"78d87ae81e722fe6\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/autocomplete.js\":\"a3e946e9d29c96a4\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/codeMirrorExtensions.js\":\"079107869f54e72c\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/contentFlush.js\":\"c89907c188b8d239\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/defaultInteractions.js\":\"ded186ac600fd20e\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/editSettleSignal.js\":\"bc619207b2ce71ae\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/insertImage.js\":\"18b66ea5218ac64a\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceCompletionRange.js\":\"d7e5332b2073aa20\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceTargetTypes.js\":\"df714cc68f529314\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/syntaxContext.js\":\"755ccb13dad222ea\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/triggerMatch.js\":\"600b466587ba2ce3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/AppRuntimeProvider.js\":\"09894ff87a59131a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/BlockFocusShellDecorator.js\":\"f16aec6cba2ad922\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/ExtensionRenderBoundary.js\":\"d426bd05831ebcae\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/PanelContentRecovery.js\":\"69fb806868cf8f88\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/apiCatalog.js\":\"db5c1f0db649b817\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/approveExtensionHere.js\":\"4f71a08965614b45\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/armedCutAppMount.js\":\"53844a391cd58525\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/batchableKeyedStore.js\":\"be68e066ec57e05a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockInteraction.js\":\"9ca5b21f5d452e2f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockSelectionAction.js\":\"871360e26bd38d44\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compileExtensionModule.js\":\"898a67f912a680b3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compiledModuleCache.js\":\"53babb7599834896\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/continuousGestures.js\":\"14422a7013b1b757\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/core.js\":\"93ebc060e16cff3f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/defaultRenderers.js\":\"41137f9c36cffa6b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/definitionFanoutAppMount.js\":\"817b31d29b8b5aa0\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dialogAppMount.js\":\"774e591a7a337e42\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensionSeeds.js\":\"d59f01524634cc4a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensions.js\":\"4a6a55d11d41c41b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/exampleExtensions.js\":\"0a63578b39c17804\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionApprovalStatus.js\":\"478b7b6bbcf9c260\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrorToast.js\":\"d70604e13158b5f5\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrors.js\":\"ee03db3941199599\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLookup.js\":\"45df17bdcef91ee1\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionToggles.js\":\"55247dab77c4f3dd\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionUtilitiesCss.js\":\"b6108192c77e3426\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/kernelPageDeletionGuard.js\":\"35728f59159d1714\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/liveRuntime.js\":\"dfe2f01dc3156076\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/openExtensionsSettings.js\":\"1a281d81eec2dc3a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/overridesCache.js\":\"137e0be565d7502a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/pluginIds.js\":\"67a4d08923a717be\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/processorRejectionToast.js\":\"e8c208ea6e92664f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeActions.js\":\"efc62780dae17815\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeContext.js\":\"22af948021be9935\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticAppExtensions.js\":\"72825bb0d6f1568a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticDataExtensions.js\":\"7b83c3e92dd5ff6a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/toastAppMount.js\":\"ff62177bed869c80\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useOverrides.js\":\"00244fa1541286d4\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useShortcutSurfaceActivations.js\":\"3b1b46516fb86ece\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/discoverToggleTree.js\":\"807c4b91a100ec80\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/facet.js\":\"7baedafca439f9be\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/resolveAppRuntime.js\":\"600159e5bc6d925e\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/runtimeEvents.js\":\"fbf1710b631df879\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/togglable.js\":\"3ea19d93be8556aa\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/variantFacet.js\":\"ae888f5dd018b129\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/verbFacet.js\":\"5c6e2fae38e59d19\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/block.js\":\"0c6e9a4854dc986f\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/focusedChild.js\":\"261a76d3ad77a5cf\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/propertySchemas.js\":\"fb2e0f6e0cb6e162\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/typeRegistry.js\":\"b3857fd5c2a5319c\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAncestorCrumbs.js\":\"e7a067abcd547ac3\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAutocompleteListbox.js\":\"c2b8cc8cd6c5cfc4\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedSearch.js\":\"8d93f0c8a27ae2dd\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedValue.js\":\"78affac4c10f3b40\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsFocalRender.js\":\"b1de2c7cb45ffdfb\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsReadOnly.js\":\"cc8ab4ea62a06434\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMaterializeBacklog.js\":\"d30c842d496a160f\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMinuteClock.js\":\"4c17e94253da2270\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePanelLayoutProjection.js\":\"4497e5295d035b3b\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePendingInvitations.js\":\"1a65fb923f824933\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRendererRegistry.js\":\"a53ef9c90a840c13\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRetainedFieldRows.js\":\"e8f910cec3945736\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useWorkspaces.js\":\"24b5e275dcba7cd2\",\"/knowledge-medium/pr-preview/pr-1792/src/lib/utils.js\":\"6efb7621c99291a1\",\"/knowledge-medium/pr-preview/pr-1792/src/main.js\":\"6b0ab54c660cb54f\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/MarkdownImage.js\":\"9b76d72730eda05e\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/blockSeparators.js\":\"a5b95749d8913614\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/context.js\":\"4b77ae8528f7558b\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/defaultMarkdownExtension.js\":\"23971bb998146f1e\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/extensions.js\":\"2980063a4791af36\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/renderMarkdownHtml.js\":\"78afb4498a025190\",\"/knowledge-medium/pr-preview/pr-1792/src/minimal-editor.js\":\"dbdf1df2de447369\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/armedCut.js\":\"edd13a8bf3e7e3a2\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/captureMediaVerb.js\":\"86d80d7e4b77abd0\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/clipboard.js\":\"fae3ff75dffe4d1b\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/decision.js\":\"64a845bec3d6b14c\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/operations.js\":\"6cb6456f776ad4f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/AccountHeaderItem.js\":\"f47c007c4d56e394\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/index.js\":\"8bed0fb6ba717766\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"11ac5bb755b3c3ce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askAgent.js\":\"25b18dec28bf8b6e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askedStore.js\":\"4f3f3423dbe6e340\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d1c8d5a6fa0464b5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/chipState.js\":\"273febdbf37d1fc2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2155ae939a5674a1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/index.js\":\"a201741a85a5e509\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1c792244c9d98ffd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/schema.js\":\"20552e517715ea3a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6abed53ea24be34c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5eaf2940ee7cdb0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/addMedia.js\":\"3c779d3312e669e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1c2b1a1ed5ee16d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/block.js\":\"bcf97864e4e60b41\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/context.js\":\"9120106817b6be29\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c707affb77e9c913\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/index.js\":\"e7aa25464e0d7de3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/outline.js\":\"20c3beec13d9c2f5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/properties.js\":\"7890f6781987abd6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/refs.js\":\"67d034e5a8464f5d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b84a25aef67a3036\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/search.js\":\"3fcfbb90a351bc79\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/shared.js\":\"055bd446390b125b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"23c3bbfe68ef8591\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/text.js\":\"b225cbf0b7fa8fd6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentWrites.js\":\"5f84fcb94a2555ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/authoringCatalog.js\":\"c48cc8b3a30b4f28\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/blockRefTargets.js\":\"ea8e6905e0ceebeb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridge.js\":\"2e6c222f4c2c5cc4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridgeLoop.js\":\"ed77111c9bb0e10a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/changeHistory.js\":\"93f5d8b3c8252b68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commands.js\":\"8ae3075d443b8092\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commentsCommands.js\":\"a2c508bd575705b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataExtension.js\":\"0f83c9f44e4493f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataModelGuide.js\":\"c5f2429a9e565b0b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/describeRuntime.js\":\"0660221c932aef69\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/extensionLint.js\":\"cbce5129260a8b7d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/grainAudit.js\":\"56bad75e474a3c6a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/healthCommand.js\":\"d48b6a771766018b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/index.js\":\"df069b83ab2f4540\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/presetIdentity.js\":\"078e3f583010543b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a0f7054035cb9981\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/readMedia.js\":\"27a8d849510885ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/schema.js\":\"6ce8ab23b51eb39e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/serialization.js\":\"ba77539bbbacf283\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/targets.js\":\"ff3faa50ba3ec0c4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/tokens.js\":\"65a1969d24a2448f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/watchEvents.js\":\"f5295ae91f774640\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/workspaceGuard.js\":\"277d806673fad670\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/writeCommands.js\":\"51f88f2bd2d028c3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/AliasCollisionToast.js\":\"16d659121071e419\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/DuplicateNameBanner.js\":\"008aa9fead3e76e6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/collisionMerge.js\":\"0619e72c3898148f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/dataExtension.js\":\"f1a988b959f29441\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/index.js\":\"501da52b967ca567\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/mergeCollisionAction.js\":\"561dd780b31090a2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/pageStyling.js\":\"4dd40332a0f49aaa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/rejectionToast.js\":\"f17193f6f696acd7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/syncProcessor.js\":\"892bd613ab2ff0e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/actions.js\":\"cae0a2fa8d85a8ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/addComment.js\":\"7638047c7a780b22\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchor.js\":\"7f628aba991b00e0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchorState.js\":\"6f5c3a3b24bc4470\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/commentLinks.js\":\"b2c0b15ba8242628\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/confirmThreadDeletion.js\":\"d72a61241c56406b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/container.js\":\"3bd98f6f69e2ebd5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/dataExtension.js\":\"3b2091213500f590\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/deleteComment.js\":\"e96370d5f9b3f4af\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/highlights.js\":\"dd0718bd0eaf737b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/index.js\":\"34835c3c67f07aa3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/linkedCommentsPill.js\":\"7efe508f8be1c334\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/margin.js\":\"d9034edf0d792962\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/marginSchema.js\":\"090d3db6cbea18be\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/newComment.js\":\"4ff61cd2fbb1db24\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ownThreadPicker.js\":\"82572f1e171a5caa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/placement.js\":\"97fa33d717f92998\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/queries.js\":\"848ea69c7746320d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotePosition.js\":\"727e9aa3015415aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedIn.js\":\"808e299c7b840c23\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedRange.js\":\"474b459f980e76a3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/rangeRefs.js\":\"f8ef1e690fd82d5d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readHighlights.js\":\"6ee59e9b12f2abcd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelection.js\":\"d336c610a1daff9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelectionUi.js\":\"10d2d248132c1f67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/reanchor.js\":\"96e328e6f157095f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/schema.js\":\"4c89fcbc53c4ab88\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scope.js\":\"eb524599d3780ae6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scopeThreads.js\":\"4e6179af6f011eef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/splitRetarget.js\":\"978264f6365ad828\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestionCard.js\":\"d0063539d6f1f6e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestions.js\":\"d0dab64ffb713240\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaries.js\":\"5934d48b268f2a8c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaryBatch.js\":\"78a1047cf43f6b89\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/surface.js\":\"a7addba8d40aef14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threadNavigation.js\":\"86adc6da7948ef9c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threads.js\":\"2d19d6642d7477ae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ui.js\":\"947ed6473076382a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/uiStore.js\":\"35ee4641b6e3489f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/appIntents.js\":\"4635e1b3167320d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/index.js\":\"0ec5dd8723bcff40\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/index.js\":\"d4f1bb32e2dfa655\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/status.js\":\"57646b8d490c609b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9cd4e5d9a57d99b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaBlockRenderer.js\":\"a0cb09e966c9a2f4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5ba1ab59a8e8d1d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaUploadReconciler.js\":\"017e0745966279d4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetDownLane.js\":\"1d19ebca03371dd3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetResolver.js\":\"efb1975a223a1e96\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetUpload.js\":\"1f0e25ce5bd2d1bc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/attachmentCleanerIO.js\":\"d145795583642480\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2e3f2eeab0d86476\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/blobStore.js\":\"da6f0c4475a3fc3e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/byteStore.js\":\"4f13c29ca8e59b04\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanerIO.js\":\"04cc4c13b7171b60\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanupAttachments.js\":\"5bdd2ef99d35eb59\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/dataExtension.js\":\"686711e95b8d8928\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/downLane.js\":\"8037beae77c7b136\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/index.js\":\"5243c96293bf9818\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/insertImageContribution.js\":\"4933c64fd38a62e8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneArming.js\":\"017d3b482cef8442\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneLock.js\":\"0e2669bdcd527d03\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaBlock.js\":\"bd48d3aacc05172c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaCapture.js\":\"efdf7abb8514daf5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewers.js\":\"20ec6295c0ebc387\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewersFacet.js\":\"53c3a90fdc8c112e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/pasteCapture.js\":\"9054132915d9617f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/resolver.js\":\"cec519ae63c23c32\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/retryUploadsAction.js\":\"9743c22f4a3bf1b0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/storagePaths.js\":\"cca6e96e26c4dbcb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadDrain.js\":\"124f80d84ae631c6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadLaneStatus.js\":\"9551fb70687bc399\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadReconcile.js\":\"190b7971a722d14f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadRecovery.js\":\"d072d7f64fb733f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadStore.js\":\"30690c1059c9dfe4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/useAssetObjectUrl.js\":\"9fa39a3dcc8c6765\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c43f17a2314f148d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d46ed9786a66a66f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/facet.js\":\"a809e11f244aedf4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/index.js\":\"661fa9a7459fdb0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/prop.js\":\"55e4a6a13f4ee6fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinkFilters.js\":\"d91035456820e22f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"870492b0f60ac9ce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BlockEntry.js\":\"8c128f79253cd304\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/LinkedReferences.js\":\"2baa92931c2be48e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"faf46222688b0413\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dailyNoteDefaults.js\":\"0c5ac0db9037835a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dataExtension.js\":\"86758a91fc341c9a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/edgeExclusions.js\":\"208eeaa690921a56\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/filterProperty.js\":\"640f988e2adde502\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/index.js\":\"df7a018517b43067\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e07809b6e92a47b0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/applies.js\":\"cf12177245b96c29\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/countQuery.js\":\"af9ac0f25ca97153\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e9d53bed79fc8431\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/index.js\":\"fd3e8b40fbe130a2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"192044672b478a92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/presentationInvalidation.js\":\"3001bc80c0ab793f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyEditorOverride.js\":\"1a6cf41e9de9ed92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyFilter.js\":\"351bc2caab52991d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/query.js\":\"098bd777a60cfd95\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/resolveFilter.js\":\"015f14411e91a8ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sourceBatch.js\":\"2393d85d53eb4dd9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sources.js\":\"56f0f572fb5dca78\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useBacklinks.js\":\"ea4647f1ee0233e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"566afc12ce071281\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayCelebration.js\":\"9d04c51612087103\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayOverlay.js\":\"c2c7eae577c03523\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/gate.js\":\"eeaff4658ae8e58c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/index.js\":\"cf55ea184861dd04\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/wolfTheme.js\":\"d10473c34dbc1d3d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/BlockDragLayer.js\":\"1637f45805119877\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dragController.js\":\"af5ff73e18ca0c34\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dropTarget.js\":\"c68eed1382a13aa4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/index.js\":\"0c70a56829a728db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/projection.js\":\"6fb00b67f8e39d59\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/BlockMetaCard.js\":\"c9374d1777b781cd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/index.js\":\"188649d068732c57\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/AddTagDialog.js\":\"ebbb939ddb059a94\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"9e28bdf5165ae1d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/TagNameIssueHint.js\":\"1b77ea8febc696e6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/addTagAction.js\":\"7629170546981605\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/appendTag.js\":\"836f7a3592c96cdc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/config.js\":\"b78f852c4e1b843f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/dataExtension.js\":\"e24ba59c933b1edb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/index.js\":\"c566f152b2cf175c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/propertyEditorOverride.js\":\"f76847929114ceb6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b9592f6cdf3ad855\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c87d195a3e18458a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6988318d3eb6c248\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4f4f817744a100e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"bb6fdd981a2412f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/index.js\":\"4536cc0285a8ce7b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"71d620363dc5a84e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/CharacterCountItem.js\":\"b8477d024163949a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a27d5b2ecaf21f9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/actions.js\":\"354384bf29c1c259\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/blockType.js\":\"87c25ac0145609f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/charCount.js\":\"7280f6abe014a413\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/dataExtension.js\":\"e969def082371f53\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/index.js\":\"b54a04d06fd04af5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/profiles.js\":\"39659c829711e723\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/properties.js\":\"766537c65c0bb832\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/textCounts.js\":\"bd98b3ce1dee1c35\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/colemak-keybindings/index.js\":\"49cc040e842b9a44\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/CommandPalette.js\":\"820594a6755bf70a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/HeaderItem.js\":\"0310904253433069\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/context.js\":\"decdab73cec068f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/index.js\":\"74d43e39db227f52\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/selection.js\":\"8406a64ceac02e62\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/toggleStore.js\":\"bb3126d9c055d04d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/useCommandPaletteActions.js\":\"a4b71e2b3a5a9870\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/ContributorBadges.js\":\"d897027154c5a1aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/author.js\":\"b9ebe39735a6f2f3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/codeMirrorExtensions.js\":\"e90fa1495ba7ef31\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/dataExtension.js\":\"17c539b76599354d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/index.js\":\"bec98f30ab7e528c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/mentionAutocomplete.js\":\"a5671d1474a2b4a6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/processor.js\":\"3489c413157e30b4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/profiles.js\":\"786938a03f00ec6c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/queries.js\":\"ef38b15a9ee6ca03\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/schema.js\":\"58510b1189b3fb7d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e013d43d9f74a660\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/followOrigin.js\":\"cc22476150899f39\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/index.js\":\"d8ab8bec8bb24d04\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"28f763d1bcacddae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"620a275c7dc42669\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/CalendarGrid.js\":\"5d4e9bf334751d15\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DailyNotePicker.js\":\"f37e0b1c28ecd521\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8c6eb3c6454adb8c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateNavDecorator.js\":\"866e66a4aa566823\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateScrubOverlay.js\":\"8f12581b9c8405cb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/HeaderItem.js\":\"f84b0e00f6aa33c0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/ReschedulePicker.js\":\"aef460952b01a214\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/SpreadDatesDialog.js\":\"83d3b981928dd8dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/actions.js\":\"ca2c812c4ccccf57\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/blockDateAdapter.js\":\"8a1d1ccab020a990\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/calendar.js\":\"89170847348d0e70\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dailyNotes.js\":\"0fc0360ed90f0fe6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dataExtension.js\":\"4fb10adb7dbdc073\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubActions.js\":\"bc4a301ef7763299\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGesture.js\":\"6e1d101047d1bafc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGestureActions.js\":\"eb24f28fdd3a8771\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubRecognizer.js\":\"319cb1ce75092b96\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/deletionGuard.js\":\"2c4f463c07718830\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dueQuery.js\":\"60a2e980f05877ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/index.js\":\"357fb27174bda620\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/landing.js\":\"845fc8c79be96ab9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/localSchema.js\":\"50b97e2a0dddeba3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/referenceDateAdapter.js\":\"8490f49befbbb1d5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/rescheduleAction.js\":\"7bcb6e0a6523177d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/schema.js\":\"7137f46b7a501601\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadBlockDates.js\":\"ebdd8bd5bbbafd66\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadDatesAction.js\":\"e8282925e6253d7e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/today.js\":\"46c74b0d2f7d3cd4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e15883245417e273\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"37fd53698f20dcab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/audit.js\":\"04af6864d1ab6e00\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditAction.js\":\"f9d3d90839141d12\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditRanges.js\":\"5772a413e98a23a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/diagnosticsSource.js\":\"394863b092bc1508\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/divergenceScan.js\":\"93b686053c208320\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/index.js\":\"c84cb19b71e54cea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/propertyChildrenChecks.js\":\"16efe88cb566966e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/referencesMirror.js\":\"98b6c0cc4b89b65a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/rowJson.js\":\"aec0a8577363f6df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/schedule.js\":\"68984cbba6842c50\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/store.js\":\"725332ea64b4aeef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/action.js\":\"5cbfc9650d57bcc4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/index.js\":\"a8c18745cb7cb71c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/plugin.js\":\"d17dc32efa28f79c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a3709ca684a61197\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/actions.js\":\"98a7188b97c082f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/changeMarker.js\":\"ba320748d657db3e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/diagnostics.js\":\"6da88c4859fa1677\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/fileSystemAccess.js\":\"50fe9b9688e7e42d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/filenames.js\":\"880906ecf8a8e74f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/index.js\":\"264e8c2405e7b343\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/mirror.js\":\"24495c5184bf8eaa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runLock.js\":\"0b84057f4873dbed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runtimeHealth.js\":\"7a695f3a4b1e4b7a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/schedule.js\":\"ffd3047181668528\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/store.js\":\"56f587c50445977e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/index.js\":\"c890cd77e20fa1f4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/themes.js\":\"ed25b9577ad0c92c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/facet.js\":\"ebe7f4ee265c9401\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/useDiagnostics.js\":\"17878b5a0f139803\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/dismissals.js\":\"0df64d4110ef361a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/index.js\":\"9a39bac4b0b6bbc3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/status.js\":\"57961d49e44a717f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/store.js\":\"92c532a46b3d8d30\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ba7016534c5b0f20\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3264dc5387f2b8ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/actions.js\":\"fd60ab01188e7384\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/config.js\":\"01e542f4db2ea644\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/dataExtension.js\":\"44b6bd417d4e1698\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/effect.js\":\"aec3d40f087c8d6d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/index.js\":\"5cc9419e8151b35f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ce2a6d171d410e9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/useToggleTree.js\":\"66e23a90b172b0c7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/ExtractTypeDialog.js\":\"e69d69b863b9bbac\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"490e3bfc2ecde263\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/PropertyShapePicker.js\":\"49e86a53d05b6ba4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/action.js\":\"a920cde29dcc4fda\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/index.js\":\"d24d46ff06cdc421\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/FindReplaceDialog.js\":\"82d4826b972c757f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/HeaderItem.js\":\"ccfa3886dbbd1719\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/dataExtension.js\":\"e41412a8af089805\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/index.js\":\"0a087af7a305c3b8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/search.js\":\"4e4b616f1d2f8c9f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/toggleStore.js\":\"a3bec05d69596b56\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/LocationPropertyEditor.js\":\"353b5a6879a80c73\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/MapView.js\":\"01da87bb9b89638b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/blockTypes.js\":\"35884f7e6d9ba688\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/codeMirrorExtensions.js\":\"dfe9887f4745777c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/createOrFindPlace.js\":\"4a8bdf5cd099c3d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/currentLocation.js\":\"99bdaa176a1ba8ff\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/dataExtension.js\":\"0d1923897bef36a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/geoContentDecorator.js\":\"f7b3aae176ffad88\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/googlePlacesClient.js\":\"fbca8f9d6aff9dc7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/index.js\":\"c00cc35b215b8c0a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/locationsPage.js\":\"4eea037680869d40\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/mapViewport.js\":\"fbc1adc70290c183\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/pickCurrentLocation.js\":\"a263db972d1761e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeAutocomplete.js\":\"8d181527564276ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeNameCollision.js\":\"4bb0a0c8114821d0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/properties.js\":\"d5d1ec68eefac27d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/propertyEditorOverrides.js\":\"6df3dc3072587b9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/query.js\":\"738d195a153a684e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/usePlaceSearch.js\":\"1237f088602ee5f8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d0c7bacecc1552d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"24f3e42bfc3a56d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5a2bd186f55eccd4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/config.js\":\"ca35f8e39e8e9523\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/dataExtension.js\":\"ec9d0f303d747303\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/facet.js\":\"78956c2b89374eb7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/grouping.js\":\"3420bc1c63baba0a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/index.js\":\"eabaa01412ebf61e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"63481b87a765d689\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/query.js\":\"97aac42d9e80fde4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/resolveConfig.js\":\"b5e7e8fa8dc4dddf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0a93223e8d5a4779\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8f5282d1969e7e81\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlDocumentContent.js\":\"866228b69cc7b6ec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlFrame.js\":\"09fef6f1ff9e2f1e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/actions.js\":\"05db2104dd37fc1f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/blockType.js\":\"8dd4fa8aa1b3a229\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/confirmRunScripts.js\":\"54c7520c8ee61d8d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/dataExtension.js\":\"2b6d30d0f92de0f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameAnnotations.js\":\"78c50e94b707d4ad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameDocument.js\":\"0372d2afc958104a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameTheme.js\":\"e596fcb6dee916c4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/index.js\":\"e555d39d650e6ebe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/scriptConsent.js\":\"87d790493d7a3b21\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/sourceMap.js\":\"ac80d40eed881211\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/useDocumentScripts.js\":\"89379b19a1072a39\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/index.js\":\"b0eb02ba461d3d6d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/record.js\":\"5713cd5cffe5276e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/recordStore.js\":\"c1512cfcf8ca3f99\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/responsiveness.js\":\"8dfed7289cb0505b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/schedule.js\":\"166b0b2f27c76a4e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/sessionContext.js\":\"0b2e94d601ca2d8e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fb0acc75870e3dfa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"378e4dcb41869241\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/actions.js\":\"3fc97677c64c6c1d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/config.js\":\"f24b80e541d4e7bd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/dataExtension.js\":\"4fde9d608d220342\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/effect.js\":\"29ec45b70f1dd011\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/index.js\":\"af9d8450093b213a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/keyCapture.js\":\"f3c384caa3fe2c5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/overrideStore.js\":\"24246cefa0f75c2b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"357d06a18fb3b8f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/HeaderItem.js\":\"b2a6e9da4c884289\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/LeftSidebar.js\":\"84ad35f37f989f90\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/actions.js\":\"fc08a7fa4d3284cb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/facet.js\":\"dcbdf867c2f3d560\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/index.js\":\"8d70e6488ddf1f44\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/shortcuts.js\":\"ad72e13b9a82a0a0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/toggleStore.js\":\"f50c71cb9f279ec3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/MergePicker.js\":\"7e7e387bd7ba3c3e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/index.js\":\"b5cfff738a163b30\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/mergeAction.js\":\"9e1b7edd7f971821\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/strategy.js\":\"48d14bcfdb850ca5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/Button.js\":\"661716e5fa8c4e18\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5b0161998ea4ebcc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/defaultItems.js\":\"efe84398301a0df0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/facet.js\":\"537b5883e949f8f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/index.js\":\"ac9a5849871a7ed9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"23bef913f52e8a03\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6874d4062ab14d10\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a24caca796362276\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c4a3da3163f818d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/index.js\":\"595b19d756ea2d30\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2be39ad2b7050d84\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c160cee25da297aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/contextMenuItem.js\":\"2e5aaa59e326d154\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/index.js\":\"d02203a7f94756b8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveAction.js\":\"d6f143e0c07666c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveBlocks.js\":\"2e877cf2b4aa7cfd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/selectionAfterMove.js\":\"cc479f985838a268\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/TutorialBanner.js\":\"8c73073022251086\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/action.js\":\"d61e628ffaaf6bba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/bannerDismissal.js\":\"bab53718643676ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/documents/cheatSheet.js\":\"c188d0730e12add2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/index.js\":\"4ef9b11053db516d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/keys.js\":\"3ac874e7e4e5b8b0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/landing.js\":\"7c1e17daacbf7025\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/outline.js\":\"055d37829fae7b0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/seed.js\":\"3df44f35f7d8eb2d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/PerfTrendDialog.js\":\"34613d4a30718cfd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/analyze.js\":\"f659f6c5ded84d62\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/diagnosticsSource.js\":\"e38504cf4b637342\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/index.js\":\"5e308e3b223bb26b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/load.js\":\"b6ca499ab7e2be8b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/monitorRun.js\":\"e68e6bc729775cb1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/schedule.js\":\"615b223356208b46\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/series.js\":\"60661ccf03d52b14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/store.js\":\"21f309234f2d8463\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/trendAction.js\":\"cf3f4a9d889c03f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/verdict.js\":\"08d978741fdc64fb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/clickToEditAction.js\":\"819529f7af5da62a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/index.js\":\"50aa0f0ada0de638\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/interactions.js\":\"e3c62f8988e0139f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"237a2cac2a1797dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGate.js\":\"ac7789e9ead0a71b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGateDialog.js\":\"e90bd121c58aa668\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/action.js\":\"c4a2d2fec995b5b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/index.js\":\"6356787daf1b7f33\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/localRunMessage.js\":\"cfe8b38c2c3425b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/plugin.js\":\"05b36ecd97774228\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/progressReport.js\":\"a062be60a84bb36f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/sweepProgress.js\":\"1f2fa81e452306b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/FieldRowRenderer.js\":\"e2bb690e3963a48a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/ValueRowRenderer.js\":\"c4f7dccf80478c20\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/actions.js\":\"2af49ef35e80b28d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/autocomplete.js\":\"ee1f29d47253dde0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/fieldRow.js\":\"b64bad9020b36023\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/index.js\":\"3151501fcbb9de28\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/referenceWarning.js\":\"311cc0695d310341\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueAutocomplete.js\":\"fda27594028ca70c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueSchema.js\":\"b029fefec4c08bc6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/HeaderItem.js\":\"e230df4bb6f75075\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/QuickFind.js\":\"19f595f13e169f4a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/index.js\":\"39142ef51c6d33df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/recents.js\":\"8c2231f74107466f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/resultItems.js\":\"b51b46fdba4a1f2b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/selection.js\":\"37bbd2b4e7fe512c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/toggleStore.js\":\"ecef222840fad92a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/HeaderItem.js\":\"aaaa6e93ab7617f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/RecentsPageBlockRenderer.js\":\"118e1ee5cbf02885\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/grouping.js\":\"b22fcaba6fa0cc89\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/index.js\":\"8de920a5626d8d09\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/target.js\":\"20ea24c5e5f79d4d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/codeMirrorExtensions.js\":\"c00fbcd759cf7d71\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/contentPrefill.js\":\"24f6e9fb93789bb3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/dataExtension.js\":\"e998b451f69738a6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/index.js\":\"f0a00acfefd27f61\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d4ed487772a87c16\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/invalidation.js\":\"4b517a904d9d957b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/localSchema.js\":\"bb515899f6cd08b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/index.js\":\"d265e3d9b4250e92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"53d4367a79606822\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/index.js\":\"08db41824f2d8fcf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/referenceNode.js\":\"2355742650e3ef5b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/remark-reference-occurrences.js\":\"db691bc8b8275b8d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"20034926634ded1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/index.js\":\"25ed461f79539bcd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3faf8137247f356c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3e305f95e46ba506\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/mergeRetargetProcessor.js\":\"f939c4e00e1b5350\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/parseFence.js\":\"0b3d84ebf79e74db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceParser.js\":\"0dd03328ad2782d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceProjection.js\":\"d95694637ff3fedd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referencesProcessor.js\":\"5e05ddb6943f8a92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/renameProcessor.js\":\"8cc304936acb806f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/spanReplacement.js\":\"83835c735aeeb3fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/htmlToOutline.js\":\"4a3cff92d35bbd8b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/index.js\":\"049b74c37e95b30f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/normalizeClipboardDom.js\":\"262cb1db56565d22\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/pasteDecision.js\":\"d6a66d9078f11ab6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/action.js\":\"d234416c36f03450\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/blockIds.js\":\"69d1d5b1f2ee3bc1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/content.js\":\"769c28cb543e2511\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/effect.js\":\"39ec60f08644510a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/ids.js\":\"25831f5177e1d8d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/import.js\":\"69d013f9de741e21\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/index.js\":\"6f1af5bc27b969b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plan.js\":\"874ee4db4ade9235\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plugin.js\":\"8cf3a6e2cba6e443\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/promotion.js\":\"52dce89edaab67cb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/properties.js\":\"c0a44a0d60d869c9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/references.js\":\"a1c432af63d4192b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/report.js\":\"3eeea1f71428666f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/roamMemo.js\":\"00eab430a15e84fb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/runtime.js\":\"dc6935fdb1c548c7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/schemaReconciliation.js\":\"674937ab5774b586\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/srsMarkers.js\":\"77207df9f4e9603a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/todo.js\":\"87333a2b1c86a7ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/typeCandidates.js\":\"6e1c9e6ea8791e68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/types.js\":\"483fcb7f537907cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/index.js\":\"7bcdaf50bcdde30a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/store.js\":\"f60e54ed7e2d1213\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/HeaderItem.js\":\"84d7dbba08b8dbda\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"63fcddc3d3c50926\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/index.js\":\"46c70d870f59aed7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/model.js\":\"5805134a3d4a6ef7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/toggleStore.js\":\"ee72b9a56f433b95\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/useKeyInspector.js\":\"30ef809fe7d6c09f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6fea6b5e616c96d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/ShellDecorator.js\":\"c8a7954496dfc47a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/actions.js\":\"377d6d75d9d2ace6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f868a4c595d2a3eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/index.js\":\"fe14ae1cb73656ac\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/shell.js\":\"91ff6220aed0b630\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/surface.js\":\"ad4e2ca5d073d29f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/walker.js\":\"da529ad30a45848f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3aaa766e363c3e7a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/dataExtension.js\":\"dfe45412be25ec59\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/index.js\":\"320817c47fd5e3a8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/indicator.js\":\"b16d64f478c3c139\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/moveSrsState.js\":\"6400d8707e6400be\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9595f1a213bd28e5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/scheduler.js\":\"61d42f315a5c8306\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/schema.js\":\"a354ae09f37d1add\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2b0b052cd97e5e02\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsClipboard.js\":\"97c1b633b1904e44\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6ee56940aba3c372\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DailyNoteReviewHint.js\":\"24f7684583d10efa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DeckPicker.js\":\"5a057a52c4f82715\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewControls.js\":\"891057c5f2e9e600\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f923ecce2c7c487e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewSession.js\":\"25007d728862b77e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/actions.js\":\"49d6da156c040922\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/archive.js\":\"f5ab8abcb8aa8d1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dataExtension.js\":\"50264ad993e6fbb4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/deck.js\":\"57e4da204b850219\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dueQuery.js\":\"9532422387aec756\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/gradeDecision.js\":\"b1c2f414efce6eaa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/index.js\":\"71cf3eb47d92b8f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/keyHints.js\":\"6b0c6423c11e2a2a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewCardLayout.js\":\"91e5a919544c4258\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewProgress.js\":\"b1c52a751e5cb202\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/schema.js\":\"4c678926f9433e5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/useDueCards.js\":\"08b295cb5a6fa9d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/index.js\":\"c6c1ce5e4e94337b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/record.js\":\"37ae44e9c4ed0cf1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/index.js\":\"9dfd856ceebced14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/persistenceStatus.js\":\"7bd2f0d804cf374e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/requestAction.js\":\"219eedd37d2f6b2f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/TypeChipsDecorator.js\":\"840f345f384d8891\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/codeMirrorExtensions.js\":\"fb8c439ce2f8bc6c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/index.js\":\"c167e53045d4a08a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/typeAutocomplete.js\":\"ff7a136c36d00723\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c4ee42f8b97e7abd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/actions.js\":\"33090aa117664916\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/anchor.js\":\"eb326a1130fd3f9d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/events.js\":\"e6299c5aaa344c9a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/gestureActions.js\":\"10fd7807bf0080d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/index.js\":\"9e239047b31b64a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e3e43cd3644d202f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/collect.js\":\"e8c30a0bc4ea23de\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/index.js\":\"0550e4bd66a36910\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/record.js\":\"9c5ca8ae2e805e15\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/RejectionDialog.js\":\"bf05f159ac7c353e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a254f93fdfbd6ff6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/index.js\":\"577d482e69edb959\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/model.js\":\"44c15c5cef57814c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/queueCounts.js\":\"eea2cab8080c382b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rejectedHelpers.js\":\"f84706f44477d2ba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rematerializeAction.js\":\"d68ea4426302d816\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/useHysteresis.js\":\"d7e09a98da38d27d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/effect.js\":\"6c4104e8f7227f70\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/index.js\":\"8e56291c7fd46624\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/theme.js\":\"5ee404a76e882190\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/actions.js\":\"e7fed3b99201121a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/dataExtension.js\":\"01af7a4d8ebdcd9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/index.js\":\"68422edabd4b6786\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/schema.js\":\"beab6a5ead1fbc2f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5f13fa54a88aca57\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/actions.js\":\"6b966b2d82fbd793\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/defaultItems.js\":\"ece4add687877358\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/facet.js\":\"25a7877e630e5544\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/holdRecognizer.js\":\"0aa7038b52816f89\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/index.js\":\"ac7a73c7337b214e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/UpdateIndicator.js\":\"44d503dbdf9db0db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/index.js\":\"c520ca3abd2ec18d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/loadTimes.js\":\"c10979c85bed36db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoNotesRenderer.js\":\"1f11bb4111289131\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoPlayerRenderer.js\":\"85eaea78db2856ad\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoTimeStamp.js\":\"fcb19b0ceeddd757\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/actions.js\":\"a46a1ae7021ce3a8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/index.js\":\"aa6c291a26cae076\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/markdown.js\":\"5fe2fef090fe220b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/notes.js\":\"2f42732354ef7929\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/registry.js\":\"49ed328cc363d887\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/remark-timestamps.js\":\"bb97ea2d9bf66b9d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/view.js\":\"5976bb798a7e5d50\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/LinkHints.js\":\"28a8518a9f902efa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/index.js\":\"f532bb5ecf110f0b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/model.js\":\"44040b6c2fbba9a8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/settings.js\":\"6c78aa1184796357\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/actions.js\":\"596b4d1bce2bbe0c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/index.js\":\"6724e8ecc3eae181\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/interactions.js\":\"006a12c398709474\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/workspace-header/index.js\":\"5b7d39642d260b82\",\"/knowledge-medium/pr-preview/pr-1792/src/registerServiceWorker.js\":\"1bbe6fd37a2d5234\",\"/knowledge-medium/pr-preview/pr-1792/src/requestPersistentStorage.js\":\"46d1df5aff529fb7\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authRequestDeadline.js\":\"39fecbcb26684a4c\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authStorage.js\":\"c319cd9babe56694\",\"/knowledge-medium/pr-preview/pr-1792/src/services/powersync.js\":\"b9d33b8d67d0da60\",\"/knowledge-medium/pr-preview/pr-1792/src/services/supabase.js\":\"9ab0825cee7ea221\",\"/knowledge-medium/pr-preview/pr-1792/src/services/uploadErrorClassifier.js\":\"005abed4bb88b07b\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/ActiveContexts.js\":\"7c0888f535177aef\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/HotkeyReconciler.js\":\"5d9eb2b24f0528a4\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/WipeLocalDataDialog.js\":\"746455f825099f95\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionDispatch.js\":\"2319c0bfb6ab2353\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionRefItems.js\":\"3b8569647a828eea\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/applyKeybindingOverrides.js\":\"86b09db8dd481ebe\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/blockActions.js\":\"3bc22156ea136f62\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/canonicalizeChord.js\":\"964d2d29c5c436de\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultContexts.js\":\"2e3e61deab0dac2a\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultShortcuts.js\":\"0ed23613a128a335\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/effectiveActions.js\":\"7e8e00b5432a47a2\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureAction.js\":\"bcb2c7533c84b682\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureBinding.js\":\"f840c7da8ee9123d\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/holdRegistry.js\":\"747f39a07e67f866\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingConflicts.js\":\"ba51b1219d6a586c\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingOverrides.js\":\"a1656ea903681471\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/pointerAction.js\":\"a67e4e86e4032a0a\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/resolve.js\":\"e189144efb18a972\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/runAction.js\":\"c0b9f27ab92625a2\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/sequenceMatcher.js\":\"4f304c8e6dd17d48\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/types.js\":\"4a07402d78e347ee\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionContext.js\":\"057dcab37e888ba9\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionDiscovery.js\":\"7757ccac82d06d3f\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/utils.js\":\"abf41954e0f72355\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/bootStore.js\":\"fdcc611393d6257a\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/previewDatabases.js\":\"e0c22ae92da45a6c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/byteTransform.js\":\"c401e24ab029eecc\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/attachmentCleaner.js\":\"7e8e4b49cca2f841\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/attachmentParts.js\":\"09ee6fe6a04504bb\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleParts.js\":\"a2c3082e5fbbd938\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleRecord.js\":\"f7bb654a1ad340e1\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/manifest.js\":\"ace4319da8c98618\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/takeBundle.js\":\"cd52b01f4c38b2c8\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/verifyBundle.js\":\"6ee9c9b1c5e6f196\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/cleaningStage.js\":\"304fadced1e85471\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionKey.js\":\"059565e552514121\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionServer.js\":\"cbb6f32a02321ab5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flip.js\":\"37840a27e2ef0b04\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flipAttempts.js\":\"e53c4844493238a2\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/pages.js\":\"a43afd9e2d3b49c6\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/preflight.js\":\"18d5448f590203de\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/reseal.js\":\"95c1e0cea859a126\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runConversion.js\":\"b63a81a12a36a285\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runLock.js\":\"488250d9f05460b9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealing.js\":\"b8582e6ac7dd9975\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealingStage.js\":\"2e9f3eed4d2e0cbb\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/stage.js\":\"a4bd022db0f0d329\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/verifyReseal.js\":\"ce0977415cdd2a01\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aad.js\":\"0a76676fe7ec2ddf\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aead.js\":\"365995021291487e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base32.js\":\"71a312e7ff32fe43\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base64url.js\":\"1f53a7623bd2e040\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/binaryEnvelope.js\":\"12f30ebdfc9045ec\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/byteAead.js\":\"df17d0d7bf8f13c9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/canary.js\":\"72b15638b62c2144\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentHash.js\":\"16fcbe94d092c146\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentKey.js\":\"9dfc1ed39ef6fd6b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/derivedIdNamespace.js\":\"493f48800738e2b5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/envelope.js\":\"fe82f7cd37edaa7a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/hex.js\":\"3b9725861d5d48f4\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/sha256Hex.js\":\"6bfa36d2a4566a59\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/workspaceKey.js\":\"5c0dab908a6aa0f3\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/conversionState.js\":\"4848a30d59bf19bf\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3e4b1775bcafd2be\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/pastedKey.js\":\"8f754cb2fe433e45\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0decbb504f7f8e33\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/upgradeWorkspacePin.js\":\"042f1a4e23bb4dd4\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/keyStore.js\":\"b074de18a9276549\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/mintWorkspaceKey.js\":\"8373e978816b2c48\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/modePin.js\":\"516a0714b38a7f68\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/openWorkspaceKeys.js\":\"80154cdc96cba931\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolveWorkspaceEntry.js\":\"2e7c4dc83b389ac6\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolver.js\":\"d1d3a4e857e81a15\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/workspaceAccess.js\":\"8a647febc6438372\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/transform.js\":\"38cc64d170bb9a02\",\"/knowledge-medium/pr-preview/pr-1792/src/themeBootDefaults.js\":\"4ccef8e423c8a74b\",\"/knowledge-medium/pr-preview/pr-1792/src/types.js\":\"d18fcc82a4987897\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/ClientLocalSettings.js\":\"25eb752cce4a4306\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/abortableSleep.js\":\"276dad99fbbf0ffe\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/array.js\":\"c9ff0ff0bdcc4bb0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/backlinkAutocomplete.js\":\"17220f3461c041ed\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockCrumbs.js\":\"a2f19e6d89e8fb9c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockrefAutocomplete.js\":\"1e845a052e02ef8c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/cadencedIdleJob.js\":\"2868911292531df4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/callbackSet.js\":\"609aa178f4b891c7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/clientId.js\":\"7a5def50c2029856\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirror.js\":\"fdc33fbb79d1d1a4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirrorCompletion.js\":\"4215111e05193c41\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/copy.js\":\"33a33acef666da47\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dailyPage.js\":\"5f56eda2e825ef32\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensics.js\":\"d4fc7ac4abb15527\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensicsHooks.js\":\"bb998c855c484025\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/deleteBlockThroughUi.js\":\"94d72dc5d0a04e17\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dialogs.js\":\"1e29d789e3014b39\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dom.js\":\"93cd4fae3f4c80e4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/downloadBlob.js\":\"9f307c07709227b8\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/exportSqliteDb.js\":\"893e3e47d83f43b5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fileSystemAccess.js\":\"748b16839f8ed887\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/flipSlide.js\":\"74a4e02fe5239f16\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fnv1a.js\":\"9126624954d18369\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/formatBytes.js\":\"d6327b7e8965dfde\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fuzzyRank.js\":\"321c88b03a2ab902\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idbKeyedStore.js\":\"faf7317bb9d4a8a3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idleCallbackPolyfill.js\":\"cb118e7aca24c3fa\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardAwareScroll.js\":\"2aca89d39069adb7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardViewport.js\":\"c4b1d6fe285b4531\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/lastWorkspace.js\":\"34f1b7a6f0f3f380\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutColumns.js\":\"55fc5c7dfde9f19a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionDom.js\":\"e9be7ea4e7f31878\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionId.js\":\"8f2db4a37a485804\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkClickGestures.js\":\"58a89c950d9f7ce3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkTargetAutocomplete.js\":\"56a7957de5d03c3c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbCorruption.js\":\"e407b4352ce62877\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbRecovery.js\":\"02d8353c7336e9a0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/markdownParser.js\":\"43b2832b394e7cf8\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/memoize.js\":\"aea96f049a77eab7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameFieldCommit.js\":\"c72d7cac50738ad5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameList.js\":\"6593107678b7c12e\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/navigation.js\":\"1ab5726ba3e5542c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/omnilinerNamespace.js\":\"65b016acc0535928\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/opfsPageScan.js\":\"4d7877b4221991e5\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelClearance.js\":\"1d0d98270922defc\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelHistory.js\":\"3684db143128ab78\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLanes.js\":\"12a62f256b466ec4\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLayoutProjection.js\":\"0df65fa835d113c9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelScrollAnchor.js\":\"8e3dab6b7c7bbecb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelUrlFlags.js\":\"f31f1f061b860719\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/platform.js\":\"0e6ccf05de0cffbb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/pluralize.js\":\"8ae6ddfddaeba398\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyCreation.js\":\"3595eb260f2f3039\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyNavigation.js\":\"b4f1a14f2ddf8764\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyValueContext.js\":\"e043332728d733b8\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/react.js\":\"453d81a599df2239\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeDate.js\":\"a8c52ad1a84e0fd9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeTime.js\":\"9eb77d5c541039d3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/renderScope.js\":\"b80a96fc455c26bc\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/resolvedThenable.js\":\"0c771843d77bdbf7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/routing.js\":\"a847530cce700bff\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/safeMode.js\":\"fde255da746d0d68\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/scheduleIdle.js\":\"8d704998f273e89a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/screenWakeLock.js\":\"cbc1f7be8e59919e\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/selection.js\":\"1ebf1ae577e5b4b3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/softKeyboardGrab.js\":\"771df0879f841a8b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/startupTimeline.js\":\"716bf7f22858909f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/state.js\":\"49f97fa4699e454f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/string.js\":\"34749295fda93ad6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/surfaceZoom.js\":\"ed78b3ebc853ddce\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/time.js\":\"76104fd5754b87eb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toast.js\":\"80b1ca1c2f1f8eda\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toggleStore.js\":\"555d172eb06cff58\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/untilStopped.js\":\"ac00c4b66c2ee873\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/userActivity.js\":\"9c1539582aba71cd\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewTransition.js\":\"a19ea7f87e8913ba\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewport.js\":\"455f6be705185e9b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/webLock.js\":\"b56be2b8914549c8\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceRecovery.js\":\"0cb6e1460383ece1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceSnapshotStore.js\":\"fbccafad2b27749a\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-compiler-runtime.js\":\"be792f78fd686fa8\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-client.js\":\"d73a6f4a76e3ab30\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server-edge.js\":\"001bca522e690713\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server.js\":\"2815dabc949e1b1b\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static-edge.js\":\"ad0220e4b93e2b68\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static.js\":\"8e9b7522528c38cd\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-test-utils.js\":\"c423b4188540eea5\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom.js\":\"c9aeaee918a24585\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-runtime.js\":\"53e36d64d8f1d493\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react.js\":\"ba037d955a1153c1\",\"/knowledge-medium/pr-preview/pr-1792/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
