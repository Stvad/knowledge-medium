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
		buildId: "7ff2382a9ab5-14bf5c39",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/\":\"d61b71889f02f52f\",\"/knowledge-medium/pr-preview/pr-1792/index.html\":\"d61b71889f02f52f\",\"/knowledge-medium/pr-preview/pr-1792/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1792/assets/FacadeVFS-DK_m4b1Y.js\":\"4bb791addfac3c12\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSCoopSyncVFS-Zqtg_HSC.js\":\"592db766baace772\",\"/knowledge-medium/pr-preview/pr-1792/assets/OPFSWriteAheadVFS-BpV4uArO.js\":\"b6e82fc411767c60\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-C5JwTb57.js\":\"2036114e522e7b90\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/assets/wa-sqlite-async-D2n_Bu4X.js\":\"273a25129a94281e\",\"/knowledge-medium/pr-preview/pr-1792/assets/worker-CNaCKKyd.js\":\"b0b355ab45606872\",\"/knowledge-medium/pr-preview/pr-1792/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1792/chunks/app-BJtOJ-B8.js\":\"d7285ab75fef9f5a\",\"/knowledge-medium/pr-preview/pr-1792/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1792/index.js\":\"3c5abd5169545a2f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1792/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1792/assets/AccessHandlePoolVFS-DfigPRIs.js\":\"d32bc6e08a10b20a\",\"/knowledge-medium/pr-preview/pr-1792/assets/IDBBatchAtomicVFS-CdFFIkSz.js\":\"e115a0a7b12a5a6d\",\"/knowledge-medium/pr-preview/pr-1792/assets/MemoryVFS-CyGGf8x8.js\":\"0f96075ab673944f\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-CT_C0yjA.js\":\"be4b1aa564c15771\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-BWiDfXtw.js\":\"e49beb7cafd65848\",\"/knowledge-medium/pr-preview/pr-1792/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1792/chunks/AccessHandlePoolVFS-Dhwcnl1I.js\":\"754f8732dd864ae2\",\"/knowledge-medium/pr-preview/pr-1792/chunks/FacadeVFS-ClKgwRWW.js\":\"a9911789af1fce31\",\"/knowledge-medium/pr-preview/pr-1792/chunks/IDBBatchAtomicVFS-CODxAmu5.js\":\"a5a6e85d8adb4fea\",\"/knowledge-medium/pr-preview/pr-1792/chunks/MemoryVFS-DvKqp4w-.js\":\"2631f6569bfc20bd\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSCoopSyncVFS-DyzBVInV.js\":\"172d76d175b246f9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/OPFSWriteAheadVFS-jM9QdIoM.js\":\"0e3487d39e46b36f\",\"/knowledge-medium/pr-preview/pr-1792/chunks/Preview-DtAikckE.js\":\"be70d81218e1ed2d\",\"/knowledge-medium/pr-preview/pr-1792/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1792/chunks/card-of_fSyqy.js\":\"d91dc82d9c972922\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-B6tQyMIH.js\":\"1c6cc145a6fdab8f\",\"/knowledge-medium/pr-preview/pr-1792/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1792/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-DX-cJLLu.js\":\"59201cd2f0953ad9\",\"/knowledge-medium/pr-preview/pr-1792/chunks/mc-wa-sqlite-async-BFPgErhd.js\":\"ff80946b27b0e1f3\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-BJXirK9P.js\":\"804da71c7a716d24\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-BVT4uqVQ.js\":\"671958763d8388f1\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-Brnz08BK.js\":\"05ebf8271e678040\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-C0-LGq9Q.js\":\"8bea0f557493a4d6\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-C1Vz74Pw.js\":\"be5c239d3aa95b8d\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-CKGZcdwF.js\":\"e3ef00a9a4f80786\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-DEmYxZk5.js\":\"6ad52ddbdad20d61\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-DK1JgdtI.js\":\"f7b30963ed90a0cb\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server-legacy.browser.production-LQWuOcXa.js\":\"07962ae5368039f2\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.browser.production-CARoacfT.js\":\"9123fcb300a7a687\",\"/knowledge-medium/pr-preview/pr-1792/chunks/react-dom-server.edge.production-OL6K69ih.js\":\"33add74306c844ad\",\"/knowledge-medium/pr-preview/pr-1792/chunks/server.browser-CJR3Mw8t.js\":\"79b95415e5bda9dd\",\"/knowledge-medium/pr-preview/pr-1792/chunks/textarea-FUWXxdU4.js\":\"b4d225167f3ae582\",\"/knowledge-medium/pr-preview/pr-1792/chunks/ui-D20nyOly.js\":\"78747fc7deb02d0b\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-BiJyU6tu.js\":\"3488f6117774d257\",\"/knowledge-medium/pr-preview/pr-1792/chunks/wa-sqlite-async-CLHlzpnB.js\":\"3dbb1e830709a816\",\"/knowledge-medium/pr-preview/pr-1792/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1792/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1792/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1792/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1792/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1792/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1792/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1792/src/App.js\":\"508feb2b18c33f09\",\"/knowledge-medium/pr-preview/pr-1792/src/appUpdate.js\":\"5d7763111726e2b5\",\"/knowledge-medium/pr-preview/pr-1792/src/appVersion.js\":\"dca76ad5972554e3\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/initialLayout.js\":\"2e48424e6f6298a3\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/openWorkspaceData.js\":\"7c599ac2fc9a02f4\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/resolveWorkspace.js\":\"c803d4259d8a2f84\",\"/knowledge-medium/pr-preview/pr-1792/src/bootstrap/workspaceBootstrap.js\":\"54128e2338fcfd8d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockComponent.js\":\"a17f5a0567dcbaf3\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockCrumbs.js\":\"c5d5b40919c36aae\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockEditor.js\":\"b57ceb17eb261ddf\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockLoadingPlaceholder.js\":\"e321e6d0a43d50a4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockProperties.js\":\"564d9b6aa7799bb6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/BlockSearchPicker.js\":\"9cb6604a0a6f4432\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ConfirmBulkDeleteDialog.js\":\"d061c1d8e3ad663d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DividerHandle.js\":\"07d36c5d4a7bae03\",\"/knowledge-medium/pr-preview/pr-1792/src/components/DraftEditor.js\":\"7a7c672abd514e7f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/GutterPill.js\":\"e057213bc797a037\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Header.js\":\"bdf4deeb175d49b4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/LazyBlockComponent.js\":\"c13408147a189841\",\"/knowledge-medium/pr-preview/pr-1792/src/components/Login.js\":\"8af4b9f1d6c56ac1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ZoomableSurface.js\":\"569ecfbcfd58b4f4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/editModeKeepalive.js\":\"e60a521bfbcb12e1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4384b1618818415d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9496da00e3450021\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefPropertyEditor.js\":\"963b5b70dac46838\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/RefTargetTypePicker.js\":\"17f58b75c49db2c8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/SelectPropertyEditor.js\":\"ed45c921ad8ec0f0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/TypesPropertyEditor.js\":\"398b6f36a979b4d6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/defaults.js\":\"384ad63b5e221737\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/kernelValuePresets.js\":\"032498841a780a88\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/selectablePresets.js\":\"fb766bf893bd85bb\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyEditors/typesPropertyUi.js\":\"56b1e733abec0e1e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/AddPropertyForm.js\":\"b3e163c8c926282a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyPicker.js\":\"811c053ddd80d2f7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/PropertyRow.js\":\"82f9d7148e6d25ba\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/Rows.js\":\"6f3218a7fe957c6a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/actions.js\":\"98265489c346eb89\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/declarationOnly.js\":\"c69c97a9412b07c6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/layout.js\":\"42d2e217803b77e4\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/model.js\":\"c380ac292cdcc213\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapeUi.js\":\"b9bef365d33edced\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/shapes.js\":\"409b67496804fc2d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4270302d7a4b7696\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanel/visibility.js\":\"050ee138a571976f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/propertyPanelSections.js\":\"874882966b3160a1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockEmbed.js\":\"11f88578cd54e4e6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockLink.js\":\"f75f80d392edd309\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/BlockRef.js\":\"eac213633a31636b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/ReferenceLink.js\":\"2e12cf23fe67d9f8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuard.js\":\"b536809d1ca0d5ac\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/cycleGuardContext.js\":\"e8f4818ba89b1ece\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/linkInteraction.js\":\"1f7fb4fcff6da685\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/referenceLayout.js\":\"d28eab8d9fdbe2d1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/references/useBlockRefAncestors.js\":\"a4a42c40f5c37ad3\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockGutter.js\":\"7b7b075771a0e52c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockInfoDialog.js\":\"0e07400d77ac3678\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BlockTypeBlockRenderer.js\":\"1d1f624d91a4d521\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/BulletHoverCard.js\":\"08d0341b4d8d15a9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorContentRenderer.js\":\"0005473dcbe1c73c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3930f5ac8d6ece9a\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ColumnResizeHandles.js\":\"d4e134d16643719d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"de577641a3f48980\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/DefaultBlockRenderer.js\":\"cc010544f9ba666d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/LayoutRenderer.js\":\"6fdf403672e5324b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MarkdownContentRenderer.js\":\"ead54a94e3f796a9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/MissingDataRenderer.js\":\"aece1c1ab0e63bfc\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PanelRenderer.js\":\"1aec4cb73594ebb6\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5c782b649381a452\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/TopLevelRenderer.js\":\"45d7792542ce26c1\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockGutterMode.js\":\"dff2c85619fce683\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/blockTitleText.js\":\"7d556a2e91ab40ea\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/fieldCreationKeydown.js\":\"f40af99534387fff\",\"/knowledge-medium/pr-preview/pr-1792/src/components/renderer/layoutRootContext.js\":\"7173215a42d1195e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/TypeChip.js\":\"dd9b7eb32b17c26f\",\"/knowledge-medium/pr-preview/pr-1792/src/components/typeChip/chipStyle.js\":\"db8d90f897449caf\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/anchored-floating.js\":\"783331f3bb1bdb51\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/button.js\":\"119c72d0ee516697\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/card.js\":\"8bdaf8f4f0f80c0c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/checkbox.js\":\"e578d86f3e8ac881\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/collapsible.js\":\"785934d3440a5b16\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/command.js\":\"a2b56c9c52bebd9c\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/context-menu.js\":\"9037f3d2f4dcdcc5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dialog.js\":\"982a420e70d44d11\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/dropdown-menu.js\":\"a8805500d5565c62\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/floating-listbox.js\":\"b40b82ffd4a3ca0b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/index.js\":\"eb097fd8dfdf0b88\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/input.js\":\"b5a5db4ada493e41\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/kbd.js\":\"e7abd0fcc49abbda\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/label.js\":\"483987741a94f9c8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/ui/textarea.js\":\"f9e6df3809d25bc3\",\"/knowledge-medium/pr-preview/pr-1792/src/components/useEditModeYieldKeepalive.js\":\"6b7a1bc1f53998b7\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/BootFallback.js\":\"78e7eba0e7b747dc\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/FocusedRowLazyMount.js\":\"cc02f7e0f74651a9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LazyViewportMount.js\":\"916f409adf6c7544\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/LocalDbCorruptionFallback.js\":\"3f3a7440c90842b0\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/error.js\":\"5ce19684060804e5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/lazyMountRegistry.js\":\"829905212b113c3b\",\"/knowledge-medium/pr-preview/pr-1792/src/components/util/suspense.js\":\"6eaa3712509a0b80\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/CreateWorkspaceDialog.js\":\"ddd9a17427f67085\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/PendingInvitations.js\":\"e761994e3c2350d2\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/SyncProgress.js\":\"4b8ad7b108f19f49\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/UnlockProgress.js\":\"5f2f5b22701e2ec5\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceKeyGate.js\":\"cafe0d6c8653e17e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSettingsDialog.js\":\"1c03fb7e613eab68\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSwitcher.js\":\"ab46a769c48cb368\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/WorkspaceSyncGate.js\":\"509230cf22e05795\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlow.js\":\"7f80d330f929f520\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/ConversionFlowHost.js\":\"aebc4645f350199e\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/EncryptionSection.js\":\"a0b2d0a4885755da\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/attachmentPrompts.js\":\"51eaafdb236e53ca\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0eccd12fbdc969fe\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowDeps.js\":\"24498d17d203b132\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/conversionFlowStore.js\":\"5e366787e3b807a9\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/flowUi.js\":\"02bf28b45d1423c8\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/conversion/useConversionRun.js\":\"b19a722b6ba629eb\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/keyUi.js\":\"619ed3be21b52d4d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnKeyLoss.js\":\"15ab5eaf7251748d\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/useCloseOnServerE2ee.js\":\"04c664f282e8a3bf\",\"/knowledge-medium/pr-preview/pr-1792/src/components/workspace/workspaceUnlocked.js\":\"ba7113b0ff2e90a0\",\"/knowledge-medium/pr-preview/pr-1792/src/context/backgroundSubtree.js\":\"e6b2e1640aaaf496\",\"/knowledge-medium/pr-preview/pr-1792/src/context/block.js\":\"ea953199faa7d090\",\"/knowledge-medium/pr-preview/pr-1792/src/context/layoutWsContext.js\":\"f908e1b3d818cbd6\",\"/knowledge-medium/pr-preview/pr-1792/src/context/propertyDisplay.js\":\"6566bbbae21e3ea0\",\"/knowledge-medium/pr-preview/pr-1792/src/context/repo.js\":\"85eff36add6884c4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasClaim.js\":\"d401152c63016082\",\"/knowledge-medium/pr-preview/pr-1792/src/data/aliasSeatNamespace.js\":\"1bee3c2c47468f14\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockData.js\":\"724282c26e462a41\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/blockType.js\":\"1c4b54837e75936b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/changeScope.js\":\"f0fd5f6c27798f01\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/codecs.js\":\"daa7bcfbc802ed2f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/derivedData.js\":\"61da97bfdbe93545\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/errors.js\":\"4437454b8c1d4cbd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/events.js\":\"179bc08d37e3b7d6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/handle.js\":\"31e397c7cb3880ab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/index.js\":\"f45e554fa4e0709c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/mutator.js\":\"28992d87b5d2fd4a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/processor.js\":\"c2dc77c2965eaedc\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/propertySchema.js\":\"f357797ab34d6deb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/query.js\":\"6c3014a33712da3c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/sameTxProcessor.js\":\"3ecc263037c262a7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/schema.js\":\"31e397c7cb3880ab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/tx.js\":\"31e397c7cb3880ab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/typedBlockQuery.js\":\"0daf70e5e15cb85a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/user.js\":\"15d924499ef4db8a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresetCore.js\":\"a4f519e3cc6142ac\",\"/knowledge-medium/pr-preview/pr-1792/src/data/api/valuePresets.js\":\"e30e220beb491f3a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/attachmentCleanerIOVerb.js\":\"a7058a7ebc7acd84\",\"/knowledge-medium/pr-preview/pr-1792/src/data/block.js\":\"9e3ec45406c91a3b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockCache.js\":\"1a0ab83b95c31831\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockId.js\":\"0a7eb4c3526c385c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockLiveness.js\":\"e770d22ce4703dd3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockMerge.js\":\"ac54d3fa154f093a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockSchema.js\":\"befb1a48ecb4a723\",\"/knowledge-medium/pr-preview/pr-1792/src/data/blockTypes.js\":\"cecf73dce5fc156b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/clientContext.js\":\"f73aff3b4f05f730\",\"/knowledge-medium/pr-preview/pr-1792/src/data/dbFileSiblings.js\":\"a632f9a6257d9ec4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/definitionSeeds.js\":\"26b70657c4201a7f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/derivedIds.js\":\"8bc55c2a6897c782\",\"/knowledge-medium/pr-preview/pr-1792/src/data/drawnSubtree.js\":\"5e8a10345bf7d75d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facetBridge.js\":\"051c197d62f6afec\",\"/knowledge-medium/pr-preview/pr-1792/src/data/facets.js\":\"2c5a552b0d7b246d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/globalState.js\":\"25972c62dd193740\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/aliasClaimRederiveProcessor.js\":\"f5bbd4db678389a3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/ancestorBatch.js\":\"049ebfefd2c2c8c3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/blockTypeTypeifyProcessor.js\":\"1ff4807f4e2e0c98\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/clientSchema.js\":\"47e5c4c969e25684\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/commitPipeline.js\":\"c09f596afea9e4a6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/devAssertions.js\":\"7f271ebfb8ab7274\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/firstSync.js\":\"8a79a824742cd4a1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/freshInitialLoad.js\":\"d021f66babf2b4e7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/graphBackfillClaim.js\":\"dad2ddbf60affc59\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/handleStore.js\":\"ae56e01c564a0ccd\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/idleMarkerJobs.js\":\"22afe7dbf3beeeab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initialDownload.js\":\"da26d52377dfafa4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/initializeClientDatabase.js\":\"18d4b5a21ed2f1c6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/jsonCanonical.js\":\"141b9b2e89658d79\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelInvalidation.js\":\"3c610af172d4d0cf\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelProcessors.js\":\"7e0783f1ac306922\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/kernelQueries.js\":\"44ec07291283f1a0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/mergeTypeMembershipProcessor.js\":\"1d7659e5fdccbdb6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/normalizeReferencesProcessor.js\":\"edf3cf767070f9d4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/poolInstrumentation.js\":\"d480b556bd9a929c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/processorRunner.js\":\"873da9fff5d58c46\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyCellBackfill.js\":\"5045698b1d09b37d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildMint.js\":\"614e2477c8a98f55\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyChildrenProcessor.js\":\"2650ce13eb9e61e0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionChangeProcessor.js\":\"fd8b89e09c5723c5\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyDefinitionSynthesis.js\":\"84e909a6bdb9c8eb\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertyKeyScan.js\":\"b9b3f28f547dd526\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/propertySchemaResolution.js\":\"a97af8f3444102c9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/raiseProtocol.js\":\"e0811496367561e9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/readBatch.js\":\"5a267614ae729908\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/refProjection.js\":\"7e3221ed947196ef\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetLookups.js\":\"aec5cc54fba95222\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/referenceTargetProcessor.js\":\"30374ce976404b8b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/replayMerge.js\":\"e1c1e7f95f807bd8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/sqlBinds.js\":\"b6162aab14842c31\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7e58777abe601f43\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/arrivalProcessors.js\":\"48c9f95c9fcbcbc0\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/invalidate.js\":\"0ad45e972bf86b24\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/materialize.js\":\"d1694fff8826dd55\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/observer.js\":\"fd69b0485c70aee4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/syncObserver/reconcile.js\":\"cccffda41d256b1e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/timingMetrics.js\":\"7c8f883d7141e29a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/treeQueries.js\":\"3583cce8f44f4b72\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txEngine.js\":\"9708ef39c6d8bdd1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/txSnapshots.js\":\"021d80b245e92885\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/typedBlockQuery.js\":\"d1a292a93da2258f\",\"/knowledge-medium/pr-preview/pr-1792/src/data/internals/undoManager.js\":\"3b6d54d8f8f74915\",\"/knowledge-medium/pr-preview/pr-1792/src/data/invalidation.js\":\"2016787a47c03245\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelDataExtension.js\":\"c9cbda7c2ce9fb6a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelPage.js\":\"f2a694e6874f437c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/kernelValuePresetCores.js\":\"eceb6b1bb4da763e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbCorruptionSignal.js\":\"fb2a7199a3cca6a7\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbStorage.js\":\"4308e62ad55e9e62\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localDbVfs.js\":\"2503a0cb241b3876\",\"/knowledge-medium/pr-preview/pr-1792/src/data/localSchema.js\":\"3478851b2fb48ed2\",\"/knowledge-medium/pr-preview/pr-1792/src/data/maintenance.js\":\"5ba829af13c4e997\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mergeProperties.js\":\"1c522d1a0f2bd489\",\"/knowledge-medium/pr-preview/pr-1792/src/data/metricsConsoleHook.js\":\"2cd65918b16a0d49\",\"/knowledge-medium/pr-preview/pr-1792/src/data/migrationsPage.js\":\"24dd94fcfdeb0c98\",\"/knowledge-medium/pr-preview/pr-1792/src/data/mutators.js\":\"7e1bd03728ca5a4c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKey.js\":\"fb9a614a279d2012\",\"/knowledge-medium/pr-preview/pr-1792/src/data/orderKeyPlacement.js\":\"78c7e4807e10aaed\",\"/knowledge-medium/pr-preview/pr-1792/src/data/outlineSurface.js\":\"645a534198313760\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingEditorContent.js\":\"339c5140ea387511\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pendingUploadsSql.js\":\"1e662e259de7721e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/pluginStateExtensions.js\":\"782b2c55ad672c85\",\"/knowledge-medium/pr-preview/pr-1792/src/data/powerSyncLogger.js\":\"fb7a5b7ec4a7ca9d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/projectorRuntime.js\":\"80e68b145cfcc3c9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/properties.js\":\"ed636f7a853283ce\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertiesPage.js\":\"4eaaeab2a07e4ef3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyChildren.js\":\"784544fa94c0a762\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionFanout.js\":\"7b97cfb152b45e6a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionMetadata.js\":\"a27c7e3129184d9d\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDefinitionRegistry.js\":\"c9d8905592d22161\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyDisplayMode.js\":\"c643245e2a70bf86\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertyRowCreation.js\":\"e6895563541a7473\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySchemaCreation.js\":\"9597eb31967ae694\",\"/knowledge-medium/pr-preview/pr-1792/src/data/propertySeeds.js\":\"560f4b41a7f43b27\",\"/knowledge-medium/pr-preview/pr-1792/src/data/recentsPage.js\":\"48e85273f668b0d6\",\"/knowledge-medium/pr-preview/pr-1792/src/data/referenceBlock.js\":\"3c879e222c51b19b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/releasePowerSyncConnection.js\":\"0d346014d5f7a0a8\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repo.js\":\"a269015b95707a4a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/repoProvider.js\":\"ad39601c52e2a877\",\"/knowledge-medium/pr-preview/pr-1792/src/data/rowProperty.js\":\"70b08d518a41afa9\",\"/knowledge-medium/pr-preview/pr-1792/src/data/searchFilter.js\":\"531bac1c00eeee06\",\"/knowledge-medium/pr-preview/pr-1792/src/data/seedIdentityLedger.js\":\"30ec3464dc79fbdf\",\"/knowledge-medium/pr-preview/pr-1792/src/data/stateBlocks.js\":\"363e046f1cfc1656\",\"/knowledge-medium/pr-preview/pr-1792/src/data/structuralEditPolicy.js\":\"407e8886776e6c78\",\"/knowledge-medium/pr-preview/pr-1792/src/data/subtreeDelete.js\":\"b2035332eaaa382a\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncStreamLock.js\":\"9c2b7c858029e2e3\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableSqlRecognizer.js\":\"fa7374993298f52c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/syncedTableWriteGuard.js\":\"75c8e277a4426c11\",\"/knowledge-medium/pr-preview/pr-1792/src/data/targets.js\":\"0c52a014fce38976\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeColors.js\":\"493ee3482603bcab\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionMetadata.js\":\"0ddfcad62177dbaa\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeDefinitionRegistry.js\":\"41f02b1458a939ba\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeExtraction.js\":\"49c4eafa61a76925\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeInitialValues.js\":\"d97ff2d4eb634d1e\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typePropertyGroups.js\":\"43e2e7322eb98887\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeSeeds.js\":\"6e911d6326e58a00\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typeTagger.js\":\"df7046301da927db\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typedRecords.js\":\"5f4eb878913b7934\",\"/knowledge-medium/pr-preview/pr-1792/src/data/typesPage.js\":\"30518bb4ee768a79\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userPrefs.js\":\"c62a4668bbcce691\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userSchemasService.js\":\"61ce097b5b4aee79\",\"/knowledge-medium/pr-preview/pr-1792/src/data/userTypesService.js\":\"24c9302c34738319\",\"/knowledge-medium/pr-preview/pr-1792/src/data/valuePresetRegistry.js\":\"a3c48b78233fa39b\",\"/knowledge-medium/pr-preview/pr-1792/src/data/visibleChildren.js\":\"3cef98b46b7e5b72\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceConversion.js\":\"2844d38c31c3b7d1\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceFirstSync.js\":\"7c152022f720799c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceIdNamespace.js\":\"2124b58dae9e12d4\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaceSchema.js\":\"d25cdcdeb8b86a79\",\"/knowledge-medium/pr-preview/pr-1792/src/data/workspaces.js\":\"136f2d5e556b3c54\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadLog.js\":\"5b8d157bb4a8319c\",\"/knowledge-medium/pr-preview/pr-1792/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/BlockPasteShellDecorator.js\":\"c7aa2cc3c6edc64e\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/atTrigger.js\":\"ddbbfb7377375a5e\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/autocomplete.js\":\"d1a17c776f63c0d7\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/codeMirrorExtensions.js\":\"a04df4012de4b87c\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/contentFlush.js\":\"3410f94913c8ae4f\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/defaultInteractions.js\":\"76329cc7d2e1b7fe\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/editSettleSignal.js\":\"ec79ad8f56883795\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/insertImage.js\":\"213fd6d2cad26f51\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceCompletionRange.js\":\"7d48e4b5f1630838\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/referenceTargetTypes.js\":\"c8ae97c269276033\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/syntaxContext.js\":\"28003b2ade39ca9b\",\"/knowledge-medium/pr-preview/pr-1792/src/editor/triggerMatch.js\":\"cc617af7f07324bb\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/AppRuntimeProvider.js\":\"1b9a74238e5fc86f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/BlockFocusShellDecorator.js\":\"2f94833d4d23e327\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/ExtensionRenderBoundary.js\":\"57f1dda97d50e0f2\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/PanelContentRecovery.js\":\"44739a738a9942be\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/apiCatalog.js\":\"6e6396ed08fa0ca4\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/approveExtensionHere.js\":\"f89f1531b5f4dc91\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/armedCutAppMount.js\":\"690fe7daf9a3437a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/batchableKeyedStore.js\":\"0eefa13b3e8d56df\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockInteraction.js\":\"089396eed9ba0b5b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/blockSelectionAction.js\":\"989109b4079fef49\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compileExtensionModule.js\":\"ec5942cd103273bc\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/compiledModuleCache.js\":\"c829168df83644c3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/continuousGestures.js\":\"b6e069e70d9fa91c\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/core.js\":\"c349476a3dbfbddb\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/defaultRenderers.js\":\"30e083f15ead1248\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/definitionFanoutAppMount.js\":\"66c4d2ce4266c470\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dialogAppMount.js\":\"ee21cf653964f6e7\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensionSeeds.js\":\"4e358484160d1eb0\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/dynamicExtensions.js\":\"b7229fcb4acf71f3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/exampleExtensions.js\":\"3ee059f3c71bd6e3\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionApprovalStatus.js\":\"a9149e605fca7dd1\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrorToast.js\":\"a03617786b1d8f54\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLoadErrors.js\":\"5ad88bdd2e4484ba\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionLookup.js\":\"6f621e9536d7de4b\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionToggles.js\":\"e9d2e1bd41530cd4\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/extensionUtilitiesCss.js\":\"f1a733098cd8d85f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/kernelPageDeletionGuard.js\":\"195737e194a5708d\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/liveRuntime.js\":\"da4c7118fafc195f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/openExtensionsSettings.js\":\"4f27c414e2726b7a\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/overridesCache.js\":\"4a2defb17201e027\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/pluginIds.js\":\"227a134dcee6f2b7\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/processorRejectionToast.js\":\"fc4df77a70386452\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeActions.js\":\"1ca2c982b7cec9c7\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/runtimeContext.js\":\"b563342a5199ec02\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticAppExtensions.js\":\"0671134d35a0a53f\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/staticDataExtensions.js\":\"435991ca4a158ae4\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/toastAppMount.js\":\"f3d270893e8f59c2\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useOverrides.js\":\"a48d625f3b7e1994\",\"/knowledge-medium/pr-preview/pr-1792/src/extensions/useShortcutSurfaceActivations.js\":\"d8bbfcbb9e16fc4c\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/discoverToggleTree.js\":\"28e047094c11043f\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/facet.js\":\"608b837e520dc4c5\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/resolveAppRuntime.js\":\"8d386ac940d295d3\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/runtimeEvents.js\":\"2efbdb2b42168eda\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/togglable.js\":\"1b4da0e7fd6288e2\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/variantFacet.js\":\"94b831f6ce7d3848\",\"/knowledge-medium/pr-preview/pr-1792/src/facets/verbFacet.js\":\"e1b811fc428bcfb8\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/block.js\":\"6874d471f2bbc512\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/focusedChild.js\":\"b03085e3487fa39b\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/propertySchemas.js\":\"8382356fd7bd36a5\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/typeRegistry.js\":\"96545ac244c86d55\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAncestorCrumbs.js\":\"42d4f69673925940\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useAutocompleteListbox.js\":\"6715d7b348a15b39\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedSearch.js\":\"3489146330d76045\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useDebouncedValue.js\":\"89edf4daef19a34a\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsFocalRender.js\":\"8d5934979976d9a1\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useIsReadOnly.js\":\"31949fe2f1e3faf9\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMaterializeBacklog.js\":\"41ba2ffb5713a050\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useMinuteClock.js\":\"37cb63acef57ed9e\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePanelLayoutProjection.js\":\"a9bf4aa377a07e15\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/usePendingInvitations.js\":\"124db63eed09e45f\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRendererRegistry.js\":\"5f0ca7872032774a\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useRetainedFieldRows.js\":\"1f25a6074d9d15d4\",\"/knowledge-medium/pr-preview/pr-1792/src/hooks/useWorkspaces.js\":\"9d2f982e7f598051\",\"/knowledge-medium/pr-preview/pr-1792/src/lib/utils.js\":\"3ea6dba7a321fcb9\",\"/knowledge-medium/pr-preview/pr-1792/src/main.js\":\"0fc50072233bd339\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/MarkdownImage.js\":\"38b6540f965231ab\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/blockSeparators.js\":\"b19fa788f9350a1b\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/context.js\":\"4e593e7889556f0c\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/defaultMarkdownExtension.js\":\"d84ac20e317c6e60\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/extensions.js\":\"3ca5b7a2e5eccdbc\",\"/knowledge-medium/pr-preview/pr-1792/src/markdown/renderMarkdownHtml.js\":\"8f2967a32e17358d\",\"/knowledge-medium/pr-preview/pr-1792/src/minimal-editor.js\":\"cbbf0f5647285083\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/armedCut.js\":\"dec80dee6671b6b0\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/captureMediaVerb.js\":\"73135d7296d971b2\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/clipboard.js\":\"53862a5f5cc054cf\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/decision.js\":\"6434f5932750b890\",\"/knowledge-medium/pr-preview/pr-1792/src/paste/operations.js\":\"dec69566af118e0b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/AccountHeaderItem.js\":\"e5f2c1e0747a79d6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/account-header/index.js\":\"887ff4c6576fe37c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f43ad7be1932fe92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askAgent.js\":\"5c6069444303e94c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/askedStore.js\":\"bfdb6b1875b04e6e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1422e64ae00eeca5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/chipState.js\":\"8dc892c8041b514f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/dataExtension.js\":\"03f6f51cacbea14a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/index.js\":\"dc6aa9a62369808c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0bf1befad236e9f8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-dispatch-companion/schema.js\":\"fca8f642383269e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9bae546ec5810880\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/BridgePairingDialog.js\":\"93e65e6aad3949ce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/addMedia.js\":\"76740f51cc23c016\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3a82deeb8a42622e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/block.js\":\"52f37aa627ba52be\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/context.js\":\"25718a1f011255f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/displayIds.js\":\"16e2eb36a4cffbb6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/index.js\":\"8bbcbcbc9fa519a0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/outline.js\":\"ff8130a7d78284b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/properties.js\":\"735c55784d70e91f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/refs.js\":\"d53bf0d81cb153e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"29c213bc0623b4e5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/search.js\":\"f044ccfbe86b8a91\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/shared.js\":\"c5230c96d0c3469a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f73824967221ac39\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentViews/text.js\":\"ac00f83a638beee8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/agentWrites.js\":\"784a6042a79cdb9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/authoringCatalog.js\":\"a296200f0c21b897\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/blockRefTargets.js\":\"79586531bfae4d07\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridge.js\":\"cc13b7492deaca2b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/bridgeLoop.js\":\"2296a64ffbb45c2f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/changeHistory.js\":\"a18c153597c376ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commands.js\":\"7a835019d165d3c6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/commentsCommands.js\":\"33863ff42dd7e98c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataExtension.js\":\"19eb296d2866fba6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/dataModelGuide.js\":\"ce8585c9444378e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/describeRuntime.js\":\"729fc3532d304683\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/extensionLint.js\":\"c34f16c1070cc66f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/grainAudit.js\":\"30466bbcdcc58613\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/healthCommand.js\":\"94516330dbcee58e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/index.js\":\"0e6afd715ab3c810\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/presetIdentity.js\":\"1f7c295be6d8bd58\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d87952f54f148ec7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/readMedia.js\":\"e7309ad695422ad6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/schema.js\":\"9d541330b2afcfc1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/serialization.js\":\"0d4bbbe95deb2cb9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/targets.js\":\"c71957a514f43626\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/tokens.js\":\"9eee1546e7567ed0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/watchEvents.js\":\"cc4aa2106a80e0fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/workspaceGuard.js\":\"c2f72fcace3dc215\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/agent-runtime/writeCommands.js\":\"08fc8eb6b02d7240\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/AliasCollisionToast.js\":\"817e0311011356d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/DuplicateNameBanner.js\":\"a5e3492832ffee81\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/collisionMerge.js\":\"b27f7d9be67e55cb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/dataExtension.js\":\"474df4560a89adb6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/index.js\":\"9b7fe9c280ac8f77\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/mergeCollisionAction.js\":\"d37fca790e2affe8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/pageStyling.js\":\"b51a1c97f8c98024\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/rejectionToast.js\":\"8fa911ad673a3543\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/alias/syncProcessor.js\":\"683bb675b305ac25\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/actions.js\":\"41b6d2b12b90296f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/addComment.js\":\"3c695dd0a8477d42\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchor.js\":\"fd26238748744ef3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/anchorState.js\":\"633693c953c66149\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/commentLinks.js\":\"5bcb3eb9ddee4ecf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/confirmThreadDeletion.js\":\"4b3245ff45ecdc95\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/container.js\":\"810884b35a219cc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/dataExtension.js\":\"17645403ee97b2f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/deleteComment.js\":\"7aebcce684a0d353\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/highlights.js\":\"df84aa6f5d70c5b4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/index.js\":\"e6d66fc431e2af73\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/linkedCommentsPill.js\":\"a2018f0f46fac380\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/margin.js\":\"ab7cb389127044cf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/marginSchema.js\":\"5ed732a90c668b68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/newComment.js\":\"a62b7c48a65b5ea1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ownThreadPicker.js\":\"32edf1494b63d03d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/placement.js\":\"58628880f6bbbd60\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/queries.js\":\"50d44aabffe2d51c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotePosition.js\":\"fb3b5552a240a6ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedIn.js\":\"6baa4c43bde11286\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/quotedRange.js\":\"34d32806c2c34110\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/rangeRefs.js\":\"626f98a404a9a5d3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readHighlights.js\":\"4840d5ec3e4a86e1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelection.js\":\"385a2a88ce71f40b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/readSelectionUi.js\":\"7322b38b8116ec21\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/reanchor.js\":\"114b9d4999ffe1e9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/schema.js\":\"9e739b3f227ded59\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scope.js\":\"8318ffdf905fb5c8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/scopeThreads.js\":\"73bb5024b1ec13e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/splitRetarget.js\":\"f6612d263f213acb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestionCard.js\":\"0475afb91e1b5e67\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/suggestions.js\":\"0a81fd8304aa0c27\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaries.js\":\"2ea91d672e314a5a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/summaryBatch.js\":\"36869a2a8574e394\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/surface.js\":\"947e872618957a85\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threadNavigation.js\":\"846961cf27350ddb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/threads.js\":\"877c5f3afec99cb2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/ui.js\":\"bfe56bf1eb022031\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/annotations/uiStore.js\":\"7bd248d64ba87179\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/appIntents.js\":\"3a368b11fb8c16bb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-intents/index.js\":\"a7017a69ae00aa9c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/index.js\":\"5f2ec7242e475316\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/app-update-prompt/status.js\":\"8f0559e49857588b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b7732009395a7dcf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaBlockRenderer.js\":\"381d0a5117b7b053\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d7a74b6c643f9290\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/MediaUploadReconciler.js\":\"576e5b47ccbe6204\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetDownLane.js\":\"9e7f90c01f08219b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetResolver.js\":\"9c06a11220b120f2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/assetUpload.js\":\"9050051a710eb522\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/attachmentCleanerIO.js\":\"07ceab25793b58dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6ec0e8130a242419\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/blobStore.js\":\"0236a2bca075fda3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/byteStore.js\":\"f8dcbb561a59827a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanerIO.js\":\"b9e3d75f9c7f83b6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/cleanupAttachments.js\":\"a8d28c10d5b14c77\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/dataExtension.js\":\"46883477dd679878\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/downLane.js\":\"6bfbaae01df13144\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/index.js\":\"022fe00ab3729a33\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/insertImageContribution.js\":\"dde2c31dff74af77\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneArming.js\":\"3727c2e441057ba2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/laneLock.js\":\"b55754e7f8ab917d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaBlock.js\":\"f60c2a2867142b5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaCapture.js\":\"62ce0238d460a927\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewers.js\":\"1c7a9014a6240ed7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/mediaViewersFacet.js\":\"badecf8fbe0b278d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/pasteCapture.js\":\"efd862d819a2de5f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/resolver.js\":\"84552c0a421c14ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/retryUploadsAction.js\":\"815419ad2e262af3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/storagePaths.js\":\"bbc69f60f63a0785\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadDrain.js\":\"48ae1ab46c40e0fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadLaneStatus.js\":\"2929bff10f05e548\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadReconcile.js\":\"4b158b8c2001986d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadRecovery.js\":\"874060fee188f9a0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/uploadStore.js\":\"3aff05ab2906b380\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/attachments/useAssetObjectUrl.js\":\"de7ca0748a9f2149\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"79f1d09368a4bba3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/BacklinksViewSection.js\":\"274898cf5b850b68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/facet.js\":\"d22a30c3e903f6b7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/index.js\":\"841a9c46e10b2e34\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks-view/prop.js\":\"6a841a550f61aba4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinkFilters.js\":\"697b1ed41fab685b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d75f3b12a55c79e9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/BlockEntry.js\":\"0d2b32ea6324222e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/LinkedReferences.js\":\"79a4a752b19319b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ec6ece17cd5885a0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dailyNoteDefaults.js\":\"96c981ec7ddfe707\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/dataExtension.js\":\"d2a5cf958aac1cc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/edgeExclusions.js\":\"76bb55b7a51891ba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/filterProperty.js\":\"12bb4db5e1468596\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/index.js\":\"045217c2531eee4b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d66ff13d642ba0ba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/applies.js\":\"3162ec0e271d3011\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/countQuery.js\":\"d472fc8e20b6c0c6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/expansionStore.js\":\"57f9a884cf2027ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/index.js\":\"e9b346c74a0e49e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"85e93839c92822ff\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/presentationInvalidation.js\":\"e08f6289abd6d75d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyEditorOverride.js\":\"c9ae4101ea082aa3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/propertyFilter.js\":\"38e7dd71d6ea45d2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/query.js\":\"f2d5377237c3d87a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/resolveFilter.js\":\"53dce9f3a358a7a8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sourceBatch.js\":\"8f15ee68f31cad88\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/sources.js\":\"32d5052f2bd78916\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useBacklinks.js\":\"36d15f25f675557c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"30ba2fc0dfffc436\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayCelebration.js\":\"a950eb54a5798329\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/BirthdayOverlay.js\":\"d036d5a2adffed0a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/gate.js\":\"a393135688e069ce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/index.js\":\"94a25770a32286b9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/birthday/wolfTheme.js\":\"660ee59c418b49eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/BlockDragLayer.js\":\"181ec11cff64ec84\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dragController.js\":\"d2964e35cec71d4b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/dropTarget.js\":\"ad1a02e1f08ed01a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/index.js\":\"dcc4e5457e0389fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-drag/projection.js\":\"3e05e650ccae5efd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/BlockMetaCard.js\":\"e0d86b7576e7ae34\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-info/index.js\":\"ffad556e02e7c1de\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/AddTagDialog.js\":\"bec985fb5caa6e8b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2a28bc946e8a4c22\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/TagNameIssueHint.js\":\"eec1f2c6b5c51dee\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/addTagAction.js\":\"4de6a6e9daaa9866\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/appendTag.js\":\"3d28db27777c8e48\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/config.js\":\"d531621d4315ee8c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/dataExtension.js\":\"94308c8afe55c031\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/index.js\":\"ffcd1711ad5fb511\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/block-tagging/propertyEditorOverride.js\":\"bb93c513d937fdb4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbList.js\":\"22c90c1bdf51b449\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d4981e43f28cc970\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/Breadcrumbs.js\":\"eb92534e89ff9a9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"400d732f15aaa6b2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5a7b3860ccc70b3f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/index.js\":\"8bf868b2661099be\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"70335494ebc398ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/CharacterCountItem.js\":\"e43dd2c29b2589cd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7324d0d8d40565ce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/actions.js\":\"41ccde5cf43c1fd1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/blockType.js\":\"d91a7a802b4ea512\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/charCount.js\":\"a110bad1e9bd8c54\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/dataExtension.js\":\"ce43355448fd468d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/index.js\":\"3cf337d54dc28f3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/profiles.js\":\"caccb744b7f2ed6f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/properties.js\":\"9e9c7fc0341de6ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/character-counter/textCounts.js\":\"01ac582e633f8abb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/colemak-keybindings/index.js\":\"905f22470f0b1f97\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/CommandPalette.js\":\"327a5be98af46663\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/HeaderItem.js\":\"3e6d7ed8237922f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/context.js\":\"f0e3a1d02f33c913\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/index.js\":\"d92d8602df9ef994\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/selection.js\":\"194fd368e084d726\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/toggleStore.js\":\"e939d58edf0a1e0c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/command-palette/useCommandPaletteActions.js\":\"f0bd0da88b6cb684\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/ContributorBadges.js\":\"709781a0fe04693f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/author.js\":\"18f90479ace8651d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/codeMirrorExtensions.js\":\"0be223e8831c0fe8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/dataExtension.js\":\"941c2e82db07db6d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/index.js\":\"7df29314f61a8308\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/mentionAutocomplete.js\":\"df6ba1f9e88fead0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/processor.js\":\"b476cf661e00e4db\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/profiles.js\":\"67a4dd7d927ff906\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/queries.js\":\"bea5b8121524c2c5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/contributors/schema.js\":\"5948a11773494e22\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b3383e43d4682218\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6aac59d09644453d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/index.js\":\"668870cd49888b68\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e8f006b3cbbbb764\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"afb752b5e6c5e5b8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/CalendarGrid.js\":\"3dad7f0f55b811f5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DailyNotePicker.js\":\"736779c9cb960fa9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"11c7a1a29c47b4b9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateNavDecorator.js\":\"f20c9c7785b4f45f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/DateScrubOverlay.js\":\"1612c07534327db1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/HeaderItem.js\":\"51e551a0cb05f1bb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/ReschedulePicker.js\":\"effa1ac11dd9dcf3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5424d417423d872a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/actions.js\":\"0b0c306c48998ce1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/blockDateAdapter.js\":\"97d5ade140708c5d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/calendar.js\":\"d2cd8331721a7fa3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dailyNotes.js\":\"6e8aa6d3edbbd037\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dataExtension.js\":\"1cac461793d4909c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubActions.js\":\"d59aaa7f64b3f8ea\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGesture.js\":\"3142416583373944\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubGestureActions.js\":\"018ed712f22e275c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8897212b5be7e832\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/deletionGuard.js\":\"4b1dca7fea25f29e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/dueQuery.js\":\"e92a1a28bde75c7e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/index.js\":\"ff443d35d222d260\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/landing.js\":\"f1fef63efe67859b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/localSchema.js\":\"a6a084cbb8148d5a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/referenceDateAdapter.js\":\"ff00353debcf92ee\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/rescheduleAction.js\":\"5c6077cac2b8f93f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/schema.js\":\"9e2275c01443ea8d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadBlockDates.js\":\"eeff8f7c31f432ef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/spreadDatesAction.js\":\"c50954bae8f30b3a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/today.js\":\"a25f3d72cef1eff5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"40d459ded4a1823f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3376d17afd88a9ca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/audit.js\":\"962372ca3fe9e0c3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditAction.js\":\"1dada3ec054f3aff\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/auditRanges.js\":\"6b792d241fd9a729\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/diagnosticsSource.js\":\"02aca152bd2e930f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/divergenceScan.js\":\"0a9294dfdd110425\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/index.js\":\"bedcadbb022494ec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8615e832f9fa73e9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/referencesMirror.js\":\"6d625f1f307a7d84\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/rowJson.js\":\"b2ef0c26f0e45176\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/schedule.js\":\"7c61c1f8ec04356e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/data-integrity/store.js\":\"afd8d115e07dfee8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/action.js\":\"73e862807df51a0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/index.js\":\"867c0c5b0975f21e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-maintenance/plugin.js\":\"e464ad6669040d9e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6ef6644a3d19613a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/actions.js\":\"9148d84525c736f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/changeMarker.js\":\"db76b645cf19b665\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/diagnostics.js\":\"d179ef06b7ca9edc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/fileSystemAccess.js\":\"73f505644d6ba581\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/filenames.js\":\"e6fc0a8481cabbb9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/index.js\":\"12aa4c6c60f585de\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/mirror.js\":\"a84eec6f6d52d0c4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runLock.js\":\"181cd894751e591b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/runtimeHealth.js\":\"7e0eca146ef9e7fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/schedule.js\":\"36a5c71d24ed788c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/db-mirror/store.js\":\"639ebbfef3cd8c26\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/index.js\":\"c5c1a174652862d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/default-themes/themes.js\":\"3ec9e1fcc88182f7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/facet.js\":\"3a43029126d19c7a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/diagnostics/useDiagnostics.js\":\"6b2cfff0e868ea25\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/dismissals.js\":\"6779fd11f01f4e86\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/index.js\":\"44c630b6eeaf0f11\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/status.js\":\"0c599ebb0c1db76d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extension-prompts/store.js\":\"ceb9aad689b28d4d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"adb2863ce2f7f371\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/ExtensionsSettings.js\":\"589cead00c1a2e89\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/actions.js\":\"c3bde829926eb95c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/config.js\":\"54a3d59c753c56a6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/dataExtension.js\":\"32c8ae8a46a1f452\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/effect.js\":\"1b82f5dea6e30191\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/index.js\":\"e727a6e5dd6cf447\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5b2cd85b1ef2777d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extensions-settings/useToggleTree.js\":\"78ff5becf5bb1a39\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/ExtractTypeDialog.js\":\"7a536a7e9c4b453e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"afaba1cf0b955e51\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/PropertyShapePicker.js\":\"62ce8b99900888fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/action.js\":\"f7890f92535fbab9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/extract-type/index.js\":\"f3481eabc0d108e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/FindReplaceDialog.js\":\"06905df05dd5fd72\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/HeaderItem.js\":\"b00abe4804f5157c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/dataExtension.js\":\"317a105dcb175f9b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/index.js\":\"c1ec8c0c9c8daf76\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/search.js\":\"6b3289ff67163b1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/toggleStore.js\":\"be7d45e00962b379\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/LocationPropertyEditor.js\":\"4a8a5192b4404ccb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/MapView.js\":\"cd312b28ef5b20f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/blockTypes.js\":\"23022c78a3e7e848\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/codeMirrorExtensions.js\":\"52f1c266ea86bfeb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/createOrFindPlace.js\":\"448407e3227cafef\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/currentLocation.js\":\"d3691b5bdf09b079\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/dataExtension.js\":\"89d716abc9009bc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/geoContentDecorator.js\":\"1e07630a4d2881e7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/googlePlacesClient.js\":\"b6e69b3ddfcfa4eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/index.js\":\"75916a8cd095349f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/locationsPage.js\":\"21ffcd17e567c2df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/mapViewport.js\":\"5e4fa9472bb5aa54\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/pickCurrentLocation.js\":\"7b19ea49ba534979\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeAutocomplete.js\":\"24d14d2348e43ad5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/placeNameCollision.js\":\"125fff6e59793bdc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/properties.js\":\"b0d383fc628d14ba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/propertyEditorOverrides.js\":\"5cb7df78e3a6309a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/query.js\":\"a4d029bda5c09046\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/geo/usePlaceSearch.js\":\"12a4d39828e27344\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e3a0c776762c010e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cf94179836043a32\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6f229d456ef11ae5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/config.js\":\"6e2392eca12138ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/dataExtension.js\":\"f5587fed1cf21c26\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/facet.js\":\"dcfbeeb122ed3482\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/grouping.js\":\"b2418e0ff615c8ec\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/index.js\":\"0eda64c33ef75c93\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9a2713f21527f8d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/query.js\":\"022f46ee57d9bf1f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/resolveConfig.js\":\"f2e2e78ce0eadd5c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ace3410178125d15\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cf76c3a92dbb6899\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlDocumentContent.js\":\"36abc321a8d700df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/HtmlFrame.js\":\"9e275993bc53a6aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/actions.js\":\"298812a403ca7b1c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/blockType.js\":\"d972dadc5be496d6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/confirmRunScripts.js\":\"35a065eed5e216fa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/dataExtension.js\":\"6e83c6fe7fdd5391\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameAnnotations.js\":\"49ff91bd50fcbc57\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameDocument.js\":\"a8c8fa72cf607399\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/frameTheme.js\":\"3062d10cae68f80a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/index.js\":\"4ebd2e3df1dacc0c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/scriptConsent.js\":\"aba8d240fae4eea6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/sourceMap.js\":\"d1d05b50d8f482d6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/html-document/useDocumentScripts.js\":\"f24dc81c2c5b6526\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/index.js\":\"5afb16c375abda9f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/record.js\":\"92e5984ea4f96763\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/recordStore.js\":\"4dcf82dd2a150209\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/responsiveness.js\":\"e87d484a08a4665b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/schedule.js\":\"baabaa7495fcd703\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/interaction-metrics/sessionContext.js\":\"89fe2ef418efa478\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"dccfd6dc9000a4da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"bcf2d403d386f07f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/actions.js\":\"ff341bd75d518114\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/config.js\":\"f77651ba5883a800\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/dataExtension.js\":\"825e04c52c8cbdce\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/effect.js\":\"3e3b711559a0a1cc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/index.js\":\"94899dd10892feee\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/keyCapture.js\":\"5eee7b60bedccff8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/overrideStore.js\":\"62a64d9f24a1e96a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8aaab5bd2263b002\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/HeaderItem.js\":\"106e511a34769bc7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/LeftSidebar.js\":\"f7543a80b847f719\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/actions.js\":\"91ba234fa1537e7f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/facet.js\":\"520cb6ea6eede95c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/index.js\":\"5f1fb4cd87171231\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/shortcuts.js\":\"976942dfdb4c204c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/left-sidebar/toggleStore.js\":\"bb36c142619a5f0f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/MergePicker.js\":\"3119f335cbf54394\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/index.js\":\"a7065643d1defd85\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/mergeAction.js\":\"05dd87648daa2580\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/merge-blocks/strategy.js\":\"131c652cfea36b5b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/Button.js\":\"e3817795c1cb3938\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"45a000541c0e8ca2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/defaultItems.js\":\"890c817bd4e1270d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/facet.js\":\"457591dea1461697\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-bottom-nav/index.js\":\"dc602a942ae5dcb4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"67c337309d3803ba\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/actions.js\":\"cb04ca543cecdd51\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2dda6df88103386d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b2a7e0a36fb6a158\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/mobile-keyboard-toolbar/index.js\":\"554d33e6a6d41ecd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ab41c5949f4033ae\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b9aeff7ed236024d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/contextMenuItem.js\":\"b0e562220b5e5988\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/index.js\":\"d6575d653598e2a4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveAction.js\":\"9afa1cecc2275e0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/moveBlocks.js\":\"84d53ed5560afff5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/move-blocks/selectionAfterMove.js\":\"fee03ce8c682c57d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/TutorialBanner.js\":\"3866e82c0cd46279\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/action.js\":\"141a53651387f2dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/bannerDismissal.js\":\"dc043c59b8317818\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/documents/cheatSheet.js\":\"e1942fb591625465\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/index.js\":\"edb843aec0561e3b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/keys.js\":\"293d28056e3228bb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/landing.js\":\"889294392003b7c7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/outline.js\":\"c4cd68b4885705af\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/onboarding/seed.js\":\"b200ea411728fa3c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ed409c9ee2653390\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/analyze.js\":\"29873374e747cdcb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/diagnosticsSource.js\":\"67caa95337ae6182\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/index.js\":\"df7e16505c175a0d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/load.js\":\"af3c0b6f1e58f57c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/monitorRun.js\":\"d9248d36a55c0909\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/schedule.js\":\"3bab3da5d6711e51\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/series.js\":\"6199434144e79a80\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/store.js\":\"573095ae5014ccf1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/trendAction.js\":\"a4c6e1bfc86c2a5d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/perf-monitor/verdict.js\":\"5a01d2d84a7edf4f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/clickToEditAction.js\":\"d9b3628aeff01e20\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/index.js\":\"8b02b636f5507dc6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/plain-outliner/interactions.js\":\"fb9799b9ac7a4f2d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d77905c5b7a33114\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGate.js\":\"81e4a9c9658779b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/MigrationGateDialog.js\":\"06aa2b084ba99141\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/action.js\":\"3876b1f28663d150\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/index.js\":\"c25e216bb2e3e4fc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/localRunMessage.js\":\"e626b2b3e3db434f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/plugin.js\":\"ecf3ce3f0ba49f42\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/progressReport.js\":\"7d7addd81b625fe6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/properties-migration/sweepProgress.js\":\"da39bfd4b7769e2a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/FieldRowRenderer.js\":\"2aa070b922df79d6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/ValueRowRenderer.js\":\"b1a08bf4118da0e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/actions.js\":\"9e6c42402ec197a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/autocomplete.js\":\"ee9149dcd08d047f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/fieldRow.js\":\"ef61011313b88725\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/index.js\":\"a01c8b0ca3666f26\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/referenceWarning.js\":\"13ade9205a7dc79a\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueAutocomplete.js\":\"fbeaf515da3f11e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/property-rows/valueSchema.js\":\"da76fb322302ee91\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/HeaderItem.js\":\"d9e00d85c775491f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/QuickFind.js\":\"49cd7619e3d508e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/index.js\":\"705570e2bc8e6f3d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/recents.js\":\"939617329bd800b8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/resultItems.js\":\"6d59a7d37dab4f87\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/selection.js\":\"f21b727bbb0db389\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/quick-find/toggleStore.js\":\"02065e3d78b8b9e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/HeaderItem.js\":\"27bbc824e22cd1f0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/RecentsPageBlockRenderer.js\":\"40e3b2d38252552e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/grouping.js\":\"401218673d983dfb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/index.js\":\"62afb21bd8a64ac2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/recents/target.js\":\"0330ef1dd9108182\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/codeMirrorExtensions.js\":\"0a3fdbe621c976ed\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/contentPrefill.js\":\"5ad4dd16c656c678\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/dataExtension.js\":\"0c3fcddcb9548702\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/index.js\":\"5c070f3ac2906cca\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e3fc49ff9aa836bc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/invalidation.js\":\"3f2e5c2195338c6d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/localSchema.js\":\"76acd7b3520d9452\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/index.js\":\"f409f625486a26f6\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5027e9c49feec289\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/index.js\":\"e911f976023d6a61\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/referenceNode.js\":\"32ccf1f19461d6b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d3e7d75a2412bdcd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cdbf27a6fc48bdc8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/index.js\":\"39dcaecc02c0375f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2b0a91c389e60659\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ae10f9102e55da3d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/mergeRetargetProcessor.js\":\"ba9c1618afb443c1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/parseFence.js\":\"894442ce3edafd5f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceParser.js\":\"28462bd2cb516bcd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referenceProjection.js\":\"6dd0a4bd6bc59dfe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/referencesProcessor.js\":\"ab7e8b9b8c9581da\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/renameProcessor.js\":\"e2a6845f18602e3e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/references/spanReplacement.js\":\"ba70abd4e021c3e5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/htmlToOutline.js\":\"4ad923b72d2ea6ee\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/index.js\":\"c742d8893f2c4346\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c3a95a0299818767\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/rich-paste/pasteDecision.js\":\"779e3f7856ed2466\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/action.js\":\"cf009e3e97b90f76\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/blockIds.js\":\"be600be63231306d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/content.js\":\"d27b5209536fabbb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/effect.js\":\"f29b13fb8d5406bd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/ids.js\":\"8a78d8e23b90f1d0\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/import.js\":\"ee52a86ee7897806\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/index.js\":\"51fb5ce5ce8640e4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plan.js\":\"68e6a0b963f53282\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/plugin.js\":\"1e527d375f69a009\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/promotion.js\":\"96279137b9d7df07\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/properties.js\":\"3fc1705cae774379\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/references.js\":\"1aeb0bd0cb8308b1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/report.js\":\"e1de7243365a3412\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/roamMemo.js\":\"23872bee324415bb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/runtime.js\":\"bd17c7dbe37605ab\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/schemaReconciliation.js\":\"76ef9258058038a2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/srsMarkers.js\":\"e77d206677e5490d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/todo.js\":\"d7e74e43794c584b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/typeCandidates.js\":\"e055561b6a70e3d7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/roam-import/types.js\":\"12ab653b37ce87e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/index.js\":\"dd9c8fc22157785c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/search-health/store.js\":\"5e44a5bb4566085d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/HeaderItem.js\":\"7598a8e54e2deb79\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3d88bcfe2f92f91c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/index.js\":\"98fe8b91d27e4367\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/model.js\":\"2609226b38a12dfa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/toggleStore.js\":\"6b079446204396f2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/shortcut-help/useKeyInspector.js\":\"e2e66b45128ea8aa\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5ceddcb34111a7f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/ShellDecorator.js\":\"ee2d73b325b50138\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/actions.js\":\"4dc0a92f7ea73b82\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d8c91abd9ec752d9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/index.js\":\"efabbe44607e5f27\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/shell.js\":\"51c13ad8ad6a97e3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/surface.js\":\"ad45f40de1797df4\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/spatial-navigation/walker.js\":\"b49cdbf1b28f2829\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4f77918f937e74b5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/dataExtension.js\":\"60c7959714973dc7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/index.js\":\"eb7cea2bc5bb1f86\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/indicator.js\":\"39d84906b13142b5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/moveSrsState.js\":\"acfbdc318f7b2783\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2646581a67c5dd83\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/scheduler.js\":\"00369651b1fb4759\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/schema.js\":\"8576c9568e0f9f5b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"52e5698fc5b78f8c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/srsClipboard.js\":\"d13be8d8cfdba9a5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"51a4f57f11f59112\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DailyNoteReviewHint.js\":\"da58f936d4cb72b9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/DeckPicker.js\":\"50cd9c450a44b79d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewControls.js\":\"ebb2a272fc4bf057\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7a8f224746f36269\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/ReviewSession.js\":\"140e939314c676d5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/actions.js\":\"896a2ef42b027625\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/archive.js\":\"e89477118eb45ad5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dataExtension.js\":\"82a104bff16109dc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/deck.js\":\"4ea120610e404205\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/dueQuery.js\":\"89fcee0fb390f0eb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/gradeDecision.js\":\"2f042988d58e5ae8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/index.js\":\"424b6251cc875917\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/keyHints.js\":\"89fa55b1b0d7cd4e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewCardLayout.js\":\"360c2d3f86dfdb4f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/reviewProgress.js\":\"712f317a6f65a0ac\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/schema.js\":\"44eb35505234da3d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/srs-review/useDueCards.js\":\"afa502a0ea364d9d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/index.js\":\"74b37398fe8557e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/startup-metrics/record.js\":\"2796706c23018d58\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/index.js\":\"df7a0bc320e824c7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/persistenceStatus.js\":\"a3040f6fb238fcc1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/storage-persistence/requestAction.js\":\"ccc66e7751addc98\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/TypeChipsDecorator.js\":\"4915f8d10087d876\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/codeMirrorExtensions.js\":\"7e330b3dbbb1c586\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/index.js\":\"8781f815df88d0e9\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/supertags/typeAutocomplete.js\":\"9b65512c360e40df\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ade794feff4f3932\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/actions.js\":\"46250254c6e220b3\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/anchor.js\":\"bf61abd0d3b71baf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/events.js\":\"68bec88453b26c79\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/gestureActions.js\":\"ba4873ea2146401e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/index.js\":\"16dfb8ba207580e2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1e9aad480d74cbd7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/collect.js\":\"a5f2656cb0128cbc\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/index.js\":\"7868a9d773120858\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/sync-metrics/record.js\":\"e3bc09adb7540413\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/RejectionDialog.js\":\"d5f1002b72ec46d5\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4157d2865021e05c\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/index.js\":\"7cc2fc404a00d228\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/model.js\":\"7b2fb6c78159fa38\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/queueCounts.js\":\"4da55cf780491738\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rejectedHelpers.js\":\"9e951ad37dfe7e2e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/rematerializeAction.js\":\"e7b30848e8b2b339\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/system-status/useHysteresis.js\":\"db908233cb57db5e\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/effect.js\":\"cbc55a2fbc43f9f1\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/index.js\":\"fcd1dcdfa3b71b15\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/theme-toggle/theme.js\":\"4e6bb0e0d9e4486f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/actions.js\":\"f6f34b2f6c989c92\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/dataExtension.js\":\"0d04f7771c17b6fd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/index.js\":\"f8dc9cf871abd5a8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/todo/schema.js\":\"827e641ce6b6aed7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1e9954954d6c28d8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/actions.js\":\"d6db1b5793af74dd\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/defaultItems.js\":\"71b47102bc8a9aaf\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/facet.js\":\"48158b8b8be3d17d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/holdRecognizer.js\":\"724bd7a7e5c54483\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/touch-selection/index.js\":\"a88fff27f349ecf7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/UpdateIndicator.js\":\"c7ae63670c9e783f\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/index.js\":\"f0198f6926f90182\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/update-indicator/loadTimes.js\":\"72697069518e9206\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoNotesRenderer.js\":\"cbd8ec3f3993afb7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoPlayerRenderer.js\":\"e649de0daefecae7\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/VideoTimeStamp.js\":\"e9879d099f1f3a80\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/actions.js\":\"7257b84aaa60b32d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/index.js\":\"a4d30deba3eb8035\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/markdown.js\":\"de2e83e246dbf732\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/notes.js\":\"4f1fb3a1eba92df2\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/registry.js\":\"253d23e24e4a6685\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/remark-timestamps.js\":\"26da9d784d6aa796\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/video-player/view.js\":\"2cc5269d5c7b6085\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/LinkHints.js\":\"7a49bc62909b16fe\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/index.js\":\"bdaa81b3d45e44c8\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/model.js\":\"0ca118b5020de9cb\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-link-hints/settings.js\":\"34f8db0b4a65b140\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/actions.js\":\"28a844845f75982b\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/index.js\":\"a903bb2f86fd2723\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/vim-normal-mode/interactions.js\":\"7a7d338a9061c33d\",\"/knowledge-medium/pr-preview/pr-1792/src/plugins/workspace-header/index.js\":\"7bb67c9667d5c205\",\"/knowledge-medium/pr-preview/pr-1792/src/registerServiceWorker.js\":\"58b83ec34e3821ea\",\"/knowledge-medium/pr-preview/pr-1792/src/requestPersistentStorage.js\":\"7f8d4da17c3ebfbf\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authRequestDeadline.js\":\"41add7e9acc300c9\",\"/knowledge-medium/pr-preview/pr-1792/src/services/authStorage.js\":\"54f0a3779b19bbf4\",\"/knowledge-medium/pr-preview/pr-1792/src/services/powersync.js\":\"3dd121d3310c2468\",\"/knowledge-medium/pr-preview/pr-1792/src/services/supabase.js\":\"e86fa9df32d1c989\",\"/knowledge-medium/pr-preview/pr-1792/src/services/uploadErrorClassifier.js\":\"bf17537038eb49e1\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/ActiveContexts.js\":\"bae8f69dfd324bff\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/HotkeyReconciler.js\":\"4995e988c7969902\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/WipeLocalDataDialog.js\":\"38656ae8b66988f4\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionDispatch.js\":\"b88b3f5f30913e7c\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/actionRefItems.js\":\"3ec7236a9fe308b8\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/applyKeybindingOverrides.js\":\"0b2e8ed34037a7d7\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/blockActions.js\":\"15d2755cae8822ed\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/canonicalizeChord.js\":\"dfe2f2e873da7886\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultContexts.js\":\"ac772706b33f3564\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/defaultShortcuts.js\":\"1ff78848586fc28b\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/effectiveActions.js\":\"cee76f9f04c28fb3\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureAction.js\":\"5558198aa7b053a6\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/gestureBinding.js\":\"8f048346d40e015b\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/holdRegistry.js\":\"fb5722d3a4281b89\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingConflicts.js\":\"d75305cb22252f59\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/keybindingOverrides.js\":\"4277041f23877fdb\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/pointerAction.js\":\"222fb8a4086c13a0\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/resolve.js\":\"9d77f4c2dd69fecf\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/runAction.js\":\"e981ad5f65f063a4\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/sequenceMatcher.js\":\"95f7a0c7050eebb9\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/types.js\":\"286d6ebda7c51fa7\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionContext.js\":\"647df88c0e77675c\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/useActionDiscovery.js\":\"2fc8aa4201402559\",\"/knowledge-medium/pr-preview/pr-1792/src/shortcuts/utils.js\":\"b48b0678b04c96af\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/bootStore.js\":\"8e00dbbd2f2950db\",\"/knowledge-medium/pr-preview/pr-1792/src/sw/previewDatabases.js\":\"02d6bce4d44b9a53\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/byteTransform.js\":\"ebe24041998d62ea\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/attachmentCleaner.js\":\"e191b4d5a1271071\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/attachmentParts.js\":\"a31995478ea1b4db\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleParts.js\":\"28b0383b30786dbb\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/bundleRecord.js\":\"8dc300b04b9d2049\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/manifest.js\":\"e226f82ff4698363\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/takeBundle.js\":\"edcb31904165ece5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/bundle/verifyBundle.js\":\"a2a940455815c6ce\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/cleaningStage.js\":\"0c1fd5cd66a9371e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionKey.js\":\"e3c93e0e6dc1c0ab\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/conversionServer.js\":\"83ebe1728f0ad8fc\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flip.js\":\"5c7ecf16b1df675c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/flipAttempts.js\":\"f4147a9914a934f0\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/pages.js\":\"a14834ede50565b8\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/preflight.js\":\"1f946cba5367c3c1\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/reseal.js\":\"40951009b7805ea9\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runConversion.js\":\"377c16bda0a977c7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/runLock.js\":\"3ccdc405f5272903\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealing.js\":\"7e92b38878b1d25a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/sealingStage.js\":\"d7c9e4970ca944c5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/stage.js\":\"38c0b058d909741c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/conversion/verifyReseal.js\":\"e083d87e9a93068a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aad.js\":\"aa0eecdf98cb65c7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/aead.js\":\"e8055e940393cb62\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base32.js\":\"1a555864e6a3465b\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/base64url.js\":\"cd4d7719e99ea6aa\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/binaryEnvelope.js\":\"067faffc8fbf332d\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/byteAead.js\":\"c9f14d8ceaf07ee1\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/canary.js\":\"903885c00ef77467\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentHash.js\":\"17d95683c3e2308a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/contentKey.js\":\"efec018288dd14b5\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/derivedIdNamespace.js\":\"6532dfc36ef5964c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/envelope.js\":\"e3e1fee11cfe26bf\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/hex.js\":\"34045b2d6d40aa84\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/sha256Hex.js\":\"d7eebaf3311899d8\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/crypto/workspaceKey.js\":\"0b26e9677de3ad86\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/conversionState.js\":\"e1d0692085e949cb\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8931fdfe506ae6ee\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/pastedKey.js\":\"45a4c3f0ee372e54\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b3638fb95919aaf0\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3cae01a51e052332\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/keyStore.js\":\"6daab8c42cd911d7\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/mintWorkspaceKey.js\":\"4dad61e40c7d8387\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/modePin.js\":\"b45eeac457be007e\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/openWorkspaceKeys.js\":\"ff1e3f2a5d6ed15a\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolveWorkspaceEntry.js\":\"6a8ffd7586982c93\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/resolver.js\":\"4909e4f615ae30ea\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/keys/workspaceAccess.js\":\"71228ebee0e2698c\",\"/knowledge-medium/pr-preview/pr-1792/src/sync/transform.js\":\"2b5ab06367aaf0fe\",\"/knowledge-medium/pr-preview/pr-1792/src/themeBootDefaults.js\":\"dca3619fe566be61\",\"/knowledge-medium/pr-preview/pr-1792/src/types.js\":\"10bf0b720dd775ad\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/ClientLocalSettings.js\":\"a5179ee64145eb96\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/abortableSleep.js\":\"f6328d5d7f62181a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/array.js\":\"6f8c19f387a9faf3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/backlinkAutocomplete.js\":\"a8874c60971b15be\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockCrumbs.js\":\"a440c269f9362617\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/blockrefAutocomplete.js\":\"3ff778413366bc2d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/cadencedIdleJob.js\":\"ceeff6dc74a3cf38\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/callbackSet.js\":\"8d33452bde275e7c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/clientId.js\":\"ef9d7a06e492e78a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirror.js\":\"e8b8bcd23a45492e\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/codemirrorCompletion.js\":\"42bf90be18e1754a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/copy.js\":\"cb5f9eedbd5adefd\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dailyPage.js\":\"b137408eb9492664\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensics.js\":\"2c2f638cfa94f3d1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dbForensicsHooks.js\":\"c2fb68de49e2e9c8\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/deleteBlockThroughUi.js\":\"457a9a0ef633e5f6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dialogs.js\":\"5f97c4b669a7fecd\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/dom.js\":\"364ae102f9a1d7cf\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/downloadBlob.js\":\"d13c54d38e69711b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/exportSqliteDb.js\":\"9430c38c3c1c62c0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fileSystemAccess.js\":\"ef383d0505e52295\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/flipSlide.js\":\"67ecc46a90e5a06a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fnv1a.js\":\"b95f37c461323457\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/formatBytes.js\":\"5ad135954fb916b9\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/fuzzyRank.js\":\"8e392cfde0a2df4a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idbKeyedStore.js\":\"39ca43714c1e7ba0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/idleCallbackPolyfill.js\":\"65a505e498f69e06\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardAwareScroll.js\":\"244f4ca2adfaafa1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/keyboardViewport.js\":\"0e294cf0e005e625\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/lastWorkspace.js\":\"afbdf61d82566084\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutColumns.js\":\"b1bf3597d6ebbc58\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionDom.js\":\"b9556089cadac031\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/layoutSessionId.js\":\"67eb84e6f101342b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkClickGestures.js\":\"10936b0c61ae45c2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/linkTargetAutocomplete.js\":\"c0806668709622ec\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbCorruption.js\":\"aac9ecee1a46e278\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/localDbRecovery.js\":\"f4d7753b30159732\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/markdownParser.js\":\"bbed08f9e8b82ca7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/memoize.js\":\"7951e25a879a7021\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameFieldCommit.js\":\"64140895972308e0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/nameList.js\":\"37fc6e91f0bc5a92\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/navigation.js\":\"a14e72cdd2e1c6d0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/omnilinerNamespace.js\":\"c89d964e374b689d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/opfsPageScan.js\":\"cf0186052848f79a\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelClearance.js\":\"7e64e1fe8a7e2a8b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelHistory.js\":\"9afd2cdf5b9a5f3f\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLanes.js\":\"3c52dfe94baf35d3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelLayoutProjection.js\":\"b09f677689acee5d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelScrollAnchor.js\":\"d95e906f5b401651\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/panelUrlFlags.js\":\"e37bc563714e591c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/platform.js\":\"8ad68cac97cd3be1\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/pluralize.js\":\"69c2033b1303cb2c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyCreation.js\":\"c9e70489ee1a2112\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyNavigation.js\":\"9766edfc396a4a8d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/propertyValueContext.js\":\"a5f6490ccc2194b0\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/react.js\":\"189acc64ee6a9ce3\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeDate.js\":\"7f41c480c9674ee2\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/relativeTime.js\":\"877fad7200424765\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/renderScope.js\":\"932d693148026b37\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/resolvedThenable.js\":\"d735d821007c2637\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/routing.js\":\"457a031fac4f8189\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/safeMode.js\":\"3fc6ea39ef3357fe\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/scheduleIdle.js\":\"bbefbfe80a27e946\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/screenWakeLock.js\":\"13070873515fb1f7\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/selection.js\":\"816bf4c9b746262e\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/softKeyboardGrab.js\":\"e4467efab83a8147\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/startupTimeline.js\":\"d07e63bbb54264bb\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/state.js\":\"24d62ca4562ee1e6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/string.js\":\"a8dae4d9f5e3192c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/surfaceZoom.js\":\"9cf0aadbe7fa7b86\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/time.js\":\"90f180eaac27c33b\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toast.js\":\"f0033f4fcaf10910\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/toggleStore.js\":\"2e4182f721d4c942\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/untilStopped.js\":\"7b7e37c1c9579512\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/userActivity.js\":\"44a261dfd3b4962d\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewTransition.js\":\"5737e3173e084a45\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/viewport.js\":\"60c33ffede74e977\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/webLock.js\":\"964f1c4f7e5c8e96\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceRecovery.js\":\"aae877518f60459c\",\"/knowledge-medium/pr-preview/pr-1792/src/utils/workspaceSnapshotStore.js\":\"4780dd444b5d050f\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-compiler-runtime.js\":\"1fff10f4dc3f5aeb\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-client.js\":\"53fe28e3ff96bc3b\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server-edge.js\":\"e631dee63c389dff\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-server.js\":\"dbf14e1ae9ab952c\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static-edge.js\":\"cb208521434c42ac\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-static.js\":\"90c92ee91add4a8b\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom-test-utils.js\":\"d08463b8deb9af22\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-dom.js\":\"e565f94e9aa7f609\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react-jsx-runtime.js\":\"db79cae0500633d8\",\"/knowledge-medium/pr-preview/pr-1792/src/vendor/react.js\":\"64b0fbb15aaca5bd\",\"/knowledge-medium/pr-preview/pr-1792/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1792/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
