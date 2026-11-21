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
		buildId: "b03893969f51-94d9c7f9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1796/\":\"2772b1babe21773f\",\"/knowledge-medium/pr-preview/pr-1796/index.html\":\"2772b1babe21773f\",\"/knowledge-medium/pr-preview/pr-1796/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1796/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1796/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1796/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1796/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1796/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1796/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1796/assets/FacadeVFS-Bg2FjIHK.js\":\"915170b3f5a53769\",\"/knowledge-medium/pr-preview/pr-1796/assets/OPFSCoopSyncVFS-BdqHteMH.js\":\"214b119b573f56fb\",\"/knowledge-medium/pr-preview/pr-1796/assets/OPFSWriteAheadVFS-YHaKRdwV.js\":\"f70c02cd5803e917\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-D0l2cExm.js\":\"bff665d046f2d80e\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-async-CZvhuXP-.js\":\"aacb7f42466c9511\",\"/knowledge-medium/pr-preview/pr-1796/assets/worker-CHDtBV_a.js\":\"49605181d1ad97ee\",\"/knowledge-medium/pr-preview/pr-1796/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1796/chunks/app-C52TGttp.js\":\"3cd07ac481711e30\",\"/knowledge-medium/pr-preview/pr-1796/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1796/index.js\":\"9d4f588567d09d07\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1796/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1796/assets/AccessHandlePoolVFS-BQYNTLKy.js\":\"af66cb9b635cd9bb\",\"/knowledge-medium/pr-preview/pr-1796/assets/IDBBatchAtomicVFS-CnBLjUfs.js\":\"432428d1c4fb72d9\",\"/knowledge-medium/pr-preview/pr-1796/assets/MemoryVFS-GpMDpTCY.js\":\"e730f55b7bc310d9\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-Ck59MAFX.js\":\"60f13589f20660bb\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-async-Cm1NVLAW.js\":\"e9ea827c6a129a28\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1796/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1796/chunks/AccessHandlePoolVFS-BhmWasfZ.js\":\"ecb26ae1358d23f8\",\"/knowledge-medium/pr-preview/pr-1796/chunks/FacadeVFS-D5Sg6zap.js\":\"1ddbf16bc3bac85e\",\"/knowledge-medium/pr-preview/pr-1796/chunks/IDBBatchAtomicVFS-CWiDTSLy.js\":\"c415bf7fa1e5e7e4\",\"/knowledge-medium/pr-preview/pr-1796/chunks/MemoryVFS-nEd2Azf3.js\":\"1892e5be147d89c7\",\"/knowledge-medium/pr-preview/pr-1796/chunks/OPFSCoopSyncVFS-DUdOsH1S.js\":\"513bfbed1d2d4a5f\",\"/knowledge-medium/pr-preview/pr-1796/chunks/OPFSWriteAheadVFS-CLdnmKFF.js\":\"a5ef61de6134c57c\",\"/knowledge-medium/pr-preview/pr-1796/chunks/Preview-EKhtWs_s.js\":\"563aa45eee4c04ff\",\"/knowledge-medium/pr-preview/pr-1796/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1796/chunks/card-RuKDqibM.js\":\"42d34d13ae191946\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dist-Dl3CI3NR.js\":\"d22f03025dbff88d\",\"/knowledge-medium/pr-preview/pr-1796/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1796/chunks/mc-wa-sqlite-ABH2eFtd.js\":\"5dc639befa9bf6d4\",\"/knowledge-medium/pr-preview/pr-1796/chunks/mc-wa-sqlite-async-q0sK5iFj.js\":\"bfc75746c8859110\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-7SLsTsKw.js\":\"a19a074c8b7ce307\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-Bby8Nvys.js\":\"9837795cb4813ac4\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-CJ9S1xSL.js\":\"e9df845ff96a806f\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-CMFtUnM-.js\":\"c196444905242210\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-Ce-VcGv3.js\":\"14d6322815b6807b\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-D0aRER2f.js\":\"8216df44840fca1f\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-DVPOdI9U.js\":\"8851dd656b689a91\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-dom-server-legacy.browser.production-7cTewNWv.js\":\"378b4a2edd1c7545\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-dom-server.browser.production-3gk_f0n5.js\":\"fc7e4a5b82f6078f\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-dom-server.edge.production-Djq6vxwu.js\":\"c75a179ae3265a02\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-jyEkc0fp.js\":\"66fc661af481e229\",\"/knowledge-medium/pr-preview/pr-1796/chunks/server.browser-DNdtDxzT.js\":\"712ceadfe0b71e68\",\"/knowledge-medium/pr-preview/pr-1796/chunks/textarea-Ck0SrQkD.js\":\"d4c42ecfffe8c77b\",\"/knowledge-medium/pr-preview/pr-1796/chunks/ui-BuOmVRag.js\":\"763d4c7192d85237\",\"/knowledge-medium/pr-preview/pr-1796/chunks/wa-sqlite-BhUpI_is.js\":\"c20922946b30caa5\",\"/knowledge-medium/pr-preview/pr-1796/chunks/wa-sqlite-async-BZzoaobk.js\":\"7bbb69e3fbefdb84\",\"/knowledge-medium/pr-preview/pr-1796/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1796/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1796/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1796/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1796/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1796/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1796/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1796/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1796/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1796/src/App.js\":\"8bf665177c111e00\",\"/knowledge-medium/pr-preview/pr-1796/src/appUpdate.js\":\"019f98bb978c702b\",\"/knowledge-medium/pr-preview/pr-1796/src/appVersion.js\":\"a16e07a41362d07d\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/initialLayout.js\":\"9e28ecf6568beb33\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/openWorkspaceData.js\":\"66465e86be3bd9bd\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/resolveWorkspace.js\":\"eddf1175645faf57\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/workspaceBootstrap.js\":\"101e3aea11e2c60a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockComponent.js\":\"0b6b4b3f74709240\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockCrumbs.js\":\"ea820c84a86de565\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockEditor.js\":\"54cf415bf5c26351\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockLoadingPlaceholder.js\":\"cded23fa0d161916\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockProperties.js\":\"d20e75b7c2183175\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockSearchPicker.js\":\"66bcc60987f33c85\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ConfirmBulkDeleteDialog.js\":\"52c662c1da498e59\",\"/knowledge-medium/pr-preview/pr-1796/src/components/DividerHandle.js\":\"608c33e0421cfc8f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/DraftEditor.js\":\"96112166318919f8\",\"/knowledge-medium/pr-preview/pr-1796/src/components/GutterPill.js\":\"b14121ef961d8d60\",\"/knowledge-medium/pr-preview/pr-1796/src/components/Header.js\":\"2b910f56144149dd\",\"/knowledge-medium/pr-preview/pr-1796/src/components/LazyBlockComponent.js\":\"5801b2a0deb0eb22\",\"/knowledge-medium/pr-preview/pr-1796/src/components/Login.js\":\"0b21cfaf7181f551\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ZoomableSurface.js\":\"0fbf0a5d03ab5bd9\",\"/knowledge-medium/pr-preview/pr-1796/src/components/editModeKeepalive.js\":\"e82492a69c8f74fb\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e74f89cfce1ed297\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"dceaacf1d80ddebb\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/RefPropertyEditor.js\":\"1606045646fdae5b\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/RefTargetTypePicker.js\":\"01d3ed0cf7b8ff44\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/SelectPropertyEditor.js\":\"67675870f490d8f8\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/TypesPropertyEditor.js\":\"c03943a1b575567d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/defaults.js\":\"017db23b67c143f8\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/kernelValuePresets.js\":\"87a3bc6c88e2c50d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/selectablePresets.js\":\"54c9e038ac28a17d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/typesPropertyUi.js\":\"d08f547b3ac7ff2a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/AddPropertyForm.js\":\"aba3667a141b95f9\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/PropertyPicker.js\":\"70c13744afe03e08\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/PropertyRow.js\":\"82ebc9be9f6bcf08\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/Rows.js\":\"d5b59ff1f8b4976f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/actions.js\":\"ad6c7f984fd2944f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/declarationOnly.js\":\"a7236e9efcd78d5b\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/layout.js\":\"b97ec01cc2c87512\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/model.js\":\"385343c1642483c8\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/shapeUi.js\":\"4c90f836e60ca146\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/shapes.js\":\"fa7580771921557f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a376e2352e535ec9\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/visibility.js\":\"8ab3ab9c6338ba0f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanelSections.js\":\"a3e7e676babc38b4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/BlockEmbed.js\":\"2e2525704623c3e1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/BlockLink.js\":\"74fc5e977cc1b376\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/BlockRef.js\":\"ea1d583ef020ec00\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/ReferenceLink.js\":\"bd50eef1522c7fef\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/cycleGuard.js\":\"996f9830a74395cc\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/cycleGuardContext.js\":\"bba08e6ddf4a4965\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/linkInteraction.js\":\"79028bdee8a9df6f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/referenceLayout.js\":\"7575d3c36c2ca721\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/useBlockRefAncestors.js\":\"6d2946a386b828c5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BlockGutter.js\":\"557a9a68fa667c01\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BlockInfoDialog.js\":\"485c79e79c7a3cbc\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BlockTypeBlockRenderer.js\":\"54d611debd2ee914\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BulletHoverCard.js\":\"6c1b7a7e8a35f3ab\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/CodeMirrorContentRenderer.js\":\"f55587c42f5e9808\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b1eea79ec6e40411\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/ColumnResizeHandles.js\":\"03073ce689b0e0c6\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4375550c4bc45d72\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/DefaultBlockRenderer.js\":\"0bdf2e3c93a8dd77\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/LayoutRenderer.js\":\"1a69f35dbbc69f14\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/MarkdownContentRenderer.js\":\"3c4f9e2bb23e6bee\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/MissingDataRenderer.js\":\"73c7d4f837ebe435\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/PanelRenderer.js\":\"e2b3820dee9dc234\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/PropertySchemaBlockRenderer.js\":\"317a832a4b9750f6\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/TopLevelRenderer.js\":\"390db5593c3700ad\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/blockGutterMode.js\":\"71416b0338e8b7fa\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/blockTitleText.js\":\"6a973edea022a268\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/fieldCreationKeydown.js\":\"7dc6596f11ee487e\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/layoutRootContext.js\":\"da98d0a86a92015a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/typeChip/TypeChip.js\":\"259b0ebc7dfa4938\",\"/knowledge-medium/pr-preview/pr-1796/src/components/typeChip/chipStyle.js\":\"ba2d69881ada1ae4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/anchored-floating.js\":\"c5ef550752417070\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/button.js\":\"730bdb4382e18a5f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/card.js\":\"c9a231947fef262e\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/checkbox.js\":\"fbe5309811eff6ea\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/collapsible.js\":\"205d921dbe0d40df\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/command.js\":\"960b65923c4fd140\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/context-menu.js\":\"98a7be306ec704c5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/dialog.js\":\"8b7b772a4b8905e2\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/dropdown-menu.js\":\"8383c2d454616ad4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/floating-listbox.js\":\"06e1c70fd8207263\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/index.js\":\"0adc89665cd330ce\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/input.js\":\"5841157a42d19088\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/kbd.js\":\"b910a36345103d5d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/label.js\":\"fe425ca70b06cc49\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/textarea.js\":\"5df64c378445c09a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/useEditModeYieldKeepalive.js\":\"4406e9284e7f504e\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/BootFallback.js\":\"0a46a10582cc7d91\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/FocusedRowLazyMount.js\":\"52a761c79d7c76fe\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/LazyViewportMount.js\":\"5573e4fec2c8453f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/LocalDbCorruptionFallback.js\":\"3de230e83142ed25\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/error.js\":\"f8a6679520f9cc9a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/lazyMountRegistry.js\":\"74fb6612dc981602\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/suspense.js\":\"eee690dc9a02290e\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/CreateWorkspaceDialog.js\":\"0666b8067090cd7f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/PendingInvitations.js\":\"fd571a22bb70eedb\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/SyncProgress.js\":\"57262ec4584305d5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/UnlockProgress.js\":\"05a81684c3fc032b\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceKeyGate.js\":\"93a83061505089c6\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceSettingsDialog.js\":\"f67a6d37fb921025\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceSwitcher.js\":\"7ee8ae7202f60406\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceSyncGate.js\":\"384b728427d34f61\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/ConversionFlow.js\":\"771b3cf20a82596a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/ConversionFlowHost.js\":\"6e52852271dbe66a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/EncryptionSection.js\":\"0b1d92f85a0af0e6\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/attachmentPrompts.js\":\"3ad90928e2d0d261\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d9fa991614447a6a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/conversionFlowDeps.js\":\"a340187bdd4ad7d9\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/conversionFlowStore.js\":\"8bc1e3fbd48c60ce\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/flowUi.js\":\"7527e76ca62535a3\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/useConversionRun.js\":\"fc8a55155e59e768\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/keyUi.js\":\"91f3a8928c59d891\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/useCloseOnKeyLoss.js\":\"d525ccb4afb26165\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/useCloseOnServerE2ee.js\":\"3e825a41339ab697\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/workspaceUnlocked.js\":\"c8a7c72a8cf5ef08\",\"/knowledge-medium/pr-preview/pr-1796/src/context/backgroundSubtree.js\":\"ee7f329919c33ad5\",\"/knowledge-medium/pr-preview/pr-1796/src/context/block.js\":\"9e3ff84ae1d9b805\",\"/knowledge-medium/pr-preview/pr-1796/src/context/layoutWsContext.js\":\"fa06520ba1a6b992\",\"/knowledge-medium/pr-preview/pr-1796/src/context/propertyDisplay.js\":\"8c37c16ab1391450\",\"/knowledge-medium/pr-preview/pr-1796/src/context/repo.js\":\"68f52228bb707509\",\"/knowledge-medium/pr-preview/pr-1796/src/data/aliasClaim.js\":\"286319fd98f67b10\",\"/knowledge-medium/pr-preview/pr-1796/src/data/aliasSeatNamespace.js\":\"3878741995afe367\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/blockData.js\":\"1bd888bb8b922523\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/blockType.js\":\"df5c520244ecfc6c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/changeScope.js\":\"cf013849e08b67e0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/codecs.js\":\"8974d0b10ae8a491\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/derivedData.js\":\"fe2c2afa03bd5786\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/errors.js\":\"046ff480d70d4388\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/events.js\":\"e75dc8ac640c6b02\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/handle.js\":\"cee28958be3d213a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/index.js\":\"444ae663f416484f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/mutator.js\":\"879bd1ab1e649383\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/processor.js\":\"e1db4b1fed8352bc\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/propertySchema.js\":\"9c488281e460bef2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/query.js\":\"77bdff1224e7d56a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/sameTxProcessor.js\":\"fd773984a4991416\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/schema.js\":\"cee28958be3d213a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/tx.js\":\"cee28958be3d213a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/typedBlockQuery.js\":\"8f704eda31faa423\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/user.js\":\"cd3df55470c28225\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/valuePresetCore.js\":\"61e930b9e203c9dd\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/valuePresets.js\":\"9fcd12d5f50a543f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/attachmentCleanerIOVerb.js\":\"42637f408b1a8b73\",\"/knowledge-medium/pr-preview/pr-1796/src/data/block.js\":\"b3522e5cf5abef35\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockCache.js\":\"2d7db57dc056cbea\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockId.js\":\"36def59980319eca\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockLiveness.js\":\"8b4aaee06af778b0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockMerge.js\":\"f69cf6fb87b036b9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockSchema.js\":\"40f82366abde0154\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockTypes.js\":\"e544a51646b7e0a6\",\"/knowledge-medium/pr-preview/pr-1796/src/data/clientContext.js\":\"c1489ee404f09300\",\"/knowledge-medium/pr-preview/pr-1796/src/data/dbFileSiblings.js\":\"ced153ada3b73514\",\"/knowledge-medium/pr-preview/pr-1796/src/data/definitionSeeds.js\":\"3c70d8a520e1daa9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/derivedIds.js\":\"38ceae73f5d41bd5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/drawnSubtree.js\":\"5fff8bb68bac3eb3\",\"/knowledge-medium/pr-preview/pr-1796/src/data/facetBridge.js\":\"18cdec58cd892b23\",\"/knowledge-medium/pr-preview/pr-1796/src/data/facets.js\":\"657e7e4419c02fdd\",\"/knowledge-medium/pr-preview/pr-1796/src/data/globalState.js\":\"0058f3dc1d8ee26b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/aliasClaimRederiveProcessor.js\":\"7c3f9add8907118b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/ancestorBatch.js\":\"645853f53a7f6e85\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/blockTypeTypeifyProcessor.js\":\"ae633635b673fbbd\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/clientSchema.js\":\"598eb9fb150097ff\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/commitPipeline.js\":\"7ab1745e597185a0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/devAssertions.js\":\"3891fb79035ccedb\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/firstSync.js\":\"4535436a3f2fa5a2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/freshInitialLoad.js\":\"2eda0f08b9f544ef\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/graphBackfillClaim.js\":\"54109568d41ca8ee\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/handleStore.js\":\"d03b7ca6e6cc2e71\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/idleMarkerJobs.js\":\"f2f386aeb02b3c9b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/initialDownload.js\":\"de84eeb529c2c62b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/initializeClientDatabase.js\":\"81b5290b598df606\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/jsonCanonical.js\":\"5a24a81fcecc8450\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/kernelInvalidation.js\":\"4f24283c057f08cf\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/kernelProcessors.js\":\"c7ade1456ffd5592\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/kernelQueries.js\":\"31484f294cbebfd9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/mergeTypeMembershipProcessor.js\":\"edcdd5ffc943b0a8\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/normalizeReferencesProcessor.js\":\"c21149136c46ee7a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/poolInstrumentation.js\":\"bc246aac9b300a85\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/processorRunner.js\":\"78ddc60027c44f0d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyCellBackfill.js\":\"4e3a69831666c131\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyChildMint.js\":\"37bd4fde81332403\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyChildrenProcessor.js\":\"2709c35c4626e15e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3c578313ace03525\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyDefinitionSynthesis.js\":\"f940f0da2534d057\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyKeyScan.js\":\"365b7520f7bc9f7d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertySchemaResolution.js\":\"b716d4838cc961b0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/raiseProtocol.js\":\"6519a17e532b73cf\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/readBatch.js\":\"2655e808a8c8b02b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/refProjection.js\":\"1a5c196115c894e5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/referenceTargetLookups.js\":\"f7c0e1538acc5176\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/referenceTargetProcessor.js\":\"9c7d508095e18d49\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/replayMerge.js\":\"66a3d6518d4ec7b6\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/sqlBinds.js\":\"9fccfe53fea99189\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"59a122951824280c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/arrivalProcessors.js\":\"857f2313a6d2b118\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/invalidate.js\":\"7f1ddc5f07dc24ee\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/materialize.js\":\"96a5cc8d97e2fd33\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/observer.js\":\"b1c8e4364f676d28\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/reconcile.js\":\"65514cf9247fc946\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/timingMetrics.js\":\"1905b9683ccfd5ed\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/treeQueries.js\":\"3d3b7e686a4b6cb3\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/txEngine.js\":\"ef601c52d7783021\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/txSnapshots.js\":\"fe296b1fe00e27f5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/typedBlockQuery.js\":\"3b90afd016c10084\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/undoManager.js\":\"7a284862954dbee2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/invalidation.js\":\"3c25a0655348eeb3\",\"/knowledge-medium/pr-preview/pr-1796/src/data/kernelDataExtension.js\":\"265159ebe38dae5e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/kernelPage.js\":\"8a20317aea2c36f7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/kernelValuePresetCores.js\":\"26d7473707595a0b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localDbCorruptionSignal.js\":\"a8a60302a7f6a21b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localDbStorage.js\":\"ef9e8f3944a158c4\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localDbVfs.js\":\"65c6624d6e56db80\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localSchema.js\":\"401a7431b9a8233b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/maintenance.js\":\"1bcbaf9e22213187\",\"/knowledge-medium/pr-preview/pr-1796/src/data/mergeProperties.js\":\"e50029280e049831\",\"/knowledge-medium/pr-preview/pr-1796/src/data/metricsConsoleHook.js\":\"7b86dd3e5354381c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/migrationsPage.js\":\"4c5a3256e6ddf945\",\"/knowledge-medium/pr-preview/pr-1796/src/data/mutators.js\":\"9d53b695b8058d12\",\"/knowledge-medium/pr-preview/pr-1796/src/data/orderKey.js\":\"bff3dd158276c753\",\"/knowledge-medium/pr-preview/pr-1796/src/data/orderKeyPlacement.js\":\"6266ceca03d5af62\",\"/knowledge-medium/pr-preview/pr-1796/src/data/outlineSurface.js\":\"3adc6486c4610c8a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/pendingEditorContent.js\":\"f1ecd3eec4a5617c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/pendingUploadsSql.js\":\"52df3cae7117370b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/pluginStateExtensions.js\":\"a25ec118e44d561f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/powerSyncLogger.js\":\"821404121c82366e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/projectorRuntime.js\":\"475c785e35096837\",\"/knowledge-medium/pr-preview/pr-1796/src/data/properties.js\":\"5bff0f38379a3b88\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertiesPage.js\":\"55a60feefc3dd190\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyChildren.js\":\"859a05aa3e18941c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDefinitionFanout.js\":\"b45455201af41285\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDefinitionMetadata.js\":\"be3583b26ae9115b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDefinitionRegistry.js\":\"cf1be71368de9e54\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDisplayMode.js\":\"357551d53508ea4d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyRowCreation.js\":\"95ec5f1c5b00f273\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertySchemaCreation.js\":\"69f2b97ee5ef3940\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertySeeds.js\":\"632c06db9ddffd48\",\"/knowledge-medium/pr-preview/pr-1796/src/data/recentsPage.js\":\"8f8d118d8feca970\",\"/knowledge-medium/pr-preview/pr-1796/src/data/referenceBlock.js\":\"4b4b2d4b378bace5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/releasePowerSyncConnection.js\":\"069e15dbe763346a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/repo.js\":\"6192c3c0766576ef\",\"/knowledge-medium/pr-preview/pr-1796/src/data/repoProvider.js\":\"277502a278f82bbc\",\"/knowledge-medium/pr-preview/pr-1796/src/data/rowProperty.js\":\"13d4408817672c4f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/searchFilter.js\":\"98721d9fb343a3a1\",\"/knowledge-medium/pr-preview/pr-1796/src/data/seedIdentityLedger.js\":\"c40ee3128c3d0474\",\"/knowledge-medium/pr-preview/pr-1796/src/data/stateBlocks.js\":\"c8f1a65166c5ad7a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/structuralEditPolicy.js\":\"406028e95caafe77\",\"/knowledge-medium/pr-preview/pr-1796/src/data/subtreeDelete.js\":\"845a078675133a14\",\"/knowledge-medium/pr-preview/pr-1796/src/data/syncStreamLock.js\":\"f0788c38770b1b87\",\"/knowledge-medium/pr-preview/pr-1796/src/data/syncedTableSqlRecognizer.js\":\"3913177f0fe9a0d2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/syncedTableWriteGuard.js\":\"b4d46a9c79f01061\",\"/knowledge-medium/pr-preview/pr-1796/src/data/targets.js\":\"d7ecb43f58452d8e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeColors.js\":\"b512b01c72365b43\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeDefinitionMetadata.js\":\"3be3f36644767bfe\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeDefinitionRegistry.js\":\"ca2930fa1097d0c9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeExtraction.js\":\"638209d7e2a67a67\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeInitialValues.js\":\"946831b75d1c6dbc\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typePropertyGroups.js\":\"561891c9b9d82f3a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeSeeds.js\":\"27c9f56bd72c44a4\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeTagger.js\":\"03b4dd28f3fb9674\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typedRecords.js\":\"abf146a98db87f53\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typesPage.js\":\"e3ab62d155b324cc\",\"/knowledge-medium/pr-preview/pr-1796/src/data/userPrefs.js\":\"2d87cb7611c3017d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/userSchemasService.js\":\"b440dc6e6d9d12c6\",\"/knowledge-medium/pr-preview/pr-1796/src/data/userTypesService.js\":\"ac8d9eb703df37a6\",\"/knowledge-medium/pr-preview/pr-1796/src/data/valuePresetRegistry.js\":\"6ee2a074657cd51d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/visibleChildren.js\":\"8befe7b97d3e7822\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceConversion.js\":\"b24902231049f88c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceFirstSync.js\":\"8b51baefcf129ec7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceIdNamespace.js\":\"d9e2d22e4584a7fd\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceSchema.js\":\"3b456ff7d3f1622f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaces.js\":\"846fdd871d000418\",\"/knowledge-medium/pr-preview/pr-1796/src/data/writeAheadLog.js\":\"004d6d3dbe6f8e63\",\"/knowledge-medium/pr-preview/pr-1796/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/BlockPasteShellDecorator.js\":\"598fe501555f7b3f\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/atTrigger.js\":\"f1fbf0b7503b7aee\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/autocomplete.js\":\"651ee0380eb9e65b\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/codeMirrorExtensions.js\":\"78d255dd1b3ab875\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/contentFlush.js\":\"b8cd029ee9763d6d\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/defaultInteractions.js\":\"277b34fc3961cc7f\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/editSettleSignal.js\":\"35d573cf18263636\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/insertImage.js\":\"68cd09fccaf5f76f\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/referenceCompletionRange.js\":\"058b925cc97e7d00\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/referenceTargetTypes.js\":\"e400e5130778ef1f\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/syntaxContext.js\":\"5cbcb256ace4b10f\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/triggerMatch.js\":\"a6457a369e4afc05\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/AppRuntimeProvider.js\":\"b85e3efbb74bd4ec\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/BlockFocusShellDecorator.js\":\"6686161c8e6a40bf\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/ExtensionRenderBoundary.js\":\"00df95ddb5cbda52\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/PanelContentRecovery.js\":\"33e219be6d2e473f\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/apiCatalog.js\":\"e040378668ccc45c\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/approveExtensionHere.js\":\"79f8aa255e7d3ab5\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/armedCutAppMount.js\":\"c27fc2d6dbf01f0a\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/batchableKeyedStore.js\":\"ce626f266615cb9b\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/blockInteraction.js\":\"731d221178f21b7d\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/blockSelectionAction.js\":\"dc7fb6b387d0b9d6\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/compileExtensionModule.js\":\"6abb211ee1ea8cd1\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/compiledModuleCache.js\":\"ce3280078b401ec2\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/continuousGestures.js\":\"7a8e3eced170809b\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/core.js\":\"2e44a056a103ed3b\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/defaultRenderers.js\":\"30573cafc513808d\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/definitionFanoutAppMount.js\":\"ee6b5e8f5d230363\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/dialogAppMount.js\":\"0c2a01d2b9cdb13d\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/dynamicExtensionSeeds.js\":\"8cb91f2f32ca82ae\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/dynamicExtensions.js\":\"7ef9f28056d6cf83\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/exampleExtensions.js\":\"965093ec9825f76b\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionApprovalStatus.js\":\"bbc736f9541959dc\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionLoadErrorToast.js\":\"14dceb3374d762d7\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionLoadErrors.js\":\"4975f49ceb9ecdbc\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionLookup.js\":\"89591149a52af70d\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionToggles.js\":\"799e88c594c87845\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionUtilitiesCss.js\":\"4dcee627cd77198e\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/kernelPageDeletionGuard.js\":\"757cbec18ed59c25\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/liveRuntime.js\":\"51a065257ffae574\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/openExtensionsSettings.js\":\"6d732cd01277ebdf\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/overridesCache.js\":\"8e8ef429f60c09b1\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/pluginIds.js\":\"d5ff142b38546478\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/processorRejectionToast.js\":\"0ead25f84c1e664f\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/runtimeActions.js\":\"6388c56e627bac94\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/runtimeContext.js\":\"5e1003d16e79e91e\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/staticAppExtensions.js\":\"827930a99974f743\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/staticDataExtensions.js\":\"f16a00aeeac4b2e5\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/toastAppMount.js\":\"3a72ef4a8bc5861b\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/useOverrides.js\":\"e619450867b67312\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/useShortcutSurfaceActivations.js\":\"d157e2447fbabf40\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/discoverToggleTree.js\":\"a597ecc5ddc9b70a\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/facet.js\":\"7e7588af5c233f7c\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/resolveAppRuntime.js\":\"a3c03730d3878a6a\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/runtimeEvents.js\":\"a9ffc347679615cf\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/togglable.js\":\"fe679b5ec6eb26c9\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/variantFacet.js\":\"718e27fdb20cf845\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/verbFacet.js\":\"c246f910843f7522\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/block.js\":\"772a121f5e01b85b\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/focusedChild.js\":\"88865898fd9ca75c\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/propertySchemas.js\":\"e42d53e9b482fecb\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/typeRegistry.js\":\"67f34f38f57d8fad\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useAncestorCrumbs.js\":\"89c5a5976e37bb00\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useAutocompleteListbox.js\":\"c5a5f4d57fc373ce\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useDebouncedSearch.js\":\"8b8df11d362fc88c\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useDebouncedValue.js\":\"53298126ab5e3cca\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useIsFocalRender.js\":\"0c3d01d2cba2b530\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useIsReadOnly.js\":\"ae14a373e3578cf6\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useMaterializeBacklog.js\":\"f89e9802d4daa789\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useMinuteClock.js\":\"d4063c9fe182288d\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/usePanelLayoutProjection.js\":\"aaa3d867d37f9178\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/usePendingInvitations.js\":\"2ca3a19e00eb32fc\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useRendererRegistry.js\":\"a75743bbdee11c89\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useRetainedFieldRows.js\":\"a0ba52511f072469\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useWorkspaces.js\":\"b57001967e598c41\",\"/knowledge-medium/pr-preview/pr-1796/src/lib/utils.js\":\"9a78cd2e18875bbb\",\"/knowledge-medium/pr-preview/pr-1796/src/main.js\":\"e1d048f1ea61e44e\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/MarkdownImage.js\":\"41b96193632b671d\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/blockSeparators.js\":\"dbb2cb84b0bded9d\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/context.js\":\"d2a593c8c9913d69\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/defaultMarkdownExtension.js\":\"899e9714f19da087\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/extensions.js\":\"264895955db0c37d\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/renderMarkdownHtml.js\":\"e938603a3c23fb8e\",\"/knowledge-medium/pr-preview/pr-1796/src/minimal-editor.js\":\"00c9a4c7315ada77\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/armedCut.js\":\"21aec6c3739d0feb\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/captureMediaVerb.js\":\"9560bc124817e440\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/clipboard.js\":\"1361a1b136175a35\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/decision.js\":\"6d7bb06a6de952a1\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/operations.js\":\"238a623ec6c492dd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/account-header/AccountHeaderItem.js\":\"a00d4828a9ecbbb0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/account-header/index.js\":\"cc1aef9133416f0b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"37f1109a0d7ed877\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/askAgent.js\":\"27855e23336aa4dd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/askedStore.js\":\"ba12d074b949bbba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"45f980697a963621\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/chipState.js\":\"caed0d3b36948e01\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3dfb91d2cc66d25f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/index.js\":\"db62484e38fb30a8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"71f92f457708e995\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/schema.js\":\"eb34e738055cf49a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/AgentTokensDialog.js\":\"76d4db0008e48c27\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8d56022c42b9523d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/addMedia.js\":\"eeab7d7fe297b8f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6fc5350e6ad51f9c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/block.js\":\"0cd34c6f61246433\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/context.js\":\"2475d776e148b005\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3da8af6937998d9f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/index.js\":\"f067d7a13ef91583\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/outline.js\":\"a3ef556e26b8e065\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/properties.js\":\"1018cee4be82058e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/refs.js\":\"31a8d96e28045964\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b06bbd276be8f472\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/search.js\":\"f603e654449eab05\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/shared.js\":\"768668f39e0e6bdd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8b9feaf9b1973e2f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/text.js\":\"0cb249ae28f70ce2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentWrites.js\":\"1092deb5591a88f5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/authoringCatalog.js\":\"8b51f44f64af82a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/blockRefTargets.js\":\"f59aeba6801779b1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/bridge.js\":\"df74c1fdffec1aab\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/bridgeLoop.js\":\"311e44b14b6354ce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/changeHistory.js\":\"85ae39ca5522675d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/commands.js\":\"05fc12595a722860\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/commentsCommands.js\":\"c2ac9b95e4d522cf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/dataExtension.js\":\"c92cd28f09dd9ec3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/dataModelGuide.js\":\"5be912381330a9ab\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/describeRuntime.js\":\"579a0cbf7653fda0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/extensionLint.js\":\"48b7d69287af24c7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/grainAudit.js\":\"04961f77bde36f22\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/healthCommand.js\":\"bf45f0d3bcd809e5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/index.js\":\"da432728586c449f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/presetIdentity.js\":\"9fec0df483dd12db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8ec98cb50ddd26f6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/readMedia.js\":\"6e2eac1fc97614a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/schema.js\":\"3d53ec9894f7a6bc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/serialization.js\":\"4ee19a3063c09854\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/targets.js\":\"4f82adbeaf67ddaa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/tokens.js\":\"e9262a9699c66dd0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/watchEvents.js\":\"6b7a6a81db7c0079\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/workspaceGuard.js\":\"3c92aee2bf041dfc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/writeCommands.js\":\"daae35c540b2eaf8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/AliasCollisionToast.js\":\"d3589b66d11c2e8d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/DuplicateNameBanner.js\":\"76c80c532273ef90\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/collisionMerge.js\":\"0135cfc42dae7a40\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/dataExtension.js\":\"4ad7949564085dd0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/index.js\":\"7d1a1abb354033d2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/mergeCollisionAction.js\":\"ba553731cd0ea58c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/pageStyling.js\":\"3d81b460027ccf7c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/rejectionToast.js\":\"e67c10dfe7c9e1ec\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/syncProcessor.js\":\"55c122fd6b1681db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/actions.js\":\"61e507321a9badee\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/addComment.js\":\"0e30f6504c8f0dac\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/anchor.js\":\"81a7dd366c71b42e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/anchorState.js\":\"c16ac1719850d8c4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/commentLinks.js\":\"ff956cdc5ca835d7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/confirmThreadDeletion.js\":\"8d939590d140fb54\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/container.js\":\"84f98305440faf50\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/dataExtension.js\":\"a0df7700067bab8b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/deleteComment.js\":\"4d480ac4e7e50076\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/highlights.js\":\"bf3f8acacd3a8efe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/index.js\":\"18475194b7d39e44\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/linkedCommentsPill.js\":\"0fc2cd282ee9e5df\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/margin.js\":\"116bc0804666627b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/marginSchema.js\":\"84bb5196b6c24c69\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/newComment.js\":\"41c18d9e448f69ce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/ownThreadPicker.js\":\"2b0bc19c0df8a1a2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/placement.js\":\"d87f4782ba1de4aa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/queries.js\":\"5743becdceb71fa0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/quotePosition.js\":\"5d25fa6286c4edc1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/quotedIn.js\":\"6c99b86b903227ad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/quotedRange.js\":\"9bdeddcc78d5e1b8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/rangeRefs.js\":\"481b65cf9ecf9a3e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/readHighlights.js\":\"947b71c9ecdb6f90\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/readSelection.js\":\"fcffc63a0a1512a6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/readSelectionUi.js\":\"462f59055122b06b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/reanchor.js\":\"dcd8f07ee4f67e22\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/schema.js\":\"4a325bda4fda027d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/scope.js\":\"82e045c6db23b8e5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/scopeThreads.js\":\"9f3c8491289349a3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/splitRetarget.js\":\"63b04b360bfe23ff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/suggestionCard.js\":\"58ce394a96b8ab6f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/suggestions.js\":\"7f353da17289b74d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/summaries.js\":\"8f651ad8c85ca726\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/summaryBatch.js\":\"205c00de01217003\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/surface.js\":\"3c19120c0dd7f154\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/threadNavigation.js\":\"d5707dce317a7414\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/threads.js\":\"71c525a659a8d85c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/ui.js\":\"ad9113d9671e94b3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/uiStore.js\":\"48309004cf0a273a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-intents/appIntents.js\":\"529c4a3809315d20\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-intents/index.js\":\"96de40ddc857bbfb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-update-prompt/index.js\":\"218666a0eabf6752\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-update-prompt/status.js\":\"b58317091721d13c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f147373c30a4b2d2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/MediaBlockRenderer.js\":\"f0aa7d6819772a70\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7c11bce1bad6b7d8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/MediaUploadReconciler.js\":\"182d24c2d8df9598\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/assetDownLane.js\":\"db535fcc91ee2e3c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/assetResolver.js\":\"a21fda9161cb3091\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/assetUpload.js\":\"77ecd677d84bee71\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/attachmentCleanerIO.js\":\"c7caab80acb6dc7a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e1a73e26acdd1c40\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/blobStore.js\":\"3a6e4ff3fd8767db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/byteStore.js\":\"47c3294519cc9ffc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/cleanerIO.js\":\"0598ac51c6254f3b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/cleanupAttachments.js\":\"df694163aa3c9ffb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/dataExtension.js\":\"9867a7defa9811c9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/downLane.js\":\"65cd86eab29bf910\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/index.js\":\"d54b261fbeefde64\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/insertImageContribution.js\":\"2ca092b8d1a786f5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/laneArming.js\":\"6dd5fd0aa337e05d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/laneLock.js\":\"ded1f75d3a47bd9d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaBlock.js\":\"ec9317e0139b0953\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaCapture.js\":\"cb9d08112d261203\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaViewers.js\":\"cffb18992c96cc01\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaViewersFacet.js\":\"4b9a51aa3715592c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/pasteCapture.js\":\"9dd26b75ba740843\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/resolver.js\":\"53a0865bb46f00c5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/retryUploadsAction.js\":\"6f40cde36c0a2ed1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/storagePaths.js\":\"9b950228ac0ebc6a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadDrain.js\":\"e5106ddf87cd9862\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadLaneStatus.js\":\"fa7b81e3edf082a4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadReconcile.js\":\"b4330d2b24ba2195\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadRecovery.js\":\"77d3adaabaed2ea6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadStore.js\":\"cde9ab7e20604988\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/useAssetObjectUrl.js\":\"4f1368f630781bea\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"33a1fe4f253fa9ce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d54b240b0345a0d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/facet.js\":\"46088e9922476df5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/index.js\":\"813edc158d18407b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/prop.js\":\"409e512aefc93d20\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/BacklinkFilters.js\":\"86dfd32d10dc0966\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7b06b7e974932ce4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/BlockEntry.js\":\"43e111a62013ed15\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/LinkedReferences.js\":\"20c5dc14e6e01556\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c7960b4b36cf0adc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/dailyNoteDefaults.js\":\"9c881aba70c057c9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/dataExtension.js\":\"8f98de22314b3af1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/edgeExclusions.js\":\"297df476a60eecaf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/filterProperty.js\":\"7b6abf589a4d4375\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/index.js\":\"f109af0c16bb69b5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c408687629e86354\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/applies.js\":\"f32367b8d439c4c5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/countQuery.js\":\"48a8ee06fdf3ebb1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/expansionStore.js\":\"61cff0117653812f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/index.js\":\"fa54cf750cf8f260\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d4951badce9d9566\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/presentationInvalidation.js\":\"3c42a923e0320f9c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/propertyEditorOverride.js\":\"f221e0f3f87df78a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/propertyFilter.js\":\"636596420722ca8a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/query.js\":\"4f6633a7fe8aa38e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/resolveFilter.js\":\"675a98636f9fbde5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/sourceBatch.js\":\"eaf46d042d921f06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/sources.js\":\"14d55eae906525ab\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/useBacklinks.js\":\"965dbaf37a4fb34a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e28e0262fa4ed5be\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/BirthdayCelebration.js\":\"9e9fb7ca9da12d68\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/BirthdayOverlay.js\":\"ec2c730962b5e494\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/gate.js\":\"2a7c92c3607c1ded\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/index.js\":\"ca5525679bece00a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/wolfTheme.js\":\"0fa2305558f2ad5e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/BlockDragLayer.js\":\"e2a45cdf7674f5df\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/dragController.js\":\"f266cc3a0e2bae4d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/dropTarget.js\":\"1c2cb5a7fcb8670e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/index.js\":\"3c2d1a5b1ddb69bb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/projection.js\":\"e91805beb9366b07\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-info/BlockMetaCard.js\":\"fd2ff957b1594816\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-info/index.js\":\"13fc932ff208ac26\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/AddTagDialog.js\":\"5819198772277c52\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"12b92087f22e7960\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/TagNameIssueHint.js\":\"f86e36d98538461d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/addTagAction.js\":\"aacdb028628acf08\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/appendTag.js\":\"839c33e2da24cbba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/config.js\":\"c662961a55f991ed\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/dataExtension.js\":\"5c3ac7ad7cc72b74\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/index.js\":\"43fa64fcb4cc9cfb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/propertyEditorOverride.js\":\"a100187a671c5f74\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/BreadcrumbList.js\":\"91af5a3fbc9ce702\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"14cc56f31da54d9c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/Breadcrumbs.js\":\"0c0fe0bdf090ae5b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2af9cfa1a1f1e76b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"be4058ac89ae63f0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/index.js\":\"7c72af69f1259298\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cc6d9395f8bfcc59\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/CharacterCountItem.js\":\"43a65af65be55223\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d489cce9256ef69c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/actions.js\":\"2053003edb21ac80\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/blockType.js\":\"bb4abc8539cb2027\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/charCount.js\":\"d04d1f77fdda98b4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/dataExtension.js\":\"6086d879922df552\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/index.js\":\"30acd306128f8e1d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/profiles.js\":\"1d862698f270dac4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/properties.js\":\"abd53c6441e87d90\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/textCounts.js\":\"9f81107c5dd65825\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/colemak-keybindings/index.js\":\"d2d5b32be421b128\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/CommandPalette.js\":\"2c1400afc648af56\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/HeaderItem.js\":\"4d5f250dd3f79a37\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/context.js\":\"45ce3357aa8e20b2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/index.js\":\"d4acbb3bb84ecc11\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/selection.js\":\"e34d61af5010b4a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/toggleStore.js\":\"fdb15f5f7a03108e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/useCommandPaletteActions.js\":\"e73b303c3110bc4f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/ContributorBadges.js\":\"0c5fd0ac6a8c65ab\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/author.js\":\"b49d49c4f8ce47eb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/codeMirrorExtensions.js\":\"3de7c73b6d651e13\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/dataExtension.js\":\"a4564f0263b47ed7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/index.js\":\"29e89cfd2d1551bf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/mentionAutocomplete.js\":\"16e4cb2ccc9d369e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/processor.js\":\"48f73d87bb1da40b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/profiles.js\":\"55b4ec61ea860aa1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/queries.js\":\"2f13c57a6005e596\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/schema.js\":\"115c9da7e6c5b633\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c20f4256076fbf63\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/followOrigin.js\":\"54ccc9bcb70b0cd3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/index.js\":\"5f0200d517b3a4fb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e875cd9b93247d4c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b855ca2965ef12b1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/CalendarGrid.js\":\"5e6f3ac098ee58fe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DailyNotePicker.js\":\"04803dcafe1cd33a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"5ded375533ea4b11\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DateNavDecorator.js\":\"7fdb86a419eb78e7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DateScrubOverlay.js\":\"e3774309195bb0d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/HeaderItem.js\":\"023d5ff7d2ca95ea\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/ReschedulePicker.js\":\"9f71a710d44bc0e6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/SpreadDatesDialog.js\":\"08e911e9daf2b96e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/actions.js\":\"eb6d151f6ccd20c8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/blockDateAdapter.js\":\"b0f5f88d4399684a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/calendar.js\":\"c35ae818dec66ffd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dailyNotes.js\":\"1c8e68962cb612e1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dataExtension.js\":\"c9069f48310a5080\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubActions.js\":\"f16b92280199a099\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubGesture.js\":\"cdced07466be4dfe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubGestureActions.js\":\"eac799ccd8f71e0f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubRecognizer.js\":\"276c72fc94368902\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/deletionGuard.js\":\"519edc53f07d955f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dueQuery.js\":\"764f26f25701178f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/index.js\":\"a32df5285b48aa50\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/landing.js\":\"0c7a40e20f187536\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/localSchema.js\":\"c7519f41ccfa6b94\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/referenceDateAdapter.js\":\"296b28d525344789\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/rescheduleAction.js\":\"c80895c841887fba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/schema.js\":\"1413917cc602806c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/spreadBlockDates.js\":\"e294af40cf40b1a7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/spreadDatesAction.js\":\"60277dce0ca9ffcb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/today.js\":\"b2c3e7151396d664\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f73ff07494527775\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e3d219cd7696bb70\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/audit.js\":\"63162fce96e580cb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/auditAction.js\":\"90eef1fba763c61c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/auditRanges.js\":\"63ade3795ff216c0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/diagnosticsSource.js\":\"61c504a8215aead9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/divergenceScan.js\":\"5e8d898056bb815e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/index.js\":\"c16e5622e5361459\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0ce854f1d63ff8f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/referencesMirror.js\":\"274a01994a45c381\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/rowJson.js\":\"9d509e61ef13a665\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/schedule.js\":\"4dc019d6e38facf5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/store.js\":\"42cfc08eccecad47\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-maintenance/action.js\":\"4c3422045d408bcc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-maintenance/index.js\":\"bb3accd2955e45b6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-maintenance/plugin.js\":\"9c180a0080d13fdb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0690a2de7b999589\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/actions.js\":\"2d8eebedb07cc68c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/changeMarker.js\":\"60f1fe07d13df4b1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/diagnostics.js\":\"97ca7589e4bc5a4a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/fileSystemAccess.js\":\"19caa04798c1e61c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/filenames.js\":\"393f010c5a814791\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/index.js\":\"6ae690e60feef6ff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/mirror.js\":\"83c0d79ffaef782b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/runLock.js\":\"20ed86291123c858\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/runtimeHealth.js\":\"78d70bb3df84f509\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/schedule.js\":\"b2ddae09b63e322f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/store.js\":\"e920f47ac5e8f326\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/default-themes/index.js\":\"78fa76bbc88d5219\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/default-themes/themes.js\":\"78985eaf79d92d6c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/diagnostics/facet.js\":\"35835f0419f52bbe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/diagnostics/useDiagnostics.js\":\"7a57d1118d4a13d8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/dismissals.js\":\"173bebc250a1eca6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/index.js\":\"fe1512f2cd5b56ec\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/status.js\":\"492235be244ca789\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/store.js\":\"bcc43f2bab29320d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5158d167b270009d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c86790ba4018fc6d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/actions.js\":\"c6cdc3c2d0838c91\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/config.js\":\"13e6c8926383595a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/dataExtension.js\":\"1e20c7890b9b71ae\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/effect.js\":\"d9d4b471fb206b00\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/index.js\":\"42d08820b185e2dd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/propertyEditorOverride.js\":\"34ac5ee835a26296\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/useToggleTree.js\":\"c4c4a23c47608d6d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/ExtractTypeDialog.js\":\"13c83cb758645174\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"27ecefc6ffd97e18\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/PropertyShapePicker.js\":\"40302da447a4822f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/action.js\":\"030022466734869a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/index.js\":\"33561a24a41f7b1f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/FindReplaceDialog.js\":\"d8c537e711c72000\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/HeaderItem.js\":\"c9950c9b36a110fa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/dataExtension.js\":\"8d5e4d0430644224\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/index.js\":\"15c465cfeef59d75\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/search.js\":\"79a2ede81e096725\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/toggleStore.js\":\"a96f1ffd6d645a43\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/LocationPropertyEditor.js\":\"2ff744a8e94fb227\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/MapView.js\":\"8417d7d0bad16439\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/blockTypes.js\":\"74388adaad706f6a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/codeMirrorExtensions.js\":\"10a17ca11b6f1f67\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/createOrFindPlace.js\":\"a0cc89609da78007\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/currentLocation.js\":\"6c49d2ddc25d7753\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/dataExtension.js\":\"44fe799a2e0a28db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/geoContentDecorator.js\":\"4f790935c31ac2ec\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/googlePlacesClient.js\":\"819fcab34cec3eba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/index.js\":\"3f7fc3419515536d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/locationsPage.js\":\"db85d25aaecbb944\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/mapViewport.js\":\"110c7e116655298c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/pickCurrentLocation.js\":\"d868fa8ea607080a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/placeAutocomplete.js\":\"489db1af078a2794\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/placeNameCollision.js\":\"c4649a659791f0c2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/properties.js\":\"54bafff8797b89dd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/propertyEditorOverrides.js\":\"4f60dfa923df8784\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/query.js\":\"fc3779bf8b8b0711\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/usePlaceSearch.js\":\"f26dff83215b9ea6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"00ea3b24473ebcd5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"60eed16b5fbbcecd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"19bc9dd56b54a6c7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/config.js\":\"c28327beb39c4f3d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/dataExtension.js\":\"346c1310eae09636\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/facet.js\":\"6fd0b6d8be7b14e5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/grouping.js\":\"a33f3f93404eb4a1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/index.js\":\"f88c582140c5fdcb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7356f8dd4dfffbd3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/query.js\":\"1f369ad34b8f2118\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/resolveConfig.js\":\"925a8086a625bffd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e3a6319194427812\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"dcd55e394805cb09\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/HtmlDocumentContent.js\":\"673c15a6d086970f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/HtmlFrame.js\":\"b3b9586862c48a52\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/actions.js\":\"dd0445b1e8174413\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/blockType.js\":\"7d98df57bb0f5435\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/confirmRunScripts.js\":\"a65c1fc8765292b0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/dataExtension.js\":\"858231d88d9ea8cb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/frameAnnotations.js\":\"c9d1c12f7ca35b58\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/frameDocument.js\":\"5711cb9e085ed5d9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/frameTheme.js\":\"31a94e77f485229e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/index.js\":\"886c1891fb02c757\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/scriptConsent.js\":\"6989a57f6d5e172e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/sourceMap.js\":\"9951052d432a2f56\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/useDocumentScripts.js\":\"391a8270ad867034\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/index.js\":\"714a1e3a2541d512\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/record.js\":\"1cc667d9310de69f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/recordStore.js\":\"c2317fe593d2a7b4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/responsiveness.js\":\"401775867ac62069\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/schedule.js\":\"2c951cd9620b115e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/sessionContext.js\":\"7633fcb67a1e38fe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e9a8fe09573229c2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8f91b4248a37c2ee\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/actions.js\":\"965b953409a21376\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/config.js\":\"dcfc2c8876505d09\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/dataExtension.js\":\"d8492471e045d012\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/effect.js\":\"b2803bc85706ef55\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/index.js\":\"141fe0d64edcb0d6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/keyCapture.js\":\"2a896c34071a34f7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/overrideStore.js\":\"bb46c5c3ceb349c5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4e684f3f9dd62a82\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/HeaderItem.js\":\"899a689232609055\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/LeftSidebar.js\":\"df7c783f43049d5f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/actions.js\":\"79df183644eeb90e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/facet.js\":\"e665f6b16ce00f2e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/index.js\":\"6a80cb8a551d1e8b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/shortcuts.js\":\"8bdbda1a30b7c935\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/toggleStore.js\":\"a79d778eefe95df3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/MergePicker.js\":\"54e7272c5efbec0f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/index.js\":\"69e1021f3fe69d9d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/mergeAction.js\":\"d37e4fb06e1a8853\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/strategy.js\":\"c6d6eccaf38ea40e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/Button.js\":\"b0fffcbe375ccbaa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0addf210c239deff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8314e5a3df47dea5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/facet.js\":\"1d137dbd1d8e2934\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/index.js\":\"d4a373f31d9a54bb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"512fdc6ee936801c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1fca6d0ac9585153\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1852c2a713d8e2e4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/facet.js\":\"01d93f060cc17b62\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/index.js\":\"2ec0b09542ec2b3a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6f16deb2665e3a68\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f3aede6844cd3c15\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/contextMenuItem.js\":\"c9ceb136cbc37081\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/index.js\":\"6110733a022a00c8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/moveAction.js\":\"26ae06b395922c10\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/moveBlocks.js\":\"709fa571d640c1f1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/selectionAfterMove.js\":\"c7754df864ac5893\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/TutorialBanner.js\":\"1638c7ea460c1530\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/action.js\":\"8290ef9eb2a8e712\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/bannerDismissal.js\":\"905026a351f6e24d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/documents/cheatSheet.js\":\"fa1a7e0dc88ba7db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/index.js\":\"520d705c49518688\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/keys.js\":\"6b92c199dae47735\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/landing.js\":\"c12b3b6c5c6dba93\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/outline.js\":\"e91c5d897e2a5880\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/seed.js\":\"eff34fc1960065d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/PerfTrendDialog.js\":\"677523d133cbcf20\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/analyze.js\":\"e56feb62fc0626a5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/diagnosticsSource.js\":\"0ab4c9072c65f98f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/index.js\":\"c9e519f55257c8c6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/load.js\":\"757751ff457089f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/monitorRun.js\":\"06843afc701786ab\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/schedule.js\":\"263dbf493f1c4221\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/series.js\":\"c18b7abed8c54583\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/store.js\":\"7663e147477761cb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/trendAction.js\":\"eebc53ff6b6aac51\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/verdict.js\":\"fd407e28b3f91349\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/plain-outliner/clickToEditAction.js\":\"aae64cfbf8850286\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/plain-outliner/index.js\":\"e3e5408ceb2d4035\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/plain-outliner/interactions.js\":\"7ade23ba2cb0fcad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7c9157f566818d88\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/MigrationGate.js\":\"6915b82eafb81199\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/MigrationGateDialog.js\":\"efef6b9365a1a02b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/action.js\":\"35f873ba9942f526\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/index.js\":\"fa811247f1d08947\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/localRunMessage.js\":\"a3ab43c5697677da\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/plugin.js\":\"3e6f8d7409084813\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/progressReport.js\":\"87c4d5fdf73243e4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/sweepProgress.js\":\"985c72d066c82126\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/FieldRowRenderer.js\":\"d9ad08884106cd94\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/ValueRowRenderer.js\":\"07e50a92465afb06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/actions.js\":\"be66d07783621a06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/autocomplete.js\":\"0471c8e5052f6ff5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/fieldRow.js\":\"04b1bd8ad9d0877e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/index.js\":\"67465971ff801cd6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/referenceWarning.js\":\"5b4ae1cf28b14331\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/valueAutocomplete.js\":\"82ad4035971d1195\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/valueSchema.js\":\"21077d99ae72df08\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/HeaderItem.js\":\"467fad0b12ea6c7e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/QuickFind.js\":\"aefab71030a7a7fd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/index.js\":\"9ecdda533f07394a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/recents.js\":\"56ed32420195f5ea\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/resultItems.js\":\"6844a0c817f5c696\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/selection.js\":\"c89ba6de84672567\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/toggleStore.js\":\"ca5eca0d4599f6bc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/HeaderItem.js\":\"9e0280d71c8e5069\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d87dc351877f1301\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/grouping.js\":\"aa756e8c46f49a8d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/index.js\":\"20bffade1557d325\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/target.js\":\"20922004fe6f5b23\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/codeMirrorExtensions.js\":\"822d73abcfe2c7b6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/contentPrefill.js\":\"6f8e615b3ed40369\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/dataExtension.js\":\"82ed4c5bec309598\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/index.js\":\"41dfd14c8698eb26\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ef2046c12ec7e160\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/invalidation.js\":\"668dd7076548a81f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/localSchema.js\":\"81d32cd74a5b565b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/blockrefs/index.js\":\"5bee9a023c31a9bc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bda5aca26ab2de6f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/index.js\":\"af93e7bbe22bbeaf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/referenceNode.js\":\"f6515fbe70182dd8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b72f0a4574b5b924\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"0fb21f7439c31f46\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/index.js\":\"7a806b03208cc61b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"dbc5cab481e02f46\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"df31a1f616534c6b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/mergeRetargetProcessor.js\":\"5a31b5067cca2d77\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/parseFence.js\":\"534e0b1977c4513a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/referenceParser.js\":\"f98378eab5e75474\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/referenceProjection.js\":\"9b82d0141e96977f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/referencesProcessor.js\":\"0245024fe37504c6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/renameProcessor.js\":\"e7c170d666c28317\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/spanReplacement.js\":\"ea385944e7a599f0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/htmlToOutline.js\":\"7c9a407c454540de\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/index.js\":\"b23e1d4852f8f021\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/normalizeClipboardDom.js\":\"37b792d68fe9c2fe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/pasteDecision.js\":\"7bb7b9ba3cde453b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/action.js\":\"64dd0fdce51b920c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/blockIds.js\":\"fb89009a30b6cf84\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/content.js\":\"aea553f14e3f108f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/effect.js\":\"cdd290990f3259ab\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/ids.js\":\"728d6a8f816d76e9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/import.js\":\"88defe118e317d4f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/index.js\":\"7f50074a84b03017\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/plan.js\":\"49291f99e220986f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/plugin.js\":\"afd44b527b662c86\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/promotion.js\":\"3cf2db51c89ba6b5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/properties.js\":\"8cfedef7a00e9df7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/references.js\":\"92a1a0a93b78d4c6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/report.js\":\"ee0ba44c2f261e49\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/roamMemo.js\":\"5efb5a583170565b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/runtime.js\":\"f9f61f362530964f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/schemaReconciliation.js\":\"94007b808f172a8e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/srsMarkers.js\":\"cda6d8c664e0542a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/todo.js\":\"b73a6a2c69115718\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/typeCandidates.js\":\"2da6ce8f22941367\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/types.js\":\"edd0a11463f70114\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/search-health/index.js\":\"1d73fade26400085\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/search-health/store.js\":\"8c0ec62ff954d01a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/HeaderItem.js\":\"78b481c45493477c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"92654b6962940315\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/index.js\":\"c617b62a40301143\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/model.js\":\"e196be391c07ed56\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/toggleStore.js\":\"e4604a6c772e7d27\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/useKeyInspector.js\":\"dfc76972cc8891a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"72095eb402e4f666\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/ShellDecorator.js\":\"aaa33272c836e625\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/actions.js\":\"de35cff19f21516a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ce7fbdbc96ca9c0c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/index.js\":\"b26ee2699b3d4d26\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/shell.js\":\"658a8371e3a3328d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/surface.js\":\"0d6a77e8c837ab13\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/walker.js\":\"993400d6c4c4640c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d45ab919b9fe7cfc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/dataExtension.js\":\"f1981e0d977cc50a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/index.js\":\"bb17d060363c831c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/indicator.js\":\"c0ad43c02ce1323d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/moveSrsState.js\":\"dc06ef26b1bcbff7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e6bca1a3587fc9e1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/scheduler.js\":\"fdc6d2db25342b31\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/schema.js\":\"0f52233a9c33e59a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"78e4d25f92f70edd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/srsClipboard.js\":\"d3872e475ef7d8bb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"34964ef7b2c0876c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b5db525222052e06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/DeckPicker.js\":\"ca20aa19c5b84369\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/ReviewControls.js\":\"c83e171e4f352237\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9ea9a1c7c27b9822\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/ReviewSession.js\":\"920ecfdfb20713ce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/actions.js\":\"663ee9f00e4c071a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/archive.js\":\"c41b11dc3bfff92f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/dataExtension.js\":\"8596937b79321aa0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/deck.js\":\"cf142d2b09164a87\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/dueQuery.js\":\"737a1ae3cbf3f503\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/gradeDecision.js\":\"ac8a8081c52247cd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/index.js\":\"85d0d7de05c7a2cd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/keyHints.js\":\"428351a8b997da32\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/reviewCardLayout.js\":\"e123a6fa5c954ed7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/reviewProgress.js\":\"402c8f09db4a2254\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/schema.js\":\"9b347f8538e32bbb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/useDueCards.js\":\"479d24058ca22f5c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/startup-metrics/index.js\":\"b6487cf14e7ae948\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/startup-metrics/record.js\":\"53034a45a8f4fbbd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/storage-persistence/index.js\":\"2b6f12faf2e4520f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/storage-persistence/persistenceStatus.js\":\"03887fd4670a36de\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/storage-persistence/requestAction.js\":\"7964ba89531617e3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/TypeChipsDecorator.js\":\"394d8f9bc287f75b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/codeMirrorExtensions.js\":\"e86cc8be461b0d42\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/index.js\":\"86aabe728632b757\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/typeAutocomplete.js\":\"46e02832b36bcf3e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b75ef15caf1fc271\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/actions.js\":\"f369e44c4604a78d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/anchor.js\":\"7f1ed57e76187ec3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/events.js\":\"a313a807cf7c9c9a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/gestureActions.js\":\"d2c14599d68363c2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/index.js\":\"6f85ca922b19bd44\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5d6c814f43f26dda\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/sync-metrics/collect.js\":\"d6e1d34b6721a333\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/sync-metrics/index.js\":\"1bcc7ac944ed0f5a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/sync-metrics/record.js\":\"bd590bd6825fe73a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/RejectionDialog.js\":\"8b4b1f9c12d5136e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e56d4e50107ec80c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/index.js\":\"2bf5e78b00cdcc2c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/model.js\":\"e0ea3d5540d3a9b3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/queueCounts.js\":\"342ae8106597c79b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/rejectedHelpers.js\":\"b21e5d9435ae56f8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/rematerializeAction.js\":\"f75cc3207782f6bf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/useHysteresis.js\":\"2c919492d70f1dc0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/theme-toggle/effect.js\":\"0c51e0efc3394da1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/theme-toggle/index.js\":\"10b51a0f19df0433\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/theme-toggle/theme.js\":\"72db134738ae6b4f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/actions.js\":\"0e9c517166f22152\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/dataExtension.js\":\"e61b4c8975d7d181\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/index.js\":\"106207289f2669bd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/schema.js\":\"479d0106571c9954\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c64c28a9c3272ac4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/actions.js\":\"a5c2374fbcf0c607\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/defaultItems.js\":\"b2e3b171468d2153\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/facet.js\":\"02674663d850e898\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/holdRecognizer.js\":\"a2b83530e8136f80\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/index.js\":\"55525b9a2ea3cb73\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/update-indicator/UpdateIndicator.js\":\"8337297bb987460e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/update-indicator/index.js\":\"01dac3af1aa931df\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/update-indicator/loadTimes.js\":\"e7b61c8a2a2585ac\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/VideoNotesRenderer.js\":\"0f18035823c48de3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/VideoPlayerRenderer.js\":\"b8257a3ae788a697\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/VideoTimeStamp.js\":\"4ab7006d6941e522\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/actions.js\":\"101389244f1d720f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/index.js\":\"929ad067a89524d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/markdown.js\":\"3780f3e5aa36f89b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/notes.js\":\"db1caae0ccc5eb03\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/registry.js\":\"bb0acddb9b027371\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/remark-timestamps.js\":\"e0c9a35d9bac7333\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/view.js\":\"81d44a30475a4ea0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/LinkHints.js\":\"256cca44cbe9a4d7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/index.js\":\"2955e2ad416e10eb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/model.js\":\"b468006f11154280\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/settings.js\":\"0604ee95cbd04412\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-normal-mode/actions.js\":\"d7cdd16b75be6be6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-normal-mode/index.js\":\"1f5c34d3faf5119e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-normal-mode/interactions.js\":\"35a6f1f5e69f36a6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/workspace-header/index.js\":\"d8a022cb3701f8ed\",\"/knowledge-medium/pr-preview/pr-1796/src/registerServiceWorker.js\":\"6efced2071c68753\",\"/knowledge-medium/pr-preview/pr-1796/src/requestPersistentStorage.js\":\"9a283ee7f394ad9e\",\"/knowledge-medium/pr-preview/pr-1796/src/services/authRequestDeadline.js\":\"6b56500ba9d45890\",\"/knowledge-medium/pr-preview/pr-1796/src/services/authStorage.js\":\"231eb75ba53299f7\",\"/knowledge-medium/pr-preview/pr-1796/src/services/powersync.js\":\"c0d13ee420c193b7\",\"/knowledge-medium/pr-preview/pr-1796/src/services/supabase.js\":\"d0307eee6c19e8a8\",\"/knowledge-medium/pr-preview/pr-1796/src/services/uploadErrorClassifier.js\":\"a19e8f1062f0850f\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/ActiveContexts.js\":\"31df2cff3aba0d8b\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/HotkeyReconciler.js\":\"2dd5e18a600e35a1\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/WipeLocalDataDialog.js\":\"0fef94e6a70426eb\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/actionDispatch.js\":\"48be94cda3c02c57\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/actionRefItems.js\":\"ff9166c709746b56\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/applyKeybindingOverrides.js\":\"3a417d747158b428\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/blockActions.js\":\"d13470c1193da2a9\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/canonicalizeChord.js\":\"38fc98ae5361fc48\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/defaultContexts.js\":\"3e8ba934770182a0\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/defaultShortcuts.js\":\"bf39be450d730e75\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/effectiveActions.js\":\"69d1165f82dcb575\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/gestureAction.js\":\"7dc6048de287ce74\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/gestureBinding.js\":\"7299caea278f685d\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/holdRegistry.js\":\"1553ac80bc9a63f2\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/keybindingConflicts.js\":\"f0bdc5575e9bcc82\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/keybindingOverrides.js\":\"c1bfb556ba5becb7\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/pointerAction.js\":\"85b04fb8f829aefd\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/resolve.js\":\"e9516cc6ca660609\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/runAction.js\":\"3c096c28497a9298\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/sequenceMatcher.js\":\"63542628b7ae9c2c\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/types.js\":\"d3ea1454ff94f3df\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/useActionContext.js\":\"6a7debb5bc60247b\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/useActionDiscovery.js\":\"7816b92feb6eebd7\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/utils.js\":\"b83eabd04baf2a7e\",\"/knowledge-medium/pr-preview/pr-1796/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1796/src/sw/bootStore.js\":\"aa32899f7af51ae4\",\"/knowledge-medium/pr-preview/pr-1796/src/sw/previewDatabases.js\":\"9f7a1047801dc741\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/byteTransform.js\":\"fe50dd68705085d6\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/attachmentCleaner.js\":\"988f61a3a94890f3\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/attachmentParts.js\":\"f29aec198cd92373\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/bundleParts.js\":\"5640a8aecd626c80\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/bundleRecord.js\":\"9378020530409137\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/manifest.js\":\"48e3f0a64d5823a4\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/takeBundle.js\":\"0010e26d9ac5754f\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/verifyBundle.js\":\"f47387864de43b46\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/cleaningStage.js\":\"0a66dda24da4b36d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/conversionKey.js\":\"1da35089a7ef65a2\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/conversionServer.js\":\"0b30ca46f917ad74\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/flip.js\":\"174a120c54efc7f5\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/flipAttempts.js\":\"75b3bf673aa233ce\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/pages.js\":\"3be39055803a5308\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/preflight.js\":\"12a71760d25f995f\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/reseal.js\":\"e3e37a69fe29e1b1\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/runConversion.js\":\"e8d12529964a1504\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/runLock.js\":\"d52771abbb31d65c\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/sealing.js\":\"a531ea7fd6aaf389\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/sealingStage.js\":\"09828a8aaba66f87\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/stage.js\":\"3d890c98d28f5819\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/verifyReseal.js\":\"381027c5c35d9657\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/aad.js\":\"8955c53e594034e0\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/aead.js\":\"891fd154fed0d41a\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/base32.js\":\"4a154d79f3da1758\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/base64url.js\":\"368ebfb28f72e47d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/binaryEnvelope.js\":\"50ac18538bc6108e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/byteAead.js\":\"dc32d0127733eb6f\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/canary.js\":\"98300e87870c6ca5\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/contentHash.js\":\"0b3577f25899b952\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/contentKey.js\":\"ddeb270fb5ddc64e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/derivedIdNamespace.js\":\"8edfab929063467b\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/envelope.js\":\"f82739fa79966a4a\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/hex.js\":\"118c4de320bfaf4e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/sha256Hex.js\":\"27cc5bd35e7842b3\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/workspaceKey.js\":\"6d6dae2a69b07527\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/conversionState.js\":\"5b95851ffdac0d44\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0d02497725733e8d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/pastedKey.js\":\"bcd25e1c54876b58\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8b14a16e5ed75c6c\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7bdbc531c0dea1b4\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/keyStore.js\":\"82573a4d6f7abf34\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/mintWorkspaceKey.js\":\"ca60e69af4f1df8f\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/modePin.js\":\"1ed604a3858d507c\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/openWorkspaceKeys.js\":\"6c0a3ff6ab8c6d5b\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/resolveWorkspaceEntry.js\":\"d45cdf73fda42a5e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/resolver.js\":\"2a14ff7c4b53a062\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/workspaceAccess.js\":\"04dc67d3b0f429f7\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/transform.js\":\"426ce3d524c83655\",\"/knowledge-medium/pr-preview/pr-1796/src/themeBootDefaults.js\":\"e69f7e30cd457e64\",\"/knowledge-medium/pr-preview/pr-1796/src/types.js\":\"52a51694743dddeb\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/ClientLocalSettings.js\":\"75937fcd2c94b2d0\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/abortableSleep.js\":\"5f86fcfbb4093928\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/array.js\":\"42bf98a489cca8ca\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/backlinkAutocomplete.js\":\"f179e945c1e8fa9d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/blockCrumbs.js\":\"da3643d03d5f0bf5\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/blockrefAutocomplete.js\":\"21a9d979c2c7c111\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/cadencedIdleJob.js\":\"e64df29f7d963d92\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/callbackSet.js\":\"70a549cfc64a028d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/clientId.js\":\"36b1a83209a3efa5\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/codemirror.js\":\"47f1b473ddacee23\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/codemirrorCompletion.js\":\"da533c88c5a9f2bb\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/copy.js\":\"8639289c99d9e05d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dailyPage.js\":\"0ab95774f9bc3a40\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dbForensics.js\":\"b86ef217ac8da18d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dbForensicsHooks.js\":\"a9c9d298355e6b40\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/deleteBlockThroughUi.js\":\"5c9f1802b3a810b6\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dialogs.js\":\"dfdbdd1285c91de9\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dom.js\":\"6b92a1111222c106\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/downloadBlob.js\":\"200ea5aaff379e09\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/exportSqliteDb.js\":\"fe753f904e69c0e6\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/fileSystemAccess.js\":\"5196d0236ee5906f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/flipSlide.js\":\"6ef2ba3092912e9a\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/fnv1a.js\":\"ccfcbebe1dbc382c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/formatBytes.js\":\"0f7e1ba857789a04\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/fuzzyRank.js\":\"9e84d0d79e7b9e37\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/idbKeyedStore.js\":\"a9f3b68305e86b80\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/idleCallbackPolyfill.js\":\"8a9ef092d67feec2\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/keyboardAwareScroll.js\":\"2930d5810564fa5c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/keyboardViewport.js\":\"24d42b69fbb20e1f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/lastWorkspace.js\":\"2c9d5e6e1e68cd48\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/layoutColumns.js\":\"e8c06046e805227c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/layoutSessionDom.js\":\"e8a98f8bc665b7c8\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/layoutSessionId.js\":\"3a0c1a963fce156f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/linkClickGestures.js\":\"996ec11cd8e06fdd\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/linkTargetAutocomplete.js\":\"0065a66078373fe9\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/localDbCorruption.js\":\"e0b50f002a553f71\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/localDbRecovery.js\":\"8c3dc63c7224b9d4\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/markdownParser.js\":\"558d239dcf25debe\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/memoize.js\":\"be48fd205c72f65e\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/nameFieldCommit.js\":\"48a57b8acbbbe910\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/nameList.js\":\"ffd304fdfa8d530f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/navigation.js\":\"bf1bd3a77effafda\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/omnilinerNamespace.js\":\"d4b007441304917e\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/opfsPageScan.js\":\"64da82d694caf60a\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelClearance.js\":\"5b0c731865997a15\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelHistory.js\":\"c53486f2976f390c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelLanes.js\":\"d8558d2ae27c1ebf\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelLayoutProjection.js\":\"22aeffe010e069b3\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelScrollAnchor.js\":\"7079bc8ea5dcbe3d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelUrlFlags.js\":\"92a2ea1e917e788d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/platform.js\":\"e81237804acd63f1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/pluralize.js\":\"caae7c5383a0059c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/propertyCreation.js\":\"60ba6013be4dc9a5\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/propertyNavigation.js\":\"f2a20eb2110a7c2b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/propertyValueContext.js\":\"6b1f3ebb87b1b56a\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/react.js\":\"865cfb72d3aa46a8\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/relativeDate.js\":\"c5dd4b73666737f8\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/relativeTime.js\":\"54b976c887d25e06\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/renderScope.js\":\"7fc25ee435ca4d4e\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/resolvedThenable.js\":\"ea90d33c7a1429eb\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/routing.js\":\"c2239025aeddc612\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/safeMode.js\":\"fdcd4acce63bfa7f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/scheduleIdle.js\":\"a842ae5a5524329b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/screenWakeLock.js\":\"466f93233b5c6782\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/selection.js\":\"d3524e5ee5b70785\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/softKeyboardGrab.js\":\"8f4f10a4852521ef\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/startupTimeline.js\":\"0361c1629763413f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/state.js\":\"3b8a605cea21ab41\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/string.js\":\"c12ce9e5ff644f2f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/surfaceZoom.js\":\"76fce6e002192292\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/time.js\":\"c53f59cb52331876\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/toast.js\":\"0903837af3de227f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/toggleStore.js\":\"16df2a6fcf0d3d0b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/untilStopped.js\":\"f2bec3295fecf790\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/userActivity.js\":\"5bd1afba1d031a60\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/viewTransition.js\":\"939a570561fdcb6c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/viewport.js\":\"1148f29a759bf39a\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/webLock.js\":\"721f7127ec2cd8de\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/workspaceRecovery.js\":\"c95afde40b46e6c4\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/workspaceSnapshotStore.js\":\"66dce20c91e123b0\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-compiler-runtime.js\":\"f4ed967f5c7bb8be\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-client.js\":\"b12e2c069e712699\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-server-edge.js\":\"e18e11880646c2e4\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-server.js\":\"15bb9331725ada1d\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-static-edge.js\":\"2bf7c0f331460690\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-static.js\":\"258a11a0d41afdb0\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-test-utils.js\":\"601f43898ad7cc99\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom.js\":\"ab66c0250b0e0dae\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-jsx-runtime.js\":\"34962e10f88b868b\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react.js\":\"68f5ded795134590\",\"/knowledge-medium/pr-preview/pr-1796/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1796/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1796/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
