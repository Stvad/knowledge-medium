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
		buildId: "c3b98ebc14c4-b3ef358c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1796/\":\"259cd478c981b3ae\",\"/knowledge-medium/pr-preview/pr-1796/index.html\":\"259cd478c981b3ae\",\"/knowledge-medium/pr-preview/pr-1796/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1796/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1796/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1796/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1796/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1796/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1796/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1796/assets/FacadeVFS-Bg2FjIHK.js\":\"915170b3f5a53769\",\"/knowledge-medium/pr-preview/pr-1796/assets/OPFSCoopSyncVFS-BdqHteMH.js\":\"214b119b573f56fb\",\"/knowledge-medium/pr-preview/pr-1796/assets/OPFSWriteAheadVFS-YHaKRdwV.js\":\"f70c02cd5803e917\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-D0l2cExm.js\":\"bff665d046f2d80e\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1796/assets/wa-sqlite-async-CZvhuXP-.js\":\"aacb7f42466c9511\",\"/knowledge-medium/pr-preview/pr-1796/assets/worker-CHDtBV_a.js\":\"49605181d1ad97ee\",\"/knowledge-medium/pr-preview/pr-1796/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1796/chunks/app-CLTWxLmb.js\":\"743cabc4fbe4967c\",\"/knowledge-medium/pr-preview/pr-1796/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1796/index.js\":\"9b74fcae13e580af\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1796/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1796/assets/AccessHandlePoolVFS-BQYNTLKy.js\":\"af66cb9b635cd9bb\",\"/knowledge-medium/pr-preview/pr-1796/assets/IDBBatchAtomicVFS-CnBLjUfs.js\":\"432428d1c4fb72d9\",\"/knowledge-medium/pr-preview/pr-1796/assets/MemoryVFS-GpMDpTCY.js\":\"e730f55b7bc310d9\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-Ck59MAFX.js\":\"60f13589f20660bb\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-async-Cm1NVLAW.js\":\"e9ea827c6a129a28\",\"/knowledge-medium/pr-preview/pr-1796/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1796/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1796/chunks/AccessHandlePoolVFS-B9_kw26j.js\":\"e6f535da3fde694c\",\"/knowledge-medium/pr-preview/pr-1796/chunks/FacadeVFS-ySlcMsZb.js\":\"0456790334518a43\",\"/knowledge-medium/pr-preview/pr-1796/chunks/IDBBatchAtomicVFS-CGyqYKrm.js\":\"719e6fa66a0a5208\",\"/knowledge-medium/pr-preview/pr-1796/chunks/MemoryVFS-B0yz_zPI.js\":\"4b81005545db98fd\",\"/knowledge-medium/pr-preview/pr-1796/chunks/OPFSCoopSyncVFS-Bo_9WPXJ.js\":\"6de1c508bb6e62d4\",\"/knowledge-medium/pr-preview/pr-1796/chunks/OPFSWriteAheadVFS-Dd69V6fs.js\":\"066bd0f50de21056\",\"/knowledge-medium/pr-preview/pr-1796/chunks/Preview-UTwTDDn3.js\":\"e38aeb25f8dbce6a\",\"/knowledge-medium/pr-preview/pr-1796/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1796/chunks/card-TOJqDQfq.js\":\"6d4d583d3b15bc6b\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1796/chunks/dist-DnQFRrs_.js\":\"afe82142d5d148ec\",\"/knowledge-medium/pr-preview/pr-1796/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1796/chunks/mc-wa-sqlite-ABH2eFtd.js\":\"5dc639befa9bf6d4\",\"/knowledge-medium/pr-preview/pr-1796/chunks/mc-wa-sqlite-async-q0sK5iFj.js\":\"bfc75746c8859110\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-CAzit3sr.js\":\"cc224b29af2d5df7\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-Csx4Bu4o.js\":\"ca8e384962a49ad5\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-DMKQclO2.js\":\"fdf69a722380ec8b\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-DRMYsAZh.js\":\"dbb0223b1cc90223\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-DrRgPF5L.js\":\"501fa115cf489be0\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-__cJcy5C.js\":\"f7a82aaba16d280e\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-dom-server-legacy.browser.production-BcwcZUd-.js\":\"134ab8e91acbdaac\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-dom-server.browser.production-cdxzQiqC.js\":\"af2f50d8d767c95d\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-dom-server.edge.production-B0rjBUCT.js\":\"b23bd9cc7efcdf81\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-nqwG2N--.js\":\"847a42ecfdd0ba86\",\"/knowledge-medium/pr-preview/pr-1796/chunks/react-tYV2sMfL.js\":\"b688b0efd5b07a77\",\"/knowledge-medium/pr-preview/pr-1796/chunks/server.browser-5jB69ozO.js\":\"4973c820c0a3a18a\",\"/knowledge-medium/pr-preview/pr-1796/chunks/textarea-B1clUsXx.js\":\"e9e4279153a4bd5e\",\"/knowledge-medium/pr-preview/pr-1796/chunks/ui-DCBE5_JU.js\":\"0916bdd0b2ee39e1\",\"/knowledge-medium/pr-preview/pr-1796/chunks/wa-sqlite-BhUpI_is.js\":\"c20922946b30caa5\",\"/knowledge-medium/pr-preview/pr-1796/chunks/wa-sqlite-async-BZzoaobk.js\":\"7bbb69e3fbefdb84\",\"/knowledge-medium/pr-preview/pr-1796/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1796/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1796/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1796/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1796/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1796/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1796/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1796/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1796/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1796/src/App.js\":\"5e993d3ad6809174\",\"/knowledge-medium/pr-preview/pr-1796/src/appUpdate.js\":\"4e07327f0737f7c1\",\"/knowledge-medium/pr-preview/pr-1796/src/appVersion.js\":\"72ce6aff49b874ee\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/initialLayout.js\":\"efc03608e8f9cf38\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/openWorkspaceData.js\":\"65afeb3f2f79cb85\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/resolveWorkspace.js\":\"72458544907a8217\",\"/knowledge-medium/pr-preview/pr-1796/src/bootstrap/workspaceBootstrap.js\":\"153aed0c65315728\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockComponent.js\":\"dfab2886044be61f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockCrumbs.js\":\"07909c0a812e49f2\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockEditor.js\":\"e8c98bf048f6d6d0\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockLoadingPlaceholder.js\":\"d7dd5e5f12b6f5b0\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockProperties.js\":\"fe8ce075188eb834\",\"/knowledge-medium/pr-preview/pr-1796/src/components/BlockSearchPicker.js\":\"d75a8a10a32bc078\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ConfirmBulkDeleteDialog.js\":\"2127563c33ba7535\",\"/knowledge-medium/pr-preview/pr-1796/src/components/DividerHandle.js\":\"a68688f403a046e5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/DraftEditor.js\":\"4ee442bc4dd3f4be\",\"/knowledge-medium/pr-preview/pr-1796/src/components/GutterPill.js\":\"e652cdb3b6e72879\",\"/knowledge-medium/pr-preview/pr-1796/src/components/Header.js\":\"0967b9ee89b8ac0f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/LazyBlockComponent.js\":\"0f20d1c759fb626f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/Login.js\":\"090396e104c5f4b1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ZoomableSurface.js\":\"c56eb7acd6bcfd47\",\"/knowledge-medium/pr-preview/pr-1796/src/components/editModeKeepalive.js\":\"67f465a4268609af\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4edf05edb9ae73b4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f145323816243d22\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/RefPropertyEditor.js\":\"68e403aed5829c86\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/RefTargetTypePicker.js\":\"bbbadb9aec3e6773\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/SelectPropertyEditor.js\":\"f6eff3db2afc14e5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/TypesPropertyEditor.js\":\"0999f5360f598b2a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/defaults.js\":\"6ba03d574895cffa\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/kernelValuePresets.js\":\"89b7f86f917b16ae\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/selectablePresets.js\":\"218030af77351ce2\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyEditors/typesPropertyUi.js\":\"af375a607a12d98d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/AddPropertyForm.js\":\"44507e4fc4c9cc85\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/PropertyPicker.js\":\"538eae5a25e6e54f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/PropertyRow.js\":\"0159728f26189bba\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/Rows.js\":\"15a487c0d3806f86\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/actions.js\":\"537ef3f1020eb2d1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/declarationOnly.js\":\"7ff20a7ea756e013\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/layout.js\":\"c35042bbabe2ae03\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/model.js\":\"73430f6f623d2165\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/shapeUi.js\":\"acd18c84fe7b70fc\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/shapes.js\":\"ab7495a8a5c2536c\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a72e27dbce0dd400\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanel/visibility.js\":\"d4b7549a42447e29\",\"/knowledge-medium/pr-preview/pr-1796/src/components/propertyPanelSections.js\":\"2ee747b6269eb460\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/BlockEmbed.js\":\"d6286b862844ea58\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/BlockLink.js\":\"9ec007eab901ca8c\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/BlockRef.js\":\"e11bff6a57a794a2\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/ReferenceLink.js\":\"70116989310a5659\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/cycleGuard.js\":\"18a240f0c4776d35\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/cycleGuardContext.js\":\"2fc0143595ca9fad\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/linkInteraction.js\":\"d8087746727f5527\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/referenceLayout.js\":\"8359d830ebae73d1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/references/useBlockRefAncestors.js\":\"019ed9ce10105b5a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BlockGutter.js\":\"cf6fd35094f4ba90\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BlockInfoDialog.js\":\"8345a056943e69ed\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BlockTypeBlockRenderer.js\":\"4f1c94c50678c85b\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/BulletHoverCard.js\":\"b5a8b96f2f3ff9db\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/CodeMirrorContentRenderer.js\":\"5d786776d22568ad\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a1ec68aaea6a677e\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/ColumnResizeHandles.js\":\"fb8a76e47cfcb6c1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3372d936fd90cf91\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/DefaultBlockRenderer.js\":\"3cc204fa236f7422\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/LayoutRenderer.js\":\"014c116c2b368b4b\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/MarkdownContentRenderer.js\":\"220d934781daa95a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/MissingDataRenderer.js\":\"e3b14d0bcbf1762a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/PanelRenderer.js\":\"b805700ab79a75b5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8f6179e4d361d61c\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/TopLevelRenderer.js\":\"197cc4a5bf040991\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/blockGutterMode.js\":\"f8b01aae5f62aeb1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/blockTitleText.js\":\"3a553d7d922f0ef7\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/fieldCreationKeydown.js\":\"95b4dc42c2dda04d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/renderer/layoutRootContext.js\":\"10cc811246a0f301\",\"/knowledge-medium/pr-preview/pr-1796/src/components/typeChip/TypeChip.js\":\"234e22d43b49da22\",\"/knowledge-medium/pr-preview/pr-1796/src/components/typeChip/chipStyle.js\":\"d24430fb316f0e86\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/anchored-floating.js\":\"16bac6909b16c1e2\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/button.js\":\"8ca11da38510d0d1\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/card.js\":\"fba08e53fc59c7e4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/checkbox.js\":\"1180d0f3de75e46f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/collapsible.js\":\"5d9f268d9e728ea4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/command.js\":\"de6d10ca67c879ce\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/context-menu.js\":\"1ace8d0d651352b4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/dialog.js\":\"33244a8f93c389f7\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/dropdown-menu.js\":\"7afef0de8325bc66\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/floating-listbox.js\":\"27617e0915b8838c\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/index.js\":\"4098cc2c97a07ca4\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/input.js\":\"029e70d64dcc0e28\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/kbd.js\":\"f0a2830125180554\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/label.js\":\"71e95edc6e2fb961\",\"/knowledge-medium/pr-preview/pr-1796/src/components/ui/textarea.js\":\"8cdda0aeed9547a3\",\"/knowledge-medium/pr-preview/pr-1796/src/components/useEditModeYieldKeepalive.js\":\"1dbab48f169a8a29\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/BootFallback.js\":\"5d5a064e29bcc61a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/FocusedRowLazyMount.js\":\"3f12edef99b10f84\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/LazyViewportMount.js\":\"56e65d3020de5b64\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/LocalDbCorruptionFallback.js\":\"56b2bdd33a1ea2b6\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/error.js\":\"9351cf18a5e020ec\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/lazyMountRegistry.js\":\"bb94b26e7fa25fcf\",\"/knowledge-medium/pr-preview/pr-1796/src/components/util/suspense.js\":\"db0b4df73fc2cf77\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/CreateWorkspaceDialog.js\":\"d150a6fc434a39ee\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/PendingInvitations.js\":\"f118f6b8f24b2c78\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/SyncProgress.js\":\"e71c955efae5a67f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/UnlockProgress.js\":\"68768891d2122a31\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceKeyGate.js\":\"7444cb29502e4b5d\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceSettingsDialog.js\":\"da8cec2d4ac93066\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceSwitcher.js\":\"77a17d516a8fd212\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/WorkspaceSyncGate.js\":\"da11a6d07400978a\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/ConversionFlow.js\":\"afbdc3d95180cd6f\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/ConversionFlowHost.js\":\"4009b1813b695732\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/EncryptionSection.js\":\"c181ea944c8274f9\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/attachmentPrompts.js\":\"f0fc8b723806bb79\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3af1dab852dfe503\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/conversionFlowDeps.js\":\"898aae635f59b8f5\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/conversionFlowStore.js\":\"2125f2e721b9b806\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/flowUi.js\":\"fd1ec665e1c642d8\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/conversion/useConversionRun.js\":\"da09245a3b1dc391\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/keyUi.js\":\"7edf80c51bf48cc7\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/useCloseOnKeyLoss.js\":\"b7ac3f5630c39c84\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/useCloseOnServerE2ee.js\":\"8423536c97463fba\",\"/knowledge-medium/pr-preview/pr-1796/src/components/workspace/workspaceUnlocked.js\":\"769089fbee66f296\",\"/knowledge-medium/pr-preview/pr-1796/src/context/backgroundSubtree.js\":\"ce4b5de2d25009f3\",\"/knowledge-medium/pr-preview/pr-1796/src/context/block.js\":\"0540173f14363781\",\"/knowledge-medium/pr-preview/pr-1796/src/context/layoutWsContext.js\":\"9d8f2a75b19e4b69\",\"/knowledge-medium/pr-preview/pr-1796/src/context/propertyDisplay.js\":\"b833e360da0c44c9\",\"/knowledge-medium/pr-preview/pr-1796/src/context/repo.js\":\"3b0fd6cc37a1c2e2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/aliasClaim.js\":\"ef5e76289b6cbe02\",\"/knowledge-medium/pr-preview/pr-1796/src/data/aliasSeatNamespace.js\":\"2fe05707b0b5c9c0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/blockData.js\":\"57ee64afd3298ec8\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/blockType.js\":\"31f25f59e648d452\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/changeScope.js\":\"b1846485122e2e0f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/codecs.js\":\"cf984bd9615c04a4\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/derivedData.js\":\"6a463e78dd5cdb5c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/errors.js\":\"6986e7feef6f1662\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/events.js\":\"17f9cdca80a416c9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/handle.js\":\"a21276510e3ec828\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/index.js\":\"293a41efb3e54f4a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/mutator.js\":\"e3ba8efc0f06cc6c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/processor.js\":\"926977a7df922620\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/propertySchema.js\":\"18d8c42e8efc5d61\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/query.js\":\"a3ac1cedc2023040\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/sameTxProcessor.js\":\"dcc780a42fbfc2db\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/schema.js\":\"a21276510e3ec828\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/tx.js\":\"a21276510e3ec828\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/typedBlockQuery.js\":\"80ec659504a15184\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/user.js\":\"1d04fb10a71e4ded\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/valuePresetCore.js\":\"ded40c983ba9dfd5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/api/valuePresets.js\":\"75d989cffc59ce61\",\"/knowledge-medium/pr-preview/pr-1796/src/data/attachmentCleanerIOVerb.js\":\"56145355ec53516e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/block.js\":\"a63512e4eb28674e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockCache.js\":\"fdc28d4d24515e34\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockId.js\":\"89a9e0a3c740b087\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockLiveness.js\":\"414504f3342cc6c1\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockMerge.js\":\"6a2dcb728b1d7ae7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockSchema.js\":\"f75172296e0da7d1\",\"/knowledge-medium/pr-preview/pr-1796/src/data/blockTypes.js\":\"73d7161a960f414b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/clientContext.js\":\"dd3c588a7f2326fe\",\"/knowledge-medium/pr-preview/pr-1796/src/data/dbFileSiblings.js\":\"43af14b19b211aaf\",\"/knowledge-medium/pr-preview/pr-1796/src/data/definitionSeeds.js\":\"9a14cc6b028a1ab2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/derivedIds.js\":\"f511335f9b9e88ea\",\"/knowledge-medium/pr-preview/pr-1796/src/data/drawnSubtree.js\":\"3a67e6c0448e5a0c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/facetBridge.js\":\"13538fe6d969962b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/facets.js\":\"b5862c6565dce82d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/globalState.js\":\"fd7cad10090b50ee\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/aliasClaimRederiveProcessor.js\":\"1f42fd7e04ccb488\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/ancestorBatch.js\":\"7896a4f8afad1508\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/blockTypeTypeifyProcessor.js\":\"ca73545c16982340\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/clientSchema.js\":\"bcd5b0e8f397b5e8\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/commitPipeline.js\":\"4ca5904d1fcb065d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/devAssertions.js\":\"ec0014b815531a19\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/firstSync.js\":\"2e83f7c6739d9c70\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/freshInitialLoad.js\":\"e4f58acb9cbcb3ce\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/graphBackfillClaim.js\":\"e087faa82a029f19\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/handleStore.js\":\"ee83d9603b6051ab\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/idleMarkerJobs.js\":\"b486b1098df88e96\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/initialDownload.js\":\"111a730c9948cd94\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/initializeClientDatabase.js\":\"86efdcc7d008e3c9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/jsonCanonical.js\":\"c4bc75171abf0f7b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/kernelInvalidation.js\":\"393e3ede07d8850d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/kernelProcessors.js\":\"1c31a4df220c1bcb\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/kernelQueries.js\":\"89cd9453377ca85f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/mergeTypeMembershipProcessor.js\":\"db126d7f4e4991e7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/normalizeReferencesProcessor.js\":\"4ee2dd829f0772fd\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/poolInstrumentation.js\":\"f6d034868c3026f3\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/processorRunner.js\":\"cc596d3602f16580\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyCellBackfill.js\":\"7eb92008e1a843c9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyChildMint.js\":\"96f5d59fb712a15c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyChildrenProcessor.js\":\"f4f19de98c6d4d01\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyDefinitionChangeProcessor.js\":\"11c438d4a8bd1849\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyDefinitionSynthesis.js\":\"1a408b77049f2dce\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertyKeyScan.js\":\"fd19d3b17670d537\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/propertySchemaResolution.js\":\"6de3e1968fcd40b2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/raiseProtocol.js\":\"d6bc9a843052346e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/readBatch.js\":\"6b7a60ca8f8c7071\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/refProjection.js\":\"5b3f2d7a26a0095c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/referenceTargetLookups.js\":\"7ca3b99158ccc82f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/referenceTargetProcessor.js\":\"0e646351fa4ece23\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/replayMerge.js\":\"be06b1db9959e6b5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/sqlBinds.js\":\"c59bab4462a6785b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"72c641db2896d749\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/arrivalProcessors.js\":\"37af04b1d44142d9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/invalidate.js\":\"e44af56f7b4b6762\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/materialize.js\":\"a33b2b8964d39f3f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/observer.js\":\"89aecbbc22301195\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/syncObserver/reconcile.js\":\"fba8105e316b39bc\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/timingMetrics.js\":\"dd6ea85ce720eb60\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/treeQueries.js\":\"a03714f4dc1fee4e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/txEngine.js\":\"cd3677e7f8b19297\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/txSnapshots.js\":\"fa5b8b11eec74a85\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/typedBlockQuery.js\":\"1bcf081be27f5db1\",\"/knowledge-medium/pr-preview/pr-1796/src/data/internals/undoManager.js\":\"91fc6d0f15489d67\",\"/knowledge-medium/pr-preview/pr-1796/src/data/invalidation.js\":\"6a942248cc095b00\",\"/knowledge-medium/pr-preview/pr-1796/src/data/kernelDataExtension.js\":\"225632289e49167a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/kernelPage.js\":\"87edac536ccedd55\",\"/knowledge-medium/pr-preview/pr-1796/src/data/kernelValuePresetCores.js\":\"69765dd9bd944b24\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localDbCorruptionSignal.js\":\"34fbbc5ad05758d5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localDbStorage.js\":\"1c42b6ba62ca0a8c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localDbVfs.js\":\"3b959af568ec5d51\",\"/knowledge-medium/pr-preview/pr-1796/src/data/localSchema.js\":\"39cc8cb446f6f1f6\",\"/knowledge-medium/pr-preview/pr-1796/src/data/maintenance.js\":\"1654ff14350b36f0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/mergeProperties.js\":\"591381801fdc82df\",\"/knowledge-medium/pr-preview/pr-1796/src/data/metricsConsoleHook.js\":\"e284f51d4ce282a9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/migrationsPage.js\":\"cfe5723508a6637d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/mutators.js\":\"d9549cde36f64f3a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/orderKey.js\":\"becc6c56b26f56c8\",\"/knowledge-medium/pr-preview/pr-1796/src/data/orderKeyPlacement.js\":\"2833e3b51ed92344\",\"/knowledge-medium/pr-preview/pr-1796/src/data/outlineSurface.js\":\"6e3b7eacfbdd41d2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/pendingEditorContent.js\":\"650503aeedb54c27\",\"/knowledge-medium/pr-preview/pr-1796/src/data/pendingUploadsSql.js\":\"6470419b71bc3dac\",\"/knowledge-medium/pr-preview/pr-1796/src/data/pluginStateExtensions.js\":\"b07b95018529d1db\",\"/knowledge-medium/pr-preview/pr-1796/src/data/powerSyncLogger.js\":\"1a8b343aafc81a8a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/projectorRuntime.js\":\"7d0e3c68792b537f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/properties.js\":\"5b01d10f441a28d7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertiesPage.js\":\"89e9104d79f9c5eb\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyChildren.js\":\"f36c102a30de50c9\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDefinitionFanout.js\":\"34792e2d48139e82\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDefinitionMetadata.js\":\"97b85800ff5c8877\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDefinitionRegistry.js\":\"530d307893fb12c8\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyDisplayMode.js\":\"b22a0f81baaf5973\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertyRowCreation.js\":\"510e3b1c7aab106f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertySchemaCreation.js\":\"69ff732181091a52\",\"/knowledge-medium/pr-preview/pr-1796/src/data/propertySeeds.js\":\"71d649ac3e22fb7a\",\"/knowledge-medium/pr-preview/pr-1796/src/data/recentsPage.js\":\"50df8f4795ff2d9c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/referenceBlock.js\":\"e5effe3a771131c7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/releasePowerSyncConnection.js\":\"ad0c40390171e324\",\"/knowledge-medium/pr-preview/pr-1796/src/data/repo.js\":\"2e2083f2ceb4b0f2\",\"/knowledge-medium/pr-preview/pr-1796/src/data/repoProvider.js\":\"47d7a99046ff1554\",\"/knowledge-medium/pr-preview/pr-1796/src/data/rowProperty.js\":\"5a94eafa7c87e67c\",\"/knowledge-medium/pr-preview/pr-1796/src/data/searchFilter.js\":\"71d92c081fc8fead\",\"/knowledge-medium/pr-preview/pr-1796/src/data/seedIdentityLedger.js\":\"bcbd236d2c721722\",\"/knowledge-medium/pr-preview/pr-1796/src/data/stateBlocks.js\":\"54385d5c0c94c2eb\",\"/knowledge-medium/pr-preview/pr-1796/src/data/structuralEditPolicy.js\":\"024394049132d8e4\",\"/knowledge-medium/pr-preview/pr-1796/src/data/subtreeDelete.js\":\"96ff6d2520dc0fe8\",\"/knowledge-medium/pr-preview/pr-1796/src/data/syncStreamLock.js\":\"50b65cfc296b9a44\",\"/knowledge-medium/pr-preview/pr-1796/src/data/syncedTableSqlRecognizer.js\":\"ca44b7b5ae095576\",\"/knowledge-medium/pr-preview/pr-1796/src/data/syncedTableWriteGuard.js\":\"ba3a1e45923f9c9f\",\"/knowledge-medium/pr-preview/pr-1796/src/data/targets.js\":\"92aa555a616dc226\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeColors.js\":\"12930e739fea886b\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeDefinitionMetadata.js\":\"827f0a25d47cf9bb\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeDefinitionRegistry.js\":\"53d55ee73967b94d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeExtraction.js\":\"82f94f069740c6d7\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeInitialValues.js\":\"7d7e76a4b0eff80e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typePropertyGroups.js\":\"d884479bab1e6f78\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeSeeds.js\":\"16d493aea53cc387\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typeTagger.js\":\"dac2242b56fe8d47\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typedRecords.js\":\"2dbcf1757cf92683\",\"/knowledge-medium/pr-preview/pr-1796/src/data/typesPage.js\":\"e5dc557a873d5c44\",\"/knowledge-medium/pr-preview/pr-1796/src/data/userPrefs.js\":\"d27a9ca0c986dc43\",\"/knowledge-medium/pr-preview/pr-1796/src/data/userSchemasService.js\":\"93dfedde600fa855\",\"/knowledge-medium/pr-preview/pr-1796/src/data/userTypesService.js\":\"5f055989a5421370\",\"/knowledge-medium/pr-preview/pr-1796/src/data/valuePresetRegistry.js\":\"75e7af2d3baf0397\",\"/knowledge-medium/pr-preview/pr-1796/src/data/visibleChildren.js\":\"3083c256023cf0ab\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceConversion.js\":\"979273bfc07be2b1\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceFirstSync.js\":\"0777ebc869211d4e\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceIdNamespace.js\":\"a686386c9bf6b1c5\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaceSchema.js\":\"5071af2b024bfa4d\",\"/knowledge-medium/pr-preview/pr-1796/src/data/workspaces.js\":\"045c7a2104f334d0\",\"/knowledge-medium/pr-preview/pr-1796/src/data/writeAheadLog.js\":\"f8b31562903b4fee\",\"/knowledge-medium/pr-preview/pr-1796/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/BlockPasteShellDecorator.js\":\"18eb77a0f7373d74\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/atTrigger.js\":\"ee2058f1259912ef\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/autocomplete.js\":\"ed72c3fd07a82313\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/codeMirrorExtensions.js\":\"bc08390b5eaeabbb\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/contentFlush.js\":\"8076b3134fe7ac83\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/defaultInteractions.js\":\"8b1012beec95a90a\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/editSettleSignal.js\":\"b0de23f1a5df8f25\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/insertImage.js\":\"388f88f9cf27124c\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/referenceCompletionRange.js\":\"c52ddacd8aff8588\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/referenceTargetTypes.js\":\"bf06e5e7d7f8ac93\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/syntaxContext.js\":\"d76e410c28d3b2e8\",\"/knowledge-medium/pr-preview/pr-1796/src/editor/triggerMatch.js\":\"35e0760180f131a6\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/AppRuntimeProvider.js\":\"b45f5187a642b270\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/BlockFocusShellDecorator.js\":\"eae6bcec9c12dadd\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/ExtensionRenderBoundary.js\":\"58428718e5b76bb5\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/PanelContentRecovery.js\":\"6f860c6aaceadb87\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/apiCatalog.js\":\"ababda4c16734fa9\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/approveExtensionHere.js\":\"fb2aeacb8132fe4e\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/armedCutAppMount.js\":\"338063dcd4021d47\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/batchableKeyedStore.js\":\"3f7667ba90e75efb\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/blockInteraction.js\":\"be52cc53aceeb967\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/blockSelectionAction.js\":\"fd46163143aad166\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/compileExtensionModule.js\":\"23f07612d6ec6ba3\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/compiledModuleCache.js\":\"dd7ffa4c8359da81\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/continuousGestures.js\":\"6fa92f715d9f4737\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/core.js\":\"731f4ef73580b31b\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/defaultRenderers.js\":\"0d4405d37a986e54\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/definitionFanoutAppMount.js\":\"81bcc92cf8f34c19\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/dialogAppMount.js\":\"bfc66e7b11796fa7\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/dynamicExtensionSeeds.js\":\"04bf6cc5603e107f\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/dynamicExtensions.js\":\"1e0e929cfb44dcad\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/exampleExtensions.js\":\"3bce3ba830072719\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionApprovalStatus.js\":\"78d8cf6e253db94f\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionLoadErrorToast.js\":\"ff99bff7e42460ea\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionLoadErrors.js\":\"b2d2c6a42ef6674e\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionLookup.js\":\"8d9754f94c912745\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionToggles.js\":\"3fe8c193a6435379\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/extensionUtilitiesCss.js\":\"73d081b924ae7fa6\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/kernelPageDeletionGuard.js\":\"268c0f87ae84a8fd\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/liveRuntime.js\":\"9d0f23b25d85f76c\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/openExtensionsSettings.js\":\"b4cf47b79561debf\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/overridesCache.js\":\"0bae01d0bf722f49\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/pluginIds.js\":\"efdc1771f3d44650\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/processorRejectionToast.js\":\"091b7e0acac16af3\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/runtimeActions.js\":\"626dcb28593b52c2\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/runtimeContext.js\":\"c53a089c36bc2770\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/staticAppExtensions.js\":\"f5776403403b3f2a\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/staticDataExtensions.js\":\"9fb836f3be4564c1\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/toastAppMount.js\":\"fb2396ea9f81c57a\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/useOverrides.js\":\"915607791a60c4bb\",\"/knowledge-medium/pr-preview/pr-1796/src/extensions/useShortcutSurfaceActivations.js\":\"3330414cfa9086f0\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/discoverToggleTree.js\":\"d482eeeff7bc4220\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/facet.js\":\"24d0bf393c549f4b\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/resolveAppRuntime.js\":\"aac84e4a9055a2c1\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/runtimeEvents.js\":\"afed6f894fc42a97\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/togglable.js\":\"fdc3704a73b3c75d\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/variantFacet.js\":\"fdcd3a6025866282\",\"/knowledge-medium/pr-preview/pr-1796/src/facets/verbFacet.js\":\"2cea99a5891a65e0\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/block.js\":\"44ddc72a6a850e2b\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/focusedChild.js\":\"3bc950edce5d3d36\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/propertySchemas.js\":\"736f4086821e4885\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/typeRegistry.js\":\"35b6fac46a370679\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useAncestorCrumbs.js\":\"6db31425dbdc9ccf\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useAutocompleteListbox.js\":\"238546496a51ff99\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useDebouncedSearch.js\":\"d1cd1a3029d579a4\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useDebouncedValue.js\":\"cbcb34dba50614bf\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useIsFocalRender.js\":\"433fc97f65005ab2\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useIsReadOnly.js\":\"1a759dd60f512547\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useMaterializeBacklog.js\":\"c51cee45db416d45\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useMinuteClock.js\":\"be113fa544559f74\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/usePanelLayoutProjection.js\":\"65dcf6e3782367ee\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/usePendingInvitations.js\":\"f8166043e91df9f7\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useRendererRegistry.js\":\"27d2855c8d2cf22b\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useRetainedFieldRows.js\":\"6748e916f78d9457\",\"/knowledge-medium/pr-preview/pr-1796/src/hooks/useWorkspaces.js\":\"5f4dcc3a639d7346\",\"/knowledge-medium/pr-preview/pr-1796/src/lib/utils.js\":\"4c879efa720401c2\",\"/knowledge-medium/pr-preview/pr-1796/src/main.js\":\"bca066beb8796927\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/MarkdownImage.js\":\"6d66935fe212066b\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/blockSeparators.js\":\"16f763ef340b86b5\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/context.js\":\"cbcb3394b665308c\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/defaultMarkdownExtension.js\":\"d9d62c962d8241e3\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/extensions.js\":\"4392e3718c15fd12\",\"/knowledge-medium/pr-preview/pr-1796/src/markdown/renderMarkdownHtml.js\":\"dd24d80c7b5e8631\",\"/knowledge-medium/pr-preview/pr-1796/src/minimal-editor.js\":\"d1aa220ce531de48\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/armedCut.js\":\"fc28b82843b500c7\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/captureMediaVerb.js\":\"a527f93188ed9e0d\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/clipboard.js\":\"0a576f5d7f10eb05\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/decision.js\":\"aff4163ff5849858\",\"/knowledge-medium/pr-preview/pr-1796/src/paste/operations.js\":\"38a78ee4a66c1be5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/account-header/AccountHeaderItem.js\":\"75ae3d75da315e4d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/account-header/index.js\":\"0445c75051f8cd0e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"49df46ca6dc047be\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/askAgent.js\":\"c44cddf41dbac700\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/askedStore.js\":\"8de86a9f5f4f21b4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"906ca696df3adc85\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/chipState.js\":\"07b5f4a5c88fd596\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9f416b4706a29acd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/index.js\":\"0f29da746b19afb1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bd551a3b4dca92aa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-dispatch-companion/schema.js\":\"1396f0c5b3fd8549\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f81cfe418c847926\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4d2d4a9325ba402f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/addMedia.js\":\"55c21e96fd18ab2d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/backlinks.js\":\"aa87cd33219bebe9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/block.js\":\"5814486f2dcdac2c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/context.js\":\"3bc77c3d59abf2f4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/displayIds.js\":\"bc46d62073fb975c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/index.js\":\"547268ab29bc0bcc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/outline.js\":\"03346f798ec9b1f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/properties.js\":\"58435af22bbbc19a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/refs.js\":\"0e81d5bb93fde39b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"795e1283af09de9e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/search.js\":\"a10f806be2a643d7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/shared.js\":\"de36026da41dd2c9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ff7d940273564df4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentViews/text.js\":\"c00b717aa35351bc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/agentWrites.js\":\"adeaceb32462eb06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/authoringCatalog.js\":\"7327898ae73eab1a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/blockRefTargets.js\":\"3f6c58ad163a95de\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/bridge.js\":\"104f268461199779\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/bridgeLoop.js\":\"760f429c7f24c1a8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/changeHistory.js\":\"ad6a8780a219c05b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/commands.js\":\"b5fdd1140213493b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/commentsCommands.js\":\"f845bd2a0a63dc1b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/dataExtension.js\":\"5848961443d9f507\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/dataModelGuide.js\":\"695a08fdd8056d28\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/describeRuntime.js\":\"b67ba9074e9e4763\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/extensionLint.js\":\"96f06c14937519a7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/grainAudit.js\":\"8e2f7c1d4dd95c2c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/healthCommand.js\":\"8791d045bbc727ef\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/index.js\":\"23f417a5df2d5457\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/presetIdentity.js\":\"2a358556e79c929c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d4b8cb845a9fe4ff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/readMedia.js\":\"8326a9c248f831c7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/schema.js\":\"26bac7e563e65d27\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/serialization.js\":\"1c1640f3bdbbc047\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/targets.js\":\"077a856800d919a1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/tokens.js\":\"7a31d6414a786418\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/watchEvents.js\":\"6d1ec4b93804509f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/workspaceGuard.js\":\"c157b3b82a5c44d3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/agent-runtime/writeCommands.js\":\"8c5036aee0ee2008\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/AliasCollisionToast.js\":\"46224b17d4332e86\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/DuplicateNameBanner.js\":\"727c7cb7483b2f95\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/collisionMerge.js\":\"19ec70bee1713564\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/dataExtension.js\":\"7bdeca743320cf57\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/index.js\":\"bcfee43fdde5b72c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/mergeCollisionAction.js\":\"305993ed172c9ba5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/pageStyling.js\":\"8110784ffa753e69\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/rejectionToast.js\":\"51f7f418b9319ff2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/alias/syncProcessor.js\":\"b37815449419b1a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/actions.js\":\"6d4e066a8914e873\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/addComment.js\":\"ef29cd972fb15878\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/anchor.js\":\"05aa649001c0efb6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/anchorState.js\":\"aca82f95b54757f6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/commentLinks.js\":\"c5bdb814307c34c3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/confirmThreadDeletion.js\":\"0d39ce06edb37011\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/container.js\":\"933fc5bb7911f94c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/dataExtension.js\":\"d919ec0f4bf48cc9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/deleteComment.js\":\"2f860a2fb4d23157\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/highlights.js\":\"5df0c620a07cd833\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/index.js\":\"dcf96e58769aa3f4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/linkedCommentsPill.js\":\"6ac0389a63723a76\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/margin.js\":\"4120387f676ac432\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/marginSchema.js\":\"2d881f6faa49b9a3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/newComment.js\":\"64f373fe82643e27\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/ownThreadPicker.js\":\"ef2367bccdbd8790\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/placement.js\":\"5c8509ebbc864b76\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/queries.js\":\"b3e118898f30e1dc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/quotePosition.js\":\"c9cac755ed915ece\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/quotedIn.js\":\"1e8febf4bb3a16c2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/quotedRange.js\":\"4782d2a5259262fe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/rangeRefs.js\":\"22e494cceb4bbb2a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/readHighlights.js\":\"b25b06497575668b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/readSelection.js\":\"0c8afbf3bf075219\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/readSelectionUi.js\":\"674498a99c7bf163\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/reanchor.js\":\"fb640ba90bec9d8a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/schema.js\":\"c492e6ad8c8be134\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/scope.js\":\"8073210a4116cb71\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/scopeThreads.js\":\"ea8dc7033bd7a245\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/splitRetarget.js\":\"a4ca297ddba55ad6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/suggestionCard.js\":\"1e3d4a59e17728ad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/suggestions.js\":\"7111d647c5251a3d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/summaries.js\":\"f6eaf38d409c5d81\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/summaryBatch.js\":\"b02413074db85667\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/surface.js\":\"a87fc4a5fe3eebbd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/threadNavigation.js\":\"cdf80ef6a510853c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/threads.js\":\"9656a862f593a705\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/ui.js\":\"4b6268c451433a54\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/annotations/uiStore.js\":\"cc673c2c9d45770f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-intents/appIntents.js\":\"40256adf78ddb17c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-intents/index.js\":\"9da168b40701f86c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-update-prompt/index.js\":\"6b16531a59d81025\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/app-update-prompt/status.js\":\"5ec05da9bf5f272c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"889325282159428a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/MediaBlockRenderer.js\":\"24ec3e37da46763f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c70f14b9e7af3851\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/MediaUploadReconciler.js\":\"ff477851ac96f496\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/assetDownLane.js\":\"d3e574cafa7ac55f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/assetResolver.js\":\"79b71bf96f37d87d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/assetUpload.js\":\"3a49f3080dedb7db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/attachmentCleanerIO.js\":\"6531013e3bcbbad4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/supabaseAuditIO.js\":\"52542b9a25a66dce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/blobStore.js\":\"d1f6325cfda0fb1d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/byteStore.js\":\"2e78bd1f6e69da87\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/cleanerIO.js\":\"5774e5de6f08c009\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/cleanupAttachments.js\":\"9bb7750c9dffefbf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/dataExtension.js\":\"641472a3b4bfeae3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/downLane.js\":\"bd312334a5c1d3c2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/index.js\":\"9ff15e2a9b792a1b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/insertImageContribution.js\":\"8a2bc99f35aaa57c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/laneArming.js\":\"a33a8c451740d0d2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/laneLock.js\":\"93087dbae17852b9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaBlock.js\":\"2d913c8854f6f23f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaCapture.js\":\"5bd04bd5c9f67603\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaViewers.js\":\"569e23946e36cae4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/mediaViewersFacet.js\":\"74d19be349e97b33\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/pasteCapture.js\":\"14c6ef3c76e0e336\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/resolver.js\":\"c1adf7ad2b8fa08a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/retryUploadsAction.js\":\"021fbf7268022238\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/storagePaths.js\":\"6f0240b1fb61462e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadDrain.js\":\"07f0f12d8a798971\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadLaneStatus.js\":\"1a91e490c3d11c80\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadReconcile.js\":\"710165fed9a5b67f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadRecovery.js\":\"d5b60e3407e18200\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/uploadStore.js\":\"4d56ff0f97791be0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/attachments/useAssetObjectUrl.js\":\"94c7c7b2100ccce8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"91e6bbc98b1bfdba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/BacklinksViewSection.js\":\"4f380ea7654c2193\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/facet.js\":\"3a3f59eeaa2adf6e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/index.js\":\"b474bf90eeffc604\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks-view/prop.js\":\"ed29bb40d95b67ce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/BacklinkFilters.js\":\"338a82f6ebb57a4c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b4eb92456ca086d9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/BlockEntry.js\":\"76386fec2a5b0b4f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/LinkedReferences.js\":\"4eededb2bdd710e6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c26d9996068b73b2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/dailyNoteDefaults.js\":\"014d1693adc4a1e7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/dataExtension.js\":\"91beaf4bceacb458\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/edgeExclusions.js\":\"4d9d41461c0f7c38\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/filterProperty.js\":\"957b73126a2c1f13\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/index.js\":\"ab369feb8e116598\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9c8c19c44d7cb76c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/applies.js\":\"128749c17f11d340\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/countQuery.js\":\"4c7ac038cd2b5813\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f2ce17a72823cf55\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/index.js\":\"420562867a37e10b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"dff670c89d611746\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/presentationInvalidation.js\":\"a7e0e8c1851f0dc7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/propertyEditorOverride.js\":\"7080266122ef8b67\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/propertyFilter.js\":\"b125745ce6d75aff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/query.js\":\"5ebb2f9c923bc7d9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/resolveFilter.js\":\"90d3a706d1e3fbda\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/sourceBatch.js\":\"1ff079115dc65cef\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/sources.js\":\"15fe7e8281d2e039\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/useBacklinks.js\":\"bb3ae8a852bf3dbc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"49e65e2bb7d142bc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/BirthdayCelebration.js\":\"b461fd773693fe51\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/BirthdayOverlay.js\":\"a6476a23fca96ba9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/gate.js\":\"7921169071313b6c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/index.js\":\"a1040a5af41a52d7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/birthday/wolfTheme.js\":\"7fc8edc022eeb5a9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/BlockDragLayer.js\":\"4e18ea87247bf066\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/dragController.js\":\"f6209865c4842bfe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/dropTarget.js\":\"da1dc25244a550ce\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/index.js\":\"80d6ff0a9facc32f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-drag/projection.js\":\"c1859595824a525d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-info/BlockMetaCard.js\":\"a55ab7143f23a312\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-info/index.js\":\"a1018ccca9d75600\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/AddTagDialog.js\":\"806afe566abd9cd2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4ee42ae7107e7f6c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/TagNameIssueHint.js\":\"5a8daa2ec249f49b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/addTagAction.js\":\"003b2e81449c7171\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/appendTag.js\":\"f65f41e307cd31d7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/config.js\":\"7510ef65cdf9bc3d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/dataExtension.js\":\"a2543159f1be5cb4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/index.js\":\"b835fe5e8577e7f0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/block-tagging/propertyEditorOverride.js\":\"db3e5e94f08fd5cd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c690053d8ab65077\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8a37114632639669\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b53ec149065d9308\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"407fb74c0ea967a3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"09ba6e14a443144e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/index.js\":\"e886384b3771e763\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"371b63da86f70885\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/CharacterCountItem.js\":\"bcfcf3909c1d507c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f61cf579a8a32bcc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/actions.js\":\"5f339d39f4648c25\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/blockType.js\":\"2632462e82003456\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/charCount.js\":\"eafc4cfc9beb8095\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/dataExtension.js\":\"05f94f9ed6ded16a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/index.js\":\"fb922e003a8ca380\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/profiles.js\":\"c4625bbd231c5212\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/properties.js\":\"595327b2a69bd324\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/character-counter/textCounts.js\":\"bd34ae5b80ca1697\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/colemak-keybindings/index.js\":\"86811c86a438b48f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/CommandPalette.js\":\"b7725b4049e0fed5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/HeaderItem.js\":\"7e12fefc043a718a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/context.js\":\"9136656eea479b36\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/index.js\":\"2be25b757713ad3f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/selection.js\":\"080666bbad337fc3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/toggleStore.js\":\"10ffcd3f032432d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/command-palette/useCommandPaletteActions.js\":\"da22cd7cf84ba291\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/ContributorBadges.js\":\"167595711e9012e4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/author.js\":\"b242c2afa3c8ca4b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/codeMirrorExtensions.js\":\"8e85996b4aa78052\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/dataExtension.js\":\"6533fb77fda5b888\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/index.js\":\"c4b78575adc63bac\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/mentionAutocomplete.js\":\"2f1e237f8996175c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/processor.js\":\"b2c2df0885b25c2b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/profiles.js\":\"4494b08351ee32d0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/queries.js\":\"e473332bc3bac5c5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/contributors/schema.js\":\"edef19586caa8e74\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"dfa7629ae3c9edfc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b84d46dfae0f2f41\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/index.js\":\"7782c86a783236cf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5a48a84a54254442\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6ba53e16353ab075\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/CalendarGrid.js\":\"656fcb2a6398ceda\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DailyNotePicker.js\":\"187a9c7e82aa1d68\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fd42101bf28cb104\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DateNavDecorator.js\":\"eef834eaa80a9862\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/DateScrubOverlay.js\":\"6c1f268866151125\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/HeaderItem.js\":\"d55ef71f70dd085c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/ReschedulePicker.js\":\"5bdfce9fdc909256\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/SpreadDatesDialog.js\":\"046dfa7c58b93daa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/actions.js\":\"3c94cb1be776670a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/blockDateAdapter.js\":\"5f7d2024ebda11f8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/calendar.js\":\"588a7378c56bddb9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dailyNotes.js\":\"b21d0d7ccff63849\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dataExtension.js\":\"9488db57fad68104\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubActions.js\":\"592d7710c0deb4c6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubGesture.js\":\"f91768ce6fbbee1e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubGestureActions.js\":\"368ce9c4ba4800a2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1ab563303ebf3f23\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/deletionGuard.js\":\"49689c65c01b0b44\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/dueQuery.js\":\"bef3f7610466136a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/index.js\":\"21c36df9fbcf4f0c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/landing.js\":\"f0021ce6d83a16aa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/localSchema.js\":\"988d049b16af63de\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/referenceDateAdapter.js\":\"4b7e1c445b7bc48c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/rescheduleAction.js\":\"c837612fa79dba5a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/schema.js\":\"d04e064bd8e6d243\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/spreadBlockDates.js\":\"6662e5aab1812912\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/spreadDatesAction.js\":\"76c9135fde939f54\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/today.js\":\"154238adff72962a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"afa432c5737fb1e3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dda9482626a81e05\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/audit.js\":\"db5f57b1b03d205f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/auditAction.js\":\"4e8acad4b5ce45b6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/auditRanges.js\":\"5498593a61009beb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/diagnosticsSource.js\":\"982afba33a35049e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/divergenceScan.js\":\"6e10960165f505ba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/index.js\":\"fc96adbfc536b778\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6ba3fd5c0d1142bc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/referencesMirror.js\":\"dd6e03251aa1c413\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/rowJson.js\":\"5439feba094c7608\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/schedule.js\":\"e8251aba595f8298\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/data-integrity/store.js\":\"510d4a8deff74697\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-maintenance/action.js\":\"384de1952a117411\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-maintenance/index.js\":\"7d6c956759e22029\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-maintenance/plugin.js\":\"aede09b8eeaef92d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"99d0d93c60c896ef\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/actions.js\":\"e4d250ffb2bc4623\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/changeMarker.js\":\"f8c7411496c4c73a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/diagnostics.js\":\"f5234e7a60edb155\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/fileSystemAccess.js\":\"16a79d8f866b89e5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/filenames.js\":\"a8e8f40e8c169d48\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/index.js\":\"c30d6876e85311f5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/mirror.js\":\"a562edca280308f9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/runLock.js\":\"a304cda386726422\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/runtimeHealth.js\":\"c8535d0d64f8f114\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/schedule.js\":\"c584320e45872016\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/db-mirror/store.js\":\"4c4d72a8064f14db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/default-themes/index.js\":\"94b1729d259e562d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/default-themes/themes.js\":\"45577609ae6bc06d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/diagnostics/facet.js\":\"8aa08b5b329cb534\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/diagnostics/useDiagnostics.js\":\"03588908ef857c4e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/dismissals.js\":\"87591d08ad5a5b83\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/index.js\":\"9f071ef09ce23236\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/status.js\":\"1a0945d5ebebbc59\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extension-prompts/store.js\":\"e32c06056343eb66\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"17fb18c5f369fb74\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/ExtensionsSettings.js\":\"98211c826730660a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/actions.js\":\"9a95952984add170\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/config.js\":\"031c26e312421486\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/dataExtension.js\":\"e1f93eade5cfe092\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/effect.js\":\"b972a2fb089267e8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/index.js\":\"4c8bbdb07ca11048\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/propertyEditorOverride.js\":\"58ac219406928285\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extensions-settings/useToggleTree.js\":\"6b8917cb68ecf7c6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/ExtractTypeDialog.js\":\"8c3ae45124a85f5d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6f3e185ccabdc3d1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/PropertyShapePicker.js\":\"d747b7cbedd1dd35\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/action.js\":\"82c7f122b0331970\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/extract-type/index.js\":\"cdaca76e5167bd3a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/FindReplaceDialog.js\":\"7ba42a2ce470c237\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/HeaderItem.js\":\"70cacdb3fca50b0b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/dataExtension.js\":\"df73471051e2d6ef\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/index.js\":\"5b483a79e64d74c8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/search.js\":\"b386a3c310807b06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/toggleStore.js\":\"1b5f796f64b65b88\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/LocationPropertyEditor.js\":\"18e86255269520e5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/MapView.js\":\"910def293ca0272f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/blockTypes.js\":\"492f0ee20cecaa3f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/codeMirrorExtensions.js\":\"1385bb3c2a30d3b0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/createOrFindPlace.js\":\"b379edc7711aed92\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/currentLocation.js\":\"0970916433b13d16\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/dataExtension.js\":\"20ba235e89dfd256\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/geoContentDecorator.js\":\"007957ba3caaac45\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/googlePlacesClient.js\":\"e76f76e8297efeaf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/index.js\":\"5737e5b06dbffdb3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/locationsPage.js\":\"6d86602a6badcf3b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/mapViewport.js\":\"7075a3f52a2b4eb5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/pickCurrentLocation.js\":\"17a39bca5d800ad9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/placeAutocomplete.js\":\"68b7d2493acc02f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/placeNameCollision.js\":\"d2ef84cb9990f47e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/properties.js\":\"745718d7c1b11e3d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/propertyEditorOverrides.js\":\"2da2a2abd579db88\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/query.js\":\"f3cb69b8e52ec839\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/geo/usePlaceSearch.js\":\"2c6273fc80bfa990\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"28e1f8eb5a7ab78a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"26711452dbd08a9c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"411cf463ed37b624\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/config.js\":\"0eaa9a9ab3d60d61\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/dataExtension.js\":\"2eece258ba95260a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/facet.js\":\"7cba043f5c392a20\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/grouping.js\":\"12fafef70c1795e4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/index.js\":\"5a19a41fe86baa72\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2d2319e525979ca5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/query.js\":\"6d6e72dd7ddafd21\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/resolveConfig.js\":\"f46cfbcc2a5bc181\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"983e2ed353887071\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"958698790c5948b3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/HtmlDocumentContent.js\":\"3ce03abf974716af\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/HtmlFrame.js\":\"6ceb069661d710e5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/actions.js\":\"6ed1cbdf11ecc5e7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/blockType.js\":\"551175faac41874d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/confirmRunScripts.js\":\"78c4cbb3fc9973a4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/dataExtension.js\":\"9f99d6cdd20014ef\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/frameAnnotations.js\":\"664a1b37f1013102\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/frameDocument.js\":\"39560fc5fcf0f601\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/frameTheme.js\":\"3b0996861fea74f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/index.js\":\"dc43c3285f9acbaf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/scriptConsent.js\":\"8e604473fc942dcd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/sourceMap.js\":\"c379e154805fb41d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/html-document/useDocumentScripts.js\":\"2a6f5fd67409cb06\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/index.js\":\"c2642dff12062e41\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/record.js\":\"cb7de69a394606d3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/recordStore.js\":\"10ce041adc4cc496\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/responsiveness.js\":\"39a205d64bea36de\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/schedule.js\":\"c685e428fa5fff75\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/interaction-metrics/sessionContext.js\":\"a91b8c64327af460\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fa63d19bfada06c5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"20ab20b638197de2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/actions.js\":\"e65a4c2a8661fccd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/config.js\":\"7e6b000309db6bd5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/dataExtension.js\":\"b67b82e866d0b2a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/effect.js\":\"6d9c71e60df99411\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/index.js\":\"781b8124d32931a9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/keyCapture.js\":\"12ee3b58ae64afec\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/overrideStore.js\":\"2fcadab6bf3078fe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"63f3dea1dcd17132\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/HeaderItem.js\":\"0a5b42752f75ee39\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/LeftSidebar.js\":\"5271a060a276a461\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/actions.js\":\"a89e4fea328d35d1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/facet.js\":\"61ddc516683383ea\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/index.js\":\"7cae44e412b9380e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/shortcuts.js\":\"9745ff84194dbc2e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/left-sidebar/toggleStore.js\":\"e981d4cfd8b43bba\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/MergePicker.js\":\"30b861855db1f22f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/index.js\":\"40c9ff01572a01f5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/mergeAction.js\":\"a7e518f774655abc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/merge-blocks/strategy.js\":\"b4df38b8f66c9d22\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/Button.js\":\"48a2c7b844081666\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"fc047accdbf39687\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/defaultItems.js\":\"81ef8eb6aaa99361\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/facet.js\":\"bf8dbfb6aba0335e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-bottom-nav/index.js\":\"7fe8feac0d0d5b8e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c826136109460c62\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4468f3ee8531b715\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b7d4569382c4762a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6d2c851d7ff48d13\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/mobile-keyboard-toolbar/index.js\":\"96542c8a6f2d7fad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/MoveDestinationPicker.js\":\"38aca81b7aae93a0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/blockSubtreeMembership.js\":\"adac68e397c7ec2f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/contextMenuItem.js\":\"9e5c6a05365de8e3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/index.js\":\"43f6ccadb786da95\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/moveAction.js\":\"7c40f69acae751ca\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/moveBlocks.js\":\"d4a2ec3cf6033166\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/move-blocks/selectionAfterMove.js\":\"b22ba6fbc4695a49\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/TutorialBanner.js\":\"5cfa2a323d8f366e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/action.js\":\"e1cb94e130040f69\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/bannerDismissal.js\":\"49a5a9e21a8966ac\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/documents/cheatSheet.js\":\"3deb534c5dc9fc3d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/index.js\":\"0a332aadabd6e2b5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/keys.js\":\"aa15b8c04baa0880\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/landing.js\":\"2908c8935848dfa8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/outline.js\":\"7ca0546aa2089c91\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/onboarding/seed.js\":\"db1b0473e6a587d2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/PerfTrendDialog.js\":\"556ff08083427e11\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/analyze.js\":\"6ad72640aea3b2b5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/diagnosticsSource.js\":\"b3179245a9277ef8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/index.js\":\"5dc21dd40266a68f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/load.js\":\"f0a11992296f121f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/monitorRun.js\":\"6686ebe2722ac4b4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/schedule.js\":\"a63953c370c313db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/series.js\":\"b5f6187af21d3731\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/store.js\":\"404a595616b58728\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/trendAction.js\":\"79fa7cc54d6a58f3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/perf-monitor/verdict.js\":\"02eb71ecaa1d8e81\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/plain-outliner/clickToEditAction.js\":\"ccfe1e0b2c027427\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/plain-outliner/index.js\":\"85a3204bf2b7a9d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/plain-outliner/interactions.js\":\"71dc11fd92a6b45d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"78c4d166057bd679\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/MigrationGate.js\":\"d183a950a1b9c177\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/MigrationGateDialog.js\":\"8d17ecb66c128b0a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/action.js\":\"6a96592cc892df0e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/index.js\":\"9e10aedbbef824a4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/localRunMessage.js\":\"bf0d79ce8669c57e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/plugin.js\":\"97c7dd5a3e5887a7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/progressReport.js\":\"cd1bd84cdc9ae3c8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/properties-migration/sweepProgress.js\":\"afc811681d36707a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/FieldRowRenderer.js\":\"9f95fe0fe6ff0126\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/ValueRowRenderer.js\":\"1658f4a01526631a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/actions.js\":\"c7d1b0bab33908b3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/autocomplete.js\":\"cc31fe830576cd0e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/fieldRow.js\":\"dbba0ee06b5db76a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/index.js\":\"f13a1412a5ad1ee9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/referenceWarning.js\":\"38ae17ade6a1f7ad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/valueAutocomplete.js\":\"0211fd0bb27fe4c8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/property-rows/valueSchema.js\":\"360746836bdefcb8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/HeaderItem.js\":\"ccf9681500e288af\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/QuickFind.js\":\"1aba3326835b93be\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/index.js\":\"e98ddf7fc4b0bf1a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/recents.js\":\"1dabaa30620a03f4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/resultItems.js\":\"dfb39cf6499390ff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/selection.js\":\"0bb246ef5f0ba7db\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/quick-find/toggleStore.js\":\"460f808a93698d7b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/HeaderItem.js\":\"a927b14f14f96f63\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4b8d0e73188d1a44\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/grouping.js\":\"edb5a8d29ebf69e4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/index.js\":\"3a19ebaacc1d9ace\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/recents/target.js\":\"f5f24899b34826f5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/codeMirrorExtensions.js\":\"99eadcf7487748b4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/contentPrefill.js\":\"aa921e84f41badfe\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/dataExtension.js\":\"5fec67db3595c093\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/index.js\":\"4623f67424d26ea2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"63df9b98d17e3566\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/invalidation.js\":\"29af61e4c92c8010\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/localSchema.js\":\"ecb88edcf028e530\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/blockrefs/index.js\":\"dc917f4be868ab29\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a69e4c5ab78e0d42\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/index.js\":\"f27ff5ce3de234cf\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/referenceNode.js\":\"159ca16879986628\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/remark-reference-occurrences.js\":\"21889c522e919e07\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4bb636c15a26213f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/index.js\":\"1baf97f28100590b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"56d92e6ac8e57fd9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b56aa2c9aa2ca669\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/mergeRetargetProcessor.js\":\"0a0b2f446c3404ad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/parseFence.js\":\"e9bcf5ad7131b3ad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/referenceParser.js\":\"4f95b605350b06b0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/referenceProjection.js\":\"e94a75744c73b485\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/referencesProcessor.js\":\"391e4327e8876b5c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/renameProcessor.js\":\"8073fbd05bf9f237\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/references/spanReplacement.js\":\"be6856f385b4e6e1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/htmlToOutline.js\":\"406bb1e248565815\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/index.js\":\"53a3991b14837b21\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/normalizeClipboardDom.js\":\"350c38769bd5a7d1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/rich-paste/pasteDecision.js\":\"e43dd9b1512cd79c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/action.js\":\"9d2a620784500ec3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/blockIds.js\":\"ef5d9d71c3e48ebd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/content.js\":\"ee1cfb1ee2b87418\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/effect.js\":\"339c950223800e1e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/ids.js\":\"ffddf2a1f037d93e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/import.js\":\"6fe0a54d4b3aa131\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/index.js\":\"c77fe478214c8280\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/plan.js\":\"edd41a80af792ae3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/plugin.js\":\"ae28dedb5fa0c123\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/promotion.js\":\"c0056b2d7fd79836\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/properties.js\":\"c83ac7a28b402563\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/references.js\":\"7b896eaaff0fed27\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/report.js\":\"f0d7974ebe2045bd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/roamMemo.js\":\"6c94118b041e1177\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/runtime.js\":\"3b725f03023fb27d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/schemaReconciliation.js\":\"4c6cf57ac685072c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/srsMarkers.js\":\"37986c09b17b5502\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/todo.js\":\"e804e8ce4e79820f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/typeCandidates.js\":\"adcfdec93b5312a3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/roam-import/types.js\":\"c2b261f272007bcc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/search-health/index.js\":\"1499830590afc4b4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/search-health/store.js\":\"762b6e45b1c4061e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/HeaderItem.js\":\"cf2dd8d50e0809ed\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"43f87b9b9f7c4bb2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/index.js\":\"2fdbd8bf8f6ae164\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/model.js\":\"fa1caa1acaa5589e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/toggleStore.js\":\"9337a8958c337a3b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/shortcut-help/useKeyInspector.js\":\"2c0e0ef0a95b21f7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"2277527c1964e1f2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/ShellDecorator.js\":\"ed52b302b0380947\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/actions.js\":\"bd9358c9dcf7f737\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e3d9b08c7700995c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/index.js\":\"47786ddee2260549\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/shell.js\":\"80cee5c7dc002522\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/surface.js\":\"e79ce629eef8902d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/spatial-navigation/walker.js\":\"040455bc9de662cc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7563fe7da4711824\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/dataExtension.js\":\"f26a4188464964ad\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/index.js\":\"cea626b4f7fa3122\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/indicator.js\":\"cf9c2864f235a37a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/moveSrsState.js\":\"3527f64a52f9de57\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"183ab265da1bc9ac\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/scheduler.js\":\"a51ae43193247a37\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/schema.js\":\"08a548adcb72f822\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8ca2f9d6bb0646d9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/srsClipboard.js\":\"9ddae4a672ea4a2f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c355543f56eb00d0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/DailyNoteReviewHint.js\":\"96fce1b6505bf4eb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/DeckPicker.js\":\"58b321ef44897c7d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/ReviewControls.js\":\"e0a5b7ff959537f4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ac87529934a9d88b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/ReviewSession.js\":\"c8a3bb311bb4c5ed\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/actions.js\":\"aa5b887148f3e4e1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/archive.js\":\"16c0c1bcf5031629\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/dataExtension.js\":\"42a2c19ac439b939\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/deck.js\":\"1e17bf02882b9ffd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/dueQuery.js\":\"01cd4b1c8ec46734\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/gradeDecision.js\":\"d87950ce12a7fac2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/index.js\":\"2eea2d48b05783d6\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/keyHints.js\":\"9b65304c87efd1e2\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/reviewCardLayout.js\":\"f02440c0557f3bed\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/reviewProgress.js\":\"01ecd6971f069b0b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/schema.js\":\"0fa35728dc8e640e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/srs-review/useDueCards.js\":\"64d0a1d2c53ed013\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/startup-metrics/index.js\":\"ae1974f25248f0f1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/startup-metrics/record.js\":\"dde0dafe00af74d4\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/storage-persistence/index.js\":\"a890c903dd52d77e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/storage-persistence/persistenceStatus.js\":\"57909936c3d8fb60\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/storage-persistence/requestAction.js\":\"ce21a3bd4c82a9d5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/TypeChipsDecorator.js\":\"3b3d66d3aca321dc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/codeMirrorExtensions.js\":\"2d6820e5aa603ae7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/index.js\":\"9ab1f9b6eadcc16d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/supertags/typeAutocomplete.js\":\"d4d88e05d82a02a7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"fac7398ce4d1de01\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/actions.js\":\"d26a6ebfd5e96c26\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/anchor.js\":\"7a553a90a5d86567\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/events.js\":\"cbdeb214e1e8f938\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/gestureActions.js\":\"f9ebca3772551e23\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/index.js\":\"13bb6748ecb9ea60\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"25c3410ca141737a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/sync-metrics/collect.js\":\"e233e73a310b494a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/sync-metrics/index.js\":\"0fcf9a3d9f923171\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/sync-metrics/record.js\":\"f216e406c60b4bc8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/RejectionDialog.js\":\"fd5f95b144976ff5\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/SystemStatusHeaderItem.js\":\"936eb30056c97cc3\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/index.js\":\"ef2d2954c95a3596\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/model.js\":\"7d61e4bb506e9e58\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/queueCounts.js\":\"9deb9ebc55dc13ff\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/rejectedHelpers.js\":\"de3b2c7582d2242b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/rematerializeAction.js\":\"90b7e97d88e53e25\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/system-status/useHysteresis.js\":\"cb0b54c4a41686ed\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/theme-toggle/effect.js\":\"de207fe42817578a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/theme-toggle/index.js\":\"de75b78b4a12f29a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/theme-toggle/theme.js\":\"45cb7df498407e45\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/actions.js\":\"2c7ebac063d965dc\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/dataExtension.js\":\"939aeb0956ca67cb\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/index.js\":\"bbf350fabfd64515\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/todo/schema.js\":\"205b508251d1902e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7009cf96d7967475\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/actions.js\":\"27c4e935fd5c6829\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/defaultItems.js\":\"6d214f0f2e201c5f\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/facet.js\":\"e8d2319149828761\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/holdRecognizer.js\":\"f9d999e047144ec0\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/touch-selection/index.js\":\"257d364b354f1570\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/update-indicator/UpdateIndicator.js\":\"a6887400ec69c3a1\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/update-indicator/index.js\":\"4f2574518528eef7\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/update-indicator/loadTimes.js\":\"84df732eed826744\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/VideoNotesRenderer.js\":\"67cc5a0b4e1db5bd\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/VideoPlayerRenderer.js\":\"99fdf5880f50d39e\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/VideoTimeStamp.js\":\"49972e19ee0e54a8\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/actions.js\":\"97d3f1acd1eafa3c\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/index.js\":\"820402cb21558855\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/markdown.js\":\"38eca4d108da27fa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/notes.js\":\"5879aa437a691b5d\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/registry.js\":\"cb5dcf60ab1e5942\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/remark-timestamps.js\":\"f1819211c2ef860a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/video-player/view.js\":\"3fbe4a78f5bb4d59\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/LinkHints.js\":\"b9366fd88b7a3805\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/index.js\":\"9bfba697100f115b\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/model.js\":\"46ba0ffd0310eae9\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-link-hints/settings.js\":\"989829913f28b36a\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-normal-mode/actions.js\":\"ebfa7043623c6d29\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-normal-mode/index.js\":\"3f4d8f32d966cbfa\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/vim-normal-mode/interactions.js\":\"278c1edf20b72e08\",\"/knowledge-medium/pr-preview/pr-1796/src/plugins/workspace-header/index.js\":\"dd01b92664a6fec9\",\"/knowledge-medium/pr-preview/pr-1796/src/registerServiceWorker.js\":\"d4ba44ecb48e8087\",\"/knowledge-medium/pr-preview/pr-1796/src/requestPersistentStorage.js\":\"5010a076793c999d\",\"/knowledge-medium/pr-preview/pr-1796/src/services/authRequestDeadline.js\":\"64efe1728418b7c5\",\"/knowledge-medium/pr-preview/pr-1796/src/services/authStorage.js\":\"1a33460350731c30\",\"/knowledge-medium/pr-preview/pr-1796/src/services/powersync.js\":\"f0c533902871c1ce\",\"/knowledge-medium/pr-preview/pr-1796/src/services/supabase.js\":\"19408f587547c44c\",\"/knowledge-medium/pr-preview/pr-1796/src/services/uploadErrorClassifier.js\":\"d089857b24264bda\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/ActiveContexts.js\":\"8ec6f8c5a7b311ed\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/HotkeyReconciler.js\":\"3268833a0ef80eed\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/WipeLocalDataDialog.js\":\"51361ab6bf323cf3\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/actionDispatch.js\":\"0ca1f60599315126\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/actionRefItems.js\":\"548d4425ad47dcff\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/applyKeybindingOverrides.js\":\"34657a8d0dc0d8b3\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/blockActions.js\":\"f6bf39216565a073\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/canonicalizeChord.js\":\"e93141de282f9c54\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/defaultContexts.js\":\"ed006f18d7235fc9\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/defaultShortcuts.js\":\"bd36d032a6ff615f\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/effectiveActions.js\":\"ed0bb8f693a3d026\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/gestureAction.js\":\"a1f5dd07743b82f4\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/gestureBinding.js\":\"e4d6b048bd053ecd\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/holdRegistry.js\":\"fe3e02c727f64c42\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/keybindingConflicts.js\":\"6cc46f4afc9bf9ba\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/keybindingOverrides.js\":\"cc3cec4b0f6f3edd\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/pointerAction.js\":\"6fc4b715543b1e99\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/resolve.js\":\"afaa2a0d330d07bf\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/runAction.js\":\"c2f8871039bf3173\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/sequenceMatcher.js\":\"9b7ea0b3592bde9f\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/types.js\":\"4c0f18dab54e406c\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/useActionContext.js\":\"9b79a4fa51c202c0\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/useActionDiscovery.js\":\"e47363d772a75498\",\"/knowledge-medium/pr-preview/pr-1796/src/shortcuts/utils.js\":\"03bfe66c324fb7e2\",\"/knowledge-medium/pr-preview/pr-1796/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1796/src/sw/bootStore.js\":\"8e57333069d30709\",\"/knowledge-medium/pr-preview/pr-1796/src/sw/previewDatabases.js\":\"9a06283096ceee78\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/byteTransform.js\":\"d08a7798b9487ef3\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/attachmentCleaner.js\":\"1b9c88b48987b3a1\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/attachmentParts.js\":\"98d7fca304cc1666\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/bundleParts.js\":\"d076297347138c02\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/bundleRecord.js\":\"41b27472a4b98f72\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/manifest.js\":\"a3afdb59e1d82f95\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/takeBundle.js\":\"9e3eca05817b3ec6\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/bundle/verifyBundle.js\":\"25268a5926903277\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/cleaningStage.js\":\"5524b65bb34301f7\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/conversionKey.js\":\"5916da58dc64b641\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/conversionServer.js\":\"3da13b542d2313f4\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/flip.js\":\"51f55f752073467b\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/flipAttempts.js\":\"624e56a9a4d67e7d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/pages.js\":\"d1e1e82e77c3060d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/preflight.js\":\"0812f08380381fea\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/reseal.js\":\"448c8ff36da50ad3\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/runConversion.js\":\"c7196acebe311691\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/runLock.js\":\"b050582cf1a8778d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/sealing.js\":\"203264c506a8f6f3\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/sealingStage.js\":\"ca1bb99522102ff8\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/stage.js\":\"6cbdea8807a73f9b\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/conversion/verifyReseal.js\":\"65ef0edc33a46428\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/aad.js\":\"17d1e421a7fd3fe7\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/aead.js\":\"951326651707815c\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/base32.js\":\"31d94eeb8f8ce0dd\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/base64url.js\":\"70443fd3e4bc69fd\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/binaryEnvelope.js\":\"eb312900dda7c3d9\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/byteAead.js\":\"ee631a3aaf3456d9\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/canary.js\":\"50c10a5e619ff4b4\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/contentHash.js\":\"a35b8c2027f9f78e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/contentKey.js\":\"1ed05bcd9276a2cc\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/derivedIdNamespace.js\":\"eeb9526bf1d0e42e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/envelope.js\":\"dfc2ff8bc01b8aa5\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/hex.js\":\"a95aea5d9c0b325b\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/sha256Hex.js\":\"1d0ecf036025a3b3\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/crypto/workspaceKey.js\":\"4e1569c091f3ef9a\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/conversionState.js\":\"c06f4b561ff0a491\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b387e0842c9ef3ec\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/pastedKey.js\":\"15d386f6559c9412\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0197c7a8e8680c1e\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e6f1f9a312d901e7\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/keyStore.js\":\"a7480298ecf225cc\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/mintWorkspaceKey.js\":\"2253967923e08b16\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/modePin.js\":\"065babe81e642002\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/openWorkspaceKeys.js\":\"f1f8695bd54fd0df\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/resolveWorkspaceEntry.js\":\"65f411950fade883\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/resolver.js\":\"543fd1f1d179855d\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/keys/workspaceAccess.js\":\"2d4496994e89d1ff\",\"/knowledge-medium/pr-preview/pr-1796/src/sync/transform.js\":\"2c80da82704b69ae\",\"/knowledge-medium/pr-preview/pr-1796/src/themeBootDefaults.js\":\"76693a0c120e94ae\",\"/knowledge-medium/pr-preview/pr-1796/src/types.js\":\"87a68c4acf9f9d9b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/ClientLocalSettings.js\":\"a38c1bd279ac1b13\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/abortableSleep.js\":\"93565837a62ff55e\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/array.js\":\"b8e7b57eed5cc35b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/backlinkAutocomplete.js\":\"cdc7f3d75cd860f1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/blockCrumbs.js\":\"a9be362014827495\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/blockrefAutocomplete.js\":\"abcbf92c2cd2d08b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/cadencedIdleJob.js\":\"b9e4d8921b3129b1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/callbackSet.js\":\"efe5685f827d6175\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/clientId.js\":\"075a10ec46fc9e37\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/codemirror.js\":\"095b2b01fa5975dd\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/codemirrorCompletion.js\":\"be766d261a17e52c\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/copy.js\":\"98774e9e59b9d2e2\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dailyPage.js\":\"c652e3293a3d1ed1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dbForensics.js\":\"8ae820534c3f51a6\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dbForensicsHooks.js\":\"8faf13954547cbd9\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/deleteBlockThroughUi.js\":\"d45da343b822b7cb\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dialogs.js\":\"fd8d1f1487ce22d9\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/dom.js\":\"c2deb24f57c09bdb\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/downloadBlob.js\":\"b7d57a319406133b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/exportSqliteDb.js\":\"2b554eab207ce032\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/fileSystemAccess.js\":\"37b13ce31daf92fa\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/flipSlide.js\":\"a6e6faf5f1053023\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/fnv1a.js\":\"6750bc8110d60434\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/formatBytes.js\":\"a7d911b211aa5423\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/fuzzyRank.js\":\"11f67eab0aaa369d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/idbKeyedStore.js\":\"dbf48dc684cf6d53\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/idleCallbackPolyfill.js\":\"e64f26556989b9e1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/keyboardAwareScroll.js\":\"00da7234249bda6b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/keyboardViewport.js\":\"b752681c23141ee1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/lastWorkspace.js\":\"787f72297cdfd1e3\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/layoutColumns.js\":\"6693891fe5a73d4d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/layoutSessionDom.js\":\"345ec9606b3a46e0\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/layoutSessionId.js\":\"4415023da3703ddb\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/linkClickGestures.js\":\"256f858478a6cce7\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/linkTargetAutocomplete.js\":\"bc2ed854b051d483\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/localDbCorruption.js\":\"9f66e71e60bc30ec\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/localDbRecovery.js\":\"2951593362c5f920\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/markdownParser.js\":\"c0acf9c5912c9a00\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/memoize.js\":\"7178b50051394dbc\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/nameFieldCommit.js\":\"dcf649ac9d448c7f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/nameList.js\":\"9e138488e748b1a2\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/navigation.js\":\"bf8c009bbbb067e5\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/omnilinerNamespace.js\":\"b950f9329ad0e958\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/opfsPageScan.js\":\"d0119c0c0bad17bf\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelClearance.js\":\"a7f55fcdab5caf0f\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelHistory.js\":\"df90bfc5f44c6dc0\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelLanes.js\":\"881d725ea17da844\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelLayoutProjection.js\":\"11f47a6dab78693b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelScrollAnchor.js\":\"bdae4cc43505dbcc\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/panelUrlFlags.js\":\"dfd282b1233af210\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/platform.js\":\"ff8d1ce7e064a7a4\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/pluralize.js\":\"8c77a8975ca940fe\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/propertyCreation.js\":\"26771db348086e8d\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/propertyNavigation.js\":\"0ea25da83d3021a5\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/propertyValueContext.js\":\"881c2585a02fee4b\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/react.js\":\"c94c4822bce263c5\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/relativeDate.js\":\"0b3d7531c442e6d9\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/relativeTime.js\":\"40c2d97a4dddaa68\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/renderScope.js\":\"035087c0a1d9e0be\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/resolvedThenable.js\":\"f12df1dbe30d3358\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/routing.js\":\"c2e2e10494864bdc\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/safeMode.js\":\"e6070dbce33562c3\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/scheduleIdle.js\":\"6216931e16c60cb3\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/screenWakeLock.js\":\"d0627a60a67731ec\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/selection.js\":\"ca4b0548016c6bf2\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/softKeyboardGrab.js\":\"85270b8f566d0688\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/startupTimeline.js\":\"a5472b61f5cfbff1\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/state.js\":\"4ebccc5cc149ea71\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/string.js\":\"c4d57045a61c8f94\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/surfaceZoom.js\":\"52444cfbb8b4f90a\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/time.js\":\"4de1a17918269021\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/toast.js\":\"34fd9c31f56fb2cd\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/toggleStore.js\":\"2704c4b20edcf52e\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/untilStopped.js\":\"76a43df00926086a\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/userActivity.js\":\"c72fd2a662b46119\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/viewTransition.js\":\"8bc4794412613c1e\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/viewport.js\":\"99af889c09a174de\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/webLock.js\":\"db4b3e36cea11367\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/workspaceRecovery.js\":\"547bf01ec7d1f387\",\"/knowledge-medium/pr-preview/pr-1796/src/utils/workspaceSnapshotStore.js\":\"308eab909eff0363\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-compiler-runtime.js\":\"12f24efcd44e860e\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-client.js\":\"8a639500c945ab8f\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-server-edge.js\":\"6690907360cd4e04\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-server.js\":\"20062c596e41a8eb\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-static-edge.js\":\"8283481e52414303\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-static.js\":\"64da55084424e0ad\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom-test-utils.js\":\"10995f99d881b2e1\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-dom.js\":\"888fbd35dd0890ce\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react-jsx-runtime.js\":\"fb536175f842f999\",\"/knowledge-medium/pr-preview/pr-1796/src/vendor/react.js\":\"e33f8e2c185b5443\",\"/knowledge-medium/pr-preview/pr-1796/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1796/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1796/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
